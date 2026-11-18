import { expect, test } from 'vitest'
import type { ProviderField, ProviderStatus } from './api.ts'
import {
  afterTest,
  changedValues,
  fieldErrors,
  initialValues,
  isConfigured,
  isPhone,
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
    { workspace_id: 'a', workspace_name: 'A', month: '2026-11', calls: 3, minutes: 12.5, charged_micros: 625_000 },
    { workspace_id: 'a', workspace_name: 'A', month: '2026-10', calls: 1, minutes: 2, charged_micros: null },
  ])
  expect(grid.get('a')?.get('2026-11')).toEqual({ calls: 3, minutes: 12.5, chargedMicros: 625_000 })
  expect(grid.get('a')?.get('2026-10')).toEqual({ calls: 1, minutes: 2, chargedMicros: null })
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

test('adding only an optional secret keeps the saved one: no error, only the new field is sent', () => {
  const resend = (apiKey: Partial<ProviderField>): ProviderStatus => ({
    provider: 'resend',
    label: 'Resend',
    category: 'email',
    fields: [
      field({ field: 'api_key', label: 'API key', ...apiKey }),
      field({ field: 'from', label: 'From', secret: false, source: 'app', value: 'desk@example.com' }),
      field({ field: 'domains_api_key', label: 'Domains API key (partners)' }),
    ],
  })
  const saved = resend({ source: 'app', last4: 'abcd' })
  const values = { ...initialValues(saved), domains_api_key: 're_full' }
  expect(fieldErrors(saved, values)).toEqual({})
  expect(changedValues(saved, values)).toEqual({ domains_api_key: 're_full' })
  // A key only on the server (.env) counts as set too; one set nowhere is still needed.
  expect(fieldErrors(resend({ source: 'env' }), values)).toEqual({})
  expect(fieldErrors(resend({}), values)).toEqual({ api_key: 'Required.' })
})

test('the spending cap field: empty is no cap, dollars with up to two decimals, nothing below zero or over the limit', () => {
  expect(parseSpendingCap('')).toEqual({ capUsd: null })
  expect(parseSpendingCap('  ')).toEqual({ capUsd: null })
  expect(parseSpendingCap('50')).toEqual({ capUsd: 50 })
  expect(parseSpendingCap('$1,250.5')).toEqual({ capUsd: 1250.5 })
  expect(parseSpendingCap('0')).toEqual({ capUsd: 0 })
  for (const bad of ['-5', 'ten', '1.999', '100001']) expect(parseSpendingCap(bad), bad).toHaveProperty('problem')
  expect(formatUsd(12.5)).toBe('$12.50')
  expect(parseSpendingCap('100001')).toEqual({ problem: 'The cap can be at most $100,000.00 a month.' })
  expect(parseSpendingCap('ten')).toEqual({
    problem: 'Enter an amount in dollars, like 50 or 49.99, or leave it empty for no cap.',
  })
})

test('the forwarding check number is a phone field: a typed number must be whole, a saved one stays', () => {
  const telnyx = (over: Partial<ProviderField>): ProviderStatus => ({
    provider: 'telnyx',
    label: 'Telnyx',
    category: 'telephony',
    fields: [field({ field: 'check_number', label: 'Forwarding check number', secret: false, ...over })],
  })
  const check = telnyx({})
  expect(isPhone(check, check.fields[0]!)).toBe(true)
  expect(isPhone(provider(sid({})), sid({}))).toBe(false)
  expect(fieldErrors(check, { check_number: '' })).toEqual({})
  expect(fieldErrors(check, { check_number: '+15035550142' })).toEqual({})
  expect(fieldErrors(check, { check_number: '+4930123456' })).toEqual({})
  expect(fieldErrors(check, { check_number: '+1503555' })).toEqual({
    check_number: "This number doesn't look complete for the United States.",
  })
  // Saved before as it was typed: not checked again until it is changed.
  const saved = telnyx({ source: 'app', value: '(503) 555-0142' })
  expect(fieldErrors(saved, { check_number: '(503) 555-0142' })).toEqual({})
})

test('after the key test: a pass closes the dialog with a toast, a failure or a warning keeps it open (LIN-364)', () => {
  const fresh = { stored: true, wasConfigured: false, restarts: false }
  expect(afterTest({ ok: true }, fresh)).toEqual({ close: true, toast: 'connectedToast' })
  expect(afterTest({ ok: true }, { ...fresh, restarts: true })).toEqual({ close: true, toast: 'connectedToastRestart' })
  expect(afterTest({ ok: true }, { stored: false, wasConfigured: true, restarts: true })).toEqual({
    close: true,
    toast: 'worksToast',
  })
  expect(afterTest({ ok: true }, { stored: true, wasConfigured: true, restarts: false })).toEqual({
    close: true,
    toast: 'connectedToast',
  })
  expect(afterTest({ ok: false }, fresh)).toEqual({ close: false })
  expect(afterTest({ ok: true, status: 'warning' }, fresh)).toEqual({ close: false })
})
