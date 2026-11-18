import { expect, test } from 'vitest'
import type { BillingOverviewBill, BillingStateBill, TrialMinutesPrompt } from '@linedesk/actions'
import {
  amountFits,
  billingBanner,
  canCancel,
  canResume,
  daysLeft,
  dollarsToCents,
  extraCallChoices,
  freeExtraCalls,
  paysCharges,
  outcomeUnknown,
  purchaseKeys,
  refusalKey,
  statusBadge,
  trialRechargeInput,
  usageLine,
  yearlyRefundLine,
  workspaceBillingView,
} from './billingModel.ts'

test('typed dollars: whole amounts in range only', () => {
  expect(dollarsToCents('25', 500, 50_000)).toBe(2500)
  expect(dollarsToCents(' $40 ', 500, 50_000)).toBe(4000)
  expect(dollarsToCents('4', 500, 50_000)).toBeNull()
  expect(dollarsToCents('501', 500, 50_000)).toBeNull()
  expect(dollarsToCents('12.50', 500, 50_000)).toBeNull()
  expect(dollarsToCents('', 500, 50_000)).toBeNull()
})

test('the trial countdown counts whole days, never below zero', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  expect(daysLeft('2026-11-30T12:00:00Z', now)).toBe(14)
  expect(daysLeft('2026-11-16T13:00:00Z', now)).toBe(1)
  expect(daysLeft('2026-11-15T12:00:00Z', now)).toBe(0)
})

test('usage: minutes rounded up per level, the allowance capped at what is included, the cost summed', () => {
  expect(
    usageLine({
      workspaceId: 'ws',
      name: null,
      allowanceUsedSeconds: 3100,
      allowanceSeconds: 3000,
      levels: { standard: { seconds: 61, micros: 50_833 }, ultra: { seconds: 30, micros: 100_000 } },
    }),
  ).toEqual({
    includedUsedMinutes: 50,
    includedMinutes: 50,
    standard: 2,
    premium: 0,
    ultra: 1,
    ownKeys: 0,
    costMicros: 150_833,
  })
})

test('auto-recharge: the amount clears the threshold by $5; refusal codes have their own words', () => {
  expect(amountFits(500, 2000)).toBe(true)
  expect(amountFits(2000, 2000)).toBe(false)
  expect(refusalKey('billing_retry_limit')).toBe('settings.billing.error.retryLimit')
  expect(refusalKey('billing_auto_recharge_off')).toBe('settings.billing.error.autoRechargeOff')
  expect(refusalKey('something_else')).toBeNull()
})

const bill = (over: Partial<BillingOverviewBill> = {}): BillingOverviewBill => ({
  status: 'active',
  interval: 'month',
  kind: 'cloud',
  seatCents: 1100,
  clientSeatCents: null,
  workspaces: 1,
  trialEndsAt: null,
  currentPeriodEnd: '2026-12-05T00:00:00Z',
  cancelAtPeriodEnd: false,
  balanceMicros: 40_000_000,
  availableMicros: 40_000_000,
  autoRecharge: { on: true, thresholdCents: 500, amountCents: 2000 },
  calls: {
    includedPerWorkspace: 5,
    extraCallCents: 100,
    step: 5,
    maxExtra: 45,
    canAdd: true,
    paidExtra: 0,
    workspaces: [
      { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 0 },
    ],
  },
  cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 0, ownerMaxBaseCents: 100_000 },
  rechargeFailure: null,
  rechargePending: null,
  heldForReview: false,
  extraNumberCents: 300,
  prices: {
    includedNumbers: 1,
    includedMinutes: 50,
    includedCalls: 5,
    standardMicrosPerMinute: 50_000,
    premiumMicrosPerMinute: 100_000,
    ultraMicrosPerMinute: 200_000,
    extraNumberCents: 300,
  },
  canBuyMinutes: true,
  hasPortal: true,
  taxed: false,
  taxAddressMissing: false,
  period: null,
  usage: [],
  invoices: [],
  ...over,
})
const state = (over: Partial<BillingStateBill> = {}): BillingStateBill => ({
  status: 'active',
  suspendedReason: null,
  pastDueSince: null,
  suspendsAt: null,
  cancelsAt: null,
  canceledAt: null,
  numbersReleaseAt: null,
  dataUntil: null,
  rechargeFailed: false,
  heldForReview: false,
  rechargeNeedsAction: false,
  lowBalance: null,
  unpaidNumbers: [],
  trialMinutes: null,
  busyLine: null,
  ...over,
})

test('banner: nothing while the bill runs normally, the most pressing thing otherwise', () => {
  expect(billingBanner(state())).toBeNull()
  expect(billingBanner(null)).toBeNull()
  expect(billingBanner(state({ status: 'suspended', suspendedReason: 'payment' }))).toEqual({
    key: 'settings.billing.banner.suspended',
    tone: 'danger',
  })
  expect(billingBanner(state({ status: 'past_due', rechargeFailed: true }))?.key).toBe(
    'settings.billing.banner.pastDue',
  )
  expect(billingBanner(state({ rechargeFailed: true }))?.key).toBe('settings.billing.banner.rechargeFailed')
  expect(billingBanner(state({ rechargeFailed: true, rechargeNeedsAction: true }))?.key).toBe(
    'settings.billing.banner.rechargeConfirm',
  )
  expect(billingBanner(state({ unpaidNumbers: [{ e164: '+15035550100', releaseAt: '2026-12-01' }] }))?.tone).toBe(
    'warning',
  )
})

test('banner: a low balance only when nothing lifts it (auto-recharge off, or the cap leaves less than one recharge)', () => {
  expect(billingBanner(state({ lowBalance: 'auto_recharge_off' }))?.key).toBe('settings.billing.banner.lowBalance')
  expect(billingBanner(state({ lowBalance: 'cap_reached' }))?.key).toBe('settings.billing.banner.capReached')
  // A failed recharge says more than the balance.
  expect(billingBanner(state({ rechargeFailed: true, lowBalance: 'auto_recharge_off' }))?.key).toBe(
    'settings.billing.banner.rechargeFailed',
  )
})

test('cancel and Keep my plan: in the trial, paid, past due and suspended (the portal has no cancel); never once canceled', () => {
  for (const status of ['trialing', 'active', 'past_due', 'suspended'] as const) {
    expect(canCancel(bill({ status })), status).toBe(true)
    expect(canResume(bill({ status, cancelAtPeriodEnd: true })), status).toBe(true)
  }
  expect(canCancel(bill({ cancelAtPeriodEnd: true }))).toBe(false)
  for (const status of ['pending_payment', 'canceled', 'comped'] as const) {
    expect(canCancel(bill({ status })), status).toBe(false)
    expect(canResume(bill({ status, cancelAtPeriodEnd: true })), status).toBe(false)
  }
})

test('a bill held for review says so instead of "Active", in the badge and the banner', () => {
  expect(statusBadge('active').key).toBe('settings.billing.status.active')
  expect(statusBadge('active', true).key).toBe('settings.billing.status.held')
  expect(statusBadge('trialing', true).key).toBe('settings.billing.status.held')
  // A held bill that is suspended or canceled says that instead.
  expect(statusBadge('suspended', true).key).toBe('settings.billing.status.suspended')
  expect(billingBanner(state({ heldForReview: true }))).toEqual({
    key: 'settings.billing.banner.held',
    tone: 'warning',
  })
  expect(billingBanner(state({ heldForReview: true, status: 'past_due' }))?.key).toBe('settings.billing.banner.pastDue')
})

test('a comped bill pays nothing', () => {
  expect(paysCharges(bill({ status: 'comped' }))).toBe(false)
  expect(paysCharges(bill())).toBe(true)
})

test('cancel: a yearly plan paid in the last 14 days is refunded on request until the 14th day, later not at all', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  const fmt = (iso: string) => iso.slice(0, 10)
  const paidOn = (createdAt: string) =>
    bill({
      interval: 'year',
      invoices: [
        {
          id: 'in_1',
          kind: 'subscription',
          number: null,
          status: 'paid',
          totalCents: 10_800,
          taxCents: 0,
          createdAt,
          url: null,
        },
        {
          id: 'in_2',
          kind: 'recharge',
          number: null,
          status: 'paid',
          totalCents: 2000,
          taxCents: 0,
          createdAt: '2026-11-15T00:00:00Z',
          url: null,
        },
      ],
    })
  expect(yearlyRefundLine(paidOn('2026-11-10T00:00:00Z'), fmt, now)).toEqual({
    key: 'settings.billing.cancel.yearlyRefund',
    values: { date: '2026-11-24' },
  })
  expect(yearlyRefundLine(paidOn('2026-10-01T00:00:00Z'), fmt, now)?.key).toBe('settings.billing.cancel.yearlyNoRefund')
  // Monthly plans and the trial (nothing was charged) say nothing about it.
  expect(yearlyRefundLine(bill({ interval: 'month' }), fmt, now)).toBeNull()
  expect(yearlyRefundLine(bill({ interval: 'year', status: 'trialing' }), fmt, now)).toBeNull()
})

test('extra calls at the same time: none, then steps of 5 up to the most; a number off the steps stays pickable', () => {
  expect(extraCallChoices({ step: 5, maxExtra: 15 })).toEqual([0, 5, 10, 15])
  expect(extraCallChoices({ step: 5, maxExtra: 0 })).toEqual([0])
  // An admin lowered the most per workspace since the owner bought 20.
  expect(extraCallChoices({ step: 5, maxExtra: 10 }, 20)).toEqual([0, 5, 10, 20])
  expect(refusalKey('billing_extra_calls_paid_plan')).toBe('settings.billing.error.extraCallsPaidPlan')
  expect(refusalKey('billing_extra_calls_above_max')).toBe('settings.billing.error.extraCallsAboveMax')
  expect(refusalKey('billing_extra_calls_payment_failed')).toBe('settings.billing.error.extraCallsPaymentFailed')
  expect(refusalKey('billing_extra_calls_canceling')).toBe('settings.billing.error.extraCallsCanceling')
  expect(refusalKey('billing_extra_calls_too_often')).toBe('settings.billing.error.extraCallsTooOften')
  expect(refusalKey('billing_extra_calls_renewing')).toBe('settings.billing.error.extraCallsRenewing')
})

test('a raise up to what this period already paid for costs nothing now (review of #1103, M-1)', () => {
  const calls = {
    paidExtra: 20,
    workspaces: [
      { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 0 },
      { workspaceId: 'ws_2', name: 'Brightwater North', extraCalls: 10, limit: 15, busyCallers: 0 },
    ],
  }
  expect(freeExtraCalls(calls, { workspaceId: 'ws_1', to: 10 })).toBe(true)
  expect(freeExtraCalls(calls, { workspaceId: 'ws_1', to: 15 })).toBe(false)
  expect(freeExtraCalls({ ...calls, paidExtra: 0 }, { workspaceId: 'ws_1', to: 5 })).toBe(false)
})

test('Buy minutes keeps one command id per purchase while its outcome is unknown, never longer (review of #1102, L-1)', () => {
  let n = 0
  const keys = purchaseKeys(() => `key_${++n}`)
  const first = keys.keyFor('2500:pm_1')
  // No answer (network) or a server error: the next press sends the same command, so the server finds the purchase.
  keys.settle(Object.assign(new Error('unreachable'), { status: undefined }))
  expect(keys.keyFor('2500:pm_1')).toBe(first)
  keys.settle(Object.assign(new Error('server error'), { status: 500 }))
  expect(keys.keyFor('2500:pm_1')).toBe(first)
  // Another amount or card is another purchase.
  expect(keys.keyFor('1000:pm_1')).not.toBe(first)
  // A definite answer ends it: paid, or a refusal (a step-up asked, a payment running).
  const second = keys.keyFor('1000:pm_1')
  keys.settle()
  expect(keys.keyFor('1000:pm_1')).not.toBe(second)
  const third = keys.keyFor('1000:pm_1')
  keys.settle(Object.assign(new Error('refused'), { status: 409 }))
  expect(keys.keyFor('1000:pm_1')).not.toBe(third)
  expect(outcomeUnknown({ status: 403 })).toBe(false)
  expect(outcomeUnknown({ status: 502 })).toBe(true)
  expect(outcomeUnknown(new Error('no status'))).toBe(true)
})

const prompt = (over: Partial<TrialMinutesPrompt> = {}): TrialMinutesPrompt => ({
  stage: 'low',
  paid: false,
  usedMinutes: 40,
  includedMinutes: 50,
  amountCents: 2500,
  thresholdCents: 500,
  capCents: 5000,
  freeUntil: '2026-12-01T12:00:00.000Z',
  standardMicrosPerMinute: 50_000,
  card: { id: 'pm_1', brand: 'visa', last4: '4242' },
  ...over,
})

test('banner: the trial prompt by its stage, with its own button; paused calls are red', () => {
  expect(billingBanner(state({ status: 'trialing', trialMinutes: prompt() }))).toEqual({
    key: 'settings.billing.banner.trialLow',
    tone: 'warning',
    trial: prompt(),
  })
  expect(billingBanner(state({ status: 'trialing', trialMinutes: prompt({ stage: 'grace' }) }))).toMatchObject({
    key: 'settings.billing.banner.trialGrace',
    tone: 'warning',
  })
  expect(billingBanner(state({ status: 'trialing', trialMinutes: prompt({ stage: 'paused' }) }))).toMatchObject({
    key: 'settings.billing.banner.trialPaused',
    tone: 'danger',
  })
  // A card held for review or a failed recharge says more; without the prompt, nothing.
  expect(billingBanner(state({ status: 'trialing', heldForReview: true, trialMinutes: prompt() }))?.key).toBe(
    'settings.billing.banner.held',
  )
  expect(billingBanner(state({ status: 'trialing', rechargeFailed: true, trialMinutes: prompt() }))?.trial).toBe(
    undefined,
  )
  expect(billingBanner(state({ status: 'trialing' }))).toBeNull()
})

test('"Keep calls answered" sends the recharge amount on the card shown, as the trial recharge', () => {
  expect(trialRechargeInput(prompt(), { id: 'pm_1' })).toEqual({
    amountCents: 2500,
    savedCard: true,
    trialRecharge: true,
    confirmCard: 'pm_1',
  })
  // No card known: the first press only names it.
  expect(trialRechargeInput(prompt({ amountCents: 3000 }), null)).toEqual({
    amountCents: 3000,
    savedCard: true,
    trialRecharge: true,
  })
})

test('Workspace settings › Billing: owners and admins with or without a bill on Cloud, members never, off billing never', () => {
  const owner = ['settings:write', 'billing:manage']
  const member = ['call:read']
  const on = (workspace: Record<string, unknown>, permissions: string[]) =>
    workspaceBillingView({ permissions, workspace: { id: 'ws_1', name: 'B', ...workspace } })
  // On a bill: the bill's page for owners and admins (the server answers who manages it), nothing for members.
  expect(on({ billingState: 'active', billingOn: true }, owner)).toBe('owner')
  expect(on({ billingState: 'active', billingOn: true }, ['settings:write'])).toBe('usage')
  expect(on({ billingState: 'active', billingOn: true }, member)).toBeNull()
  // No bill on an install that bills: "not on a bill" for owners and admins.
  expect(on({ billingState: null, billingOn: true }, owner)).toBe('none')
  expect(on({ billingState: null, billingOn: true }, member)).toBeNull()
  // A white-label client without a bill: its partner handles it, no section.
  expect(on({ billingState: null, billingOn: true, partnerManaged: true }, owner)).toBeNull()
  // Self-hosted (billing off), or an older server that does not say: no section.
  expect(on({ billingState: null, billingOn: false }, owner)).toBeNull()
  expect(on({ billingState: null }, owner)).toBeNull()
  expect(workspaceBillingView({ permissions: owner, workspace: null })).toBeNull()
})

test('banner: busy callers today (LIN-450) is the least pressing line, in the warning tone', () => {
  const busyLine = {
    workspaceId: 'ws_1',
    callers: 2,
    limit: 5,
    extraCalls: 0,
    step: 5,
    stepCents: 500,
    canAdd: true,
  }
  expect(billingBanner(state({ busyLine }))).toEqual({
    key: 'settings.billing.banner.busyLine',
    tone: 'warning',
    busy: busyLine,
  })
  expect(billingBanner(state({ busyLine, rechargeFailed: true }))?.key).toBe('settings.billing.banner.rechargeFailed')
  expect(billingBanner(state({ busyLine, lowBalance: 'auto_recharge_off' }))?.key).toBe(
    'settings.billing.banner.lowBalance',
  )
})
