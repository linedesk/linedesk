// Calls at the same time (LIN-450, docs/billing.md §2.1c): the bill's extra-calls item on its plan subscription.
//
// Every change of a bill's extra calls (the owner's `billing.setExtraCalls`, an instance admin's workspace move) runs
// under the bill's own `extra-calls:<bill>` lock, never the balance lock the call gate waits on (security review of
// #1103, L-2): Stripe answers slowly, calls must not wait for it.

import type { BillingProvider } from '@linedesk/billing'
import {
  billing_accounts,
  type BillingRules,
  EXTRA_CALLS_STEP,
  maxExtraCalls,
  organization,
  type Tx,
} from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { syncedPrices } from './billing-catalog.ts'
import { db } from './db.ts'
import { extraCallsSyncAlert } from './emails/alerts.ts'

type Bill = typeof billing_accounts.$inferSelect

/** Serializes the changes of one bill's extra calls, until the transaction ends. */
export const lockExtraCalls = (tx: Pick<Tx, 'execute'>, billId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`extra-calls:${billId}`}))`)

/** The sum of the extra calls over the bill's workspaces: the item's quantity. */
export async function extraCallsSum(tx: Pick<Tx, 'select'>, billId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${organization.extraCalls}), 0)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return row?.n ?? 0
}

/**
 * What the bill already paid for this subscription period (security review of #1103, M-1): the highest quantity paid
 * until `extra_calls_paid_until`, and at least what is on the bill now (the renewal charged it). A new period (another
 * period end) starts from the quantity now.
 */
export const paidExtraCalls = (bill: Bill, quantityNow: number, now: string): number =>
  Math.max(
    quantityNow,
    // Our period end moves only once the renewal's invoice.paid arrived, up to about an hour after Stripe started the
    // new period: past it, nothing counts as paid (security review of #1103, V-1).
    !periodEnded(bill, now) &&
      bill.extra_calls_paid_until &&
      bill.current_period_end &&
      Date.parse(bill.extra_calls_paid_until) === Date.parse(bill.current_period_end)
      ? bill.extra_calls_paid
      : 0,
  )

/** Our stored period end is past: Stripe renewed, the renewal's webhook has not reached us yet. */
export const periodEnded = (bill: Bill, now: string) =>
  !!bill.current_period_end && Date.parse(bill.current_period_end) <= Date.parse(now)

/** What the bill has paid for once `quantity` went through: kept for the rest of the period. */
export const paidAfter = (bill: Bill, paid: number, quantity: number) => ({
  extra_calls_paid: Math.max(paid, quantity),
  extra_calls_paid_until: bill.current_period_end,
})

/** The synced extra-calls price of the bill's interval, or null while the catalog has none. */
export async function extraCallsPriceId(tx: Pick<Tx, 'select'>, interval: 'month' | 'year') {
  return (await syncedPrices(tx))?.[`extra_calls_${interval}ly`] ?? null
}

/**
 * Sets the bill's extra-calls item to the sum stored now, in a short transaction of its own under the bill's lock, so
 * it never writes a sum older than another change (security review of #1103, L-3). For work after a commit: a lowering
 * (`charge: false`, never refunded) or a workspace move (the target is charged above what it paid this period). A
 * failure is logged and emailed to the instance admins; the nightly reconciliation reports the difference too.
 */
export async function syncExtraCallsItem(
  provider: BillingProvider,
  billId: string,
  { charge, key }: { charge: boolean; key: string },
) {
  try {
    await db.transaction(async tx => {
      await lockExtraCalls(tx, billId)
      const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
      if (!bill?.stripe_subscription_id) return
      const quantity = await extraCallsSum(tx, billId)
      const priceId = await extraCallsPriceId(tx, bill.interval)
      // i18n-ignore: a log line and the admins' alert reason, never shown to a customer
      if (!priceId) throw new Error('the extra-calls prices are not synced')
      const paid = paidExtraCalls(bill, 0, new Date().toISOString())
      const answer = await provider.setExtraCallsQuantity({
        subscriptionId: bill.stripe_subscription_id,
        priceId,
        quantity,
        paidUpTo: paid,
        charge,
        idempotencyKey: `${key}:${billId}`,
      })
      // i18n-ignore: a log line and the admins' alert reason, never shown to a customer
      if (answer === 'payment_failed') throw new Error('the card was refused')
      if (charge && answer === 'updated')
        await tx
          .update(billing_accounts)
          .set(paidAfter(bill, paid, quantity))
          .where(eq(billing_accounts.id, billId))
    })
  } catch (error) {
    console.error(`ALERT billing extra calls: bill ${billId} not updated in Stripe (${key})`, error)
    await alertInstanceAdmins(extraCallsSyncAlert(billId)).catch(e =>
      console.error('billing: the extra-calls alert could not be sent:', e),
    )
  }
}

/**
 * Whether the owner can add `EXTRA_CALLS_STEP` more calls at the same time to a workspace that has `extraCalls` now: a
 * paid plan (not the trial) that does not end at the period end, no instance admin's cap for the bill, and below the
 * most a workspace may have. The busy-line banner's and email's one button (LIN-450).
 */
export const canAddCallsStep = (bill: Bill, extraCalls: number, rules: BillingRules) =>
  bill.status === 'active' &&
  !!bill.stripe_subscription_id &&
  !bill.cancel_at_period_end &&
  bill.concurrent_calls_cap == null &&
  extraCalls + EXTRA_CALLS_STEP <= maxExtraCalls(rules)
