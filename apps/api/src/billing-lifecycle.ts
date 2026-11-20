// The bill's life after a failed plan payment, a dispute or a cancellation:
//
// - A plan invoice that failed makes the bill `past_due` (calls answered as normal; the balance and the gate apply).
//   From the event's job (stripe-events.ts), with the invoice and the subscription fetched from Stripe first.
// - The hourly dunning job (`billing.dunning`): 7 days after the failure (3 for the first payment after the trial) the
//   bill is `suspended` with the reason `payment` (calls get the fixed line through the refused-call path, reason
//   `billing_inactive`); reminders on day 14 and 21; on day 30 our job cancels the subscription and the bill is
//   `canceled`; 30 days after any cancellation the numbers of its workspaces are released (`phoneNumber.release` as
//   the billing system). The owner is emailed at each step, once (`billing_alerts`). Before suspending or canceling,
//   Stripe is asked: a subscription that is active again (paid since) is left to `invoice.paid`.
// - `invoice.paid` lifts only a payment suspension (stripe-events.ts planPaid; security review of #865, N1).
// - `charge.dispute.created` suspends the bill (reason `dispute`) and takes the disputed recharge's or top-up's credit
//   off the balance at once (an `adjustment`; M4); `charge.dispute.closed` won gives it back (the reversing adjustment)
//   and lifts the suspension when nothing else holds it. `radar.early_fraud_warning.created` suspends (reason
//   `fraud_warning`). The instance admins are emailed each time.
// - `customer.subscription.deleted` (canceled in the Dashboard, or by our day-30 job): the bill is `canceled`.
// - `customer.subscription.updated`: `cancel_at_period_end` mirrored from the subscription fetched now (review of #1007).
//
// Runs only while billing is in effect. Every write is under the bill's lock order (ledger.ts: the balance row first).
import type { BillingChargeSource, BillingDispute, BillingProvider, BillingSubscription } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_disputes,
  billing_periods,
  billing_recharges,
  ledger_entries,
  organization,
  phone_numbers,
  type SUSPEND_REASONS,
  type stripe_events,
  type Tx,
} from '@linedesk/db'
import { and, desc, eq, isNotNull, isNull, lte, notInArray } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { queueLifecycleEmail, releaseNumberAsSystem } from './billing-periods.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { db } from './db.ts'
import { billingDisputeAlert, billingDisputeClosedAlert, billingLifecycleFailedAlert } from './emails/billing-alerts.ts'
import type { LifecycleEmail } from './emails/billing-lifecycle.ts'
import { lockBalance, periodAt, postEntry } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import { type EventOutcome, UNHANDLED_TYPE } from './stripe-events.ts'

/** The hourly dunning job. */
export const BILLING_DUNNING = 'billing.dunning'
const BILLING_DUNNING_CRON = '23 * * * *'

const DAY_MS = 86_400_000
/** Decision 9: the days of each step, counted from the failed plan invoice (`past_due_since`) or the cancellation. */
export const DUNNING = {
  /** past_due → suspended. */
  suspendDays: 7,
  /** The first payment after the trial failed: suspended sooner. */
  firstPaymentSuspendDays: 3,
  /** Reminder emails while suspended. */
  reminderDays: [14, 21],
  /** suspended → canceled (our job cancels the subscription). */
  cancelDays: 30,
  /** The numbers are kept this long after any cancellation (port-out), then released. */
  releaseDays: 30,
  /** The inbox stays readable and exportable this long after the cancellation (decision 10). */
  dataDays: 90,
} as const

type Bill = typeof billing_accounts.$inferSelect
type StoredEvent = typeof stripe_events.$inferSelect
type SuspendReason = (typeof SUSPEND_REASONS)[number]

const iso = (ms: number) => new Date(ms).toISOString()
const plusDays = (at: string, days: number) => iso(Date.parse(at) + days * DAY_MS)

/** The Stripe subscription statuses that mean the plan fee is still unpaid. */
const UNPAID_SUBSCRIPTION = ['past_due', 'unpaid']
/** The Stripe subscription statuses of a plan that is paid up (a late payment came). */
const PAID_SUBSCRIPTION = ['active', 'trialing']

/**
 * The stronger reason wins: an instance admin's suspension over an early fraud warning over a dispute over a missed
 * payment (#919's `suspend_reason`). An admin's suspension and a fraud warning's are lifted only by an instance admin
 * (the flagged card is still saved; re-review of #920, N1); a dispute's lifts when it is settled.
 */
const REASON_RANK: Record<SuspendReason, number> = { payment: 1, dispute: 2, early_fraud_warning: 3, admin: 4 }

/** The bill row, locked, under the balance lock (the lock order of ledger.ts). */
async function lockBill(tx: Tx, billId: string) {
  await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId)).for('update')
  return bill ?? null
}

/** The bill's status and the workspaces' mirror of it (`organization.billing_state`, read on the call path). */
async function setStatus(tx: Tx, billId: string, set: Partial<Bill> & { status: Bill['status'] }, now: string) {
  await tx
    .update(billing_accounts)
    .set({ ...set, updated_at: now })
    .where(eq(billing_accounts.id, billId))
  // The mirror has no `canceled`: a canceled bill's workspaces are `suspended` there (no calls either way).
  const mirror =
    set.status === 'trialing' || set.status === 'active' || set.status === 'past_due' ? 'active' : 'suspended'
  await tx.update(organization).set({ billingState: mirror }).where(eq(organization.billingAccountId, billId))
}

/**
 * The owner's email for one occasion, once: the `billing_alerts` row and the queued job in the caller's transaction.
 * Whether it was new.
 */
async function emailOnce(
  tx: Tx,
  billId: string,
  kind: 'dunning' | 'numbers_release' | 'numbers_released',
  ref: string,
  email: LifecycleEmail | null,
) {
  const added = await tx
    .insert(billing_alerts)
    .values({ billing_account_id: billId, kind, ref })
    .onConflictDoNothing()
    .returning()
  if (added.length && email) await queueLifecycleEmail(tx, billId, email)
  return added.length > 0
}

/** The subscription as Stripe has it now, or null when the bill has none or Stripe does not know it. */
async function subscriptionOf(provider: BillingProvider, bill: Bill): Promise<BillingSubscription | null> {
  if (!bill.stripe_subscription_id) return null
  return provider.subscription(bill.stripe_subscription_id)
}

// ---- A failed plan invoice ----

/**
 * A plan invoice that failed (`invoice.payment_failed`, or `invoice.voided`; from stripe-events.ts's failure job, the
 * invoice fetched just now and of the bill's own customer). An open invoice of the bill's own subscription, with the
 * subscription unpaid in Stripe, makes a trialing or active bill `past_due` from the time Stripe reported it. A void,
 * paid or uncollectible invoice, or a subscription paid up since, changes nothing.
 */
export async function planInvoiceFailed(
  provider: BillingProvider,
  invoice: { id: string; status: string | null; subscriptionId: string | null },
  bill: Bill,
  failedAt: string,
  now: string,
): Promise<EventOutcome> {
  if (!invoice.subscriptionId || invoice.subscriptionId !== bill.stripe_subscription_id || invoice.status !== 'open')
    return { outcome: 'applied', bill: bill.id }
  const subscription = await provider.subscription(invoice.subscriptionId)
  if (!subscription || !UNPAID_SUBSCRIPTION.includes(subscription.status)) return { outcome: 'applied', bill: bill.id }
  const changed = await db.transaction(async tx => {
    const current = await lockBill(tx, bill.id)
    if (!current || (current.status !== 'trialing' && current.status !== 'active')) return false
    await setStatus(
      tx,
      bill.id,
      { status: 'past_due', past_due_since: failedAt, past_due_first_payment: current.status === 'trialing' },
      now,
    )
    return true
  })
  return changed ? { outcome: 'lifecycle', bill: bill.id, change: 'past_due' } : { outcome: 'applied', bill: bill.id }
}

// ---- The dunning job ----

/** past_due for 7 days (3 after a failed first payment): suspended, the owner emailed. */
export async function suspendPastDue(provider: BillingProvider, now: string): Promise<string[]> {
  const due = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'past_due'),
        isNotNull(billing_accounts.past_due_since),
        lte(billing_accounts.past_due_since, plusDays(now, -DUNNING.firstPaymentSuspendDays)),
      ),
    )
  const suspended: string[] = []
  for (const bill of due) {
    const grace = bill.past_due_first_payment ? DUNNING.firstPaymentSuspendDays : DUNNING.suspendDays
    if (Date.parse(bill.past_due_since!) > Date.parse(plusDays(now, -grace))) continue
    // Paid since (the event may still be on its way): left to invoice.paid.
    const subscription = await subscriptionOf(provider, bill)
    if (subscription && PAID_SUBSCRIPTION.includes(subscription.status)) continue
    const done = await db.transaction(async tx => {
      const current = await lockBill(tx, bill.id)
      if (current?.status !== 'past_due' || current.past_due_since !== bill.past_due_since) return false
      await setStatus(tx, bill.id, { status: 'suspended', suspend_reason: 'payment', suspended_at: now }, now)
      await emailOnce(tx, bill.id, 'dunning', `${bill.past_due_since}:suspended`, {
        kind: 'suspended',
        cancelAt: plusDays(bill.past_due_since!, DUNNING.cancelDays),
      })
      return true
    })
    if (done) suspended.push(bill.id)
  }
  return suspended
}

/** Day 14 and 21 of a payment suspension: one reminder each (only the latest when the job was down for both). */
export async function sendDunningReminders(now: string): Promise<string[]> {
  const bills = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'suspended'),
        eq(billing_accounts.suspend_reason, 'payment'),
        isNotNull(billing_accounts.past_due_since),
      ),
    )
  const reminded: string[] = []
  for (const bill of bills) {
    const since = bill.past_due_since!
    const due = DUNNING.reminderDays.filter(d => Date.parse(plusDays(since, d)) <= Date.parse(now))
    if (!due.length || Date.parse(plusDays(since, DUNNING.cancelDays)) <= Date.parse(now)) continue
    const sent = await db.transaction(async tx => {
      let any = false
      for (const day of due) {
        const latest = day === due.at(-1)
        const email: LifecycleEmail | null = latest
          ? { kind: 'dunning_reminder', cancelAt: plusDays(since, DUNNING.cancelDays) }
          : null
        if (await emailOnce(tx, bill.id, 'dunning', `${since}:d${day}`, email)) any ||= latest
      }
      return any
    })
    if (sent) reminded.push(bill.id)
  }
  return reminded
}

/**
 * A canceled bill (our day-30 job, or the subscription deleted in Stripe): no new period, the numbers kept 30 days
 * for a port-out, the data 90 days; the owner is told both dates once (`numbers_release`, ref = the cancellation).
 */
async function markCanceled(tx: Tx, bill: Bill, now: string) {
  await setStatus(tx, bill.id, { status: 'canceled', canceled_at: now }, now)
  await emailOnce(tx, bill.id, 'numbers_release', now, {
    kind: 'canceled',
    releaseAt: plusDays(now, DUNNING.releaseDays),
    dataUntil: plusDays(now, DUNNING.dataDays),
  })
}

/** Day 30 of an unpaid plan fee: our job cancels the subscription (no proration, no final invoice), the bill is canceled. */
export async function cancelUnpaid(provider: BillingProvider, now: string): Promise<string[]> {
  const due = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'suspended'),
        eq(billing_accounts.suspend_reason, 'payment'),
        lte(billing_accounts.past_due_since, plusDays(now, -DUNNING.cancelDays)),
      ),
    )
  const canceled: string[] = []
  for (const bill of due) {
    const subscription = await subscriptionOf(provider, bill)
    if (subscription && PAID_SUBSCRIPTION.includes(subscription.status)) continue
    if (subscription) await provider.cancelSubscription(subscription.id, { now: true })
    const done = await db.transaction(async tx => {
      const current = await lockBill(tx, bill.id)
      if (current?.status !== 'suspended' || current.suspend_reason !== 'payment') return false
      await markCanceled(tx, current, now)
      return true
    })
    if (done) canceled.push(bill.id)
  }
  return canceled
}

/**
 * 30 days after a cancellation: the numbers Linedesk bought on its own carrier account for the bill's workspaces are
 * released through `phoneNumber.release` as the billing system (logged in the command log), and the owner gets the
 * final email once. Never a number on the customer's own carrier account or one they attached: those are theirs, at
 * their carrier, and stay as they are (security review of #920, M3). Each number on its own: one that fails is
 * returned in `failed` (the run emails the instance admins), and the others are still released.
 */
export async function releaseCanceledNumbers(now: string): Promise<{ released: string[]; failed: string[] }> {
  const due = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'canceled'),
        lte(billing_accounts.canceled_at, plusDays(now, -DUNNING.releaseDays)),
      ),
    )
  const released: string[] = []
  const failed: string[] = []
  for (const bill of due) {
    const numbers = await db
      .select({ id: phone_numbers.id, e164: phone_numbers.e164 })
      .from(phone_numbers)
      .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
      .where(
        and(
          eq(organization.billingAccountId, bill.id),
          eq(phone_numbers.purchased, true),
          eq(phone_numbers.carrier_account, 'install'),
        ),
      )
    if (!numbers.length) continue
    const gone: string[] = []
    for (const number of numbers) {
      try {
        if ((await releaseNumberAsSystem(number.id)).released) gone.push(number.e164)
      } catch (error) {
        console.error(`billing dunning: number ${number.id} could not be released:`, error)
        failed.push(
          `release of ${number.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        )
      }
    }
    released.push(...gone)
    // The final email once every number is gone; while one failed, the next run tries again and the email waits.
    if (gone.length === numbers.length)
      await db.transaction(tx =>
        emailOnce(tx, bill.id, 'numbers_released', bill.canceled_at!, {
          kind: 'numbers_released',
          numbers: gone,
          dataUntil: plusDays(bill.canceled_at!, DUNNING.dataDays),
        }),
      )
  }
  return { released, failed }
}

export type DunningRun = {
  billing: 'on' | 'off'
  suspended: string[]
  reminded: string[]
  canceled: string[]
  released: string[]
  failed: string[]
}

/** One run of the dunning job: every step on its own; failures are emailed to the instance admins. */
export async function runDunning(
  now = new Date().toISOString(),
  options: { provider?: BillingProvider } = {},
): Promise<DunningRun> {
  const run: DunningRun = { billing: 'on', suspended: [], reminded: [], canceled: [], released: [], failed: [] }
  if ((await billingState(db)).inEffect === 'none') return { ...run, billing: 'off' }
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      console.error(`billing dunning: ${name} failed:`, error)
      run.failed.push(`${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
  }
  const provider = options.provider ?? (await billingProvider(db))
  await step('suspend', async () => {
    run.suspended = await suspendPastDue(provider, now)
  })
  await step('reminders', async () => {
    run.reminded = await sendDunningReminders(now)
  })
  await step('cancel', async () => {
    run.canceled = await cancelUnpaid(provider, now)
  })
  await step('release numbers', async () => {
    const { released, failed } = await releaseCanceledNumbers(now)
    run.released = released
    run.failed.push(...failed)
  })
  if (run.failed.length)
    await alertInstanceAdmins(billingLifecycleFailedAlert(run.failed)).catch(e =>
      console.error('billing dunning: the alert could not be sent:', e),
    )
  return run
}

// ---- Stripe events: subscription deleted, disputes, early fraud warnings ----

async function billOfCustomer(customerId: string | null) {
  if (!customerId) return null
  const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.stripe_customer_id, customerId))
  return bill ?? null
}

/** The bill's period for an entry posted now: the one that contains now, else its latest. */
async function periodForEntry(tx: Tx, billId: string, now: string) {
  const current = await periodAt(tx, billId, now)
  if (current) return current
  const [latest] = await tx
    .select()
    .from(billing_periods)
    .where(eq(billing_periods.billing_account_id, billId))
    .orderBy(desc(billing_periods.starts_at))
    .limit(1)
  if (!latest) throw new Error(`billing: bill ${billId} has no period to post a dispute adjustment in`)
  return latest
}

/**
 * The balance credit a disputed charge paid for, through ids we stored: the recharge attempt with that invoice, or the
 * top-up of that Checkout session; on this bill only. A plan invoice's charge paid no credit (null).
 */
async function creditOfCharge(
  tx: Tx,
  billId: string,
  source: { invoiceId: string | null; checkoutSessionId: string | null },
) {
  if (source.invoiceId) {
    const [recharge] = await tx
      .select({ id: billing_recharges.id })
      .from(billing_recharges)
      .where(
        and(
          eq(billing_recharges.stripe_invoice_id, source.invoiceId),
          eq(billing_recharges.billing_account_id, billId),
        ),
      )
    if (recharge) {
      const [entry] = await tx
        .select()
        .from(ledger_entries)
        .where(
          and(
            eq(ledger_entries.billing_account_id, billId),
            eq(ledger_entries.kind, 'recharge'),
            eq(ledger_entries.source_type, 'billing_recharge'),
            eq(ledger_entries.source_id, recharge.id),
          ),
        )
      if (entry) return entry
    }
  }
  if (source.checkoutSessionId) {
    const [entry] = await tx
      .select()
      .from(ledger_entries)
      .where(
        and(
          eq(ledger_entries.billing_account_id, billId),
          eq(ledger_entries.kind, 'topup'),
          eq(ledger_entries.source_type, 'stripe_checkout'),
          eq(ledger_entries.source_id, source.checkoutSessionId),
        ),
      )
    if (entry) return entry
  }
  return null
}

/** Suspends a bill for a dispute or a fraud warning; a stronger reason already there stays. Canceled and comped stay. */
async function suspendFor(tx: Tx, bill: Bill, reason: SuspendReason, now: string) {
  if (bill.status === 'canceled' || bill.status === 'comped' || bill.status === 'pending_payment') return false
  if (bill.status === 'suspended' && bill.suspend_reason && REASON_RANK[bill.suspend_reason] >= REASON_RANK[reason])
    return false
  await setStatus(
    tx,
    bill.id,
    { status: 'suspended', suspend_reason: reason, suspended_at: bill.suspended_at ?? now },
    now,
  )
  return true
}

/**
 * Statuses settled in Linedesk's favour: a dispute won, an inquiry closed without a chargeback (`warning_closed`),
 * one prevented before it became a dispute (`prevented`); and `refunded`, a fraud warning whose charge was refunded.
 * Anything else holds the suspension (`lost` waits for an instance admin).
 */
const SETTLED_DISPUTE = ['won', 'warning_closed', 'prevented', 'refunded']
/** Dispute statuses Stripe never moves out of. */
const FINAL_DISPUTE = ['won', 'lost', 'warning_closed', 'prevented']
const settled = (status: string) => SETTLED_DISPUTE.includes(status)

/**
 * The share of the credit a dispute takes off: the disputed part of the charge (a partial dispute takes only its
 * share; the charge includes tax, the credit does not), never more than the credit.
 */
function disputedMicros(creditMicros: number, dispute: { amountCents: number; chargeAmountCents: number }) {
  if (!(dispute.chargeAmountCents > 0) || dispute.amountCents >= dispute.chargeAmountCents) return creditMicros
  return Math.round((creditMicros * Math.max(0, dispute.amountCents)) / dispute.chargeAmountCents)
}

/**
 * Stores the dispute as Stripe has it now and acts on that status, never on which event came (a late or replayed
 * `created` after the dispute was won must not suspend again; security review of #920, M4). Not settled: the
 * disputed share of the credit comes off the balance, once (`dispute:<id>`), and the bill is suspended. Settled
 * (won, warning_closed, prevented): an adjustment made before is reversed, once (`dispute:<id>:won`), and the
 * suspension lifts when nothing else holds it. What changed, for the admin alert.
 */
async function applyDispute(
  tx: Tx,
  billId: string,
  fetched: BillingDispute,
  subscription: BillingSubscription | null,
  now: string,
) {
  let dispute = fetched
  await requireLedgerGuards(tx)
  const current = (await lockBill(tx, billId))!
  await tx
    .insert(billing_disputes)
    .values({
      id: dispute.id,
      billing_account_id: billId,
      kind: 'dispute',
      charge_id: dispute.chargeId,
      status: dispute.status,
    })
    .onConflictDoNothing()
  const [row] = await tx.select().from(billing_disputes).where(eq(billing_disputes.id, dispute.id)).for('update')
  if (row!.billing_account_id !== billId) throw new Error(`billing: dispute ${dispute.id} is stored for another bill`)
  // A final status stored by another event wins over a status fetched before it (an earlier `created` committing after
  // `closed`): Stripe never moves a dispute out of a final status (re-review of #920, N3).
  if (FINAL_DISPUTE.includes(row!.status) && !FINAL_DISPUTE.includes(dispute.status))
    dispute = { ...dispute, status: row!.status }
  await tx
    .update(billing_disputes)
    .set({ status: dispute.status, updated_at: now })
    .where(eq(billing_disputes.id, dispute.id))
  let adjustedMicros: number | null = null
  let returnedMicros: number | null = null
  if (!settled(dispute.status)) {
    if (!row!.adjustment_entry_id) {
      const credit = await creditOfCharge(tx, billId, dispute)
      if (credit) {
        const period = await periodForEntry(tx, billId, now)
        const micros = disputedMicros(credit.amount_micros, dispute)
        const { entry } = await postEntry(tx, {
          billing_account_id: billId,
          period_id: period.id,
          kind: 'adjustment',
          amount_micros: -micros,
          source_type: 'job',
          source_id: `dispute:${dispute.id}`,
        })
        adjustedMicros = micros
        await tx
          .update(billing_disputes)
          .set({ credit_entry_id: credit.id, adjustment_entry_id: entry.id, updated_at: now })
          .where(eq(billing_disputes.id, dispute.id))
      }
    }
    const suspended = await suspendFor(tx, current, 'dispute', now)
    return { status: dispute.status, adjustedMicros, returnedMicros, suspended, lifted: false }
  }
  if (row!.adjustment_entry_id && !row!.reversal_entry_id) {
    const [adjustment] = await tx.select().from(ledger_entries).where(eq(ledger_entries.id, row!.adjustment_entry_id))
    const period = await periodForEntry(tx, billId, now)
    const { entry } = await postEntry(tx, {
      billing_account_id: billId,
      period_id: period.id,
      kind: 'adjustment',
      amount_micros: -adjustment!.amount_micros,
      source_type: 'job',
      source_id: `dispute:${dispute.id}:won`,
      reverses_entry_id: adjustment!.id,
    })
    returnedMicros = -adjustment!.amount_micros
    await tx.update(billing_disputes).set({ reversal_entry_id: entry.id }).where(eq(billing_disputes.id, row!.id))
  }
  const lifted = await liftIfClear(tx, current, subscription, now)
  return { status: dispute.status, adjustedMicros, returnedMicros, suspended: false, lifted }
}

const cents = (micros: number | null) => (micros === null ? null : Math.round(micros / 10_000))

/** `charge.dispute.created`: the dispute as Stripe has it now (applyDispute); the admins told. */
async function disputeCreated(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const dispute = await provider.dispute(objectId)
  if (!dispute) return { outcome: 'not_found' }
  const bill = await billOfCustomer(dispute.customerId)
  if (!bill) return { outcome: 'unknown' }
  const subscription = settled(dispute.status) ? await subscriptionOf(provider, bill) : null
  const result = await db.transaction(tx => applyDispute(tx, bill.id, dispute, subscription, now))
  await alertInstanceAdmins(
    settled(result.status)
      ? billingDisputeClosedAlert({
          bill: bill.id,
          object: dispute.id,
          charge: dispute.chargeId,
          status: result.status,
          returnedCents: cents(result.returnedMicros),
          lifted: result.lifted,
        })
      : billingDisputeAlert({
          bill: bill.id,
          kind: 'dispute',
          object: dispute.id,
          charge: dispute.chargeId,
          adjustedCents: cents(result.adjustedMicros),
        }),
  ).catch(e => console.error('billing: the dispute alert could not be sent:', e))
  return {
    outcome: 'lifecycle',
    bill: bill.id,
    change: settled(result.status) ? `dispute_${result.status}` : 'dispute',
  }
}

/**
 * `charge.dispute.closed`: the dispute as Stripe has it now (applyDispute; stored first when its `created` never
 * came). Won, warning_closed or prevented: the credit back, the suspension lifted when nothing else holds it, to what
 * the subscription is in Stripe now (a plan still unpaid goes back to dunning). Lost: the bill stays suspended. The
 * instance admins are told either way, so a bill that stays suspended is never forgotten.
 */
async function disputeClosed(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const dispute = await provider.dispute(objectId)
  if (!dispute) return { outcome: 'not_found' }
  const bill = await billOfCustomer(dispute.customerId)
  if (!bill) return { outcome: 'unknown' }
  const subscription = settled(dispute.status) ? await subscriptionOf(provider, bill) : null
  const result = await db.transaction(tx => applyDispute(tx, bill.id, dispute, subscription, now))
  await alertInstanceAdmins(
    billingDisputeClosedAlert({
      bill: bill.id,
      object: dispute.id,
      charge: dispute.chargeId,
      status: result.status,
      returnedCents: cents(result.returnedMicros),
      lifted: result.lifted,
    }),
  ).catch(e => console.error('billing: the dispute alert could not be sent:', e))
  return { outcome: 'lifecycle', bill: bill.id, change: `dispute_${result.status}` }
}

/**
 * Lifts a dispute's suspension when no other open dispute or warning holds it, to the subscription's state. Whether it
 * was lifted. A fraud warning's suspension is never lifted here: an instance admin resumes it (re-review of #920, N1).
 */
async function liftIfClear(tx: Tx, bill: Bill, subscription: BillingSubscription | null, now: string) {
  if (bill.status !== 'suspended' || bill.suspend_reason !== 'dispute') return false
  const [open] = await tx
    .select({ id: billing_disputes.id })
    .from(billing_disputes)
    .where(and(eq(billing_disputes.billing_account_id, bill.id), notInArray(billing_disputes.status, SETTLED_DISPUTE)))
    .limit(1)
  if (open || !subscription) return false
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    await setStatus(tx, bill.id, { status: subscription.status, suspend_reason: null, suspended_at: null }, now)
    return true
  }
  if (UNPAID_SUBSCRIPTION.includes(subscription.status)) {
    // Still unpaid: back in dunning, from when it was first past due (or now).
    await setStatus(
      tx,
      bill.id,
      { status: 'suspended', suspend_reason: 'payment', past_due_since: bill.past_due_since ?? now },
      now,
    )
    return true
  }
  return false
}

/**
 * A refunded charge's credit off the balance, once (`refund:<charge>`, kept on the warning's row): the card got the
 * money back, so the minutes go too (re-review of #920, N1). Not when a dispute of the charge holds its credit already.
 */
async function takeRefundedCredit(tx: Tx, billId: string, warningId: string, source: BillingChargeSource, now: string) {
  const [row] = await tx.select().from(billing_disputes).where(eq(billing_disputes.id, warningId)).for('update')
  if (!row || row.adjustment_entry_id) return null
  const [disputed] = await tx
    .select({ id: billing_disputes.id })
    .from(billing_disputes)
    .where(
      and(
        eq(billing_disputes.billing_account_id, billId),
        eq(billing_disputes.charge_id, source.chargeId),
        isNotNull(billing_disputes.adjustment_entry_id),
        isNull(billing_disputes.reversal_entry_id),
      ),
    )
    .limit(1)
  if (disputed) return null
  const credit = await creditOfCharge(tx, billId, source)
  if (!credit) return null
  const period = await periodForEntry(tx, billId, now)
  const { entry } = await postEntry(tx, {
    billing_account_id: billId,
    period_id: period.id,
    kind: 'adjustment',
    amount_micros: -credit.amount_micros,
    source_type: 'job',
    source_id: `refund:${source.chargeId}`,
  })
  await tx
    .update(billing_disputes)
    .set({ credit_entry_id: credit.id, adjustment_entry_id: entry.id, updated_at: now })
    .where(eq(billing_disputes.id, warningId))
  return credit.amount_micros
}

/**
 * A fraud warning's hold: suspended for it, and auto-recharge off, so the flagged card is never charged on its own again,
 * also after an instance admin resumed the bill (the owner turns it back on, ideally with a new card).
 */
async function holdForFraud(tx: Tx, bill: Bill, now: string) {
  await suspendFor(tx, bill, 'early_fraud_warning', now)
  await tx
    .update(billing_accounts)
    .set({ auto_recharge: false, updated_at: now })
    .where(eq(billing_accounts.id, bill.id))
}

/**
 * `radar.early_fraud_warning.created`: suspended at once and auto-recharge off; only an instance admin lifts it
 * (re-review of #920, N1). An admin refunds the charge, which avoids a dispute fee. A warning whose charge was refunded
 * already (the refund's event came first) is stored as refunded and its credit comes off; the bill is held all the same.
 */
async function fraudWarning(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const warning = await provider.earlyFraudWarning(objectId)
  if (!warning) return { outcome: 'not_found' }
  const bill = await billOfCustomer(warning.customerId)
  if (!bill) return { outcome: 'unknown' }
  const takenMicros = await db.transaction(async tx => {
    await requireLedgerGuards(tx)
    const current = (await lockBill(tx, bill.id))!
    await tx
      .insert(billing_disputes)
      .values({
        id: warning.id,
        billing_account_id: bill.id,
        kind: 'fraud_warning',
        charge_id: warning.chargeId,
        status: warning.refunded ? 'refunded' : 'open',
      })
      .onConflictDoNothing()
    await holdForFraud(tx, current, now)
    return warning.refunded ? await takeRefundedCredit(tx, bill.id, warning.id, warning, now) : null
  })
  await alertInstanceAdmins(
    billingDisputeAlert({
      bill: bill.id,
      kind: 'fraud_warning',
      object: warning.id,
      charge: warning.chargeId,
      adjustedCents: cents(takenMicros),
    }),
  ).catch(e => console.error('billing: the fraud warning alert could not be sent:', e))
  return { outcome: 'lifecycle', bill: bill.id, change: 'fraud_warning' }
}

/**
 * `charge.refunded`: a charge refunded in full closes the open fraud warnings of that charge (the refund is what an
 * admin does about one) and takes the refunded credit off the balance, once. The bill stays suspended for the warning
 * until an instance admin resumes it, since the flagged card is still saved (re-review of #920, N1). The charge is
 * fetched from Stripe first; a partial refund changes nothing. A refund without a warning is left to #919's refunds.
 */
async function chargeRefunded(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const charge = await provider.charge(objectId)
  if (!charge) return { outcome: 'not_found' }
  const bill = await billOfCustomer(charge.customerId)
  if (!bill) return { outcome: 'unknown' }
  if (!charge.refunded) return { outcome: 'applied', bill: bill.id }
  const closed = await db.transaction(async tx => {
    await requireLedgerGuards(tx)
    await lockBill(tx, bill.id)
    const rows = await tx
      .update(billing_disputes)
      .set({ status: 'refunded', updated_at: now })
      .where(
        and(
          eq(billing_disputes.billing_account_id, bill.id),
          eq(billing_disputes.kind, 'fraud_warning'),
          eq(billing_disputes.charge_id, charge.chargeId),
          eq(billing_disputes.status, 'open'),
        ),
      )
      .returning({ id: billing_disputes.id })
    if (!rows.length) return null
    return { ids: rows.map(r => r.id), takenMicros: await takeRefundedCredit(tx, bill.id, rows[0]!.id, charge, now) }
  })
  if (!closed) return { outcome: 'applied', bill: bill.id }
  await alertInstanceAdmins(
    billingDisputeClosedAlert({
      bill: bill.id,
      object: closed.ids.join(', '),
      charge: charge.chargeId,
      status: 'refunded',
      returnedCents: null,
      lifted: false,
    }),
  ).catch(e => console.error('billing: the fraud warning alert could not be sent:', e))
  return { outcome: 'lifecycle', bill: bill.id, change: 'fraud_warning_refunded' }
}

/** `customer.subscription.deleted`: the bill's own subscription, canceled in Stripe now, cancels the bill. */
async function subscriptionDeleted(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.stripe_subscription_id, objectId))
  if (!bill) return { outcome: 'unknown' }
  const subscription = await provider.subscription(objectId)
  if (subscription && subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired')
    return { outcome: 'applied', bill: bill.id }
  const changed = await db.transaction(async tx => {
    const current = await lockBill(tx, bill.id)
    if (!current || current.status === 'canceled' || current.stripe_subscription_id !== objectId) return false
    await markCanceled(tx, current, now)
    return true
  })
  return changed ? { outcome: 'lifecycle', bill: bill.id, change: 'canceled' } : { outcome: 'applied', bill: bill.id }
}

/**
 * `customer.subscription.updated`: the bill mirrors whether its own subscription is set to cancel at the period end
 * (security review of #1007, M-2). Cancel and "Keep my plan" happen in the app (the portal has no cancel), but Stripe's
 * Dashboard, and the portal's "Renew" on a subscription set to cancel, change it behind the app: the page must never
 * say "nothing more is charged" while Stripe renews. Fetched now, never the event's copy; a canceled bill is left alone.
 */
async function subscriptionUpdated(provider: BillingProvider, objectId: string, now: string): Promise<EventOutcome> {
  const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.stripe_subscription_id, objectId))
  if (!bill) return { outcome: 'unknown' }
  const subscription = await provider.subscription(objectId)
  if (!subscription || subscription.status === 'canceled' || subscription.status === 'incomplete_expired')
    return { outcome: 'applied', bill: bill.id }
  const changed = await db.transaction(async tx => {
    const current = await lockBill(tx, bill.id)
    if (!current || current.status === 'canceled' || current.stripe_subscription_id !== objectId) return false
    if (current.cancel_at_period_end === subscription.cancelAtPeriodEnd) return false
    await tx
      .update(billing_accounts)
      .set({ cancel_at_period_end: subscription.cancelAtPeriodEnd, updated_at: now })
      .where(eq(billing_accounts.id, current.id))
    return true
  })
  return changed
    ? {
        outcome: 'lifecycle',
        bill: bill.id,
        change: subscription.cancelAtPeriodEnd ? 'cancel_at_period_end' : 'renews',
      }
    : { outcome: 'applied', bill: bill.id }
}

/**
 * One lifecycle event, from its job (stripe-events.ts): the object is fetched from Stripe first and the bill found
 * through ids we stored. `unknown`: no bill has it (the caller retries a young event).
 */
export async function lifecycleEvent(event: StoredEvent, objectId: string | null, now: string): Promise<EventOutcome> {
  if (!objectId) return { outcome: 'unknown' }
  const provider = await billingProvider(db)
  if (provider.name === 'none') throw new Error('billing is off')
  switch (event.type) {
    case 'customer.subscription.deleted':
      return subscriptionDeleted(provider, objectId, now)
    case 'customer.subscription.updated':
      return subscriptionUpdated(provider, objectId, now)
    case 'charge.dispute.created':
      return disputeCreated(provider, objectId, now)
    case 'charge.dispute.closed':
      return disputeClosed(provider, objectId, now)
    case 'radar.early_fraud_warning.created':
      return fraudWarning(provider, objectId, now)
    case 'charge.refunded':
      return chargeRefunded(provider, objectId, now)
    default:
      return { outcome: 'unhandled', marker: UNHANDLED_TYPE }
  }
}

// ---- What the owner sees (billing.state) ----

/** The dates of a bill's dunning and cancellation, as the in-app banner shows them. */
export function lifecycleDates(
  bill: Pick<Bill, 'status' | 'past_due_since' | 'past_due_first_payment' | 'canceled_at'>,
) {
  const since = bill.past_due_since
  const grace = bill.past_due_first_payment ? DUNNING.firstPaymentSuspendDays : DUNNING.suspendDays
  return {
    suspendsAt: bill.status === 'past_due' && since ? plusDays(since, grace) : null,
    cancelsAt:
      (bill.status === 'past_due' || bill.status === 'suspended') && since ? plusDays(since, DUNNING.cancelDays) : null,
    numbersReleaseAt:
      bill.status === 'canceled' && bill.canceled_at ? plusDays(bill.canceled_at, DUNNING.releaseDays) : null,
    dataUntil: bill.status === 'canceled' && bill.canceled_at ? plusDays(bill.canceled_at, DUNNING.dataDays) : null,
  }
}

/** Open disputes and warnings of a bill (a refund refuses their charges; PR 13). */
export async function openDisputes(tx: Pick<Tx, 'select'>, billId: string) {
  return tx
    .select()
    .from(billing_disputes)
    .where(and(eq(billing_disputes.billing_account_id, billId), notInArray(billing_disputes.status, SETTLED_DISPUTE)))
}

// ---- Queues ----

export async function createBillingLifecycleQueues(instance: PgBoss) {
  await instance.createQueue(BILLING_DUNNING, { retryLimit: 0, expireInSeconds: 1800 })
}

export async function runBillingLifecycleJobs(instance: PgBoss) {
  await instance.schedule(BILLING_DUNNING, BILLING_DUNNING_CRON)
  await instance.work(BILLING_DUNNING, async () => runDunning())
}
