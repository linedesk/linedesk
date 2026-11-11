// The assistant's system prompt, built from its configuration.
import { type BookingContext, callRulesOf } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import type { BusinessHours } from './call-session.ts'

export const FALLBACK_GREETING = 'Thanks for calling. How can I help?'

const line = (label: string, value?: string) => (value ? `${label}: ${value}` : null)

function businessFacts({ business_profile: p }: Assistant): string {
  const faqs = p.faqs?.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')
  return [
    line('About', p.description),
    line('Services', p.services?.join(', ')),
    line('Service area', p.service_area),
    line('Address', p.address),
    line('Hours', p.hours),
    faqs ? `Frequently asked questions:\n${faqs}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/** What the business told the assistant: its free-text instructions, or the older structured fields. */
function businessKnowledge(assistant: Assistant): string {
  const instructions = assistant.business_profile.instructions?.trim()
  return instructions || businessFacts(assistant)
}

/**
 * The system prompt. Fixed parts: how to speak on a phone line, honesty about being an AI, what the
 * assistant can do and how to use its tools. Editable by the owner: what the business wants it to
 * know (instructions) and how to handle calls (call_rules, or the default rules).
 */
/**
 * Outside business hours an assistant may greet and know something else: its outside variants, where
 * it has them. During hours, or when the workspace does not use hours (null), the usual ones.
 */
export function forHours(assistant: Assistant | null, hours: BusinessHours | null | undefined): Assistant | null {
  if (!assistant || !hours || hours.openNow) return assistant
  const greeting = assistant.greeting_outside?.trim() || assistant.greeting
  const instructions = assistant.instructions_outside?.trim()
  return {
    ...assistant,
    greeting,
    business_profile: instructions ? { ...assistant.business_profile, instructions } : assistant.business_profile,
  }
}

/** What the assistant says about opening hours: the hours and where now falls; nothing when the workspace does not use hours. */
function hoursContext(hours: BusinessHours | null | undefined): string | null {
  if (!hours) return null
  if (hours.openNow) return hours.summary
  return `${hours.summary} The office is closed right now: take a message as usual and tell the caller the team will call back when the office opens, saying when. An emergency is still flagged as urgent.`
}

const MESSAGES_ONLY = 'You can do two things for the caller: save a message for the team with take_message, and flag the call as urgent with flag_urgent. You cannot book appointments, transfer calls, send anyone out or look anything up.'
const MESSAGES_AND_TRANSFER = 'You can do three things for the caller: save a message for the team with take_message, flag the call as urgent with flag_urgent, and put an urgent caller through to the on-call person with transfer_call. You cannot book appointments, send anyone out or look anything up.'

/** How to put an urgent caller through; only when the assistant transfers urgent calls right now. */
export const TRANSFER_INSTRUCTIONS = "Urgent calls go to a person: this comes before the rules above, and applies while the office is closed too. For an emergency that needs a person right now (the instructions and rules above say what counts as one), do not take a message first: as soon as you know the caller's name and what happened, use transfer_call. Call it without saying anything yourself: it tells the caller that you are connecting them. Never transfer a call that is not urgent. Only if transfer_call says nobody took the call, tell the caller you could not reach anyone right now, take a message with how to reach them, and say the team will call back as soon as possible; the call is already flagged as urgent."

/**
 * Booking: the types and the calendars with the owner's notes on when to use each. The model picks
 * the calendar; the API checks it is one of the assistant's.
 */
export function bookingInstructions(booking: BookingContext, transfer = false): string {
  const needs = (fields: string[]) => (fields.length ? `; before booking also ask for: ${fields.join(', ')}` : '')
  const types = booking.appointmentTypes.map(t => `- ${t.name} (${t.duration_min} minutes), id ${t.id}${needs(t.required_fields)}`).join('\n')
  const upcoming = booking.upcoming.map(b => `- ${b.title ?? 'Appointment'}, ${b.label}, booking id ${b.id}`).join('\n')
  const calendars = booking.calendars
    .map(c => `- ${c.name}, id ${c.id}: ${c.instruction.trim() || (c.is_default ? 'use when no other calendar fits' : 'no note')}${c.is_default ? ' (default)' : ''}`)
    .join('\n')
  return [
    transfer
      ? 'You can do four things for the caller: book an appointment, save a message for the team with take_message, flag the call as urgent with flag_urgent, and put an urgent caller through to the on-call person with transfer_call. You cannot look anything else up.'
      : 'You can do three things for the caller: book an appointment, save a message for the team with take_message, and flag the call as urgent with flag_urgent. You cannot transfer calls or look anything else up.',
    `Today is ${booking.today} (${booking.todayDate}, time zone ${booking.timeZone}).`,
    `Appointment types:\n${types}`,
    `Calendars, with when to use each:\n${calendars}`,
    booking.calendars.length > 1
      ? 'Pick the calendar whose note fits the caller\'s request; if none fits, use the default.'
      : null,
    'To book: find out what the caller needs, then use find_slots with the appointment type, the calendar and the days the caller wants. Offer at most two or three of the times it returns, in plain words. When the caller picks one, ask for their name if you do not have it, and the address for a visit, then use book_appointment with that exact start. Only say the appointment is booked after book_appointment confirmed it. If no time suits or the calendar cannot be reached, take a message with the times the caller prefers.',
    'Never make up a free time: only offer times find_slots returned.',
    'If the caller gives an email address, pass it to book_appointment: they get the confirmation by email. Always confirm the day and time out loud.',
    upcoming
      ? `This caller's upcoming appointments, booked through us:\n${upcoming}\nYou may cancel one with cancel_appointment, or move it with find_slots and then reschedule_appointment, when the caller asks. Confirm which one first.`
      : 'You can only cancel or move appointments this caller booked with us earlier; they have none. For anything else, take a message.',
  ].filter(Boolean).join('\n\n')
}

/** `transfer`: the assistant puts urgent calls through to the on-call phone on this call (see transferNumberFor). */
export function buildInstructions(assistant: Assistant | null, hours?: BusinessHours | null, booking?: BookingContext | null, transfer = false): string {
  const name = assistant?.name ?? 'the assistant'
  const knowledge = assistant ? businessKnowledge(assistant) : ''
  return [
    `You are ${name}, the AI assistant answering the phone for a business. You are on a live phone call: keep every reply to one or two short spoken sentences, start with a short first sentence, ask one question at a time, and never use lists, markdown or emojis.`,
    'Speak English only. If the caller speaks another language, say in English that you can only help in English and offer to take a message.',
    assistant?.greeting ? `You have already opened the call with: "${assistant.greeting}" Do not repeat it.` : null,
    'You are an AI assistant. Whenever the caller asks whether you are a person, a robot or an AI, say truthfully that you are an AI assistant. Never claim to be human.',
    booking ? bookingInstructions(booking, transfer) : transfer ? MESSAGES_AND_TRANSFER : MESSAGES_ONLY,
    hoursContext(hours),
    'Only state facts about the business that are given below; if you do not know something, say so and offer to take a message.',
    knowledge ? `What the business wants you to know:\n${knowledge}` : null,
    `How to handle calls:\n${callRulesOf(assistant?.call_rules)}`,
    transfer ? TRANSFER_INSTRUCTIONS : null,
    'When you use a tool, say your reply in the same response as the tool call instead of waiting for its result: the caller should never wait in silence.',
    'Use take_message once per call, when you have what the team needs; do not save the same request twice.',
    'When the caller has nothing else, say goodbye briefly. After the caller has said goodbye too, say a short goodbye and use end_call in the same response; never keep talking after both of you said goodbye.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
