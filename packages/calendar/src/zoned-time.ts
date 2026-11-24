// Wall-clock time in an IANA time zone <-> instants (epoch ms). Built on Intl only.
const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Throws a RangeError for an unknown time zone. */
function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** What the clock on the wall shows in `timeZone` at `instant`, encoded as if it were UTC. */
function wallClock(instant: number, timeZone: string) {
  const part: Record<string, number> = {}
  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) part[type] = Number(value)
  return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!)
}

const offsetAt = (instant: number, timeZone: string) => wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000

/** The calendar date (`YYYY-MM-DD`) in `timeZone` at `instant`. */
export const localDate = (instant: number, timeZone: string) => new Date(wallClock(instant, timeZone)).toISOString().slice(0, 10)

export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/** 0 = Sunday … 6 = Saturday, like `Date.getDay()`. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/**
 * The instant at which the wall clock in `timeZone` shows `date` + `time` (`HH:MM`, seconds ignored,
 * `24:00` = end of day). On a daylight-saving change: a time that occurs twice resolves to the
 * first occurrence, a time that is skipped moves forward by the skipped amount (02:30 → 03:30).
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string) {
  const wall = Date.parse(`${date}T${time.slice(0, 5)}:00Z`)
  if (Number.isNaN(wall)) throw new RangeError(`invalid local time ${date} ${time}`)
  const offsetBefore = offsetAt(wall - DAY_MS, timeZone)
  const offsetAfter = offsetAt(wall + DAY_MS, timeZone)
  const matches = [wall - offsetBefore, wall - offsetAfter].filter(instant => wallClock(instant, timeZone) === wall)
  return matches.length ? Math.min(...matches) : wall - offsetBefore
}
