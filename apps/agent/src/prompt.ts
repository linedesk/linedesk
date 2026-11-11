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
  ].filter(Boolean).join('\n')
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
/** What the assistant says about opening hours: the hours and where now falls, or nothing when none are set. */
function hoursContext(hours: BusinessHours | null | undefined): string {
  if (!hours) return 'No business hours are set: do not tell callers when the office is open, unless the business text below says so.'
  if (hours.openNow) return hours.summary
  return `${hours.summary} The office is closed right now: take a message as usual and tell the caller the team will call back when the office opens, saying when. An emergency is still flagged as urgent.`
}

const MESSAGES_ONLY = 'You can do two things for the caller: save a message for the team with take_message, and flag the call as urgent with flag_urgent. You cannot book appointments, transfer calls, send anyone out or look anything up.'

/**
 * Booking: the types and the calendars with the owner's notes on when to use each. The model picks
 * the calendar; the API checks it is one of the assistant's.
 */
export function bookingInstructions(booking: BookingContext): string {
  const needs = (fields: string[]) => (fields.length ? `; before booking also ask for: ${fields.join(', ')}` : '')
  const types = booking.appointmentTypes.map(t => `- ${t.name} (${t.duration_min} minutes), id ${t.id}${needs(t.required_fields)}`).join('\n')
  const upcoming = booking.upcoming.map(b => `- ${b.title ?? 'Appointment'}, ${b.label}, booking id ${b.id}`).join('\n')
  const calendars = booking.calendars
    .map(c => `- ${c.name}, id ${c.id}: ${c.instruction.trim() || (c.is_default ? 'use when no other calendar fits' : 'no note')}${c.is_default ? ' (default)' : ''}`)
    .join('\n')
  return [
    'You can do three things for the caller: book an appointment, save a message for the team with take_message, and flag the call as urgent with flag_urgent. You cannot transfer calls or look anything else up.',
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

export function buildInstructions(assistant: Assistant | null, hours?: BusinessHours | null, booking?: BookingContext | null): string {
  const name = assistant?.name ?? 'the assistant'
  const knowledge = assistant ? businessKnowledge(assistant) : ''
  return [
    `You are ${name}, the AI assistant answering the phone for a business. You are on a live phone call: keep every reply to one or two short spoken sentences, start with a short first sentence, ask one question at a time, and never use lists, markdown or emojis.`,
    'Speak English only. If the caller speaks another language, say in English that you can only help in English and offer to take a message.',
    assistant?.greeting ? `You have already opened the call with: "${assistant.greeting}" Do not repeat it.` : null,
    'You are an AI assistant. Whenever the caller asks whether you are a person, a robot or an AI, say truthfully that you are an AI assistant. Never claim to be human.',
    booking ? bookingInstructions(booking) : MESSAGES_ONLY,
    hoursContext(hours),
    'Only state facts about the business that are given below; if you do not know something, say so and offer to take a message.',
    knowledge ? `What the business wants you to know:\n${knowledge}` : null,
    `How to handle calls:\n${callRulesOf(assistant?.call_rules)}`,
    'When you use a tool, say your reply in the same response as the tool call instead of waiting for its result: the caller should never wait in silence.',
    'Use take_message once per call, when you have what the team needs; do not save the same request twice.',
    'When the caller has nothing else, say goodbye briefly. After the caller has said goodbye too, say a short goodbye and use end_call in the same response; never keep talking after both of you said goodbye.',
  ].filter(Boolean).join('\n\n')
}
