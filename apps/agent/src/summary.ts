// After hang-up: one LLM call turns the transcript into the call's title, summary and outcome.
import { CALLER_NAME_MAX, outcome, urgency, type VoiceStage, workspaceLanguageName } from '@linedesk/actions'
import { z } from 'zod'
import type { CallResult, Speaker } from './call-session.ts'
import { teamT } from './team-text.ts'

export interface TranscriptLine {
  speaker: Speaker
  text: string
}

/** A value a collection step got (get_name, get_phone_number, …): confirmed by the caller, or only a best guess. */
export interface CollectedDetail {
  label: string
  value: string
  confirmed: boolean
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

/** The system prompt; `language` is the team's (the workspace language): what the title, summary and items are written in. */
export function summarySystem(language = 'en'): string {
  return `You summarize a phone call between a business's assistant and a caller for the business owner's inbox.
Answer with one JSON object and nothing else:
{
  "title": short headline of what the call is about, at most 8 words, no caller name,
  "summary": one or two sentences with the facts the owner needs,
  "outcome": one of ${outcome.options.join(', ')},
  "urgency": one of ${urgency.options.join(', ')},
  "action_items": things the owner still has to do, each a short imperative sentence, [] if none; each request the caller left for the team is one item, with the details it needs,
  "caller_name": the caller's name if they gave it, else null
}
Outcomes: "booked" when the assistant booked an appointment, "message" when the caller left a message or a request for the team, "callback" when the caller expects a call back, "answered" when the question was fully answered, "transferred" when the caller was put through to a person, "hangup" when the caller said nothing or left right away, "spam" for sales and robocalls. A caller who said what they wanted and then gave up or hung up before anything was saved is "callback", with an action item to call them back about it (with their name and number if they gave them), never "hangup". Use "urgent" only for emergencies.
${languageRule(language)}
Lines starting with "system:" are tools the assistant used. Messages the assistant already saved are listed after the transcript: they are action items already, never repeat or rephrase them in "action_items".
The details the caller gave when the assistant asked for them (name, phone number, address, email, date) are listed after the transcript too. Use them exactly as listed, and say when one is not confirmed. Never write a phone number that is not listed there: the transcript can hold numbers that were heard wrong.`
}

/** In English as before; in another team language, the summary says in that language when the call was in another one. */
function languageRule(language: string): string {
  if (language === 'en') return 'Write the title, summary and action items in English, also when the call was in another language. When it was not in English, begin the summary with "Call in <language>." (for example "Call in Spanish.").'
  const name = workspaceLanguageName(language)
  return `Write the title, summary and action items in ${name} (language code "${language}"), also when the call was in another language. When it was not in ${name}, begin the summary with a short sentence in ${name} naming the language of the call. Keep names, phone numbers, email addresses and street addresses exactly as they were said.`
}

const formatTranscript = (lines: TranscriptLine[]) => lines.map(l => `${l.speaker}: ${l.text}`).join('\n')

/**
 * What the summary is told when there is no number to call back on (no caller ID, none given): no item asks the owner
 * to call back, and a missing number is not a next step either (Tim, 2026-11-16); the summary says it.
 */
const NO_CALLBACK_NOTE = 'The team has no number to call this caller back on (no caller ID, and the caller gave none): never write an action item to call them back. Write the action items about what the caller wants, and say in the summary that the caller left no number.'

/** One listed detail: "- callback number: +15035550191" or "- address (not confirmed): 22 Oak St". */
const detailLine = (d: CollectedDetail) => `- ${d.label}${d.confirmed ? '' : ' (not confirmed)'}: ${d.value}`

function summaryRequest(lines: TranscriptLine[], savedMessages: string[], callbackKnown: boolean, details: readonly CollectedDetail[] = []) {
  const saved = savedMessages.length ? savedMessages.map(m => `- ${m}`).join('\n') : '(none)'
  const given = details.length ? details.map(detailLine).join('\n') : '(none)'
  return `Transcript:\n${formatTranscript(lines)}\n\nAction items already saved:\n${saved}\n\nDetails the caller gave:\n${given}${callbackKnown ? '' : `\n\n${NO_CALLBACK_NOTE}`}`
}

/** An action item that asks the owner to call the caller back ("Call back Sam", "Call the caller back: …"). */
const asksToCallBack = (text: string) => /^\s*(please\s+)?(call|phone|ring)\b[^.:]{0,60}\bback\b/i.test(text)

/** A detail as an item of its own: trimmed, first letter upper case; empty stays empty. */
const asItem = (detail: string) => {
  const rest = detail.trim()
  return rest ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : ''
}

/**
 * Without a number to call back on, an item that asks for a call back keeps only what it said after a colon ("Call the
 * caller back: the voice failed" keeps "The voice failed"); one with nothing after it goes. Duplicates go.
 */
function withoutCallBacks(items: { text: string }[]): { text: string }[] {
  const texts = items.map(({ text }) => (asksToCallBack(text) ? asItem(text.includes(':') ? text.slice(text.indexOf(':') + 1) : '') : text))
  return [...new Set(texts.filter(Boolean))].map(text => ({ text }))
}

/** The caller said nothing: no summary to ask the language model for. In the team's language, like the summaries. */
export function hangupResult(language = 'en'): CallResult {
  const t = teamT(language)
  return { outcome: 'hangup', urgency: 'low', title: t('call.autoSummary.hungUp.title'), summary: t('call.autoSummary.hungUp.summary') }
}

/**
 * The caller said nothing because a stage of the voice pipeline failed (the voice, speech to text): not a hang-up but a
 * caller the assistant could not help, so it reaches the owner as a call back, with the stage that failed.
 */
export function voiceFailedResult(stage: VoiceStage, language = 'en'): CallResult {
  const t = teamT(language)
  return {
    outcome: 'callback',
    urgency: 'normal',
    title: t('call.autoSummary.voiceFailed.title', { stage }),
    summary: t('call.autoSummary.voiceFailed.summary', { stage }),
    actionItems: [{ text: t('call.autoSummary.voiceFailed.item', { stage }) }],
  }
}

/**
 * Used when the LLM call fails, so the call still leaves the live state with what is known. A message saved on the
 * call (a transfer nobody took) says what the call was about, so it becomes the title and summary. Without one, details
 * the caller confirmed (a name, a number) mean they wanted something from the team: a call back with those details.
 */
export function unsummarizedResult(lines: TranscriptLine[], savedMessages: string[] = [], language = 'en', details: readonly CollectedDetail[] = []): CallResult {
  if (savedMessages.length) {
    return { outcome: 'message', title: headline(savedMessages[0]!), summary: savedMessages.join(' ') }
  }
  const t = teamT(language)
  const said = lines.find(l => l.speaker === 'caller')?.text ?? ''
  const who = details.filter(d => d.confirmed).map(d => d.value).join(', ')
  if (who) {
    return { outcome: 'callback', title: t('call.autoSummary.unavailable.title'), summary: said, actionItems: [{ text: t('call.autoSummary.callBackWho', { who, detail: said }).trim() }] }
  }
  return { outcome: 'answered', title: t('call.autoSummary.unavailable.title'), summary: said }
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
function endedMidStep(result: CallResult, tools: Parameters<typeof mergeToolResults>[1], callbackKnown: boolean, language: string): CallResult | null {
  if (!tools.collecting || tools.messages.length || tools.bookings?.length || tools.transferred) return null
  if (result.outcome !== 'hangup' && result.outcome !== 'answered' && result.actionItems?.length) return null
  const t = teamT(language)
  const who = [tools.confirmedName, ...(tools.confirmedNumbers ?? [])].filter(Boolean).join(', ')
  const ended = t('call.autoSummary.endedMidStep', { step: tools.collecting, summary: result.summary ?? '' }).trim()
  // Without a number nobody can call back: the team gets it as a message, with what the call was about.
  const item = callbackKnown
    ? (who ? t('call.autoSummary.callBackWho', { who, detail: ended }) : t('call.autoSummary.callBack', { detail: ended })).trim()
    : asItem(ended)
  const rest = callbackKnown ? (result.actionItems ?? []) : withoutCallBacks(result.actionItems ?? [])
  return { ...result, outcome: callbackKnown ? 'callback' : 'message', urgency: tools.urgent ? 'urgent' : result.urgency, actionItems: [{ text: item }, ...rest] }
}

/** Outcomes that do not fit a call in which the assistant took a message. */
const NOT_A_MESSAGE = new Set<CallResult['outcome']>(['answered', 'hangup'])
const ONLY_BY_TOOLS = new Set<CallResult['outcome']>(['booked', 'transferred'])

/**
 * `savedMessages` are the action items saved during the call (a transfer nobody took); the LLM is told not to repeat
 * them. `details`: what the collection steps got, which the next steps are written from. `teamLanguage`: the
 * workspace language the owner reads it in. `callbackKnown`: the team has a number to call back on (caller ID, or one
 * the caller gave: hasCallbackNumber); without one the summary is told not to ask for a call back.
 */
export async function summarizeCall(
  lines: TranscriptLine[],
  complete: CompleteJson,
  savedMessages: string[] = [],
  teamLanguage = 'en',
  { callbackKnown = true, details = [] }: { callbackKnown?: boolean; details?: readonly CollectedDetail[] } = {},
): Promise<CallResult> {
  if (!lines.some(l => l.speaker === 'caller')) return hangupResult(teamLanguage)
  const parsed = summarySchema.parse(JSON.parse(await complete(summarySystem(teamLanguage), summaryRequest(lines, savedMessages, callbackKnown, details))))
  return {
    title: parsed.title, summary: parsed.summary, outcome: parsed.outcome, urgency: parsed.urgency,
    actionItems: parsed.action_items.map(text => ({ text })),
    callerName: parsed.caller_name ?? undefined,
  }
}

/**
 * What goes into `call.finish`: tools used during the call win over the summary (a transfer that
 * connected makes it transferred, a booking booked, a taken message a message). `callbackKnown` false: the team has
 * no number to call back on, so no action item asks for a call back; it says that the number is missing instead.
 * `language`: the team's, which the items this adds are written in.
 */
export function mergeToolResults(
  result: CallResult,
  tools: { messages: string[]; urgent: boolean; bookings?: string[]; transferred?: boolean; collecting?: string | null; confirmedName?: string | undefined; confirmedNumbers?: readonly string[] },
  callbackKnown = true,
  language = 'en',
): CallResult {
  const leftMidStep = endedMidStep(result, tools, callbackKnown, language)
  if (leftMidStep) return leftMidStep
  const taken = tools.messages.map(text => ({ text }))
  const summarized = (result.actionItems ?? []).filter(item => !tools.messages.includes(item.text))
  // Without a number, "Call back …" from the summary keeps only what it is about.
  const extra = callbackKnown ? summarized : withoutCallBacks(summarized)
  // Booked and transferred come only from what the tools did, never from the summary's guess (a caller who
  // agreed on a day is not booked without a booking).
  const guessed = ONLY_BY_TOOLS.has(result.outcome) ? (taken.length ? 'message' : 'callback') : result.outcome
  const outcome = tools.transferred
    ? 'transferred'
    : tools.bookings?.length
      ? 'booked'
      : taken.length && NOT_A_MESSAGE.has(guessed)
        ? 'message'
        : tools.confirmedNumbers?.length && NOT_A_MESSAGE.has(guessed)
          ? 'callback'
          : guessed
  const items = [...taken, ...extra]
  // A call back or message with nothing to act on would be lost in the inbox: what the call was about becomes the item.
  if (!items.length && (outcome === 'callback' || outcome === 'message') && result.summary?.trim()) {
    const t = teamT(language)
    items.push({ text: callbackKnown ? t('call.autoSummary.callBack', { detail: result.summary.trim() }) : result.summary.trim() })
  }
  // Without a number nobody can call back: a call back is a message for the team.
  const filed = !callbackKnown && outcome === 'callback' ? 'message' : outcome
  return { ...result, outcome: filed, urgency: tools.urgent ? 'urgent' : result.urgency, actionItems: items }
}
