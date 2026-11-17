// The billing math (docs/billing.md §4.2 to §4.4): rating at the three levels with the included allowance at each level's
// factor, own keys only when confirmed, the reservation a call holds, the gate and the recharge decision. Pure
// functions, checked by examples and by seeded random properties.
import {
  allowanceFactor,
  BALANCE_BUFFER_MICROS,
  BILLING_DEFAULTS,
  callGate,
  callLimitSeconds,
  callReservation,
  concurrentCallCap,
  INCLUDED_STANDARD_SECONDS,
  LEVEL_PRICES,
  maxExtraCalls,
  PAID_LEVELS,
  type PaidLevel,
  planPrice,
  RECHARGE_LIMITS,
  rateCall,
  rechargeCapCents,
  rechargeDecision,
  trialGraceMicros,
  usageMicros,
  workspaceCallLimit,
} from '@linedesk/db'
import { describe, expect, test } from 'vitest'
import { checkBillingRules, invoiceTax, isLinedeskPlan, mergeBillingRules, planCatalog } from '../src/billing-rules.ts'

/** A small seeded generator, so a failing property shows the same case on every run. */
function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
  return {
    int: (max: number) => Math.floor(next() * (max + 1)),
    pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!,
  }
}

const rate = (over: Partial<Parameters<typeof rateCall>[0]> = {}) =>
  rateCall({
    durationSeconds: 0,
    transferSeconds: 0,
    level: 'standard',
    ownKeysConfirmed: false,
    allowanceUsed: 0,
    ...over,
  })

describe('rating a call', () => {
  test('Standard is 5¢, Premium 10¢ and Ultra 20¢ a minute, per second', () => {
    expect(PAID_LEVELS).toEqual(['standard', 'premium', 'ultra'])
    expect(LEVEL_PRICES.standard.microsPerMinute).toBe(50_000)
    expect(LEVEL_PRICES.premium.microsPerMinute).toBe(100_000)
    expect(LEVEL_PRICES.ultra.microsPerMinute).toBe(200_000)
    expect(usageMicros(30, 'ultra')).toBe(100_000)
    expect(usageMicros(60, 'standard')).toBe(50_000)
    expect(usageMicros(61, 'premium')).toBe(101_667)
    const full = { allowanceUsed: INCLUDED_STANDARD_SECONDS }
    expect(rate({ durationSeconds: 90, ...full })).toMatchObject({
      basis: 'standard',
      billableSeconds: 90,
      priceMicros: 75_000,
    })
    expect(rate({ durationSeconds: 90, level: 'premium', ...full })).toMatchObject({
      basis: 'premium',
      priceMicros: 150_000,
    })
  })

  test('the 50 included minutes are Standard; a Premium minute uses two', () => {
    expect(allowanceFactor('standard')).toBe(1)
    expect(allowanceFactor('premium')).toBe(2)
    expect(rate({ durationSeconds: 3600 })).toMatchObject({
      includedSeconds: 3000,
      billableSeconds: 600,
      allowanceSeconds: 3000,
      priceMicros: 500_000,
    })
    expect(rate({ durationSeconds: 3600, level: 'premium' })).toMatchObject({
      includedSeconds: 1500,
      billableSeconds: 2100,
      allowanceSeconds: 3000,
      priceMicros: 3_500_000,
    })
    // Ultra never uses the allowance: every minute is paid from the balance, and the allowance stays for other calls.
    expect(allowanceFactor('ultra')).toBe(0)
    expect(rate({ durationSeconds: 600, level: 'ultra' })).toMatchObject({
      includedSeconds: 0,
      billableSeconds: 600,
      allowanceSeconds: 0,
      priceMicros: 2_000_000,
    })
    // One Standard second left is not half a Premium second: nothing is included.
    expect(rate({ durationSeconds: 60, level: 'premium', allowanceUsed: 2999 })).toMatchObject({
      includedSeconds: 0,
      allowanceSeconds: 0,
    })
  })

  test('a transferred call bills the inbound leg plus the transfer leg at its level', () => {
    expect(rate({ durationSeconds: 300, transferSeconds: 120, level: 'premium', allowanceUsed: 3000 })).toMatchObject({
      seconds: 420,
      billableSeconds: 420,
      priceMicros: 700_000,
    })
  })

  test('own keys is $0 only when confirmed after the call', () => {
    expect(rate({ durationSeconds: 600, ownKeysConfirmed: true, allowanceUsed: 3000 })).toMatchObject({
      basis: 'own_keys',
      includedSeconds: 0,
      allowanceSeconds: 0,
      priceMicros: 0,
    })
    expect(rate({ durationSeconds: 600, level: 'premium', allowanceUsed: 3000 }).priceMicros).toBe(1_000_000)
  })

  test('a comped bill records the seconds at $0 and keeps the allowance', () => {
    expect(rate({ durationSeconds: 600, comped: true })).toMatchObject({
      basis: 'standard',
      seconds: 600,
      allowanceSeconds: 0,
      priceMicros: 0,
    })
  })

  test('properties: seconds add up, the allowance never goes over, the price is the billable seconds at the level', () => {
    const r = random(20261116)
    for (let i = 0; i < 2000; i++) {
      const level: PaidLevel = r.pick(PAID_LEVELS)
      const call = {
        durationSeconds: r.int(7200),
        transferSeconds: r.pick([0, r.int(600)]),
        level,
        ownKeysConfirmed: r.int(9) === 0,
        allowanceUsed: r.int(INCLUDED_STANDARD_SECONDS + 100),
      }
      const rating = rateCall(call)
      expect(rating.seconds).toBe(call.durationSeconds + call.transferSeconds)
      expect(rating.includedSeconds + rating.billableSeconds).toBe(rating.seconds)
      expect(rating.allowanceSeconds).toBe(
        rating.includedSeconds * (call.ownKeysConfirmed ? 0 : allowanceFactor(level)),
      )
      expect(call.allowanceUsed + rating.allowanceSeconds).toBeLessThanOrEqual(
        Math.max(call.allowanceUsed, INCLUDED_STANDARD_SECONDS),
      )
      expect(rating.priceMicros).toBe(call.ownKeysConfirmed ? 0 : usageMicros(rating.billableSeconds, level))
      // A higher level never costs less for the same call and allowance.
      if (!call.ownKeysConfirmed && level !== 'ultra') {
        const higher = level === 'standard' ? 'premium' : 'ultra'
        expect(rateCall({ ...call, level: higher }).priceMicros).toBeGreaterThanOrEqual(rating.priceMicros)
      }
    }
  })
})

describe('what a call holds while it runs', () => {
  test('the limit is the max length, plus the bridged time and the transfer leg with transfers on', () => {
    expect(callLimitSeconds(20, false)).toBe(1200)
    expect(callLimitSeconds(20, true)).toBe(2400)
  })

  test('free allowance first, money for the rest of the limit', () => {
    expect(callReservation('standard', 1200, 3000)).toEqual({ heldSeconds: 1200, reservedMicros: 0 })
    expect(callReservation('premium', 1200, 3000)).toEqual({ heldSeconds: 2400, reservedMicros: 0 })
    expect(callReservation('premium', 1200, 1000)).toEqual({ heldSeconds: 1000, reservedMicros: 1_166_667 })
    expect(callReservation('standard', 1200, 0)).toEqual({ heldSeconds: 0, reservedMicros: 1_000_000 })
    // Ultra holds no allowance and the Ultra price for the whole limit.
    expect(callReservation('ultra', 1200, 3000)).toEqual({ heldSeconds: 0, reservedMicros: 4_000_000 })
  })

  test('properties: what it holds always covers the most the call can cost', () => {
    const r = random(7)
    for (let i = 0; i < 2000; i++) {
      const level: PaidLevel = r.pick(PAID_LEVELS)
      const limit = 60 + r.int(4000)
      const used = r.int(INCLUDED_STANDARD_SECONDS)
      const held = r.int(INCLUDED_STANDARD_SECONDS - used)
      const free = INCLUDED_STANDARD_SECONDS - used - held
      const reservation = callReservation(level, limit, free)
      expect(reservation.heldSeconds).toBeLessThanOrEqual(free)
      // However long the call runs up to its limit, and whatever other running calls posted first, the rating's price
      // is at most the money this call holds.
      const duration = r.int(limit)
      const worst = rateCall({
        durationSeconds: duration,
        transferSeconds: 0,
        level,
        ownKeysConfirmed: false,
        allowanceUsed: used + held,
      })
      expect(worst.priceMicros).toBeLessThanOrEqual(reservation.reservedMicros)
    }
  })
})

describe('the cap on billed seconds (review M2)', () => {
  test('a call is billed at most its limit plus the grace, and says what it reported', () => {
    expect(rate({ durationSeconds: 36_000, level: 'ultra', limitSeconds: 60 })).toMatchObject({
      seconds: 120,
      cappedFromSeconds: 36_000,
      priceMicros: 400_000,
    })
    expect(rate({ durationSeconds: 100, transferSeconds: 20, limitSeconds: 60 })).toMatchObject({
      seconds: 120,
      cappedFromSeconds: null,
    })
    expect(rate({ durationSeconds: 100, transferSeconds: 21, limitSeconds: 60 })).toMatchObject({
      seconds: 120,
      cappedFromSeconds: 121,
    })
  })

  test('properties: whatever a call reports, its price is at most its reservation plus the grace at its level', () => {
    const r = random(857)
    for (let i = 0; i < 2000; i++) {
      const level: PaidLevel = r.pick(PAID_LEVELS)
      const limit = 60 + r.int(4000)
      const used = r.int(INCLUDED_STANDARD_SECONDS)
      const reservation = callReservation(level, limit, INCLUDED_STANDARD_SECONDS - used)
      const rating = rateCall({
        durationSeconds: r.int(200_000),
        transferSeconds: r.int(10_000),
        level,
        ownKeysConfirmed: false,
        allowanceUsed: used,
        limitSeconds: limit,
      })
      expect(rating.seconds).toBeLessThanOrEqual(limit + BILLING_DEFAULTS.callLimitGraceSeconds)
      expect(rating.priceMicros).toBeLessThanOrEqual(
        reservation.reservedMicros + usageMicros(BILLING_DEFAULTS.callLimitGraceSeconds, level) + 1,
      )
    }
  })
})

describe('the call gate', () => {
  const bill = { status: 'active', balanceMicros: 0, reservedMicros: 0, running: 0, extraCalls: [0] }

  test('a bill out of service is refused', () => {
    for (const status of ['pending_payment', 'suspended', 'canceled'])
      expect(callGate({ ...bill, status }, 0)).toEqual({ allow: false, reason: 'billing_inactive' })
  })

  test('the concurrency cap (LIN-450): 5 per workspace, in the trial too, plus the extra calls bought, at most 50 each', () => {
    expect(concurrentCallCap([])).toBe(5)
    expect(concurrentCallCap([0, 0, 0])).toBe(15)
    expect(concurrentCallCap([10, 0])).toBe(20)
    expect(concurrentCallCap([45])).toBe(50)
    // Never above the most per workspace, however much is stored (an admin lowered the most since).
    expect(concurrentCallCap([100])).toBe(50)
    expect(workspaceCallLimit(0)).toBe(5)
    expect(workspaceCallLimit(5)).toBe(10)
    expect(maxExtraCalls()).toBe(45)
    expect(maxExtraCalls({ ...BILLING_DEFAULTS, concurrentCallsMaxPerWorkspace: 22 })).toBe(15)
    expect(maxExtraCalls({ ...BILLING_DEFAULTS, concurrentCallsMaxPerWorkspace: 3 })).toBe(0)
    expect(callGate({ ...bill, status: 'trialing', running: 4 }, 0)).toEqual({ allow: true })
    expect(callGate({ ...bill, status: 'trialing', running: 5 }, 0)).toEqual({ allow: false, reason: 'too_many_calls' })
    expect(callGate({ ...bill, running: 4 }, 0)).toEqual({ allow: true })
    expect(callGate({ ...bill, running: 5 }, 0)).toEqual({ allow: false, reason: 'too_many_calls' })
    // The trial: at most `trialConcurrentCalls` over all the bill's workspaces (review of #1103, L-4); paid bills sum.
    expect(callGate({ ...bill, status: 'trialing', extraCalls: [0, 0, 0], running: 5 }, 0)).toEqual({
      allow: false,
      reason: 'too_many_calls',
    })
    expect(callGate({ ...bill, extraCalls: [0, 0, 0], running: 14 }, 0)).toEqual({ allow: true })
    expect(
      callGate({ ...bill, status: 'trialing', extraCalls: [0, 0], running: 7 }, 0, {
        ...BILLING_DEFAULTS,
        trialConcurrentCalls: 8,
      }),
    ).toEqual({ allow: true })
    expect(callGate({ ...bill, extraCalls: [5], running: 9 }, 0)).toEqual({ allow: true })
    expect(callGate({ ...bill, extraCalls: [5], running: 10 }, 0)).toEqual({ allow: false, reason: 'too_many_calls' })
    // An instance admin's cap for the bill comes first.
    expect(callGate({ ...bill, extraCalls: [5], running: 3, concurrencyCap: 3 }, 0)).toEqual({
      allow: false,
      reason: 'too_many_calls',
    })
  })

  test('a subscription of extra calls alone is no plan; on top of a seat it is (review of #1103, L-5)', () => {
    const sub = (items: { lookupKey: string; productId: string }[]) =>
      ({ items: items.map(i => ({ ...i, quantity: 1 })) }) as unknown as Parameters<typeof isLinedeskPlan>[0]
    const seat = { lookupKey: 'ws_monthly', productId: 'linedesk_workspace' }
    const extra = { lookupKey: 'extra_calls_monthly', productId: 'linedesk_extra_calls' }
    expect(isLinedeskPlan(sub([seat]))).toBe(true)
    expect(isLinedeskPlan(sub([seat, extra]))).toBe(true)
    expect(isLinedeskPlan(sub([extra]))).toBe(false)
    // A seat price known by its product, without our lookup key (an older price), is still a seat.
    expect(isLinedeskPlan(sub([{ lookupKey: 'extra_calls_monthly', productId: 'linedesk_workspace' }]))).toBe(true)
    expect(isLinedeskPlan(sub([]))).toBe(false)
  })

  test('the extra calls are a Stripe price like the plan: $1 a month per call, $12 a year, from the rules', () => {
    expect(planPrice('extra_calls_monthly')).toMatchObject({ product: 'extra_calls', cents: 100, interval: 'month' })
    expect(planPrice('extra_calls_yearly')).toMatchObject({ product: 'extra_calls', cents: 1200, interval: 'year' })
    const rules = { ...BILLING_DEFAULTS, extraCallCents: 150 }
    expect(planPrice('extra_calls_yearly', rules)?.cents).toBe(1800)
  })

  test('the balance may go to −$5 after the trial, to 0 in it, then the trial grace of 10 Standard minutes', () => {
    expect(callGate(bill, BALANCE_BUFFER_MICROS)).toEqual({ allow: true })
    expect(callGate(bill, BALANCE_BUFFER_MICROS + 1)).toEqual({ allow: false, reason: 'no_balance' })
    expect(callGate({ ...bill, balanceMicros: 2_000_000, reservedMicros: 1_000_000 }, 1_000_000)).toEqual({
      allow: true,
    })
    expect(callGate({ ...bill, status: 'trialing' }, 0)).toEqual({ allow: true })
    // In the trial a call the balance does not cover starts on the grace while the bill is above −50¢ (10 × 5¢).
    expect(trialGraceMicros()).toBe(500_000)
    expect(callGate({ ...bill, status: 'trialing' }, 1)).toEqual({ allow: true, grace: true })
    expect(callGate({ ...bill, status: 'trialing', balanceMicros: -499_999 }, 1_000_000)).toEqual({
      allow: true,
      grace: true,
    })
    expect(callGate({ ...bill, status: 'trialing', balanceMicros: -500_000 }, 0)).toEqual({
      allow: false,
      reason: 'no_balance',
    })
    expect(callGate({ ...bill, status: 'trialing', reservedMicros: 500_000 }, 1)).toEqual({
      allow: false,
      reason: 'no_balance',
    })
    // After the trial the $5 buffer, never the grace.
    expect(callGate({ ...bill, balanceMicros: -4_999_999 }, 1_000_000)).toEqual({ allow: false, reason: 'no_balance' })
  })

  test('a comped bill checks only the cap', () => {
    expect(callGate({ ...bill, status: 'comped', balanceMicros: -100_000_000 }, 10_000_000)).toEqual({ allow: true })
    expect(callGate({ ...bill, status: 'comped', running: 5 }, 0)).toEqual({ allow: false, reason: 'too_many_calls' })
  })
})

describe('the recharge decision', () => {
  const bill = {
    status: 'active',
    autoRecharge: true,
    thresholdCents: 500,
    amountCents: 2000,
    capBaseCents: 5000,
    workspaces: 1,
    extraNumbers: 0,
    pending: false,
    failedWaiting: false,
    availableMicros: 4_000_000,
    usedThisMonthCents: 0,
  }

  test('below the threshold it recharges the amount', () => {
    expect(rechargeDecision(bill)).toEqual({ kind: 'recharge', amountCents: 2000 })
    expect(rechargeDecision({ ...bill, availableMicros: 5_000_000 })).toEqual({ kind: 'none' })
  })

  test('never in the trial, off, with one pending or a failure waiting', () => {
    expect(rechargeDecision({ ...bill, status: 'trialing' })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...bill, status: 'trialing', trialRecharge: false })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...bill, autoRecharge: false })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...bill, pending: true })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...bill, failedWaiting: true })).toEqual({ kind: 'none' })
  })

  test('in the trial once the owner pressed "Keep calls answered" (the trial recharge), with the same rules', () => {
    const tapped = { ...bill, status: 'trialing', trialRecharge: true }
    expect(rechargeDecision(tapped)).toEqual({ kind: 'recharge', amountCents: 2000 })
    expect(rechargeDecision({ ...tapped, availableMicros: 5_000_000 })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...tapped, autoRecharge: false })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...tapped, pending: true })).toEqual({ kind: 'none' })
    expect(rechargeDecision({ ...tapped, usedThisMonthCents: 3001 })).toEqual({ kind: 'cap_reached' })
    expect(rechargeDecision({ ...bill, status: 'canceled', trialRecharge: true })).toEqual({ kind: 'none' })
  })

  test('the monthly cap cuts the amount, below $20 it is reached; each extra number adds $3', () => {
    expect(rechargeDecision({ ...bill, usedThisMonthCents: 2500 })).toEqual({ kind: 'recharge', amountCents: 2000 })
    expect(rechargeDecision({ ...bill, usedThisMonthCents: 3000 })).toEqual({ kind: 'recharge', amountCents: 2000 })
    expect(rechargeDecision({ ...bill, usedThisMonthCents: 3001 })).toEqual({ kind: 'cap_reached' })
    expect(rechargeDecision({ ...bill, amountCents: 5000, usedThisMonthCents: 2000 })).toEqual({
      kind: 'recharge',
      amountCents: 3000,
    })
    expect(rechargeDecision({ ...bill, usedThisMonthCents: 3001, extraNumbers: 1 })).toEqual({
      kind: 'recharge',
      amountCents: 2000,
    })
  })

  test('properties: a recharge is never under the minimum and never takes the month over the cap', () => {
    const r = random(42)
    for (let i = 0; i < 2000; i++) {
      const input = {
        ...bill,
        amountCents: 2000 + r.int(48_000),
        workspaces: 1 + r.int(10),
        extraNumbers: r.int(40),
        availableMicros: r.int(10_000_000) - 5_000_000,
        usedThisMonthCents: r.int(60_000),
      }
      const answer = rechargeDecision(input)
      if (answer.kind !== 'recharge') continue
      const cap = rechargeCapCents(input.capBaseCents, input.workspaces) + 300 * input.extraNumbers
      expect(answer.amountCents).toBeGreaterThanOrEqual(RECHARGE_LIMITS.amountCents.min)
      expect(answer.amountCents).toBeLessThanOrEqual(input.amountCents)
      expect(input.usedThisMonthCents + answer.amountCents).toBeLessThanOrEqual(cap)
    }
  })
})

describe("an install's own rules (docs/billing.md §7a)", () => {
  test('a stored field in range replaces the default; one out of range, or unknown, is ignored and named', () => {
    const { rules, problems } = mergeBillingRules({
      includedStandardSeconds: 0,
      extraCallCents: 200,
      balanceBufferMicros: -1,
      levels: {
        standard: { microsPerMinute: 30_000, allowanceFactor: null },
        ultra: { microsPerMinute: 'free' },
        gold: {},
      },
      surprise: 1,
    })
    expect(rules).toMatchObject({
      includedStandardSeconds: 0,
      extraCallCents: 200,
      balanceBufferMicros: BILLING_DEFAULTS.balanceBufferMicros,
    })
    expect(rules.levels.standard).toEqual({ microsPerMinute: 30_000, allowanceFactor: null })
    expect(rules.levels.ultra).toEqual(BILLING_DEFAULTS.levels.ultra)
    expect(problems.sort()).toEqual(['balanceBufferMicros', 'levels.gold', 'levels.ultra', 'surprise'])
    expect(mergeBillingRules('nonsense')).toEqual({ rules: BILLING_DEFAULTS, problems: ['not an object'] })
    expect(mergeBillingRules(undefined)).toEqual({ rules: BILLING_DEFAULTS, problems: [] })
  })

  test('Stripe Tax is on by default; an install turns it off, and Checkout and its own invoices follow (LIN-459)', () => {
    expect(BILLING_DEFAULTS.automaticTax).toBe(true)
    expect(planCatalog(BILLING_DEFAULTS, 'Front Desk')).toMatchObject({ automaticTax: true, taxCode: 'txcd_10103001' })
    const { rules, problems } = mergeBillingRules({ automaticTax: false })
    expect(problems).toEqual([])
    expect(planCatalog(rules, 'Front Desk').automaticTax).toBe(false)
    expect(invoiceTax(rules)).toEqual({ automatic: false, code: 'txcd_10103001' })
    expect(mergeBillingRules({ automaticTax: 'yes' }).problems).toEqual(['automaticTax'])
    expect(checkBillingRules({ automaticTax: 1 }).problems).toEqual(['automaticTax'])
    expect(checkBillingRules({ automaticTax: true }).problems).toEqual([])
  })

  test('the math follows the rules: prices, the allowance, the buffer and the concurrency cap', () => {
    const { rules } = mergeBillingRules({
      includedStandardSeconds: 600,
      balanceBufferMicros: 0,
      concurrentCallsBase: 1,
      concurrentCallsPerWorkspace: 1,
      extraNumberCents: 500,
      levels: { standard: { microsPerMinute: 30_000, allowanceFactor: 1 } },
    })
    expect(
      rateCall(
        { durationSeconds: 1200, transferSeconds: 0, level: 'standard', ownKeysConfirmed: false, allowanceUsed: 0 },
        rules,
      ),
    ).toMatchObject({
      includedSeconds: 600,
      priceMicros: 300_000,
    })
    expect(callReservation('standard', 1200, 600, rules)).toEqual({ heldSeconds: 600, reservedMicros: 300_000 })
    expect(concurrentCallCap([0, 0], rules)).toBe(3)
    const bill = { status: 'active', balanceMicros: 0, reservedMicros: 0, running: 0, extraCalls: [0] }
    expect(callGate(bill, 1, rules)).toEqual({ allow: false, reason: 'no_balance' })
  })
})
