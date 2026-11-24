// Business hours without React: the week as rows of the form, and back to what businessHours.set takes.
// The form has one span per day; the API allows more (a lunch break), but the form shows the first.
import type { BusinessHoursSpan } from '@linedesk/actions'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

export type DayHours = { weekday: number; open: boolean; start: string; end: string }

/** Monday first, as a US small business reads its week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const DEFAULT_SPAN = { start: '08:00', end: '17:00' }

/** 7:00 AM, 12:30 PM, Midnight, Noon (the clock in the active language: 07:30 in German). */
export function timeOptionLabel(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  const { t } = i18n()
  if (h === 24 || (h === 0 && m === 0)) return t('settings.hours.midnight')
  if (h === 12 && m === 0) return t('settings.hours.noon')
  return fmt().time(Date.UTC(2000, 0, 1, h, m), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
}

/** Every half hour from 00:00 to 24:00, labelled in the active language. */
export const timeOptions = () =>
  Array.from({ length: 49 }, (_, i) => {
    const value = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`
    return { value, label: timeOptionLabel(value) }
  })

/** The opening times (no 24:00) and closing times (no 00:00) to pick from. */
export const startTimeOptions = () => timeOptions().filter(o => o.value !== '24:00')
export const endTimeOptions = () => timeOptions().filter(o => o.value !== '00:00')

/** A weekday (0 Sunday … 6 Saturday) in the active language: "Monday", or "Mon" when short. */
export const weekdayName = (weekday: number, width: 'long' | 'short' = 'long') =>
  // 2023-01-01 was a Sunday.
  fmt().dateTime(Date.UTC(2023, 0, 1 + weekday, 12), { weekday: width, timeZone: 'UTC' })

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
  spansOf(days).some(h => h.end <= h.start) ? i18n().t('settings.hours.closingBeforeOpening') : null

/** The open days, days with the same hours grouped: ["Mon–Fri 7:00 AM–6:00 PM", "Sat 8:00 AM–Noon"]; none when closed every day. */
export function weekGroups(days: readonly DayHours[]): string[] {
  const groups: { first: number; last: number; text: string }[] = []
  for (const weekday of WEEK_ORDER) {
    const day = days.find(d => d.weekday === weekday)
    if (!day?.open) continue
    const text = i18n().t('settings.hours.range', { start: timeOptionLabel(day.start), end: timeOptionLabel(day.end) })
    const prev = groups.at(-1)
    if (prev && prev.text === text && WEEK_ORDER.indexOf(prev.last as never) + 1 === WEEK_ORDER.indexOf(weekday))
      prev.last = weekday
    else groups.push({ first: weekday, last: weekday, text })
  }
  const { t } = i18n()
  return groups.map(g =>
    g.first === g.last
      ? t('settings.hours.summaryDay', { day: weekdayName(g.first, 'short'), hours: g.text })
      : t('settings.hours.summaryDays', {
          first: weekdayName(g.first, 'short'),
          last: weekdayName(g.last, 'short'),
          hours: g.text,
        }),
  )
}

/** The week in one line: "Mon–Fri 7:00 AM–6:00 PM · Sat 8:00 AM–Noon". */
export function weekSummary(days: readonly DayHours[]): string {
  const groups = weekGroups(days)
  return groups.length ? groups.join(' · ') : i18n().t('settings.hours.closedEveryDay')
}
