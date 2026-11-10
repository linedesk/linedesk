import { describe, expect, it } from 'vitest'
import { clock, dateTimeLabel, longDuration, parseTs, shortDuration } from './time.ts'

describe('time labels', () => {
  const now = new Date(2026, 10, 10, 15, 0)
  it('labels the call time by how long ago it was', () => {
    expect(dateTimeLabel(new Date(2026, 10, 10, 10, 23), now)).toBe('10:23 AM')
    expect(dateTimeLabel(new Date(2026, 10, 9, 16, 5), now)).toBe('Yesterday 4:05 PM')
    expect(dateTimeLabel(new Date(2026, 10, 3, 9, 0), now)).toBe('Nov 3, 9:00 AM')
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
})
