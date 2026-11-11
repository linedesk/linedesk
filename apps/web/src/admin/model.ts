// Pure helpers of the admin page: sorting, the usage grid, and the words for a provider's status.
import { providers as providerSpecs, type ProviderTestData } from '@linedesk/actions'
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

/** US dollars with cents: 12.5 → "$12.50". */
export const formatUsd = (value: number) => `$${value.toFixed(2)}`

/** The highest monthly spending cap the API takes (SPENDING_CAP_MAX_USD in packages/actions). */
const SPENDING_CAP_MAX_USD = 100_000

/** The spending cap field: empty is no cap; else dollars, like "50" or "$49.99". */
export function parseSpendingCap(text: string): { capUsd: number | null } | { problem: string } {
  const value = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!value) return { capUsd: null }
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return { problem: 'Enter an amount in dollars, like 50 or 49.99, or leave it empty for no cap.' }
  const capUsd = Number(value)
  if (capUsd > SPENDING_CAP_MAX_USD) return { problem: `The cap can be at most ${formatUsd(SPENDING_CAP_MAX_USD)} a month.` }
  return { capUsd }
}

export type ProviderState = 'app' | 'env' | 'none'
/** A provider counts as set in the app as soon as one of its fields is stored there. */
export function providerState(provider: ProviderStatus): ProviderState {
  if (provider.fields.some(f => f.source === 'app')) return 'app'
  return provider.fields.some(f => f.source === 'env') ? 'env' : 'none'
}

type FieldSpec = { optional?: true; switch?: true }
const fieldSpecOf = (provider: ProviderStatus, field: string): FieldSpec | undefined =>
  (providerSpecs[provider.provider].fields as Record<string, FieldSpec>)[field]
export const isOptional = (provider: ProviderStatus, field: ProviderField) =>
  !!fieldSpecOf(provider, field.field)?.optional
export const isSwitch = (provider: ProviderStatus, field: ProviderField) => !!fieldSpecOf(provider, field.field)?.switch

/** Every field a connection needs has a value, here or on the server. A provider without fields needs none. */
export const isConfigured = (provider: ProviderStatus) =>
  provider.fields.every(f => f.source !== null || isOptional(provider, f))

export type Connection = 'none' | 'checking' | 'connected' | 'error'
export type TestState = ProviderTestData | 'running' | undefined

/** What the row's badge says: set up and tested ok, set up and failing, still checking, or not set up. */
export function connectionOf(provider: ProviderStatus, test: TestState): Connection {
  if (!isConfigured(provider)) return 'none'
  if (test === undefined || test === 'running') return 'checking'
  return test.ok ? 'connected' : 'error'
}

/** The form's start: non-secret values as stored, secrets always empty (they never come back). */
export const initialValues = (provider: ProviderStatus): Record<string, string> =>
  Object.fromEntries(provider.fields.map(f => [f.field, f.secret ? '' : (f.value ?? '')]))

/** What Save sends: the fields that were typed or changed. Empty means "keep": a key cannot be half cleared. */
export function changedValues(provider: ProviderStatus, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    provider.fields
      .map(f => [f.field, (values[f.field] ?? '').trim(), f] as const)
      .filter(([, value, f]) => value && (f.secret || value !== (f.value ?? '')))
      .map(([name, value]) => [name, value]),
  )
}

/** Per field, why Save cannot go ahead: a needed value is missing, or a stored one was emptied. */
export function fieldErrors(provider: ProviderStatus, values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of provider.fields) {
    const typed = (values[f.field] ?? '').trim()
    if (typed) continue
    if (f.source === 'app' && !f.secret && f.value) errors[f.field] = 'Cannot be empty. Disconnect clears every key.'
    else if (!f.source && !isOptional(provider, f)) errors[f.field] = 'Required.'
  }
  return errors
}
