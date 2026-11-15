// Business hours as the voice agent needs them on a call: open right now or not, when the office
// opens next, and one plain sentence it can work from ("Closed now; opens tomorrow at 7:00 AM").
// Hours are the workspace's weekly working hours (availability_rules) in its time zone.
import type { WorkingHours } from './slots.ts'
import { addDays, localDate, weekdayOf, zonedTimeToInstant } from './zoned-time.ts'

export type BusinessHoursContext = {
  timeZone: string
  /** Weekly hours, wall-clock `HH:MM` in `timeZone`; 0 = Sunday. */
  weekly: { weekday: number; start: string; end: string }[]
  openNow: boolean
  /** When the office opens next (ISO instant), or when it closes if it is open; null without hours. */
  nextChangeAt: string | null
  /** For the assistant: the hours and where "now" falls, in one or two sentences. */
  summary: string
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hhmm = (time: string) => time.slice(0, 5)

/** 07:00 → 7:00 AM, 24:00 → midnight. */
export function timeLabel(time: string): string {
  const [h = 0, m = 0] = hhmm(time).split(':').map(Number)
  if (h === 24 || (h === 0 && m === 0)) return 'midnight'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "Monday to Friday 7:00 AM–6:00 PM; Saturday 8:00 AM–noon" style, days with the same hours grouped. */
export function weeklyLabel(weekly: BusinessHoursContext['weekly']): string {
  const byDay = new Map<number, string>()
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const spans = weekly.filter(w => w.weekday === day).sort((a, b) => a.start.localeCompare(b.start))
    if (spans.length) byDay.set(day, spans.map(s => `${timeLabel(s.start)}–${timeLabel(s.end)}`).join(' and '))
  }
  const groups: { first: number; last: number; text: string }[] = []
  for (const [day, text] of byDay) {
    const prev = groups.at(-1)
    const next = (d: number) => (d + 1) % 7
    if (prev && prev.text === text && next(prev.last) === day) prev.last = day
    else groups.push({ first: day, last: day, text })
  }
  return groups
    .map(g => `${g.first === g.last ? DAY_NAMES[g.first] : `${DAY_NAMES[g.first]} to ${DAY_NAMES[g.last]}`} ${g.text}`)
    .join('; ')
}

/** "today at 7:00 AM", "tomorrow at 7:00 AM", "Monday at 7:00 AM". */
function whenLabel(date: string, today: string, time: string): string {
  const day = date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : DAY_NAMES[weekdayOf(date)]
  return `${day} at ${timeLabel(time)}`
}

/** A holiday or closure day: closed all day (no times) or open only start–end. */
export type DayException = { date: string; start_time: string | null; end_time: string | null; name?: string }

/** "Thursday, November 26". */
export function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** How far ahead the next opening is looked for (a closure can be weeks long). */
const LOOKAHEAD_DAYS = 45
/** Holidays this many days ahead are mentioned, so the assistant can answer "are you open on…". */
const UPCOMING_DAYS = 14

/** The open spans of one date: its exceptions if it has any, else the weekly hours. */
function daySpans(date: string, weekly: BusinessHoursContext['weekly'], exceptions: readonly DayException[]) {
  const own = exceptions.filter(e => e.date === date)
  if (!own.length) return weekly.filter(w => w.weekday === weekdayOf(date))
  return own.flatMap(e => (e.start_time && e.end_time ? [{ weekday: weekdayOf(date), start: hhmm(e.start_time), end: hhmm(e.end_time) }] : []))
}

/** "Thanksgiving, Thursday, November 26: closed." for the holidays of the next two weeks; null when there are none. */
function upcomingLabel(exceptions: readonly DayException[], today: string): string | null {
  const last = addDays(today, UPCOMING_DAYS)
  const days = exceptions.filter(e => e.date >= today && e.date <= last).sort((a, b) => a.date.localeCompare(b.date))
  if (!days.length) return null
  const line = (e: DayException) => {
    const when = e.date === today ? 'Today' : dateLabel(e.date)
    const what = e.start_time && e.end_time ? `open only ${timeLabel(e.start_time)}–${timeLabel(e.end_time)}` : 'closed'
    return `${when}${e.name?.trim() ? ` (${e.name.trim()})` : ''}: ${what}.`
  }
  return `Holidays and special hours: ${days.map(line).join(' ')}`
}

/**
 * Null when the workspace has no hours: the assistant then says nothing about opening times.
 * `exceptions`: holidays and closure days, which replace the weekly hours on their date.
 */
export function businessHoursContext(
  rules: readonly WorkingHours[],
  timeZone: string,
  nowMs: number,
  exceptions: readonly DayException[] = [],
): BusinessHoursContext | null {
  if (!rules.length) return null
  const weekly = rules.map(r => ({ weekday: r.weekday, start: hhmm(r.start_time), end: hhmm(r.end_time) }))
  const today = localDate(nowMs, timeZone)
  // Every span of the coming weeks as instants, in order.
  const spans = Array.from({ length: LOOKAHEAD_DAYS }, (_, i) => addDays(today, i))
    .flatMap(date =>
      daySpans(date, weekly, exceptions).map(w => ({
        date,
        ...w,
        from: zonedTimeToInstant(date, w.start, timeZone),
        to: zonedTimeToInstant(date, w.end, timeZone),
      })),
    )
    .sort((a, b) => a.from - b.from)
  const current = spans.find(s => s.from <= nowMs && nowMs < s.to)
  const next = spans.find(s => s.from > nowMs)
  const hours = [`Business hours: ${weeklyLabel(weekly)}.`, upcomingLabel(exceptions, today)].filter(Boolean).join(' ')
  if (current) {
    return {
      timeZone,
      weekly,
      openNow: true,
      nextChangeAt: new Date(current.to).toISOString(),
      summary: `${hours} Open now, until ${timeLabel(current.end)}.`,
    }
  }
  const opens = next ? (next.date <= addDays(today, 6) ? whenLabel(next.date, today, next.start) : `on ${dateLabel(next.date)} at ${timeLabel(next.start)}`) : null
  return {
    timeZone,
    weekly,
    openNow: false,
    nextChangeAt: next ? new Date(next.from).toISOString() : null,
    summary: `${hours} Closed now${opens ? `; opens ${opens}` : ''}.`,
  }
}
