// Warm transfer, the decisions without any audio: which transfer contacts the assistant may put
// callers through to on this call, in which order it tries them and what happens when nobody accepts,
// what the person hears, and how their answer is read. The call itself is in transfer-call.ts.
import { isActiveContact, RING_SECONDS_DEFAULT, type TransferResult } from '@linedesk/actions'
import type { Assistant, TransferContact } from '@linedesk/db/types'
import type { BusinessHours } from './call-session.ts'

/** How long a phone rings when the contact does not say (older settings). */
export const RING_SECONDS = RING_SECONDS_DEFAULT
/** How long the on-call person has to answer after each briefing; it is said twice at most. */
export const DECISION_MS = 10_000

/** A contact the assistant can dial on this call: active, with its number. */
export type Dialable = TransferContact & { number: string }

/**
 * The contacts the assistant may put callers through to on this call, in the owner's order: switched
 * on, with a number, and not limited to business hours while the business is closed. A workspace
 * without business hours has no "closed".
 */
export function transferContactsFor(assistant: Assistant | null, hours: BusinessHours | null): Dialable[] {
  const closed = !!hours && !hours.openNow
  // Vacation or closure mode: nobody is put through.
  if (hours?.closure) return []
  return (assistant?.transfers ?? []).filter(
    (c): c is Dialable =>
      isActiveContact(c) && !(c.hours_only && closed),
  )
}

/** A call never tries more contacts than this, so the caller does not wait on hold for minutes. */
export const MAX_TRANSFER_TRIES = 3

/** What the assistant does when nobody it tried accepts. */
export type Fallback = 'message_urgent' | 'message'

/** A condition as written, without case, extra spaces or a closing full stop: two contacts with the same one fit the same calls. */
const conditionKey = (condition: string) => condition.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')

/**
 * Whom to try, in order, for the contacts the assistant said fit this call (by name), and what to do
 * when none of them accepts. A named contact stands for its condition: every contact with the same
 * condition fits too, so a backup is tried even when the assistant named only the first one. The owner's
 * list order wins over the order the assistant named them. A contact whose fallback is "next" hands over
 * to the next one that fits; when there is none, the assistant takes a message marked urgent (someone
 * wanted the call to reach a person).
 */
export function transferPlan(contacts: Dialable[], picked: readonly string[]): { tries: Dialable[]; fallback: Fallback } | null {
  const names = new Set(picked.map(n => n.trim().toLowerCase()))
  const conditions = new Set(contacts.filter(c => names.has(c.name.trim().toLowerCase())).map(c => conditionKey(c.condition)))
  const fitting = contacts.filter(c => conditions.has(conditionKey(c.condition)))
  if (!fitting.length) return null
  const tries: Dialable[] = []
  for (const contact of fitting) {
    tries.push(contact)
    if (contact.if_no_answer !== 'next' || tries.length >= MAX_TRANSFER_TRIES) break
  }
  const last = tries[tries.length - 1]!
  return { tries, fallback: last.if_no_answer === 'message' ? 'message' : 'message_urgent' }
}

/** +15035550142 → "503 555 0142", the way a voice reads a number digit group by digit group. */
export function spokenNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `${m[1]} ${m[2]} ${m[3]}` : e164.replace(/^\+/, '')
}

/** +15035550142 → "+1 503 555 0142", the way the app shows numbers. */
const displayNumber = (e164: string) => (/^\+1\d{10}$/.test(e164) ? `+1 ${spokenNumber(e164)}` : e164)

export type Briefing = { callerName?: string | null; callerNumber?: string | null; about: string; urgent?: boolean }

/** What the person hears when they pick up. */
export function briefingText({ callerName, callerNumber, about, urgent = true }: Briefing): string {
  const name = callerName?.trim()
  const who = name || (callerNumber && /^\+\d+$/.test(callerNumber) ? spokenNumber(callerNumber) : 'a caller')
  const topic = about.trim().replace(/[.!?]+$/, '')
  return `${urgent ? 'Urgent call' : 'Call'} from ${who}${topic ? ` about ${topic}` : ''}. Press 1 or say yes to take it, or press 2 or say no.`
}

export type Answer = 'yes' | 'no'

const YES =
  /\b(yes|yeah|yep|yup|sure|ok(ay)?|put (them|him|her|it) through|connect (me|them|us)|i'?ll take it|go ahead)\b/i
const NO = /\b(no|nope|can'?t|cannot|not now|busy|decline)\b/i

/** A voicemail or an automated line, not a person answering the question. */
const MACHINE =
  /\b(voice ?mail|leave (me |us )?a message|not available|after the (tone|beep)|mailbox|record your message|press \d)\b/i
/** A clear answer is short; anything longer is someone talking, not a decision. */
const MAX_ANSWER_WORDS = 6

/**
 * The on-call person's spoken answer; null when it is neither, both ("yes, but I can't"), longer than a
 * short reply, or sounds like a voicemail greeting.
 */
export function answerOf(text: string): Answer | null {
  if (MACHINE.test(text) || text.trim().split(/\s+/).length > MAX_ANSWER_WORDS) return null
  const yes = YES.test(text) || /\bno problem\b/i.test(text)
  const no = NO.test(text.replace(/\bno problem\b/gi, ''))
  if (yes === no) return null
  return yes ? 'yes' : 'no'
}

/** A key pressed on the phone: 1 takes the call, 2 declines it. */
export const answerOfDigit = (digit: string): Answer | null => (digit === '1' ? 'yes' : digit === '2' ? 'no' : null)

/** The result for the call record: answered and said yes, said no, or never decided (no answer, voicemail). */
export const resultOf = (answer: Answer | null): TransferResult =>
  answer === 'yes' ? 'connected' : answer === 'no' ? 'declined' : 'not_answered'

/** The line in the transcript, and what the call shows. */
export function transferLabel(result: TransferResult, to: string, name?: string): string {
  const number = name ? `${name} (${displayNumber(to)})` : displayNumber(to)
  if (result === 'connected') return `Transferred to ${number}`
  if (result === 'dialing') return `Transferring to ${number}`
  if (result === 'declined') return `Transfer declined by ${number}`
  if (result === 'failed') return `Transfer to ${number} could not be placed`
  return 'Transfer not answered'
}

/** What the caller hears right before the ringback: whom they are put through to. */
export const connectingLine = (name: string) => `I'm connecting you with ${name} now. Please stay on the line.`

/** What the caller hears before the next contact's ringback, when the one before did not take the call. */
export const tryingNextLine = (previous: string, next: string) =>
  `${previous} can't take the call right now. Let me try ${next}. Please stay on the line.`

/**
 * The message the team gets when nobody took the call, saved by the transfer itself: the assistant does not always
 * take one afterwards, and without it the call has nothing to do for the team.
 */
export function notConnectedMessage({ callerName, about, tried }: { callerName?: string | null; about: string; tried: string[] }): string {
  const who = callerName?.trim() || 'The caller'
  const topic = about.trim().replace(/[.!?]+$/, '')
  return `${who} wanted to be put through to ${tried.join(', then ')}${topic ? ` about ${topic}` : ''}; nobody took the call. Call them back.`
}

/** What the assistant is told when nobody took the call; it then talks to the caller again. */
export function notConnectedReply(fallback: Fallback): string {
  const saved = 'A message that they wanted to be put through is saved already; use take_message only for details the caller adds.'
  return fallback === 'message_urgent'
    ? `Nobody took the call. Tell the caller you could not reach anyone right now, ask how to reach them, and say the team will call back as soon as possible. The call is flagged as urgent. ${saved}`
    : `Nobody took the call. Tell the caller you could not reach anyone right now, ask how to reach them, and say the team will get back to them. ${saved}`
}
