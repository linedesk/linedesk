// Stripe's webhook events (docs/billing.md §5.1): the stored inbox, the job that processes one event, the sweeper and
// reprocessing. The route (stripe-webhook.ts) only checks the signature and stores the event with its job in one
// transaction; everything else happens here, as the system actor with `billing:system`, through the registry.
//
// Rules (security review of #849, L2): an event finds its bill only through ids we stored (`stripe_customer_id`,
// `stripe_subscription_id`, `billing_recharges.stripe_invoice_id`), never through metadata alone; an event of a
// customer we do not know is retried for an hour (its bill may be stored a moment later), then marked processed with
// no action (other integrations may share the Stripe account); the object is fetched from Stripe before acting
// (`prepare`, outside the transaction), and the payload's amounts are never trusted. Every effect happens once: the
// ledger's unique source keys, and the event row locked while it is applied.
//
// Only what processing reads is stored of an event (security review of #865, L4): its id, type, time, mode and the
// object's id, kind and customer. A type this release does not act on stays unprocessed with a marker (M1), so the
// release that handles it processes the stored events too.
import type {
  BillingEvent,
  BillingInvoice,
  BillingInvoiceLine,
  BillingProvider,
  BillingSubscription,
} from '@linedesk/billing'
import {
  billing_accounts,
  billing_invoices,
  billing_recharges,
  organization,
  PLAN_PRICES,
  stripe_events,
  type Tx,
} from '@linedesk/db'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { rechargeFailed } from './billing-recharge.ts'
import { billingProvider, billingState, refuseMoneyChange } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type NotCreditedReason, rechargeNotCreditedAlert, stripeEventFailedAlert } from './emails/billing-alerts.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { jobQueue } from './jobs.ts'
import { lockBalance, periodForMoney, postEntry } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'

/** Processes one stored event. */
export const STRIPE_EVENT = 'billing.stripeEvent'
/** Every 5 minutes: queues the events that are stored but neither processed nor queued (a lost job). */
export const STRIPE_EVENT_SWEEP = 'billing.stripeEventSweep'
const STRIPE_EVENT_SWEEP_CRON = '*/5 * * * *'
/** After this many failed attempts the instance admins are told and only `billing.reprocessEvent` tries again. */
export const STRIPE_EVENT_ATTEMPTS = 5
/** An event still unprocessed this long after it arrived is queued again by the sweeper. */
export const SWEEP_AFTER_MS = 5 * 60_000
/** Stored events are kept this long (they hold names, emails and addresses; docs/billing.md §8). */
export const STRIPE_EVENT_KEEP_DAYS = 90
/** The longest error text kept on an event (Stripe's messages name no secret, but stay short). */
const ERROR_MAX = 500
/** An event whose customer no bill has is tried again for this long before it is marked processed (review of #865, L2). */
export const UNKNOWN_RETRY_MS = 60 * 60_000

/**
 * `last_error` of an event this release stores but does not act on (security review of #865, M1): it stays unprocessed,
 * its attempts at the cap, so nothing retries or alerts on it. `UNHANDLED_TYPE`: the type is not handled; the sweeper
 * queues it again once a release handles the type. `UNHANDLED_PLAN`: a plan invoice's failure or void (dunning, a later
 * PR), which that PR processes again by type and marker.
 */
export const UNHANDLED_TYPE = 'unhandled: type'
export const UNHANDLED_PLAN = 'unhandled: plan invoice'

/** `invoice.paid` is applied in a transaction (billing.processStripeEvent); the failures by the job (they ask Stripe). */
const INVOICE_PAID = 'invoice.paid'
const INVOICE_FAILURES = ['invoice.payment_failed', 'invoice.voided'] as const
/** A new card (docs/billing.md §3.4): ends the wait after a failed recharge. By the job too (it asks Stripe). */
const CARD_CHANGES = ['payment_method.attached', 'customer.updated'] as const
/**
 * Trial Checkout (docs/billing.md §3.2, billing-checkout.ts): a finished Checkout confirmed like the return page does
 * (the only way out of `pending_payment` besides the owner's own confirmation, security review M1), the trial's end
 * email, and the first recharge added to the conversion invoice. By the job (they ask Stripe).
 */
const CHECKOUT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.trial_will_end',
  'invoice.created',
] as const
/** The event types this release acts on. */
export const HANDLED_EVENTS: readonly string[] = [
  INVOICE_PAID,
  ...INVOICE_FAILURES,
  ...CARD_CHANGES,
  ...CHECKOUT_EVENTS,
]

/** The API's billing jobs: `billing:system` only, which no role, API key, setup link or session has. */
export const billingSystemActor: Actor = {
  actorId: 'billing:system',
  role: 'member',
  workspaceId: null,
  permissions: ['billing:system'],
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/** Queues the processing of one event in the caller's transaction; one queued or running job per event. */
export async function queueStripeEvent(tx: Tx, eventId: string) {
  await jobQueue()?.send(STRIPE_EVENT, { eventId }, { db: fromDrizzle(tx, sql), singletonKey: eventId })
}

export type StoreOutcome = 'stored' | 'requeued' | 'duplicate'

/**
 * The inbox (docs/billing.md §5.1): stores the event and queues its job in one transaction, so an event is never
 * stored without its job. A redelivery of an event already stored queues it again only while it is unprocessed and not
 * given up on (review of #865, N2: an event at the attempt cap waits for billing.reprocessEvent).
 */
export async function storeStripeEvent(tx: Tx, event: BillingEvent, now: string): Promise<StoreOutcome> {
  const [stored] = await tx
    .insert(stripe_events)
    .values({
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      created: iso(event.created),
      received_at: now,
      // The minimum processing reads, in Stripe's shape (L4: no names, emails or addresses kept).
      payload: {
        id: event.id,
        type: event.type,
        created: event.created,
        livemode: event.livemode,
        data: { object: { id: event.objectId, object: event.objectType, customer: event.customerId } },
      },
    })
    .onConflictDoNothing()
    .returning({ id: stripe_events.id })
  if (stored) {
    await queueStripeEvent(tx, event.id)
    return 'stored'
  }
  const [existing] = await tx
    .select({ processed_at: stripe_events.processed_at, attempts: stripe_events.attempts })
    .from(stripe_events)
    .where(eq(stripe_events.id, event.id))
  if (existing && !existing.processed_at && existing.attempts < STRIPE_EVENT_ATTEMPTS) {
    await queueStripeEvent(tx, event.id)
    return 'requeued'
  }
  return 'duplicate'
}

/** The object and customer of a stored event, read from its payload only to know what to fetch. */
function eventSubject(payload: unknown): { objectId: string | null; customerId: string | null } {
  const object = (payload as { data?: { object?: { id?: unknown; customer?: unknown } } })?.data?.object
  const customer = object?.customer
  return {
    objectId: typeof object?.id === 'string' ? object.id : null,
    customerId:
      typeof customer === 'string'
        ? customer
        : typeof (customer as { id?: unknown })?.id === 'string'
          ? (customer as { id: string }).id
          : null,
  }
}

type Bill = typeof billing_accounts.$inferSelect
type Recharge = typeof billing_recharges.$inferSelect

/**
 * What `prepare` fetched from Stripe for an invoice event: the invoice as it is now, and its subscription when the
 * invoice was the bill's subscription's then (`subscriptionFetched`; the handler retries when that changed since).
 */
type InvoiceFetch = {
  kind: 'invoice'
  invoice: BillingInvoice | null
  subscription: BillingSubscription | null
  subscriptionFetched: boolean
}
type Prepared = { kind: 'none' } | InvoiceFetch

/** The recharge attempt charged by this invoice (we stored the invoice id), and the bill it is for. */
async function rechargeOfInvoice(tx: Pick<Tx, 'select'>, invoiceId: string) {
  const [recharge] = await tx.select().from(billing_recharges).where(eq(billing_recharges.stripe_invoice_id, invoiceId))
  return recharge ?? null
}

async function billBy(tx: Pick<Tx, 'select'>, column: 'customer' | 'subscription' | 'id', value: string | null) {
  if (!value) return null
  const match =
    column === 'customer'
      ? eq(billing_accounts.stripe_customer_id, value)
      : column === 'subscription'
        ? eq(billing_accounts.stripe_subscription_id, value)
        : eq(billing_accounts.id, value)
  const [bill] = await tx.select().from(billing_accounts).where(match)
  return bill ?? null
}

/** The bill an invoice is for, through our stored ids only: its recharge attempt, else its Stripe customer. */
async function billOfInvoice(tx: Pick<Tx, 'select'>, invoiceId: string, customerId: string | null) {
  const recharge = await rechargeOfInvoice(tx, invoiceId)
  const bill = recharge ? await billBy(tx, 'id', recharge.billing_account_id) : await billBy(tx, 'customer', customerId)
  return { recharge, bill }
}

/**
 * Fetch-before-act, outside the transaction: the invoice as Stripe has it now, and its subscription when it is the
 * bill's. Nothing is fetched for an invoice or customer no bill here has.
 */
async function fetchInvoice(invoiceId: string, customerId: string | null): Promise<Prepared> {
  const { bill } = await billOfInvoice(db, invoiceId, customerId)
  if (!bill) return { kind: 'none' }
  const provider = await billingProvider(db)
  // Billing turned off between the job's check and here: fail, the sweeper queues it again once it is on.
  if (provider.name === 'none') throw new Error('billing is off')
  const invoice = await provider.invoice(invoiceId)
  // A subscription invoice of the bill's own customer while the bill has no subscription yet: Checkout's first
  // `invoice.paid` comes within a second of the payment, before the owner is back in the app to store it (billing
  // review of 16.11., B4). Its subscription is fetched too, so the handler can link it (linkSubscription).
  const unlinked =
    !!invoice?.subscriptionId &&
    !bill.stripe_subscription_id &&
    !!bill.stripe_customer_id &&
    invoice.customerId === bill.stripe_customer_id
  const subscriptionFetched =
    !!invoice?.subscriptionId && (invoice.subscriptionId === bill.stripe_subscription_id || unlinked)
  const subscription = subscriptionFetched ? await provider.subscription(invoice!.subscriptionId!) : null
  return { kind: 'invoice', invoice, subscription, subscriptionFetched }
}

/** What an event needs fetched before it is applied (`prepare` of billing.processStripeEvent). */
async function prepareEvent(eventId: string): Promise<Prepared> {
  const [event] = await db.select().from(stripe_events).where(eq(stripe_events.id, eventId))
  if (!event || event.processed_at || event.type !== INVOICE_PAID) return { kind: 'none' }
  const { objectId, customerId } = eventSubject(event.payload)
  return objectId ? fetchInvoice(objectId, customerId) : { kind: 'none' }
}

export type EventOutcome =
  /** Not acted on in this release: left unprocessed with its marker (UNHANDLED_TYPE, UNHANDLED_PLAN). */
  | { outcome: 'unhandled'; marker: string }
  /** No bill here has this object or customer (another integration on the same Stripe account). */
  | { outcome: 'unknown' }
  /** No bill has it yet, and the event is young: tried again by the sweeper (review of #865, L2). */
  | { outcome: 'unknown_retry' }
  /** A recharge invoice failed or was voided: PR 4's failed-recharge rules ran (rechargeFailed). */
  | { outcome: 'recharge_failed'; bill: string; recharge: string; code: string }
  /** Stripe no longer has the object. */
  | { outcome: 'not_found' }
  | { outcome: 'already_processed' }
  | {
      outcome: 'applied'
      bill: string
      /** What a Checkout event did (billing-checkout.ts): `trialing`, `trial_refused`, `emailed`, `recharge_added`. */
      detail?: string
      credited?: { recharge: string; micros: number; posted: boolean }
      notCredited?: { recharge: string; reason: NotCreditedReason }
      plan?: 'active' | 'unchanged'
      /** The bill had no subscription yet, and this paid invoice's became it (linkSubscription). */
      linked?: string
    }
  /** A new card after a failed recharge: the wait ended (`cleared`), or the card is the one that failed. */
  | { outcome: 'card_changed'; bill: string; cleared: boolean }

/** Why a paid recharge invoice must not credit the balance, or its line when it is a real payment of the attempt's amount. */
export function notCreditedReason(
  invoice: BillingInvoice,
  recharge: Recharge,
  bill: Bill,
): { reason: NotCreditedReason } | { line: BillingInvoiceLine } {
  if (recharge.status === 'canceled') return { reason: 'canceled' }
  if (!bill.stripe_customer_id || invoice.customerId !== bill.stripe_customer_id) return { reason: 'customer_mismatch' }
  if (invoice.currency !== 'usd') return { reason: 'currency' }
  // The recharge's own line: the invoice item the recharge job made (its metadata), or the only invoice item of an
  // invoice made for this attempt alone.
  const items = invoice.lines.filter(l => l.kind === 'invoice_item')
  const line =
    items.find(l => l.rechargeId === recharge.id) ??
    (invoice.rechargeId === recharge.id && items.length === 1 ? items[0] : undefined)
  if (!line) return { reason: 'no_line' }
  if (line.currency !== 'usd') return { reason: 'currency' }
  if (line.amountCents !== recharge.amount_cents) return { reason: 'amount_mismatch' }
  // Credit only for a real payment of the whole invoice (M4; security review of #865, L1): not marked paid out of
  // band, no discount or credit on the recharge's own line (a coupon on the plan line of a conversion invoice is the
  // plan's business; recheck of #865, L-A), no customer credit balance applied, and its total paid by charges or
  // payment intents.
  if (invoice.amountPaidOffStripeCents > 0) return { reason: 'out_of_band' }
  if (line.discountCents !== 0) return { reason: 'discounted' }
  // The rest of the invoice must not pay for the recharge (delta review of #866): no negative line (a credit item, a
  // proration credit) beside it, and the pre-tax total at least the recharge, so a $20 line next to a −$15 line paid
  // with $5 credits nothing. Fails closed: an admin decides.
  if (invoice.lines.some(l => l.amountCents < 0) || invoice.totalCents - invoice.taxCents < line.amountCents)
    return { reason: 'not_covered' }
  if (
    invoice.startingBalanceCents !== 0 ||
    invoice.amountPaidCents !== invoice.totalCents ||
    invoice.chargedCents < invoice.totalCents
  )
    return { reason: 'not_charged' }
  return { line }
}

/** The bill's period for an entry posted now: the one that contains now, else its latest (a credit is never lost). */
async function periodForCredit(tx: Tx, billId: string, now: string) {
  const period = await periodForMoney(tx, billId, now)
  if (!period) throw new Error(`billing: bill ${billId} has no period to credit a recharge in`)
  return period
}

/** Credits a paid recharge once (docs/billing.md §2.2): the attempt becomes `paid`, the balance gets the pre-tax amount. */
async function creditRecharge(tx: Tx, bill: Bill, recharge: Recharge, line: BillingInvoiceLine, now: string) {
  const period = await periodForCredit(tx, bill.id, now)
  const { posted } = await postEntry(tx, {
    billing_account_id: bill.id,
    period_id: period.id,
    kind: 'recharge',
    amount_micros: line.amountCents * 10_000,
    source_type: 'billing_recharge',
    source_id: recharge.id,
  })
  if (recharge.status !== 'paid')
    await tx
      .update(billing_recharges)
      .set({ status: 'paid', resolved_at: now })
      .where(eq(billing_recharges.id, recharge.id))
  // A paid recharge ends the wait after a failed one (section 3.4).
  if (bill.recharge_failed_at)
    await tx
      .update(billing_accounts)
      .set({ recharge_failed_at: null, updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
  return { recharge: recharge.id, micros: line.amountCents * 10_000, posted }
}

/** The lookup keys of our plan prices: a subscription of only these is a Linedesk plan. */
const PLAN_LOOKUP_KEYS: ReadonlySet<string> = new Set(PLAN_PRICES.map(p => p.lookupKey))

/** Stripe statuses of a subscription that is running (paid, in its trial, or being retried). */
const LIVE_SUBSCRIPTION: readonly string[] = ['active', 'trialing', 'past_due']
/** Bill statuses that take a subscription they do not have yet (never a canceled or comped one). */
const LINKABLE: readonly Bill['status'][] = ['pending_payment', 'trialing', 'active', 'past_due', 'suspended']

/**
 * A paid subscription invoice of the bill's customer, before the bill stored its subscription (B4): Stripe sends
 * `invoice.paid` for Checkout's first invoice before the owner is back in the app. Marking that event processed with no
 * effect left the bill inactive for good. The subscription is linked here instead, from the objects fetched just now,
 * only when it is the bill's own customer's (the customer id we stored, on both the invoice and the subscription) and
 * a Linedesk plan (every item one of our plan prices), and only onto a bill that has none: a bill never changes its
 * subscription here. Idempotent: a second delivery finds it linked and is applied as the bill's own.
 */
async function linkSubscription(
  tx: Tx,
  bill: Bill,
  invoice: BillingInvoice,
  subscription: BillingSubscription | null,
  now: string,
) {
  if (bill.stripe_subscription_id || !LINKABLE.includes(bill.status)) return null
  if (!invoice.subscriptionId || subscription?.id !== invoice.subscriptionId) return null
  if (!bill.stripe_customer_id || invoice.customerId !== bill.stripe_customer_id) return null
  if (subscription.customerId !== bill.stripe_customer_id || !LIVE_SUBSCRIPTION.includes(subscription.status))
    return null
  if (!subscription.items.length || !subscription.items.every(i => i.lookupKey && PLAN_LOOKUP_KEYS.has(i.lookupKey)))
    return null
  // A bill whose trial was refused (card used before, prepaid) never links a trial subscription: only the owner's next
  // Checkout, the plan without a trial, may be linked (security review of #961, G4).
  if (bill.trial_refused && subscription.status === 'trialing') return null
  const [linked] = await tx
    .update(billing_accounts)
    .set({ stripe_subscription_id: subscription.id, updated_at: now })
    .where(and(eq(billing_accounts.id, bill.id), isNull(billing_accounts.stripe_subscription_id)))
    .returning()
  return linked ?? null
}

/** Bill statuses a paid plan invoice makes active again (a trial converted, a late payment); never canceled or comped. */
const ACTIVATED_BY_PAYMENT: readonly Bill['status'][] = ['trialing', 'active', 'past_due', 'suspended']

/** A paid plan invoice (docs/billing.md §3.2 step 9, §3.4): the bill active, its period from the fetched subscription. */
async function planPaid(tx: Tx, bill: Bill, subscription: BillingSubscription | null, now: string) {
  if (subscription?.status !== 'active' || !ACTIVATED_BY_PAYMENT.includes(bill.status)) return 'unchanged' as const
  // A payment lifts only a payment suspension: one an instance admin made (or a dispute's) stays (review of #865, N1).
  // Fails closed: a suspension without a reason (the database refuses one, review of #919 L1) stays too.
  const held = bill.status === 'suspended' && bill.suspend_reason !== 'payment'
  await tx
    .update(billing_accounts)
    .set({
      ...(held ? {} : { status: 'active' as const, past_due_since: null, suspended_at: null, suspend_reason: null }),
      current_period_start: subscription.currentPeriodStart,
      current_period_end: subscription.currentPeriodEnd,
      ...(subscription.interval ? { interval: subscription.interval } : {}),
      updated_at: now,
    })
    .where(eq(billing_accounts.id, bill.id))
  if (held) return 'unchanged' as const
  await tx.update(organization).set({ billingState: 'active' }).where(eq(organization.billingAccountId, bill.id))
  return 'active' as const
}

/** The invoice in the bill's list (display only): plan invoices and recharges. */
async function mirrorInvoice(
  tx: Tx,
  bill: Bill,
  invoice: BillingInvoice,
  kind: 'subscription' | 'recharge',
  now: string,
) {
  if (!invoice.status) return
  const row = {
    billing_account_id: bill.id,
    kind,
    number: invoice.number,
    status: invoice.status,
    total_cents: invoice.totalCents,
    tax_cents: invoice.taxCents,
    period_start: invoice.periodStart,
    period_end: invoice.periodEnd,
    hosted_invoice_url: invoice.hostedInvoiceUrl,
    pdf_url: invoice.pdfUrl,
    updated_at: now,
  }
  await tx
    .insert(billing_invoices)
    .values({ stripe_invoice_id: invoice.id, ...row })
    .onConflictDoUpdate({ target: billing_invoices.stripe_invoice_id, set: row })
}

/**
 * The recharge attempt a paid invoice charges, when the recharge job has not stored the invoice id yet: Stripe sends
 * `invoice.paid` as soon as the job's pay call succeeds, before the job writes `stripe_invoice_id`. Taken from the
 * invoice as fetched from Stripe (never the event's copy), and only when the attempt is this bill's, the invoice is
 * the bill's own customer's, and the attempt has no other invoice; the id is stored here then (under the balance lock),
 * so the job's own write finds the attempt settled and changes nothing.
 */
async function claimRecharge(tx: Tx, invoice: BillingInvoice, bill: Bill) {
  if (!invoice.rechargeId || !bill.stripe_customer_id || invoice.customerId !== bill.stripe_customer_id) return null
  const [claimed] = await tx
    .update(billing_recharges)
    .set({ stripe_invoice_id: invoice.id })
    .where(
      and(
        eq(billing_recharges.id, invoice.rechargeId),
        eq(billing_recharges.billing_account_id, bill.id),
        isNull(billing_recharges.stripe_invoice_id),
      ),
    )
    .returning()
  return claimed ?? null
}

/**
 * `invoice.paid` (docs/billing.md §5.1), for recharges and plans: the recharge attempt the invoice charges is credited
 * when it is a real payment of its amount; a paid plan invoice makes the bill active with Stripe's period. Both read
 * the invoice and subscription fetched just now, never the event's copy.
 */
async function invoicePaid(
  tx: Tx,
  objectId: string,
  customerId: string | null,
  fetched: InvoiceFetch,
  now: string,
  alert: (a: Parameters<typeof rechargeNotCreditedAlert>[0]) => void,
): Promise<EventOutcome> {
  const found = await billOfInvoice(tx, objectId, customerId)
  if (!found.bill) return { outcome: 'unknown' }
  const { invoice, subscription } = fetched
  if (!invoice) return { outcome: 'not_found' }
  if (invoice.status !== 'paid') return { outcome: 'applied', bill: found.bill.id, plan: 'unchanged' }
  // Lock order (ledger.ts): the bill's balance row first, then its recharge and bill rows, read again under it.
  await lockBalance(tx, found.bill.id)
  const { recharge: stored, bill: current } = await billOfInvoice(tx, objectId, customerId)
  if (!current) return { outcome: 'unknown' }
  const linked = await linkSubscription(tx, current, invoice, subscription, now)
  const bill = linked ?? current
  // The bill's subscription is stored since prepare looked (Checkout, PR 8): retried with a fresh fetch (L2).
  if (!fetched.subscriptionFetched && invoice.subscriptionId && invoice.subscriptionId === bill.stripe_subscription_id)
    throw new Error('the bill got this subscription after the invoice was fetched; tried again')
  const recharge = stored ?? (await claimRecharge(tx, invoice, bill))
  const result: Extract<EventOutcome, { outcome: 'applied' }> = { outcome: 'applied', bill: bill.id }
  if (linked) result.linked = linked.stripe_subscription_id!
  if (recharge) {
    const checked = notCreditedReason(invoice, recharge, bill)
    if ('reason' in checked) {
      result.notCredited = { recharge: recharge.id, reason: checked.reason }
      alert({ bill: bill.id, recharge: recharge.id, invoice: invoice.id, reason: checked.reason })
    } else result.credited = await creditRecharge(tx, bill, recharge, checked.line, now)
  }
  const ownSubscription = !!invoice.subscriptionId && invoice.subscriptionId === bill.stripe_subscription_id
  if (ownSubscription && invoice.customerId === bill.stripe_customer_id)
    result.plan = await planPaid(tx, bill, subscription, now)
  if (ownSubscription || recharge)
    await mirrorInvoice(tx, bill, invoice, ownSubscription ? 'subscription' : 'recharge', now)
  return result
}

export const stripeEventPreparers: Record<string, Preparer> = {
  'billing.processStripeEvent': async (_ctx, input: { eventId: string }) => prepareEvent(input.eventId),
  'billing.settleInvoice': async (_ctx, input: { invoiceId: string; customerId?: string | null }) =>
    fetchInvoice(input.invoiceId, input.customerId ?? null),
}

/** Young enough that its bill may still be stored (Checkout writes the customer a moment later): retried (L2). */
const retryUnknown = (receivedAt: string, now: string) => Date.parse(now) - Date.parse(receivedAt) < UNKNOWN_RETRY_MS

export const stripeEventHandlers: Record<string, Handler> = {
  'billing.processStripeEvent': async ({ tx, now, prepared, onCommit }, input: { eventId: string }) => {
    await requireLedgerGuards(tx)
    const [event] = await tx.select().from(stripe_events).where(eq(stripe_events.id, input.eventId)).for('update')
    if (!event) throw new Reject('no stored Stripe event with this id')
    if (event.processed_at) return { rows: {}, data: { outcome: 'already_processed' } }
    if (event.type !== INVOICE_PAID) {
      // The failures and card changes are the job's (they ask Stripe); every other type waits, unprocessed, for the
      // release that handles it (M1).
      if (HANDLED_EVENTS.includes(event.type)) throw new Reject('this event type is processed by its job')
      await markUnhandled(tx, event.id, UNHANDLED_TYPE)
      return { rows: {}, data: { outcome: 'unhandled', marker: UNHANDLED_TYPE } satisfies EventOutcome }
    }
    const fetched = (prepared ?? { kind: 'none' }) as Prepared
    const { objectId, customerId } = eventSubject(event.payload)
    let outcome: EventOutcome
    if (!objectId) outcome = { outcome: 'unknown' }
    else if (fetched.kind === 'none') {
      // Prepare found no bill. One stored since then is fetched for again (L2); none yet: retried while young.
      if ((await billOfInvoice(tx, objectId, customerId)).bill)
        throw new Error('the bill of this invoice was stored after it was looked up; tried again')
      outcome = { outcome: retryUnknown(event.received_at, now) ? 'unknown_retry' : 'unknown' }
    } else
      outcome = await invoicePaid(tx, objectId, customerId, fetched, now, facts =>
        onCommit?.(() => alertInstanceAdmins(rechargeNotCreditedAlert(facts))),
      )
    if (outcome.outcome === 'unknown_retry')
      await tx.update(stripe_events).set({ attempts: 0, last_error: null }).where(eq(stripe_events.id, event.id))
    else
      await tx.update(stripe_events).set({ processed_at: now, last_error: null }).where(eq(stripe_events.id, event.id))
    return { rows: {}, data: outcome }
  },

  // The nightly reconciliation settles a paid recharge pending for more than a day (docs/billing.md §3.4) like
  // invoice.paid; a failed or voided one goes through rechargeFailed (billing-reconcile.ts).
  'billing.settleInvoice': async (
    { tx, now, prepared, onCommit },
    input: { invoiceId: string; customerId?: string | null },
  ) => {
    await requireLedgerGuards(tx)
    const fetched = (prepared ?? { kind: 'none' }) as Prepared
    if (fetched.kind === 'none') return { rows: {}, data: { outcome: 'unknown' } }
    const outcome = await invoicePaid(tx, input.invoiceId, input.customerId ?? null, fetched, now, facts =>
      onCommit?.(() => alertInstanceAdmins(rechargeNotCreditedAlert(facts))),
    )
    return { rows: {}, data: outcome }
  },

  'billing.reprocessEvent': async ({ tx, actor }, input: { eventId: string; reason: string }) => {
    refuseMoneyChange(actor)
    const [event] = await tx
      .update(stripe_events)
      .set({ processed_at: null, attempts: 0, last_error: null })
      .where(eq(stripe_events.id, input.eventId))
      .returning({ id: stripe_events.id, type: stripe_events.type })
    if (!event) throw new Reject('no stored Stripe event with this id')
    await queueStripeEvent(tx, event.id)
    return { rows: {}, data: { eventId: event.id, type: event.type } }
  },
}

type StoredEvent = typeof stripe_events.$inferSelect

/** Leaves an event unprocessed with its marker, at the attempt cap, so nothing retries or alerts on it (M1). */
async function markUnhandled(tx: Pick<Tx, 'update'>, eventId: string, marker: string) {
  await tx
    .update(stripe_events)
    .set({ attempts: STRIPE_EVENT_ATTEMPTS, last_error: marker })
    .where(eq(stripe_events.id, eventId))
}

/**
 * The recharge attempt a failed or voided invoice is for: the one that stored the invoice id, else the one the invoice
 * names (metadata, read from the fetched invoice) when it is this bill's, of the bill's own customer, and has no
 * invoice yet (the recharge job had not stored it).
 */
async function rechargeOfFailedInvoice(invoice: BillingInvoice, bill: Bill, stored: Recharge | null) {
  if (stored) return stored
  if (!invoice.rechargeId) return null
  const [named] = await db
    .select()
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.id, invoice.rechargeId),
        eq(billing_recharges.billing_account_id, bill.id),
        isNull(billing_recharges.stripe_invoice_id),
      ),
    )
  return named ?? null
}

/**
 * A recharge invoice that failed or was voided (docs/billing.md §3.4, security review of #865, M1): PR 4's
 * failed-recharge rules, the same as when the recharge job sees the decline itself (rechargeFailed: collection off,
 * voided unless the owner must confirm 3DS, the bill waits, the owner is emailed once). The invoice is fetched first;
 * a payment that failed and was then paid, or an attempt already settled, changes nothing. A voided invoice of an
 * attempt kept open for 3DS (`failed`) cancels it, so it no longer counts in the cap.
 */
export async function failRechargeInvoice(
  provider: BillingProvider,
  invoice: BillingInvoice,
  recharge: Recharge,
  now: string,
  /** Stripe said the payment failed (the event); the reconciliation passes false and relies on the invoice. */
  reportedFailed: boolean,
): Promise<string | null> {
  // The first recharge on the trial's conversion invoice (docs/billing.md §3.2 step 9) rides on a plan invoice: it is
  // never stopped or voided here (that would void the plan's fee). Stripe retries the invoice (dunning, PR 11); its
  // payment credits the recharge (invoice.paid), its void cancels it.
  if (invoice.subscriptionId) {
    if (invoice.status !== 'void' || (recharge.status !== 'pending' && recharge.status !== 'failed')) return null
    await db.transaction(async tx => {
      await lockBalance(tx, recharge.billing_account_id)
      await tx
        .update(billing_recharges)
        .set({ status: 'canceled', resolved_at: now })
        .where(and(eq(billing_recharges.id, recharge.id), inArray(billing_recharges.status, ['pending', 'failed'])))
    })
    return null
  }
  if (invoice.status === 'void') {
    if (recharge.status === 'failed') {
      await db.transaction(async tx => {
        await lockBalance(tx, recharge.billing_account_id)
        await tx
          .update(billing_recharges)
          .set({ status: 'canceled' })
          .where(and(eq(billing_recharges.id, recharge.id), eq(billing_recharges.status, 'failed')))
      })
      return 'invoice_voided'
    }
    if (recharge.status !== 'pending') return null
    await rechargeFailed(db, provider, recharge.id, invoice.id, 'invoice_voided', now)
    return 'invoice_voided'
  }
  const code = invoice.paymentFailureCode ?? (reportedFailed ? 'payment_failed' : null)
  if (invoice.status !== 'open' || recharge.status !== 'pending' || !code) return null
  await rechargeFailed(db, provider, recharge.id, invoice.id, code, now)
  return code
}

/** Records what a job did with its event: processed, left with its marker, or retried while its bill may yet come. */
function finishEvent(event: StoredEvent, now: string) {
  return (outcome: EventOutcome) =>
    db
      .update(stripe_events)
      .set(
        outcome.outcome === 'unhandled'
          ? { attempts: STRIPE_EVENT_ATTEMPTS, last_error: outcome.marker }
          : outcome.outcome === 'unknown_retry'
            ? { attempts: 0, last_error: null }
            : { processed_at: now, last_error: null },
      )
      .where(and(eq(stripe_events.id, event.id), isNull(stripe_events.processed_at)))
      .then(() => outcome)
}

/**
 * `payment_method.attached` and `customer.updated` (docs/billing.md §3.4): after a failed recharge no new one starts
 * until the card changes or the owner retries. The wait ends when the card the next recharge would charge
 * (`rechargeCard`, fetched now, never the event's copy) was made after the failure: a card the owner added since, made
 * the customer's default (the portal does both). The same card, or one added but not made the default, keeps the wait,
 * so a declining card is not charged again on every change of the customer's address.
 */
async function cardChangedJob(event: StoredEvent): Promise<EventOutcome> {
  const now = new Date().toISOString()
  const done = finishEvent(event, now)
  const { customerId } = eventSubject(event.payload)
  const bill = await billBy(db, 'customer', customerId)
  if (!bill) return done({ outcome: retryUnknown(event.received_at, now) ? 'unknown_retry' : 'unknown' })
  const failedAt = bill.recharge_failed_at
  if (!failedAt) return done({ outcome: 'applied', bill: bill.id })
  const provider = await billingProvider(db)
  if (provider.name === 'none') throw new Error('billing is off')
  const card = await provider.rechargeCard(bill.stripe_customer_id!, bill.stripe_subscription_id)
  if (!card?.createdAt || Date.parse(card.createdAt) <= Date.parse(failedAt))
    return done({ outcome: 'card_changed', bill: bill.id, cleared: false })
  // Under the bill's lock order, and only the failure that was read: a newer one (a decline since) stays.
  const cleared = await db.transaction(async tx => {
    await lockBalance(tx, bill.id)
    const rows = await tx
      .update(billing_accounts)
      .set({ recharge_failed_at: null, updated_at: now })
      .where(and(eq(billing_accounts.id, bill.id), eq(billing_accounts.recharge_failed_at, failedAt)))
      .returning({ id: billing_accounts.id })
    return rows.length > 0
  })
  return done({ outcome: 'card_changed', bill: bill.id, cleared })
}

/** `invoice.payment_failed` and `invoice.voided`: outside a transaction, since the failed-recharge rules ask Stripe. */
async function invoiceFailedJob(event: StoredEvent): Promise<EventOutcome> {
  const now = new Date().toISOString()
  const done = finishEvent(event, now)
  const { objectId, customerId } = eventSubject(event.payload)
  if (!objectId) return done({ outcome: 'unknown' })
  const { recharge: stored, bill } = await billOfInvoice(db, objectId, customerId)
  if (!bill) return done({ outcome: retryUnknown(event.received_at, now) ? 'unknown_retry' : 'unknown' })
  const provider = await billingProvider(db)
  if (provider.name === 'none') throw new Error('billing is off')
  const invoice = await provider.invoice(objectId)
  if (!invoice) return done({ outcome: 'not_found' })
  if (!bill.stripe_customer_id || invoice.customerId !== bill.stripe_customer_id) return done({ outcome: 'unknown' })
  const recharge = await rechargeOfFailedInvoice(invoice, bill, stored)
  // A plan invoice: dunning (a later PR) handles it, from the stored events. One carrying the first recharge too: the
  // recharge is canceled only when the invoice is voided, and dunning still gets the event.
  if (recharge && invoice.subscriptionId) await failRechargeInvoice(provider, invoice, recharge, now, false)
  if (!recharge || invoice.subscriptionId) return done({ outcome: 'unhandled', marker: UNHANDLED_PLAN })
  const code = await failRechargeInvoice(provider, invoice, recharge, now, event.type === 'invoice.payment_failed')
  return done(
    code
      ? { outcome: 'recharge_failed', bill: bill.id, recharge: recharge.id, code }
      : { outcome: 'applied', bill: bill.id },
  )
}

/**
 * The Checkout events (CHECKOUT_EVENTS). billing-checkout.ts is imported when one runs: it is a handler module, which
 * only handlers.ts imports at load.
 */
async function checkoutEventJob(event: StoredEvent): Promise<EventOutcome> {
  const now = new Date().toISOString()
  const done = finishEvent(event, now)
  const { objectId, customerId } = eventSubject(event.payload)
  if (!objectId) return done({ outcome: 'unknown' })
  const checkout = await import('./billing-checkout.ts')
  const result =
    event.type === 'customer.subscription.trial_will_end'
      ? await checkout.trialWillEnd(objectId, customerId)
      : event.type === 'invoice.created'
        ? await checkout.firstRecharge(objectId, customerId, now)
        : await checkout.checkoutCompleted(objectId, customerId, now)
  if (result.outcome === 'unknown')
    return done({ outcome: retryUnknown(event.received_at, now) ? 'unknown_retry' : 'unknown' })
  return done(result)
}

/**
 * Runs a billing action as the system actor, through the registry like every write. run-action.ts is imported when it
 * runs, not at load: it imports every handler, and jobs.ts (which imports this file) is imported by some of them.
 */
export async function runAsBillingSystem(name: string, input: unknown) {
  const { runAction } = await import('./run-action.ts')
  return runAction(name, input, billingSystemActor)
}

/**
 * The job: one attempt at one event. Skipped while billing is not in effect (the sweeper queues it again once it is).
 * A failure is recorded on the event and retried by pg-boss with backoff; the fifth failure alerts the instance admins.
 */
export async function processStripeEventJob(eventId: string) {
  if ((await billingState(db)).inEffect === 'none') return { skipped: 'billing_off' as const }
  const [event] = await db
    .update(stripe_events)
    .set({ attempts: sql`${stripe_events.attempts} + 1` })
    .where(and(eq(stripe_events.id, eventId), isNull(stripe_events.processed_at)))
    .returning()
  if (!event) return { skipped: 'processed' as const }
  try {
    if ((INVOICE_FAILURES as readonly string[]).includes(event.type)) return await invoiceFailedJob(event)
    if ((CARD_CHANGES as readonly string[]).includes(event.type)) return await cardChangedJob(event)
    if ((CHECKOUT_EVENTS as readonly string[]).includes(event.type)) return await checkoutEventJob(event)
    const result = await runAsBillingSystem('billing.processStripeEvent', { eventId })
    if (!result.body.ok) throw new Error(result.body.error)
    return result.body.data as EventOutcome
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX)
    await db.update(stripe_events).set({ last_error: message }).where(eq(stripe_events.id, eventId))
    console.error(`billing: Stripe event ${eventId} (${event.type}), attempt ${event.attempts}, failed: ${message}`)
    if (event.attempts >= STRIPE_EVENT_ATTEMPTS)
      await alertInstanceAdmins(
        stripeEventFailedAlert({ eventId, type: event.type, attempts: event.attempts, error: message }),
      ).catch(e => console.error('billing: the failed-event alert could not be sent:', e))
    throw error
  }
}

/**
 * The sweeper: events stored but not processed after 5 minutes, and not yet given up on, are queued again. First, the
 * events a release before this one did not handle, of a type this one handles, are armed again (M1).
 */
export async function sweepStripeEvents(now = new Date()) {
  if ((await billingState(db)).inEffect === 'none') return { requeued: 0 }
  await db
    .update(stripe_events)
    .set({ attempts: 0, last_error: null })
    .where(
      and(
        isNull(stripe_events.processed_at),
        eq(stripe_events.last_error, UNHANDLED_TYPE),
        inArray(stripe_events.type, [...HANDLED_EVENTS]),
      ),
    )
  const stale = await db
    .select({ id: stripe_events.id })
    .from(stripe_events)
    .where(
      and(
        isNull(stripe_events.processed_at),
        lt(stripe_events.received_at, new Date(now.getTime() - SWEEP_AFTER_MS).toISOString()),
        lt(stripe_events.attempts, STRIPE_EVENT_ATTEMPTS),
      ),
    )
    .limit(500)
  for (const { id } of stale) await db.transaction(tx => queueStripeEvent(tx, id))
  return { requeued: stale.length }
}

/**
 * Removes stored events older than the keep time (docs/billing.md §8); unprocessed ones too. Runs every night, billing
 * on or off (review of #865, L4).
 */
export async function pruneStripeEvents(tx: Tx, now = new Date()) {
  const before = new Date(now.getTime() - STRIPE_EVENT_KEEP_DAYS * 86_400_000).toISOString()
  const removed = await tx
    .delete(stripe_events)
    .where(lt(stripe_events.received_at, before))
    .returning({ id: stripe_events.id })
  return removed.length
}

/** The queues of this file (jobs.ts `startJobs`): one queued or running job per event, five attempts with backoff. */
export async function createStripeEventQueues(instance: PgBoss) {
  await instance.createQueue(STRIPE_EVENT, {
    policy: 'exclusive',
    retryLimit: STRIPE_EVENT_ATTEMPTS - 1,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
  })
  await instance.createQueue(STRIPE_EVENT_SWEEP, { retryLimit: 0, expireInSeconds: 120 })
}

/** The workers of this file (jobs.ts `runJobs`). */
export async function runStripeEventJobs(instance: PgBoss) {
  await instance.work<{ eventId: string }>(STRIPE_EVENT, async ([job]) => processStripeEventJob(job!.data.eventId))
  await instance.schedule(STRIPE_EVENT_SWEEP, STRIPE_EVENT_SWEEP_CRON)
  await instance.work(STRIPE_EVENT_SWEEP, async () => sweepStripeEvents())
}
