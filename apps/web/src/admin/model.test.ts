import { expect, test } from 'vitest'
import type { ProviderField, ProviderStatus } from './api.ts'
import {
  fieldValueText,
  shortValue,
  formatMinutes,
  monthLabel,
  nextSort,
  providerState,
  recentMonths,
  sortRows,
  usageByWorkspace,
} from './model.ts'

test('sorting: text without case, numbers by value, empty values last either way', () => {
  const rows = [
    { n: 'beta', v: 2 },
    { n: 'Alpha', v: null },
    { n: 'gamma', v: 10 },
  ]
  expect(sortRows(rows, r => r.n, 'asc').map(r => r.n)).toEqual(['Alpha', 'beta', 'gamma'])
  expect(sortRows(rows, r => r.v, 'asc').map(r => r.v)).toEqual([2, 10, null])
  expect(sortRows(rows, r => r.v, 'desc').map(r => r.v)).toEqual([10, 2, null])
  expect(rows[0]!.n).toBe('beta') // the input is not changed
})

test('clicking the sorted column flips it, another column starts in its own direction', () => {
  expect(nextSort({ key: 'name', dir: 'asc' }, 'name', 'asc')).toEqual({ key: 'name', dir: 'desc' })
  expect(nextSort({ key: 'name', dir: 'desc' }, 'calls', 'desc')).toEqual({ key: 'calls', dir: 'desc' })
})

test('the usage grid covers the last months in UTC, across a year boundary', () => {
  expect(recentMonths(3, new Date('2027-01-15T12:00:00Z'))).toEqual(['2027-01', '2026-12', '2026-11'])
  expect(recentMonths(1, new Date('2026-03-31T23:30:00Z'))).toEqual(['2026-03'])
  expect(monthLabel('2026-11')).toBe('Nov 2026')
  const grid = usageByWorkspace([
    { workspace_id: 'a', workspace_name: 'A', month: '2026-11', calls: 3, minutes: 12.5 },
    { workspace_id: 'a', workspace_name: 'A', month: '2026-10', calls: 1, minutes: 2 },
  ])
  expect(grid.get('a')?.get('2026-11')).toEqual({ calls: 3, minutes: 12.5 })
  expect(grid.get('b')).toBeUndefined()
  expect(formatMinutes(12.5)).toBe('12.5 min')
  expect(formatMinutes(1234)).toBe('1,234 min')
  expect(formatMinutes(0)).toBe('–')
})

const field = (over: Partial<ProviderField>): ProviderField => ({
  field: 'api_key',
  label: 'API key',
  secret: true,
  hint: null,
  source: null,
  last4: null,
  value: null,
  updated_at: null,
  updated_by: null,
  ...over,
})
const provider = (...fields: ProviderField[]): ProviderStatus => ({
  provider: 'twilio',
  label: 'Twilio',
  category: 'telephony',
  fields,
})

test('a provider is set in the app as soon as one field is stored there', () => {
  expect(providerState(provider(field({})))).toBe('none')
  expect(providerState(provider(field({ source: 'env' }), field({})))).toBe('env')
  expect(providerState(provider(field({ source: 'env' }), field({ source: 'app' })))).toBe('app')
})

test('a secret shows at most its last four characters', () => {
  expect(fieldValueText(field({}))).toBe('Not set')
  expect(fieldValueText(field({ source: 'app', last4: 't3lx' }))).toBe('••••t3lx')
  expect(fieldValueText(field({ source: 'app' }))).toBe('••••')
  expect(fieldValueText(field({ source: 'env' }))).toBe('Set')
  expect(fieldValueText(field({ secret: false, source: 'env', value: 'ws://localhost:7880' }))).toBe(
    'ws://localhost:7880',
  )
})

test('long values are cut in the middle, short ones stay whole', () => {
  expect(shortValue('openai/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini')
  const key = 'MCowBQYDK2VwAyEAbcdefghijklmnopqrstuvwxyz0123456789='
  expect(shortValue(key)).toBe('MCowBQYDK2VwAy…3456789=')
})
