import { describe, expect, it } from 'vitest'
import { clock, dateTimeLabel, formatDate, listTime, longDuration, parseTs, shortDuration, whenLabel } from './time.ts'

describe('time labels', () => {
  const now = new Date(2026, 10, 10, 15, 0)
  it('labels the call time by how long ago it was', () => {
    expect(dateTimeLabel(new Date(2026, 10, 10, 10, 23), now)).toBe('10:23 AM')
    expect(dateTimeLabel(new Date(2026, 10, 9, 16, 5), now)).toBe('Yesterday 4:05 PM')
    expect(dateTimeLabel(new Date(2026, 10, 3, 9, 0), now)).toBe('Nov 3, 9:00 AM')
  })
  it('shows a call in the inbox list with its clock time', () => {
    expect(listTime(new Date(2026, 10, 10, 10, 23), now)).toBe('10:23 AM')
    expect(listTime(new Date(2026, 10, 9, 19, 59), now)).toBe('Yesterday 7:59 PM')
    expect(listTime(new Date(2026, 10, 6, 9, 2), now)).toBe('Fri 9:02 AM')
    expect(listTime(new Date(2026, 10, 3, 9, 2), now)).toBe('Nov 3, 9:02 AM')
    expect(listTime(new Date(2025, 10, 12, 9, 2), now)).toBe('Nov 12, 2025')
  })
  it('formats durations', () => {
    expect(longDuration(152)).toBe('2 min 32 sec')
    expect(longDuration(120)).toBe('2 min')
    expect(longDuration(9)).toBe('9 sec')
    expect(shortDuration(96)).toBe('1m 36s')
    expect(shortDuration(60)).toBe('1m')
    expect(clock(65)).toBe('01:05')
  })
  it('parses Postgres and ISO timestamps to the same instant', () => {
    expect(parseTs('2026-11-10 12:00:00+00').getTime()).toBe(parseTs('2026-11-10T12:00:00.000Z').getTime())
  })
  it('says when a reminder comes back', () => {
    expect(whenLabel(new Date(2026, 10, 10, 18, 30), now)).toBe('Today 6:30 PM')
    expect(whenLabel(new Date(2026, 10, 11, 8, 0), now)).toBe('Tomorrow 8:00 AM')
    expect(whenLabel(new Date(2026, 10, 13, 8, 0), now)).toBe('Fri 8:00 AM')
    expect(whenLabel(new Date(2026, 10, 16, 8, 0), now)).toBe('Mon 8:00 AM')
    expect(whenLabel(new Date(2026, 11, 10, 8, 0), now)).toBe('Dec 10, 8:00 AM')
  })
})

describe('formatDate', () => {
  it('formats as toLocaleString does', () => {
    const date = new Date(2026, 10, 12, 21, 5)
    for (const options of [
      { hour: 'numeric', minute: '2-digit' },
      { month: 'short', day: 'numeric' },
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    ] as const)
      expect(formatDate(date, options)).toBe(date.toLocaleString('en-US', options))
  })
})
