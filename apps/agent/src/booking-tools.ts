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
        appointmentTypeId: args.appointment_type_id, calendarId: args.calendar_id, limit: SEARCH_LIMIT,
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

  async function cancel(bookingId: string): Promise<string> {
    try {
      await api.run(appointmentCancel, { bookingId, callId }, workspaceId)
      log.record('system', 'Cancelled an appointment', appointmentCancel.name)
      return 'Cancelled. Tell the caller the appointment is cancelled.'
    } catch (e) {
      return `Cancelling did not work (${failure(e)}). Take a message for the team instead.`
    }
  }

  async function reschedule(bookingId: string, start: string): Promise<string> {
    try {
      const { data } = await api.run(appointmentReschedule, { bookingId, start, callId }, workspaceId)
      const moved = data as BookData
      log.bookings.push(`moved to ${moved.label}`)
      log.record('system', `Rescheduled · ${moved.label} · ${moved.calendarName}`, appointmentReschedule.name)
      return `Moved to ${moved.label}. Confirm the new day and time to the caller.`
    } catch (e) {
      return `Moving it did not work (${failure(e)}). Do not say it moved. Offer another time, or take a message.`
    }
  }

  return { findSlots, book, cancel, reschedule }
}
