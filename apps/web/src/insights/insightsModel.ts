// What the Insights page says about the numbers: the summary sentence, trends and money.
import type { InsightCounts, InsightRange } from '@linedesk/actions'

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export const rangeLabel = (days: InsightRange) => `the last ${days} days`

/** "Up 12%", "Down 5%", "Same", or null when there is nothing to compare with. */
export function trend(current: number, previous: number): string | null {
  if (previous === 0) return current === 0 ? null : 'New'
  const change = Math.round(((current - previous) / previous) * 100)
  if (change === 0) return 'Same'
  return change > 0 ? `Up ${change}%` : `Down ${-change}%`
}

const listOf = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/** "In the last 7 days Maya answered 34 calls, booked 9 jobs and caught 4 urgent calls after hours." */
export function summarySentence(assistant: string, days: InsightRange, c: InsightCounts): string {
  const when = `In ${rangeLabel(days)}`
  if (c.calls === 0) return `No calls in ${rangeLabel(days)}.`
  const parts = [`answered ${plural(c.answered, 'call')}`]
  if (c.booked) parts.push(`booked ${plural(c.booked, 'job')}`)
  if (c.urgentAfterHours) parts.push(`caught ${plural(c.urgentAfterHours, 'urgent call')} after hours`)
  else if (c.urgent) parts.push(`flagged ${plural(c.urgent, 'urgent call')}`)
  return `${when} ${assistant} ${listOf(parts)}.`
}

export const formatMoney = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`

/** "380", "$1,250.50" → cents; "" → null (clears it); anything else → undefined (not a value). */
export function parseMoney(text: string): number | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, '')
  if (cleaned === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  return Math.round(Number(cleaned) * 100)
}

/** "9 am", "12 pm". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h} ${hour < 12 ? 'am' : 'pm'}`
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** The index of the largest value, or null when all are zero. */
export function peakIndex(values: number[]): number | null {
  let best: number | null = null
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > (values[best] ?? 0))) best = i
  })
  return best
}

/** "Nov 11". */
export const shortDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
