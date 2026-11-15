import { afterAll, describe, expect, it, test } from 'vitest'
import { activate } from './i18n/index.tsx'
import {
  clock,
  dateTimeLabel,
  dayFieldLabel,
  formatDate,
  listDuration,
  listTime,
  longDuration,
  parseTs,
  shortDuration,
  untilLabel,
  whenLabel,
} from './time.ts'

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
    expect(longDuration(152)).toBe('2 min, 32 sec')
    expect(longDuration(120)).toBe('2 min')
    expect(longDuration(9)).toBe('9 sec')
    expect(shortDuration(96)).toBe('1m 36s')
    expect(shortDuration(60)).toBe('1m')
    expect(clock(65)).toBe('01:05')
    expect(listDuration(181)).toBe('03:01')
    expect(listDuration(48)).toBe('00:48')
    expect(listDuration(3781)).toBe('1:03:01')
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

test("a date field shows its day in the app's language, not the browser's (LIN-202)", () => {
  expect(dayFieldLabel('2026-11-14')).toBe('Nov 14, 2026')
  expect(dayFieldLabel('2027-01-01')).toBe('Jan 1, 2027')
  expect(dayFieldLabel('not a day')).toBe('not a day')
})

describe('formatDate', () => {
  it('formats in English as toLocaleString does', () => {
    const date = new Date(2026, 10, 12, 21, 5)
    for (const options of [
      { hour: 'numeric', minute: '2-digit' },
      { month: 'short', day: 'numeric' },
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    ] as const)
      expect(formatDate(date, options)).toBe(date.toLocaleString('en-US', options))
  })
})

test('a setup link says until when it is valid, with the clock time (LIN-161)', () => {
  const now = new Date(2026, 10, 14, 1, 0) // Saturday
  expect(untilLabel(new Date(2026, 10, 14, 18, 30), now)).toBe('today 6:30 PM')
  expect(untilLabel(new Date(2026, 10, 15, 1, 0), now)).toBe('tomorrow 1:00 AM')
  expect(untilLabel(new Date(2026, 10, 16, 1, 0), now)).toBe('Mon 1:00 AM')
})

describe('in another language', () => {
  const now = new Date(2026, 10, 10, 15, 0)
  afterAll(() => activate('en', { remember: false }))

  it('uses that language for the words, the dates and the clock', async () => {
    await activate('es', { remember: false })
    expect(dayFieldLabel('2026-11-14')).toBe(
      new Date(2026, 10, 14).toLocaleDateString('es', { month: 'short', day: 'numeric', year: 'numeric' }),
    )
    expect(dateTimeLabel(new Date(2026, 10, 3, 9, 0), now)).toContain(
      formatDate(new Date(2026, 10, 3), { month: 'short', day: 'numeric' }),
    )
    await activate('ja', { remember: false })
    expect(listTime(new Date(2026, 10, 10, 10, 23), now)).toBe('10:23')
  })
})
