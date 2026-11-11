import type { BookingContext } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { ActionError, type ApiClient } from './api-client.ts'
import { bookingTools, spreadSlots } from './booking-tools.ts'
import { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { buildInstructions } from './prompt.ts'
import { mergeToolResults } from './summary.ts'

const booking: BookingContext = {
  timeZone: 'America/Los_Angeles', today: 'Wednesday, November 11, 2026', todayDate: '2026-11-11',
  appointmentTypes: [{ id: 'at_1', name: 'Repair visit', duration_min: 60, required_fields: ['address'] }],
  upcoming: [],
  calendars: [
    { id: 'acal_office', name: 'Office', instruction: 'Estimates', is_default: true },
    { id: 'acal_mike', name: 'Mike', instruction: 'Emergencies', is_default: false },
  ],
}

const slot = (day: string, time: string) => ({ start: `2026-11-${day}T${time}:00.000Z`, end: '', label: `Day ${day} at ${time}` })

function session(): CallSession {
  return {
    callId: 'call_1', workspaceId: 'ws_1', assistant: { id: 'as_1' } as CallSession['assistant'], contact: {} as CallSession['contact'], blocked: false,
    businessHours: null, booking, append: async () => {}, finish: async () => {},
  }
}

function fakeApi(answer: (name: string, input: Record<string, unknown>) => unknown): ApiClient & { sent: [string, Record<string, unknown>, string | undefined][] } {
  const sent: [string, Record<string, unknown>, string | undefined][] = []
  return {
    sent,
    async run(def, input, workspaceId) {
      sent.push([def.name, input as Record<string, unknown>, workspaceId])
      return { ok: true, rows: {}, data: answer(def.name, input as Record<string, unknown>) as Record<string, unknown> }
    },
    providerSettings: async () => ({}),
  }
}

test('offered times: at most two per day and six in all, earliest first', () => {
  const slots = ['17', '17', '17', '18', '18', '19', '20', '21', '22'].map((day, i) => slot(day, `1${i}:00`))
  expect(spreadSlots(slots).map(s => s.label)).toEqual(['Day 17 at 10:00', 'Day 17 at 11:00', 'Day 18 at 13:00', 'Day 18 at 14:00', 'Day 19 at 15:00', 'Day 20 at 16:00'])
})

test('find_slots asks for the chosen calendar and days, and lists the times with their exact start', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => ({ slots: [slot('17', '17:00'), slot('17', '18:00')] }))
  const text = await bookingTools(api, call, log).findSlots({ appointment_type_id: 'at_1', calendar_id: 'acal_mike', from_date: '2026-11-17', to_date: null })
  expect(api.sent[0]).toEqual(['calendar.findSlots', { appointmentTypeId: 'at_1', calendarId: 'acal_mike', limit: 60, fromDate: '2026-11-17' }, 'ws_1'])
  expect(text).toContain('- Day 17 at 17:00 [2026-11-17T17:00:00.000Z]')
  expect(log.lines.at(-1)).toEqual({ speaker: 'system', text: 'Checked availability · Repair visit · 2 slots' })
})

test('book_appointment books for the call and the assistant, and the call ends as booked', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => ({ bookingId: 'bk_1', start: '2026-11-17T17:00:00.000Z', end: '', label: 'Tuesday, November 17 at 9:00 AM', calendarName: 'Mike' }))
  const text = await bookingTools(api, call, log).book({ appointment_type_id: 'at_1', calendar_id: 'acal_mike', start: '2026-11-17T17:00:00.000Z', caller_name: 'Dana Ruiz', reason: 'Burst pipe', address: null })
  expect(api.sent[0]![1]).toMatchObject({ callId: 'call_1', assistantId: 'as_1', calendarId: 'acal_mike', callerName: 'Dana Ruiz' })
  expect(api.sent[0]![1]).not.toHaveProperty('address')
  expect(text).toBe('Booked: Repair visit, Tuesday, November 17 at 9:00 AM. Confirm the day and time to the caller.')
  expect(log.bookings).toEqual(['Repair visit, Tuesday, November 17 at 9:00 AM'])
  expect(mergeToolResults({ outcome: 'callback', title: 't', summary: 's' }, log).outcome).toBe('booked')
})

test('a refused booking is not confirmed: the model hears why and what to do instead', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => {
    throw new ActionError('appointment.book', 409, 'That time is not free any more: look for slots again.')
  })
  const text = await bookingTools(api, call, log).book({ appointment_type_id: 'at_1', calendar_id: 'acal_mike', start: 'x', caller_name: 'Dana', reason: 'r' })
  expect(text).toBe('The booking did not go through (That time is not free any more: look for slots again.). Do not say it is booked. Offer to look for another time, or take a message.')
  expect(log.bookings).toEqual([])
})

test('the prompt lists types and calendars with their notes only when the assistant can book', () => {
  const withBooking = buildInstructions(null, null, booking)
  expect(withBooking).toContain('Today is Wednesday, November 11, 2026 (2026-11-11, time zone America/Los_Angeles).')
  expect(withBooking).toContain('- Repair visit (60 minutes), id at_1; before booking also ask for: address')
  expect(withBooking).toContain('they have none')
  expect(buildInstructions(null, null, { ...booking, upcoming: [{ id: 'bk_1', title: 'Repair visit · Sam', label: 'Tuesday, November 17 at 9:00 AM' }] }))
    .toContain('- Repair visit · Sam, Tuesday, November 17 at 9:00 AM, booking id bk_1')
  expect(withBooking).toContain('- Office, id acal_office: Estimates (default)')
  expect(withBooking).toContain('- Mike, id acal_mike: Emergencies')
  expect(withBooking).toContain("Pick the calendar whose note fits the caller's request")
  expect(withBooking).not.toContain('You cannot book appointments')
  expect(buildInstructions(null, null, null)).toContain('You cannot book appointments')
})

test('cancel and reschedule always name the call, so the API only lets the caller change their own bookings', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => ({ bookingId: 'bk_1', start: 'x', end: '', label: 'Thursday, November 19 at 2:00 PM', calendarName: 'Office' }))
  const tools = bookingTools(api, call, log)
  expect(await tools.reschedule('bk_1', '2026-11-19T22:00:00.000Z')).toBe('Moved to Thursday, November 19 at 2:00 PM. Confirm the new day and time to the caller.')
  expect(await tools.cancel('bk_1')).toBe('Cancelled. Tell the caller the appointment is cancelled.')
  expect(api.sent.map(([name, input]) => [name, input.callId])).toEqual([['appointment.reschedule', 'call_1'], ['appointment.cancel', 'call_1']])
})
