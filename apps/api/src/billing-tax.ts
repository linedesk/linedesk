// The install's Stripe Tax switch on running subscriptions (LIN-459; security review of #1105, M-1). Checkout gives a
// subscription the switch as it was then; when an instance admin changes it (billingRules.set), this sets
// `automatic_tax` on every running subscription of the install's bills, so plan invoices and recharges are taxed alike.
// Idempotent: a subscription that already matches is left alone. With tax on, a subscription whose customer has no
// address Stripe can tax stays untaxed (its next invoice would fail to finalize otherwise); the nightly reconciliation
// runs this again, so it is taxed once the customer adds an address. Each run logs what it did.
import type { BillingProvider, SubscriptionTaxSync } from '@linedesk/billing'
import { billing_accounts, type Db } from '@linedesk/db'
import { and, inArray, isNotNull } from 'drizzle-orm'
import { billingRules } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'

/** Bill statuses whose subscription still makes invoices. */
const RUNNING = ['trialing', 'active', 'past_due'] as const

export type TaxSyncResult = Record<SubscriptionTaxSync | 'failed', number> & { enabled: boolean }

/**
 * Sets automatic tax on every running subscription to the switch. Skipped (null) while billing through Stripe is not
 * in effect. One subscription Stripe could not be asked about is counted as `failed` and logged; the others go on.
 */
export async function syncSubscriptionTax(
  db: Db,
  options: { provider?: BillingProvider } = {},
): Promise<TaxSyncResult | null> {
  if (!options.provider && (await billingState(db)).inEffect === 'none') return null
  const provider = options.provider ?? (await billingProvider(db))
  if (provider.name === 'none') return null
  const enabled = (await billingRules(db)).automaticTax
  const bills = await db
    .select({ id: billing_accounts.id, subscription: billing_accounts.stripe_subscription_id })
    .from(billing_accounts)
    .where(and(inArray(billing_accounts.status, [...RUNNING]), isNotNull(billing_accounts.stripe_subscription_id)))
  const result: TaxSyncResult = { enabled, updated: 0, unchanged: 0, no_address: 0, gone: 0, failed: 0 }
  for (const bill of bills) {
    try {
      const done = await provider.syncSubscriptionTax(bill.subscription!, enabled)
      result[done]++
      if (done === 'updated')
        console.log(`billing: subscription of bill ${bill.id}: automatic tax ${enabled ? 'on' : 'off'}`)
    } catch (error) {
      result.failed++
      console.error(`billing: subscription of bill ${bill.id}: automatic tax not set:`, error)
    }
  }
  console.log(`billing: subscription tax sync (${enabled ? 'on' : 'off'}): ${JSON.stringify(result)}`)
  return result
}

/** Runs the sync after the switch's change committed; a failure is logged (the nightly reconciliation runs it again). */
export function syncSubscriptionTaxAfterCommit(db: Db, onCommit: ((work: () => Promise<void>) => void) | undefined) {
  const run = async () => {
    await syncSubscriptionTax(db).catch(e => console.error('billing: subscription tax sync failed:', e))
  }
  if (onCommit) onCommit(run)
  else void run()
}

/** How long a count of customers without a tax address is reused (security review of #1105, N-1). */
export const TAX_ADDRESS_COUNT_MS = 5 * 60_000
/**
 * How long a count Stripe failed to answer is reused (null): an admin key asking in a loop while Stripe is slow or down
 * does not send a read per customer on every call (security review of #1110, R-3). Short, so the dialog recovers soon.
 */
export const TAX_ADDRESS_FAILED_MS = 60_000

let counted: { customers: string; at: number; count: number | null } | null = null
/** The count being asked of Stripe now: a second call for the same customers waits for it instead of asking again. */
let asking: { customers: string; count: Promise<number | null> } | null = null

/** Forgets the last count (tests). */
export function resetTaxAddressCount() {
  counted = null
  asking = null
}

/**
 * How many paying customers Stripe Tax cannot tax (no billing address), for the admin before turning tax on. Asked
 * only when the confirm dialog needs it (`billing.adminTaxAddressMissing`), never on a read of the rules, and never
 * inside a transaction: the customer ids are read first, then Stripe is asked for exactly those (security review of
 * #1105, N-1). The answer is kept for TAX_ADDRESS_COUNT_MS for the same customers, so opening the dialog again, or a
 * read-scoped key asking in a loop, does not use up the Stripe rate limit recharges share; a failure (null) is kept
 * for TAX_ADDRESS_FAILED_MS. Null: billing is off, or Stripe could not be asked.
 */
export async function customersWithoutTaxAddress(
  db: Db,
  options: { provider?: BillingProvider; now?: number } = {},
): Promise<number | null> {
  if (!options.provider && (await billingState(db)).inEffect === 'none') return null
  const provider = options.provider ?? (await billingProvider(db))
  if (provider.name === 'none') return null
  const rows = await db
    .select({ customer: billing_accounts.stripe_customer_id })
    .from(billing_accounts)
    .where(and(inArray(billing_accounts.status, [...RUNNING]), isNotNull(billing_accounts.stripe_customer_id)))
  const ids = [...new Set(rows.map(r => r.customer!))].sort()
  const customers = ids.join(',')
  const now = options.now ?? Date.now()
  if (counted && counted.customers === customers) {
    const kept = counted.count === null ? TAX_ADDRESS_FAILED_MS : TAX_ADDRESS_COUNT_MS
    if (now - counted.at < kept) return counted.count
  }
  if (asking?.customers === customers) return asking.count
  const count = (async () => {
    try {
      return ids.length ? await provider.customersWithoutTaxAddress(ids) : 0
    } catch (error) {
      console.error('billing: customers without a tax address could not be counted:', error)
      return null
    }
  })()
  asking = { customers, count }
  try {
    const answer = await count
    counted = { customers, at: now, count: answer }
    return answer
  } finally {
    if (asking?.count === count) asking = null
  }
}
