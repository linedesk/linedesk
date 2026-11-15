// What the Insights page says about the numbers: periods, the summary sentence, changes, the chart's
// grouping by day, week or month, the busiest time, and money.
import type { InsightCounts, InsightDay, InsightPeriod, InsightsData, JobValueCurrency } from '@linedesk/actions'
import { currencyDigits, fromMinorUnits, jobValueCurrencies, toMinorUnits } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { fmt, intlLocale } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import type { SelectOption } from '../ui/controls.tsx'

type Translate = ReturnType<typeof i18n>['t']
/** The active language's `t`, looked up on each call (the language can change while the module stays loaded). */
const t = ((...args: Parameters<Translate>) => i18n().t(...args)) as Translate

export const PERIOD_LABELS: Record<InsightPeriod, MessageKey> = {
  '7d': msg('insights.period.7d'),
  '30d': msg('insights.period.30d'),
  month: msg('insights.period.month'),
  lastMonth: msg('insights.period.lastMonth'),
  '12m': msg('insights.period.12m'),
  all: msg('insights.period.all'),
}

const DAY_MS = 86_400_000
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const utcDate = (date: string, opts: Intl.DateTimeFormatOptions) =>
  fmt().dateTime(new Date(ms(date)), { ...opts, timeZone: 'UTC' })

/** "Nov 11". */
export const shortDate = (date: string) => utcDate(date, { month: 'short', day: 'numeric' })
/** "Nov 11, 2026". */
export const longDate = (date: string) => utcDate(date, { month: 'short', day: 'numeric', year: 'numeric' })

/** "Oct 15 – Nov 13, 2026" or "Dec 1, 2025 – Nov 13, 2026". */
export function spanLabel(from: string, to: string): string {
  if (from === to) return longDate(to)
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${shortDate(from)} – ${longDate(to)}`
    : `${longDate(from)} – ${longDate(to)}`
}

/** What the period is compared with, as the tiles say it: "prior 30 days", "Oct 1–13", "September". */
export function compareLabel(data: Pick<InsightsData, 'period' | 'days' | 'compareWith'>): string | null {
  const c = data.compareWith
  if (!c) return null
  if (data.period === 'lastMonth') return utcDate(c.from, { month: 'long' })
  if (data.period === 'month')
    return c.from === c.to ? shortDate(c.from) : `${shortDate(c.from)}–${utcDate(c.to, { day: 'numeric' })}`
  if (data.period === '12m') return t('insights.compare.prior12m')
  return t('insights.compare.priorDays', { days: data.days })
}

/**
 * The change against the period before, as a count: "+6", "−3", "Same". The percentage follows only when
 * both periods have at least 20, because on small numbers it mostly shows noise (2 → 3 is "+50%").
 */
export function change(current: number, previous: number): string {
  const d = current - previous
  if (d === 0) return t('insights.change.same')
  const sign = d > 0 ? '+' : '−'
  const count = `${sign}${fmt().number(Math.abs(d))}`
  if (current < 20 || previous < 20) return count
  const percent = fmt().number(Math.abs(Math.round((d / previous) * 100)) / 100, { style: 'percent' })
  return `${count} (${sign}${percent})`
}

/** Which way of naming the period the sentences use, and its values. */
function periodWords(period: InsightsData['period'], days: number, from?: string, to?: string) {
  if (period === 'custom') {
    if (from && to && from === to) return { period: 'day', days, date: longDate(from) }
    if (from && to) return { period: 'range', days, from: shortDate(from), to: longDate(to) }
    return { period: 'some', days }
  }
  return { period: period === '7d' || period === '30d' ? 'days' : period, days }
}

/** "In the last 7 days Maya answered 34 calls, booked 9 appointments and caught 4 urgent calls after hours." */
export function summarySentence(
  assistant: string,
  data: Pick<InsightsData, 'period' | 'days'> & Partial<Pick<InsightsData, 'from' | 'to'>>,
  c: InsightCounts,
): string {
  const words = periodWords(data.period, data.days, data.from, data.to)
  if (c.calls === 0) return t('insights.summary.noCalls', words)
  const parts = [t('insights.summary.answered', { count: c.answered })]
  if (c.booked) parts.push(t('insights.summary.booked', { count: c.booked }))
  if (c.urgentAfterHours) parts.push(t('insights.summary.caughtAfterHours', { count: c.urgentAfterHours }))
  else if (c.urgent) parts.push(t('insights.summary.flagged', { count: c.urgent }))
  const when = t('insights.summary.when', words)
  return t('insights.summary.sentence', { when, assistant, actions: fmt().list(parts) })
}

// --- The chart -----------------------------------------------------------------------------------

export type Grouping = 'day' | 'week' | 'month'
/** By day up to a month, by week up to about six months, by month beyond. */
export const groupingFor = (days: number): Grouping => (days <= 31 ? 'day' : days <= 183 ? 'week' : 'month')

export type ChartMetric = 'answered' | 'booked' | 'messages' | 'missed'
export type Column = {
  key: string
  /** "Nov 11", "Week of Nov 10", "Nov 2026". */
  label: string
  /** The axis' short label: "Nov 11", "Nov 10", "Nov". */
  tick: string
  value: number
  /** Missed calls, stacked on answered (the answered chart only). */
  missed: number
  /** The week or month goes on after the period's last day: not over yet. */
  partial: boolean
}

/** Monday of the week `date` is in. */
const mondayOf = (date: string) => {
  const t = ms(date)
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10)
}
const lastOfMonth = (date: string) => {
  const d = new Date(ms(date))
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
}

/** The period's days folded into columns of the grouping, oldest first. */
export function columns(daily: InsightDay[], metric: ChartMetric, grouping: Grouping, today: string): Column[] {
  const out: Column[] = []
  const byKey = new Map<string, Column>()
  for (const d of daily) {
    let key = d.date
    let column: Column | undefined
    if (grouping === 'week') key = mondayOf(d.date)
    else if (grouping === 'month') key = d.date.slice(0, 7)
    column = byKey.get(key)
    if (!column) {
      const end =
        grouping === 'day'
          ? d.date
          : grouping === 'week'
            ? new Date(ms(key) + 6 * DAY_MS).toISOString().slice(0, 10)
            : lastOfMonth(d.date)
      column = {
        key,
        label:
          grouping === 'day'
            ? shortDate(d.date)
            : grouping === 'week'
              ? t('insights.chart.weekOf', { date: shortDate(key) })
              : utcDate(d.date, { month: 'short', year: 'numeric' }),
        tick: grouping === 'month' ? utcDate(d.date, { month: 'short' }) : shortDate(key),
        value: 0,
        missed: 0,
        partial: grouping !== 'day' && end > today,
      }
      byKey.set(key, column)
      out.push(column)
    }
    column.value += d[metric]
    if (metric === 'answered') column.missed += d.missed
  }
  return out
}

/** Which columns get an axis label: about five, always the last. */
export function tickEvery(count: number): number {
  return count <= 8 ? 1 : Math.ceil(count / 5)
}

// --- Busy times ----------------------------------------------------------------------------------

/** For each weekday (0 Sunday), the name the messages select on. */
const WEEKDAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** A day that is the given weekday (Jan 1, 2023 was a Sunday), at the given hour, in UTC. */
const sample = (weekday: number, hour = 0) => new Date(Date.UTC(2023, 0, 1 + weekday, hour))

/** "Tue", in the active language. */
export const weekdayShort = (weekday: number) => fmt().dateTime(sample(weekday), { weekday: 'short', timeZone: 'UTC' })

/** "Tuesdays": every one of that weekday. */
export const weekdays = (weekday: number) => t('insights.weekdays', { day: WEEKDAY_IDS[weekday] ?? 'sun' })

/** "9 AM", "12 PM" (or "9時", "9 Uhr"). */
export const hourLabel = (hour: number) => fmt().time(sample(0, hour), { hour: 'numeric', timeZone: 'UTC' })

/** "9 – 10 AM", "11 AM – 12 PM": the hour that starts at `hour`. */
const hourRange = (hour: number) =>
  new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', timeZone: 'UTC' }).formatRange(
    sample(0, hour),
    sample(0, hour + 1),
  )

/** "Tuesdays, 9 – 10 AM", or null when there were no calls. */
export function busiestTime(byWeekdayHour: number[][]): string | null {
  let w = -1
  let h = -1
  let top = 0
  for (let day = 0; day < byWeekdayHour.length; day++)
    for (let hour = 0; hour < 24; hour++) {
      const v = byWeekdayHour[day]?.[hour] ?? 0
      if (v > top) [w, h, top] = [day, hour, v]
    }
  if (top === 0) return null
  return t('insights.busiest.value', { days: weekdays(w), hours: hourRange(h) })
}

// --- Money ---------------------------------------------------------------------------------------

/**
 * Minor units (cents; whole units for JPY, KRW and CLP) as whole units in the appointment value's currency: "$1,250", "€350",
 * "£90", "CA$400", "A$400", "CHF 350", "¥5,000", "₹1,500", "SEK 900".
 */
export const formatMoney = (cents: number, currency: JobValueCurrency = 'USD') =>
  fmt().currency(Math.round(fromMinorUnits(cents, currency)), currency, { maximumFractionDigits: 0 })

/**
 * A currency in the menu: its code and symbol ("USD · $", "EUR · €", "CAD · CA$"), the symbol as formatMoney
 * writes it; just the code where the symbol is the code ("CHF").
 */
export function currencyLabel(currency: JobValueCurrency): string {
  const symbol = new Intl.NumberFormat(intlLocale(), { style: 'currency', currency })
    .formatToParts(0)
    .find(p => p.type === 'currency')?.value
  return symbol && symbol !== currency ? `${currency} · ${symbol}` : currency
}

/** The currencies most businesses pick, first in the menu in this order (like the phone countries, #736). */
export const COMMON_CURRENCIES = ['USD', 'CAD', 'GBP', 'AUD'] as const satisfies readonly JobValueCurrency[]

/** The top of the menu: the viewer's own currency (their country's, useViewerCurrency) first, then COMMON_CURRENCIES. */
export function topCurrencies(viewer?: JobValueCurrency | null): JobValueCurrency[] {
  return [...new Set<JobValueCurrency>([...(viewer ? [viewer] : []), ...COMMON_CURRENCIES])]
}

/**
 * The currencies offered next to the appointment value, in the order of the menu: topCurrencies, then under an
 * "All currencies" heading every other one by code (the top ones are not repeated). Every currency picker uses it.
 * A function: the symbols and the heading are in the active language.
 */
export function currencyOptions(viewer?: JobValueCurrency | null): SelectOption<JobValueCurrency>[] {
  const all = t('insights.currency.all')
  const top = topCurrencies(viewer)
  return [
    ...top.map(c => ({ value: c, label: currencyLabel(c) })),
    ...jobValueCurrencies
      .filter(c => !top.includes(c))
      .sort()
      .map(c => ({ value: c, label: currencyLabel(c), group: all })),
  ]
}

/**
 * What was typed → minor units of the currency: "380", "$1,250.50", "€90", "R$ 90" → cents; "¥5,000" → 5000 (JPY
 * has no decimals, so "5000.5" is not a value there); "" → null (clears it); anything else → undefined.
 */
export function parseMoney(text: string, currency: JobValueCurrency = 'USD'): number | null | undefined {
  if (text.trim() === '') return null
  // A symbol or code around the number ("$", "¥", "R$", "CHF", "kr") and thousands separators go.
  const cleaned = text.replace(/[\p{Sc},\s]/gu, '').replace(/^[a-z]{1,3}|[a-z]{1,3}$/gi, '')
  const digits = currencyDigits(currency)
  const number = digits === 0 ? /^\d+$/ : /^\d+(\.\d{1,2})?$/
  if (!number.test(cleaned)) return undefined
  return toMinorUnits(Number(cleaned), currency)
}

/** Minor units → the amount as it is typed in the field: 35050 USD → "350.5", 5000 JPY → "5000"; null → "". */
export const moneyText = (cents: number | null, currency: JobValueCurrency) =>
  cents === null ? '' : String(fromMinorUnits(cents, currency))

// --- Export --------------------------------------------------------------------------------------

/** The totals export: one row per day of the period. */
export function totalsTable(data: InsightsData): { header: string[]; rows: (string | number | null)[][] } {
  const hours = data.current.afterHours !== null
  const value = data.jobValueCents
  const header = [
    t('insights.export.column.date'),
    t('insights.export.column.calls'),
    t('insights.export.column.answered'),
    t('insights.export.column.missed'),
    t('insights.export.column.booked'),
    t('insights.export.column.messages'),
    t('insights.export.column.transferred'),
    t('insights.export.column.other'),
    t('insights.export.column.spam'),
    t('insights.export.column.urgent'),
    ...(hours ? [t('insights.export.column.afterHours')] : []),
    t('insights.export.column.minutes'),
    ...(value !== null
      ? [t('insights.export.column.bookedValue', { currency: data.jobValueCurrency ?? 'USD' })]
      : []),
  ]
  const rows = data.daily.map(d => [
    d.date,
    d.calls,
    d.answered,
    d.missed,
    d.booked,
    d.messages,
    d.transferred,
    d.other,
    d.spam,
    d.urgent,
    ...(hours ? [d.afterHours] : []),
    d.minutes,
    ...(value !== null ? [Math.round(fromMinorUnits(d.booked * value, data.jobValueCurrency ?? 'USD'))] : []),
  ])
  return { header, rows }
}

/** "linedesk-calls_2026-10-15_to_2026-11-13". */
export const exportName = (what: 'calls' | 'totals', data: Pick<InsightsData, 'from' | 'to'>) =>
  `linedesk-${what}_${data.from}_to_${data.to}`
