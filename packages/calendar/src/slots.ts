// Free appointment slots = working hours − busy intervals (± buffer) − minimum notice, inside the
// search window and the type's booking horizon. Pure: no I/O, no clock, no vendor code.
// Field names match the database rows, so rows can be passed in as they are.
import { addDays, localDate, weekdayOf, zonedTimeToInstant } from './zoned-time.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
export const DEFAULT_STEP_MIN = 30

/** Two instants as ISO 8601 strings; `end` is exclusive. */
export type Interval = { start: string; end: string }
/**
 * Open hours on one weekday (0 = Sunday … 6 = Saturday), wall-clock `HH:MM`. Several per day are allowed.
 * `end_time` must be after `start_time` (`24:00` = end of day): hours cannot cross midnight.
 */
export type WorkingHours = { weekday: number; start_time: string; end_time: string }
/** Replaces the weekly hours on `date` (`YYYY-MM-DD`). Without times (both null) the day is closed. */
export type HoursException = { date: string; start_time: string | null; end_time: string | null }
export type SlotRules = { duration_min: number; buffer_min: number; min_notice_hours: number; max_days_ahead: number }

export interface FindSlotsInput {
  /** IANA time zone the working hours are written in. */
  timeZone: string
  hours: readonly WorkingHours[]
  exceptions: readonly HoursException[]
  appointmentType: SlotRules
  /** Existing bookings and provider free/busy. Order and overlaps do not matter. */
  busy: readonly Interval[]
  /** Slots lie completely inside this window. */
  window: Interval
  now: string
  /** Distance between slot starts, counted from the start of each open period. */
  stepMin?: number
  /** Return at most this many slots (the earliest ones). */
  limit?: number
}

type Span = { start: number; end: number }

function toInstant(iso: string) {
  const instant = Date.parse(iso)
  if (Number.isNaN(instant)) throw new RangeError(`invalid instant ${iso}`)
  return instant
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$|^24:00(:00)?$/

function assertTimeRange(label: string, start: string, end: string) {
  if (!TIME.test(start) || !TIME.test(end)) throw new RangeError(`${label}: ${start}–${end} is not a valid time range`)
  if (end.slice(0, 5) <= start.slice(0, 5)) throw new RangeError(`${label}: end ${end} must be after start ${start} (hours cannot cross midnight)`)
}

/** Throws a RangeError for input the engine cannot give a correct answer for. */
function assertValid({ hours, exceptions, appointmentType: type, stepMin = DEFAULT_STEP_MIN, limit }: FindSlotsInput) {
  if (!(type.duration_min > 0)) throw new RangeError('duration_min must be positive')
  if (!(stepMin > 0)) throw new RangeError('stepMin must be positive')
  if (limit !== undefined && !(limit > 0)) throw new RangeError('limit must be positive')
  for (const field of ['buffer_min', 'min_notice_hours', 'max_days_ahead'] as const) {
    if (!(type[field] >= 0)) throw new RangeError(`${field} must not be negative`)
  }
  for (const h of hours) {
    if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6) throw new RangeError(`weekday ${h.weekday} must be 0 (Sunday) to 6`)
    assertTimeRange(`working hours on weekday ${h.weekday}`, h.start_time, h.end_time)
  }
  for (const e of exceptions) {
    if (e.start_time === null && e.end_time === null) continue
    if (e.start_time === null || e.end_time === null) throw new RangeError(`exception on ${e.date}: needs both times or none`)
    assertTimeRange(`exception on ${e.date}`, e.start_time, e.end_time)
  }
}

/** The open periods of one local date as instants: its exceptions if it has any, else the weekly hours. */
function openPeriods(date: string, { timeZone, hours, exceptions }: FindSlotsInput): Span[] {
  const dayExceptions = exceptions.filter(e => e.date === date)
  const ranges = dayExceptions.length ? dayExceptions : hours.filter(h => h.weekday === weekdayOf(date))
  return ranges.flatMap(r => r.start_time && r.end_time
    ? [{ start: zonedTimeToInstant(date, r.start_time, timeZone), end: zonedTimeToInstant(date, r.end_time, timeZone) }]
    : [])
}

/** The span in which slots may lie: window ∩ [now + notice, end of the last bookable local day). */
function bookableSpan({ timeZone, appointmentType: type, window, now }: FindSlotsInput): Span {
  const nowInstant = toInstant(now)
  const dayAfterLast = addDays(localDate(nowInstant, timeZone), type.max_days_ahead + 1)
  return {
    start: Math.max(toInstant(window.start), nowInstant + type.min_notice_hours * HOUR_MS),
    end: Math.min(toInstant(window.end), zonedTimeToInstant(dayAfterLast, '00:00', timeZone)),
  }
}

/** Free slots, earliest first. Empty when nothing fits. Throws a RangeError for invalid input. */
export function findSlots(input: FindSlotsInput): Interval[] {
  assertValid(input)
  const { timeZone, appointmentType: type, limit = Infinity } = input
  const duration = type.duration_min * MINUTE_MS
  const step = (input.stepMin ?? DEFAULT_STEP_MIN) * MINUTE_MS
  const buffer = type.buffer_min * MINUTE_MS
  const blocked = input.busy.map(b => ({ start: toInstant(b.start) - buffer, end: toInstant(b.end) + buffer }))
  const isFree = (start: number) => blocked.every(b => start + duration <= b.start || start >= b.end)
  const bookable = bookableSpan(input)

  // Day by day: every slot of a later day starts later, so the search can stop at the limit.
  const starts = new Set<number>()
  const lastDate = localDate(bookable.end, timeZone)
  for (let date = localDate(bookable.start, timeZone); date <= lastDate && starts.size < limit; date = addDays(date, 1)) {
    for (const period of openPeriods(date, input)) {
      for (let start = period.start; start + duration <= period.end; start += step) {
        if (start >= bookable.start && start + duration <= bookable.end && isFree(start)) starts.add(start)
      }
    }
  }
  return [...starts].sort((a, b) => a - b).slice(0, limit)
    .map(start => ({ start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() }))
}
