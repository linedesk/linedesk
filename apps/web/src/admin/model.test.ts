import { expect, test } from 'vitest'
import type { ProviderField, ProviderStatus } from './api.ts'
import {
  changedValues,
  fieldErrors,
  initialValues,
  isConfigured,
  formatMinutes,
  formatUsd,
  parseSpendingCap,
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
  expect(formatMinutes(0)).toBe('0 min')
  expect(formatMinutes(0.04)).toBe('<0.1 min')
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

const sid = (over: Partial<ProviderField>) =>
  field({ field: 'account_sid', label: 'Account SID', secret: false, ...over })
const token = (over: Partial<ProviderField>) => field({ field: 'auth_token', label: 'Auth token', ...over })

test('a provider is set up once every needed field has a value, here or on the server', () => {
  expect(isConfigured(provider(sid({ source: 'env', value: 'AC1' }), token({})))).toBe(false)
  expect(isConfigured(provider(sid({ source: 'env', value: 'AC1' }), token({ source: 'app', last4: 'abcd' })))).toBe(
    true,
  )
  expect(isConfigured({ provider: 'file', label: 'Local disk', category: 'recording', fields: [] })).toBe(true)
})

test('Save sends only typed or changed values, never an emptied one', () => {
  const p = provider(sid({ source: 'app', value: 'AC1' }), token({ source: 'app', last4: 'abcd' }))
  expect(initialValues(p)).toEqual({ account_sid: 'AC1', auth_token: '' })
  expect(changedValues(p, { account_sid: 'AC1', auth_token: '' })).toEqual({})
  expect(changedValues(p, { account_sid: ' AC2 ', auth_token: 'new' })).toEqual({
    account_sid: 'AC2',
    auth_token: 'new',
  })
})

test('a needed field without a value, or an emptied stored one, stops Save', () => {
  const empty = provider(sid({}), token({}))
  expect(fieldErrors(empty, { account_sid: 'AC1', auth_token: '' })).toEqual({ auth_token: 'Required.' })
  const stored = provider(sid({ source: 'app', value: 'AC1' }), token({ source: 'app' }))
  expect(fieldErrors(stored, { account_sid: '', auth_token: '' })).toEqual({
    account_sid: 'Cannot be empty. Disconnect clears every key.',
  })
})

test('the spending cap field: empty is no cap, dollars with up to two decimals, nothing below zero or over the limit', () => {
  expect(parseSpendingCap('')).toEqual({ capUsd: null })
  expect(parseSpendingCap('  ')).toEqual({ capUsd: null })
  expect(parseSpendingCap('50')).toEqual({ capUsd: 50 })
  expect(parseSpendingCap('$1,250.5')).toEqual({ capUsd: 1250.5 })
  expect(parseSpendingCap('0')).toEqual({ capUsd: 0 })
  for (const bad of ['-5', 'ten', '1.999', '100001']) expect(parseSpendingCap(bad), bad).toHaveProperty('problem')
  expect(formatUsd(12.5)).toBe('$12.50')
})
