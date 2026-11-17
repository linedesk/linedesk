// The install's billing rules (docs/billing.md §7a): the plan prices and the trial, the call prices, the included
// allowance and the abuse limits, read from the instance setting `billing.rules` (one JSON row) over
// `BILLING_DEFAULTS` (Linedesk Cloud's values). Every install that bills its own workspaces sets its own here
// (Server admin › Billing). Each field is checked against a range; a row that
// does not parse, or a field out of range, falls back to the default for that field and is logged, never thrown, so a
// bad setting never stops calls.
import type { BillingSubscription, PlanCatalog } from '@linedesk/billing'
import {
  BILLING_DEFAULTS,
  type BillingRules,
  instance_settings,
  PAID_LEVELS,
  PLAN_PRICES,
  planPrices,
  planProducts,
  STRIPE_TAX_CODE,
  type Tx,
} from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

export const BILLING_RULES_KEY = 'billing.rules'

const count = (min: number, max: number) => z.number().int().min(min).max(max)
const level = z.object({ microsPerMinute: count(0, 10_000_000), allowanceFactor: count(1, 10).nullable() }).strict()
/** A plan fee in cents: at least Stripe's smallest USD charge ($0.50), at most $100,000. */
const planCents = count(50, 10_000_000)
const FIELDS = {
  workspaceMonthlyCents: planCents,
  workspaceYearlyCents: planCents,
  partnerMonthlyCents: planCents,
  partnerYearlyCents: planCents,
  // At least a day: the sign-up flow always starts with a trial (a bill without one starts on a paid plan).
  trialDays: count(1, 90),
  includedStandardSeconds: count(0, 1_000_000),
  balanceBufferMicros: count(0, 100_000_000),
  trialConcurrentCalls: count(1, 1000),
  concurrentCallsBase: count(1, 1000),
  concurrentCallsPerWorkspace: count(0, 1000),
  billedTransferCapSeconds: count(60, 7200),
  callLimitGraceSeconds: count(0, 3600),
  extraNumberCents: count(0, 100_000),
  rechargeCapPerWorkspaceCents: count(0, 1_000_000),
} satisfies Partial<Record<keyof BillingRules, z.ZodType>>

/** `stored` over the defaults, field by field; `problems` names what was ignored. */
export function mergeBillingRules(stored: unknown): { rules: BillingRules; problems: string[] } {
  const rules: BillingRules = { ...BILLING_DEFAULTS, levels: { ...BILLING_DEFAULTS.levels } }
  const problems: string[] = []
  if (stored === undefined) return { rules, problems }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    return { rules, problems: ['not an object'] }
  const input = stored as Record<string, unknown>
  for (const [key, value] of Object.entries(input)) {
    if (key === 'levels') continue
    const schema = FIELDS[key as keyof typeof FIELDS]
    const parsed = schema?.safeParse(value)
    if (parsed?.success) (rules as Record<string, unknown>)[key] = parsed.data
    else problems.push(key)
  }
  if (input.levels !== undefined) {
    const isObject = typeof input.levels === 'object' && input.levels !== null && !Array.isArray(input.levels)
    if (!isObject) problems.push('levels')
    const levels = isObject ? (input.levels as Record<string, unknown>) : {}
    for (const [name, value] of Object.entries(levels)) {
      const parsed = level.safeParse(value)
      if ((PAID_LEVELS as readonly string[]).includes(name) && parsed.success)
        rules.levels[name as keyof typeof rules.levels] = parsed.data
      else problems.push(`levels.${name}`)
    }
  }
  return { rules, problems }
}

/**
 * The lowest price per minute an admin may set for a level (docs/billing.md §11, PR 13): the server's
 * BILLING_MIN_MICROS_PER_MINUTE (Linedesk Cloud sets it, so a mistyped 0 never gives calls away); 0 without it, so a
 * self-hosted partner may charge nothing.
 */
export function minMicrosPerMinute(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.BILLING_MIN_MICROS_PER_MINUTE ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Checks rules an instance admin is about to store (Server admin › Billing): unlike `mergeBillingRules`, which keeps a
 * running install going whatever the row holds, anything unknown, out of range or below the server's minimum price
 * refuses the whole change. Answers the problems, or the rules to store (only the fields given).
 */
export function checkBillingRules(
  input: Record<string, unknown>,
  minMicros = minMicrosPerMinute(),
): { problems: string[] } | { problems: []; stored: Record<string, unknown> } {
  const problems: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (key === 'levels') continue
    const schema = FIELDS[key as keyof typeof FIELDS]
    if (!schema?.safeParse(value).success) problems.push(key)
  }
  if (input.levels !== undefined) {
    const levels = input.levels
    if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) problems.push('levels')
    else
      for (const [name, value] of Object.entries(levels)) {
        const parsed = level.safeParse(value)
        if (!(PAID_LEVELS as readonly string[]).includes(name) || !parsed.success) problems.push(`levels.${name}`)
        else if (parsed.data.microsPerMinute < minMicros) problems.push(`levels.${name}.microsPerMinute`)
      }
  }
  return problems.length ? { problems } : { problems: [], stored: input }
}

/**
 * The row to store when an admin saves rules: the stored row with the given fields over it, a field given as null
 * removed (back to its default; a level likewise). A caller that leaves fields out (an older admin tab, an MCP or
 * API client) never resets them, plan prices included (security review of #1040, I-6).
 */
export function mergeStoredRules(
  stored: Record<string, unknown> | null,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(stored ?? {}) }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'levels' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const before = next.levels
      const levels: Record<string, unknown> =
        before && typeof before === 'object' && !Array.isArray(before) ? { ...(before as object) } : {}
      for (const [name, level] of Object.entries(value)) {
        if (level === null) delete levels[name]
        else levels[name] = level
      }
      if (Object.keys(levels).length) next.levels = levels
      else delete next.levels
    } else if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

/** The given fields without the nulls (a null is a reset to the default, not a value to check). */
export function withoutResets(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === null) continue
    if (key === 'levels' && value && typeof value === 'object' && !Array.isArray(value)) {
      const levels = Object.fromEntries(Object.entries(value).filter(([, level]) => level !== null))
      if (Object.keys(levels).length) out.levels = levels
    } else out[key] = value
  }
  return out
}

/** The rule fields that make the Stripe catalog: a save that changes one syncs it (security review of #1040, M-1). */
export const PLAN_RULE_FIELDS: ReadonlySet<string> = new Set([
  'workspaceMonthlyCents',
  'workspaceYearlyCents',
  'partnerMonthlyCents',
  'partnerYearlyCents',
])

/**
 * The lowest monthly plan fee an admin may set (security review of #1040, L-6): the server's BILLING_MIN_PLAN_CENTS,
 * else what a seat's included minutes cost at the Standard price (default: 50 minutes at 5¢ = $2.50), so a mistyped
 * fee never sells seats below the minutes they include. A yearly fee: at least 12 times this.
 */
export function minPlanCents(rules: BillingRules, env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.BILLING_MIN_PLAN_CENTS ?? '')
  if (Number.isSafeInteger(value) && value > 0) return value
  const micros = (rules.includedStandardSeconds * rules.levels.standard.microsPerMinute) / 60
  return Math.max(50, Math.ceil(micros / 10_000))
}

/**
 * The plan fees of rules about to be in effect: each at least the floor (`minPlanCents`; yearly 12 times it), and a
 * yearly fee never more than 12 monthly ones. Answers the fields that break a rule.
 */
export function planPriceProblems(rules: BillingRules, env: Record<string, string | undefined> = process.env) {
  const floor = minPlanCents(rules, env)
  const problems: string[] = []
  for (const plan of ['workspace', 'partner'] as const) {
    const monthly = rules[`${plan}MonthlyCents`]
    const yearly = rules[`${plan}YearlyCents`]
    if (monthly < floor) problems.push(`${plan}MonthlyCents`)
    if (yearly < 12 * floor || yearly > 12 * monthly) problems.push(`${plan}YearlyCents`)
  }
  return problems
}

/** The rules in effect on this install. */
export async function billingRules(tx: Pick<Tx, 'select'>): Promise<BillingRules> {
  const [row] = await tx
    .select({ value: instance_settings.value })
    .from(instance_settings)
    .where(eq(instance_settings.key, BILLING_RULES_KEY))
  if (!row) return mergeBillingRules(undefined).rules
  let stored: unknown
  try {
    stored = JSON.parse(row.value)
  } catch {
    stored = null
  }
  const { rules, problems } = mergeBillingRules(stored)
  if (problems.length)
    console.error(`billing rules: ignored ${problems.join(', ')} of ${BILLING_RULES_KEY}; using the defaults there`)
  return rules
}

/**
 * What the install sells in Stripe (docs/billing.md §2.1, §7b): the products named with the install's product name
 * and the plan prices of its rules, in USD. The billing provider makes or finds them in the connected Stripe account
 * before a Checkout (`PlanCatalog`), so any Stripe account works without a setup script for prices.
 */
export const planCatalog = (rules: BillingRules, brand: string): PlanCatalog => ({
  products: planProducts(brand),
  prices: planPrices(rules),
  taxCode: STRIPE_TAX_CODE,
  currency: 'usd',
})

/**
 * The text on a recharge invoice's line, with the install's product name ("Front Desk balance recharge"). Stripe shows
 * it to the customer as written (not translated, like the invoice).
 */
// i18n-ignore: the Stripe invoice line, in the Stripe account's invoice language
export const rechargeLine = (brand: string) => `${brand} balance recharge`

/** Every plan lookup key a Linedesk subscription may have. */
const PLAN_LOOKUP_KEYS: ReadonlySet<string> = new Set(PLAN_PRICES.map(p => p.lookupKey))
/** The Stripe products of the plans: our own ids, which never change (unlike price ids). */
const PLAN_PRODUCT_IDS: ReadonlySet<string> = new Set(['linedesk_workspace', 'linedesk_partner'])

/**
 * A subscription of only our plan prices: every item has a plan lookup key (or its `metadata.linedesk`) **and** its
 * price belongs to one of our plan products. Lookup keys are generic (`ws_monthly`): in a Stripe account shared with
 * another integration, its prices may carry the same ones (security review of #1040, L-1).
 */
export const isLinedeskPlan = (sub: BillingSubscription) =>
  sub.items.length > 0 &&
  sub.items.every(
    i => !!i.lookupKey && PLAN_LOOKUP_KEYS.has(i.lookupKey) && !!i.productId && PLAN_PRODUCT_IDS.has(i.productId),
  )
