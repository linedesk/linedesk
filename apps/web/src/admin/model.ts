// Pure helpers of the admin page: sorting, the usage grid, and a provider's keys (the status: providerStatus.ts).
import { phoneNumberProblem, providers as providerSpecs } from '@linedesk/actions'
import type { ProviderField, ProviderStatus, UsageRow } from './api.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

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
  fmt().dateTime(new Date(`${month}-01T00:00:00Z`), { month: 'short', year: 'numeric', timeZone: 'UTC' })

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
export function formatMinutes(minutes: number) {
  const inMinutes = (value: number) =>
    fmt().number(value, { style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 1 })
  return minutes >= 0.1 ? inMinutes(minutes) : minutes > 0 ? `<${inMinutes(0.1)}` : inMinutes(0)
}

/** US dollars with cents, in the active language's number format: 12.5 → "$12.50". */
export const formatUsd = (value: number) =>
  fmt().currency(value, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** The highest monthly spending cap the API takes (SPENDING_CAP_MAX_USD in packages/actions). */
const SPENDING_CAP_MAX_USD = 100_000

/** The spending cap field: empty is no cap; else dollars, like "50" or "$49.99". */
export function parseSpendingCap(text: string): { capUsd: number | null } | { problem: string } {
  const value = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!value) return { capUsd: null }
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return { problem: i18n().t('admin.model.spendingCap.invalid') }
  const capUsd = Number(value)
  if (capUsd > SPENDING_CAP_MAX_USD)
    return { problem: i18n().t('admin.model.spendingCap.max', { amount: formatUsd(SPENDING_CAP_MAX_USD) }) }
  return { capUsd }
}

export type ProviderState = 'app' | 'env' | 'none'
/** A provider counts as set in the app as soon as one of its fields is stored there. */
export function providerState(provider: ProviderStatus): ProviderState {
  if (provider.fields.some(f => f.source === 'app')) return 'app'
  return provider.fields.some(f => f.source === 'env') ? 'env' : 'none'
}

type FieldSpec = { optional?: true; switch?: true; phone?: true }
const fieldSpecOf = (provider: ProviderStatus, field: string): FieldSpec | undefined =>
  (providerSpecs[provider.provider].fields as Record<string, FieldSpec>)[field]
export const isOptional = (provider: ProviderStatus, field: ProviderField) =>
  !!fieldSpecOf(provider, field.field)?.optional
export const isSwitch = (provider: ProviderStatus, field: ProviderField) => !!fieldSpecOf(provider, field.field)?.switch
/** A phone number field (the carriers' forwarding check number): the phone field, its value in E.164. */
export const isPhone = (provider: ProviderStatus, field: ProviderField) => !!fieldSpecOf(provider, field.field)?.phone

/** Every field a connection needs has a value, here or on the server. A provider without fields needs none. */
export const isConfigured = (provider: ProviderStatus) =>
  provider.fields.every(f => f.source !== null || isOptional(provider, f))

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
    if (typed) {
      // A number typed here must be a whole one; a value saved before as it was typed stays as it is.
      const problem = isPhone(provider, f) && typed !== (f.value ?? '') ? phoneNumberProblem(typed) : null
      if (problem) errors[f.field] = problem
      continue
    }
    if (f.source === 'app' && !f.secret && f.value) errors[f.field] = i18n().t('admin.model.field.emptied')
    else if (!f.source && !isOptional(provider, f)) errors[f.field] = i18n().t('admin.model.field.required')
  }
  return errors
}
