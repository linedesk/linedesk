import { describe, expect, it } from 'vitest'
import { parseWhen } from './parseWhen.ts'

// Tuesday, 10 November 2026, 10:30 local time.
const now = new Date(2026, 10, 10, 10, 30)
const at = (text: string) => {
  const d = parseWhen(text, now)
  return d && `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('typed reminder times', () => {
  it('reads days, with the morning as the default time', () => {
    expect(at('tomorrow')).toBe('11/11 8:00')
    expect(at('tomorrow 9am')).toBe('11/11 9:00')
    expect(at('Tomorrow at 2:30 pm')).toBe('11/11 14:30')
    expect(at('fri 2pm')).toBe('11/13 14:00')
    expect(at('tuesday')).toBe('11/17 8:00') // today is Tuesday: next week's
    expect(at('next mon')).toBe('11/16 8:00')
    expect(at('nov 20')).toBe('11/20 8:00')
    expect(at('20 nov 4pm')).toBe('11/20 16:00')
    expect(at('12/1')).toBe('12/1 8:00')
    expect(at('jan 5')).toBe('1/5 8:00') // next year
  })
  it('reads times alone as their next occurrence, and a bare small hour as the afternoon', () => {
    expect(at('3')).toBe('11/10 15:00')
    expect(at('9am')).toBe('11/11 9:00') // already past today
    expect(at('14:15')).toBe('11/10 14:15')
    expect(at('this afternoon')).toBe('11/10 14:00')
    expect(at('tomorrow evening')).toBe('11/11 18:00')
  })
  it('reads relative times', () => {
    expect(at('in 3 hours')).toBe('11/10 13:30')
    expect(at('in 20 min')).toBe('11/10 10:50')
    expect(at('in 2 days')).toBe('11/12 8:00')
    expect(at('in a week')).toBe('11/17 8:00')
    expect(at('in a month')).toBe('12/10 8:00')
  })
  it('gives nothing for text it does not fully understand or for the past', () => {
    for (const text of [
      '',
      'later',
      'tomorrow lunch-ish',
      '25:00',
      '13pm',
      'feb 30',
      'today 7am',
      'in 3 hours tomorrow',
    ]) {
      expect(at(text)).toBeNull()
    }
  })
})
