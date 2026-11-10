import { describe, expect, it } from 'vitest'
import { findSlots, type FindSlotsInput, type WorkingHours } from './slots.ts'

const LA = 'America/Los_Angeles'
const weekdays = (start_time: string, end_time: string): WorkingHours[] => [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_time, end_time }))
const everyDay = (start_time: string, end_time: string): WorkingHours[] => [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start_time, end_time }))

// Monday 12 January 2026, 06:00 in Los Angeles (PST = UTC-8).
const base: FindSlotsInput = {
  timeZone: LA,
  hours: weekdays('09:00', '17:00'),
  exceptions: [],
  appointmentType: { duration_min: 60, buffer_min: 0, min_notice_hours: 0, max_days_ahead: 30 },
  busy: [],
  window: { start: '2026-01-12T00:00:00-08:00', end: '2026-01-13T00:00:00-08:00' },
  now: '2026-01-12T06:00:00-08:00',
}
const slots = (over: Partial<FindSlotsInput> = {}) => findSlots({ ...base, ...over })
const type = (over: Partial<FindSlotsInput['appointmentType']>) => ({ ...base.appointmentType, ...over })
/** Slot starts as Los Angeles wall-clock `MM-DD HH:MM`. */
const starts = (over: Partial<FindSlotsInput> = {}) => slots(over).map(s => new Date(s.start)
  .toLocaleString('sv-SE', { timeZone: over.timeZone ?? LA }).slice(5, 16))

describe('findSlots: working hours', () => {
  it('returns slots inside working hours, earliest first, every 30 minutes by default', () => {
    const result = slots()
    expect(result).toHaveLength(15) // 09:00 … 16:00
    expect(result[0]).toEqual({ start: '2026-01-12T17:00:00.000Z', end: '2026-01-12T18:00:00.000Z' })
    expect(result.at(-1)).toEqual({ start: '2026-01-13T00:00:00.000Z', end: '2026-01-13T01:00:00.000Z' })
    expect(result.map(s => s.start)).toEqual(result.map(s => s.start).toSorted())
  })

  it('honours the step', () => {
    expect(starts({ stepMin: 120 })).toEqual(['01-12 09:00', '01-12 11:00', '01-12 13:00', '01-12 15:00'])
  })

  it('never lets a slot run past closing time', () => {
    expect(starts({ appointmentType: type({ duration_min: 90 }), stepMin: 60 }).at(-1)).toBe('01-12 15:00')
  })

  it('skips days without hours', () => {
    const weekend = { start: '2026-01-17T00:00:00-08:00', end: '2026-01-19T00:00:00-08:00' }
    expect(slots({ window: weekend })).toEqual([])
  })

  it('supports several periods per day (lunch break) in any order', () => {
    const hours = [{ weekday: 1, start_time: '13:00', end_time: '15:00' }, { weekday: 1, start_time: '09:00', end_time: '11:00' }]
    expect(starts({ hours, stepMin: 60 })).toEqual(['01-12 09:00', '01-12 10:00', '01-12 13:00', '01-12 14:00'])
  })

  it('returns a slot once when periods overlap', () => {
    const hours = [{ weekday: 1, start_time: '09:00', end_time: '11:00' }, { weekday: 1, start_time: '10:00', end_time: '12:00' }]
    expect(starts({ hours, stepMin: 60 })).toEqual(['01-12 09:00', '01-12 10:00', '01-12 11:00'])
  })

  it('reads hours in the workspace time zone', () => {
    const result = slots({ timeZone: 'America/New_York', window: { start: '2026-01-12T00:00:00-05:00', end: '2026-01-13T00:00:00-05:00' } })
    expect(result[0]!.start).toBe('2026-01-12T14:00:00.000Z')
  })
})

describe('findSlots: exceptions', () => {
  it('closes a day', () => {
    expect(slots({ exceptions: [{ date: '2026-01-12', start_time: null, end_time: null }] })).toEqual([])
  })

  it('replaces the hours of a day', () => {
    const exceptions = [{ date: '2026-01-12', start_time: '12:00', end_time: '14:00' }]
    expect(starts({ exceptions, stepMin: 60 })).toEqual(['01-12 12:00', '01-12 13:00'])
  })

  it('opens a day that is normally closed', () => {
    const exceptions = [{ date: '2026-01-17', start_time: '10:00', end_time: '12:00' }]
    const window = { start: '2026-01-17T00:00:00-08:00', end: '2026-01-18T00:00:00-08:00' }
    expect(starts({ exceptions, window, stepMin: 60 })).toEqual(['01-17 10:00', '01-17 11:00'])
  })

  it('leaves other days alone', () => {
    const window = { start: '2026-01-12T00:00:00-08:00', end: '2026-01-14T00:00:00-08:00' }
    const result = starts({ exceptions: [{ date: '2026-01-12', start_time: null, end_time: null }], window, stepMin: 240 })
    expect(result).toEqual(['01-13 09:00', '01-13 13:00'])
  })
})

describe('findSlots: busy intervals and buffers', () => {
  const booking = { start: '2026-01-12T11:00:00-08:00', end: '2026-01-12T12:00:00-08:00' }

  it('removes slots that overlap a busy interval, keeps the ones that touch it', () => {
    expect(starts({ busy: [booking], stepMin: 60 })).toEqual(['01-12 09:00', '01-12 10:00', '01-12 12:00', '01-12 13:00', '01-12 14:00', '01-12 15:00', '01-12 16:00'])
  })

  it('keeps the buffer free before and after a busy interval', () => {
    const result = starts({ busy: [booking], appointmentType: type({ buffer_min: 30 }) })
    // blocked 10:30–12:30: the last slot before ends at 10:30, the first after starts at 12:30
    expect(result.slice(0, 5)).toEqual(['01-12 09:00', '01-12 09:30', '01-12 12:30', '01-12 13:00', '01-12 13:30'])
  })

  it('drops a slot that only crosses the buffer, not the booking itself', () => {
    const result = starts({ busy: [booking], appointmentType: type({ buffer_min: 15 }), stepMin: 60 })
    expect(result).not.toContain('01-12 10:00') // would end 11:00, inside the 10:45 buffer
    expect(result).not.toContain('01-12 12:00') // starts inside the buffer that ends 12:15
    expect(result).toEqual(['01-12 09:00', '01-12 13:00', '01-12 14:00', '01-12 15:00', '01-12 16:00'])
  })

  it('handles overlapping and unsorted busy intervals', () => {
    const busy = [
      { start: '2026-01-12T13:00:00-08:00', end: '2026-01-12T17:00:00-08:00' },
      { start: '2026-01-12T09:00:00-08:00', end: '2026-01-12T11:30:00-08:00' },
      { start: '2026-01-12T10:00:00-08:00', end: '2026-01-12T12:00:00-08:00' },
    ]
    expect(starts({ busy })).toEqual(['01-12 12:00'])
  })

  it('returns nothing when the day is fully booked', () => {
    expect(slots({ busy: [{ start: '2026-01-12T08:00:00-08:00', end: '2026-01-12T18:00:00-08:00' }] })).toEqual([])
  })

  it('accepts busy instants in any offset', () => {
    expect(starts({ busy: [{ start: '2026-01-12T19:00:00Z', end: '2026-01-12T20:00:00Z' }], stepMin: 60 })).not.toContain('01-12 11:00')
  })
})

describe('findSlots: minimum notice, booking horizon, window', () => {
  it('applies minimum notice from now', () => {
    const result = starts({ now: '2026-01-12T09:10:00-08:00', appointmentType: type({ min_notice_hours: 2 }) })
    expect(result[0]).toBe('01-12 11:30')
  })

  it('never offers a slot in the past', () => {
    expect(starts({ now: '2026-01-12T13:01:00-08:00' })[0]).toBe('01-12 13:30')
  })

  it('carries notice over to the next day', () => {
    const window = { start: '2026-01-12T00:00:00-08:00', end: '2026-01-14T00:00:00-08:00' }
    const result = starts({ window, now: '2026-01-12T15:00:00-08:00', appointmentType: type({ min_notice_hours: 24 }) })
    expect(result[0]).toBe('01-13 15:00')
  })

  it('stops at the end of the last bookable local day', () => {
    const window = { start: '2026-01-12T00:00:00-08:00', end: '2026-02-12T00:00:00-08:00' }
    const result = starts({ window, appointmentType: type({ max_days_ahead: 2 }), stepMin: 240 })
    expect(result).toEqual(['01-12 09:00', '01-12 13:00', '01-13 09:00', '01-13 13:00', '01-14 09:00', '01-14 13:00'])
  })

  it('offers only today with max_days_ahead 0', () => {
    const window = { start: '2026-01-12T00:00:00-08:00', end: '2026-02-12T00:00:00-08:00' }
    expect(starts({ window, appointmentType: type({ max_days_ahead: 0 }), stepMin: 240 })).toEqual(['01-12 09:00', '01-12 13:00'])
  })

  it('keeps slots completely inside the search window', () => {
    const window = { start: '2026-01-12T10:15:00-08:00', end: '2026-01-12T12:45:00-08:00' }
    expect(starts({ window })).toEqual(['01-12 10:30', '01-12 11:00', '01-12 11:30'])
  })

  it('returns nothing for a window in the past, beyond the horizon or empty', () => {
    expect(slots({ window: { start: '2026-01-05T00:00:00-08:00', end: '2026-01-06T00:00:00-08:00' } })).toEqual([])
    expect(slots({ window: { start: '2026-03-02T00:00:00-08:00', end: '2026-03-03T00:00:00-08:00' } })).toEqual([])
    expect(slots({ window: { start: '2026-01-12T12:00:00-08:00', end: '2026-01-12T12:00:00-08:00' } })).toEqual([])
  })

  it('returns nothing without working hours or when the appointment is longer than the day', () => {
    expect(slots({ hours: [] })).toEqual([])
    expect(slots({ appointmentType: type({ duration_min: 600 }) })).toEqual([])
  })

  it('returns the earliest slots up to the limit', () => {
    const window = { start: '2026-01-12T00:00:00-08:00', end: '2026-01-20T00:00:00-08:00' }
    expect(starts({ window, limit: 3 })).toEqual(['01-12 09:00', '01-12 09:30', '01-12 10:00'])
    expect(starts({ window, limit: 17, stepMin: 30 }).slice(-2)).toEqual(['01-13 09:00', '01-13 09:30'])
  })

  it('applies the limit after sorting periods that are stored out of order', () => {
    const hours = [{ weekday: 1, start_time: '13:00', end_time: '15:00' }, { weekday: 1, start_time: '09:00', end_time: '11:00' }]
    expect(starts({ hours, stepMin: 60, limit: 2 })).toEqual(['01-12 09:00', '01-12 10:00'])
  })
})

describe('findSlots: invalid input is rejected, not guessed', () => {
  const hours = (start_time: string, end_time: string, weekday = 1) => ({ hours: [{ weekday, start_time, end_time }] })

  it.each([
    ['zero duration', { appointmentType: type({ duration_min: 0 }) }],
    ['negative buffer', { appointmentType: type({ buffer_min: -30 }) }],
    ['negative notice', { appointmentType: type({ min_notice_hours: -1 }) }],
    ['negative horizon', { appointmentType: type({ max_days_ahead: -1 }) }],
    ['zero step', { stepMin: 0 }],
    ['zero limit', { limit: 0 }],
    ['unreadable now', { now: 'yesterday' }],
    ['unknown time zone', { timeZone: 'Mars/Olympus' }],
    ['hours ending at 00:00', hours('18:00', '00:00')],
    ['hours crossing midnight', hours('22:00', '02:00')],
    ['hours of zero length', hours('09:00', '09:00')],
    ['malformed time', hours('9am', '17:00')],
    ['hour 25', hours('09:00', '25:00')],
    ['weekday 7', hours('09:00', '17:00', 7)],
    ['exception crossing midnight', { exceptions: [{ date: '2026-01-12', start_time: '22:00', end_time: '02:00' }] }],
    ['exception with one time', { exceptions: [{ date: '2026-01-12', start_time: '09:00', end_time: null }] }],
  ] satisfies [string, Partial<FindSlotsInput>][])('%s', (_name, over) => {
    expect(() => slots(over)).toThrow(RangeError)
  })

  it('rejects bad hours even when the search window never reaches that weekday', () => {
    expect(() => slots(hours('22:00', '02:00', 6))).toThrow(/cannot cross midnight/)
  })

  it('accepts 24:00 as closing time and seconds in times', () => {
    expect(starts({ ...hours('22:00', '24:00'), stepMin: 60 })).toEqual(['01-12 22:00', '01-12 23:00'])
    expect(starts({ ...hours('09:00:00', '11:00:00'), stepMin: 60 })).toEqual(['01-12 09:00', '01-12 10:00'])
  })

  it('compares wall-clock times, so hours inside the skipped DST hour are still valid', () => {
    const input = { ...hours('02:00', '03:00', 0), now: '2026-03-07T12:00:00-08:00', window: { start: '2026-03-08T00:00:00-08:00', end: '2026-03-09T00:00:00-07:00' } }
    expect(slots(input)).toEqual([]) // the hour does not exist that day
  })
})

describe('findSlots: daylight saving in America/Los_Angeles', () => {
  const dst = (over: Partial<FindSlotsInput>) => ({ hours: everyDay('09:00', '11:00'), stepMin: 60, ...over })

  it('spring forward (Sunday 8 March 2026): 09:00 is one UTC hour earlier than the day before', () => {
    const result = slots(dst({ now: '2026-03-06T12:00:00-08:00', window: { start: '2026-03-07T00:00:00-08:00', end: '2026-03-09T00:00:00-07:00' } }))
    expect(result.map(s => s.start)).toEqual([
      '2026-03-07T17:00:00.000Z', '2026-03-07T18:00:00.000Z', // PST
      '2026-03-08T16:00:00.000Z', '2026-03-08T17:00:00.000Z', // PDT
    ])
  })

  it('fall back (Sunday 1 November 2026): 09:00 is one UTC hour later than the day before', () => {
    const result = slots(dst({ now: '2026-10-30T12:00:00-07:00', window: { start: '2026-10-31T00:00:00-07:00', end: '2026-11-02T00:00:00-08:00' } }))
    expect(result.map(s => s.start)).toEqual([
      '2026-10-31T16:00:00.000Z', '2026-10-31T17:00:00.000Z', // PDT
      '2026-11-01T17:00:00.000Z', '2026-11-01T18:00:00.000Z', // PST
    ])
  })

  it('hours across the skipped hour are one hour shorter', () => {
    const result = slots(dst({ hours: everyDay('00:00', '06:00'), now: '2026-03-07T12:00:00-08:00', window: { start: '2026-03-08T00:00:00-08:00', end: '2026-03-09T00:00:00-07:00' } }))
    expect(result).toHaveLength(5)
    expect(result.map(s => s.start.slice(11, 16))).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00']) // wall clock 00, 01, 03, 04, 05
    expect(result.every(s => Date.parse(s.end) - Date.parse(s.start) === 3_600_000)).toBe(true)
  })

  it('hours across the repeated hour are one hour longer', () => {
    const result = slots(dst({ hours: everyDay('00:00', '06:00'), now: '2026-10-31T12:00:00-07:00', window: { start: '2026-11-01T00:00:00-07:00', end: '2026-11-02T00:00:00-08:00' } }))
    expect(result).toHaveLength(7)
    expect(result[0]!.start).toBe('2026-11-01T07:00:00.000Z')
    expect(result.at(-1)!.end).toBe('2026-11-01T14:00:00.000Z')
  })

  it('a booking on the DST day blocks the right slot', () => {
    const busy = [{ start: '2026-03-08T09:00:00-07:00', end: '2026-03-08T10:00:00-07:00' }]
    const result = slots(dst({ busy, now: '2026-03-07T12:00:00-08:00', window: { start: '2026-03-08T00:00:00-08:00', end: '2026-03-09T00:00:00-07:00' } }))
    expect(result.map(s => s.start)).toEqual(['2026-03-08T17:00:00.000Z'])
  })

  it('minimum notice counts elapsed hours across the change', () => {
    // 24 h after Saturday 09:30 PST is Sunday 10:30 PDT
    const result = slots(dst({
      hours: everyDay('09:00', '13:00'), appointmentType: type({ min_notice_hours: 24 }), stepMin: 30,
      now: '2026-03-07T09:30:00-08:00', window: { start: '2026-03-07T00:00:00-08:00', end: '2026-03-09T00:00:00-07:00' },
    }))
    expect(result[0]!.start).toBe('2026-03-08T17:30:00.000Z')
  })

  it('the booking horizon counts local days across the change', () => {
    const result = slots(dst({
      appointmentType: type({ max_days_ahead: 1 }),
      now: '2026-03-07T23:30:00-08:00', window: { start: '2026-03-07T00:00:00-08:00', end: '2026-03-20T00:00:00-07:00' },
    }))
    expect(result.map(s => s.start)).toEqual(['2026-03-08T16:00:00.000Z', '2026-03-08T17:00:00.000Z'])
  })
})
