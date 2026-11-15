import { expect, test } from 'vitest'
import {
  dayRows,
  hoursChanged,
  hoursProblem,
  spansOf,
  timeOptionLabel,
  timeOptions,
  weekdayName,
  weekSummary,
} from './businessHoursModel.ts'

const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '07:00', end: '18:00' }))

test('the week as form rows and back', () => {
  const rows = dayRows(weekdays)
  expect(rows).toHaveLength(7)
  expect(rows.find(d => d.weekday === 0)).toEqual({ weekday: 0, open: false, start: '08:00', end: '17:00' })
  expect(rows.find(d => d.weekday === 1)).toEqual({ weekday: 1, open: true, start: '07:00', end: '18:00' })
  expect(spansOf(rows)).toEqual(weekdays)
})

test('changed only when the open hours differ', () => {
  const rows = dayRows(weekdays)
  expect(hoursChanged(weekdays, rows)).toBe(false)
  expect(
    hoursChanged(
      weekdays,
      rows.map(d => (d.weekday === 0 ? { ...d, start: '09:00' } : d)),
    ),
  ).toBe(false) // a closed day's times do not count
  expect(
    hoursChanged(
      weekdays,
      rows.map(d => (d.weekday === 6 ? { ...d, open: true } : d)),
    ),
  ).toBe(true)
})

test('half-hour options from midnight to midnight', () => {
  const options = timeOptions()
  expect(options).toHaveLength(49)
  expect(options[0]).toEqual({ value: '00:00', label: 'Midnight' })
  expect(options[48]).toEqual({ value: '24:00', label: 'Midnight' })
  expect(timeOptionLabel('12:00')).toBe('Noon')
  // Intl puts a narrow no-break space before AM/PM.
  expect(timeOptionLabel('07:30')).toMatch(/^7:30\sAM$/)
  expect(timeOptionLabel('18:00')).toMatch(/^6:00\sPM$/)
})

test('weekday names and the week in one line', () => {
  expect(weekdayName(0)).toBe('Sunday')
  expect(weekdayName(1, 'short')).toBe('Mon')
  const summary = weekSummary(dayRows(weekdays)).replace(/\s/g, ' ')
  expect(summary).toBe('Mon–Fri 7:00 AM–6:00 PM')
  expect(weekSummary(dayRows([]))).toBe('Closed every day')
})

test('an open day must close after it opens; closed days are not checked', () => {
  const rows = dayRows(weekdays)
  expect(hoursProblem(rows)).toBeNull()
  const backwards = rows.map(d => (d.weekday === 2 ? { ...d, start: '18:00', end: '07:00' } : d))
  expect(hoursProblem(backwards)).toBe('Each open day needs a closing time after its opening time.')
  expect(hoursProblem(backwards.map(d => (d.weekday === 2 ? { ...d, open: false } : d)))).toBeNull()
})
