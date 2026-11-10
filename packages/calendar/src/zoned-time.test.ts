import { describe, expect, it } from 'vitest'
import { addDays, localDate, weekdayOf, zonedTimeToInstant } from './zoned-time.ts'

const LA = 'America/Los_Angeles'
const iso = (instant: number) => new Date(instant).toISOString()
const at = (date: string, time: string, timeZone = LA) => iso(zonedTimeToInstant(date, time, timeZone))

describe('zonedTimeToInstant', () => {
  it('uses the standard offset in winter and the daylight offset in summer', () => {
    expect(at('2026-01-15', '09:00')).toBe('2026-01-15T17:00:00.000Z')
    expect(at('2026-07-15', '09:00')).toBe('2026-07-15T16:00:00.000Z')
  })

  it('switches offset on the spring-forward day (8 March 2026, 02:00 → 03:00)', () => {
    expect(at('2026-03-08', '01:59')).toBe('2026-03-08T09:59:00.000Z')
    expect(at('2026-03-08', '03:00')).toBe('2026-03-08T10:00:00.000Z')
    expect(at('2026-03-08', '09:00')).toBe('2026-03-08T16:00:00.000Z')
  })

  it('moves a skipped time forward by the skipped hour', () => {
    expect(at('2026-03-08', '02:30')).toBe('2026-03-08T10:30:00.000Z') // 03:30 PDT
  })

  it('switches offset on the fall-back day (1 November 2026, 02:00 → 01:00)', () => {
    expect(at('2026-11-01', '00:30')).toBe('2026-11-01T07:30:00.000Z')
    expect(at('2026-11-01', '02:00')).toBe('2026-11-01T10:00:00.000Z')
    expect(at('2026-11-01', '09:00')).toBe('2026-11-01T17:00:00.000Z')
  })

  it('resolves a time that occurs twice to its first occurrence', () => {
    expect(at('2026-11-01', '01:30')).toBe('2026-11-01T08:30:00.000Z') // 01:30 PDT
  })

  it('accepts HH:MM:SS and 24:00 as end of day', () => {
    expect(at('2026-01-15', '09:00:00')).toBe('2026-01-15T17:00:00.000Z')
    expect(at('2026-01-15', '24:00')).toBe(at('2026-01-16', '00:00'))
  })

  it('handles other zones, including half-hour offsets and no DST', () => {
    expect(at('2026-07-15', '09:00', 'America/New_York')).toBe('2026-07-15T13:00:00.000Z')
    expect(at('2026-07-15', '09:00', 'America/Phoenix')).toBe('2026-07-15T16:00:00.000Z')
    expect(at('2026-07-15', '09:00', 'Asia/Kolkata')).toBe('2026-07-15T03:30:00.000Z')
    expect(at('2026-07-15', '09:00', 'UTC')).toBe('2026-07-15T09:00:00.000Z')
  })

  it('rejects malformed input and unknown zones', () => {
    expect(() => zonedTimeToInstant('2026-01-15', 'nine', LA)).toThrow(RangeError)
    expect(() => zonedTimeToInstant('2026-01-15', '09:00', 'Mars/Olympus')).toThrow(RangeError)
  })
})

describe('date helpers', () => {
  it('localDate follows the zone, not UTC', () => {
    expect(localDate(Date.parse('2026-01-15T07:59:00Z'), LA)).toBe('2026-01-14')
    expect(localDate(Date.parse('2026-01-15T08:00:00Z'), LA)).toBe('2026-01-15')
  })

  it('addDays crosses months, years and DST days by calendar date', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09')
  })

  it('weekdayOf counts from Sunday = 0', () => {
    expect(weekdayOf('2026-03-08')).toBe(0)
    expect(weekdayOf('2026-01-12')).toBe(1)
  })

})
