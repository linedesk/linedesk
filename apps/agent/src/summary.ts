// After hang-up: one LLM call turns the transcript into the call's title, summary and outcome.
import { CALLER_NAME_MAX, outcome, urgency } from '@linedesk/actions'
import { z } from 'zod'
import type { CallResult, Speaker } from './call-session.ts'

export interface TranscriptLine {
  speaker: Speaker
  text: string
}

/** One LLM call that must answer with a JSON object, returned as text. */
export type CompleteJson = (system: string, user: string) => Promise<string>

const MAX_TITLE_LENGTH = 80

const summarySchema = z.object({
  title: z.string().min(1).transform(title => title.slice(0, MAX_TITLE_LENGTH)),
  summary: z.string().min(1),
  outcome,
  urgency,
  action_items: z.array(z.string().min(1)).default([]),
  // call.finish takes at most CALLER_NAME_MAX characters: a longer name is cut, so the summary is still saved.
  caller_name: z.string().nullish().transform(name => name?.trim().slice(0, CALLER_NAME_MAX) || null),
})

const SYSTEM = `You summarize a phone call between a business's assistant and a caller for the business owner's inbox.
Answer with one JSON object and nothing else:
{
  "title": short headline of what the call is about, at most 8 words, no caller name,
  "summary": one or two sentences with the facts the owner needs,
  "outcome": one of ${outcome.options.join(', ')},
  "urgency": one of ${urgency.options.join(', ')},
  "action_items": things the owner still has to do, each a short imperative sentence, [] if none,
  "caller_name": the caller's name if they gave it, else null
}
Outcomes: "booked" when the assistant booked an appointment, "message" when the assistant took a message, "callback" when the caller expects a call back, "answered" when the question was fully answered, "transferred" when the caller was put through to a person, "hangup" when the caller said nothing or left right away, "spam" for sales and robocalls. A caller who said what they wanted and then gave up or hung up before anything was saved is "callback", with an action item to call them back about it (with their name and number if they gave them), never "hangup". Use "urgent" only for emergencies.
Write the title, summary and action items in English, also when the call was in another language. When it was not in English, begin the summary with "Call in <language>." (for example "Call in Spanish.").
Lines starting with "system:" are tools the assistant used. Messages the assistant already saved are listed after the transcript: they are action items already, never repeat or rephrase them in "action_items".`

const formatTranscript = (lines: TranscriptLine[]) => lines.map(l => `${l.speaker}: ${l.text}`).join('\n')

function summaryRequest(lines: TranscriptLine[], savedMessages: string[]) {
  const saved = savedMessages.length ? savedMessages.map(m => `- ${m}`).join('\n') : '(none)'
  return `Transcript:\n${formatTranscript(lines)}\n\nAction items already saved:\n${saved}`
}

export const hangupResult: CallResult = {
  outcome: 'hangup', urgency: 'low', title: 'Hung up before speaking', summary: 'The caller hung up without saying anything.',
}

/**
 * The caller said nothing because a stage of the voice pipeline failed (the voice, speech to text): not a hang-up but a
 * caller the assistant could not help, so it reaches the owner as a call back, with the stage that failed.
 */
export function voiceFailedResult(stage: string): CallResult {
  return {
    outcome: 'callback',
    urgency: 'normal',
    title: `Missed: the assistant's ${stage} failed`,
    summary: `The assistant's ${stage} failed on this call, so the caller got no help and hung up.`,
    actionItems: [{ text: `Call the caller back: the assistant's ${stage} failed on this call.` }],
  }
}

/**
 * Used when the LLM call fails, so the call still leaves the live state with what is known. A message the
 * assistant took says what the call was about, so it becomes the title and summary.
 */
export function unsummarizedResult(lines: TranscriptLine[], savedMessages: string[] = []): CallResult {
  if (savedMessages.length) {
    return { outcome: 'message', title: headline(savedMessages[0]!), summary: savedMessages.join(' ') }
  }
  return { outcome: 'answered', title: 'Call (summary unavailable)', summary: lines.find(l => l.speaker === 'caller')?.text ?? '' }
}

/** The first sentence of a text, cut at a word boundary to fit a title. */
function headline(text: string) {
  const sentence = text.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, '')
  if (sentence.length <= MAX_TITLE_LENGTH) return sentence
  const cut = sentence.slice(0, MAX_TITLE_LENGTH - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`
}

/**
 * The caller hung up while a collection step was asking them for something, before any message, booking or transfer:
 * what the call gathered still reaches the owner as a call back, never as a hang-up without an action item.
 */
function endedMidStep(result: CallResult, tools: Parameters<typeof mergeToolResults>[1]): CallResult | null {
  if (!tools.collecting || tools.messages.length || tools.bookings?.length || tools.transferred) return null
  if (result.outcome !== 'hangup' && result.outcome !== 'answered' && result.actionItems?.length) return null
  const who = [tools.confirmedName, ...(tools.confirmedNumbers ?? [])].filter(Boolean).join(', ')
  const item = `Call the caller back${who ? ` (${who})` : ''}: the call ended while the assistant was asking for the ${tools.collecting}. ${result.summary}`.trim()
  return { ...result, outcome: 'callback', urgency: tools.urgent ? 'urgent' : result.urgency, actionItems: [{ text: item }, ...(result.actionItems ?? [])] }
}

/** Outcomes that do not fit a call in which the assistant took a message. */
const NOT_A_MESSAGE = new Set<CallResult['outcome']>(['answered', 'hangup'])
const ONLY_BY_TOOLS = new Set<CallResult['outcome']>(['booked', 'transferred'])

/** `savedMessages` are the action items taken during the call; the LLM is told not to repeat them. */
export async function summarizeCall(lines: TranscriptLine[], complete: CompleteJson, savedMessages: string[] = []): Promise<CallResult> {
  if (!lines.some(l => l.speaker === 'caller')) return hangupResult
  const parsed = summarySchema.parse(JSON.parse(await complete(SYSTEM, summaryRequest(lines, savedMessages))))
  return {
    title: parsed.title, summary: parsed.summary, outcome: parsed.outcome, urgency: parsed.urgency,
    actionItems: parsed.action_items.map(text => ({ text })),
    callerName: parsed.caller_name ?? undefined,
  }
}

/**
 * What goes into `call.finish`: tools used during the call win over the summary (a transfer that
 * connected makes it transferred, a booking booked, a taken message a message).
 */
export function mergeToolResults(
  result: CallResult,
  tools: { messages: string[]; urgent: boolean; bookings?: string[]; transferred?: boolean; collecting?: string | null; confirmedName?: string | undefined; confirmedNumbers?: readonly string[] },
): CallResult {
  const leftMidStep = endedMidStep(result, tools)
  if (leftMidStep) return leftMidStep
  const taken = tools.messages.map(text => ({ text }))
  const extra = (result.actionItems ?? []).filter(item => !tools.messages.includes(item.text))
  // Booked and transferred come only from what the tools did, never from the summary's guess (a caller who
  // agreed on a day is not booked without a booking).
  const guessed = ONLY_BY_TOOLS.has(result.outcome) ? (taken.length ? 'message' : 'callback') : result.outcome
  const outcome = tools.transferred
    ? 'transferred'
    : tools.bookings?.length ? 'booked' : taken.length && NOT_A_MESSAGE.has(guessed) ? 'message' : guessed
  const items = [...taken, ...extra]
  // A call back or message with nothing to act on would be lost in the inbox: what the call was about becomes the item.
  if (!items.length && (outcome === 'callback' || outcome === 'message') && result.summary?.trim()) items.push({ text: `Call the caller back: ${result.summary.trim()}` })
  return { ...result, outcome, urgency: tools.urgent ? 'urgent' : result.urgency, actionItems: items }
}
