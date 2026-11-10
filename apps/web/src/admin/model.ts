// Pure helpers of the admin page: sorting, the usage grid, and the words for a provider's status.
import type { ProviderField, ProviderStatus, UsageRow } from './api.ts'

export type SortDir = 'asc' | 'desc'
export type Sort<K extends string> = { key: K; dir: SortDir }
type Value = string | number | null

/** Sorted copy. Text compares without case; empty values go last in either direction. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => Value, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)]
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return String(x).localeCompare(String(y), 'en', { sensitivity: 'base' }) * sign
  })
}

/** Clicking the sorted column flips it; a new column starts in its natural direction. */
export const nextSort = <K extends string>(current: Sort<K>, key: K, first: SortDir): Sort<K> =>
  current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first }

/** The last `count` calendar months in UTC as `YYYY-MM`, newest first. */
export function recentMonths(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7),
  )
}

export const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })

export type UsageCell = { calls: number; minutes: number }
/** Usage per workspace: month → cell. */
export function usageByWorkspace(usage: readonly UsageRow[]): Map<string, Map<string, UsageCell>> {
  const grid = new Map<string, Map<string, UsageCell>>()
  for (const { workspace_id, month, calls, minutes } of usage) {
    if (!grid.has(workspace_id)) grid.set(workspace_id, new Map())
    grid.get(workspace_id)!.set(month, { calls, minutes })
  }
  return grid
}

/** Answered minutes; a month with calls but under a tenth of a minute says so instead of a dash. */
export const formatMinutes = (minutes: number) =>
  minutes >= 0.1
    ? `${minutes.toLocaleString('en-US', { maximumFractionDigits: 1 })} min`
    : minutes > 0
      ? '<0.1 min'
      : '0 min'

export type ProviderState = 'app' | 'env' | 'none'
/** A provider counts as set in the app as soon as one of its fields is stored there. */
export function providerState(provider: ProviderStatus): ProviderState {
  if (provider.fields.some(f => f.source === 'app')) return 'app'
  return provider.fields.some(f => f.source === 'env') ? 'env' : 'none'
}
export const stateLabel: Record<ProviderState, string> = { app: 'Set in app', env: 'From environment', none: 'Not set' }

/** What the page shows for one field. A secret is only ever its last four characters. */
export function fieldValueText(field: ProviderField): string {
  if (!field.source) return 'Not set'
  if (!field.secret) return field.value ?? 'Set'
  if (field.source === 'env') return 'Set'
  return field.last4 ? `••••${field.last4}` : '••••'
}

/** Longer values (a webhook public key) are cut in the middle so a row stays one line; Copy has the whole value. */
export const SHORT_VALUE_MAX = 32
export const shortValue = (value: string) =>
  value.length > SHORT_VALUE_MAX ? `${value.slice(0, 14)}…${value.slice(-8)}` : value
