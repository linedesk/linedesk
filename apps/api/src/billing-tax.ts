// The install's Stripe Tax switch on running subscriptions (LIN-459; security review of #1105, M-1). Checkout gives a
// subscription the switch as it was then; when an instance admin changes it (billingRules.set), this sets
// `automatic_tax` on every running subscription of the install's bills, so plan invoices and recharges are taxed alike.
// Idempotent: a subscription that already matches is left alone. With tax on, a subscription whose customer has no
// address Stripe can tax stays untaxed (its next invoice would fail to finalize otherwise); the nightly reconciliation
// runs this again, so it is taxed once the customer adds an address. Each run logs what it did.
import type { BillingProvider, SubscriptionTaxSync } from '@linedesk/billing'
import { billing_accounts, type Db, type Tx } from '@linedesk/db'
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

/**
 * How many paying customers Stripe Tax cannot tax (no billing address), for the admin before turning tax on. Null:
 * billing is off, or Stripe could not be asked.
 */
export async function customersWithoutTaxAddress(tx: Tx | Db): Promise<number | null> {
  if ((await billingState(tx)).inEffect === 'none') return null
  const provider = await billingProvider(tx)
  if (provider.name === 'none') return null
  const rows = await tx
    .select({ customer: billing_accounts.stripe_customer_id })
    .from(billing_accounts)
    .where(and(inArray(billing_accounts.status, [...RUNNING]), isNotNull(billing_accounts.stripe_customer_id)))
  try {
    return await provider.customersWithoutTaxAddress(rows.map(r => r.customer!))
  } catch (error) {
    console.error('billing: customers without a tax address could not be counted:', error)
    return null
  }
}
