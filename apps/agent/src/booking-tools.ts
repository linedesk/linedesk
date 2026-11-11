// The assistant's booking tools: find free times in one of its calendars, and book one. Both go
// through the API (calendar.findSlots, appointment.book); the API checks the calendar is the
// assistant's and the time still free. Results are short sentences the model can say.
import { appointmentBook, appointmentCancel, appointmentReschedule, type BookData, calendarFindSlots, type FindSlotsData } from '@linedesk/actions'
import { ActionError, type ApiClient } from './api-client.ts'
import type { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'

/** Times the model gets to choose from: a few per day over a few days reads well on the phone. */
const PER_DAY = 2
const MAX_OFFERED = 6
/** Slots asked from the API; enough to spread over several days. */
const SEARCH_LIMIT = 60

/** A booking as the caller described it: its day (YYYY-MM-DD) and the name it is under; the API checks both. */
export type DescribedBooking = { booking_date: string; booked_name: string }
/** Descriptions that matched no booking before the assistant stops trying on a call (no guessing names or days). */
export const MAX_DESCRIBE_ATTEMPTS = 2

export type FindSlotsArgs = { appointment_type_id: string; calendar_id: string; from_date?: string | null; to_date?: string | null }
export type BookArgs = {
  appointment_type_id: string; calendar_id: string; start: string; caller_name: string; reason: string; address?: string | null; email?: string | null
}

/** At most PER_DAY slots per local day, MAX_OFFERED in all, earliest first. */
export function spreadSlots(slots: FindSlotsData['slots']): FindSlotsData['slots'] {
  const perDay = new Map<string, number>()
  const out: FindSlotsData['slots'] = []
  for (const slot of slots) {
    const day = slot.label.split(' at ')[0]!
    const count = perDay.get(day) ?? 0
    if (count >= PER_DAY) continue
    perDay.set(day, count + 1)
    out.push(slot)
    if (out.length >= MAX_OFFERED) break
  }
  return out
}

const failure = (e: unknown) => (e instanceof ActionError ? e.message.replace(/^[\w.]+ failed \(\d+\): /, '') : 'the calendar did not answer')

export function bookingTools(api: ApiClient, call: CallSession, log: CallLog) {
  const { callId, workspaceId } = call
  const typeName = (id: string) => call.booking?.appointmentTypes.find(t => t.id === id)?.name ?? 'appointment'

  async function findSlots(args: FindSlotsArgs): Promise<string> {
    try {
      const { data } = await api.run(calendarFindSlots, {
        appointmentTypeId: args.appointment_type_id, calendarId: args.calendar_id, callId, limit: SEARCH_LIMIT,
        ...(args.from_date ? { fromDate: args.from_date } : {}), ...(args.to_date ? { toDate: args.to_date } : {}),
      }, workspaceId)
      const offered = spreadSlots((data as FindSlotsData).slots)
      log.record('system', `Checked availability · ${typeName(args.appointment_type_id)} · ${offered.length} slot${offered.length === 1 ? '' : 's'}`, calendarFindSlots.name)
      if (!offered.length) return 'No free times in that range. Ask whether another day works, or take a message with the times the caller prefers.'
      return `Free times (offer two or three; book with the exact start in brackets):\n${offered.map(s => `- ${s.label} [${s.start}]`).join('\n')}`
    } catch (e) {
      log.record('system', 'Could not check availability', calendarFindSlots.name)
      return `Checking the calendar failed (${failure(e)}). Apologize and take a message with the times the caller prefers.`
    }
  }

  async function book(args: BookArgs): Promise<string> {
    try {
      const { data } = await api.run(appointmentBook, {
        appointmentTypeId: args.appointment_type_id, calendarId: args.calendar_id, start: args.start, callerName: args.caller_name, reason: args.reason,
        ...(args.address ? { address: args.address } : {}), ...(args.email ? { callerEmail: args.email } : {}), callId, ...(call.assistant ? { assistantId: call.assistant.id } : {}),
      }, workspaceId)
      const booked = data as BookData
      const what = `${typeName(args.appointment_type_id)}, ${booked.label}`
      log.bookings.push(what)
      log.record('system', `Booked · ${what} · ${booked.calendarName}`, appointmentBook.name)
      return `Booked: ${what}. Confirm the day and time to the caller.`
    } catch (e) {
      log.record('system', 'Booking failed', appointmentBook.name)
      return `The booking did not go through (${failure(e)}). Do not say it is booked. Offer to look for another time, or take a message.`
    }
  }

  /** Failed attempts to describe a booking on this call: after MAX_DESCRIBE_ATTEMPTS, no more guesses. */
  let failedDescriptions = 0
  const described = ({ booking_date, booked_name }: DescribedBooking) => ({ bookingDate: booking_date, bookedName: booked_name, callId })
  const outOfAttempts = () => failedDescriptions >= MAX_DESCRIBE_ATTEMPTS
  const refused = (e: unknown, what: string) => {
    if (e instanceof ActionError && /no booking of this caller matches/.test(e.message)) failedDescriptions++
    return `${what} did not work (${failure(e)}). Do not guess another day or name: take a message for the team instead.`
  }
  const NO_MORE = 'The booking could not be found on this call. Do not try again: take a message for the team instead.'

  async function cancel(which: DescribedBooking): Promise<string> {
    if (outOfAttempts()) return NO_MORE
    try {
      const { data } = await api.run(appointmentCancel, described(which), workspaceId)
      log.record('system', 'Cancelled an appointment', appointmentCancel.name)
      const label = (data as { label?: string } | undefined)?.label
      return `Cancelled${label ? ` the appointment on ${label}` : ''}. Tell the caller it is cancelled.`
    } catch (e) {
      log.record('system', 'Could not cancel an appointment', appointmentCancel.name)
      return refused(e, 'Cancelling')
    }
  }

  async function reschedule(which: DescribedBooking, start: string): Promise<string> {
    if (outOfAttempts()) return NO_MORE
    try {
      const { data } = await api.run(appointmentReschedule, { ...described(which), start }, workspaceId)
      const moved = data as BookData
      log.bookings.push(`moved to ${moved.label}`)
      log.record('system', `Rescheduled · ${moved.label} · ${moved.calendarName}`, appointmentReschedule.name)
      return `Moved to ${moved.label}. Confirm the new day and time to the caller.`
    } catch (e) {
      log.record('system', 'Could not move an appointment', appointmentReschedule.name)
      return refused(e, 'Moving it')
    }
  }

  return { findSlots, book, cancel, reschedule }
}
