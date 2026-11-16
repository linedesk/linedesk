// Trial Checkout on Linedesk Cloud (docs/billing.md §3.2, §2.2, §2.4; billing PR 8): the owner of a bill waiting in
// `pending_payment` starts a Stripe Checkout (`billing.startCheckout`), comes back to /billing/return and the app
// confirms it (`billing.confirmCheckout`). Also "Buy minutes" (`billing.startTopUp`), cancel and resume.
//
// Security rules (security review of #876, M1 and I2):
// - Only the Checkout confirmation moves a bill out of `pending_payment` (`confirmSession`): the owner's
//   `billing.confirmCheckout`, or the webhook's `checkout.session.completed` through the same function. `invoice.paid`
//   only links a subscription (stripe-events.ts); a stored subscription is never a confirmed Checkout. The confirmed
//   Checkout is its own fact, `billing_accounts.checkout_confirmed_at`.
// - Every confirmation of a bill in `pending_payment` runs the card checks: the card's fingerprint (one trial per card,
//   `card_fingerprints`) and its funding (no trial on a prepaid card). A refused trial cancels its subscription at once
//   (nothing was charged) and clears it from the bill, so the owner's next Checkout, without a trial, is linked.
// - A session is acted on only when it is the caller's: our bill id as `client_reference_id`, the bill's own Stripe
//   customer, the expected mode. Anything else answers 404, never what the session is.
// - Checkout always uses the card-only payment method configuration; without it Checkout does not start, and our own
//   setup's refusals (a key without a permission, a missing price) go to the instance admins, not to the owner.
import {
  BillingSetupError,
  type BillingProvider,
  type BillingSubscription,
  type CheckoutSession,
} from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_periods,
  billing_recharges,
  card_fingerprints,
  organization,
  PLAN_PRICES,
  phone_numbers,
  type Tx,
  usage_counters,
  user,
} from '@linedesk/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingRules } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { checkoutExtraAlert, checkoutRefusedAlert, checkoutSetupAlert } from './emails/billing-alerts.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { queueBillingAlert } from './jobs.ts'
import { Forbidden, type Handler, NotFound, type Preparer, Reject } from './handler-context.ts'
import { lockBalance, periodAt, periodForMoney, postEntry } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import { signupRules } from './self-serve.ts'
import { refuseBillingActor } from './usage-levels.ts'

/** The free trial's length (docs/billing.md §3.2 step 3). */
export const TRIAL_DAYS = 14
/**
 * How long a Checkout Session can be completed (Stripe allows 30 minutes to 24 hours): well under a day, so the sign-up
 * sweep never deletes a bill while one of its sessions is still open (security review of #961, G1 and G2).
 */
export const CHECKOUT_EXPIRES_SECONDS = 60 * 60
const checkoutExpiresAt = () => Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_SECONDS
/** "Buy minutes": the amounts the server allows, in cents before tax (docs/billing.md §2.2, L5). */
export const TOPUP_LIMITS = { minCents: 500, maxCents: 50_000 } as const

/** What Checkout shows above its button. Stripe shows it as written (English, like the rest of our Stripe texts). */
export const CHECKOUT_TEXT = {
  trial: `Your ${TRIAL_DAYS}-day free trial starts today. Cancel before it ends and you pay nothing. After the trial your plan renews, and your call balance is recharged automatically when it runs low.`,
  plan: 'Your plan starts today. Your call balance is recharged automatically when it runs low.',
  topup: 'Prepaid call minutes for your Linedesk balance.',
} as const

export const BILLING_OFF = 'Billing is not on for this server.'
export const NOT_THE_OWNER = 'Only the owner of the bill can do this.'
export const CHECKOUT_UNAVAILABLE = 'Checkout is not available right now. The server admins were told; try again later.'
/** A session that is not the caller's, or not known: the same answer (no probing other bills' sessions). */
export const NO_SUCH_CHECKOUT = 'checkout session not found'

type Bill = typeof billing_accounts.$inferSelect

// ---- Whose bill ----------------------------------------------------------------------------------------------

/** The bill of the actor's workspace, owned by the actor; billing must be in effect. Locked when asked. */
async function ownBill(tx: Tx, actor: Actor, { lock = false } = {}): Promise<Bill> {
  refuseBillingActor(actor)
  if ((await billingState(tx)).inEffect !== 'stripe') throw new Reject(BILLING_OFF)
  if (!actor.workspaceId) throw new Reject('no workspace')
  const [org] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, actor.workspaceId))
  if (!org?.bill) throw new Reject('this workspace is not on a bill')
  if (lock) await lockBalance(tx, org.bill)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, org.bill))
  if (!bill) throw new Reject('this workspace is not on a bill')
  if (bill.owner_user_id !== actor.actorId) throw new Forbidden(NOT_THE_OWNER)
  return bill
}

/** The plan's Stripe prices for a bill (docs/billing.md §2.1): a seat per workspace, at the bill's interval. */
async function planItems(tx: Tx, bill: Bill) {
  // The partner plan is not open yet (LIN-322): its sign-up says "not yet", and Checkout refuses it too.
  if (bill.kind !== 'cloud') throw new Reject('The partner plan is not available yet.')
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  const lookupKey = bill.interval === 'year' ? 'ws_yearly' : 'ws_monthly'
  return [{ lookupKey, quantity: Math.max(1, row?.n ?? 1) }]
}

/** Every plan lookup key a Linedesk subscription may have (the public prices). */
const PLAN_KEYS: ReadonlySet<string> = new Set(PLAN_PRICES.map(p => p.lookupKey))
const isLinedeskPlan = (sub: BillingSubscription) =>
  sub.items.length > 0 && sub.items.every(i => !!i.lookupKey && PLAN_KEYS.has(i.lookupKey))

/** Our setup failed (a key, a price, the configuration): the admins hear of it, the owner gets a plain answer. */
async function setupFailed(error: unknown): Promise<never> {
  if (error instanceof BillingSetupError) {
    console.error(`billing: Checkout could not start: ${error.code}`)
    await alertInstanceAdmins(checkoutSetupAlert(error.code)).catch(e =>
      console.error('billing: the Checkout setup alert could not be sent:', e),
    )
    throw new Reject(CHECKOUT_UNAVAILABLE)
  }
  throw error
}

/** The card-only payment method configuration, or no Checkout at all (never `payment_method_types`; I2). */
async function cardOnlyConfiguration(provider: BillingProvider) {
  const configuration = await provider.checkoutPaymentMethodConfiguration().catch(setupFailed)
  if (!configuration) await setupFailed(new BillingSetupError('checkout_configuration_missing'))
  return configuration!
}

/** The bill's Stripe customer: the stored one, else made now (once per bill: the bill id is the idempotency key). */
async function customerOf(provider: BillingProvider, bill: Bill) {
  if (bill.stripe_customer_id) return bill.stripe_customer_id
  const [owner] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, bill.owner_user_id))
  if (!owner) throw new Reject('the owner of this bill has no account')
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
    .limit(1)
  return provider
    .createCustomer({ billId: bill.id, email: owner.email, name: org?.name ?? owner.name })
    .catch(setupFailed)
}

const returnUrl = () => `${WEB_ORIGIN}/billing/return?session_id={CHECKOUT_SESSION_ID}`
const cancelUrl = () => `${WEB_ORIGIN}/`

// ---- Starting Checkout ---------------------------------------------------------------------------------------

/** What a start prepared before its transaction: the session made, and the customer to store. */
type Started = { url: string; sessionId: string; customerId: string; billId: string }

/**
 * `billing.startCheckout` (§3.2 step 3): the plan with a 14-day trial, or without one after a refused trial. Stripe is
 * asked before the transaction (the customer, the configuration, the session); the transaction stores the customer.
 */
const prepareStartCheckout: Preparer = async ({ actor, now }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor))
  if (bill.status !== 'pending_payment') throw new Reject('This bill has finished Checkout.')
  const items = await db.transaction(tx => planItems(tx, bill))
  const provider = await billingProvider(db)
  const configuration = await cardOnlyConfiguration(provider)
  const customerId = await customerOf(provider, bill)
  // One open Checkout per bill (security review of #961, G1): a second tab, or "Add card" again after going back, ends
  // the session before it, so two can never both be completed. One completed meanwhile is caught by confirmSession.
  if (bill.stripe_customer_id) await provider.expireOpenCheckouts(customerId).catch(setupFailed)
  const trial = !bill.trial_refused
  const started = await provider
    .startCheckout({
      kind: trial ? 'trial' : 'plan',
      billId: bill.id,
      customerId,
      paymentMethodConfiguration: configuration,
      items,
      ...(trial ? { trialDays: TRIAL_DAYS } : {}),
      submitText: trial ? CHECKOUT_TEXT.trial : CHECKOUT_TEXT.plan,
      successUrl: returnUrl(),
      cancelUrl: cancelUrl(),
      // A double click within a second makes one session; a later start makes a new one (the open one was expired).
      idempotencyKey: `${bill.id}:checkout:${trial ? 'trial' : 'plan'}:${now.slice(0, 19)}`,
      expiresAt: checkoutExpiresAt(),
    })
    .catch(setupFailed)
  return { url: started.url, sessionId: started.id, customerId, billId: bill.id } satisfies Started
}

/** Stores the bill's customer the first time (a second start finds it). */
async function storeCustomer(tx: Tx, started: Started, now: string) {
  await tx
    .update(billing_accounts)
    .set({ stripe_customer_id: started.customerId, updated_at: now })
    .where(and(eq(billing_accounts.id, started.billId), isNull(billing_accounts.stripe_customer_id)))
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, started.billId))
  if (bill?.stripe_customer_id !== started.customerId) throw new Reject('this bill has another Stripe customer')
}

// ---- Confirming Checkout -------------------------------------------------------------------------------------

/** What `billing.confirmCheckout` answers. */
export type ConfirmData =
  /** The bill is in its trial or paid: the app opens onboarding. */
  | { status: 'trialing' | 'active'; heldForReview: boolean }
  /** No trial for this card (`card_used`: it had one; `prepaid`): its subscription was canceled, start the plan now. */
  | { status: 'trial_refused'; reason: 'card_used' | 'prepaid' }
  /** A top-up: credited once (`credited` false when it was already). */
  | { status: 'topup'; credited: boolean; amountCents: number }

/** Workspace states for a bill state (auth-schema: pending_payment, active, suspended). */
const workspaceState = (status: Bill['status']) => (status === 'pending_payment' ? 'pending_payment' : 'active')

const addMonth = (iso: string) => {
  const d = new Date(iso)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  return d.toISOString()
}

/**
 * The bill's first period (PR 10's period job opens the next ones from it): the trial, or the first month of a paid
 * plan (a yearly plan's first monthly sub-period). With the counter rows of its workspaces. Once.
 */
async function openFirstPeriod(tx: Tx, bill: Bill, start: string, end: string, kind: 'trial' | 'month') {
  if (await periodAt(tx, bill.id, start)) return
  const [period] = await tx
    .insert(billing_periods)
    .values({
      id: `bp_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      billing_account_id: bill.id,
      starts_at: start,
      ends_at: end,
      kind,
    })
    .onConflictDoNothing()
    .returning()
  if (!period) return
  const workspaces = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  if (workspaces.length)
    await tx
      .insert(usage_counters)
      .values(workspaces.map(w => ({ billing_account_id: bill.id, period_id: period.id, workspace_id: w.id })))
      .onConflictDoNothing()
}

/**
 * One trial per card (§3.2 step 4): the card's fingerprint is stored with the first bill whose trial it started.
 * `card_used` when another bill's trial already had it.
 */
async function claimTrial(tx: Tx, fingerprint: string, billId: string, now: string) {
  const [made] = await tx
    .insert(card_fingerprints)
    .values({ fingerprint, first_billing_account_id: billId, trial_used_at: now })
    .onConflictDoNothing()
    .returning()
  if (made) return 'ok' as const
  const [known] = await tx
    .select()
    .from(card_fingerprints)
    .where(eq(card_fingerprints.fingerprint, fingerprint))
    .for('update')
  if (!known) throw new Error('card fingerprint vanished')
  if (known.first_billing_account_id === billId) return 'ok' as const
  if (known.trial_used_at) return 'card_used' as const
  // The card paid a plan before, without a trial: its first trial now.
  await tx.update(card_fingerprints).set({ trial_used_at: now }).where(eq(card_fingerprints.fingerprint, fingerprint))
  return 'ok' as const
}

/** A paid plan's card is remembered too (no trial is used): a later trial with it on another bill is refused. */
async function rememberCard(tx: Tx, fingerprint: string, billId: string) {
  await tx.insert(card_fingerprints).values({ fingerprint, first_billing_account_id: billId }).onConflictDoNothing()
}

/** Subscription states in which a subscription will still charge (canceled or expired ones never do). */
const RUNNING: readonly string[] = ['trialing', 'active', 'past_due', 'incomplete', 'unpaid']

/**
 * The subscription of a Checkout completed after the bill's own (G1): canceled at once (nothing more is charged), and
 * the instance admins are told, with a refund to make when it was paid. Only when it still ran, so a replay of the
 * same session tells nobody twice.
 */
async function dropExtraCheckout(
  provider: BillingProvider,
  bill: Bill,
  session: CheckoutSession,
  sub: BillingSubscription,
) {
  await provider.cancelSubscription(sub.id, { now: true })
  const paid = sub.status !== 'trialing'
  console.error(`billing: bill ${bill.id}: extra Checkout ${session.id}, subscription ${sub.id} canceled`)
  await alertInstanceAdmins(
    checkoutExtraAlert({ bill: bill.id, session: session.id, subscription: sub.id, paid }),
  ).catch(e => console.error('billing: the extra Checkout alert could not be sent:', e))
}

/**
 * Applies a completed Checkout Session to its bill (§3.2 step 4), in the caller's transaction, the bill locked. The
 * one place a bill leaves `pending_payment` (M1). Throws NotFound when the session is not this bill's.
 */
export async function confirmSession(
  tx: Tx,
  billId: string,
  session: CheckoutSession,
  provider: BillingProvider,
  now: string,
): Promise<ConfirmData> {
  await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  // Bound to the caller (§3.2 step 4): our bill id, the bill's own customer, a mode we start.
  if (
    !bill?.stripe_customer_id ||
    session.clientReferenceId !== bill.id ||
    session.customerId !== bill.stripe_customer_id ||
    (session.mode !== 'subscription' && session.mode !== 'payment')
  )
    throw new NotFound(NO_SUCH_CHECKOUT)
  if (session.mode === 'payment') return creditTopUp(tx, bill, session, now)
  if (session.status !== 'complete') throw new Reject('Checkout is not finished yet.')
  const sub = session.subscription
  // The session's own subscription, when Stripe made one for this bill's customer and it still runs.
  const own = sub && sub.customerId === bill.stripe_customer_id && RUNNING.includes(sub.status) ? sub : null
  if (bill.status !== 'pending_payment') {
    // A second session completed after the first was confirmed (two tabs; security review of #961, G1): its
    // subscription would convert and charge for nothing. It is canceled at once and the admins are told.
    if (own && own.id !== bill.stripe_subscription_id) await dropExtraCheckout(provider, bill, session, own)
    // Confirmed before (a reload of the return page, the webhook first): answered as it is, nothing runs again.
    return bill.status === 'trialing' || bill.status === 'active'
      ? { status: bill.status, heldForReview: !!bill.held_for_review_at }
      : (() => {
          throw new Reject('This bill is not waiting for Checkout.')
        })()
  }
  // A refusal after Stripe made a subscription ends that subscription at once, so it never converts and charges
  // (security review of #961, G5); the webhook's refusal tells the admins (checkoutCompleted).
  const refuse = async (message: string): Promise<never> => {
    if (own) await provider.cancelSubscription(own.id, { now: true })
    throw new Reject(message)
  }
  if (!sub || sub.customerId !== bill.stripe_customer_id || !isLinedeskPlan(sub))
    return refuse('This Checkout has no Linedesk plan.')
  // A bill never changes its subscription here: one linked since (by invoice.paid) must be this one.
  if (bill.stripe_subscription_id && bill.stripe_subscription_id !== sub.id)
    return refuse('This bill has another subscription. Ask the server admins.')
  const fingerprint = session.card?.fingerprint
  if (!fingerprint) return refuse('Checkout saved no card.')

  if (sub.status === 'trialing') {
    // The checks run on every confirmation while the bill is pending_payment, whoever linked the subscription (M1).
    const refusal =
      session.card?.funding === 'prepaid' ? ('prepaid' as const) : await claimTrial(tx, fingerprint, bill.id, now)
    if (refusal !== 'ok') {
      // Nothing was charged: the trial's subscription ends at once, and the bill lets go of it, so the owner's next
      // Checkout (the plan now, no trial) is linked by invoice.paid or here. A failure rolls everything back.
      await provider.cancelSubscription(sub.id, { now: true })
      await tx
        .update(billing_accounts)
        .set({ trial_refused: refusal, stripe_subscription_id: null, updated_at: now })
        .where(eq(billing_accounts.id, bill.id))
      return { status: 'trial_refused', reason: refusal }
    }
    if (!sub.trialEnd) return refuse('This trial has no end date.')
    await tx
      .update(billing_accounts)
      .set({
        status: 'trialing',
        stripe_subscription_id: sub.id,
        trial_ends_at: sub.trialEnd,
        checkout_confirmed_at: now,
        current_period_start: now,
        current_period_end: sub.trialEnd,
        ...(sub.interval ? { interval: sub.interval } : {}),
        updated_at: now,
      })
      .where(eq(billing_accounts.id, bill.id))
    await tx
      .update(organization)
      .set({ billingState: workspaceState('trialing') })
      .where(eq(organization.billingAccountId, bill.id))
    await openFirstPeriod(tx, bill, now, sub.trialEnd, 'trial')
    return { status: 'trialing', heldForReview: false }
  }

  if (sub.status !== 'active') throw new Reject('This Checkout is not paid yet.')
  // A plan paid now (after a refused trial): no trial is used, the card is remembered. Radar's risk level of the charge
  // holds number purchase for review (§3.2 step 5).
  await rememberCard(tx, fingerprint, bill.id)
  const rules = await signupRules(tx)
  const held = !!session.riskLevel && rules.reviewRiskLevels.includes(session.riskLevel)
  const start = sub.currentPeriodStart ?? now
  const end = sub.currentPeriodEnd ?? addMonth(start)
  await tx
    .update(billing_accounts)
    .set({
      status: 'active',
      stripe_subscription_id: sub.id,
      checkout_confirmed_at: now,
      card_risk_level: session.riskLevel,
      ...(held ? { held_for_review_at: now } : {}),
      current_period_start: start,
      current_period_end: end,
      ...(sub.interval ? { interval: sub.interval } : {}),
      updated_at: now,
    })
    .where(eq(billing_accounts.id, bill.id))
  await tx
    .update(organization)
    .set({ billingState: workspaceState('active') })
    .where(eq(organization.billingAccountId, bill.id))
  const monthEnd = addMonth(start)
  await openFirstPeriod(tx, bill, start, Date.parse(end) < Date.parse(monthEnd) ? end : monthEnd, 'month')
  return { status: 'active', heldForReview: held }
}

/**
 * A paid top-up (§2.2, L5): credited once with the session's pre-tax amount (`amount_subtotal`, never the total),
 * only for a real charge in USD of a session we made for this bill. The ledger's source key makes it once.
 */
async function creditTopUp(tx: Tx, bill: Bill, session: CheckoutSession, now: string): Promise<ConfirmData> {
  if (session.kind !== 'topup') throw new NotFound(NO_SUCH_CHECKOUT)
  const cents = session.amountSubtotalCents ?? 0
  if (session.status !== 'complete' || session.paymentStatus !== 'paid' || !session.charged)
    throw new Reject('This payment is not finished yet.')
  if (session.currency !== 'usd' || cents < TOPUP_LIMITS.minCents || cents > TOPUP_LIMITS.maxCents)
    throw new Reject('This payment cannot be credited. Ask the server admins.')
  await requireLedgerGuards(tx)
  // The period that contains now, else the bill's latest (as recharges are credited): a top-up after the trial's
  // period ended, before the next one is opened, is still credited (security review of #961, G3).
  const period = await periodForMoney(tx, bill.id, now)
  if (!period) throw new Reject('This bill has no billing period yet.')
  const { posted } = await postEntry(tx, {
    billing_account_id: bill.id,
    period_id: period.id,
    kind: 'topup',
    amount_micros: cents * 10_000,
    source_type: 'stripe_checkout',
    source_id: session.id,
    note: 'Buy minutes',
  })
  return { status: 'topup', credited: posted, amountCents: cents }
}

/** Fetch-before-act: the session as Stripe has it now, outside the transaction. */
const prepareConfirm: Preparer = async ({ actor }, input: { sessionId: string }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor))
  const provider = await billingProvider(db)
  const session = await provider.checkoutSession(input.sessionId)
  if (!session) throw new NotFound(NO_SUCH_CHECKOUT)
  return { billId: bill.id, session }
}

// ---- Top-up, cancel, resume ----------------------------------------------------------------------------------

/** Bills that may buy minutes: in their trial or paid (also past due, so calls can go on). */
const BUYS_MINUTES: readonly Bill['status'][] = ['trialing', 'active', 'past_due']

const prepareTopUp: Preparer = async ({ actor, now }, input: { amountCents: number }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor))
  if (!BUYS_MINUTES.includes(bill.status)) throw new Reject('Minutes can be bought once the plan has started.')
  if (!bill.stripe_customer_id) throw new Reject('This bill has no Stripe customer yet.')
  // Built on the server only (L5): the amount is checked here, and Stripe gets our product and this amount.
  if (input.amountCents < TOPUP_LIMITS.minCents || input.amountCents > TOPUP_LIMITS.maxCents)
    throw new Reject('Buy between $5 and $500 at a time.')
  const provider = await billingProvider(db)
  const configuration = await cardOnlyConfiguration(provider)
  const started = await provider
    .startCheckout({
      kind: 'topup',
      billId: bill.id,
      customerId: bill.stripe_customer_id,
      paymentMethodConfiguration: configuration,
      amountCents: input.amountCents,
      submitText: CHECKOUT_TEXT.topup,
      successUrl: returnUrl(),
      cancelUrl: cancelUrl(),
      idempotencyKey: `${bill.id}:topup:${input.amountCents}:${now.slice(0, 19)}`,
      expiresAt: checkoutExpiresAt(),
    })
    .catch(setupFailed)
  return { url: started.url, sessionId: started.id }
}

/** `billing.cancel` and `billing.resume` (§3.2 step 10): the subscription is asked first, the bill mirrors it. */
const prepareCancel =
  (resume: boolean): Preparer =>
  async ({ actor }) => {
    const bill = await db.transaction(tx => ownBill(tx, actor))
    if (!bill.stripe_subscription_id || !['trialing', 'active', 'past_due'].includes(bill.status))
      throw new Reject('This bill has no running plan.')
    const provider = await billingProvider(db)
    const sub = resume
      ? await provider.resumeSubscription(bill.stripe_subscription_id)
      : await provider.cancelSubscription(bill.stripe_subscription_id, { now: false })
    if (!sub) throw new Reject('Stripe no longer has this plan. Ask the server admins.')
    return { billId: bill.id, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, endsAt: sub.trialEnd ?? sub.currentPeriodEnd }
  }

const applyCancel: Handler = async ({ tx, actor, now, prepared }) => {
  const done = prepared as { billId: string; cancelAtPeriodEnd: boolean; endsAt: string | null }
  const bill = await ownBill(tx, actor, { lock: true })
  if (bill.id !== done.billId) throw new Reject('the bill changed; try again')
  await tx
    .update(billing_accounts)
    .set({ cancel_at_period_end: done.cancelAtPeriodEnd, updated_at: now })
    .where(eq(billing_accounts.id, bill.id))
  return { rows: {}, data: { cancelAtPeriodEnd: done.cancelAtPeriodEnd, endsAt: done.endsAt } }
}

export const checkoutPreparers: Record<string, Preparer> = {
  'billing.startCheckout': prepareStartCheckout,
  'billing.confirmCheckout': prepareConfirm,
  'billing.startTopUp': prepareTopUp,
  'billing.cancel': prepareCancel(false),
  'billing.resume': prepareCancel(true),
}

export const checkoutHandlers: Record<string, Handler> = {
  'billing.startCheckout': async ({ tx, actor, now, prepared }) => {
    const started = prepared as Started
    const bill = await ownBill(tx, actor, { lock: true })
    if (bill.id !== started.billId) throw new Reject('the bill changed; try again')
    await storeCustomer(tx, started, now)
    // The URL is a bearer link: in the answer only, never in the command log (the action marks it secret).
    return { rows: {}, data: { url: started.url } }
  },
  'billing.confirmCheckout': async ({ tx, actor, now, prepared }) => {
    const { billId, session } = prepared as { billId: string; session: CheckoutSession }
    const bill = await ownBill(tx, actor)
    if (bill.id !== billId) throw new NotFound(NO_SUCH_CHECKOUT)
    const provider = await billingProvider(tx)
    return { rows: {}, data: await confirmSession(tx, billId, session, provider, now) }
  },
  'billing.startTopUp': async ({ tx, actor, prepared }) => {
    await ownBill(tx, actor)
    return { rows: {}, data: { url: (prepared as { url: string }).url } }
  },
  'billing.cancel': applyCancel,
  'billing.resume': applyCancel,
}

// ---- Numbers on a billed workspace -----------------------------------------------------------------------------

/** Bill states in which a number may be bought (§3.2 step 6). */
const BUYS_NUMBERS: readonly Bill['status'][] = ['trialing', 'active']

export const NUMBER_NEEDS_CHECKOUT = 'Finish Checkout first: then you can get your number.'
export const NUMBER_HELD_FOR_REVIEW =
  'Getting a number is on hold while we check your card. We will email you; this usually takes less than a day.'
export const TRIAL_NUMBER_LIMIT = 'Your trial includes one number. You can add more once your plan has started.'
export const NUMBER_BILL_INACTIVE = 'Your plan is not active. Pay the open invoice to get numbers again.'
export const NUMBER_OWNER_ONLY = 'Only the owner of the bill can add a number that costs extra.'

/**
 * Why a workspace on a bill may not buy a number now, or null (docs/billing.md §3.2 step 6): runs before the install's
 * purchase limits. Only for workspaces on a bill while billing runs through Stripe; a number on the workspace's own
 * carrier account is not limited by billing. Instance admins buy regardless (they provision by hand).
 */
export async function billingNumberRefusal(tx: Tx, actor: Actor, workspaceId: string): Promise<string | null> {
  if (actor.permissions.includes('instance:admin')) return null
  const [org] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!org?.bill) return null
  if ((await billingState(tx)).inEffect !== 'stripe') return null
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, org.bill))
  if (!bill || bill.status === 'comped') return null
  if (bill.status === 'pending_payment' || !bill.checkout_confirmed_at) return NUMBER_NEEDS_CHECKOUT
  if (!BUYS_NUMBERS.includes(bill.status)) return NUMBER_BILL_INACTIVE
  if (bill.held_for_review_at) return NUMBER_HELD_FOR_REVIEW
  const [held] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(phone_numbers)
    .where(
      and(
        eq(phone_numbers.workspace_id, workspaceId),
        eq(phone_numbers.purchased, true),
        eq(phone_numbers.carrier_account, 'install'),
      ),
    )
  const numbers = held?.n ?? 0
  if (bill.status === 'trialing') {
    const rules = await signupRules(tx)
    return numbers >= rules.trialNumbersPerWorkspace ? TRIAL_NUMBER_LIMIT : null
  }
  // After the trial a number past the included one debits the bill each month (PR 10): the bill's owner only (M3),
  // and only with balance for its first month.
  if (numbers < 1) return null
  if (bill.owner_user_id !== actor.actorId) return NUMBER_OWNER_ONLY
  const rules = await billingRules(tx)
  const balance = await lockBalance(tx, bill.id)
  if (balance.balance_micros - balance.reserved_micros < rules.extraNumberCents * 10_000)
    return `An extra number costs $${(rules.extraNumberCents / 100).toFixed(2)} a month from your balance. Buy minutes first.`
  return null
}

// ---- Stripe events of trial Checkout (stripe-events.ts hands them over) ----------------------------------------

/** The bill an event's customer belongs to (our stored customer id only). */
async function billOfCustomer(customerId: string | null) {
  if (!customerId) return null
  const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.stripe_customer_id, customerId))
  return bill ?? null
}

export type CheckoutEventOutcome =
  | { outcome: 'unknown' }
  | { outcome: 'not_found' }
  | { outcome: 'applied'; bill: string; detail: string }

/**
 * `checkout.session.completed` and `checkout.session.async_payment_succeeded`: the same confirmation as the return
 * page (M1), for an owner who closed the tab before coming back. The bill is found by our stored customer id, and the
 * session must name it.
 */
export async function checkoutCompleted(sessionId: string, customerId: string | null, now: string) {
  const bill = await billOfCustomer(customerId)
  if (!bill) return { outcome: 'unknown' } satisfies CheckoutEventOutcome
  const provider = await billingProvider(db)
  const session = await provider.checkoutSession(sessionId)
  if (!session) return { outcome: 'not_found' } satisfies CheckoutEventOutcome
  // An open session (an async payment) or another bill's: nothing to do, never an error that retries forever.
  if (session.status !== 'complete' || session.clientReferenceId !== bill.id)
    return { outcome: 'applied', bill: bill.id, detail: 'not_complete_or_other' } satisfies CheckoutEventOutcome
  try {
    const data = await db.transaction(tx => confirmSession(tx, bill.id, session, provider, now))
    return { outcome: 'applied', bill: bill.id, detail: data.status } satisfies CheckoutEventOutcome
  } catch (error) {
    if (error instanceof NotFound) return { outcome: 'unknown' } satisfies CheckoutEventOutcome
    if (error instanceof Reject) {
      // A completed Checkout that is not applied may have charged or left a subscription: a person looks (G5, G3).
      console.error(`billing: Checkout ${session.id} of bill ${bill.id} refused: ${error.message}`)
      await alertInstanceAdmins(
        checkoutRefusedAlert({ bill: bill.id, session: session.id, reason: error.message }),
      ).catch(e => console.error('billing: the refused Checkout alert could not be sent:', e))
      return { outcome: 'applied', bill: bill.id, detail: `refused: ${error.message}` } satisfies CheckoutEventOutcome
    }
    throw error
  }
}

/**
 * `customer.subscription.trial_will_end` (§3.2 step 8, day 11): the owner is emailed once per trial what will be
 * charged on which date, with how to cancel. The subscription is fetched; a canceled or converted one gets nothing.
 */
export async function trialWillEnd(subscriptionId: string, customerId: string | null) {
  const bill = await billOfCustomer(customerId)
  if (!bill || bill.stripe_subscription_id !== subscriptionId)
    return { outcome: 'unknown' } satisfies CheckoutEventOutcome
  const provider = await billingProvider(db)
  const sub = await provider.subscription(subscriptionId)
  if (!sub) return { outcome: 'not_found' } satisfies CheckoutEventOutcome
  if (sub.status !== 'trialing' || sub.cancelAtPeriodEnd || !sub.trialEnd || bill.status !== 'trialing')
    return { outcome: 'applied', bill: bill.id, detail: 'no_email' } satisfies CheckoutEventOutcome
  const trialEnd = sub.trialEnd
  const sent = await db.transaction(async tx => {
    // Once per trial: the alert row and the email job in one transaction.
    const [row] = await tx
      .insert(billing_alerts)
      .values({ billing_account_id: bill.id, kind: 'trial_will_end', ref: trialEnd })
      .onConflictDoNothing()
      .returning()
    if (!row) return false
    await queueBillingAlert(tx, { kind: 'trial_will_end', bill: bill.id, ref: trialEnd })
    return true
  })
  return {
    outcome: 'applied',
    bill: bill.id,
    detail: sent ? 'emailed' : 'already_emailed',
  } satisfies CheckoutEventOutcome
}

/** What the recharge added to the conversion invoice says on the invoice. */
export const FIRST_RECHARGE_TEXT = 'Linedesk balance recharge'

/**
 * `invoice.created` (§3.2 step 9): the trial's conversion invoice, still a draft, gets the first recharge as an
 * invoice item (the bill's recharge amount), unless auto-recharge is off. The attempt row (with the invoice id) is
 * stored first, so `invoice.paid` credits it once with the existing rules; the item is added with the attempt id as
 * its idempotency key.
 */
export async function firstRecharge(invoiceId: string, customerId: string | null, now: string) {
  const bill = await billOfCustomer(customerId)
  if (!bill) return { outcome: 'unknown' } satisfies CheckoutEventOutcome
  const provider = await billingProvider(db)
  const invoice = await provider.invoice(invoiceId)
  if (!invoice) return { outcome: 'not_found' } satisfies CheckoutEventOutcome
  const skip = (detail: string) => ({ outcome: 'applied', bill: bill.id, detail }) satisfies CheckoutEventOutcome
  if (
    invoice.status !== 'draft' ||
    invoice.customerId !== bill.stripe_customer_id ||
    !invoice.subscriptionId ||
    invoice.subscriptionId !== bill.stripe_subscription_id ||
    // The first invoice after the trial (Stripe's `subscription_cycle` at the trial's end).
    invoice.billingReason !== 'subscription_cycle'
  )
    return skip('not_conversion')
  const recharge = await db.transaction(async tx => {
    await lockBalance(tx, bill.id)
    const [current] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))
    if (current?.status !== 'trialing' || !current.auto_recharge) return null
    const [stored] = await tx.select().from(billing_recharges).where(eq(billing_recharges.stripe_invoice_id, invoiceId))
    if (stored) return stored
    const [made] = await tx
      .insert(billing_recharges)
      .values({
        id: `rc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        billing_account_id: bill.id,
        amount_cents: current.recharge_amount_cents,
        stripe_invoice_id: invoiceId,
        created_at: now,
      })
      .onConflictDoNothing()
      .returning()
    return made ?? null
  })
  if (!recharge) return skip('no_recharge')
  if (recharge.status !== 'pending') return skip('settled')
  await provider.addInvoiceItem({
    customerId: bill.stripe_customer_id!,
    invoiceId,
    amountCents: recharge.amount_cents,
    description: FIRST_RECHARGE_TEXT,
    rechargeId: recharge.id,
  })
  return skip('recharge_added')
}
