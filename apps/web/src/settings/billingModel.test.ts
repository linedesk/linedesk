import { expect, test } from 'vitest'
import type { BillingOverviewBill, BillingStateBill } from '@linedesk/actions'
import {
  amountFits,
  billingBanner,
  canCancel,
  canResume,
  daysLeft,
  dollarsToCents,
  paysCharges,
  refusalKey,
  statusBadge,
  usageLine,
  yearlyRefundLine,
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
  seatCents: 1100,
  workspaces: 1,
  trialEndsAt: null,
  currentPeriodEnd: '2026-12-05T00:00:00Z',
  cancelAtPeriodEnd: false,
  balanceMicros: 40_000_000,
  availableMicros: 40_000_000,
  autoRecharge: { on: true, thresholdCents: 500, amountCents: 2000 },
  cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 0, ownerMaxBaseCents: 100_000 },
  rechargeFailure: null,
  rechargePending: null,
  heldForReview: false,
  extraNumberCents: 300,
  canBuyMinutes: true,
  hasPortal: true,
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
        { id: 'in_1', kind: 'subscription', number: null, status: 'paid', totalCents: 10_800, createdAt, url: null },
        {
          id: 'in_2',
          kind: 'recharge',
          number: null,
          status: 'paid',
          totalCents: 2000,
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
