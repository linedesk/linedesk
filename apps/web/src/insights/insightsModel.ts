// What the Insights page says about the numbers: periods, the summary sentence, changes, the chart's
// grouping by day, week or month, the busiest time, and money.
import type { InsightCounts, InsightDay, InsightPeriod, InsightsData, JobValueCurrency } from '@linedesk/actions'
import { currencyDigits, fromMinorUnits, jobValueCurrencies, toMinorUnits } from '@linedesk/actions'

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export const PERIOD_LABELS: Record<InsightPeriod, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastMonth: 'Last month',
  '12m': 'Last 12 months',
  all: 'All time',
}

const DAY_MS = 86_400_000
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms(date)).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })

/** "Nov 11". */
export const shortDate = (date: string) => fmt(date, { month: 'short', day: 'numeric' })
/** "Nov 11, 2026". */
export const longDate = (date: string) => fmt(date, { month: 'short', day: 'numeric', year: 'numeric' })

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
  if (data.period === 'lastMonth') return fmt(c.from, { month: 'long' })
  if (data.period === 'month')
    return c.from === c.to ? shortDate(c.from) : `${shortDate(c.from)}–${fmt(c.to, { day: 'numeric' })}`
  if (data.period === '12m') return 'prior 12 months'
  return `prior ${data.days} days`
}

/**
 * The change against the period before, as a count: "+6", "−3", "Same". The percentage follows only when
 * both periods have at least 20, because on small numbers it mostly shows noise (2 → 3 is "+50%").
 */
export function change(current: number, previous: number): string {
  const d = current - previous
  if (d === 0) return 'Same'
  const count = `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')}`
  if (current < 20 || previous < 20) return count
  return `${count} (${d > 0 ? '+' : '−'}${Math.abs(Math.round((d / previous) * 100))}%)`
}

const listOf = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/** How the sentence starts for the period: "In the last 30 days", "This month", "Since your first call". */
function opening(period: InsightsData['period'], days: number, from?: string, to?: string): string {
  switch (period) {
    case 'custom':
      return from && to
        ? from === to
          ? `On ${longDate(from)}`
          : `From ${shortDate(from)} to ${longDate(to)}`
        : `In these ${days} days`
    case 'month':
      return 'This month'
    case 'lastMonth':
      return 'Last month'
    case '12m':
      return 'In the last 12 months'
    case 'all':
      return 'Since your first call'
    default:
      return `In the last ${days} days`
  }
}

/** "In the last 7 days Maya answered 34 calls, booked 9 appointments and caught 4 urgent calls after hours." */
export function summarySentence(
  assistant: string,
  data: Pick<InsightsData, 'period' | 'days'> & Partial<Pick<InsightsData, 'from' | 'to'>>,
  c: InsightCounts,
): string {
  const when = opening(data.period, data.days, data.from, data.to)
  if (c.calls === 0)
    return data.period === 'all' ? 'No calls yet.' : `No calls ${when[0]!.toLowerCase()}${when.slice(1)}.`
  const parts = [`answered ${plural(c.answered, 'call')}`]
  if (c.booked) parts.push(`booked ${plural(c.booked, 'appointment')}`)
  if (c.urgentAfterHours) parts.push(`caught ${plural(c.urgentAfterHours, 'urgent call')} after hours`)
  else if (c.urgent) parts.push(`flagged ${plural(c.urgent, 'urgent call')}`)
  return `${when} ${assistant} ${listOf(parts)}.`
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
              ? `Week of ${shortDate(key)}`
              : fmt(d.date, { month: 'short', year: 'numeric' }),
        tick: grouping === 'month' ? fmt(d.date, { month: 'short' }) : shortDate(key),
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

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** "9 am", "12 pm". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h} ${hour % 24 < 12 ? 'am' : 'pm'}`
}

/** "Tuesdays, 9–10 am", or null when there were no calls. */
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
  const start = hourLabel(h)
  const end = hourLabel(h + 1)
  const sameHalf = start.slice(-2) === end.slice(-2)
  return `${WEEKDAYS[w]}s, ${sameHalf ? start.slice(0, -3) : start}–${end}`
}

// --- Money ---------------------------------------------------------------------------------------

/**
 * Minor units (cents; whole yen for JPY) as whole units in the appointment value's currency: "$1,250", "€350",
 * "£90", "CA$400", "A$400", "CHF 350", "¥5,000", "₹1,500", "SEK 900".
 */
export const formatMoney = (cents: number, currency: JobValueCurrency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    Math.round(fromMinorUnits(cents, currency)),
  )

/**
 * A currency in the menu: its code and symbol ("USD · $", "EUR · €", "CAD · CA$"), the symbol as formatMoney
 * writes it; just the code where the symbol is the code ("CHF").
 */
export function currencyLabel(currency: JobValueCurrency): string {
  const symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .formatToParts(0)
    .find(p => p.type === 'currency')?.value
  return symbol && symbol !== currency ? `${currency} · ${symbol}` : currency
}

/** The currencies offered next to the appointment value, in the order of the menu. */
export const CURRENCY_OPTIONS = jobValueCurrencies.map(c => ({ value: c, label: currencyLabel(c) }))

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
    'Date',
    'Calls',
    'Answered',
    'Missed',
    'Booked',
    'Messages',
    'Transferred',
    'Other answered',
    'Spam',
    'Urgent',
    ...(hours ? ['After hours'] : []),
    'Minutes',
    ...(value !== null ? [`Booked value (${data.jobValueCurrency ?? 'USD'})`] : []),
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
