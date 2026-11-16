// The assistant's system prompt, built from its configuration.
import { aiDisclosureInstructions, type BookingContext, CALLER_NAME_MAX, isActiveContact, communicationStyleInstructions, behaviourLines, behaviourOn, type CallerHistory, callRules, defaultPromptTexts, fenceData, isE164, type Language, LANGUAGES, languageNames, mainLanguageOf, otherLanguagesOf, PROMPT_TEXTS, type PromptOverrides, type PromptTexts, promptTexts, workspaceLanguageName } from '@linedesk/actions'
import type { Assistant, CallerDetails, Contact, TransferContact } from '@linedesk/db/types'
import type { BusinessHours } from './call-session.ts'
import { displayNumber } from './transfer.ts'

export const FALLBACK_GREETING = 'Thanks for calling. How can I help?'

const line = (label: string, value?: string) => (value ? `${label}: ${value}` : null)

/** The older structured fields (before free-text instructions). */
function businessFacts({ business_profile: p }: Assistant): string {
  return [line('About', p.description), line('Services', p.services?.filter(s => s.trim()).join(', ')), line('Service area', p.service_area), line('Address', p.address), line('Hours', p.hours)]
    .filter(Boolean)
    .join('\n')
}

/** What the business told the assistant: its free-text instructions ("About the business"), or the older structured fields. */
function businessKnowledge(assistant: Assistant): string {
  const instructions = assistant.business_profile.instructions?.trim()
  return instructions || businessFacts(assistant)
}

/** The behaviour checklist's lines; they come after the call rules and win where they differ. */
export function behavioursInstructions(assistant: Assistant | null, pt: PromptTexts = defaultPromptTexts): string | null {
  const lines = behaviourLines(assistant?.behaviours, pt)
  return lines.length ? pt('owner.heading', { lines: lines.map(l => `- ${l}`).join('\n') }) : null
}

/**
 * The system prompt. Fixed parts: how to speak on a phone line, honesty about being an AI, what the
 * assistant can do, how to handle calls (callRules) and how to use its tools. Editable by the owner: what
 * the business wants it to know (instructions).
 */
/**
 * Outside business hours an assistant greets with its outside greeting, where it has one. What it knows
 * is the same at any hour; after-hours behaviour comes from the call rules and the transfer rules.
 */
export function forHours(assistant: Assistant | null, hours: BusinessHours | null | undefined): Assistant | null {
  if (!assistant || !hours || hours.openNow) return assistant
  // Vacation or closure mode has its own greeting; empty: the outside-hours one.
  return { ...assistant, greeting: hours.closure?.greeting.trim() || assistant.greeting_outside?.trim() || assistant.greeting }
}

/** What the assistant says about opening hours: the hours and where now falls; nothing when the workspace does not use hours. */
/**
 * With no hours set, a realtime model made some up ("Monday through Saturday, 8 to 6", staging 2026-11-15): the prompt
 * says it does not know them, unless the business's own text gives them.
 */
export const NO_HOURS = PROMPT_TEXTS['call.noHours'].text

/** A sentence and, where it applies, a second one after it. */
const withSentence = (first: string, second: string | null) => (second ? `${first} ${second}` : first)

function hoursContext(hours: BusinessHours | null | undefined, canBook: boolean, pt: PromptTexts): string | null {
  if (!hours) return pt('call.noHours')
  if (hours.openNow) return hours.summary
  // find_slots offers no time on closed days, so a booking while closed is one for when the business is back.
  if (hours.closure) return withSentence(pt('call.closure', { hours: hours.summary }), canBook ? pt('call.closureBooking') : null)
  return withSentence(pt('call.closed', { hours: hours.summary }), canBook ? pt('call.closedBooking') : null)
}

/**
 * What the assistant cannot do on this call, so it never promises it: only what is missing (the tools it has are
 * described with the tools). null when nothing is missing.
 */
export function cannotInstructions({ booking, transfer, lookup }: { booking: boolean; transfer: boolean; lookup: boolean }, pt: PromptTexts = defaultPromptTexts): string | null {
  const missing = [
    ...(booking ? [] : [pt('cannot.book')]),
    ...(transfer ? [] : [pt('cannot.transfer')]),
    ...(lookup ? [] : [pt('cannot.lookup')]),
  ]
  if (!missing.length) return null
  const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} or ${missing.at(-1)}`
  return pt('cannot.sentence', { list })
}

/** A transfer contact as the assistant sees it: who, and when to put the caller through. */
export type TransferRule = Pick<TransferContact, 'name' | 'condition'>

/**
 * When to put the caller through and to whom; only with the contacts the assistant can reach right now
 * (transferContactsFor). They come before the call rules: a rule that says "take a message" for a
 * caller who asks for a person gives way to a contact whose condition is exactly that.
 */
export function transferInstructions(pt: PromptTexts = defaultPromptTexts): string {
  return pt('call.transfer')
}

/**
 * Contacts that take calls, but not now because the business is closed: "only during business hours" ones outside the
 * hours, and every contact in vacation or closure mode (nobody is put through then).
 */
export function heldTransferContacts(assistant: Pick<Assistant, 'transfers'> | null, hours?: BusinessHours | null): TransferContact[] {
  if (!hours || (hours.openNow && !hours.closure)) return []
  return (assistant?.transfers ?? []).filter(c => isActiveContact(c) && (hours.closure || c.hours_only))
}

/**
 * What the assistant says when a call fits a contact that cannot be reached now: closed, so nobody is put through,
 * never "I am an AI and cannot transfer you".
 */
export function heldTransferInstructions(held: readonly Pick<TransferContact, 'condition'>[], pt: PromptTexts = defaultPromptTexts): string | null {
  if (!held.length) return null
  const conditions = [...new Set(held.map(c => c.condition.trim().replace(/[.!?]+$/, '')))].map(c => `- ${c}`).join('\n')
  return pt('call.held', { conditions })
}

/**
 * Changing a booking: the assistant knows none of the caller's bookings (caller ID can be faked). The
 * caller says the day and the name, and the API checks both against the caller's bookings.
 */
export const CHANGE_BOOKING_INSTRUCTIONS = PROMPT_TEXTS['booking.change'].text

/**
 * Changing a booking when call.start listed the caller's upcoming bookings (under the contact's name): the assistant
 * may talk about them; the API still checks day and name when one is cancelled or moved.
 */
export const CHANGE_LISTED_BOOKING_INSTRUCTIONS = PROMPT_TEXTS['booking.changeListed'].text

/** The listed-bookings rule with the booking-name check (the owner's "Ask for the booking name …" switch). */
export const CHANGE_LISTED_BOOKING_NAME_CHECKED = PROMPT_TEXTS['booking.changeListedChecked'].text

/** Whether the assistant may offer booking changes on this call; an API of an older version did not say, so no. */
export const canChangeBookings = (booking: BookingContext) => booking.canChangeBookings === true

type BookingType = BookingContext['appointmentTypes'][number]

/** How the details a type needs are said; an API of an older version did not list the name, which it always wanted. */
const DETAIL_LABEL = { name: 'name', phone: 'phone number', email: 'email address', address: 'address' } as const

/**
 * "- Repair visit (60 minutes), id at_1. Use when: the caller needs a repair. Before booking ask for: name, address."
 * `callerNumber`: caller ID gave the number, which the API puts on the booking, so it is not asked for.
 */
export function typeLine(t: BookingType, callerNumber = false): string {
  const condition = t.instruction?.trim()
  const wanted: BookingType['required_fields'] = t.instruction === undefined && !t.required_fields.includes('name') ? ['name', ...t.required_fields] : t.required_fields
  const fields = callerNumber ? wanted.filter(f => f !== 'phone') : wanted
  return [
    `- ${t.name} (${t.duration_min} min, id ${t.id})`,
    condition ? `: use when ${condition}.` : '.',
    fields.length ? ` Ask for: ${fields.map(f => DETAIL_LABEL[f]).join(', ')}.` : ' Nothing to ask for beyond the reason.',
  ].join('')
}

/** "- Office, id acal_1. Use when: no other calendar fits. (default)" */
export function calendarLine(c: BookingContext['calendars'][number]): string {
  const condition = c.instruction.trim()
  return `- ${c.name} (id ${c.id})${condition ? `: use when ${condition}` : ''}${c.is_default ? ' (default)' : ''}.`
}

/**
 * Booking: the types and the calendars, each with the owner's condition for when to use it. The model
 * picks both by their conditions; the API checks the calendar is one of the assistant's.
 */
export type BookingPromptOptions = {
  /** transfer_call is on this call. */
  /** call.start listed the caller's upcoming bookings. */
  listed?: boolean
  /** Caller ID gave the caller's number. */
  callerNumber?: boolean
  /** The owner's booking-name check is on (behaviour ask_booking_name). */
  nameChecked?: boolean
}

export function bookingInstructions(booking: BookingContext, { listed = false, callerNumber = false, nameChecked = false }: BookingPromptOptions = {}, pt: PromptTexts = defaultPromptTexts): string {
  const types = booking.appointmentTypes.map(type => typeLine(type, callerNumber)).join('\n')
  const calendars = booking.calendars.map(calendarLine).join('\n')
  return [
    pt('booking.types', { types }),
    // One calendar: the tools use it by themselves (calendar_id left out), so it is not listed.
    booking.calendars.length > 1 ? pt('booking.calendars', { calendars }) : null,
    booking.appointmentTypes.length > 1 ? pt('booking.pickType') : null,
    booking.calendars.length > 1 ? pt('booking.pickCalendar') : null,
    pt('booking.howTo'),
    // Kept in the prompt as well as at the tools: the costliest mistakes a light model makes when booking.
    pt('booking.onlyOffered'),
    canChangeBookings(booking)
      ? pt(listed ? (nameChecked ? 'booking.changeListedChecked' : 'booking.changeListed') : 'booking.change')
      : pt('booking.noChange'),
  ].filter(Boolean).join('\n\n')
}

/** Our delimiters around what callers and the team wrote; removed from that text so it cannot close them. */
const CALLER_TAGS = /<\s*\/?\s*caller_(?:notes|history|details)\b[^>]*>/gi
/** How the main assistant is told to use the steps. */
export const COLLECT_INSTRUCTIONS = PROMPT_TEXTS['tools.collect'].text

/** The longest contact note the assistant gets; longer ones are cut. */
export const CALLER_NOTE_MAX_CHARS = 2000

/** The contact's note as one line of plain text (whitespace collapsed, our delimiters removed, capped); null when there is none. */
export function callerNoteOf(contact: Pick<Contact, 'note'> | null | undefined): string | null {
  const note = contact?.note?.replace(CALLER_TAGS, ' ').replace(/\s+/g, ' ').trim()
  if (!note) return null
  const chars = [...note]
  return chars.length > CALLER_NOTE_MAX_CHARS ? `${chars.slice(0, CALLER_NOTE_MAX_CHARS - 1).join('')}…` : note
}

/**
 * Text from outside the business's own settings (a name callers gave, a greeting filled in with what the
 * business's system said about the caller) as one quoted line of data: no quotes or line breaks of its own,
 * so it cannot close the quote and read as an instruction. `max` cuts it.
 */
export function quotedData(text: string, max = Number.POSITIVE_INFINITY): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/["\u201C\u201D\u201E\u00AB\u00BB]/g, "'").replace(/\s+/g, ' ').trim()
  return `"${line.slice(0, max).trim()}"`
}

/**
 * The team's note on the contact this call matched, if any, always (Tim, 2026-11-15): the assistant takes it into
 * account for this caller. Notes also come from imports and API keys, so they are information, never rules that
 * override these instructions; fenced, as one line.
 */
export function callerNotesInstructions(contact: Pick<CallerContext, 'note'> | null | undefined, pt: PromptTexts = defaultPromptTexts): string | null {
  const note = callerNoteOf(contact)
  if (!note) return null
  return pt('call.notes', { notes: `<caller_notes>${note}</caller_notes>` })
}

/** What the business's own system said about the caller (the assistant's call-start webhook), as data. */
export function callerDetailsInstructions(details: CallerDetails | null | undefined, pt: PromptTexts = defaultPromptTexts): string | null {
  if (!details || !Object.keys(details).length) return null
  const lines = Object.entries(details).map(([name, value]) => `${name}: ${String(value)}`).join('\n')
  return pt('call.details', { details: `<caller_details>\n${fenceData(lines, ['caller_details'])}\n</caller_details>` })
}

/** One line of the caller's history, from call records: delimiters removed, whitespace collapsed. */
const historyText = (text: string) => text.replace(CALLER_TAGS, ' ').replace(/\s+/g, ' ').trim()

function historyLines(history: CallerHistory): string[] {
  const calls = history.recentCalls.map(c => {
    const parts = [c.title, c.summary, c.outcome ? `Outcome: ${c.outcome}.` : null, c.openSteps.length ? `Open next steps: ${c.openSteps.join('; ')}.` : null]
    return `- Call on ${c.when}: ${historyText(parts.filter(Boolean).join(' ')) || 'no summary'}`
  })
  const bookings = history.upcomingBookings.map(b => `- Appointment on ${b.when} (day ${b.date})${b.type ? `: ${historyText(b.type)}` : ''}`)
  return [
    ...(calls.length ? ['Earlier calls, newest first:', ...calls] : []),
    ...(bookings.length ? ['Upcoming appointments booked under the name on file:', ...bookings] : []),
  ]
}

/**
 * What the assistant knows about a returning caller: their last calls and upcoming appointments, when the owner's
 * "Know the caller's previous calls" switch is on (`enabled`). Summaries partly repeat what callers said, so they go
 * in as data between delimiters. null when there is nothing to tell.
 */
export function callerHistoryInstructions(caller: CallerContext | null | undefined, enabled = true, pt: PromptTexts = defaultPromptTexts): string | null {
  const lines = enabled && caller?.history ? historyLines(caller.history) : []
  if (!lines.length) return null
  return pt('call.history', { history: `<caller_history>\n${lines.join('\n')}\n</caller_history>` })
}

/**
 * Who is calling, as far as the line tells: the number from caller ID (the team has it with the call, so the assistant need
 * not ask for it) and whether it belongs to a contact with a name (then it need not ask for the name either). No
 * number: caller ID withheld or not a phone number ("anonymous"), or a test call from the web app.
 */
/** On a test call from the app there is no caller ID: the owner trying it says "the number I'm calling from". */
export const TEST_CALL_CALLER_ID = PROMPT_TEXTS['call.testCall'].text

/**
 * `keepNameBack`: the owner's "Ask for the booking name before changing an appointment" switch is on and the caller
 * can cancel or move an appointment, which the server checks by day and booked name; then the assistant never says
 * the contact's name first.
 */
export function callerIdInstructions(caller: CallerContext | null | undefined, { keepNameBack = false } = {}, pt: PromptTexts = defaultPromptTexts): string {
  const phone = isE164(caller?.phone) ? caller.phone : null
  if (!phone) return withSentence(pt('call.unknownNumber'), caller?.testCall ? pt('call.testCall') : null)
  const callerId = pt('call.callerId', { number: displayNumber(phone) })
  const name = caller?.name?.trim()
  if (!name) return callerId
  const contact = pt('call.savedContact', { caller: quotedData(name, CALLER_NAME_MAX), callerId })
  return withSentence(contact, keepNameBack ? pt('call.keepName') : null)
}

/**
 * The caller as the prompt sees them: the matched contact's name, note and number (caller ID), and their history.
 * `nameConfirmed`: the name was given or confirmed by the team (for a transfer's briefing; the prompt does not check).
 */
export type CallerContext = Pick<Contact, 'name' | 'note'> & {
  phone?: string | null
  nameConfirmed?: boolean
  history?: CallerHistory | null
  /** A test room (the web app's test call, a call test): no caller ID, by design. */
  testCall?: boolean
}

/**
 * language.team: the notes and booking details saved with tools are in the team's language (the workspace language).
 * language.spoken: tool results and the example lines in these instructions are English: without it a model goes back
 * to English after a tool.
 */

/**
 * Which languages the assistant speaks (assistants.languages): its main language, and the ones it may switch to.
 * `teamLanguage`: the workspace language, what it writes messages for the team in (English unless set).
 */
export function languageInstructions(assistant: Pick<Assistant, 'languages'> | null, teamLanguage = 'en', pt: PromptTexts = defaultPromptTexts): string {
  const main = mainLanguageOf(assistant?.languages)
  const others = otherLanguagesOf(assistant?.languages)
  const mainName = LANGUAGES[main]
  const teamRule = pt('language.team', { team: workspaceLanguageName(teamLanguage) })
  if (!others.length) {
    const only = pt('language.only', { main: mainName })
    if (main === 'en') return teamLanguage === 'en' ? only : `${only} ${teamRule}`
    return `${only} ${teamRule} ${pt('language.spoken')}`
  }
  return [
    pt('language.several', { main: mainName, all: languageNames([main, ...others]) }),
    pt('language.other', { main: mainName }),
    teamRule,
    pt('language.spoken'),
  ].join(' ')
}

/**
 * The language rule for a collection step (collect-task.ts); null: English only, the step's default. `spoken`: the
 * language spoken on the call now (followCallerLanguage). Once the caller switched to another allowed language, the step
 * speaks only that one: its own instructions and the tools' lines are English, and a rule that names the main language
 * as the fallback made steps ask for the name and number in the main language.
 */
export function collectLanguageRule(assistant: Pick<Assistant, 'languages'> | null, spoken?: Language): string | null {
  const main = mainLanguageOf(assistant?.languages)
  const others = otherLanguagesOf(assistant?.languages)
  if (main === 'en' && !others.length) return null
  const keep = 'Say what the tools tell you in that language; keep names, numbers, addresses and email addresses exactly as they are.'
  if (!others.length) return `Speak ${LANGUAGES[main]}. ${keep}`
  if (spoken && spoken !== main && others.includes(spoken)) {
    const name = LANGUAGES[spoken]
    return `The caller speaks ${name}: speak only ${name} in this step, from the first question on. These instructions and what the tools tell you are in English: say it in ${name}, and read numbers digit by digit and spelled letters back in ${name}; keep names, numbers, addresses and email addresses exactly as they are.`
  }
  return `Speak the language the caller has been speaking in this call if it is ${languageNames([main, ...others], 'or')}, else ${LANGUAGES[main]}; these instructions and the tools' lines being in English never change it. ${keep}`
}

/**
 * What the assistant is told once the caller switched to another allowed language (followCallerLanguage); null while
 * the main language is spoken. Without it a reply after a tool (a goodbye after end_call) went back to the main language.
 */
export function spokenLanguageRule(assistant: Pick<Assistant, 'languages'> | null, spoken: Language): string | null {
  const main = mainLanguageOf(assistant?.languages)
  if (spoken === main || !otherLanguagesOf(assistant?.languages).includes(spoken)) return null
  const name = LANGUAGES[spoken]
  return `The caller is speaking ${name} now: reply only in ${name}, also after a tool and in your goodbye, until the caller switches language. Read numbers and spelled letters back in ${name}.`
}

/**
 * The date and time in the workspace time zone when the call starts ("Thursday, November 12, 2026, 1:31 PM"), so the
 * assistant can say what day it is and work out "tomorrow". null without a time zone (an older API).
 */
export function clockInstructions(timeZone: string | null | undefined, now: number, pt: PromptTexts = defaultPromptTexts): string | null {
  if (!timeZone) return null
  try {
    const at = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now)
    // A day the caller names goes to the tools as said ("next Wednesday"); code works out the date (spoken-day.ts).
    return pt('call.clock', { now: at, timeZone })
  } catch {
    return null
  }
}

/**
 * `transfers`: the contacts the assistant can put the caller through to on this call (transferContactsFor); none: no transfer.
 * `caller`: the contact this call matched (null: withheld number); its note goes in as the team's notes, its
 * history (call.start's callerHistory) as what the records say.
 * `documents`: the assistant's reference documents (inline text, or the look_up tool).
 * The greeting is not in the instructions: the model has it as its own first message (the voice says it with say(),
 * which puts it into the conversation; a realtime model is asked for it with realtimeLine), as Vapi's firstMessage.
 */
export function buildInstructions(
  assistant: Assistant | null,
  hours?: BusinessHours | null,
  booking?: BookingContext | null,
  transfers: readonly TransferRule[] = [],
  caller?: CallerContext | null,
  timeZone?: string | null,
  now: number = Date.now(),
  callerDetails?: CallerDetails | null,
  lookup = false,
  teamLanguage = 'en',
  overrides?: PromptOverrides | null,
): string {
  // The fixed text: the instance admin's where it has some (Server admin › System prompt), else the defaults.
  const pt = promptTexts(overrides)
  const transfer = transfers.length > 0
  const nameChecked = behaviourOn(assistant?.behaviours, 'ask_booking_name')
  const name = assistant?.name ?? pt('role.nameFallback')
  const knowledge = assistant ? businessKnowledge(assistant) : ''
  // The booking context carries the business's time zone too, so a call that can book always has the clock line.
  const clock = clockInstructions(timeZone ?? booking?.timeZone, now, pt)
  return [
    // Right after who the assistant is: a later place let off-topic requests through (LLM tests, 2026-11-16).
    `${pt('role.intro', { name })}\n${pt('role.scope')}`,
    languageInstructions(assistant, teamLanguage, pt),
    // When to mention being an AI is the owner's setting; answering truthfully when asked is part of every mode.
    aiDisclosureInstructions(assistant?.ai_disclosure, pt),
    communicationStyleInstructions(assistant?.communication_style, pt),
    // A contact held while the office is closed: the assistant must not say it cannot transfer calls.
    cannotInstructions({ booking: !!booking, transfer: transfer || heldTransferContacts(assistant, hours).length > 0, lookup }, pt),
    booking
      ? bookingInstructions(booking, { listed: !!(behaviourOn(assistant?.behaviours, 'caller_history') && caller?.history?.upcomingBookings.length), callerNumber: !!caller, nameChecked }, pt)
      : null,
    knowledge ? pt('knowledge.heading', { knowledge }) : null,
    pt('knowledge.price'),
    // The owner's own words win over the general rules (what is urgent for them, their way of handling a call).
    pt(knowledge ? 'rules.headingBusiness' : 'rules.heading', { rules: callRules({ booking: !!booking, transfer }, pt) }),
    behavioursInstructions(assistant, pt),
    pt('tools.collect'),
    pt(transfer ? 'tools.replyTransfer' : 'tools.reply'),
    pt('tools.noFalseClaims'),
    pt('tools.private'),
    pt('tools.endCall'),
    // Everything that differs per call comes last, together: the part before it stays the same from call to call,
    // so the provider's prompt cache can reuse it.
    pt('call.heading'),
    clock,
    hoursContext(hours, !!booking, pt),
    callerIdInstructions(caller, { keepNameBack: nameChecked && !!booking && canChangeBookings(booking) }, pt),
    transfer ? transferInstructions(pt) : heldTransferInstructions(heldTransferContacts(assistant, hours), pt),
    callerNotesInstructions(caller, pt),
    callerDetailsInstructions(callerDetails, pt),
    callerHistoryInstructions(caller, behaviourOn(assistant?.behaviours, 'caller_history'), pt),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Starts the part of the instructions about this call (time, hours now, the caller, who can be reached). */
export const CALL_HEADING = PROMPT_TEXTS['call.heading'].text
