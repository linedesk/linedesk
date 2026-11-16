// The install's billing rules (docs/billing.md §7a): prices, the included allowance and the abuse limits, read from
// the instance setting `billing.rules` (one JSON row) over `BILLING_DEFAULTS`, which are Linedesk Cloud's. A
// self-hosted partner billing its own clients sets its own here. Each field is checked against a range; a row that
// does not parse, or a field out of range, falls back to the default for that field and is logged, never thrown, so a
// bad setting never stops calls.
import { BILLING_DEFAULTS, type BillingRules, instance_settings, PAID_LEVELS, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

export const BILLING_RULES_KEY = 'billing.rules'

const count = (min: number, max: number) => z.number().int().min(min).max(max)
const level = z.object({ microsPerMinute: count(0, 10_000_000), allowanceFactor: count(1, 10).nullable() }).strict()
const FIELDS = {
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
