// A time typed into the Remind menu: "tomorrow 9am", "fri 2pm", "in 3 hours", "nov 20", "next mon".
// Day without a time means the morning (8:00); a time without a day means its next occurrence.
// Anything it does not fully understand gives null, so a typo never sets a wrong reminder.

const MORNING_HOUR = 8
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const PARTS_OF_DAY: Record<string, number> = {
  morning: 8,
  noon: 12,
  afternoon: 14,
  evening: 18,
  tonight: 19,
  night: 19,
}
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
}
const FILLER = /\b(remind|me|on|at|the|this|in)\b/g

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const amount = (word: string) => NUMBER_WORDS[word] ?? Number(word)

type State = { text: string; now: Date; day: Date | null; hour: number | null; minute: number }

/** Removes the first match from the text and returns it. */
function take(s: State, pattern: RegExp): RegExpExecArray | null {
  const match = pattern.exec(s.text)
  if (match) s.text = `${s.text.slice(0, match.index)} ${s.text.slice(match.index + match[0].length)}`.trim()
  return match
}

/** "in 3 hours", "in 20 minutes": an exact moment. "in 2 days", "in a week": a day. */
function relative(s: State): Date | null {
  const m = take(
    s,
    /\bin (\d+|an?|one|two|three|four|five|six|ten) ?(minutes?|mins?|months?|hours?|hrs?|h|days?|weeks?)\b/,
  )
  if (!m) return null
  const n = amount(m[1]!)
  const unit = m[2]!
  if (/^mo/.test(unit)) {
    s.day = new Date(s.now.getFullYear(), s.now.getMonth() + n, s.now.getDate())
    return null
  }
  if (/^m/.test(unit)) return new Date(s.now.getTime() + n * 60_000)
  if (/^h/.test(unit)) return new Date(s.now.getTime() + n * 3_600_000)
  s.day = addDays(startOfDay(s.now), /^w/.test(unit) ? n * 7 : n)
  return null
}

function namedDay(s: State) {
  const today = startOfDay(s.now)
  if (take(s, /\btoday\b/)) s.day = today
  else if (take(s, /\b(tomorrow|tmrw?|tmr)\b/)) s.day = addDays(today, 1)
  const weekday = take(s, /\b(next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/)
  if (weekday) {
    const ahead = (WEEKDAYS.indexOf(weekday[2]!) - today.getDay() + 7) % 7 || 7 // today's weekday means next week
    s.day = addDays(today, ahead)
  }
}

function calendarDay(s: State) {
  const month = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
  const m =
    take(s, new RegExp(`\\b${month} (\\d{1,2})(?:st|nd|rd|th)?\\b`)) ??
    take(s, new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${month}\\b`))
  const slash = m ? null : take(s, /\b(\d{1,2})\/(\d{1,2})\b/)
  if (!m && !slash) return
  const [monthIndex, date] = m
    ? MONTHS.includes(m[1]!.slice(0, 3))
      ? [MONTHS.indexOf(m[1]!.slice(0, 3)), Number(m[2])]
      : [MONTHS.indexOf(m[2]!.slice(0, 3)), Number(m[1])]
    : [Number(slash![1]) - 1, Number(slash![2])]
  let day = new Date(s.now.getFullYear(), monthIndex, date)
  if (day.getMonth() !== monthIndex) return // Feb 30 and the like
  if (day < startOfDay(s.now)) day = new Date(s.now.getFullYear() + 1, monthIndex, date)
  s.day = day
}

function timeOfDay(s: State) {
  const part = take(s, /\b(morning|noon|afternoon|evening|tonight|night)\b/)
  if (part) s.hour = PARTS_OF_DAY[part[1]!]!
  const m = take(s, /\b(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)?\b/)
  if (!m) return
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const half = m[3]?.[0]
  if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) {
    s.text = `${s.text} ?` // not a time: leave something unread, so the whole text fails
    return
  }
  if (half === 'p' && hour < 12) hour += 12
  else if (half === 'a' && hour === 12) hour = 0
  else if (!half && hour >= 1 && hour <= 6) hour += 12 // "at 3" in a working day is the afternoon
  s.hour = hour
  s.minute = minute
}

/** The moment a typed text means, or null when it is not a time or already past. */
export function parseWhen(input: string, now = new Date()): Date | null {
  const s: State = {
    text: input.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim(),
    now,
    day: null,
    hour: null,
    minute: 0,
  }
  if (!s.text) return null
  const exact = relative(s)
  namedDay(s)
  calendarDay(s)
  timeOfDay(s)
  if (s.text.replace(FILLER, '').trim()) return null // something it did not understand
  if (exact) return s.day || s.hour !== null ? null : exact
  if (!s.day && s.hour === null) return null
  const hour = s.hour ?? MORNING_HOUR
  let day = s.day ?? startOfDay(now)
  let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, s.minute)
  if (!s.day && at <= now) {
    day = addDays(day, 1) // a time alone: the next time it comes round
    at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, s.minute)
  }
  return at > now ? at : null
}
