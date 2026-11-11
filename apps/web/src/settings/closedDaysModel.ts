// Holidays, closure days and vacation mode without React: dates in the workspace's time zone,
// the US holidays most small businesses close on, and the labels the page shows.
import type { ClosedDay } from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { timeOptionLabel } from './businessHoursModel.ts'

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

/** The `n`th `weekday` (0 = Sunday) of a month; n = -1 is the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)
  }
  const lastDay = new Date(Date.UTC(year, month, 0))
  const back = (lastDay.getUTCDay() - weekday + 7) % 7
  return iso(year, month, lastDay.getUTCDate() - back)
}

/** The US holidays most small businesses close on, in one year. */
function usHolidaysIn(year: number): ClosedDay[] {
  const closed = (date: string, name: string): ClosedDay => ({ date, name, start: null, end: null })
  return [
    closed(iso(year, 1, 1), "New Year's Day"),
    closed(nthWeekday(year, 5, 1, -1), 'Memorial Day'),
    closed(iso(year, 7, 4), 'Independence Day'),
    closed(nthWeekday(year, 9, 1, 1), 'Labor Day'),
    closed(nthWeekday(year, 11, 4, 4), 'Thanksgiving'),
    closed(iso(year, 12, 25), 'Christmas Day'),
  ]
}

/** Those holidays in the coming twelve months from `today`. */
export function usHolidaysAhead(today: string): ClosedDay[] {
  const year = Number(today.slice(0, 4))
  const last = addDays(today, 365)
  return [...usHolidaysIn(year), ...usHolidaysIn(year + 1)].filter(d => d.date >= today && d.date <= last)
}

/** The list with `added` merged in: a date already there keeps its entry. Sorted by date. */
export function withDays(days: readonly ClosedDay[], added: readonly ClosedDay[]): ClosedDay[] {
  const dates = new Set(days.map(d => d.date))
  return [...days, ...added.filter(d => !dates.has(d.date))].sort((a, b) => a.date.localeCompare(b.date))
}

/** "Thu, Nov 26" (with the year when it is not this year's). */
export function shortDate(date: string, today: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }
  if (date.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric'
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', options)
}

/** "Closed" or "Open 8:00 AM–12:00 PM". */
export const dayHoursLabel = (d: ClosedDay) =>
  d.start && d.end ? `Open ${timeOptionLabel(d.start)}–${timeOptionLabel(d.end)}` : 'Closed'

export type ClosureState = 'on' | 'scheduled' | 'ended'

export function closureState(c: Closure, today: string): ClosureState {
  if (today > c.until) return 'ended'
  return today < c.from ? 'scheduled' : 'on'
}

/** Where a closure stands, in one line: "Closed now, back on Mon, Jan 5." */
export function closureSummary(c: Closure, today: string): string {
  const back = shortDate(addDays(c.until, 1), today)
  const range = `${shortDate(c.from, today)} – ${shortDate(c.until, today)}`
  const state = closureState(c, today)
  if (state === 'on') return `Closed now, back on ${back}.`
  if (state === 'scheduled') return `Closed ${range}, back on ${back}.`
  return `Ended ${shortDate(c.until, today)}.`
}

/** "Monday, January 5". */
const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

/** What the assistant says while closed, until the owner writes their own. */
export const defaultClosureGreeting = (until: string) =>
  `Thanks for calling. We're closed for a break and back on ${longDate(addDays(until, 1))}. Leave a message and we'll call you back then.`

/** Why the closure cannot be saved; null when it can. */
export function closureProblem(c: Closure): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.from) || !/^\d{4}-\d{2}-\d{2}$/.test(c.until)) return 'Pick the first and the last day.'
  if (c.until < c.from) return 'The last day cannot be before the first.'
  return null
}
