// Charging an auto-recharge (docs/billing.md §2.2, §3.4, PR 4) and the bill owner's billing emails. The recharge
// decision (ledger.ts) only makes a pending `billing_recharges` row; this job, queued in the same transaction, makes
// the Stripe invoice through the billing provider and charges the saved card. It never credits the balance: that
// happens when `invoice.paid` arrives and the invoice is fetched again (the webhook, PR 5).
//
// No transaction stays open while Stripe is asked. The result is written under the bill's lock order (balance row,
// then the recharge row), and only onto an attempt that is still pending, so a webhook that settled it meanwhile wins.
import type { BillingProvider, BillingSetupError, RechargeCharge } from '@linedesk/billing'
import {
  assistants,
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_recharges,
  type Db,
  instance_settings,
  organization,
  planPrice,
  RECHARGE_LIMITS,
  type RECHARGE_TAX,
  rechargeCapCents,
  rechargesIn,
  type Tx,
  user,
} from '@linedesk/db'
import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingRules, invoiceTax, rechargeLine, reminderDaysFor, topUpLine } from './billing-rules.ts'
import { brandName } from './branding.ts'
import { billingProvider } from './billing-settings.ts'
import type { EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { billingUnusableAlert, cappedCallAlert, signupCapAlert, signupKeptAlert } from './emails/alerts.ts'
import { billingOwnerEmail } from './emails/billing.ts'
import { rechargeSetupAlert } from './emails/billing-alerts.ts'
import { queueBillingAlert } from './jobs.ts'
import { extraNumbersOnBill, lockBalance, trialSecondsUsed } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import { signupRules } from './self-serve.ts'

type RechargeTax = (typeof RECHARGE_TAX)[number]

/** Stripe idempotency keys last 24 hours: an attempt older than this looks for its invoice before making one. */
const IDEMPOTENCY_KEY_MS = 23 * 60 * 60_000

/** Bill statuses in which the owner buys minutes (billing-checkout.ts `BUYS_MINUTES`; not imported: a handler module). */
const BUYS_MINUTES = ['trialing', 'active', 'past_due'] as const

/** What the recharge job did with one attempt. */
export type RechargeRun =
  | { outcome: 'not_pending' }
  | { outcome: 'canceled'; reason: 'billing_off' | 'no_customer' | 'bill_inactive' }
  | { outcome: RechargeCharge['status']; invoiceId: string | null }

/**
 * Charges one pending recharge attempt. `provider` replaces the provider in effect (tests). Billing off, no Stripe
 * customer, or a bill no longer charged automatically: the attempt is canceled (it then counts in no cap and a later
 * decision may try again). A network failure throws, so pg-boss tries again with the same idempotency keys.
 */
export async function chargeRecharge(
  db: Db,
  rechargeId: string,
  options: { provider?: BillingProvider; now?: () => string; description?: string } = {},
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
        : // "Buy minutes" with the saved card (`manual`): the owner's purchase, also in the trial, whatever auto-recharge is.
          attempt.manual
          ? (BUYS_MINUTES as readonly string[]).includes(bill.status)
            ? null
            : 'bill_inactive'
          : !rechargesIn(bill.status, bill.trial_recharge_at !== null) || !bill.auto_recharge
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
    description: attempt.manual ? topUpLine(brandName()) : rechargeLine(brandName()),
    invoiceId,
    // Bought in the app just now: charged on-session, so 3D Secure fails at once and the app offers Checkout.
    ...(attempt.manual ? { onSession: true } : {}),
    // Checkout saved the card on the subscription: the adapter makes it the customer's default when there is none (B1).
    subscriptionId: bill.stripe_subscription_id,
    // Stripe Tax as decided for this attempt: tax is added on top; the balance gets the pre-tax amount only (§2.2).
    tax: { ...invoiceTax(await billingRules(db)), automatic: (await attemptTax(db, provider, attempt, bill)) === 'on' },
    // The invoice's id is kept on the attempt as soon as it exists, before its item, finalize or pay can be refused:
    // a give-up after a refusal then stops that invoice instead of leaving it for Stripe to charge (review #1110, R-1).
    onInvoice: id => settle(db, rechargeId, { stripe_invoice_id: id }, now()),
  })
  if (charge.status !== 'failed') {
    await settle(db, rechargeId, { stripe_invoice_id: charge.invoiceId }, now())
    return { outcome: charge.status, invoiceId: charge.invoiceId }
  }
  if (!charge.invoiceId)
    console.error(`billing: recharge ${rechargeId}: Stripe refused its invoice (${charge.failureCode})`)
  await rechargeFailed(db, provider, rechargeId, charge.invoiceId, charge.failureCode, now())
  return { outcome: 'failed', invoiceId: charge.invoiceId }
}

/**
 * How this attempt is taxed (`billing_recharges.tax`), decided at its first try and kept for every retry (security
 * review of #1105, L-1): the same invoice request each time, whatever the switch says by then. With the switch on, a
 * customer Stripe cannot tax (no billing address) is charged without tax (`no_address`) rather than refused: turning tax
 * on never stops a bill's calls (M-1). The billing page asks the owner for the address.
 */
async function attemptTax(
  db: Db,
  provider: BillingProvider,
  attempt: typeof billing_recharges.$inferSelect,
  bill: typeof billing_accounts.$inferSelect,
): Promise<RechargeTax> {
  if (attempt.tax) return attempt.tax
  const decided: RechargeTax = !(await billingRules(db)).automaticTax
    ? 'off'
    : (await provider.customerTaxReady(bill.stripe_customer_id!))
      ? 'on'
      : 'no_address'
  // Only while still undecided: a concurrent run of the same attempt (pg-boss retries one job at a time) keeps its own.
  const [row] = await db
    .update(billing_recharges)
    .set({ tax: sql`coalesce(${billing_recharges.tax}, ${decided})` })
    .where(eq(billing_recharges.id, attempt.id))
    .returning({ tax: billing_recharges.tax })
  if (row?.tax === 'no_address')
    console.warn(`billing: recharge ${attempt.id} of bill ${bill.id} charged without tax: the customer has no address`)
  return row?.tax ?? decided
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
  invoiceId: string | null,
  failureCode: string,
  now: string,
) {
  const invoiceSet = invoiceId ? { stripe_invoice_id: invoiceId } : {}
  const [attempt] = await db.select().from(billing_recharges).where(eq(billing_recharges.id, rechargeId))
  // "Buy minutes" with the saved card: the owner is in the app and goes on to Checkout. The invoice is voided, the
  // attempt canceled; no waiting for a new card, no email, nothing that would stop auto-recharge.
  if (attempt?.manual) {
    if (invoiceId && (await provider.stopRechargeInvoice(invoiceId, { void: true })) === 'paid')
      return creditPaidInvoice(db, rechargeId, invoiceId)
    await settle(db, rechargeId, { status: 'canceled', failure_code: failureCode, ...invoiceSet }, now)
    return
  }
  const needsOwner = failureCode === 'authentication_required' && !!invoiceId
  // Paid meanwhile (Stripe's own collection got there before the give-up, its invoice.paid not processed yet):
  // credited now, never canceled, and no failed-recharge email (security review of #1110, V-1).
  if (invoiceId && (await provider.stopRechargeInvoice(invoiceId, { void: !needsOwner })) === 'paid')
    return creditPaidInvoice(db, rechargeId, invoiceId)
  // Without an invoice (Stripe refused it at create, L-3) the alert is keyed by the attempt: one email per attempt.
  const ref = invoiceId ?? rechargeId
  await settle(
    db,
    rechargeId,
    { status: needsOwner ? 'failed' : 'canceled', failure_code: failureCode, ...invoiceSet },
    now,
    async (tx, billId) => {
      await tx
        .update(billing_accounts)
        .set({ recharge_failed_at: now, updated_at: now })
        .where(eq(billing_accounts.id, billId))
      const added = await tx
        .insert(billing_alerts)
        .values({ billing_account_id: billId, kind: 'recharge_failed', ref })
        .onConflictDoNothing()
        .returning()
      if (added.length)
        await queueBillingAlert(tx, { kind: 'recharge_failed', bill: billId, ref, rechargeId, needsOwner })
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

/**
 * A give-up found the attempt's invoice already paid in Stripe (its automatic collection paid it, the `invoice.paid`
 * webhook not processed yet): it is settled like that webhook (`billing.settleInvoice`, the same checks and the same
 * ledger source key), so the attempt is credited exactly once whichever comes first, and nothing is canceled or
 * emailed as failed (security review of #1110, V-1). Not credited (a check failed): the attempt stays as the settle
 * left it and the admins get its not-credited alert. A refusal to run is thrown: the attempt stays pending and the
 * stuck-recharge alert names it.
 */
async function creditPaidInvoice(db: Db, rechargeId: string, invoiceId: string) {
  const [row] = await db
    .select({ customer: billing_accounts.stripe_customer_id })
    .from(billing_recharges)
    .innerJoin(billing_accounts, eq(billing_accounts.id, billing_recharges.billing_account_id))
    .where(eq(billing_recharges.id, rechargeId))
  // Loaded when it runs: stripe-events.ts imports this file.
  const { runAsBillingSystem } = await import('./stripe-events.ts')
  const settled = await runAsBillingSystem('billing.settleInvoice', { invoiceId, customerId: row?.customer ?? null })
  if (!settled.body.ok) throw new Error(`billing: paid invoice ${invoiceId} of recharge ${rechargeId} not settled`)
  console.warn(`billing: recharge ${rechargeId}: invoice ${invoiceId} was paid before the give-up; settled as paid`)
}

/** How often the setup alert goes out per install and error code (recheck of #865, L-B). */
export const RECHARGE_SETUP_ALERT_MS = 24 * 60 * 60_000
/** The instance setting that remembers when the setup alert for a code last went out. */
export const rechargeSetupAlertKey = (code: string) => `billing.rechargeSetupAlerted:${code}`

/**
 * The last try failed on our own setup (recheck of #864, L2: a 401, 403 or 404 from Stripe, or an account-side 400):
 * not the owner's card, so no `recharge_failed_at` and no owner email. The attempt is canceled (a later decision may try
 * again once the setup is fixed), its invoice (stored, else looked up) is voided or deleted when that still works, and
 * the instance admins are emailed: once per install and error code in 24 hours, not once per bill (a broken key fails
 * every bill's recharge the same way). An invoice found paid is credited instead (V-1).
 */
async function setupGaveUp(
  db: Db,
  provider: BillingProvider,
  attempt: typeof billing_recharges.$inferSelect,
  code: string,
  now: string,
) {
  // The attempt's invoice, also one Stripe has but the attempt does not name yet (refused before its id was stored):
  // voided, or deleted as a draft, so Stripe never charges it later behind a canceled attempt while a new attempt
  // charges again (security review of #1110, R-1). Not found or not stoppable: logged; the stuck and not-credited
  // alerts still name it.
  let invoiceId = attempt.stripe_invoice_id
  if (provider.name !== 'none') {
    if (!invoiceId)
      invoiceId = await provider.findRechargeInvoice(attempt.id).catch(e => {
        console.error(`billing: the invoice of recharge ${attempt.id} could not be looked up:`, e)
        return null
      })
    if (invoiceId) {
      const stopped = await provider.stopRechargeInvoice(invoiceId, { void: true }).catch(e => {
        console.error(`billing: invoice ${invoiceId} could not be stopped:`, e)
        return null
      })
      // Paid meanwhile: credited, not canceled, and nothing failed for the admins to hear of (V-1).
      if (stopped === 'paid') return creditPaidInvoice(db, attempt.id, invoiceId)
    }
  }
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
  | { kind: 'signup_cap'; hour: string; cap: number }
  /**
   * The sign-up sweep kept a bill that waits for Checkout (signup-handlers.ts). Without `reason`: a subscription is
   * linked or the Checkout confirmed in our database (N2); `in_stripe`: Stripe has a running subscription or a
   * completed Checkout for its customer that our database does not show yet (V-1); `stripe_error`: Stripe could not be
   * asked, so the bill waits for the next run.
   */
  | {
      kind: 'signup_kept'
      bill: string
      subscription: string | null
      reason?: 'in_stripe' | 'stripe_error'
      customer?: string
      session?: string | null
    }
  /**
   * A trial reminder (`ref`: the trial's end; `daysBefore`: how many days before it, docs/billing.md §3.2 step 8), and
   * the trial's confirmation when it starts (`ref`: the trial's end).
   */
  | { kind: 'trial_will_end'; bill: string; ref: string; daysBefore: number }
  | { kind: 'trial_started'; bill: string; ref: string }
  /** "One step left" to a sign-up that has not started its trial (billing-checkout.ts sendActivationNudges). */
  | { kind: 'activation_nudge'; bill: string; ref: string }
  /**
   * The trial prompt (docs/billing.md §3.2 step 7; call-billing.ts trialMinutesAlert): most of the trial's minutes
   * used, or used up with calls on the trial grace. `ref`: the trial's period.
   */
  | { kind: 'trial_minutes_low' | 'trial_minutes_used'; bill: string; ref: string }

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
  if (
    job.kind === 'capped_call' ||
    job.kind === 'billing_unusable' ||
    job.kind === 'recharge_setup' ||
    job.kind === 'signup_cap' ||
    job.kind === 'signup_kept'
  ) {
    const alert =
      job.kind === 'capped_call'
        ? cappedCallAlert(job)
        : job.kind === 'recharge_setup'
          ? rechargeSetupAlert({ bill: job.bill, recharge: job.rechargeId, code: job.code })
          : job.kind === 'signup_cap'
            ? signupCapAlert(job.cap)
            : job.kind === 'signup_kept'
              ? signupKeptAlert(job)
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
  if (job.kind === 'activation_nudge') return sendActivationNudge(db, sender, bill.bill, bill.email)
  if (job.kind === 'trial_minutes_low' || job.kind === 'trial_minutes_used')
    return sendTrialMinutes(db, sender, job, bill.bill, bill.email, options.provider)
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
  } else if (job.kind === 'trial_will_end' || job.kind === 'trial_started') {
    // The plan's charge at the end of the trial: what the subscription charges, else a seat per workspace at the
    // bill's interval (before tax).
    const workspaces = await workspacesOf(db, job.bill)
    const price = planPrice(bill.bill.interval === 'year' ? 'ws_yearly' : 'ws_monthly', rules)!
    const charged = await subscriptionCents(db, bill.bill.stripe_subscription_id, options.provider)
    const trial = {
      ...base,
      planCents: charged ?? price.cents * Math.max(1, workspaces),
      interval: bill.bill.interval,
      trialEnd: job.ref,
      rechargeCents: bill.bill.auto_recharge ? bill.bill.recharge_amount_cents : null,
      workspaceId: await oldestWorkspace(db, job.bill),
    }
    content =
      job.kind === 'trial_will_end'
        ? { ...trial, kind: 'trial_will_end', daysBefore: job.daysBefore }
        : { ...trial, kind: 'trial_started', reminderDays: reminderDaysFor(rules) }
  } else {
    // What calls can still use (the balance less what running calls hold): the figure the alert fired on (N3).
    content = { ...base, kind: 'low_balance', balanceMicros: (bill.balance ?? 0) - (bill.reserved ?? 0) }
  }
  const locale = await localeForEmail(db, bill.email)
  await sender.send({ to: bill.email, ...billingOwnerEmail(content, undefined, locale) })
  return { sent: 'owner' as const }
}

/**
 * The "one step left" email, read when it is sent: nothing for a sign-up that started its trial meanwhile (or was
 * swept), whose owner is disabled, or whose workspace is gone or disabled.
 */
async function sendActivationNudge(
  db: Db,
  sender: EmailSender,
  bill: typeof billing_accounts.$inferSelect,
  email: string,
) {
  if (bill.status !== 'pending_payment' || bill.kind !== 'cloud') return { sent: 'nobody' as const }
  const [owner] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, bill.owner_user_id), isNull(user.disabledAt)))
  const [workspace] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(and(eq(organization.billingAccountId, bill.id), isNull(organization.disabledAt)))
    .orderBy(asc(organization.createdAt))
    .limit(1)
  if (!owner || !workspace) return { sent: 'nobody' as const }
  const [assistant] = await db
    .select({ name: assistants.name })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspace.id))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  const rules = await billingRules(db)
  const { pendingDays } = await signupRules(db)
  const locale = await localeForEmail(db, email)
  const content = billingOwnerEmail(
    {
      kind: 'activation_nudge',
      bufferMicros: rules.balanceBufferMicros,
      workspaceId: workspace.id,
      workspace: workspace.name,
      assistant: assistant?.name ?? null,
      trialDays: bill.trial_refused ? null : rules.trialDays,
      deleteOn: new Date(Date.parse(bill.created_at) + pendingDays * 86_400_000).toISOString(),
    },
    undefined,
    locale,
  )
  await sender.send({ to: email, ...content })
  return { sent: 'owner' as const }
}

/**
 * The trial prompt's email, read when it is sent: nothing once the owner pressed "Keep calls answered", the trial
 * ended or auto-recharge was turned off. Names the minutes used, the purchase and the saved card it would charge
 * (brand and last four, read from the billing provider; "your saved card" when it cannot be read), the automatic
 * top-up below the threshold, and until when the plan stays free.
 */
async function sendTrialMinutes(
  db: Db,
  sender: EmailSender,
  job: { kind: 'trial_minutes_low' | 'trial_minutes_used'; ref: string },
  bill: typeof billing_accounts.$inferSelect,
  email: string,
  override?: BillingProvider,
) {
  if (bill.status !== 'trialing' || !bill.auto_recharge || bill.trial_recharge_at) return { sent: 'nobody' as const }
  const rules = await billingRules(db)
  const used = await trialSecondsUsed(db, bill.id, job.ref)
  const locale = await localeForEmail(db, email)
  const content = billingOwnerEmail(
    {
      kind: job.kind,
      bufferMicros: rules.balanceBufferMicros,
      usedMinutes: Math.min(Math.floor(used / 60), Math.floor(rules.includedStandardSeconds / 60)),
      includedMinutes: Math.floor(rules.includedStandardSeconds / 60),
      amountCents: bill.recharge_amount_cents,
      thresholdCents: bill.recharge_threshold_cents,
      card: await savedCard(db, bill, override),
      freeUntil: bill.trial_ends_at,
      standardMicrosPerMinute: rules.levels.standard.microsPerMinute,
      workspaceId: await oldestWorkspace(db, bill.id),
    },
    undefined,
    locale,
  )
  await sender.send({ to: email, ...content })
  return { sent: 'owner' as const }
}

/** The card a recharge of the bill charges (brand and last four), or null when it cannot be read. */
export async function savedCard(
  db: Db | Tx,
  bill: Pick<typeof billing_accounts.$inferSelect, 'id' | 'stripe_customer_id' | 'stripe_subscription_id'>,
  override?: BillingProvider,
) {
  if (!bill.stripe_customer_id) return null
  try {
    const provider = override ?? (await billingProvider(db as Tx))
    const card = await provider.rechargeCard(bill.stripe_customer_id, bill.stripe_subscription_id)
    return card ? { id: card.id, brand: card.brand ?? null, last4: card.last4 ?? null } : null
  } catch (error) {
    console.error(`billing: the saved card of bill ${bill.id} could not be read:`, error)
    return null
  }
}

/**
 * What the subscription charges next, before tax: its items' own prices, which may be older than the install's
 * prices now (a changed price applies to new Checkouts only, docs/billing.md §7b). Null when it cannot be read.
 */
async function subscriptionCents(db: Db, subscriptionId: string | null, override?: BillingProvider) {
  if (!subscriptionId) return null
  try {
    const provider = override ?? (await db.transaction(tx => billingProvider(tx)))
    const sub = await provider.subscription(subscriptionId)
    if (!sub?.items.length || sub.items.some(i => i.unitAmountCents == null)) return null
    return sub.items.reduce((sum, i) => sum + (i.unitAmountCents ?? 0) * i.quantity, 0)
  } catch (error) {
    console.error(`billing: subscription ${subscriptionId} could not be read for the trial's end:`, error)
    return null
  }
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
        eq(billing_recharges.manual, false),
        gte(billing_recharges.created_at, start.toISOString()),
        lt(billing_recharges.created_at, end.toISOString()),
      ),
    )
  return rows.reduce((sum, r) => sum + r.amount, 0)
}

/** The bill's oldest workspace (the button of the trial email opens its Settings › Billing), or null. */
async function oldestWorkspace(db: Db, billId: string) {
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
    .orderBy(asc(organization.createdAt))
    .limit(1)
  return row?.id ?? null
}

async function workspacesOf(db: Db, billId: string) {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return rows.length
}
