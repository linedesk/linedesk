import type { BookingContext } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { ActionError, type ApiClient } from './api-client.ts'
import { bookingTools, MAX_DESCRIBE_ATTEMPTS, spreadSlots } from './booking-tools.ts'
import { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { buildInstructions, CHANGE_BOOKING_INSTRUCTIONS } from './prompt.ts'
import { mergeToolResults } from './summary.ts'

const booking: BookingContext = {
  timeZone: 'America/Los_Angeles', today: 'Wednesday, November 11, 2026', todayDate: '2026-11-11',
  appointmentTypes: [{ id: 'at_1', name: 'Repair visit', duration_min: 60, required_fields: ['address'] }],
  upcoming: [],
  canChangeBookings: true,
  calendars: [
    { id: 'acal_office', name: 'Office', instruction: 'Estimates', is_default: true },
    { id: 'acal_mike', name: 'Mike', instruction: 'Emergencies', is_default: false },
  ],
}

const slot = (day: string, time: string) => ({ start: `2026-11-${day}T${time}:00.000Z`, end: '', label: `Day ${day} at ${time}` })

function session(): CallSession {
  return {
    callId: 'call_1', workspaceId: 'ws_1', assistant: { id: 'as_1' } as CallSession['assistant'], contact: {} as CallSession['contact'], caller: null, blocked: false,
    businessHours: null, booking, businessNumber: null, simulatedOnCall: null, append: async () => {}, finish: async () => {},
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
  // The caller's bookings are never in the prompt: the caller describes one, the API checks it.
  expect(withBooking).toContain(CHANGE_BOOKING_INSTRUCTIONS)
  expect(withBooking).not.toMatch(/booking id|upcoming appointments/)
  const noChanges = buildInstructions(null, null, { ...booking, canChangeBookings: false })
  expect(noChanges).toContain('You cannot cancel or move appointments on this call')
  expect(noChanges).not.toContain(CHANGE_BOOKING_INSTRUCTIONS)
  // An API of an older version does not say: no changes.
  expect(buildInstructions(null, null, { ...booking, canChangeBookings: undefined as unknown as boolean })).not.toContain(CHANGE_BOOKING_INSTRUCTIONS)
  expect(withBooking).toContain('- Office, id acal_office: Estimates (default)')
  expect(withBooking).toContain('- Mike, id acal_mike: Emergencies')
  expect(withBooking).toContain("Pick the calendar whose note fits the caller's request")
  expect(withBooking).not.toContain('You cannot book appointments')
  expect(buildInstructions(null, null, null)).toContain('You cannot book appointments')
})

test('cancel and reschedule name the call and the booking as the caller described it, never a booking id', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(name => (name === 'appointment.cancel'
    ? { eventDeleted: true, label: 'Tuesday, November 17 at 9:00 AM' }
    : { bookingId: 'bk_1', start: 'x', end: '', label: 'Thursday, November 19 at 2:00 PM', calendarName: 'Office' }))
  const tools = bookingTools(api, call, log)
  const which = { booking_date: '2026-11-17', booked_name: 'Sam Patel' }
  expect(await tools.reschedule(which, '2026-11-19T22:00:00.000Z')).toBe('Moved to Thursday, November 19 at 2:00 PM. Confirm the new day and time to the caller.')
  expect(await tools.cancel(which)).toBe('Cancelled the appointment on Tuesday, November 17 at 9:00 AM. Tell the caller it is cancelled.')
  expect(api.sent.map(([name, input]) => [name, input])).toEqual([
    ['appointment.reschedule', { bookingDate: '2026-11-17', bookedName: 'Sam Patel', callId: 'call_1', start: '2026-11-19T22:00:00.000Z' }],
    ['appointment.cancel', { bookingDate: '2026-11-17', bookedName: 'Sam Patel', callId: 'call_1' }],
  ])
})

test(`after ${MAX_DESCRIBE_ATTEMPTS} descriptions that match no booking, the assistant stops guessing on that call`, async () => {
  const call = session()
  const api = fakeApi(() => {
    throw new ActionError('appointment.cancel', 409, 'no booking of this caller matches that day and name: take a message instead')
  })
  const tools = bookingTools(api, call, new CallLog(call))
  for (let i = 0; i < MAX_DESCRIBE_ATTEMPTS; i++) {
    expect(await tools.cancel({ booking_date: '2026-11-17', booked_name: `Guess ${i}` })).toMatch(/^Cancelling did not work \(no booking of this caller matches.*Do not guess another day or name/)
  }
  expect(await tools.reschedule({ booking_date: '2026-11-18', booked_name: 'Another' }, '2026-11-19T22:00:00.000Z')).toMatch(/Do not try again: take a message/)
  expect(api.sent).toHaveLength(MAX_DESCRIBE_ATTEMPTS)
})
