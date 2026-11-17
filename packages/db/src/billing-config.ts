// Billing prices and rules (docs/billing.md §4 and §7a, decisions 14 to 16), in one module: every
// price, allowance, cap and abuse limit billing uses is here, and nowhere else in the code. Amounts in US cents unless
// the name says micros (1 USD = 1,000,000).
//
// Two kinds of values:
// - `BILLING_DEFAULTS` (a `BillingRules`): prices, the included allowance and the abuse limits. An install can
//   change them (instance setting `billing.rules`, apps/api/src/billing-rules.ts, Server admin › Billing): every
//   install that bills its workspaces sets its own; the defaults are Linedesk Cloud's.
// - The recharge constants below: database CHECKs on `billing_accounts` use them, so they change only by migration.
// Stripe price and account ids are never in the code: they live in the Stripe account and the provider settings.

/**
 * The plan fees as Stripe prices (docs/billing.md §2.1), found by `lookupKey`. USD, per unit, tax-exclusive. `cents`
 * here are the defaults: the amounts in effect are the install's rules (`planPrices`, Server admin › Billing), and
 * the app makes the matching prices in the install's own Stripe account before a Checkout (`PlanCatalog`). There are
 * no founding prices (dropped 2026-11-16, docs/billing.md §2.1b).
 * Usage and extra numbers are never Stripe prices: they are paid from the balance (`BILLING_DEFAULTS`).
 */
export const PLAN_PRICES = [
  { lookupKey: 'ws_monthly', product: 'workspace', cents: 1100, interval: 'month' },
  { lookupKey: 'ws_yearly', product: 'workspace', cents: 10_800, interval: 'year' },
  { lookupKey: 'partner_monthly', product: 'partner', cents: 1900, interval: 'month' },
  { lookupKey: 'partner_yearly', product: 'partner', cents: 16_800, interval: 'year' },
  // Extra calls at once (LIN-450): $1 a month per extra call, sold in steps of `EXTRA_CALLS_STEP`; the yearly price is
  // 12 monthly ones (a subscription's items share one interval), so yearly and monthly plans pay the same.
  { lookupKey: 'extra_calls_monthly', product: 'extra_calls', cents: 100, interval: 'month' },
  { lookupKey: 'extra_calls_yearly', product: 'extra_calls', cents: 1200, interval: 'year' },
] as const satisfies readonly PlanPrice[]
export type PlanProduct = 'workspace' | 'partner' | 'extra_calls' | 'balance_recharge' | 'balance_topup'
export type PlanPrice = { lookupKey: string; product: PlanProduct; cents: number; interval: 'month' | 'year' }
/**
 * The Stripe products by their names on invoices and receipts, with the install's product name (Server admin ›
 * Branding) in front of the plan products. English, like every text this install sends to Stripe. The balance
 * products have no fixed price: a recharge invoice item and a top-up Checkout line give the amount.
 */
export const planProducts = (brand: string): Record<PlanProduct, string> => ({
  workspace: `${brand} workspace`,
  partner: `${brand} Partner`,
  extra_calls: `${brand} extra calls at the same time`,
  balance_recharge: 'Balance recharge',
  balance_topup: 'Prepaid minutes',
})
/** Stripe Tax code of every product and the account default: SaaS, business use (docs/billing.md §5.2). */
export const STRIPE_TAX_CODE = 'txcd_10103001'

/**
 * Extra calls at once are bought in steps of this many per workspace (LIN-450): the add-on's Stripe quantity is the
 * bill's extra calls, always a multiple of it. A database CHECK on `organization.extra_calls` uses it.
 */
export const EXTRA_CALLS_STEP = 5
/** The extra-calls prices' lookup keys start so (`extra_calls_monthly`, `extra_calls_yearly`). */
export const EXTRA_CALLS_LOOKUP_PREFIX = 'extra_calls_'

/** A bill's default monthly recharge cap base ($50): auto-recharges stop for the calendar month at the cap. */
export const RECHARGE_CAP_BASE_CENTS = 5000
/** What each workspace after the first adds to a bill's monthly recharge cap ($25). */
export const RECHARGE_CAP_PER_WORKSPACE_CENTS = 2500
/** The highest recharge cap an owner sets alone (with the step-up); above it only an instance admin. */
export const RECHARGE_CAP_SELF_SERVE_MAX_CENTS = 100_000
/**
 * Auto-recharge: when the balance falls below the threshold, the saved card is charged the amount. $25, not the $20
 * minimum: fewer charges a year, so fewer transactions toward the US states' 200-transaction sales tax thresholds
 * (LIN-459).
 */
export const RECHARGE_DEFAULTS = { thresholdCents: 500, amountCents: 2500 } as const
/** The owner's range for the threshold and the amount; $20 is also the smallest top-up. */
export const RECHARGE_LIMITS = {
  thresholdCents: { min: 500, max: 10_000 },
  amountCents: { min: 2000, max: 50_000 },
} as const
/** "Buy minutes": what one purchase may be, in cents before tax (docs/billing.md §2.2, L5). */
export const TOPUP_LIMITS_CENTS = { min: 500, max: 50_000 } as const
/** A recharge lifts the balance at least this far above the threshold, so one recharge is enough (no repeats). */
export const RECHARGE_AMOUNT_OVER_THRESHOLD_CENTS = 500
/** How far below zero the balance may go before new calls are refused (a failed recharge, the cap reached). */
export const BALANCE_BUFFER_MICROS = 5_000_000

/**
 * The usage levels and their default prices (Standard 5¢, Premium 10¢, Ultra 20¢ a minute). Per level: the price of
 * a minute (billed per second) and how many Standard seconds of the included allowance one second uses, or null when
 * the level's minutes never use it (every Ultra minute is paid from the balance). A new level is a row here plus the
 * regenerated CHECKs on `call_reservations.usage_level` and `ledger_entries.price_basis`, not new rating code.
 */
export const LEVEL_PRICES = {
  standard: { microsPerMinute: 50_000, allowanceFactor: 1 },
  premium: { microsPerMinute: 100_000, allowanceFactor: 2 },
  // Speech-to-speech models (Janik, 2026-11-16). The price may change after the realtime cost research.
  ultra: { microsPerMinute: 200_000, allowanceFactor: null },
} as const satisfies Record<string, LevelPrice>
export type LevelPrice = { microsPerMinute: number; allowanceFactor: number | null }
/** The levels a call pays, fixed when it starts. An own-keys call also has one: what it pays unless own keys is confirmed. */
export type PaidLevel = keyof typeof LEVEL_PRICES
export const PAID_LEVELS = Object.keys(LEVEL_PRICES) as [PaidLevel, ...PaidLevel[]]
/** How a usage entry was priced: a paid level, or $0 because every part ran on the customer's own keys. */
export const USAGE_LEVELS = [...PAID_LEVELS, 'own_keys'] as const
export type UsageLevel = PaidLevel | 'own_keys'

/** What an install may set (docs/billing.md §7a): prices, the included allowance and the abuse limits. */
export type BillingRules = {
  /** The plan fee per workspace (a seat) a month and a year, in cents before tax. */
  workspaceMonthlyCents: number
  workspaceYearlyCents: number
  /** The partner plan's base fee a month and a year, in cents before tax. */
  partnerMonthlyCents: number
  partnerYearlyCents: number
  /** The free trial's length in days (Checkout's `trial_period_days`). */
  trialDays: number
  levels: Record<PaidLevel, LevelPrice>
  /** The included allowance per workspace and period, in Standard seconds. */
  includedStandardSeconds: number
  /** How far below zero the balance may go before new calls are refused, after the trial; in the trial it is 0. */
  balanceBufferMicros: number
  /**
   * Calls at once (LIN-450): each workspace has `concurrentCallsPerWorkspace` included (in the trial too) plus the
   * extra calls its owner bought, at most `concurrentCallsMaxPerWorkspace` in all; a bill may run the sum of its
   * workspaces' limits plus `concurrentCallsBase`. In the trial a bill runs at most `trialConcurrentCalls` in all, however
   * many workspaces it has (security review of #1103, L-4: toll fraud on a fresh trial number).
   */
  concurrentCallsBase: number
  trialConcurrentCalls: number
  concurrentCallsPerWorkspace: number
  concurrentCallsMaxPerWorkspace: number
  /** The monthly price of one extra call at once, in cents (sold in steps of `EXTRA_CALLS_STEP`; yearly 12 times it). */
  extraCallCents: number
  /** On a billed workspace a transfer leg lasts at most this long, and so does the time a call stays bridged. */
  billedTransferCapSeconds: number
  /** The stale sweep ends a billed call this long after its limit. */
  callLimitGraceSeconds: number
  /** The monthly price of each extra number, and what it adds to the monthly recharge cap. */
  extraNumberCents: number
  /** What each workspace after the first adds to the monthly recharge cap. */
  rechargeCapPerWorkspaceCents: number
  /**
   * Stripe Tax (docs/billing.md §5.2): automatic tax on every Checkout, subscription and invoice the app makes, with a
   * required billing address and tax ID collection at Checkout. On by default, as before the switch existed (security
   * review of #1105, M-1); a self-hoster without Stripe Tax set up in their Stripe account turns it off. A change reaches
   * running subscriptions too (billing-tax.ts).
   */
  automaticTax: boolean
}

/** Linedesk Cloud's rules, and the defaults of every install. */
export const BILLING_DEFAULTS: BillingRules = {
  workspaceMonthlyCents: 1100,
  workspaceYearlyCents: 10_800,
  partnerMonthlyCents: 1900,
  partnerYearlyCents: 16_800,
  trialDays: 14,
  levels: LEVEL_PRICES,
  includedStandardSeconds: 3000,
  balanceBufferMicros: BALANCE_BUFFER_MICROS,
  concurrentCallsBase: 0,
  trialConcurrentCalls: 5,
  concurrentCallsPerWorkspace: 5,
  concurrentCallsMaxPerWorkspace: 50,
  extraCallCents: 100,
  billedTransferCapSeconds: 600,
  callLimitGraceSeconds: 60,
  extraNumberCents: 300,
  rechargeCapPerWorkspaceCents: RECHARGE_CAP_PER_WORKSPACE_CENTS,
  automaticTax: true,
}

/**
 * Self-serve sign-up and the trial (docs/billing.md §3.1, §3.2): the abuse limits, set per install with the instance
 * setting `signup.rules` (apps/api/src/self-serve.ts) over these defaults, which are Linedesk Cloud's.
 */
export type SignupRules = {
  /** Sign-up codes one address gets in an hour and in a day (counted before the code is sent). */
  codesPerAddressHour: number
  codesPerAddressDay: number
  /** Sign-up codes one IP (an IPv4 address or an IPv6 /64) asks for in an hour and in a day. */
  signupsPerIpHour: number
  signupsPerIpDay: number
  /** Sign-up codes on the whole install in an hour; reaching it refuses more and alerts the instance admins. */
  codesPerInstallHour: number
  /** A sign-up whose Checkout never completed is deleted after this many days (the daily sign-up sweep). */
  pendingDays: number
  /** Whether the sign-up page needs a Cloudflare Turnstile check; while on and Turnstile is not set up, sign-up is closed. */
  turnstile: boolean
  /** Address domains refused on top of the built-in list of disposable-mail domains. */
  blockedDomains: string[]
  /** Workspaces a bill may have during its trial: Cloud, partner. */
  trialWorkspacesCloud: number
  trialWorkspacesPartner: number
  /** Numbers a workspace may have during the trial (the included one). */
  trialNumbersPerWorkspace: number
  /** Radar risk levels of the trial's card check that hold number purchase for review. */
  reviewRiskLevels: string[]
}

/**
 * How long a card's fingerprint (`card_fingerprints`, one free trial per card) is kept after its bill was canceled,
 * in months (docs/billing.md §3.2 step 4; Janik, 2026-11-16). Fingerprints of bills that are not canceled stay. The
 * daily sign-up sweep deletes the older ones.
 */
export const CARD_FINGERPRINT_RETENTION_MONTHS = 24

/** Linedesk Cloud's sign-up and trial limits, and the defaults of every install. */
export const SIGNUP_DEFAULTS: SignupRules = {
  codesPerAddressHour: 3,
  codesPerAddressDay: 5,
  signupsPerIpHour: 3,
  signupsPerIpDay: 10,
  codesPerInstallHour: 200,
  pendingDays: 7,
  turnstile: true,
  blockedDomains: [],
  trialWorkspacesCloud: 1,
  trialWorkspacesPartner: 2,
  trialNumbersPerWorkspace: 1,
  reviewRiskLevels: ['elevated', 'highest'],
}

/** The range of each whole-number sign-up rule (`signup.rules`): what the server takes and the admin page checks. */
export const SIGNUP_RULE_RANGES = {
  codesPerAddressHour: [1, 100],
  codesPerAddressDay: [1, 1000],
  signupsPerIpHour: [1, 1000],
  signupsPerIpDay: [1, 10_000],
  codesPerInstallHour: [1, 100_000],
  pendingDays: [1, 90],
  trialWorkspacesCloud: [1, 100],
  trialWorkspacesPartner: [1, 100],
  trialNumbersPerWorkspace: [0, 100],
} as const satisfies Partial<Record<keyof SignupRules, readonly [number, number]>>
export type SignupCountRule = keyof typeof SIGNUP_RULE_RANGES

/** The countries a business can sign up from (decision 12): US, Canada, Puerto Rico. */
export const SIGNUP_COUNTRIES = ['US', 'CA', 'PR'] as const
export type SignupCountry = (typeof SIGNUP_COUNTRIES)[number]

/** Each plan price's amount under the install's rules. */
const PLAN_PRICE_CENTS = {
  ws_monthly: r => r.workspaceMonthlyCents,
  ws_yearly: r => r.workspaceYearlyCents,
  partner_monthly: r => r.partnerMonthlyCents,
  partner_yearly: r => r.partnerYearlyCents,
  extra_calls_monthly: r => r.extraCallCents,
  extra_calls_yearly: r => 12 * r.extraCallCents,
} as const satisfies Record<(typeof PLAN_PRICES)[number]['lookupKey'], (rules: BillingRules) => number>

/**
 * The plan prices in effect on this install: `PLAN_PRICES` with the amounts of the install's rules. A changed amount
 * applies to new Checkouts; a running subscription keeps the Stripe price it was started on (docs/billing.md §7b).
 */
export const planPrices = (rules: BillingRules = BILLING_DEFAULTS): PlanPrice[] =>
  PLAN_PRICES.map(p => ({ ...p, cents: PLAN_PRICE_CENTS[p.lookupKey](rules) }))

/** The price in effect for a lookup key (`ws_monthly`, …), or null for one that is not a plan price. */
export const planPrice = (lookupKey: string, rules: BillingRules = BILLING_DEFAULTS): PlanPrice | null =>
  planPrices(rules).find(p => p.lookupKey === lookupKey) ?? null

/** The default included allowance: 50 Standard minutes, in Standard seconds. */
export const INCLUDED_STANDARD_SECONDS = BILLING_DEFAULTS.includedStandardSeconds

/**
 * The monthly recharge cap in effect for a bill: its stored base plus $25 for each workspace after the first.
 * Computed on every read, never stored, so adding or removing a workspace moves it without a write.
 */
export function rechargeCapCents(
  baseCents: number,
  workspaces: number,
  rules: BillingRules = BILLING_DEFAULTS,
): number {
  return baseCents + rules.rechargeCapPerWorkspaceCents * Math.max(0, workspaces - 1)
}

// Rating and the call gate (docs/billing.md §2.1a, §4.2 to §4.4). Pure functions on numbers, so the server and the
// browser compute the same; the ledger code in apps/api/src/ledger.ts supplies the rows and the install's rules.

/** Standard seconds of the allowance one second at `level` uses; 0 for a level that does not use it. */
export const allowanceFactor = (level: PaidLevel, rules: BillingRules = BILLING_DEFAULTS): number =>
  rules.levels[level].allowanceFactor ?? 0

/** The calls one workspace may have running at once: those included plus the extra ones bought, at most the rules' most. */
export const workspaceCallLimit = (extraCalls: number, rules: BillingRules = BILLING_DEFAULTS): number =>
  Math.min(
    Math.max(rules.concurrentCallsPerWorkspace, rules.concurrentCallsMaxPerWorkspace),
    rules.concurrentCallsPerWorkspace + Math.max(0, extraCalls),
  )

/**
 * The most extra calls one workspace may buy: up to the rules' most per workspace, in whole steps. 0 when the
 * included calls already reach it.
 */
export const maxExtraCalls = (rules: BillingRules = BILLING_DEFAULTS): number =>
  Math.max(
    0,
    Math.floor((rules.concurrentCallsMaxPerWorkspace - rules.concurrentCallsPerWorkspace) / EXTRA_CALLS_STEP) *
      EXTRA_CALLS_STEP,
  )

/**
 * The calls a bill may have running at once: the base plus each workspace's limit (`workspaceCallLimit`). `extraCalls`
 * is each workspace's extra calls (an empty list counts one workspace without any, as a bill always has one).
 */
export function concurrentCallCap(extraCalls: readonly number[], rules: BillingRules = BILLING_DEFAULTS): number {
  const each = extraCalls.length ? extraCalls : [0]
  return rules.concurrentCallsBase + each.reduce((sum, extra) => sum + workspaceCallLimit(extra, rules), 0)
}

/**
 * The billed seconds a call can reach at most: the assistant's max length, and with transfers on the time it stays
 * bridged and the transfer leg itself, each capped. Stored on the reservation, so a settings change mid-call does not
 * lengthen it.
 */
export function callLimitSeconds(
  maxCallMinutes: number,
  transfers: boolean,
  rules: BillingRules = BILLING_DEFAULTS,
): number {
  return Math.max(1, Math.floor(maxCallMinutes * 60)) + (transfers ? 2 * rules.billedTransferCapSeconds : 0)
}

/** What `seconds` at a level cost, in micro-dollars (rounded to the nearest micro-dollar), as a positive amount. */
export const usageMicros = (seconds: number, level: PaidLevel, rules: BillingRules = BILLING_DEFAULTS) =>
  Math.round((seconds * rules.levels[level].microsPerMinute) / 60)

export type CallRating = {
  /** How the entry is priced: the paid level, or own_keys ($0) once confirmed. */
  basis: UsageLevel
  /** Billed seconds: the inbound leg plus the transfer leg, at most the call's limit plus the grace. */
  seconds: number
  /** The seconds the call reported, when they were over the limit plus the grace and `seconds` was capped; else null. */
  cappedFromSeconds: number | null
  /** Billed seconds the included allowance covered. */
  includedSeconds: number
  /** Billed seconds paid for. */
  billableSeconds: number
  /** Standard seconds of the allowance used (includedSeconds × the level's allowance factor). */
  allowanceSeconds: number
  /** The price, as a positive amount; the ledger entry is its negative. */
  priceMicros: number
}

/**
 * Rates a finished call (docs/billing.md §4.2): its billed seconds are the inbound leg's duration plus the transfer
 * leg's, at the level fixed at its start. The included allowance goes first, at the level's allowance factor (a
 * Premium second uses two Standard seconds, so 50 Standard or 25 Premium minutes are included; Ultra never uses it),
 * the rest at the level's price. Only own keys confirmed after the call makes it $0, using no allowance; a comped
 * bill records the seconds at $0, also using none. With `limitSeconds` (the limit stored on its reservation) the
 * billed seconds are capped at the limit plus the stale sweep's grace, so a wrong duration never debits more than the
 * gate reserved for (docs/billing.md §4.2).
 */
export function rateCall(
  call: {
    durationSeconds: number
    transferSeconds: number
    level: PaidLevel
    ownKeysConfirmed: boolean
    allowanceUsed: number
    comped?: boolean
    limitSeconds?: number
  },
  rules: BillingRules = BILLING_DEFAULTS,
): CallRating {
  const reported = Math.max(0, Math.floor(call.durationSeconds)) + Math.max(0, Math.floor(call.transferSeconds))
  const most = call.limitSeconds === undefined ? reported : call.limitSeconds + rules.callLimitGraceSeconds
  const seconds = Math.min(reported, most)
  const cappedFromSeconds = reported > seconds ? reported : null
  const free = { includedSeconds: 0, billableSeconds: seconds, allowanceSeconds: 0, priceMicros: 0, cappedFromSeconds }
  if (call.comped) return { basis: call.level, seconds, ...free }
  if (call.ownKeysConfirmed) return { basis: 'own_keys', seconds, ...free }
  const weight = allowanceFactor(call.level, rules)
  const left = Math.max(0, rules.includedStandardSeconds - call.allowanceUsed)
  const includedSeconds = weight > 0 ? Math.min(seconds, Math.floor(left / weight)) : 0
  const billableSeconds = seconds - includedSeconds
  return {
    basis: call.level,
    seconds,
    cappedFromSeconds,
    includedSeconds,
    billableSeconds,
    allowanceSeconds: includedSeconds * weight,
    priceMicros: usageMicros(billableSeconds, call.level, rules),
  }
}

/**
 * What a call holds while it runs: as much of the free allowance as its whole limit needs, and money for the rest of
 * that limit (rounded up), at its paid level, also when own keys is forecast (a part can fall back to ours). Ultra
 * holds no allowance and its price for the whole limit.
 */
export function callReservation(
  level: PaidLevel,
  limitSeconds: number,
  allowanceFree: number,
  rules: BillingRules = BILLING_DEFAULTS,
) {
  const weight = allowanceFactor(level, rules)
  const heldSeconds = weight > 0 ? Math.min(Math.max(0, allowanceFree), limitSeconds * weight) : 0
  const uncovered = weight > 0 ? limitSeconds - Math.floor(heldSeconds / weight) : limitSeconds
  return { heldSeconds, reservedMicros: Math.ceil((uncovered * rules.levels[level].microsPerMinute) / 60) }
}

export type GateBill = {
  status: string
  balanceMicros: number
  reservedMicros: number
  /** Calls of the bill running now (its reservation rows). */
  running: number
  /** The extra calls at once of each workspace on the bill (`organization.extra_calls`). */
  extraCalls: readonly number[]
  /** Calls at once an instance admin set for this bill (Server admin › Billing); null or absent: the rules' cap. */
  concurrencyCap?: number | null
}
export type GateReason = 'billing_inactive' | 'too_many_calls' | 'no_balance'
export type GateAnswer = { allow: true } | { allow: false; reason: GateReason }

/**
 * "Can this call start?" (docs/billing.md §4.4): the bill is in service, below its concurrency cap (an instance admin's
 * cap, else the rules' cap, in the trial at most `trialConcurrentCalls`), and the balance
 * less every running call's reservation and this one's stays at or above −buffer (0 in the trial). A comped bill
 * pays nothing, so only the cap applies.
 */
export function callGate(bill: GateBill, needMicros: number, rules: BillingRules = BILLING_DEFAULTS): GateAnswer {
  if (!['trialing', 'active', 'past_due', 'comped'].includes(bill.status))
    return { allow: false, reason: 'billing_inactive' }
  const trialing = bill.status === 'trialing'
  const ruled = concurrentCallCap(bill.extraCalls, rules)
  if (bill.running >= (bill.concurrencyCap ?? (trialing ? Math.min(ruled, rules.trialConcurrentCalls) : ruled)))
    return { allow: false, reason: 'too_many_calls' }
  if (bill.status === 'comped') return { allow: true }
  const buffer = trialing ? 0 : rules.balanceBufferMicros
  if (bill.balanceMicros - bill.reservedMicros - needMicros < -buffer) return { allow: false, reason: 'no_balance' }
  return { allow: true }
}

export type RechargeBill = {
  status: string
  autoRecharge: boolean
  thresholdCents: number
  amountCents: number
  capBaseCents: number
  workspaces: number
  extraNumbers: number
  /** A recharge is pending (its invoice not yet paid or failed). */
  pending: boolean
  /** The last recharge failed and waits for a new card or the owner's Retry. */
  failedWaiting: boolean
  availableMicros: number
  /** Pending, failed-but-payable and paid recharges created this UTC calendar month. */
  usedThisMonthCents: number
}
export type RechargeAnswer = { kind: 'none' } | { kind: 'recharge'; amountCents: number } | { kind: 'cap_reached' }

/** The monthly recharge cap with the extra numbers: each adds its price, so number months never use up the cap meant for calls. */
export const rechargeCapWithNumbers = (bill: RechargeBill, rules: BillingRules = BILLING_DEFAULTS) =>
  rechargeCapCents(bill.capBaseCents, bill.workspaces, rules) + rules.extraNumberCents * Math.max(0, bill.extraNumbers)

/**
 * The recharge decision (docs/billing.md §4.3): below the threshold, recharge the amount, cut to what the monthly cap
 * leaves; under the $20 minimum the cap is reached. Never in the trial (no off-session charge before conversion),
 * never with one pending or a failure waiting for the owner.
 */
export function rechargeDecision(bill: RechargeBill, rules: BillingRules = BILLING_DEFAULTS): RechargeAnswer {
  if (!bill.autoRecharge || !['active', 'past_due'].includes(bill.status)) return { kind: 'none' }
  if (bill.pending || bill.failedWaiting) return { kind: 'none' }
  if (bill.availableMicros >= bill.thresholdCents * 10_000) return { kind: 'none' }
  const amountCents = Math.min(bill.amountCents, rechargeCapWithNumbers(bill, rules) - bill.usedThisMonthCents)
  return amountCents < RECHARGE_LIMITS.amountCents.min ? { kind: 'cap_reached' } : { kind: 'recharge', amountCents }
}
