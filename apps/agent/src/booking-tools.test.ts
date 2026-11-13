import type { BookingContext } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { ActionError, type ApiClient } from './api-client.ts'
import { bookingTools, MAX_DESCRIBE_ATTEMPTS, spreadSlots } from './booking-tools.ts'
import { CallLog } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { buildInstructions, CHANGE_BOOKING_INSTRUCTIONS, calendarLine, typeLine } from './prompt.ts'
import { mergeToolResults } from './summary.ts'

const booking: BookingContext = {
  timeZone: 'America/Los_Angeles', today: 'Wednesday, November 11, 2026', todayDate: '2026-11-11',
  appointmentTypes: [
    { id: 'at_1', name: 'Repair visit', duration_min: 60, required_fields: ['name', 'address'], instruction: 'the caller has something broken' },
    { id: 'at_2', name: 'Appointment', duration_min: 30, required_fields: [], instruction: 'no other type fits' },
  ],
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
    callId: 'call_1', workspaceId: 'ws_1', assistant: { id: 'as_1' } as CallSession['assistant'], contact: {} as CallSession['contact'], caller: null, blocked: false, forwardingCheck: false, busy: false, overCap: false,
    businessHours: null, booking, lookups: [], businessNumber: null, simulatedOnCall: null, timeZone: null, append: async () => {}, finish: async () => {}, recordTimings: async () => {},
  }
}

function fakeApi(answer: (name: string, input: Record<string, unknown>) => unknown): ApiClient & { sent: [string, Record<string, unknown>, string | undefined][] } {
  const sent: [string, Record<string, unknown>, string | undefined][] = []
  return {
    sent,
    async run(def, input, scope) {
      sent.push([def.name, input as Record<string, unknown>, scope?.workspaceId])
      return { ok: true, rows: {}, data: answer(def.name, input as Record<string, unknown>) as Record<string, unknown> }
    },
    providerSettings: async () => ({}),
  }
}

/** An API that offers Day 17 at 17:00 (s1) and Day 19 at 22:00 (s2) on find_slots and answers the rest with `answer`. */
const offering = (answer: (name: string, input: Record<string, unknown>) => unknown) =>
  fakeApi((name, input) => (name === 'calendar.findSlots' ? { slots: [slot('17', '17:00'), slot('19', '22:00')] } : answer(name, input)))
const search = { appointment_type_id: 'at_1', calendar_id: 'acal_mike' }

test('offered times: two per day, the first and the last of it, six in all, earliest day first', () => {
  const slots = ['17', '17', '17', '18', '18', '19', '20', '21', '22'].map((day, i) => slot(day, `1${i}:00`))
  expect(spreadSlots(slots).map(s => s.label)).toEqual(['Day 17 at 10:00', 'Day 17 at 12:00', 'Day 18 at 13:00', 'Day 18 at 14:00', 'Day 19 at 15:00', 'Day 20 at 16:00'])
})

test('offered times: a single day is spread over the whole day, so an afternoon is offered too', () => {
  const day = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30'].map(t => slot('12', t))
  expect(spreadSlots(day).map(s => s.label)).toEqual(['Day 12 at 09:00', 'Day 12 at 10:30', 'Day 12 at 11:30', 'Day 12 at 13:00', 'Day 12 at 14:00', 'Day 12 at 15:30'])
})

test('find_slots asks for the chosen calendar and days on this call, and lists the times with their exact start', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => ({ slots: [slot('17', '17:00'), slot('17', '18:00')] }))
  const text = await bookingTools(api, call, log).findSlots({ appointment_type_id: 'at_1', calendar_id: 'acal_mike', from_date: '2026-11-17', to_date: null })
  expect(api.sent[0]).toEqual(['calendar.findSlots', { appointmentTypeId: 'at_1', calendarId: 'acal_mike', callId: 'call_1', limit: 60, fromDate: '2026-11-17' }, 'ws_1'])
  expect(text).toContain('- Day 17 at 17:00 [s1]')
  // A day not listed is searched before the assistant says anything about it; dates are said as written.
  expect(text).toContain('call find_slots again with from_date and to_date set to that day')
  expect(text).toContain('exactly as written; never change the date')
  // The times are local to the business; another zone is converted.
  expect(text).toContain("All these times are in the business's time zone (America/Los_Angeles).")
  expect(log.lines.at(-1)).toEqual({ speaker: 'system', text: 'Checked availability · Repair visit · 2 slots' })
})

test('book_appointment books for the call and the assistant, and the call ends as booked', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = offering(() => ({ bookingId: 'bk_1', start: '2026-11-17T17:00:00.000Z', end: '', label: 'Tuesday, November 17 at 9:00 AM', calendarName: 'Mike' }))
  const tools = bookingTools(api, call, log)
  await tools.findSlots(search)
  const text = await tools.book({ ...search, start: 's1', caller_name: 'Dana Ruiz', reason: 'Burst pipe', address: null })
  expect(api.sent[1]![1]).toMatchObject({ start: '2026-11-17T17:00:00.000Z' })
  expect(api.sent[1]![1]).toMatchObject({ callId: 'call_1', assistantId: 'as_1', calendarId: 'acal_mike', callerName: 'Dana Ruiz' })
  expect(api.sent[1]![1]).not.toHaveProperty('address')
  expect(text).toBe('Booked: Repair visit, Tuesday, November 17 at 9:00 AM. Confirm the day and time to the caller exactly as written here: Tuesday, November 17 at 9:00 AM.')
  expect(log.bookings).toEqual(['Repair visit, Tuesday, November 17 at 9:00 AM'])
  expect(mergeToolResults({ outcome: 'callback', title: 't', summary: 's' }, log).outcome).toBe('booked')
})

test('booked and transferred only from the tools: the summary guessing them without a booking or transfer falls back', () => {
  const none = { messages: [], urgent: false }
  expect(mergeToolResults({ outcome: 'booked', title: 't', summary: 's' }, none).outcome).toBe('callback')
  expect(mergeToolResults({ outcome: 'booked', title: 't', summary: 's' }, { ...none, messages: ['Friday works'] }).outcome).toBe('message')
  expect(mergeToolResults({ outcome: 'transferred', title: 't', summary: 's' }, none).outcome).toBe('callback')
})

test('a refused booking is not confirmed: the model hears why and what to do instead', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = offering(() => {
    throw new ActionError('appointment.book', 409, 'That time is not free any more: look for slots again.')
  })
  const tools = bookingTools(api, call, log)
  await tools.findSlots(search)
  const text = await tools.book({ ...search, start: 's2', caller_name: 'Dana', reason: 'r' })
  expect(text).toBe('The booking did not go through (That time is not free any more: look for slots again.). Do not say it is booked. Offer to look for another time, or take a message.')
  expect(log.bookings).toEqual([])
})

test('the prompt lists types and calendars with their notes only when the assistant can book', () => {
  const withBooking = buildInstructions(null, null, booking)
  expect(withBooking).toContain('where the business is (time zone America/Los_Angeles)')
  expect(withBooking).not.toContain('Today is')
  expect(withBooking).toContain(
    '- Repair visit (60 minutes), id at_1. Use when: the caller has something broken. Before booking ask for: name, address.',
  )
  expect(withBooking).toContain(
    '- Appointment (30 minutes), id at_2. Use when: no other type fits. No details to ask for beyond the reason.',
  )
  expect(withBooking).toContain('Pick the appointment type that fits the caller\'s request by its name and, where it has one, its "Use when" condition')
  // The caller's bookings are never in the prompt: the caller describes one, the API checks it.
  expect(withBooking).toContain(CHANGE_BOOKING_INSTRUCTIONS)
  expect(withBooking).not.toMatch(/booking id|upcoming appointments/)
  const noChanges = buildInstructions(null, null, { ...booking, canChangeBookings: false })
  expect(noChanges).toContain('You cannot cancel or move appointments on this call')
  expect(noChanges).not.toContain(CHANGE_BOOKING_INSTRUCTIONS)
  // An API of an older version does not say: no changes.
  expect(buildInstructions(null, null, { ...booking, canChangeBookings: undefined as unknown as boolean })).not.toContain(CHANGE_BOOKING_INSTRUCTIONS)
  expect(withBooking).toContain('- Office, id acal_office. Use when: Estimates. (default)')
  expect(withBooking).toContain('- Mike, id acal_mike. Use when: Emergencies.')
  expect(withBooking).toContain(
    'Pick the calendar whose "Use when" condition fits the caller\'s request; if none fits, use the default.',
  )
  expect(withBooking).not.toContain('You cannot book appointments')
  expect(buildInstructions(null, null, null)).toContain('You cannot book appointments')
})

test('cancel and reschedule name the call and the booking as the caller described it, never a booking id', async () => {
  const call = session()
  const log = new CallLog(call)
  log.confirmedName = 'Sam Patel'
  const api = offering(name => (name === 'appointment.cancel'
    ? { eventDeleted: true, label: 'Tuesday, November 17 at 9:00 AM' }
    : { bookingId: 'bk_1', start: 'x', end: '', label: 'Thursday, November 19 at 2:00 PM', calendarName: 'Office' }))
  const tools = bookingTools(api, call, log)
  const which = { booking_date: '2026-11-17' }
  const searched = { appointment_type_id: 'at_1', calendar_id: 'acal_office' }
  await tools.findSlots(searched)
  expect(await tools.reschedule(which, 's2', searched)).toBe('Moved to Thursday, November 19 at 2:00 PM. Confirm the new day and time to the caller.')
  expect(await tools.cancel(which)).toBe('Cancelled the appointment on Tuesday, November 17 at 9:00 AM. Tell the caller it is cancelled.')
  expect(api.sent.slice(1).map(([name, input]) => [name, input])).toEqual([
    ['appointment.reschedule', { bookingDate: '2026-11-17', bookedName: 'Sam Patel', callId: 'call_1', start: '2026-11-19T22:00:00.000Z', appointmentTypeId: 'at_1', calendarId: 'acal_office' }],
    ['appointment.cancel', { bookingDate: '2026-11-17', bookedName: 'Sam Patel', callId: 'call_1', readsRefusals: true }],
  ])
})

test(`after ${MAX_DESCRIBE_ATTEMPTS} refusals, the assistant stops guessing on that call`, async () => {
  const call = session()
  // The API refuses as data (the miss is kept on its side), whatever the reason.
  const api = offering(() => ({ changed: false, refused: 'no booking of this caller matches that day and name: take a message instead' }))
  const log = new CallLog(call)
  log.confirmedName = 'Sam Patel'
  const tools = bookingTools(api, call, log)
  await tools.findSlots(search)
  for (let i = 0; i < MAX_DESCRIBE_ATTEMPTS; i++) {
    expect(await tools.cancel({ booking_date: '2026-11-17' })).toMatch(/^That did not work \(no booking of this caller matches.*Do not guess another day, name or time/)
  }
  expect(await tools.reschedule({ booking_date: '2026-11-18' }, 's2', { appointment_type_id: 'at_1', calendar_id: 'acal_office' }))
    .toMatch(/Do not try again: take a message/)
  expect(api.sent).toHaveLength(MAX_DESCRIBE_ATTEMPTS + 1)
})

test('a time that is not free on reschedule never reads as moved, and is no failed try: the caller picks another time', async () => {
  const call = session()
  const api = offering(() => ({ changed: false, refused: 'That time is not free: look for slots again.', slotTaken: true }))
  const log = new CallLog(call)
  log.confirmedName = 'Sam Patel'
  const tools = bookingTools(api, call, log)
  await tools.findSlots(search)
  for (let i = 0; i < MAX_DESCRIBE_ATTEMPTS + 1; i++) {
    const text = await tools.reschedule({ booking_date: '2026-11-17' }, 's2', { appointment_type_id: 'at_1', calendar_id: 'acal_office' })
    expect(text).toMatch(/^That time is not free any more\. Look for slots again/)
    expect(text).not.toMatch(/Moved/)
  }
  expect(api.sent).toHaveLength(MAX_DESCRIBE_ATTEMPTS + 2)
})

test('a start that find_slots never offered is not sent: the model gets the offered keys', async () => {
  const call = session()
  const api = offering(() => ({ bookingId: 'bk_1', start: '', end: '', label: '', calendarName: 'Mike' }))
  const tools = bookingTools(api, call, new CallLog(call))
  expect(await tools.book({ ...search, start: 's1', reason: 'r' })).toMatch(/none yet, call find_slots first/)
  await tools.findSlots(search)
  // 1:00 PM in Portland written as 13:00 UTC: never offered.
  expect(await tools.book({ ...search, start: '2026-11-17T13:00:00.000Z', reason: 'r' })).toBe(
    'That is not a time find_slots offered. Use the key in brackets of one of these: Day 17 at 17:00 [s1], Day 19 at 22:00 [s2].',
  )
  // The exact start of an offered time still works.
  await tools.book({ ...search, start: '2026-11-19T22:00:00.000Z', reason: 'r' })
  expect(api.sent.map(([name]) => name)).toEqual(['calendar.findSlots', 'appointment.book'])
})

test('an email that is not valid is asked for again, not sent: the booking would fail on it', async () => {
  const call = session()
  const api = offering(() => ({ bookingId: 'bk_1', start: '2026-11-17T17:00:00.000Z', end: '', label: 'Tuesday', calendarName: 'Mike' }))
  const tools = bookingTools(api, call, new CallLog(call))
  await tools.findSlots(search)
  expect(await tools.book({ ...search, start: 's1', reason: 'r', email: 'test at brightwater dot example' })).toMatch(/is not a valid email address\. Get it with get_email/)
  await tools.book({ ...search, start: 's1', reason: 'r', email: ' test@brightwater.example ' })
  expect(api.sent.map(([name]) => name)).toEqual(['calendar.findSlots', 'appointment.book'])
  expect(api.sent[1]![1]).toMatchObject({ callerEmail: 'test@brightwater.example' })
})

test('no free times beyond the booking window: the assistant hears the last bookable day', async () => {
  const call = session()
  const api = fakeApi(() => ({ slots: [], bookableUntil: 'Wednesday, November 25' }))
  const text = await bookingTools(api, call, new CallLog(call)).findSlots({ ...search, from_date: '2026-12-03', to_date: '2026-12-03' })
  expect(text).toContain('This appointment can be booked up to Wednesday, November 25 at the latest')
})

test('the same time is not booked twice on one call', async () => {
  const call = session()
  const api = offering(() => ({ bookingId: 'bk_1', start: '2026-11-17T17:00:00.000Z', end: '', label: 'Tuesday, November 17 at 9:00 AM', calendarName: 'Mike' }))
  const tools = bookingTools(api, call, new CallLog(call))
  await tools.findSlots(search)
  await tools.book({ ...search, start: 's1', reason: 'r' })
  expect(await tools.book({ ...search, start: 's1', reason: 'r', address: '220 NE Alberta St' })).toMatch(/^That time is already booked on this call/)
  expect(api.sent.map(([name]) => name)).toEqual(['calendar.findSlots', 'appointment.book'])
})

test('conditions: a default calendar without one is used when no other fits; one type needs no picking rule', () => {
  expect(calendarLine({ id: 'acal_1', name: 'Office', instruction: ' ', is_default: true })).toBe('- Office, id acal_1. Use when: no other calendar fits. (default)')
  expect(calendarLine({ id: 'acal_2', name: 'Mike', instruction: '', is_default: false })).toBe('- Mike, id acal_2.')
  const one = buildInstructions(null, null, { ...booking, appointmentTypes: [booking.appointmentTypes[0]!] })
  expect(one).not.toContain('Pick the appointment type')
})

test('an API of an older version lists no name and no condition: the name is still asked for', () => {
  expect(typeLine({ id: 'at_1', name: 'Repair visit', duration_min: 60, required_fields: ['address'] })).toBe('- Repair visit (60 minutes), id at_1. Before booking ask for: name, address.')
})

test('book_appointment without a name sends none, for a type that does not ask for it', async () => {
  const call = session()
  const api = offering(() => ({ bookingId: 'bk_1', start: '2026-11-17T17:00:00.000Z', end: '', label: 'Tuesday', calendarName: 'Mike' }))
  const tools = bookingTools(api, call, new CallLog(call))
  await tools.findSlots({ appointment_type_id: 'at_2', calendar_id: 'acal_mike' })
  await tools.book({ appointment_type_id: 'at_2', calendar_id: 'acal_mike', start: 's1', caller_name: ' ', reason: 'Quote' })
  expect(api.sent[1]![1]).not.toHaveProperty('callerName')
})

test('no cancel or move before the caller confirmed their name on this call: the model never fills in a name', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = offering(() => ({ eventDeleted: true, label: 'Monday, November 16 at 1:00 PM' }))
  const tools = bookingTools(api, call, log)
  await tools.findSlots(search)
  expect(await tools.cancel({ booking_date: '2026-11-16' })).toMatch(/^Before you cancel or move an appointment, get the caller's full name with get_name/)
  expect(await tools.reschedule({ booking_date: '2026-11-16' }, 's1', search)).toMatch(/^Before you cancel or move/)
  expect(api.sent.map(([name]) => name)).toEqual(['calendar.findSlots'])
  log.confirmedName = 'Donna Ruiz'
  await tools.cancel({ booking_date: '2026-11-16' })
  expect(api.sent[1]![1]).toMatchObject({ bookingDate: '2026-11-16', bookedName: 'Donna Ruiz' })
})


test('find_slots takes the day as the caller said it; an ambiguous one is asked back, nothing searched', async () => {
  const call = session()
  const log = new CallLog(call)
  const api = fakeApi(() => ({ slots: [slot('17', '17:00')] }))
  const tools = bookingTools(api, call, log)
  const asked = await tools.findSlots({ ...search, from_date: 'next Wednesday', to_date: null })
  expect(asked).toMatch(/can mean Wednesday, November \d+ or Wednesday, November \d+\. Ask the caller which one/)
  expect(api.sent).toEqual([])
  await tools.findSlots({ ...search, from_date: 'November 17', to_date: 'November 18' })
  expect(api.sent[0]?.[1]).toMatchObject({ fromDate: '2026-11-17', toDate: '2026-11-18' })
})

test('cancel_appointment takes the day as the caller said it; a day it cannot read is asked again, not guessed', async () => {
  const call = session()
  const log = new CallLog(call)
  log.confirmedName = 'Sam Lee'
  const api = fakeApi(() => ({ changed: true, label: 'Tuesday, November 17 at 9:00 AM' }))
  const tools = bookingTools(api, call, log)
  expect(await tools.cancel({ booking_date: 'sometime' })).toContain('Ask the caller for the date')
  expect(api.sent).toEqual([])
  await tools.cancel({ booking_date: 'November 17' })
  expect(api.sent[0]?.[1]).toMatchObject({ bookingDate: '2026-11-17', bookedName: 'Sam Lee' })
})
