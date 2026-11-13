// The day a caller names, worked out in code: models count weekdays wrong ("next Wednesday" a day off), so the
// tools take the caller's words and this turns them into a date, or into a question when they can mean two days.
import { parseDate } from './collect/collectors.ts'

export type Day = { date: string } | { ask: string } | { unknown: string }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10)
}
const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay()
/** "Wednesday, November 18": how a date is said back to the caller. */
export const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

/** Today in a time zone, YYYY-MM-DD. */
export const todayIn = (timeZone: string, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/**
 * The day `said` names, from `today` (YYYY-MM-DD): a date (YYYY-MM-DD, "November 17", "11/17"), "today",
 * "tomorrow", "the day after tomorrow", a weekday ("Wednesday", "this Wednesday": the coming one), "the 17th" (the
 * coming one), "this week" / "next week" (its Monday, or with `end` its Sunday). "next Wednesday" can mean this week's
 * or the following week's: then the caller is asked.
 */
export function resolveDay(said: string, today: string, { end = false } = {}): Day {
  const s = said.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').replace(/^(on|for) /, '')
  if (s === 'today' || s === 'tonight') return { date: today }
  if (s === 'tomorrow') return { date: addDays(today, 1) }
  if (s === 'the day after tomorrow' || s === 'day after tomorrow') return { date: addDays(today, 2) }

  const week = s.match(/^(this|next) week$/)
  if (week) {
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7) + (week[1] === 'next' ? 7 : 0))
    return { date: end ? addDays(monday, 6) : week[1] === 'this' && !end ? today : monday }
  }

  const weekday = s.match(/^(this |next |coming |this coming )?([a-z]+)$/)
  const index = weekday ? WEEKDAYS.indexOf(weekday[2]!) : -1
  if (weekday && index >= 0) {
    const ahead = (index - weekdayOf(today) + 7) % 7
    const coming = addDays(today, ahead || (weekday[1]?.trim() === 'this' ? 0 : 7))
    if (weekday[1]?.trim() !== 'next') return { date: coming }
    const following = addDays(coming, 7)
    return { ask: `"${said.trim()}" can mean ${dayLabel(coming)} or ${dayLabel(following)}. Ask the caller which one, then call this again with that date.` }
  }

  const dayOfMonth = s.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)?$/)
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1])
    for (const months of [0, 1, 2]) {
      const [y, m] = today.split('-').map(Number)
      const date = new Date(Date.UTC(y!, m! - 1 + months, day, 12))
      const iso = date.toISOString().slice(0, 10)
      if (date.getUTCDate() === day && iso >= today) return { date: iso }
    }
  }

  const date = parseDate(said, today)
  if (date) return { date }
  return { unknown: `Could not tell which day "${said.trim()}" is. Ask the caller for the date (like "Tuesday" or "November 17").` }
}
