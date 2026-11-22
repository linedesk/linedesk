// Trial Checkout on an install that bills its workspaces: the owner of a bill waiting in
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
//   Stripe's test card 4242 4242 4242 4242 in test mode is the one exception (isStripeTestCard): it is never remembered.
// - A session is acted on only when it is the caller's: our bill id as `client_reference_id`, the bill's own Stripe
//   customer, the expected mode. Anything else answers 404, never what the session is.
// - Checkout always uses the card-only payment method configuration; without it Checkout does not start, and our own
//   setup's refusals (a key without a permission, a missing price) go to the instance admins, not to the owner.

import { createHash } from 'node:crypto'
import {
  type BillingProvider,
  BillingSetupError,
  type BillingSubscription,
  type CheckoutSession,
} from '@linedesk/billing'
import {
  type ActivationDisclosure,
  type ActivationFacts,
  type BillingRules,
  billing_accounts,
  billing_alerts,
  billing_periods,
  billing_recharges,
  card_fingerprints,
  EXTRA_CALLS_LOOKUP_PREFIX,
  EXTRA_CALLS_STEP,
  INCLUDED_NUMBERS_PER_WORKSPACE,
  maxExtraCalls,
  minutesPromptFor,
  organization,
  type PlanPrices,
  partners,
  phone_numbers,
  planPrice,
  rechargeCapCents,
  type TRIAL_REFUSALS,
  type TrialRechargeDisclosure,
  type Tx,
  usage_counters,
  user,
  workspace_settings,
} from '@linedesk/db'
import { type MessageKey, msg } from '@linedesk/i18n'
import { and, asc, eq, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { SIGN_IN_AGAIN } from './account.ts'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { PASSKEY_STEP_UP_REQUIRED } from './admin-step-up.ts'
import { managesBill, tellBillOwner } from './bill-manager.ts'
import { pricesForCheckout } from './billing-catalog.ts'
import { billingRules, isLinedeskPlan, planCatalog, reminderDaysFor } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { brandName, currentBranding } from './branding.ts'
import { enabledLevels } from './call-quality.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { checkoutExtraAlert, checkoutRefusedAlert, checkoutSetupAlert } from './emails/billing-alerts.ts'
import { BILLING_PATH } from './emails/billing-lifecycle.ts'
import { appLink, WEB_ORIGIN } from './emails/templates.ts'
import {
  Forbidden,
  type Handler,
  NotFound,
  type Preparer,
  type Reader,
  Reject,
  type Said,
  wordsOf,
} from './handler-context.ts'
import { queueBillingAlert, queueRecharge } from './jobs.ts'
import { feeNumbers, lockBalance, periodAt, periodForMoney, postEntry, trialSecondsUsed } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import { type LegalTerms, legalTerms, recordAcceptance, TERMS_CHANGED } from './legal-terms.ts'
import { ownerStepUpNeeded } from './owner-step-up.ts'
import { PARTNER_BILLING_URL, partnerBillOf } from './partner-billing.ts'
import { createRateLimiter } from './rate-limit.ts'
import { signupRules } from './self-serve.ts'
import { refuseUnservedWorkspaces } from './served-countries.ts'
import { billsToReaccept } from './terms-update.ts'
import { refuseBillingActor } from './usage-levels.ts'
import { workspaceLocale } from './workspace-locale.ts'

/**
 * How long a Checkout Session can be completed (Stripe allows 30 minutes to 24 hours): well under a day, so the sign-up
 * sweep never deletes a bill while one of its sessions is still open (security review of #961, G1 and G2).
 */
export const CHECKOUT_EXPIRES_SECONDS = 60 * 60
const checkoutExpiresAt = () => Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_SECONDS
/** "Buy minutes": the amounts the server allows, in cents before tax. */
export const TOPUP_LIMITS = { minCents: 500, maxCents: 50_000 } as const

/**
 * What Checkout shows above its button, as Stripe shows it: in the language of the owner who starts it, with the
 * install's product name, trial length and prices (Server admin › Branding and › Billing). Short:
 * the trial, the price a month after it (billed yearly or monthly, plus tax where it applies) and the reminder emails,
 * "Your 14-day free trial starts today. Cancel before it ends and you pay nothing. Then $9 a month, billed yearly, plus
 * tax where it applies. We email you 7 days and 1 day before the first charge." Auto-recharge is not mentioned:
 * activation never turns it on (2026-11-17), and its consent is taken when the owner turns it on ("Keep calls
 * answered", Settings › Billing).
 */
export function checkoutText(
  kind: 'trial' | 'plan' | 'topup',
  reader: Reader,
  {
    brand,
    trialDays,
    taxed = false,
    reminderDays = [],
    price,
  }: {
    brand: string
    trialDays: number
    taxed?: boolean
    reminderDays?: number[]
    /** What the plan costs per interval before tax: the text says what that is a month (as the activation step does). */
    price?: { cents: number; interval: 'month' | 'year' }
  },
): string {
  if (kind === 'topup') {
    const text = reader.t('server.api.checkout.text.topup', { brand: plainName(brand) })
    // With Stripe Tax on, the amounts charged are before tax.
    return taxed ? `${text} ${reader.t('server.api.checkout.text.taxNote')}` : text
  }
  const parts = [
    kind === 'trial'
      ? reader.t('server.api.checkout.text.trial', { days: trialDays })
      : price
        ? reader.t('server.api.checkout.text.planPrice', { price: pricePhrase(price, taxed, reader) })
        : reader.t('server.api.checkout.text.plan'),
  ]
  if (kind === 'trial' && price)
    parts.push(reader.t('server.api.checkout.text.then', { price: pricePhrase(price, taxed, reader) }))
  if (taxed && !price) parts.push(reader.t('server.api.checkout.text.taxNote'))
  // The trial's reminder emails, promised where the card is entered too.
  if (kind === 'trial' && reminderDays.length)
    parts.push(reader.t('server.api.checkout.text.reminders', { days: reminderList(reminderDays, reader) }))
  return parts.join(' ')
}

/** "$9 a month, billed yearly, plus tax where it applies", in the reader's language. */
function pricePhrase(price: { cents: number; interval: 'month' | 'year' }, taxed: boolean, reader: Reader): string {
  const cents = price.interval === 'year' ? Math.round(price.cents / 12) : price.cents
  const amount = reader.format.currency(cents / 100, 'USD', { maximumFractionDigits: cents % 100 ? 2 : 0 })
  const phrase =
    price.interval === 'year'
      ? reader.t('server.api.checkout.text.priceYearly', { amount })
      : reader.t('server.api.checkout.text.priceMonthly', { amount })
  return taxed ? reader.t('server.api.checkout.text.plusTax', { price: phrase }) : phrase
}

/** "7 days and 1 day", in the reader's language. */
export function reminderList(days: readonly number[], reader: Reader): string {
  const words = days.map(count => reader.t('server.api.checkout.text.reminderDay', { count }))
  return new Intl.ListFormat(reader.locale, { type: 'conjunction' }).format(words)
}

/**
 * The install's name (and color) at the top of Checkout instead of the Stripe account's (Stripe's per-session
 * `branding_settings`). Everything else Stripe shows (receipts, invoices, the portal) is the account's, shared by every
 * install on that account.
 */
const checkoutBranding = () => ({ displayName: plainName(brandName()), buttonColor: currentBranding().color })

/**
 * The install's name as plain text for Stripe's pages: Checkout's custom text reads a little Markdown (links, bold),
 * and the name is admin-set, so link and emphasis characters and line breaks go (security review of #1102, L-4).
 */
export const plainName = (name: string) =>
  name
    .replace(/[[\]()*_`~#<>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const BILLING_OFF: Said = { key: msg('server.api.checkout.billingOff') }
export const NOT_THE_OWNER: Said = { key: msg('server.api.checkout.notTheOwner') }
export const CHECKOUT_UNAVAILABLE: Said = { key: msg('server.api.checkout.unavailable') }
/** A session that is not the caller's, or not known: the same answer (no probing other bills' sessions). */
export const NO_SUCH_CHECKOUT: Said = { key: msg('server.api.checkout.notFound') }

type Bill = typeof billing_accounts.$inferSelect
type TrialRefusal = (typeof TRIAL_REFUSALS)[number]

// ---- One trial per account -----------------------------------------------------------------------------------

/**
 * Whether the account had its free trial already: it owns another
 * Cloud bill that started a trial or a plan (a confirmed Checkout, a trial end, or a running status). Such an account's
 * next Cloud sign-up gets no trial (`account_used`); the card rule (`card_used`, `prepaid`) applies on top.
 */
export async function accountTrialUsed(tx: Tx, userId: string, exceptBillId?: string): Promise<boolean> {
  const [used] = await tx
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.owner_user_id, userId),
        eq(billing_accounts.kind, 'cloud'),
        exceptBillId ? ne(billing_accounts.id, exceptBillId) : undefined,
        sql`(${billing_accounts.checkout_confirmed_at} is not null or ${billing_accounts.trial_ends_at} is not null or ${billing_accounts.status} in ('trialing', 'active', 'past_due'))`,
      ),
    )
    .limit(1)
  return !!used
}

/**
 * Why a bill waiting for Checkout gets no trial: the stored refusal, else `account_used` for a Cloud bill whose owner
 * had a trial on another bill (also a bill made before the rule, or one a workspace moved to); null: the trial.
 */
export async function trialRefusalOf(tx: Tx, bill: Bill): Promise<Bill['trial_refused']> {
  if (bill.trial_refused) return bill.trial_refused
  if (bill.kind !== 'cloud' || bill.status !== 'pending_payment') return null
  return (await accountTrialUsed(tx, bill.owner_user_id, bill.id)) ? 'account_used' : null
}

/**
 * Whether a bill waiting for Checkout starts with the free trial: a business's (Cloud) bill unless it was refused one.
 * A partner bill never does: White-label Cloud has no free trial and is paid from its Checkout.
 */
export async function trialOffered(tx: Tx, bill: Bill): Promise<boolean> {
  return bill.kind !== 'partner' && !(await trialRefusalOf(tx, bill))
}

// ---- Whose bill ----------------------------------------------------------------------------------------------

/**
 * The bill of the actor's workspace, managed by the actor (its owner, or an owner or admin of the only workspace it
 * pays for: managesBill); billing must be in effect. Locked when asked. With
 * `partnerId`: the bill of that white-label partner instead, managed from the partner area (also with no workspace),
 * only by the partner's owner who owns the bill (partnerBillOf, docs/white-label.md).
 */
export async function ownBill(
  tx: Tx,
  actor: Actor,
  { lock = false, partnerId }: { lock?: boolean; partnerId?: string | undefined } = {},
): Promise<Bill> {
  refuseBillingActor(actor)
  // Whose partner bill first: anyone else gets the same 403 whatever the install's billing.
  const partnerBill = partnerId ? await partnerBillOf(tx, actor, partnerId) : null
  if ((await billingState(tx)).inEffect !== 'stripe') throw new Reject(BILLING_OFF)
  const billId = partnerBill ?? (await workspaceBillId(tx, actor))
  if (lock) await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  if (!bill) throw Reject.t('server.api.checkout.noBill')
  if (!(await managesBill(tx, actor, bill))) throw new Forbidden(NOT_THE_OWNER)
  return bill
}

/**
 * Asked again right before Stripe is: the bill read fresh (no lock: Stripe is never asked inside a transaction), still
 * the same one and still managed by the actor. A hand-over, a new owner or a move to another bill since the first read
 * is refused before Stripe is touched (security review of #1235). The handler checks once more under its own read.
 */
export async function stillManages(actor: Actor, billId: string, partnerId?: string): Promise<void> {
  const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId }))
  if (bill.id !== billId) throw new Reject('the bill changed; try again')
}

/** The bill of the actor's workspace (its id). */
async function workspaceBillId(tx: Tx, actor: Actor): Promise<string> {
  if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
  const [org] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, actor.workspaceId))
  if (!org?.bill) throw Reject.t('server.api.checkout.noBill')
  return org.bill
}

/**
 * The plan's Stripe prices for a bill: a seat per workspace, at the bill's interval. A partner
 * bill: the partner base fee (quantity 1), and a seat per client workspace once it has any (Checkout takes no item of
 * quantity 0; the first client adds the seat item, partner-billing.ts).
 */
async function planItems(tx: Tx, bill: Bill) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  const seats = row?.n ?? 0
  const seat = bill.interval === 'year' ? 'ws_yearly' : 'ws_monthly'
  if (bill.kind === 'partner') {
    const base = bill.interval === 'year' ? 'partner_yearly' : 'partner_monthly'
    return [{ lookupKey: base, quantity: 1 }, ...(seats ? [{ lookupKey: seat, quantity: seats }] : [])]
  }
  return [{ lookupKey: seat, quantity: Math.max(1, seats || 1) }]
}

/**
 * How many Checkouts (a trial, a plan, Buy minutes) one bill may start a minute (security review of #1040, L-3): every
 * start asks Stripe several times, and the account's rate limit is shared with the webhook, recharges and refunds.
 * Per API process, like the other in-memory limits.
 */
export const CHECKOUT_STARTS_PER_MINUTE = 6
export const CHECKOUT_TOO_OFTEN: Said = { key: msg('server.api.checkout.tooOften') }
let allowCheckoutStart = createRateLimiter({ max: CHECKOUT_STARTS_PER_MINUTE, windowMs: 60_000 })
function refuseCheckoutFlood(billId: string) {
  if (!allowCheckoutStart(billId)) throw new Reject(CHECKOUT_TOO_OFTEN)
}
/** Forgets every bill's starts (tests). */
export function resetCheckoutLimit() {
  allowCheckoutStart = createRateLimiter({ max: CHECKOUT_STARTS_PER_MINUTE, windowMs: 60_000 })
}

/** Our setup failed (a key, a price, the configuration): the admins hear of it, the owner gets a plain answer. */
export async function setupFailed(error: unknown): Promise<never> {
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
  if (!owner) throw Reject.t('server.api.checkout.ownerNoAccount')
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
    .limit(1)
  // A partner bill is the partner's company (its clients' names are not the customer).
  const [partner] =
    bill.kind === 'partner'
      ? await db.select({ name: partners.name }).from(partners).where(eq(partners.billing_account_id, bill.id))
      : []
  return provider
    .createCustomer({ billId: bill.id, email: owner.email, name: partner?.name ?? org?.name ?? owner.name })
    .catch(setupFailed)
}

/** Where Checkout returns to; a partner bill's return names the partner, so the page confirms that bill. */
const returnUrl = (partnerId?: string) =>
  `${WEB_ORIGIN}/billing/return?session_id={CHECKOUT_SESSION_ID}${partnerId ? `&partner=${encodeURIComponent(partnerId)}` : ''}`
const cancelUrl = (partnerId?: string) => (partnerId ? `${WEB_ORIGIN}/#partner` : `${WEB_ORIGIN}/`)

// ---- Starting Checkout ---------------------------------------------------------------------------------------

/**
 * What a start prepared before its transaction: the session made, and the customer to store. `accepted`: a business's
 * bill: the terms in effect (accepted at sign-up) and what the activation step said next to its button, recorded in
 * the transaction.
 */
type Started = {
  url: string
  sessionId: string
  customerId: string
  billId: string
  accepted: { terms: LegalTerms; disclosure: ActivationDisclosure } | null
  /** The interval this Checkout sells; stored on the bill when the owner picked another one than it had. */
  interval: 'month' | 'year'
}

type StartInput = {
  partnerId?: string
  /** Extra calls at the same time added on the activation step (LIN-450); a business's bill only. */
  extraCalls?: number
  /** Monthly or yearly, as the owner picked it in the Start your free trial dialog; absent: the bill's interval. */
  interval?: 'month' | 'year'
}

/**
 * The terms in effect, which the bill's owner accepted once, at sign-up (or since, in the app's "We updated our terms"
 * dialog, LIN-420): Checkout and the activation step ask for none. A
 * start is refused with `terms_changed` while the owner has no acceptance of the version in effect for this bill (the
 * terms changed since sign-up): exactly when `/v1/me` `termsUpdate` asks them (terms-update.ts), so nobody starts
 * paying under terms they never accepted. A business's start records them with what the activation step showed; a
 * partner's records nothing (accepted at sign-up). No terms set: a business's Checkout cannot start (sign-up is closed
 * too), a partner's is not held.
 */
async function termsInEffect(bill: Bill): Promise<LegalTerms | null> {
  const { terms } = legalTerms()
  if (!terms) {
    if (bill.kind === 'partner') return null
    throw new Reject(CHECKOUT_UNAVAILABLE)
  }
  const waiting = await db.transaction(tx => billsToReaccept(tx, bill.owner_user_id, terms.termsVersion))
  if (waiting.includes(bill.id)) throw Reject.t('server.api.checkout.termsNotAccepted', undefined, TERMS_CHANGED)
  return terms
}

/**
 * What the activation step shows next to its button, from the bill and the install's rules: the
 * plan's price for the workspaces Checkout sells, the trial (none after a refused one), the first charge's date, the
 * reminder days. No auto-recharge: activation never turns it on. The step reads the same through /v1/me
 * (`activationFacts`).
 */
export function activationDisclosure(
  o: {
    planCents: number
    interval: 'month' | 'year'
    trial: boolean
    /** Extra calls at the same time added on the step (LIN-450), already in `planCents`. */
    extraCalls?: number
  },
  rules: BillingRules,
  now: string,
): ActivationDisclosure {
  const trialDays = o.trial ? rules.trialDays : null
  return {
    ...(o.extraCalls ? { extraCalls: { count: o.extraCalls, monthlyCents: o.extraCalls * rules.extraCallCents } } : {}),
    planCents: o.planCents,
    interval: o.interval,
    trialDays,
    firstChargeAt: trialDays ? new Date(Date.parse(now) + trialDays * 86_400_000).toISOString() : null,
    reminderDays: trialDays ? reminderDaysFor(rules) : [],
  }
}

/**
 * The activation step's facts for a bill waiting for its trial (/v1/me, billing-page.ts): what Checkout will say and
 * charge, from the same rules as `billing.startCheckout`. `now`: the trial would
 * start now, so its first charge is `trialDays` from now (Stripe counts the trial from the subscription's start).
 */
export async function activationFacts(tx: Tx, bill: Bill, rules: BillingRules, now: string): Promise<ActivationFacts> {
  const items = await planItems(tx, bill)
  const trial = await trialOffered(tx, bill)
  // Both intervals' prices: the Start your free trial dialog switches between monthly and yearly before Checkout.
  const planCentsByInterval = {
    month: itemsCents(await planItems(tx, { ...bill, interval: 'month' }), rules),
    year: itemsCents(await planItems(tx, { ...bill, interval: 'year' }), rules),
  }
  return {
    ...activationDisclosure({ planCents: itemsCents(items, rules), interval: bill.interval, trial }, rules, now),
    planCentsByInterval,
    includedMinutes: Math.floor(rules.includedStandardSeconds / 60),
    standardMicrosPerMinute: rules.levels.standard.microsPerMinute,
    calls: {
      included: rules.concurrentCallsPerWorkspace,
      step: EXTRA_CALLS_STEP,
      maxExtra: bill.kind === 'cloud' ? maxExtraCalls(rules) : 0,
      extraCallCents: rules.extraCallCents,
    },
    prices: await planPrices(tx, rules),
  }
}

/**
 * The install's prices the plan card shows (ui/PlanCard.tsx): the included number, minutes and calls at the same time
 * per workspace, the price a minute of each level the server admin has on (call-quality.ts `enabledLevels`), and an
 * extra number. `comped`: a bill that pays nothing for its numbers.
 */
export async function planPrices(tx: Tx, rules: BillingRules, { comped = false } = {}): Promise<PlanPrices> {
  const levels = await enabledLevels(tx)
  return {
    includedNumbers: INCLUDED_NUMBERS_PER_WORKSPACE,
    includedMinutes: Math.floor(rules.includedStandardSeconds / 60),
    includedCalls: rules.concurrentCallsPerWorkspace,
    standardMicrosPerMinute: rules.levels.standard.microsPerMinute,
    premiumMicrosPerMinute: levels.premium ? rules.levels.premium.microsPerMinute : null,
    ultraMicrosPerMinute: levels.ultra ? rules.levels.ultra.microsPerMinute : null,
    extraNumberCents: comped ? 0 : rules.extraNumberCents,
  }
}

/**
 * The plan items with the extra calls at the same time the owner added on the activation step (LIN-450): one more
 * line of the subscription at the bill's interval, sold like Settings › Billing sells it. Only a business's bill, and
 * at most the install's most per workspace (a bill in activation has one workspace).
 */
function withExtraCalls(
  bill: Bill,
  items: { lookupKey: string; quantity: number }[],
  extraCalls: number | undefined,
  rules: BillingRules,
) {
  if (!extraCalls) return items
  if (bill.kind !== 'cloud') throw Reject.t('server.api.checkout.extraCallsBusinessOnly')
  if (extraCalls % EXTRA_CALLS_STEP || extraCalls > maxExtraCalls(rules))
    throw Reject.t('server.api.checkout.extraCallsAboveMax', { max: rules.concurrentCallsMaxPerWorkspace })
  return [...items, { lookupKey: `${EXTRA_CALLS_LOOKUP_PREFIX}${bill.interval}ly`, quantity: extraCalls }]
}

/** What the plan items cost before tax at the install's prices. */
const itemsCents = (items: { lookupKey: string; quantity: number }[], rules: BillingRules) =>
  items.reduce((sum, i) => sum + (planPrice(i.lookupKey, rules)?.cents ?? 0) * i.quantity, 0)

/**
 * The country Checkout's billing address starts at (LIN-647): the workspace's, as Workspace settings shows it (set, else
 * from its numbers, holidays or the hint saved when it was made). The caller's workspace when it is on the bill, else the
 * bill's first. Null when nothing of the workspace names one (the US fallback): then Stripe guesses from the IP.
 */
async function checkoutCountry(tx: Tx, billId: string, actor: Actor): Promise<string | null> {
  const [workspace] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
    .orderBy(sql`${organization.id} = ${actor.workspaceId ?? ''} desc`, asc(organization.createdAt))
    .limit(1)
  if (!workspace) return null
  const locale = await workspaceLocale(tx, workspace.id)
  return locale.countrySource === 'default' ? null : locale.resolvedCountry
}

/**
 * `billing.startCheckout`: a business's plan with a 14-day trial, or without one after a refused trial;
 * a partner's plan always without (trialOffered). Stripe is
 * asked before the transaction (the customer, the configuration, the session); the transaction stores the customer.
 */
const prepareStartCheckout: Preparer = async ({ actor, now }, input: StartInput) => {
  const stored = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
  if (stored.status !== 'pending_payment') throw Reject.t('server.api.checkout.alreadyFinished')
  // Monthly or yearly as picked in the dialog (the sign-up's choice until then): everything below sells that one, and
  // the handler stores it on the bill. Before the first Checkout nothing was charged, so the switch is free.
  const bill: Bill = input.interval ? { ...stored, interval: input.interval } : stored
  const terms = await termsInEffect(bill)
  refuseCheckoutFlood(bill.id)
  const items = await db.transaction(tx => planItems(tx, bill))
  // A Cloud business outside the sign-up countries is told "not yet" before any card (served-countries.ts).
  if (bill.kind === 'cloud') await db.transaction(tx => refuseUnservedWorkspaces(tx, bill.id))
  const provider = await billingProvider(db)
  await stillManages(actor, bill.id, input.partnerId)
  const configuration = await cardOnlyConfiguration(provider)
  const customerId = await customerOf(provider, bill)
  // One open Checkout per bill (security review of #961, G1): a second tab, or "Add card" again after going back, ends
  // the session before it, so two can never both be completed. One completed meanwhile is caught by confirmSession.
  if (bill.stripe_customer_id) await provider.expireOpenCheckouts(customerId).catch(setupFailed)
  // One trial per account (the server decides; the activation step only showed it): checked again here, so a trial
  // started on another bill since the sign-up counts too.
  // A partner bill never has one (trialOffered).
  const trial = await db.transaction(tx => trialOffered(tx, bill))
  // The install's prices, trial and name (Server admin › Billing and › Branding): what this Checkout sells. The price
  // ids are the ones the last catalog sync stored; nothing in Stripe is made or changed here (review of #1040, M-1).
  const rules = await billingRules(db)
  const prices = await pricesForCheckout(provider).catch(setupFailed)
  // The seats first, then the extra calls the step added.
  const sold = withExtraCalls(bill, items, input.extraCalls, rules)
  const country = bill.kind === 'cloud' ? await db.transaction(tx => checkoutCountry(tx, bill.id, actor)) : null
  const started = await provider
    .startCheckout({
      kind: trial ? 'trial' : 'plan',
      billId: bill.id,
      customerId,
      paymentMethodConfiguration: configuration,
      catalog: planCatalog(rules, brandName()),
      prices,
      items: sold,
      ...(trial ? { trialDays: rules.trialDays } : {}),
      submitText: checkoutText(trial ? 'trial' : 'plan', wordsOf(actor), {
        brand: brandName(),
        trialDays: rules.trialDays,
        taxed: rules.automaticTax,
        reminderDays: reminderDaysFor(rules),
        price: { cents: itemsCents(sold, rules), interval: bill.interval },
      }),
      branding: checkoutBranding(),
      ...(country ? { country } : {}),
      successUrl: returnUrl(input.partnerId),
      cancelUrl: cancelUrl(input.partnerId),
      // A double click within a second makes one session; a later start makes a new one (the open one was expired).
      idempotencyKey: `${bill.id}:checkout:${trial ? 'trial' : 'plan'}:${bill.interval}:${now.slice(0, 19)}`,
      expiresAt: checkoutExpiresAt(),
    })
    .catch(setupFailed)
  const accepted =
    terms && bill.kind !== 'partner'
      ? {
          terms,
          disclosure: activationDisclosure(
            {
              planCents: itemsCents(sold, rules),
              interval: bill.interval,
              trial,
              extraCalls: input.extraCalls ?? 0,
            },
            rules,
            now,
          ),
        }
      : null
  return {
    url: started.url,
    sessionId: started.id,
    customerId,
    billId: bill.id,
    accepted,
    interval: bill.interval,
  } satisfies Started
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
  /**
   * No trial (`card_used`: the card had one; `prepaid`; `account_used`: the account had one): its subscription was
   * canceled, start the plan now.
   */
  | { status: 'trial_refused'; reason: TrialRefusal }
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
 * One trial per card: the card's fingerprint is stored with the first bill whose trial it started.
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

/**
 * Stripe's test card 4242 4242 4242 4242 in a test-mode session: every test of the trial uses it, so the one-trial-per-card
 * rule skips it and it is never remembered. A live session never has it (Stripe declines test cards in live mode).
 */
const isStripeTestCard = (session: CheckoutSession) => !session.livemode && session.card?.last4 === '4242'

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
 * The bill's workspaces left the setup's last step (`activate`, the card): their onboarding goes on at the number,
 * which may now be bought.
 */
async function activated(tx: Tx, billId: string) {
  await tx
    .update(workspace_settings)
    .set({ onboarding_step: 'phone' })
    .where(
      and(
        eq(workspace_settings.onboarding_step, 'activate'),
        sql`${workspace_settings.workspace_id} in (select ${organization.id} from ${organization} where ${organization.billingAccountId} = ${billId})`,
      ),
    )
}

/**
 * Applies a completed Checkout Session to its bill, in the caller's transaction, the bill locked. The
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
  // Bound to the caller: our bill id, the bill's own customer, a mode we start.
  if (
    !bill?.stripe_customer_id ||
    session.clientReferenceId !== bill.id ||
    session.customerId !== bill.stripe_customer_id ||
    (session.mode !== 'subscription' && session.mode !== 'payment')
  )
    throw new NotFound(NO_SUCH_CHECKOUT)
  if (session.mode === 'payment') return creditTopUp(tx, bill, session, now)
  if (session.status !== 'complete') throw Reject.t('server.api.checkout.notFinished')
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
          throw Reject.t('server.api.checkout.notWaiting')
        })()
  }
  // A refusal after Stripe made a subscription ends that subscription at once, so it never converts and charges
  // (security review of #961, G5); the webhook's refusal tells the admins (checkoutCompleted).
  const refuse = async (key: MessageKey): Promise<never> => {
    if (own) await provider.cancelSubscription(own.id, { now: true })
    throw Reject.t(key)
  }
  if (!sub || sub.customerId !== bill.stripe_customer_id || !isLinedeskPlan(sub))
    return refuse(msg('server.api.checkout.noPlan'))
  // A bill never changes its subscription here: one linked since (by invoice.paid) must be this one.
  if (bill.stripe_subscription_id && bill.stripe_subscription_id !== sub.id)
    return refuse(msg('server.api.checkout.otherSubscription'))
  const fingerprint = session.card?.fingerprint
  if (!fingerprint) return refuse(msg('server.api.checkout.noCard'))

  // White-label Cloud has no free trial: a partner bill never takes a trial subscription, also one
  // from a Checkout an older release opened, or one made by hand. It ends at once, nothing charged; the owner's next
  // Checkout is the paid plan (trialOffered).
  if (sub.status === 'trialing' && bill.kind === 'partner') return refuse(msg('server.api.checkout.partnerNoTrial'))
  if (sub.status === 'trialing') {
    // The checks run on every confirmation while the bill is pending_payment, whoever linked the subscription (M1).
    // The account had its trial on another bill (a Checkout opened before that, or the rule missed): no trial either.
    const refusal =
      (await trialRefusalOf(tx, bill)) ??
      (session.card?.funding === 'prepaid'
        ? ('prepaid' as const)
        : isStripeTestCard(session)
          ? ('ok' as const)
          : await claimTrial(tx, fingerprint, bill.id, now))
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
    if (!sub.trialEnd) return refuse(msg('server.api.checkout.trialNoEnd'))
    await tx
      .update(billing_accounts)
      .set({
        status: 'trialing',
        stripe_subscription_id: sub.id,
        trial_ends_at: sub.trialEnd,
        checkout_confirmed_at: now,
        // Stripe's own start (the subscription was made at Checkout, seconds before this confirmation): the nightly
        // reconciliation compares the period with Stripe's and reported every new trial otherwise.
        current_period_start: sub.currentPeriodStart ?? now,
        current_period_end: sub.currentPeriodEnd ?? sub.trialEnd,
        ...(sub.interval ? { interval: sub.interval } : {}),
        updated_at: now,
      })
      .where(eq(billing_accounts.id, bill.id))
    await tx
      .update(organization)
      .set({ billingState: workspaceState('trialing') })
      .where(eq(organization.billingAccountId, bill.id))
    await openFirstPeriod(tx, bill, now, sub.trialEnd, 'trial')
    // Extra calls added at activation: stored now, charged with the plan at the trial's end (the trial stays free).
    await applyCheckoutExtraCalls(tx, bill.id, sub, null)
    await activated(tx, bill.id)
    // The trial's confirmation (the card networks' rule for trials: what was agreed, the first charge and how to
    // cancel), once: only this transition out of pending_payment queues it.
    await queueBillingAlert(tx, { kind: 'trial_started', bill: bill.id, ref: sub.trialEnd })
    return { status: 'trialing', heldForReview: false }
  }

  // Refused before (the webhook first, or a reload of the return page): the trial's subscription was canceled then, and
  // the answer is the same refusal again, not "not paid" (LIN-631).
  if (bill.trial_refused && sub.trialEnd && !RUNNING.includes(sub.status))
    return { status: 'trial_refused', reason: bill.trial_refused }
  if (sub.status !== 'active') throw Reject.t('server.api.checkout.notPaid')
  // A plan paid now (after a refused trial): no trial is used, the card is remembered. Radar's risk level of the charge
  // holds number purchase for review.
  if (!isStripeTestCard(session)) await rememberCard(tx, fingerprint, bill.id)
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
  // Extra calls added at activation: the first invoice paid them for this period.
  await applyCheckoutExtraCalls(tx, bill.id, sub, end)
  await activated(tx, bill.id)
  return { status: 'active', heldForReview: held }
}

/**
 * The extra calls at the same time the activation step added (LIN-450): the quantity of the subscription's extra-calls
 * line, given to the bill's workspace (a bill in activation has one), in whole steps and at most the most a workspace
 * may have. `paidUntil`: a plan paid now, whose first invoice paid them until this period end (going back up to them
 * this period is free, as in Settings › Billing); null in a trial, which charges them with the plan at its end.
 */
async function applyCheckoutExtraCalls(
  tx: Tx,
  billId: string,
  sub: NonNullable<CheckoutSession['subscription']>,
  paidUntil: string | null,
) {
  const quantity = sub.items
    .filter(i => i.lookupKey?.startsWith(EXTRA_CALLS_LOOKUP_PREFIX))
    .reduce((n, i) => n + i.quantity, 0)
  if (!quantity) return
  const rules = await billingRules(tx)
  const extra = Math.min(quantity - (quantity % EXTRA_CALLS_STEP), maxExtraCalls(rules))
  if (extra !== quantity)
    console.error(`billing: Checkout of bill ${billId} sold ${quantity} extra calls; ${extra} given (steps, the most)`)
  const [workspace] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
    .orderBy(asc(organization.createdAt))
    .limit(1)
  if (!workspace) return
  await tx.update(organization).set({ extraCalls: extra }).where(eq(organization.id, workspace.id))
  if (paidUntil)
    await tx
      .update(billing_accounts)
      .set({ extra_calls_paid: extra, extra_calls_paid_until: paidUntil })
      .where(eq(billing_accounts.id, billId))
}

/**
 * A paid top-up: credited once with the session's pre-tax amount (`amount_subtotal`, never the total),
 * only for a real charge in USD of a session we made for this bill. The ledger's source key makes it once.
 */
async function creditTopUp(tx: Tx, bill: Bill, session: CheckoutSession, now: string): Promise<ConfirmData> {
  if (session.kind !== 'topup') throw new NotFound(NO_SUCH_CHECKOUT)
  const cents = session.amountSubtotalCents ?? 0
  if (session.status !== 'complete' || session.paymentStatus !== 'paid' || !session.charged)
    throw Reject.t('server.api.checkout.paymentNotFinished')
  if (session.currency !== 'usd' || cents < TOPUP_LIMITS.minCents || cents > TOPUP_LIMITS.maxCents)
    throw Reject.t('server.api.checkout.paymentNotCredited')
  await requireLedgerGuards(tx)
  // The period that contains now, else the bill's latest (as recharges are credited): a top-up after the trial's
  // period ended, before the next one is opened, is still credited (security review of #961, G3).
  const period = await periodForMoney(tx, bill.id, now)
  if (!period) throw Reject.t('server.api.checkout.noPeriod')
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
const prepareConfirm: Preparer = async ({ actor }, input: { sessionId: string; partnerId?: string }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
  const provider = await billingProvider(db)
  await stillManages(actor, bill.id, input.partnerId)
  const session = await provider.checkoutSession(input.sessionId)
  if (!session) throw new NotFound(NO_SUCH_CHECKOUT)
  return { billId: bill.id, session }
}

// ---- Top-up, cancel, resume ----------------------------------------------------------------------------------

/** Bills that may buy minutes: in their trial or paid (also past due, so calls can go on). */
export const BUYS_MINUTES: readonly Bill['status'][] = ['trialing', 'active', 'past_due']

/** Why "Buy minutes" with the saved card went on to Checkout (the web app says so). */
type SavedCardFallback = 'no_card' | 'authentication_required' | 'declined' | 'daily_limit'

/**
 * The most the saved card is charged by Buy minutes in any 24 hours, per bill (security review of #1102, M-1): one
 * purchase at the largest amount. Beyond it the owner pays in Checkout, entering the card. A daily limit and not the
 * monthly cap: purchases counted in the cap would stop the automatic recharges that keep calls running.
 */
export const SAVED_CARD_DAILY_CENTS = 50_000

/** What `billing.startTopUp` answers (`TopUpData` in packages/actions). */
type TopUpAnswer =
  | { kind: 'confirm'; card: { id: string; brand: string | null; last4: string | null } }
  | { kind: 'checkout'; url: string; fallback?: SavedCardFallback }
  | { kind: 'paid'; amountCents: number; credited: boolean }
  | { kind: 'pending'; amountCents: number }

/**
 * The attempt id of a Buy minutes command: the same for a retry of the same command (the client resends it after a
 * lost answer), so the retry finds the purchase it made instead of charging again (security review of #1102, L-1).
 */
const purchaseIdOf = (billId: string, commandId: string) =>
  `rc_${createHash('sha256').update(`${billId}:${commandId}`).digest('hex').slice(0, 20)}`

/** The pending purchase or automatic recharge of the bill, if one runs: one payment at a time. */
async function pendingPayment(billId: string) {
  const [pending] = await db
    .select({ id: billing_recharges.id })
    .from(billing_recharges)
    .where(and(eq(billing_recharges.billing_account_id, billId), eq(billing_recharges.status, 'pending')))
  return pending ?? null
}

/** What Buy minutes charged to the saved card in the last 24 hours (canceled attempts charged nothing). */
async function boughtToday(billId: string, now: string) {
  const since = new Date(Date.parse(now) - 86_400_000).toISOString()
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${billing_recharges.amount_cents}), 0)::int` })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.billing_account_id, billId),
        eq(billing_recharges.manual, true),
        ne(billing_recharges.status, 'canceled'),
        gte(billing_recharges.created_at, since),
      ),
    )
  return row?.cents ?? 0
}

/** The owner proves it is them before the card is charged, as for raising the cap (security review of #1102, M-1). */
async function requireOwnerStepUp(actor: Actor) {
  const stepUp = await ownerStepUpNeeded(db, actor)
  // The web app answers both codes itself: the passkey dialog, and settings.billing.error.signInAgain.
  if (stepUp === 'passkey')
    // i18n-ignore: the API error body for logs and API clients; the web app opens the passkey dialog for the code
    throw new Reject('Confirm with your passkey to pay with the saved card.', PASSKEY_STEP_UP_REQUIRED)
  if (stepUp)
    // i18n-ignore: the API error body for logs and API clients; the web app shows the key of the code
    throw new Reject('Sign in again to pay with the saved card.', SIGN_IN_AGAIN)
}

/** A purchase's step; `card` on a charge: the card charged (brand and last four), for the trial recharge's consent. */
type SavedCardStep =
  | Exclude<TopUpAnswer, { kind: 'paid' | 'pending' }>
  | (Extract<TopUpAnswer, { kind: 'paid' | 'pending' }> & { card?: ShownCard })
  | { kind: 'fallback'; reason: SavedCardFallback }
type ShownCard = { brand: string | null; last4: string | null }

/** The card a retried purchase charged (its first answer was lost): read again, or unknown. */
async function chargedCard(provider: BillingProvider, bill: Bill): Promise<ShownCard | undefined> {
  const { savedCard } = await import('./billing-recharge.ts')
  return (await savedCard(db, bill, provider)) ?? undefined
}

/** The answer without the card (the client was shown it already). */
const strip = ({ card: _card, ...answer }: Extract<SavedCardStep, { kind: 'paid' | 'pending' }>): TopUpAnswer => answer

/**
 * What "Keep calls answered" showed and the owner agreed to, for the consent record:
 * the minutes used of the trial's included ones, the purchase and its card, the automatic top-up after it (threshold,
 * monthly cap) and until when the plan stays free. Read again after the charge, from the bill and the install's rules.
 */
async function trialRechargeConsent(
  bill: Bill,
  card: ShownCard | undefined,
  ids: { commandId: string; now: string },
): Promise<TrialRechargeDisclosure> {
  const rules = await billingRules(db)
  const [workspaces] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  const period = await db.transaction(tx => periodAt(tx, bill.id, ids.now))
  const used = period ? await trialSecondsUsed(db, bill.id, period.id) : 0
  return {
    kind: 'trial_recharge',
    usedMinutes: Math.floor(used / 60),
    includedMinutes: Math.floor(rules.includedStandardSeconds / 60),
    amountCents: bill.recharge_amount_cents,
    card: card ?? { brand: null, last4: null },
    thresholdCents: bill.recharge_threshold_cents,
    capCents: rechargeCapCents(bill.recharge_cap_base_cents, workspaces?.n ?? 1, rules),
    freeUntil: bill.status === 'trialing' ? bill.trial_ends_at : null,
    standardMicrosPerMinute: rules.levels.standard.microsPerMinute,
    rechargeId: purchaseIdOf(bill.id, ids.commandId),
  }
}

/**
 * "Buy minutes" with the saved card, in two steps. Without `confirmCard` it only answers which
 * card would be charged (brand and last four), and the owner confirms that card; with it, the owner's step-up is
 * checked (a recent sign-in or the passkey, as for raising the cap) and the card a recharge charges (`rechargeCard`)
 * is charged at once, on-session, when it is still the confirmed one, with an invoice like a recharge's (tax, receipt,
 * refunds and disputes as for recharges). The attempt is a `billing_recharges` row marked `manual`: credited here at
 * once (and by `invoice.paid`, through the same rules), never counted in the monthly cap of automatic recharges, and
 * at most `SAVED_CARD_DAILY_CENTS` in 24 hours. No card, over the daily limit, 3D Secure or a decline: Checkout.
 */
async function buyWithSavedCard(
  provider: BillingProvider,
  actor: Actor,
  bill: Bill,
  input: { amountCents: number; confirmCard?: string; partnerId?: string },
  ids: { commandId: string; now: string },
): Promise<SavedCardStep> {
  const { partnerId } = input
  const id = purchaseIdOf(bill.id, ids.commandId)
  const [retried] = await db.select().from(billing_recharges).where(eq(billing_recharges.id, id))
  if (retried) return purchaseOutcome(provider, bill, retried)
  const card = await provider.rechargeCard(bill.stripe_customer_id!, bill.stripe_subscription_id).catch(setupFailed)
  if (!card) return { kind: 'fallback', reason: 'no_card' }
  if ((await boughtToday(bill.id, ids.now)) + input.amountCents > SAVED_CARD_DAILY_CENTS)
    return { kind: 'fallback', reason: 'daily_limit' }
  // The card shown is the card charged: a card changed since the owner saw it is shown again.
  if (input.confirmCard !== card.id)
    return { kind: 'confirm', card: { id: card.id, brand: card.brand ?? null, last4: card.last4 ?? null } }
  await requireOwnerStepUp(actor)
  await stillManages(actor, bill.id, partnerId)
  const attempt = await db.transaction(async tx => {
    await requireLedgerGuards(tx)
    await lockBalance(tx, bill.id)
    const [made] = await tx
      .insert(billing_recharges)
      .values({
        id,
        billing_account_id: bill.id,
        amount_cents: input.amountCents,
        manual: true,
        created_at: ids.now,
      })
      .onConflictDoNothing()
      .returning()
    return made ?? null
  })
  // One payment at a time per bill (an automatic recharge or another purchase is running).
  if (!attempt) throw Reject.t('server.api.checkout.paymentRunning')
  const step = await purchaseOutcome(provider, bill, attempt)
  return step.kind === 'paid' || step.kind === 'pending'
    ? { ...step, card: { brand: card.brand ?? null, last4: card.last4 ?? null } }
    : step
}

/** Charges a Buy minutes attempt (again: every step has the attempt's idempotency key) and says what came of it. */
async function purchaseOutcome(
  provider: BillingProvider,
  bill: Bill,
  attempt: typeof billing_recharges.$inferSelect,
): Promise<SavedCardStep> {
  const amountCents = attempt.amount_cents
  const { chargeRecharge, rechargeGaveUp } = await import('./billing-recharge.ts')
  let run: Awaited<ReturnType<typeof chargeRecharge>>
  try {
    run = await chargeRecharge(db, attempt.id, { provider })
  } catch (error) {
    if (error instanceof BillingSetupError) {
      await rechargeGaveUp(db, attempt.id, { provider, setupError: error })
      return setupFailed(error)
    }
    // No answer from Stripe: the recharge job tries again with the same idempotency keys, so the payment the owner
    // confirmed is made once at most; the balance follows when it is paid.
    console.error(`billing: Buy minutes ${attempt.id} of bill ${bill.id}: no answer from Stripe, queued`, error)
    await db.transaction(tx => queueRecharge(tx, attempt.id))
    return { kind: 'pending', amountCents }
  }
  const [now] = await db.select().from(billing_recharges).where(eq(billing_recharges.id, attempt.id))
  if (run.outcome === 'paid' || now?.status === 'paid') {
    const { runAsBillingSystem } = await import('./stripe-events.ts')
    const invoiceId = run.outcome === 'paid' ? run.invoiceId : now?.stripe_invoice_id
    const settled = invoiceId
      ? await runAsBillingSystem('billing.settleInvoice', { invoiceId, customerId: bill.stripe_customer_id })
      : null
    const credited =
      now?.status === 'paid' || (!!settled?.body.ok && !!(settled.body.data as { credited?: unknown }).credited)
    return { kind: 'paid', amountCents, credited }
  }
  if (run.outcome === 'open' || now?.status === 'pending') return { kind: 'pending', amountCents }
  // Failed: rechargeFailed voided the invoice and canceled the attempt (no failed-recharge wait, no email).
  return {
    kind: 'fallback',
    reason:
      now?.failure_code === 'authentication_required'
        ? 'authentication_required'
        : now?.failure_code
          ? 'declined'
          : 'no_card',
  }
}

const prepareTopUp: Preparer = async (
  { actor, now, commandId },
  input: {
    amountCents: number
    savedCard?: boolean
    confirmCard?: string
    trialRecharge?: boolean
    partnerId?: string
  },
) => {
  const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
  if (!BUYS_MINUTES.includes(bill.status)) throw Reject.t('server.api.checkout.minutesAfterStart')
  if (!bill.stripe_customer_id) throw Reject.t('server.api.checkout.noCustomer')
  refuseCheckoutFlood(bill.id)
  // Built on the server only (L5): the amount is checked here, and Stripe gets our product and this amount.
  if (input.amountCents < TOPUP_LIMITS.minCents || input.amountCents > TOPUP_LIMITS.maxCents)
    throw Reject.t('server.api.checkout.topupRange', {
      min: reader => reader.format.currency(TOPUP_LIMITS.minCents / 100, 'USD'),
      max: reader => reader.format.currency(TOPUP_LIMITS.maxCents / 100, 'USD'),
    })
  // "Keep calls answered": the bill's recharge amount on the saved card, offered in the
  // trial until pressed there and on a paid plan with auto-recharge off (`minutesPromptFor`); it turns auto-recharge on.
  // The terms in effect are recorded with it, so they must be there before a charge.
  if (input.trialRecharge) {
    const { terms } = legalTerms()
    if (!terms) throw new Reject(CHECKOUT_UNAVAILABLE)
    if (!input.savedCard || !minutesPromptFor(bill) || input.amountCents !== bill.recharge_amount_cents)
      throw Reject.t('server.api.checkout.trialRechargeChanged')
  }
  const provider = await billingProvider(db)
  await stillManages(actor, bill.id, input.partnerId)
  let fallback: SavedCardFallback | undefined
  if (input.savedCard) {
    const step = await buyWithSavedCard(provider, actor, bill, input, { commandId, now })
    if (step.kind !== 'fallback') {
      const consent =
        input.trialRecharge && (step.kind === 'paid' || step.kind === 'pending')
          ? await trialRechargeConsent(bill, step.card ?? (await chargedCard(provider, bill)), { commandId, now })
          : null
      return { billId: bill.id, answer: step.kind === 'paid' || step.kind === 'pending' ? strip(step) : step, consent }
    }
    fallback = step.reason
  }
  // A purchase still running (no answer from Stripe yet) is not paid for a second time in Checkout (review L-2).
  if (await pendingPayment(bill.id)) throw Reject.t('server.api.checkout.paymentRunning')
  if (input.savedCard) await stillManages(actor, bill.id, input.partnerId)
  const configuration = await cardOnlyConfiguration(provider)
  const rules = await billingRules(db)
  const started = await provider
    .startCheckout({
      kind: 'topup',
      billId: bill.id,
      customerId: bill.stripe_customer_id,
      paymentMethodConfiguration: configuration,
      catalog: planCatalog(rules, brandName()),
      amountCents: input.amountCents,
      submitText: checkoutText('topup', wordsOf(actor), {
        brand: brandName(),
        trialDays: rules.trialDays,
        taxed: rules.automaticTax,
      }),
      branding: checkoutBranding(),
      successUrl: returnUrl(input.partnerId),
      // Bought from Settings › Billing (or Partner › Billing): going back from Checkout lands there again.
      cancelUrl: input.partnerId ? PARTNER_BILLING_URL() : appLink(WEB_ORIGIN, actor.workspaceId!, BILLING_PATH),
      idempotencyKey: `${bill.id}:topup:${input.amountCents}:${now.slice(0, 19)}`,
      expiresAt: checkoutExpiresAt(),
    })
    .catch(setupFailed)
  const answer: TopUpAnswer = { kind: 'checkout', url: started.url, ...(fallback ? { fallback } : {}) }
  return { billId: bill.id, answer }
}

/**
 * Bill statuses in which the owner cancels or resumes in the app. Suspended too (security review of #1007, L-5): the
 * portal has no cancel, so the app is the one place to cancel, also while calls are paused.
 */
const CANCELS: readonly Bill['status'][] = ['trialing', 'active', 'past_due', 'suspended']

/** `billing.cancel` and `billing.resume`: the subscription is asked first, the bill mirrors it. */
const prepareCancel =
  (resume: boolean): Preparer =>
  async ({ actor }, input: { partnerId?: string }) => {
    const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
    if (!bill.stripe_subscription_id || !CANCELS.includes(bill.status))
      throw Reject.t('server.api.checkout.noRunningPlan')
    const provider = await billingProvider(db)
    await stillManages(actor, bill.id, input.partnerId)
    const sub = resume
      ? await provider.resumeSubscription(bill.stripe_subscription_id)
      : await provider.cancelSubscription(bill.stripe_subscription_id, { now: false })
    if (!sub) throw Reject.t('server.api.checkout.planGone')
    return {
      billId: bill.id,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      endsAt: sub.trialEnd ?? sub.currentPeriodEnd,
      wasCanceling: bill.cancel_at_period_end,
    }
  }

const applyCancel: Handler = async ({ tx, actor, now, prepared }, input: { partnerId?: string }) => {
  const done = prepared as { billId: string; cancelAtPeriodEnd: boolean; endsAt: string | null; wasCanceling: boolean }
  const bill = await ownBill(tx, actor, { lock: true, partnerId: input.partnerId })
  if (bill.id !== done.billId) throw new Reject('the bill changed; try again')
  await tx
    .update(billing_accounts)
    .set({ cancel_at_period_end: done.cancelAtPeriodEnd, updated_at: now })
    .where(eq(billing_accounts.id, bill.id))
  // Someone else who manages the bill canceled or resumed it: its owner hears of it, once. Compared with the bill as
  // it was before Stripe was asked, so a webhook that mirrored the change meanwhile does not hide it.
  if (done.cancelAtPeriodEnd !== done.wasCanceling)
    await tellBillOwner(
      tx,
      actor,
      bill,
      done.cancelAtPeriodEnd ? { change: 'cancel', endsAt: done.endsAt } : { change: 'resume' },
      now,
    )
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
  'billing.startCheckout': async ({ tx, actor, now, prepared }, input: StartInput) => {
    const started = prepared as Started
    const bill = await ownBill(tx, actor, { lock: true, partnerId: input.partnerId })
    if (bill.id !== started.billId) throw new Reject('the bill changed; try again')
    await storeCustomer(tx, started, now)
    // Another interval than the sign-up's, picked in the dialog: the bill says what this Checkout sells (the Checkout
    // confirmation stores the subscription's own interval again).
    if (bill.interval !== started.interval)
      await tx
        .update(billing_accounts)
        .set({ interval: started.interval, updated_at: now })
        .where(and(eq(billing_accounts.id, bill.id), eq(billing_accounts.status, 'pending_payment')))
    // The consent to the trial and its automatic charge, recorded before Checkout opens (A9): what the activation step
    // said next to its button, with the terms in effect (accepted at sign-up; the step does not ask for them again).
    if (started.accepted)
      await recordAcceptance(tx, {
        userId: actor.actorId,
        billId: bill.id,
        sessionId: actor.sessionId!,
        terms: started.accepted.terms,
        disclosure: started.accepted.disclosure,
        now,
        source: 'activation',
      })
    // The URL is a bearer link: in the answer only, never in the command log (the action marks it secret).
    return { rows: {}, data: { url: started.url } }
  },
  'billing.confirmCheckout': async ({ tx, actor, now, prepared }, input: { partnerId?: string }) => {
    const { billId, session } = prepared as { billId: string; session: CheckoutSession }
    const bill = await ownBill(tx, actor, { partnerId: input.partnerId })
    if (bill.id !== billId) throw new NotFound(NO_SUCH_CHECKOUT)
    const provider = await billingProvider(tx)
    return { rows: {}, data: await confirmSession(tx, billId, session, provider, now) }
  },
  'billing.startTopUp': async ({ tx, actor, now, prepared }, input: { partnerId?: string }) => {
    const done = prepared as { billId: string; answer: TopUpAnswer; consent?: TrialRechargeDisclosure | null }
    const bill = await ownBill(tx, actor, { partnerId: input.partnerId })
    // Money that moved is never answered with an error (a retry would be a second purchase; review of #1102, L-1).
    const charged = done.answer.kind === 'paid' || done.answer.kind === 'pending'
    if (bill.id !== done.billId && !charged) throw new Reject('the bill changed; try again')
    if (bill.id !== done.billId)
      console.error(`billing: Buy minutes for bill ${done.billId} answered while the owner's bill is now ${bill.id}`)
    // "Keep calls answered" charged: auto-recharge is on from now (in the trial too), and the consent is kept (the
    // terms in effect, the session's IP and browser, what the banner showed). Once: a retry finds it on already.
    if (done.consent && bill.id === done.billId) {
      const trial = bill.status === 'trialing'
      const [turnedOn] = await tx
        .update(billing_accounts)
        .set({ auto_recharge: true, ...(trial ? { trial_recharge_at: now } : {}), updated_at: now })
        .where(
          and(
            eq(billing_accounts.id, bill.id),
            trial ? isNull(billing_accounts.trial_recharge_at) : eq(billing_accounts.auto_recharge, false),
          ),
        )
        .returning({ id: billing_accounts.id })
      const { terms } = legalTerms()
      if (turnedOn && terms && actor.sessionId)
        await recordAcceptance(tx, {
          userId: actor.actorId,
          billId: bill.id,
          sessionId: actor.sessionId,
          terms,
          disclosure: done.consent,
          now,
          source: 'trial_recharge',
        })
    }
    return { rows: {}, data: done.answer }
  },
  'billing.cancel': applyCancel,
  'billing.resume': applyCancel,
}

// ---- Numbers on a billed workspace -----------------------------------------------------------------------------

/** Bill states in which a number may be bought. */
const BUYS_NUMBERS: readonly Bill['status'][] = ['trialing', 'active']

export const NUMBER_NEEDS_CHECKOUT: Said = { key: msg('server.api.checkout.number.needsCheckout') }
export const NUMBER_HELD_FOR_REVIEW: Said = { key: msg('server.api.checkout.number.heldForReview') }
export const TRIAL_NUMBER_LIMIT: Said = { key: msg('server.api.checkout.number.trialLimit') }
export const NUMBER_BILL_INACTIVE: Said = { key: msg('server.api.checkout.number.billInactive') }
export const NUMBER_OWNER_ONLY: Said = { key: msg('server.api.checkout.number.ownerOnly') }
/** An extra number debits the bill each month: a person decides it in the app, as themselves (LIN-439). */
export const NUMBER_EXTRA_IN_APP: Said = { key: msg('server.api.checkout.number.extraInApp') }

/**
 * The workspace's bill while billing runs through Stripe, and why its state alone stops a new number (checkout not
 * done, not paying, held for review), or null without a bill.
 */
export async function billOfWorkspaceForNumbers(tx: Tx, workspaceId: string) {
  const [org] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!org?.bill) return null
  if ((await billingState(tx)).inEffect !== 'stripe') return null
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, org.bill))
  if (!bill) return null
  // A comped bill pays nothing, but an extra number still costs the install each month: who may add one is the same
  // as on a paying bill, only without the balance (LIN-505).
  const comped = bill.status === 'comped'
  const blocked =
    !comped && (bill.status === 'pending_payment' || !bill.checkout_confirmed_at)
      ? NUMBER_NEEDS_CHECKOUT
      : !comped && !BUYS_NUMBERS.includes(bill.status)
        ? NUMBER_BILL_INACTIVE
        : !comped && bill.held_for_review_at
          ? NUMBER_HELD_FOR_REVIEW
          : null
  return { bill, comped, blocked }
}

/**
 * Why a workspace on a bill may not buy a number now, or null: runs before the install's
 * purchase limits. Only for workspaces on a bill while billing runs through Stripe (with billing off, as on a self-hosted
 * install, only the install's purchase limits apply); a number on the workspace's own carrier account is not limited by
 * billing. Instance admins buy regardless (they provision by hand). `feeWaived`: the number asked for costs nothing a
 * month (a number that needs documents while the install waives their fee, `regulatedNumberFeeWaived`): only the bill's
 * state and the trial's limit apply, not what an extra number needs.
 */
export async function billingNumberRefusal(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  { feeWaived = false }: { feeWaived?: boolean } = {},
): Promise<Said | null> {
  if (actor.permissions.includes('instance:admin')) return null
  const found = await billOfWorkspaceForNumbers(tx, workspaceId)
  if (!found) return null
  if (found.blocked) return found.blocked
  const { bill, comped } = found
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
  // Never through a key or a setup link: a setup link keeps the actorId of the bill owner who made
  // it. Nor while an admin is signed in as someone else (LIN-439). The first number may (onboarding buys it).
  const inApp = !(actor.apiKeyId || actor.personalKeyId || actor.setupKeyId || actor.impersonation)
  if (bill.status === 'trialing') {
    const rules = await signupRules(tx)
    if (numbers >= rules.trialNumbersPerWorkspace) return TRIAL_NUMBER_LIMIT
    // A second trial number becomes an extra number once the plan starts.
    return numbers >= 1 && !inApp ? NUMBER_EXTRA_IN_APP : null
  }
  // After the trial a number past the included one debits the bill each month (PR 10): only someone who manages the
  // bill (M3; its owner, or an owner or admin of its only workspace: managesBill), and only with balance for its first
  // month. A free number debits nothing; one already held for free does not take the included one (feeNumbers).
  if (feeWaived) return null
  const [paying] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(phone_numbers)
    .where(and(eq(phone_numbers.workspace_id, workspaceId), await feeNumbers(tx)))
  if ((paying?.n ?? 0) < 1) return null
  if (!inApp) return NUMBER_EXTRA_IN_APP
  if (!(await managesBill(tx, actor, bill))) return NUMBER_OWNER_ONLY
  if (comped) return null
  const rules = await billingRules(tx)
  const balance = await lockBalance(tx, bill.id)
  if (balance.balance_micros - balance.reserved_micros < rules.extraNumberCents * 10_000)
    return {
      key: msg('server.api.checkout.number.extraCost'),
      params: { amount: reader => reader.format.currency(rules.extraNumberCents / 100, 'USD') },
    }
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

// ---- Trial reminders ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * The reminder due for a trial now: the smallest of the reminder days whose moment (the trial's end less that many
 * days) has come, never one that fell before the trial started (`startedAt`), and none once the trial ended. Null
 * when none is due. A run that missed the 7-day reminder and finds the 1-day one due sends only the 1-day one.
 */
export function dueReminder(
  days: readonly number[],
  trialEnd: string,
  startedAt: string | null,
  now: string,
): number | null {
  const end = Date.parse(trialEnd)
  const at = Date.parse(now)
  if (!(end > at)) return null
  const started = startedAt ? Date.parse(startedAt) : -Infinity
  const due = days.filter(d => end - d * DAY_MS <= at && end - d * DAY_MS >= started)
  return due.length ? Math.min(...due) : null
}

/** Days after sign-up when a sign-up that has not started its trial gets its one "one step left" email. */
export const ACTIVATION_NUDGE_DAYS = 3

/**
 * The "one step left" email: once per Cloud sign-up still `pending_payment`
 * ACTIVATION_NUDGE_DAYS after it was made, sent within a day of that (a run missed for longer skips it rather than
 * nudging late) and never once the sign-up sweep is due. Marked in `billing_alerts` in the transaction that queues it,
 * so two runs never both send it; the job checks again when it sends (activated, swept, owner or workspace disabled:
 * nothing). Returns the bills nudged this run. Run hourly by billing.periods.
 */
export async function sendActivationNudges(now: string, { billId }: { billId?: string } = {}): Promise<string[]> {
  const { pendingDays } = await signupRules(db)
  const at = Date.parse(now)
  const from = new Date(at - (ACTIVATION_NUDGE_DAYS + 1) * DAY_MS).toISOString()
  const to = new Date(at - ACTIVATION_NUDGE_DAYS * DAY_MS).toISOString()
  const sweptBefore = new Date(at - pendingDays * DAY_MS).toISOString()
  const bills = await db
    .select({ id: billing_accounts.id })
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'pending_payment'),
        eq(billing_accounts.kind, 'cloud'),
        sql`${billing_accounts.created_at} > ${from}::timestamptz`,
        sql`${billing_accounts.created_at} <= ${to}::timestamptz`,
        sql`${billing_accounts.created_at} > ${sweptBefore}::timestamptz`,
        billId ? eq(billing_accounts.id, billId) : undefined,
      ),
    )
  const nudged: string[] = []
  for (const bill of bills) {
    const sent = await db.transaction(async tx => {
      const [row] = await tx
        .insert(billing_alerts)
        .values({ billing_account_id: bill.id, kind: 'activation_nudge', ref: `day${ACTIVATION_NUDGE_DAYS}` })
        .onConflictDoNothing()
        .returning()
      if (!row) return false
      await queueBillingAlert(tx, { kind: 'activation_nudge', bill: bill.id, ref: row.ref })
      return true
    })
    if (sent) nudged.push(bill.id)
  }
  return nudged
}

/**
 * The trial reminders: every bill in its trial gets an email on each of the install's
 * reminder days before the trial ends (7 and 1 by default), with the first charge's date and amount and a direct way to
 * cancel. Hourly (billing-periods.ts) and on Stripe's `customer.subscription.trial_will_end` for that bill
 * (`billId`). The subscription is fetched first (fetch-before-act): a canceled or converted trial gets nothing, nor a
 * bill whose trial end differs from Stripe's. Once per trial and day: the `billing_alerts` row (kind `trial_will_end`,
 * ref `<trial end>/<days>d`) is made in the transaction that queues the email. Answers the bills emailed.
 */
export async function sendTrialReminders(
  now: string,
  { billId, provider: given }: { billId?: string; provider?: BillingProvider } = {},
): Promise<string[]> {
  const rules = await billingRules(db)
  const days = reminderDaysFor(rules)
  if (!days.length) return []
  const bills = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.status, 'trialing'),
        isNotNull(billing_accounts.stripe_subscription_id),
        isNotNull(billing_accounts.trial_ends_at),
        sql`${billing_accounts.trial_ends_at} > ${now}::timestamptz`,
        sql`${billing_accounts.trial_ends_at} <= ${new Date(Date.parse(now) + Math.max(...days) * DAY_MS).toISOString()}::timestamptz`,
        billId ? eq(billing_accounts.id, billId) : undefined,
      ),
    )
  const emailed: string[] = []
  let provider = given
  for (const bill of bills) {
    const due = dueReminder(days, bill.trial_ends_at!, bill.checkout_confirmed_at, now)
    if (due === null || bill.cancel_at_period_end) continue
    const ref = `${bill.trial_ends_at}/${due}d`
    const [already] = await db
      .select({ ref: billing_alerts.ref })
      .from(billing_alerts)
      .where(
        and(
          eq(billing_alerts.billing_account_id, bill.id),
          eq(billing_alerts.kind, 'trial_will_end'),
          eq(billing_alerts.ref, ref),
        ),
      )
    if (already) continue
    provider ??= await billingProvider(db)
    const sub = await provider.subscription(bill.stripe_subscription_id!)
    if (sub?.status !== 'trialing' || sub.cancelAtPeriodEnd || !sub.trialEnd) continue
    if (sub.customerId !== bill.stripe_customer_id || Date.parse(sub.trialEnd) !== Date.parse(bill.trial_ends_at!))
      continue
    const sent = await db.transaction(async tx => {
      const [row] = await tx
        .insert(billing_alerts)
        .values({ billing_account_id: bill.id, kind: 'trial_will_end', ref })
        .onConflictDoNothing()
        .returning()
      if (!row) return false
      await queueBillingAlert(tx, { kind: 'trial_will_end', bill: bill.id, ref: sub.trialEnd!, daysBefore: due })
      return true
    })
    if (sent) emailed.push(bill.id)
  }
  return emailed
}

/**
 * `customer.subscription.trial_will_end` (Stripe's, 3 days before the end by default): no email of its own; the bill's
 * trial reminders are checked at once, so a reminder due is not left to the next hourly run.
 */
export async function trialWillEnd(subscriptionId: string, customerId: string | null, now: string) {
  const bill = await billOfCustomer(customerId)
  if (!bill || bill.stripe_subscription_id !== subscriptionId)
    return { outcome: 'unknown' } satisfies CheckoutEventOutcome
  const emailed = await sendTrialReminders(now, { billId: bill.id })
  return {
    outcome: 'applied',
    bill: bill.id,
    detail: emailed.length ? 'emailed' : 'no_email',
  } satisfies CheckoutEventOutcome
}
