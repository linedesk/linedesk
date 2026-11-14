// Holidays, closure days and vacation mode without React: dates in the workspace's time zone
// and the labels the page shows.
import type { ClosedDay, DerivedDay } from '@linedesk/actions'
import type { Closure, HolidayCalendar, HolidayChange } from '@linedesk/db/types'
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
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** What the assistant says while closed, until the owner writes their own. */
export const defaultClosureGreeting = (until: string) =>
  `Thanks for calling. We're closed for a break and back on ${longDate(addDays(until, 1))}. Leave a message and we'll call you back then.`

/** Why the closure cannot be saved; null when it can. */
export function closureProblem(c: Closure): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.from) || !/^\d{4}-\d{2}-\d{2}$/.test(c.until))
    return 'Pick the first and the last day.'
  if (c.until < c.from) return 'The last day cannot be before the first.'
  return null
}

/**
 * One line of "Next closed days": an own day, a public holiday, a later year of a yearly day, or a holiday or
 * yearly day the business opens on this year (`opened`, shown dimmed so it can be closed again).
 */
export type UpcomingDay = {
  date: string
  name: string
  start: string | null
  end: string | null
  kind: 'own' | 'holiday' | 'repeat' | 'opened'
  /** holiday: its name every year; repeat: the date of the own day it repeats. */
  key: string
  /** own: closed on this date every year. */
  yearly: boolean
  /** holiday or repeat: its hours are changed for this year. */
  changed: boolean
}

/** Own days, holidays, repeats and the days opened this year, from today, by date. */
export function upcomingDays(
  own: readonly ClosedDay[],
  derived: readonly DerivedDay[],
  calendar: HolidayCalendar | null,
  today: string,
): UpcomingDay[] {
  const changes = new Map((calendar?.changes ?? []).map(c => [c.date, c]))
  const days: UpcomingDay[] = [
    ...own
      .filter(d => d.date >= today)
      .map(d => ({ ...d, kind: 'own' as const, key: d.date, yearly: !!d.yearly, changed: false })),
    ...derived.map(d => ({
      date: d.date,
      name: d.name,
      start: d.start,
      end: d.end,
      kind: d.source,
      key: d.key,
      yearly: false,
      changed: !!changes.get(d.date) && !changes.get(d.date)!.open,
    })),
    ...(calendar?.changes ?? [])
      .filter(c => c.open && c.date >= today)
      .map(c => ({
        date: c.date,
        name: c.name,
        start: null,
        end: null,
        kind: 'opened' as const,
        key: c.date,
        yearly: false,
        changed: true,
      })),
  ]
  return days.sort((a, b) => a.date.localeCompare(b.date))
}

/** The calendar with one date's change replaced (`change` null: the date as the calendar has it). */
export function withChange(calendar: HolidayCalendar, date: string, change: HolidayChange | null): HolidayCalendar {
  const changes = calendar.changes.filter(c => c.date !== date)
  return { ...calendar, changes: change ? [...changes, change].sort((a, b) => a.date.localeCompare(b.date)) : changes }
}

/**
 * The derived days as they will be after `next`, as far as the browser can tell without the holiday data:
 * holidays switched off or opened are gone, changed hours are in. The server's answer replaces it.
 */
export function derivedAfter(derived: readonly DerivedDay[], next: HolidayCalendar): DerivedDay[] {
  const off = new Set(next.off)
  const changes = new Map(next.changes.map(c => [c.date, c]))
  return derived
    .filter(d => !(d.source === 'holiday' && (!next.on || off.has(d.key))) && !changes.get(d.date)?.open)
    .map(d => {
      const change = changes.get(d.date)
      return change ? { ...d, start: change.start, end: change.end } : d
    })
}

/** "United States · California · open on 2 holidays". */
export function calendarSummary(calendar: HolidayCalendar, countryName: string, stateName: string | null): string {
  const open = calendar.off.length
  return [
    countryName,
    stateName ?? 'Nationwide',
    open ? `open on ${open === 1 ? '1 holiday' : `${open} holidays`}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
