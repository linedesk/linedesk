// Warm transfer, the decisions without any audio: whether the assistant puts urgent calls through on
// this call, what the on-call person hears, and how their answer is read. The call itself is in
// transfer-call.ts.
import type { TransferResult } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { BusinessHours } from './call-session.ts'

/** How long the on-call phone rings before the assistant goes back to the caller. */
export const RING_SECONDS = 25
/** How long the on-call person has to answer after each briefing; it is said twice at most. */
export const DECISION_MS = 10_000

/**
 * The number to put urgent calls through to on this call, or null: transfer is off, has no number, or
 * the owner allows it only during business hours and the business is closed now. A workspace without
 * business hours has no "closed".
 */
export function transferNumberFor(assistant: Assistant | null, hours: BusinessHours | null): string | null {
  if (!assistant?.transfer_urgent || !assistant.transfer_number) return null
  if (assistant.transfer_hours_only && hours && !hours.openNow) return null
  return assistant.transfer_number
}

/** +15035550142 → "503 555 0142", the way a voice reads a number digit group by digit group. */
export function spokenNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `${m[1]} ${m[2]} ${m[3]}` : e164.replace(/^\+/, '')
}

/** +15035550142 → "+1 503 555 0142", the way the app shows numbers. */
const displayNumber = (e164: string) => (/^\+1\d{10}$/.test(e164) ? `+1 ${spokenNumber(e164)}` : e164)

export type Briefing = { callerName?: string | null; callerNumber?: string | null; about: string }

/** What the on-call person hears when they pick up. */
export function briefingText({ callerName, callerNumber, about }: Briefing): string {
  const name = callerName?.trim()
  const who = name || (callerNumber && /^\+\d+$/.test(callerNumber) ? spokenNumber(callerNumber) : 'a caller')
  const topic = about.trim().replace(/[.!?]+$/, '')
  return `Urgent call from ${who}${topic ? ` about ${topic}` : ''}. Press 1 or say yes to take it, or press 2 or say no.`
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
export function transferLabel(result: TransferResult, to: string): string {
  const number = displayNumber(to)
  if (result === 'connected') return `Transferred to ${number}`
  if (result === 'dialing') return `Transferring to ${number}`
  if (result === 'declined') return `Transfer declined by ${number}`
  if (result === 'failed') return `Transfer to ${number} could not be placed`
  return 'Transfer not answered'
}

/** What the caller hears right before the ringback. */
export const CONNECTING_LINE = "I'm connecting you with our on-call person now. Please stay on the line."

/** What the assistant is told when the transfer did not connect; it then talks to the caller again. */
export const NOT_CONNECTED_REPLY =
  'Nobody took the call. Tell the caller you could not reach anyone right now, take a message with how to reach them, and say the team will call back as soon as possible. The call is flagged as urgent.'
