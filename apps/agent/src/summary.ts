// After hang-up: one LLM call turns the transcript into the call's title, summary and outcome, the
// lead details, a tag and the workspace's custom fields.
import { type CallCustomField, callTags, type LeadInput, outcome, urgency } from '@linedesk/actions'
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
  caller_name: z.string().nullish(),
  callback_number: z.string().nullish(),
  address: z.string().nullish(),
  job_type: z.string().nullish(),
  // An answer the model got slightly wrong costs the tag, never the summary.
  tag: z.enum(callTags).nullish().catch(null),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).nullable()).nullish().catch(null),
})

const SYSTEM = `You summarize a phone call between a business's assistant and a caller for the business owner's inbox.
Answer with one JSON object and nothing else:
{
  "title": short headline of what the call is about, at most 8 words, no caller name,
  "summary": one or two sentences with the facts the owner needs,
  "outcome": one of ${outcome.options.join(', ')},
  "urgency": one of ${urgency.options.join(', ')},
  "action_items": things the owner still has to do, each a short imperative sentence, [] if none,
  "caller_name": the caller's name if they gave it, else null,
  "callback_number": a number the caller asked to be called back on, only if they said one, else null,
  "address": the address of the job or the caller if they gave one, else null,
  "job_type": what kind of job or request it is in two or three words (for example "Leak repair", "Quote", "Billing question"), else null,
  "tag": one of ${callTags.join(', ')}, or null if none fits
}
Outcomes: "booked" when the assistant booked an appointment, "message" when the assistant took a message, "callback" when the caller expects a call back, "answered" when the question was fully answered, "transferred" when the caller was put through to a person, "hangup" when the caller said nothing or left right away, "spam" for sales and robocalls. Use "urgent" only for emergencies.
Tags: "booked" when an appointment was booked, "transferred" when the caller was put through, "message" when a message was taken for an existing customer, "new_lead" for someone who is not a customer yet and wants work done or a quote, "existing_customer" for a customer of the business, "wrong_number" when the caller meant to reach someone else, "spam" for sales calls and robocalls.
Lines starting with "system:" are tools the assistant used. Messages the assistant already saved are listed after the transcript: they are action items already, never repeat or rephrase them in "action_items".`

/** The custom fields as the summary asks for them; empty when the workspace has none. */
export function customFieldsRequest(fields: CallCustomField[]): string {
  if (!fields.length) return ''
  const kind = (f: CallCustomField) =>
    f.type === 'number' ? 'a number' : f.type === 'boolean' ? 'true or false' : f.type === 'choice' ? `one of: ${f.options.join(', ')}` : 'short text'
  const lines = fields.map(f => `- "${f.id}": ${f.label} (${kind(f)})${f.instruction ? `. ${f.instruction}` : ''}`)
  return `\n\nAlso add "custom_fields": an object with these keys, each the value the caller gave, or null when the call did not say:\n${lines.join('\n')}`
}

const formatTranscript = (lines: TranscriptLine[]) => lines.map(l => `${l.speaker}: ${l.text}`).join('\n')

function summaryRequest(lines: TranscriptLine[], savedMessages: string[]) {
  const saved = savedMessages.length ? savedMessages.map(m => `- ${m}`).join('\n') : '(none)'
  return `Transcript:\n${formatTranscript(lines)}\n\nAction items already saved:\n${saved}`
}

export const hangupResult: CallResult = {
  outcome: 'hangup', urgency: 'low', title: 'Hung up before speaking', summary: 'The caller hung up without saying anything.',
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

/** Outcomes that do not fit a call in which the assistant took a message. */
const NOT_A_MESSAGE = new Set<CallResult['outcome']>(['answered', 'hangup'])

/** `savedMessages` are the action items taken during the call; the LLM is told not to repeat them. */
export async function summarizeCall(lines: TranscriptLine[], complete: CompleteJson, savedMessages: string[] = [], customFields: CallCustomField[] = []): Promise<CallResult> {
  if (!lines.some(l => l.speaker === 'caller')) return hangupResult
  const parsed = summarySchema.parse(JSON.parse(await complete(SYSTEM + customFieldsRequest(customFields), summaryRequest(lines, savedMessages))))
  const known = new Set(customFields.map(f => f.id))
  const customValues = Object.fromEntries(Object.entries(parsed.custom_fields ?? {}).filter(([id, v]) => known.has(id) && v !== null && v !== ''))
  return {
    title: parsed.title, summary: parsed.summary, outcome: parsed.outcome, urgency: parsed.urgency,
    actionItems: parsed.action_items.map(text => ({ text })),
    callerName: parsed.caller_name ?? undefined,
    lead: leadFromTool(parsed),
    ...(parsed.tag ? { tag: parsed.tag } : {}),
    ...(Object.keys(customValues).length ? { customValues: customValues as Record<string, string | number | boolean> } : {}),
  }
}

/** The lead details a tool or the summary named, without the empty ones. */
export function leadFromTool(found: { caller_name?: string | null; callback_number?: string | null; address?: string | null; job_type?: string | null }): LeadInput {
  const text = (value: string | null | undefined) => value?.trim() || undefined
  const lead: LeadInput = { callerName: text(found.caller_name), callbackNumber: text(found.callback_number), address: text(found.address), jobType: text(found.job_type) }
  return Object.fromEntries(Object.entries(lead).filter(([, v]) => v !== undefined))
}

/**
 * What goes into `call.finish`: tools used during the call win over the summary (a transfer that
 * connected makes it transferred, a booking booked, a taken message a message).
 */
export function mergeToolResults(result: CallResult, tools: { messages: string[]; urgent: boolean; bookings?: string[]; transferred?: boolean; lead?: LeadInput }): CallResult {
  const taken = tools.messages.map(text => ({ text }))
  const extra = (result.actionItems ?? []).filter(item => !tools.messages.includes(item.text))
  const outcome = tools.transferred
    ? 'transferred'
    : tools.bookings?.length ? 'booked' : taken.length && NOT_A_MESSAGE.has(result.outcome) ? 'message' : result.outcome
  // What the assistant did is the tag; otherwise the summary's.
  const tag = tools.transferred ? 'transferred' : tools.bookings?.length ? 'booked' : result.tag
  const lead = { ...result.lead, ...tools.lead }
  return {
    ...result, outcome, urgency: tools.urgent ? 'urgent' : result.urgency, actionItems: [...taken, ...extra],
    ...(tag ? { tag } : {}), ...(Object.keys(lead).length ? { lead } : {}),
  }
}
