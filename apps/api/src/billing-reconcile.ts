// The nightly reconciliation with Stripe, next to the ledger check (ledger.ts `checkLedger`,
// which rebuilds and compares the balances and counters). It catches what the webhook missed and what drifted:
//
// - the events of the last 3 days (Stripe keeps 30) that never reached the inbox are stored and processed now; when
//   Stripe lists more than the run reads, that is reported (review of #865, L5);
// - recharge attempts pending for more than 24 hours are settled from their invoice: paid is credited, failed or
//   voided goes through PR 4's failed-recharge rules (rechargeFailed). The admins already hear of every attempt
//   pending for more than 2 hours from PR 4's stuck-recharge alert (hourly, and nightly for all), so this run reports
//   none itself: one alert, one settlement (review of #865, M1);
// - refunds from the balance still pending after a few minutes (their action failed after Stripe was asked) are
//   settled from Stripe: one Stripe made is posted now and reported, one Stripe never made is voided (review of
//   #919, M2);
// - every bill with a subscription is compared with Stripe: status, period, seats, and the card a recharge charges;
// - events that failed five times are counted; stored events older than 90 days are removed, billing on or off (L4).
//
// Differences are reported to the instance admins, never "fixed" from Stripe's side here: a status or quantity change
// has its own path (the webhook, the dunning jobs, the admin actions).
import { type BillingProvider, type BillingSubscription, WEBHOOK_EVENTS } from '@linedesk/billing'
import {
  billing_accounts,
  billing_recharges,
  billing_refunds,
  organization,
  stripe_events,
  type Tx,
  EXTRA_CALLS_LOOKUP_PREFIX,
} from '@linedesk/db'
import { and, eq, gte, isNotNull, isNull, like, lt, not, or, sql } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { settlePendingRefunds } from './billing-admin.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { db } from './db.ts'
import { billingReconcileAlert, type ReconcileFinding } from './emails/billing-alerts.ts'
import { extraCallsOnBill, lockBalance } from './ledger.ts'
import { syncSubscriptionTax } from './billing-tax.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import {
  failRechargeInvoice,
  pruneStripeEvents,
  runAsBillingSystem,
  STRIPE_EVENT_ATTEMPTS,
  storeStripeEvent,
} from './stripe-events.ts'

export const BILLING_RECONCILE = 'billing.reconcile'
const BILLING_RECONCILE_CRON = '17 4 * * *'
/** How far back the events are compared (Stripe keeps 30 days). */
export const RECONCILE_EVENT_DAYS = 3
/** A recharge attempt still pending after this long is settled from Stripe (its idempotency key has expired). */
export const SETTLE_RECHARGE_AFTER_MS = 24 * 3_600_000
/** The most events one run reads per group of types; more is reported (events_truncated), never dropped silently. */
export const RECONCILE_EVENT_LIMIT = 9_999

/** The Stripe subscription statuses each bill status expects (`comped` and `pending_payment` are not compared). */
const EXPECTED_STATUS: Partial<Record<(typeof billing_accounts.$inferSelect)['status'], readonly string[]>> = {
  trialing: ['trialing'],
  active: ['active'],
  past_due: ['past_due'],
  suspended: ['past_due', 'unpaid'],
  canceled: ['canceled', 'incomplete_expired'],
}

/** The seat items of a subscription: the workspace prices (`ws_…`). */
const seats = (sub: BillingSubscription) =>
  sub.items.filter(i => i.lookupKey?.startsWith('ws_')).reduce((sum, i) => sum + i.quantity, 0)
/** The extra calls at once a subscription charges (LIN-450): its extra-calls item's quantity. */
const extraCallsBilled = (sub: BillingSubscription) =>
  sub.items.filter(i => i.lookupKey?.startsWith(EXTRA_CALLS_LOOKUP_PREFIX)).reduce((sum, i) => sum + i.quantity, 0)

const sameTime = (a: string | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime())

/** Missed events: Stripe's list of the last days against the inbox; each missing one is stored and queued. */
async function missedEvents(provider: BillingProvider, now: Date, limit: number) {
  const since = Math.floor(now.getTime() / 1000) - RECONCILE_EVENT_DAYS * 86_400
  const { events, truncated } = await provider.recentEvents(since, WEBHOOK_EVENTS, limit)
  let missed = 0
  for (const event of events) {
    const outcome = await db.transaction(tx => storeStripeEvent(tx, event, now.toISOString()))
    if (outcome === 'stored') missed++
  }
  return { missed, truncated }
}

/**
 * Recharge attempts pending for more than a day, settled from their invoice as Stripe has it now: paid is credited
 * (billing.settleInvoice, the invoice.paid rules), failed or voided gets the failed-recharge rules. Anything else stays
 * pending; PR 4's stuck-recharge alert names it.
 */
async function settleOldRecharges(provider: BillingProvider, now: Date) {
  const old = await db
    .select()
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.status, 'pending'),
        lt(billing_recharges.created_at, new Date(now.getTime() - SETTLE_RECHARGE_AFTER_MS).toISOString()),
      ),
    )
  let settled = 0
  for (const recharge of old) {
    const invoiceId = recharge.stripe_invoice_id ?? (await provider.findRechargeInvoice(recharge.id))
    const invoice = invoiceId ? await provider.invoice(invoiceId) : null
    if (!invoice) continue
    if (invoice.status === 'paid') {
      const result = await runAsBillingSystem('billing.settleInvoice', {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
      })
      if (result.body.ok && (result.body.data as { credited?: unknown }).credited) settled++
    } else if (await failRechargeInvoice(provider, invoice, recharge, now.toISOString(), false)) settled++
  }
  return settled
}

/**
 * Refunds from the balance whose action did not finish (billing-admin.ts `settlePendingRefunds`): each bill's under its
 * balance lock. A refund Stripe made without its ledger entry is posted now and reported.
 */
async function settleRefunds(provider: BillingProvider, now: Date): Promise<ReconcileFinding[]> {
  const bills = await db
    .selectDistinct({ id: billing_refunds.billing_account_id })
    .from(billing_refunds)
    .where(eq(billing_refunds.status, 'pending'))
  const findings: ReconcileFinding[] = []
  for (const { id } of bills) {
    const { posted } = await db.transaction(async tx => {
      await lockBalance(tx, id)
      return settlePendingRefunds(tx, provider, id, now.toISOString())
    })
    for (const p of posted) findings.push({ kind: 'refund', bill: id, ours: p.refundId, stripe: p.creditNoteId })
  }
  return findings
}

/** Every bill with a subscription against Stripe's: status, period, seats, the card a recharge charges. */
async function billsAgainstStripe(provider: BillingProvider): Promise<ReconcileFinding[]> {
  const bills = await db.select().from(billing_accounts).where(isNotNull(billing_accounts.stripe_subscription_id))
  const findings: ReconcileFinding[] = []
  for (const bill of bills) {
    const sub = await provider.subscription(bill.stripe_subscription_id!)
    // A dispute or fraud-warning suspension leaves the subscription as it is (paid): not compared (PR 11).
    const expected =
      bill.status === 'suspended' && bill.suspend_reason !== 'payment' ? undefined : EXPECTED_STATUS[bill.status]
    if (!sub) {
      if (expected) findings.push({ kind: 'status', bill: bill.id, ours: bill.status, stripe: 'missing' })
      continue
    }
    if (expected && !expected.includes(sub.status))
      findings.push({ kind: 'status', bill: bill.id, ours: bill.status, stripe: sub.status })
    if (bill.status === 'canceled') continue
    if (
      bill.current_period_end &&
      (!sameTime(bill.current_period_start, sub.currentPeriodStart) ||
        !sameTime(bill.current_period_end, sub.currentPeriodEnd))
    )
      findings.push({
        kind: 'period',
        bill: bill.id,
        ours: `${bill.current_period_start} – ${bill.current_period_end}`,
        stripe: `${sub.currentPeriodStart} – ${sub.currentPeriodEnd}`,
      })
    const [workspaces] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(organization)
      .where(eq(organization.billingAccountId, bill.id))
    if ((workspaces?.n ?? 0) !== seats(sub))
      findings.push({ kind: 'quantity', bill: bill.id, ours: String(workspaces?.n ?? 0), stripe: String(seats(sub)) })
    const extraCalls = (await extraCallsOnBill(db, bill.id)).reduce((sum, n) => sum + n, 0)
    if (extraCalls !== extraCallsBilled(sub))
      findings.push({
        kind: 'quantity',
        bill: bill.id,
        ours: `extra calls ${extraCalls}`,
        stripe: `extra calls ${extraCallsBilled(sub)}`,
      })
    // Auto-recharge charges what the recharge itself charges: the customer's invoice default, else the subscription's
    // card (which the recharge then makes the default). Not the subscription's card alone: Checkout leaves the
    // customer's default empty, and this check said "fine" while every recharge failed (billing review of 16.11., B2).
    if (
      bill.auto_recharge &&
      (bill.status === 'active' || bill.status === 'past_due') &&
      !(await provider.rechargeCard(bill.stripe_customer_id ?? sub.customerId, bill.stripe_subscription_id))
    )
      findings.push({ kind: 'payment_method', bill: bill.id, ours: 'auto_recharge', stripe: 'none' })
  }
  return findings
}

async function failedEvents(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stripe_events)
    .where(
      and(
        isNull(stripe_events.processed_at),
        gte(stripe_events.attempts, STRIPE_EVENT_ATTEMPTS),
        // Not the ones left for a later release on purpose (stripe-events.ts UNHANDLED_*).
        or(isNull(stripe_events.last_error), not(like(stripe_events.last_error, 'unhandled:%'))),
      ),
    )
  return row?.n ?? 0
}

/**
 * One reconciliation run. Skipped while billing is not in effect. Returns what it found (and alerts on it); a throw
 * alerts too, so a broken run is never silent.
 */
export async function reconcileBilling(now = new Date(), options: { eventLimit?: number } = {}) {
  const eventLimit = options.eventLimit ?? RECONCILE_EVENT_LIMIT
  // The stored events go after 90 days whether billing is on or not (they hold Stripe ids of customers).
  const pruned = await db.transaction(tx => pruneStripeEvents(tx, now))
  if ((await billingState(db)).inEffect === 'none') return { findings: [], pruned, billing: 'off' as const }
  await db.transaction((tx: Tx) => requireLedgerGuards(tx))
  const provider = await billingProvider(db)
  const { missed, truncated } = await missedEvents(provider, now, eventLimit)
  const settled = await settleOldRecharges(provider, now)
  const findings: ReconcileFinding[] = [
    ...(missed ? [{ kind: 'missed_events' as const, count: missed }] : []),
    ...(truncated ? [{ kind: 'events_truncated' as const, count: eventLimit }] : []),
    ...(await settleRefunds(provider, now)),
    ...(await billsAgainstStripe(provider)),
  ]
  const failed = await failedEvents()
  if (failed) findings.push({ kind: 'failed_events', count: failed })
  // The Stripe Tax switch on running subscriptions: catches a sync that failed after the change, and subscriptions
  // left untaxed for a missing address once the customer added one (billing-tax.ts; security review of #1105, M-1).
  const taxSync = await syncSubscriptionTax(db, { provider }).catch(error => {
    console.error('billing reconciliation: subscription tax sync failed:', error)
    return null
  })
  if (findings.length) {
    console.error(`billing reconciliation: ${findings.length} findings (${JSON.stringify(findings)})`)
    await alertInstanceAdmins(billingReconcileAlert(findings))
  }
  return { findings, pruned, settled, taxSync }
}

export async function createReconcileQueue(instance: PgBoss) {
  await instance.createQueue(BILLING_RECONCILE, { retryLimit: 0, expireInSeconds: 1800 })
}

export async function runReconcileJob(instance: PgBoss) {
  await instance.schedule(BILLING_RECONCILE, BILLING_RECONCILE_CRON)
  await instance.work(BILLING_RECONCILE, async () => {
    try {
      const result = await reconcileBilling()
      return { findings: result.findings.length, pruned: result.pruned, billing: 'billing' in result ? 'off' : 'on' }
    } catch (error) {
      // retryLimit 0: without this the run would fail silently until tomorrow (security review of #857, L4).
      console.error('billing reconciliation failed:', error)
      await alertInstanceAdmins(
        billingReconcileAlert([
          { kind: 'run_failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) },
        ]),
      ).catch(() => {})
      throw error
    }
  })
}
