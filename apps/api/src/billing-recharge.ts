// Charging an auto-recharge (docs/billing.md §2.2, §3.4, PR 4) and the bill owner's billing emails. The recharge
// decision (ledger.ts) only makes a pending `billing_recharges` row; this job, queued in the same transaction, makes
// the Stripe invoice through the billing provider and charges the saved card. It never credits the balance: that
// happens when `invoice.paid` arrives and the invoice is fetched again (the webhook, PR 5).
//
// No transaction stays open while Stripe is asked. The result is written under the bill's lock order (balance row,
// then the recharge row), and only onto an attempt that is still pending, so a webhook that settled it meanwhile wins.
import type { BillingProvider, BillingSetupError, RechargeCharge } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_recharges,
  type Db,
  instance_settings,
  organization,
  RECHARGE_LIMITS,
  rechargeCapCents,
  type Tx,
  user,
} from '@linedesk/db'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingRules } from './billing-rules.ts'
import { billingProvider } from './billing-settings.ts'
import type { EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { billingUnusableAlert, cappedCallAlert } from './emails/alerts.ts'
import { billingOwnerEmail } from './emails/billing.ts'
import { rechargeSetupAlert } from './emails/billing-alerts.ts'
import { queueBillingAlert } from './jobs.ts'
import { extraNumbersOnBill, lockBalance } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'

/** Stripe idempotency keys last 24 hours: an attempt older than this looks for its invoice before making one. */
const IDEMPOTENCY_KEY_MS = 23 * 60 * 60_000

/** What the recharge job did with one attempt. */
export type RechargeRun =
  | { outcome: 'not_pending' }
  | { outcome: 'canceled'; reason: 'billing_off' | 'no_customer' | 'bill_inactive' }
  | { outcome: RechargeCharge['status']; invoiceId: string }

/** The text on the recharge invoice's line; Stripe shows it to the customer (not translated, like the invoice). */
// i18n-ignore: the Stripe invoice line, in the Stripe account's invoice language
const RECHARGE_LINE = 'Linedesk balance recharge'

/**
 * Charges one pending recharge attempt. `provider` replaces the provider in effect (tests). Billing off, no Stripe
 * customer, or a bill no longer charged automatically: the attempt is canceled (it then counts in no cap and a later
 * decision may try again). A network failure throws, so pg-boss tries again with the same idempotency keys.
 */
export async function chargeRecharge(
  db: Db,
  rechargeId: string,
  options: { provider?: BillingProvider; now?: () => string } = {},
): Promise<RechargeRun> {
  const now = options.now ?? (() => new Date().toISOString())
  const found = await db.transaction(async tx => {
    await requireLedgerGuards(tx)
    const [attempt] = await tx.select().from(billing_recharges).where(eq(billing_recharges.id, rechargeId))
    if (attempt?.status !== 'pending') return null
    const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, attempt.billing_account_id))
    return { attempt, bill: bill!, provider: options.provider ?? (await billingProvider(tx)) }
  })
  if (!found) return { outcome: 'not_pending' }
  const { attempt, bill, provider } = found
  const reason =
    provider.name === 'none'
      ? 'billing_off'
      : !bill.stripe_customer_id
        ? 'no_customer'
        : !['active', 'past_due'].includes(bill.status) || !bill.auto_recharge
          ? 'bill_inactive'
          : null
  if (reason) {
    await settle(db, rechargeId, { status: 'canceled', failure_code: reason }, now())
    console.error(`billing: recharge ${rechargeId} of bill ${bill.id} canceled before charging (${reason})`)
    return { outcome: 'canceled', reason }
  }
  const invoiceId =
    attempt.stripe_invoice_id ??
    (Date.parse(now()) - Date.parse(attempt.created_at) > IDEMPOTENCY_KEY_MS
      ? await provider.findRechargeInvoice(rechargeId)
      : null)
  const charge = await provider.chargeRecharge({
    customerId: bill.stripe_customer_id!,
    amountCents: attempt.amount_cents,
    rechargeId,
    description: RECHARGE_LINE,
    invoiceId,
    // Checkout saved the card on the subscription: the adapter makes it the customer's default when there is none (B1).
    subscriptionId: bill.stripe_subscription_id,
  })
  if (charge.status !== 'failed') {
    await settle(db, rechargeId, { stripe_invoice_id: charge.invoiceId }, now())
    return { outcome: charge.status, invoiceId: charge.invoiceId }
  }
  await rechargeFailed(db, provider, rechargeId, charge.invoiceId, charge.failureCode, now())
  return { outcome: 'failed', invoiceId: charge.invoiceId }
}

/**
 * A recharge attempt whose charge was refused (docs/billing.md §3.4; also for the `invoice.payment_failed` webhook):
 * first its invoice's automatic collection is turned off, so it is never charged later behind the owner's back; a
 * decline also voids it (the attempt is `canceled`); `authentication_required` keeps it open for the owner to confirm
 * on the invoice's page (`failed`, still counted in the cap). Then, once: the bill waits for a new card or the owner's
 * Retry (`recharge_failed_at`), and the owner is emailed (a `billing_alerts` row per invoice).
 */
export async function rechargeFailed(
  db: Db,
  provider: BillingProvider,
  rechargeId: string,
  invoiceId: string,
  failureCode: string,
  now: string,
) {
  const needsOwner = failureCode === 'authentication_required'
  await provider.stopRechargeInvoice(invoiceId, { void: !needsOwner })
  await settle(
    db,
    rechargeId,
    { status: needsOwner ? 'failed' : 'canceled', failure_code: failureCode, stripe_invoice_id: invoiceId },
    now,
    async (tx, billId) => {
      await tx
        .update(billing_accounts)
        .set({ recharge_failed_at: now, updated_at: now })
        .where(eq(billing_accounts.id, billId))
      const added = await tx
        .insert(billing_alerts)
        .values({ billing_account_id: billId, kind: 'recharge_failed', ref: invoiceId })
        .onConflictDoNothing()
        .returning()
      if (added.length)
        await queueBillingAlert(tx, { kind: 'recharge_failed', bill: billId, ref: invoiceId, rechargeId, needsOwner })
    },
  )
}

/**
 * The recharge job's last retry failed too (jobs.ts): the attempt is not left pending for good. Its invoice, if one was
 * made, gets the failed-recharge rules (collection off, voided, the owner emailed); without one the attempt is
 * canceled, so a later decision may try again (security review of #864, L3). A failure here leaves it pending, and the
 * stuck-recharge alert (stuckRecharges) names it to the instance admins.
 */
export async function rechargeGaveUp(
  db: Db,
  rechargeId: string,
  options: { provider?: BillingProvider; now?: () => string; setupError?: BillingSetupError } = {},
) {
  const now = options.now ?? (() => new Date().toISOString())
  const [attempt] = await db.select().from(billing_recharges).where(eq(billing_recharges.id, rechargeId))
  if (attempt?.status !== 'pending') return
  const provider = options.provider ?? (await db.transaction(tx => billingProvider(tx)))
  if (options.setupError) return setupGaveUp(db, provider, attempt, options.setupError.code, now())
  const invoiceId =
    attempt.stripe_invoice_id ?? (provider.name === 'none' ? null : await provider.findRechargeInvoice(rechargeId))
  if (invoiceId) await rechargeFailed(db, provider, rechargeId, invoiceId, 'stripe_error', now())
  else await settle(db, rechargeId, { status: 'canceled', failure_code: 'stripe_error' }, now())
  console.error(`billing: recharge ${rechargeId} gave up after the job's last retry`)
}

/** How often the setup alert goes out per install and error code (recheck of #865, L-B). */
export const RECHARGE_SETUP_ALERT_MS = 24 * 60 * 60_000
/** The instance setting that remembers when the setup alert for a code last went out. */
export const rechargeSetupAlertKey = (code: string) => `billing.rechargeSetupAlerted:${code}`

/**
 * The last try failed on our own setup (recheck of #864, L2: a 401, 403 or 404 from Stripe): not the owner's card, so no
 * `recharge_failed_at` and no owner email. The attempt is canceled (a later decision may try again once the setup is
 * fixed), its invoice is stopped when that still works, and the instance admins are emailed: once per install and
 * error code in 24 hours, not once per bill (a broken key fails every bill's recharge the same way).
 */
async function setupGaveUp(
  db: Db,
  provider: BillingProvider,
  attempt: typeof billing_recharges.$inferSelect,
  code: string,
  now: string,
) {
  if (attempt.stripe_invoice_id && provider.name !== 'none')
    await provider
      .stopRechargeInvoice(attempt.stripe_invoice_id, { void: true })
      .catch(e => console.error(`billing: invoice ${attempt.stripe_invoice_id} could not be stopped:`, e))
  await settle(db, attempt.id, { status: 'canceled', failure_code: code }, now, async (tx, billId) => {
    const before = new Date(Date.parse(now) - RECHARGE_SETUP_ALERT_MS).toISOString()
    const due = await tx
      .insert(instance_settings)
      .values({ key: rechargeSetupAlertKey(code), value: now, updated_at: now })
      .onConflictDoUpdate({
        target: instance_settings.key,
        set: { value: now, updated_at: now },
        setWhere: lt(instance_settings.updated_at, before),
      })
      .returning({ key: instance_settings.key })
    if (due.length) await queueBillingAlert(tx, { kind: 'recharge_setup', bill: billId, rechargeId: attempt.id, code })
  })
  console.error(`billing: recharge ${attempt.id} gave up on a Stripe setup error (${code})`)
}

/** How long a recharge attempt may stay pending before the instance admins hear of it (review of #864, M1). */
export const STUCK_RECHARGE_MS = 2 * 60 * 60_000

/**
 * Recharge attempts pending for longer than STUCK_RECHARGE_MS (`since`: only those that crossed it after then, so the
 * hourly check names each once; the nightly one names all of them again).
 */
export async function stuckRecharges(db: Db | Tx, now: string, since?: string) {
  const before = new Date(Date.parse(now) - STUCK_RECHARGE_MS).toISOString()
  const rows = await db
    .select({
      recharge: billing_recharges.id,
      bill: billing_recharges.billing_account_id,
      since: billing_recharges.created_at,
    })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.status, 'pending'),
        lt(billing_recharges.created_at, before),
        ...(since
          ? [gte(billing_recharges.created_at, new Date(Date.parse(since) - STUCK_RECHARGE_MS).toISOString())]
          : []),
      ),
    )
    .orderBy(billing_recharges.created_at)
  return rows
}

type Settlement = Partial<Pick<typeof billing_recharges.$inferInsert, 'status' | 'failure_code' | 'stripe_invoice_id'>>

/** Writes onto the attempt while it is still pending, under the bill's lock order; then `also` in the same transaction. */
async function settle(
  db: Db,
  rechargeId: string,
  values: Settlement,
  now: string,
  also?: (tx: Tx, billId: string) => Promise<void>,
) {
  await db.transaction(async tx => {
    const [row] = await tx.select().from(billing_recharges).where(eq(billing_recharges.id, rechargeId))
    if (!row) return
    await lockBalance(tx, row.billing_account_id)
    const resolved = values.status && values.status !== 'pending' ? { resolved_at: now } : {}
    const [updated] = await tx
      .update(billing_recharges)
      .set({ ...values, ...resolved })
      .where(and(eq(billing_recharges.id, rechargeId), eq(billing_recharges.status, 'pending')))
      .returning()
    if (updated && also) await also(tx, row.billing_account_id)
  })
}

/** One billing email (jobs.ts BILLING_ALERT): to the bill owner, or the capped-call alert to the instance admins. */
export type BillingAlertJob =
  | { kind: 'capped_call'; bill: string; call: string; reported: number; billed: number }
  | { kind: 'billing_unusable'; reason: 'guards' | 'keys' }
  | { kind: 'recharge_cap_reached' | 'low_balance'; bill: string; ref: string }
  | { kind: 'recharge_failed'; bill: string; ref: string; rechargeId: string; needsOwner: boolean }
  | { kind: 'recharge_setup'; bill: string; rechargeId: string; code: string }

/**
 * Sends one billing email. The facts are read when it is sent (the cap, the balance, the amount); an owner without an
 * address, or a bill that is gone, gets nothing. Throws when the email could not go out, so the job tries again.
 */
export async function sendBillingAlert(
  db: Db,
  sender: EmailSender,
  job: BillingAlertJob,
  options: { provider?: BillingProvider } = {},
) {
  // Awaited, so the job's retries help when an email does not go out (review of #864, N2).
  if (job.kind === 'capped_call' || job.kind === 'billing_unusable' || job.kind === 'recharge_setup') {
    const alert =
      job.kind === 'capped_call'
        ? cappedCallAlert(job)
        : job.kind === 'recharge_setup'
          ? rechargeSetupAlert({ bill: job.bill, recharge: job.rechargeId, code: job.code })
          : billingUnusableAlert(job.reason)
    await alertInstanceAdmins(alert, sender, { wait: true })
    return { sent: 'admins' as const }
  }
  const [bill] = await db
    .select({
      bill: billing_accounts,
      balance: billing_balances.balance_micros,
      reserved: billing_balances.reserved_micros,
      email: user.email,
    })
    .from(billing_accounts)
    .leftJoin(billing_balances, eq(billing_balances.billing_account_id, billing_accounts.id))
    .leftJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(eq(billing_accounts.id, job.bill))
  if (!bill?.email) return { sent: 'nobody' as const }
  const rules = await billingRules(db)
  const base = { bufferMicros: rules.balanceBufferMicros }
  let content: Parameters<typeof billingOwnerEmail>[0]
  if (job.kind === 'recharge_failed') {
    const [attempt] = await db.select().from(billing_recharges).where(eq(billing_recharges.id, job.rechargeId))
    const invoiceUrl = job.needsOwner ? await invoicePage(db, job.ref, options.provider) : null
    content = { ...base, kind: 'recharge_failed', amountCents: attempt?.amount_cents ?? 0, invoiceUrl }
  } else if (job.kind === 'recharge_cap_reached') {
    // The cap as the decision computed it (with the extra numbers), and what this month's recharges came to: the cap
    // is "reached" when what is left under it is below the minimum recharge, not only when it is used up (billing
    // review of 16.11., B7: "recharged up to its cap of $50" after $40).
    const workspaces = await workspacesOf(db, job.bill)
    const extraNumbers = await db.transaction(tx => extraNumbersOnBill(tx, job.bill))
    content = {
      ...base,
      kind: 'recharge_cap_reached',
      capCents:
        rechargeCapCents(bill.bill.recharge_cap_base_cents, workspaces, rules) + rules.extraNumberCents * extraNumbers,
      rechargedCents: await rechargedInMonth(db, job.bill, job.ref),
      minimumCents: RECHARGE_LIMITS.amountCents.min,
    }
  } else {
    // What calls can still use (the balance less what running calls hold): the figure the alert fired on (N3).
    content = { ...base, kind: 'low_balance', balanceMicros: (bill.balance ?? 0) - (bill.reserved ?? 0) }
  }
  const locale = await localeForEmail(db, bill.email)
  await sender.send({ to: bill.email, ...billingOwnerEmail(content, undefined, locale) })
  return { sent: 'owner' as const }
}

/**
 * The page where the owner confirms a payment that needs them: fetched from the billing provider when the email goes
 * out (a bearer link, never stored); null when it cannot be read, and the email then points to Settings › Billing.
 */
async function invoicePage(db: Db, invoiceId: string, override?: BillingProvider) {
  try {
    const provider = override ?? (await db.transaction(tx => billingProvider(tx)))
    return await provider.rechargeInvoicePage(invoiceId)
  } catch (error) {
    console.error(`billing: the page of invoice ${invoiceId} could not be read:`, error)
    return null
  }
}

/**
 * What the recharge cap counts for a UTC month (`YYYY-MM`, the alert's ref): pending, failed-but-payable and paid
 * attempts made in it (docs/billing.md §4.3).
 */
async function rechargedInMonth(db: Db, billId: string, month: string) {
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  const rows = await db
    .select({ amount: billing_recharges.amount_cents })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.billing_account_id, billId),
        inArray(billing_recharges.status, ['pending', 'failed', 'paid']),
        gte(billing_recharges.created_at, start.toISOString()),
        lt(billing_recharges.created_at, end.toISOString()),
      ),
    )
  return rows.reduce((sum, r) => sum + r.amount, 0)
}

async function workspacesOf(db: Db, billId: string) {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return rows.length
}
