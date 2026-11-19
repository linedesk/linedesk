// Server admin › Billing: dollars typed by the admin, the reason rule and the rules editor's form.
import { expect, test } from 'vitest'
import type { AdminBillRow } from '@linedesk/actions'
import { BILLING_DEFAULTS, SIGNUP_DEFAULTS } from '@linedesk/db/types'
import {
  ago,
  billFilterOfHash,
  billsHref,
  customFields,
  domainList,
  eventFilterOfHash,
  eventsHref,
  RULE_GROUPS,
  ruleUnit,
  SIGNUP_COUNT_FIELDS,
  SIGNUP_GROUPS,
  filterBills,
  parseCount,
  parseDollars,
  planFloorText,
  RULE_FIELDS,
  reasonProblem,
  rulesForm,
  rulesFromForm,
  signupDirty,
  signupForm,
  signupFromForm,
} from './billingModel.ts'

/** Every field at its default: sent as null, so the server resets it (it merges over the stored rules). */
const RESETS = {
  ...Object.fromEntries(RULE_FIELDS.map(([field]) => [field, null])),
  automaticTax: null,
  regulatedNumberFeeWaived: null,
  levels: Object.fromEntries(Object.keys(BILLING_DEFAULTS.levels).map(name => [name, null])),
}

test('dollars become whole cents; a typo, zero or a negative where none is allowed is refused', () => {
  expect(parseDollars('20')).toEqual({ cents: 2000 })
  expect(parseDollars(' $1,250.5 ')).toEqual({ cents: 125050 })
  expect(parseDollars('0.07')).toEqual({ cents: 7 })
  expect(parseDollars('-3', { negative: true })).toEqual({ cents: -300 })
  expect(parseDollars('-$3', { negative: true })).toEqual({ cents: -300 })
  expect(parseDollars('0', { zero: true })).toEqual({ cents: 0 })
  expect(parseDollars('-3')).toHaveProperty('problem')
  expect(parseDollars('0')).toHaveProperty('problem')
  expect(parseDollars('1.234')).toHaveProperty('problem')
  expect(parseDollars('abc')).toHaveProperty('problem')
  expect(parseDollars('')).toHaveProperty('problem')
  expect(parseDollars('100000.01')).toHaveProperty('problem')
  expect(parseDollars('100000')).toEqual({ cents: 10_000_000 })
})

test('a count is a whole number in range; empty only where it means "the rules"', () => {
  expect(parseCount('5', 1, 1000)).toEqual({ value: 5 })
  expect(parseCount('', 1, 1000, { empty: true })).toEqual({ value: null })
  expect(parseCount('', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('0', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('2.5', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('1001', 1, 1000)).toHaveProperty('problem')
})

test('a reason is 3 to 500 characters once trimmed', () => {
  expect(reasonProblem('  ab ')).not.toBeNull()
  expect(reasonProblem('Goodwill for an outage')).toBeNull()
  expect(reasonProblem('x'.repeat(501))).not.toBeNull()
})

test('the rules form round-trips the defaults to every field reset, nothing stored', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form['levels.standard.price']).toBe('0.05')
  expect(form['levels.ultra.factor']).toBe('')
  expect(form.balanceBufferMicros).toBe('5')
  expect(form.extraNumberCents).toBe('3')
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({ rules: RESETS, problems: [] })
})

test('the Stripe Tax switch: on by default; off is stored as false, back at the default it is reset (LIN-459)', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form.automaticTax).toBe('on')
  expect(rulesFromForm({ ...form, automaticTax: 'off' }, BILLING_DEFAULTS)).toEqual({
    rules: { ...RESETS, automaticTax: false },
    problems: [],
  })
  expect(rulesForm({ ...BILLING_DEFAULTS, automaticTax: false }).automaticTax).toBe('off')
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({ rules: RESETS, problems: [] })
})

test('the free numbers with documents switch: off by default; on is stored as true, back at the default it is reset', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form.regulatedNumberFeeWaived).toBe('off')
  expect(rulesFromForm({ ...form, regulatedNumberFeeWaived: 'on' }, BILLING_DEFAULTS)).toEqual({
    rules: { ...RESETS, regulatedNumberFeeWaived: true },
    problems: [],
  })
  expect(rulesForm({ ...BILLING_DEFAULTS, regulatedNumberFeeWaived: true }).regulatedNumberFeeWaived).toBe('on')
})

test('only what differs from the defaults is stored (the rest reset), in the units the server takes; a changed level whole', () => {
  const form = {
    ...rulesForm(BILLING_DEFAULTS),
    'levels.premium.price': '0.12',
    concurrentCallsPerWorkspace: '10',
    balanceBufferMicros: '2.5',
    extraNumberCents: '4.50',
    extraCallCents: '1.50',
  }
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({
    rules: {
      ...RESETS,
      concurrentCallsPerWorkspace: 10,
      balanceBufferMicros: 2_500_000,
      extraNumberCents: 450,
      extraCallCents: 150,
      levels: { ...RESETS.levels, premium: { microsPerMinute: 120_000, allowanceFactor: 2 } },
    },
    problems: [],
  })
})

test('a field that is not a number in its unit is named, and nothing is sent', () => {
  const form = { ...rulesForm(BILLING_DEFAULTS), concurrentCallsPerWorkspace: '2.5', 'levels.standard.price': 'cheap' }
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({
    problems: ['concurrentCallsPerWorkspace', 'levels.standard.price'],
  })
})

test('the plan prices and the trial are dollars and days in the form, cents and days stored (docs/billing.md §7b)', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form.workspaceMonthlyCents).toBe('11')
  expect(form.workspaceYearlyCents).toBe('108')
  expect(form.trialDays).toBe('14')
  expect(
    rulesFromForm(
      { ...form, workspaceMonthlyCents: '9', partnerYearlyCents: '150.50', trialDays: '7' },
      BILLING_DEFAULTS,
    ),
  ).toEqual({
    rules: { ...RESETS, workspaceMonthlyCents: 900, partnerYearlyCents: 15_050, trialDays: 7 },
    problems: [],
  })
  expect(rulesFromForm({ ...form, trialDays: '1.5', workspaceYearlyCents: 'free' }, BILLING_DEFAULTS)).toEqual({
    problems: ['workspaceYearlyCents', 'trialDays'],
  })
})

test('the plan fees show the server floor: a month, and 12 of it a year (security review of #1040, L-6)', () => {
  expect(planFloorText('workspaceMonthlyCents', 250)).toBe('At least $2.50 on this server')
  expect(planFloorText('partnerYearlyCents', 250)).toBe('At least $30.00 on this server, and at most 12 monthly fees')
  expect(planFloorText('trialDays', 250)).toBeUndefined()
})

test('included minutes and the longest transfer are typed in minutes and stored in seconds', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form.includedStandardSeconds).toBe('50')
  expect(form.billedTransferCapSeconds).toBe('10')
  const parsed = rulesFromForm(
    { ...form, includedStandardSeconds: '60', billedTransferCapSeconds: '7.5' },
    BILLING_DEFAULTS,
  )
  expect(parsed).toMatchObject({ rules: { includedStandardSeconds: 3600, billedTransferCapSeconds: 450 } })
  // A fraction of a second is not a whole number of seconds.
  expect(rulesFromForm({ ...form, includedStandardSeconds: '0.001' }, BILLING_DEFAULTS).problems).toEqual([
    'includedStandardSeconds',
  ])
})

const row = (over: Partial<AdminBillRow>): AdminBillRow => ({
  id: 'b',
  kind: 'cloud',
  status: 'active',
  interval: 'month',
  owner: { id: 'u', email: null, name: null },
  workspaces: [],
  balanceMicros: 0,
  reservedMicros: 0,
  heldForReviewAt: null,
  cardRiskLevel: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
})

test('the bills list filters by status, or by a hold for review', () => {
  const bills = [
    row({ id: 'a', status: 'trialing' }),
    row({ id: 'b', status: 'active', heldForReviewAt: '2026-11-02T00:00:00.000Z' }),
    row({ id: 'c', status: 'past_due' }),
  ]
  expect(filterBills(bills, 'all').map(b => b.id)).toEqual(['a', 'b', 'c'])
  expect(filterBills(bills, 'trialing').map(b => b.id)).toEqual(['a'])
  expect(filterBills(bills, 'held').map(b => b.id)).toEqual(['b'])
  expect(filterBills(bills, 'canceled')).toEqual([])
})

test('the sign-up limits: defaults go back as null, changes as values, numbers out of range are problems', () => {
  const form = signupForm(SIGNUP_DEFAULTS)
  expect(signupDirty(form, form)).toBe(false)
  expect(signupFromForm(form, SIGNUP_DEFAULTS)).toEqual({
    rules: {
      codesPerAddressHour: null,
      codesPerAddressDay: null,
      signupsPerIpHour: null,
      signupsPerIpDay: null,
      codesPerInstallHour: null,
      pendingDays: null,
      trialWorkspacesCloud: null,
      trialNumbersPerWorkspace: null,
      turnstile: null,
      blockedDomains: null,
      reviewRiskLevels: null,
    },
    problems: [],
  })
  const changed = {
    ...form,
    counts: { ...form.counts, pendingDays: '3' },
    turnstile: false,
    blockedDomains: 'Spam.Example\nspam.example, other.example ',
    reviewRiskLevels: ['highest'],
  }
  expect(signupDirty(changed, form)).toBe(true)
  expect(signupFromForm(changed, SIGNUP_DEFAULTS)).toMatchObject({
    rules: {
      pendingDays: 3,
      turnstile: false,
      blockedDomains: ['spam.example', 'other.example'],
      reviewRiskLevels: ['highest'],
    },
  })
  const bad = { ...form, counts: { ...form.counts, pendingDays: '91', codesPerAddressHour: '1.5' } }
  expect(signupFromForm(bad, SIGNUP_DEFAULTS).problems).toEqual(['codesPerAddressHour', 'pendingDays'])
  // The order of the risk levels is no change.
  expect(signupDirty({ ...form, reviewRiskLevels: ['highest', 'elevated'] }, form)).toBe(false)
  expect(domainList(' a.example ,, b.example\n')).toEqual(['a.example', 'b.example'])
})

test('the rules and sign-up groups hold every field exactly once', () => {
  const ruleFields = RULE_GROUPS.flatMap(g => g.fields as readonly string[])
  expect(ruleFields.toSorted()).toEqual(RULE_FIELDS.map(([field]) => field).toSorted())
  const signupFields = SIGNUP_GROUPS.flatMap(g => g.fields as readonly string[])
  expect(signupFields.toSorted()).toEqual([...SIGNUP_COUNT_FIELDS].toSorted())
})

test('units go inside the field: dollars, dollars per minute for a level price, none for a factor', () => {
  expect(ruleUnit('workspaceMonthlyCents')).toBe('usd')
  expect(ruleUnit('trialDays')).toBe('days')
  expect(ruleUnit('levels.premium.price')).toBe('usdPerMinute')
  expect(ruleUnit('levels.premium.factor')).toBe('times')
})

test('an empty field takes the default, in the rules and in the sign-up limits', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  // A level's factor keeps its own meaning: empty is none, so it is left as it is.
  const kept = (key: string) => key === 'automaticTax' || key === 'regulatedNumberFeeWaived' || key.endsWith('.factor')
  const emptied = Object.fromEntries(Object.keys(form).map(key => [key, kept(key) ? form[key]! : '']))
  expect(rulesFromForm(emptied, BILLING_DEFAULTS)).toEqual({ rules: RESETS, problems: [] })
  const signup = signupForm(SIGNUP_DEFAULTS)
  const empty = { ...signup, counts: Object.fromEntries(SIGNUP_COUNT_FIELDS.map(f => [f, ''])) as typeof signup.counts }
  const parsed = signupFromForm(empty, SIGNUP_DEFAULTS)
  expect(parsed.problems).toEqual([])
  for (const field of SIGNUP_COUNT_FIELDS) expect('rules' in parsed && parsed.rules[field]).toBeNull()
})

test("the install's own values are the filled fields that differ from the default", () => {
  const defaults = rulesForm(BILLING_DEFAULTS)
  const form = {
    ...defaults,
    trialDays: '21',
    workspaceMonthlyCents: '',
    automaticTax: 'on',
    regulatedNumberFeeWaived: 'off',
  }
  expect(customFields(form, defaults)).toEqual(['trialDays'])
  // An emptied factor is a value of its own (the level uses none of the included minutes).
  expect(customFields({ ...defaults, 'levels.standard.factor': '' }, defaults)).toEqual(['levels.standard.factor'])
})

test('filters live in the address, so a link or a reload keeps them', () => {
  expect(billFilterOfHash('#admin/billing/bills?status=past_due')).toBe('past_due')
  expect(billFilterOfHash('#admin/billing/bills?status=nonsense')).toBe('all')
  expect(billFilterOfHash('#admin/billing/bills')).toBe('all')
  expect(billsHref('held')).toBe('#admin/billing/bills?status=held')
  expect(billsHref('all')).toBe('#admin/billing/bills')
  expect(eventFilterOfHash('#admin/billing/events?filter=failed')).toBe('failed')
  expect(eventFilterOfHash('#admin/billing/events?filter=x')).toBe('all')
  expect(eventsHref('all')).toBe('#admin/billing/events')
})

test('times read as how long ago, in the largest unit that fits', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z')
  expect(ago('2026-11-17T11:59:50.000Z', now)).toBe('now')
  expect(ago('2026-11-17T11:55:00.000Z', now)).toBe('5 minutes ago')
  expect(ago('2026-11-16T12:00:00.000Z', now)).toBe('yesterday')
  expect(ago('2026-11-14T12:00:00.000Z', now)).toBe('3 days ago')
})
