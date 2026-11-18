// Warm transfer, the decisions without any audio: which transfer contacts the assistant may put
// callers through to on this call, in which order it tries them and what happens when nobody accepts,
// what the person hears, and how their answer is read. The call itself is in transfer-call.ts.
import { isActiveContact, RING_SECONDS_DEFAULT, type SpokenLines, spokenLines, type TransferResult } from '@linedesk/actions'
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

/** A condition as written, without case, extra spaces or a closing full stop: two contacts with the same one fit the same calls. */
const conditionKey = (condition: string) => condition.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')

/**
 * Whom to try, in order, for the contacts the assistant said fit this call (by name). A named contact stands for
 * its condition: every contact with the same condition fits too, so a backup is tried even when the assistant named
 * only the first one. The owner's list order wins over the order the assistant named them. A contact whose fallback
 * is "next" hands over to the next one that fits; when nobody accepts, the assistant takes a message.
 */
export function transferPlan(contacts: Dialable[], picked: readonly string[]): { tries: Dialable[] } | null {
  const names = new Set(picked.map(n => n.trim().toLowerCase()))
  const conditions = new Set(contacts.filter(c => names.has(c.name.trim().toLowerCase())).map(c => conditionKey(c.condition)))
  const fitting = contacts.filter(c => conditions.has(conditionKey(c.condition)))
  if (!fitting.length) return null
  const tries: Dialable[] = []
  for (const contact of fitting) {
    tries.push(contact)
    if (contact.if_no_answer !== 'next' || tries.length >= MAX_TRANSFER_TRIES) break
  }
  return { tries }
}

/** +15035550142 → "503 555 0142", the way a voice reads a number digit group by digit group. */
export function spokenNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `${m[1]} ${m[2]} ${m[3]}` : e164.replace(/^\+/, '')
}

/** +15035550142 → "+1 503 555 0142", the way the app shows numbers. */
export const displayNumber = (e164: string) => (/^\+1\d{10}$/.test(e164) ? `+1 ${spokenNumber(e164)}` : e164)

/**
 * `nameConfirmed`: the name is the one the team gave or confirmed on the contact (contacts.name_source `member`). Any other
 * name only says who the caller says they are: caller ID can be faked, and so can a name.
 */
export type Briefing = { callerName?: string | null; nameConfirmed?: boolean; callerNumber?: string | null; about: string }

/** The lines the on-call person hears and the answers understood from them, in the business's language (spokenLines). */
export type OnCallLines = Pick<
  SpokenLines,
  'onCallBriefing' | 'aCaller' | 'onCallConnecting' | 'onCallDeclined' | 'onCallFailed' | 'onCallYes' | 'onCallNo'
>

/** What the person hears when they pick up, in `lines`' language. */
export function briefingText(
  { callerName, nameConfirmed = false, callerNumber, about }: Briefing,
  lines: OnCallLines = spokenLines('en'),
): string {
  const name = callerName?.trim() || null
  const number = callerNumber && /^\+\d+$/.test(callerNumber) ? spokenNumber(callerNumber) : null
  const who = name && nameConfirmed ? name : (number ?? lines.aCaller)
  const topic = about.trim().replace(/[.!?。！？]+$/, '') || null
  return lines.onCallBriefing(who, name && !nameConfirmed ? name : null, topic)
}

/**
 * The caller's name for a transfer, and whether the team confirmed it: the name the caller gave on this call (the tool's
 * argument, else the one confirmed with get_name), else the contact's. Confirmed only when it is the contact's name and
 * the team gave or confirmed that (`nameConfirmed`).
 */
export function transferCallerName(said: string | null | undefined, contact: { name?: string | null; nameConfirmed?: boolean } | null | undefined) {
  const own = contact?.name?.trim() || null
  const name = said?.trim() || own
  const confirmed = !!(name && own && contact?.nameConfirmed && name.toLowerCase() === own.toLowerCase())
  return { name, confirmed }
}

export type Answer = 'yes' | 'no'

/** A voicemail or an automated line, not a person answering the question. */
const MACHINE =
  /\b(voice ?mail|leave (me |us )?a message|not available|after the (tone|beep)|mailbox|record your message|press \d)\b/i
/** A clear answer is short; anything longer is someone talking, not a decision. */
const MAX_ANSWER_WORDS = 6

const english = spokenLines('en')

/**
 * The on-call person's spoken answer, in `lines`' language or English; null when it is neither, both ("yes, but I
 * can't"), longer than a short reply, or sounds like a voicemail greeting.
 */
export function answerOf(text: string, lines: Pick<OnCallLines, 'onCallYes' | 'onCallNo'> = english): Answer | null {
  if (MACHINE.test(text) || text.trim().split(/\s+/).length > MAX_ANSWER_WORDS) return null
  const yes = english.onCallYes.test(text) || lines.onCallYes.test(text) || /\bno problem\b/i.test(text)
  const rest = text.replace(/\bno problem\b/gi, '')
  const no = english.onCallNo.test(rest) || lines.onCallNo.test(rest)
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

/**
 * What the caller hears right before a contact's ringback, in the language spoken now (spokenLines): whom the
 * assistant is trying to reach, and after a contact who did not take the call, that it tries the next one.
 */
export const connectingLine = (lines: Pick<SpokenLines, 'transferConnecting' | 'transferNext'>, next: string, previous: string | null) =>
  previous ? lines.transferNext(previous, next) : lines.transferConnecting(next)

/**
 * The message the team gets when nobody took the call, saved by the transfer itself: the assistant does not always
 * take one afterwards, and without it the call has nothing to do for the team.
 */
export function notConnectedMessage({ callerName, nameConfirmed = false, about, tried }: { callerName?: string | null; nameConfirmed?: boolean; about: string; tried: string[] }): string {
  const name = callerName?.trim()
  const who = name && nameConfirmed ? name : name ? `A caller who says they are ${name}` : 'The caller'
  const topic = about.trim().replace(/[.!?]+$/, '')
  return `${who} wanted to be put through to ${tried.join(', then ')}${topic ? ` about ${topic}` : ''}; nobody took the call. Call them back.`
}

/** What the assistant is told when nobody took the call; it then talks to the caller again. */
export function notConnectedReply(): string {
  const saved = 'A message that they wanted to be put through is saved already; anything the caller adds reaches the owner with the call.'
  const noPromises = 'Nothing else has happened: nobody is on the way and no visit or time is set. Never say or suggest otherwise.'
  return `Nobody took the call. Tell the caller you could not reach anyone right now, that their message is passed on, and that someone will get back to them. ${noPromises} ${saved}`
}
