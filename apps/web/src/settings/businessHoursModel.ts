// Business hours without React: the week as rows of the form, and back to what businessHours.set takes.
// The form has one span per day; the API allows more (a lunch break), but the form shows the first.
import type { BusinessHoursSpan } from '@linedesk/actions'

export type DayHours = { weekday: number; open: boolean; start: string; end: string }

/** Monday first, as a US small business reads its week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const DEFAULT_SPAN = { start: '08:00', end: '17:00' }

/** 7:00 AM, 12:30 PM, midnight. */
export function timeOptionLabel(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  if (h === 24 || (h === 0 && m === 0)) return 'Midnight'
  if (h === 12 && m === 0) return 'Noon'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Every half hour from 00:00 to 24:00. */
export const timeOptions = Array.from({ length: 49 }, (_, i) => {
  const value = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`
  return { value, label: timeOptionLabel(value) }
})

/** One row per weekday; a day without hours is closed (with the default times ready for when it opens). */
export function dayRows(spans: readonly BusinessHoursSpan[]): DayHours[] {
  return [0, 1, 2, 3, 4, 5, 6].map(weekday => {
    const span = spans.filter(s => s.weekday === weekday).sort((a, b) => a.start.localeCompare(b.start))[0]
    return span ? { weekday, open: true, start: span.start, end: span.end } : { weekday, open: false, ...DEFAULT_SPAN }
  })
}

export const spansOf = (days: readonly DayHours[]): BusinessHoursSpan[] =>
  days.filter(d => d.open).map(({ weekday, start, end }) => ({ weekday, start, end }))

export function hoursChanged(saved: readonly BusinessHoursSpan[], days: readonly DayHours[]): boolean {
  const key = (spans: readonly BusinessHoursSpan[]) =>
    spans
      .map(s => `${s.weekday} ${s.start} ${s.end}`)
      .sort()
      .join('|')
  return key(spansOf(dayRows(saved))) !== key(spansOf(days))
}

/** Why the hours cannot be saved, in words for the user; null when they can. */
export const hoursProblem = (days: readonly DayHours[]): string | null =>
  spansOf(days).some(h => h.end <= h.start) ? 'Each open day needs a closing time after its opening time.' : null

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The week in one line, days with the same hours grouped: "Mon–Fri 7:00 AM–6:00 PM · Sat 8:00 AM–Noon". */
export function weekSummary(days: readonly DayHours[]): string {
  const groups: { first: number; last: number; text: string }[] = []
  for (const weekday of WEEK_ORDER) {
    const day = days.find(d => d.weekday === weekday)
    if (!day?.open) continue
    const text = `${timeOptionLabel(day.start)}–${timeOptionLabel(day.end)}`
    const prev = groups.at(-1)
    if (prev && prev.text === text && WEEK_ORDER.indexOf(prev.last as never) + 1 === WEEK_ORDER.indexOf(weekday)) prev.last = weekday
    else groups.push({ first: weekday, last: weekday, text })
  }
  if (!groups.length) return 'Closed every day'
  return groups
    .map(g => `${DAY_SHORT[g.first]}${g.first === g.last ? '' : `–${DAY_SHORT[g.last]}`} ${g.text}`)
    .join(' · ')
}
