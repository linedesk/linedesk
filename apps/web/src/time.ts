/**
 * Times and durations as the app shows them, in the active language (docs/translations.md, "Formatting"): dates and
 * clock times through Intl, the words around them ("Yesterday 4:05 PM") from the catalog.
 */
import { i18n } from './i18n/index.tsx'

/** `date` formatted with `options` in the active language; each formatter is built once (the inbox formats every row). */
export function formatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return i18n().format.dateTime(date, options)
}

/** A day ("YYYY-MM-DD") as a date field shows it: "Nov 14, 2026" in English, "14 nov 2026" in Spanish. */
export function dayFieldLabel(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return formatDate(date, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Postgres sends "2026-11-10 12:00:00+00", actions write ISO. Parse both. */
export function parseTs(value: string): Date {
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return new Date(iso)
}

export type Day = 'today' | 'yesterday' | 'earlier'

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
/** Calendar days from `from` to `to` in the browser's time zone (negative: `to` is earlier). */
const daysBetween = (from: Date, to: Date) => Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000)

export function dayLabel(date: Date, now = new Date()): Day {
  const days = daysBetween(date, now)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : 'earlier'
}

const clockTime = (date: Date) => formatDate(date, { hour: 'numeric', minute: '2-digit' })
export const monthDay = (date: Date) => formatDate(date, { month: 'short', day: 'numeric' })

export function timeLabel(date: Date, now = new Date()): string {
  const day = dayLabel(date, now)
  if (day === 'today') return clockTime(date)
  if (day === 'yesterday') return i18n().t('common.time.yesterday')
  return monthDay(date)
}

/**
 * A call's length has two formats, one per kind of place (LIN-434):
 * - `listDuration`, "02:08", in dense lists of calls (the inbox, a contact's calls on the Contacts page);
 * - `callDuration`, "2 min, 8 sec", everywhere else (the call header, the contact panel, the test call).
 */

/** "02:08" for the duration column of a list of calls: as short in every language ("2 Min., 8 Sek." would wrap there). */
export function listDuration(seconds: number): string {
  return i18n().format.duration(seconds, 'digital')
}

/** "2 min, 8 sec": a call's length outside the dense lists. */
export function callDuration(seconds: number): string {
  return i18n().format.duration(seconds, 'short')
}

/** "1m 20s" for compact setting values that are not a call's length (ring time, appointment length). */
export function shortDuration(seconds: number): string {
  return i18n().format.duration(seconds, 'narrow')
}

/** "01:20" for clocks and transcript times. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** "10:23 AM", "Yesterday 10:23 AM" or "Nov 8, 10:23 AM" for the call header. */
export function dateTimeLabel(date: Date, now = new Date()): string {
  const { t } = i18n()
  const time = clockTime(date)
  const day = dayLabel(date, now)
  if (day === 'today') return time
  if (day === 'yesterday') return t('common.time.yesterdayAt', { time })
  return t('common.time.dateAt', { date: monthDay(date), time })
}

/**
 * A call's time in the inbox list, always with the clock time so you can tell when someone called:
 * "2:58 PM", "Yesterday 7:59 PM", "Mon 9:02 AM" (the last week), "Nov 12, 9:02 AM", "Nov 12, 2025" (another year).
 */
export function listTime(date: Date, now = new Date()): string {
  const { t } = i18n()
  const time = clockTime(date)
  const days = daysBetween(date, now)
  if (days <= 0) return time
  if (days === 1) return t('common.time.yesterdayAt', { time })
  if (days < 7) return t('common.time.weekdayAt', { weekday: formatDate(date, { weekday: 'short' }), time })
  if (date.getFullYear() !== now.getFullYear())
    return formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' })
  return t('common.time.dateAt', { date: monthDay(date), time })
}

/** When a reminder comes back: "Today 6:30 PM", "Tomorrow 8:00 AM", "Fri 8:00 AM", "Dec 10, 8:00 AM". */
export function whenLabel(date: Date, now = new Date()): string {
  const { t } = i18n()
  const days = daysBetween(now, date)
  const time = clockTime(date)
  if (days === 0) return t('common.time.todayAt', { time })
  if (days === 1) return t('common.time.tomorrowAt', { time })
  if (days > 1 && days < 7) return t('common.time.weekdayAt', { weekday: formatDate(date, { weekday: 'short' }), time })
  return t('common.time.dateAt', { date: monthDay(date), time })
}

/**
 * When something runs out, inside a sentence after "valid until": "today 6:30 PM", "tomorrow 1:00 AM", "Sun 1:00 AM",
 * "Dec 10, 8:00 AM". Always with the clock time (LIN-161: the setup link said "So., 01:00").
 */
export function untilLabel(date: Date, now = new Date()): string {
  const { t } = i18n()
  const days = daysBetween(now, date)
  const time = clockTime(date)
  if (days === 0) return t('common.time.untilToday', { time })
  if (days === 1) return t('common.time.untilTomorrow', { time })
  return whenLabel(date, now)
}
