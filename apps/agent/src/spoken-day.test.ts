import { expect, test } from 'vitest'
import { resolveDay } from './spoken-day.ts'

// Thursday, November 12, 2026.
const today = '2026-11-12'

test('today, tomorrow and dates come out as the date', () => {
  expect(resolveDay('today', today)).toEqual({ date: '2026-11-12' })
  expect(resolveDay('Tomorrow', today)).toEqual({ date: '2026-11-13' })
  expect(resolveDay('the day after tomorrow', today)).toEqual({ date: '2026-11-14' })
  expect(resolveDay('2026-11-17', today)).toEqual({ date: '2026-11-17' })
  expect(resolveDay('November 17', today)).toEqual({ date: '2026-11-17' })
  expect(resolveDay('11/17', today)).toEqual({ date: '2026-11-17' })
})

test('a weekday is the coming one; "this" on the same day is today', () => {
  expect(resolveDay('Wednesday', today)).toEqual({ date: '2026-11-18' })
  expect(resolveDay('on Friday', today)).toEqual({ date: '2026-11-13' })
  expect(resolveDay('Thursday', today)).toEqual({ date: '2026-11-19' })
  expect(resolveDay('this Thursday', today)).toEqual({ date: '2026-11-12' })
  expect(resolveDay('this coming Monday', today)).toEqual({ date: '2026-11-16' })
})

test('"next Wednesday" can mean two days: the caller is asked, with both dates', () => {
  const day = resolveDay('next Wednesday', today)
  expect(day).toEqual({ ask: expect.stringContaining('Wednesday, November 18 or Wednesday, November 25') })
})

test('a day of the month is the coming one; a week is its Monday, or its Sunday as the end', () => {
  expect(resolveDay('the 17th', today)).toEqual({ date: '2026-11-17' })
  expect(resolveDay('3rd', today)).toEqual({ date: '2026-12-03' })
  expect(resolveDay('the 31st', today)).toEqual({ date: '2026-12-31' })
  expect(resolveDay('next week', today)).toEqual({ date: '2026-11-16' })
  expect(resolveDay('next week', today, { end: true })).toEqual({ date: '2026-11-22' })
  expect(resolveDay('this week', today)).toEqual({ date: '2026-11-12' })
  expect(resolveDay('this week', today, { end: true })).toEqual({ date: '2026-11-15' })
})

test('words that name no day are not guessed', () => {
  expect(resolveDay('sometime soon', today)).toEqual({ unknown: expect.stringContaining('Ask the caller for the date') })
})

// Seen in a live test (LIN-160): the model passed "Monday, November 16th" and got "could not tell which day".
test('a weekday in front of the date and a time after it are understood; a weekday that does not fit is asked back', () => {
  expect(resolveDay('Monday, November 16th', today)).toEqual({ date: '2026-11-16' })
  expect(resolveDay('Monday the 16th', today)).toEqual({ date: '2026-11-16' })
  expect(resolveDay('November 16 at 7 AM', today)).toEqual({ date: '2026-11-16' })
  expect(resolveDay('Monday, November 16 at 7:30 am', today)).toEqual({ date: '2026-11-16' })
  expect(resolveDay('tomorrow 9am', today)).toEqual({ date: '2026-11-13' })
  expect(resolveDay('Tuesday, November 16', today)).toEqual({ ask: expect.stringContaining('Monday, November 16 is not a Tuesday') })
})
