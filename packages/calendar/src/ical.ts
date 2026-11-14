// The part of iCalendar (RFC 5545) the CalDAV adapter needs: read the events of a calendar object, with their times
// as instants and their recurrences within a window, and write one event. Not a general parser: properties of
// VEVENT only (alarms and time zone definitions skipped), times in UTC or an IANA TZID; all-day and floating times
// (and a TZID that is no IANA zone) are read in the business's time zone.
import { addDays, weekdayOf, zonedTimeToInstant } from './zoned-time.ts'
import type { Interval } from './slots.ts'

type Prop = { name: string; params: Record<string, string>; value: string }

/** A VEVENT as read: its properties by name (the first of each, EXDATE all of them). */
export type VEvent = { props: Map<string, Prop>; exdates: Prop[] }

/** Unfolds the lines (RFC 5545 3.1) and splits each into name, parameters and value. */
function propsOf(text: string): Prop[] {
  const lines = text.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r?\n/)
  const props: Prop[] = []
  for (const line of lines) {
    if (!line) continue
    // The value starts at the first colon outside a quoted parameter value.
    let quoted = false
    let colon = -1
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted
      else if (line[i] === ':' && !quoted) {
        colon = i
        break
      }
    }
    if (colon < 0) continue
    const [name, ...params] = line.slice(0, colon).split(';')
    props.push({
      name: name!.toUpperCase(),
      params: Object.fromEntries(
        params.map(p => {
          const eq = p.indexOf('=')
          return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, '')]
        }),
      ),
      value: line.slice(colon + 1),
    })
  }
  return props
}

/** The VEVENTs of a calendar object; nested components (VALARM) are skipped. */
export function parseEvents(text: string): VEvent[] {
  const events: VEvent[] = []
  let current: VEvent | null = null
  let nested = 0
  for (const prop of propsOf(text)) {
    if (prop.name === 'BEGIN') {
      if (current) nested++
      else if (prop.value.toUpperCase() === 'VEVENT') current = { props: new Map(), exdates: [] }
      continue
    }
    if (prop.name === 'END') {
      if (current && nested) nested--
      else if (current && prop.value.toUpperCase() === 'VEVENT') {
        events.push(current)
        current = null
      }
      continue
    }
    if (!current || nested) continue
    if (prop.name === 'EXDATE') current.exdates.push(prop)
    else if (!current.props.has(prop.name)) current.props.set(prop.name, prop)
  }
  return events
}

export const unescapeText = (value: string) =>
  value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

/** A DATE or DATE-TIME as wall clock: date `YYYY-MM-DD`, time `HH:MM:SS` (null for a date), and its zone. */
type Wall = { date: string; time: string | null; zone: 'utc' | 'floating' | string }

function wallOf(prop: Pick<Prop, 'params' | 'value'>, value = prop.value): Wall | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!m[4]) return { date, time: null, zone: 'floating' }
  const zone = m[7] ? 'utc' : (prop.params.TZID ?? 'floating')
  return { date, time: `${m[4]}:${m[5]}:${m[6]}`, zone }
}

/** Whether a TZID is an IANA zone this runtime knows, asked once per zone (a refused one costs a throwing formatter). */
const knownZones = new Map<string, boolean>()
function isKnownZone(zone: string): boolean {
  let known = knownZones.get(zone)
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      known = true
    } catch {
      known = false
    }
    // A full cache keeps what it knows: a zone it has no room for counts as unknown (the business's zone is used).
    if (knownZones.size >= 1000) return false
    knownZones.set(zone, known)
  }
  return known
}

/**
 * The instant (ms) a wall clock time stands for; floating ones and an unknown TZID (a Windows zone name) in
 * `timeZone`. NaN for a date or time that does not exist (month 13): the caller leaves such an event out.
 */
function instantOf(wall: Wall, timeZone: string): number {
  const time = wall.time ?? '00:00:00'
  const utc = Date.parse(`${wall.date}T${time}Z`)
  if (wall.zone === 'utc' || Number.isNaN(utc)) return utc
  const zone = wall.zone !== 'floating' && isKnownZone(wall.zone) ? wall.zone : timeZone
  if (!isKnownZone(zone)) return utc
  try {
    return zonedTimeToInstant(wall.date, time, zone) + Number(time.slice(6, 8)) * 1000
  } catch {
    return Number.NaN
  }
}

/** An ISO 8601 duration as ms (P1D, PT1H30M, -PT15M; weeks too). */
function durationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!m) return null
  const [, sign, w, d, h, min, s] = m
  const ms =
    ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 * 3600 +
      Number(h ?? 0) * 3600 +
      Number(min ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  return sign === '-' ? -ms : ms
}

/** An event's own span: DTEND, else DURATION, else a day for an all-day event and nothing for a timed one. */
function spanOf(event: VEvent, timeZone: string): { start: Wall; startMs: number; lengthMs: number } | null {
  const dtstart = event.props.get('DTSTART')
  const start = dtstart && wallOf(dtstart)
  if (!start) return null
  const startMs = instantOf(start, timeZone)
  const dtend = event.props.get('DTEND')
  const end = dtend && wallOf(dtend)
  const duration = event.props.get('DURATION')
  const lengthMs = end
    ? instantOf(end, timeZone) - startMs
    : duration
      ? (durationMs(duration.value) ?? 0)
      : start.time
        ? 0
        : 86_400_000
  if (!Number.isFinite(startMs) || !Number.isFinite(lengthMs)) return null
  return { start, startMs, lengthMs: Math.max(0, lengthMs) }
}

/** Free time (TRANSP:TRANSPARENT) and cancelled events take no time. */
const takesTime = (event: VEvent) =>
  event.props.get('TRANSP')?.value.toUpperCase() !== 'TRANSPARENT' &&
  event.props.get('STATUS')?.value.toUpperCase() !== 'CANCELLED'

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
/** RRULE parts expanded here; a rule with others is read as "every day" (busy too often rather than double-booked). */
const UNDERSTOOD = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'])
/** Longest span between two occurrences of each FREQ, in days: bounds a COUNT series whose rule is not expanded here. */
const PERIOD_DAYS: Record<string, number> = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }
const MAX_INTERVAL = 1000
const MAX_COUNT = 1_000_000
/** No series is followed further than this from its DTSTART (days, about 400 years). */
const MAX_SPAN_DAYS = 146_000

/**
 * How many occurrences one availability check may compute, over all events of all calendars. The calendar is the
 * member's (and invitations reach it from anyone), so a hostile series must not hold up the API.
 */
export const MAX_OCCURRENCES_PER_CHECK = 20_000
export type OccurrenceBudget = { left: number }
export class OccurrenceBudgetExceeded extends Error {}
const MAX_DATE_MS = 8.64e15
/** Events in one calendar object, and EXDATE values in one event, that are read at most; more fails the check. */
const MAX_EVENTS_PER_OBJECT = 5000
const MAX_EXDATES_PER_EVENT = 1000

function spend(budget: OccurrenceBudget) {
  budget.left--
  if (budget.left < 0) throw new OccurrenceBudgetExceeded('too many occurrences')
}

function addMonths(date: string, months: number): string | null {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1 + months, d))
  // The 31st in a month without one has no occurrence (RFC 5545 3.3.10).
  return t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** A whole number from an RRULE part within [min, max], or null when it is missing or no number. */
function wholeNumber(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  return Math.min(max, Math.max(min, Number(value)))
}

/** Occurrences i in [0, steps) of a DAILY rule with BYDAY (`first` + i·interval on one of `days`); the weekdays repeat every 7 steps. */
function dailyByDayBefore(first: string, interval: number, days: string[], steps: number): number {
  const w0 = weekdayOf(first)
  const hit = (i: number) => days.includes(WEEKDAYS[(w0 + ((i * interval) % 7)) % 7]!)
  const perWeek = [0, 1, 2, 3, 4, 5, 6].filter(hit).length
  let n = Math.floor(steps / 7) * perWeek
  for (let i = Math.floor(steps / 7) * 7; i < steps; i++) if (hit(i)) n++
  return n
}

/**
 * The start dates (wall clock) of a recurring event from `fromDate` (or DTSTART, when later) until `lastDate`, in
 * order. FREQ DAILY, WEEKLY (BYDAY), MONTHLY and YEARLY by DTSTART's day, with INTERVAL, COUNT and UNTIL. Occurrences
 * before `fromDate` are skipped by arithmetic, COUNT included, so a series that started years ago costs no more.
 * Any other rule counts as every day of the series (with COUNT: of the longest the series could last).
 */
function recurrenceDates(
  rule: Record<string, string>,
  first: string,
  fromDate: string,
  lastDate: string,
  budget: OccurrenceBudget,
): string[] {
  const freq = rule.FREQ ?? ''
  const interval = wholeNumber(rule.INTERVAL, 1, MAX_INTERVAL) ?? 1
  const count = wholeNumber(rule.COUNT, 0, MAX_COUNT) ?? Number.POSITIVE_INFINITY
  const ruleUntil = /^\d{8}/.test(rule.UNTIL ?? '')
    ? `${rule.UNTIL!.slice(0, 4)}-${rule.UNTIL!.slice(4, 6)}-${rule.UNTIL!.slice(6, 8)}`
    : null
  const farthest = addDays(first, MAX_SPAN_DAYS)
  let until = [lastDate, farthest, ...(ruleUntil && !Number.isNaN(Date.parse(ruleUntil)) ? [ruleUntil] : [])].sort()[0]!
  const start = fromDate > first ? fromDate : first
  const dates: string[] = []
  if (start > until || count === 0) return dates

  const known = Object.keys(rule).every(k => UNDERSTOOD.has(k)) && freq in PERIOD_DAYS
  const byDay = rule.BYDAY?.split(',').map(d => d.trim().toUpperCase())
  // BYDAY with a position (2TU, -1FR) or on a monthly or yearly rule: not expanded here.
  const plainByDay = !byDay || byDay.every(d => WEEKDAYS.includes(d))
  if (!known || !plainByDay || (byDay && freq !== 'WEEKLY' && freq !== 'DAILY')) {
    if (Number.isFinite(count)) {
      const seriesEnd = addDays(first, Math.min(count * (PERIOD_DAYS[freq] ?? 366) * interval, MAX_SPAN_DAYS))
      if (seriesEnd < until) until = seriesEnd
    }
    for (let d = start; d <= until; d = addDays(d, 1)) {
      spend(budget)
      dates.push(d)
    }
    return dates
  }

  const skipped = daysBetween(first, start)
  const day = Number(first.slice(8, 10))
  // The first step to compute, and how many occurrences came before it (they count towards COUNT).
  let step = 0
  let seen = 0
  if (freq === 'DAILY') {
    step = Math.max(0, Math.floor(skipped / interval) - 1)
    seen = byDay ? dailyByDayBefore(first, interval, byDay, step) : step
  } else if (freq === 'WEEKLY') {
    const days = byDay ?? [WEEKDAYS[weekdayOf(first)]!]
    step = Math.max(0, Math.floor((skipped + weekdayOf(first)) / 7 / interval) - 1)
    const firstWeek = WEEKDAYS.filter((d, i) => days.includes(d) && i >= weekdayOf(first)).length
    seen = step === 0 ? 0 : firstWeek + (step - 1) * new Set(days).size
  } else if (day <= 28 || !Number.isFinite(count)) {
    // Skipped by month arithmetic. With a COUNT every skipped step must be an occurrence: only when every month has the
    // day (≤ 28); without a COUNT the skipped ones need not be counted at all.
    const months =
      (Number(start.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
      Number(start.slice(5, 7)) -
      Number(first.slice(5, 7))
    step = Math.max(0, Math.floor(months / (freq === 'YEARLY' ? 12 : 1) / interval) - 1)
    seen = day <= 28 ? step : 0
  }
  const keep = (date: string) => {
    seen++
    if (seen <= count && date >= start && date <= until) dates.push(date)
  }
  for (const firstStep = step; seen < count; step++) {
    spend(budget)
    if (freq === 'DAILY') {
      const date = addDays(first, step * interval)
      if (date > until) break
      if (!byDay || byDay.includes(WEEKDAYS[weekdayOf(date)]!)) keep(date)
    } else if (freq === 'WEEKLY') {
      const weekStart = addDays(first, step * 7 * interval - weekdayOf(first))
      if (weekStart > until) break
      const days = byDay ?? [WEEKDAYS[weekdayOf(first)]!]
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        if (date >= first && days.includes(WEEKDAYS[i]!)) keep(date)
      }
    } else {
      const date = addMonths(first, step * interval * (freq === 'YEARLY' ? 12 : 1))
      if (date && date > until) break
      if (date) keep(date)
      if (step > firstStep + 12 * 400) break
    }
  }
  return dates
}

/**
 * The times the events of one calendar object take inside `window`. A recurring event the server did not expand is
 * expanded here; RECURRENCE-ID instances replace the occurrence they move, EXDATE removes one. Events with dates that
 * cannot be read are left out. `budget` is shared by every call of one availability check: past it, the check fails
 * with OccurrenceBudgetExceeded instead of computing on.
 */
export function busyOf(
  text: string,
  window: Interval,
  timeZone = 'UTC',
  budget: OccurrenceBudget = { left: MAX_OCCURRENCES_PER_CHECK },
): Interval[] {
  const lo = Date.parse(window.start)
  const hi = Date.parse(window.end)
  const events = parseEvents(text)
  if (events.length > MAX_EVENTS_PER_OBJECT) throw new OccurrenceBudgetExceeded('too many events')
  // Dates (wall clock) that can matter for the window, with a day of margin for zones; anything else is not converted.
  const near = (date: string, from: string, last: string) => date >= from && date <= last
  const windowFrom = new Date(lo - 2 * 86_400_000).toISOString().slice(0, 10)
  const windowLast = new Date(hi + 86_400_000).toISOString().slice(0, 10)
  const out: Interval[] = []
  const moved = new Set<number>()
  for (const event of events) {
    spend(budget)
    const recurrenceId = event.props.get('RECURRENCE-ID')
    const wall = recurrenceId && wallOf(recurrenceId)
    if (wall && near(wall.date, windowFrom, windowLast)) moved.add(instantOf(wall, timeZone))
  }
  const add = (startMs: number, lengthMs: number) => {
    const endMs = startMs + Math.max(lengthMs, 0)
    // Dates outside what a Date can hold (±275,000 years) are no time anyone books into.
    if (!(Math.abs(startMs) <= MAX_DATE_MS) || !(Math.abs(endMs) <= MAX_DATE_MS)) return
    if (startMs < hi && endMs > lo && endMs > startMs)
      out.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() })
  }
  for (const event of events) {
    spend(budget)
    const span = spanOf(event, timeZone)
    if (!span || !takesTime(event)) continue
    const rrule = event.props.get('RRULE')
    if (!rrule || event.props.has('RECURRENCE-ID')) {
      add(span.startMs, span.lengthMs)
      continue
    }
    const rule = Object.fromEntries(
      rrule.value
        .split(';')
        .map(part => part.split('=') as [string, string])
        .map(([k, v]) => [k.toUpperCase(), v ?? '']),
    )
    // Dates around the window, with margin for zones and the event's own length; add drops what does not overlap.
    const fromMs = lo - Math.min(span.lengthMs, MAX_SPAN_DAYS * 86_400_000) - 2 * 86_400_000
    const fromDate = new Date(Math.max(fromMs, Date.parse('0001-01-01T00:00:00Z'))).toISOString().slice(0, 10)
    const lastDate = new Date(hi + 86_400_000).toISOString().slice(0, 10)
    // Excluded dates: at most MAX_EXDATES_PER_EVENT, each paid from the budget, only those near the window converted.
    const excluded = new Set<number>()
    let exdates = 0
    for (const p of event.exdates) {
      for (const v of p.value.split(',')) {
        if (++exdates > MAX_EXDATES_PER_EVENT) throw new OccurrenceBudgetExceeded('too many excluded dates')
        spend(budget)
        const w = wallOf(p, v)
        if (w && near(w.date, fromDate, lastDate)) excluded.add(instantOf(w, timeZone))
      }
    }
    for (const date of recurrenceDates(rule, span.start.date, fromDate, lastDate, budget)) {
      const startMs = instantOf({ ...span.start, date }, timeZone)
      if (excluded.has(startMs) || moved.has(startMs)) continue
      add(startMs, span.lengthMs)
    }
  }
  return out
}

/** What Linedesk reads back from an event it wrote: title, times, whether it was cancelled. */
export function eventOf(text: string): {
  uid: string
  title: string
  description: string
  location: string | undefined
  start: string
  end: string
  cancelled: boolean
  sequence: number
} | null {
  const event = parseEvents(text)[0]
  const span = event && spanOf(event, 'UTC')
  if (!event || !span) return null
  const text_ = (name: string) => {
    const p = event.props.get(name)
    return p ? unescapeText(p.value) : undefined
  }
  return {
    uid: text_('UID') ?? '',
    title: text_('SUMMARY') ?? '',
    description: text_('DESCRIPTION') ?? '',
    location: text_('LOCATION'),
    start: new Date(span.startMs).toISOString(),
    end: new Date(span.startMs + span.lengthMs).toISOString(),
    cancelled: event.props.get('STATUS')?.value.toUpperCase() === 'CANCELLED',
    sequence: Number(event.props.get('SEQUENCE')?.value) || 0,
  }
}

/**
 * Text as an iCalendar TEXT value: every line break (CRLF, LF and a bare CR) becomes \\n and other control characters
 * go, so a caller's words can never start a property of their own (an ATTENDEE that makes the server send invitations).
 */
const escapeText = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\p{Cc}/gu, c => (c === '\t' ? c : ''))

/** Lines longer than 75 octets are folded (RFC 5545 3.1), never inside a UTF-8 character. */
function fold(line: string): string {
  const bytes = new TextEncoder()
  if (bytes.encode(line).length <= 75) return line
  const parts: string[] = []
  let part = ''
  for (const char of line) {
    const limit = parts.length ? 74 : 75
    if (bytes.encode(part + char).length > limit) {
      parts.push(part)
      part = ''
    }
    part += char
  }
  parts.push(part)
  return parts.join('\r\n ')
}

/** 2030-01-08T18:00:00.000Z → 20300108T180000Z */
export const icalUtc = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

/** One event as a calendar object. Times in UTC: every client shows them in its own zone. */
export function eventIcs(
  event: {
    uid: string
    title: string
    description: string
    start: string
    end: string
    location?: string
    sequence?: number
  },
  now = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Linedesk//Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${icalUtc(now.toISOString())}`,
    `DTSTART:${icalUtc(event.start)}`,
    `DTEND:${icalUtc(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `SEQUENCE:${event.sequence ?? 0}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(fold).join('\r\n')}\r\n`
}
