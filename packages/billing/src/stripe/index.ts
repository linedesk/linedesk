// The Stripe adapter: the only place that imports the Stripe SDK. Loaded with a dynamic import (../index.ts), so an
// install without Stripe never loads it.
import Stripe from 'stripe'
import { stripeKeyMode } from '../keys.ts'
import {
  type BillingEvent,
  type BillingInvoice,
  type BillingInvoiceLine,
  type BillingProvider,
  BillingSetupError,
  type BillingSubscription,
  CHECKOUT_PMC_NAME,
  type RechargeCard,
  type RechargeCharge,
  type RechargeInvoiceInput,
  type StripeKeys,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookRefused,
} from '../provider.ts'

/**
 * The Stripe API version every request and the webhook endpoint use (docs/billing.md §5.1): the version this SDK
 * release is built for (the SDK constructor accepts only that one). Changing it is its own PR, with the SDK update and a look at Stripe's upgrade notes.
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia' as const

/** No request to Stripe waits longer; billing never sits on the call path, but admin pages should not hang. */
export const STRIPE_TIMEOUT_MS = 8000

/** Stripe lists at most 20 event types per request. */
const EVENT_TYPES_PER_REQUEST = 20

const iso = (seconds: number | null | undefined) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null
const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null)

/** The bootstrap's card-only payment method configuration (found by name; a connected account's copy has a parent). */
export const isCheckoutPaymentMethodConfiguration = (config: Stripe.PaymentMethodConfiguration) =>
  config.name === CHECKOUT_PMC_NAME && !config.parent

/** A fetch of an object Stripe does not have (deleted, another account): null, not an error. */
function missing(error: unknown) {
  return error instanceof Stripe.errors.StripeError && error.statusCode === 404
}

/** The fields of an event billing reads before it fetches anything: which object, which customer. */
export function eventOf(event: Stripe.Event): BillingEvent {
  const object = event.data.object as { id?: unknown; object?: unknown; customer?: unknown }
  const customer =
    object.object === 'customer' ? object.id : (object.customer as string | { id: string } | null | undefined)
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created,
    objectId: typeof object.id === 'string' ? object.id : null,
    objectType: typeof object.object === 'string' ? object.object : null,
    customerId: typeof customer === 'string' ? customer : idOf(customer as { id: string } | null),
  }
}

function lineOf(line: Stripe.InvoiceLineItem): BillingInvoiceLine {
  const parent = line.parent?.type
  return {
    id: line.id,
    amountCents: line.amount,
    currency: line.currency,
    kind:
      parent === 'invoice_item_details'
        ? 'invoice_item'
        : parent === 'subscription_item_details'
          ? 'subscription'
          : 'other',
    rechargeId: line.metadata?.billing_recharge_id ?? null,
    // Counts a discount twice (it is in both lists): only ever compared with 0 (provider.ts BillingInvoiceLine).
    discountCents:
      (line.discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0) +
      (line.pretax_credit_amounts ?? []).reduce((sum, c) => sum + c.amount, 0),
  }
}

/** `doFetch` is replaced in tests (recorded responses); in the app it is the global fetch. */
export function createStripeBillingProvider(keys: StripeKeys, doFetch: typeof fetch = fetch): BillingProvider {
  const mode = stripeKeyMode(keys.secretKey)
  if (!mode) throw new Error('not a Stripe secret or restricted key')
  const stripe = new Stripe(keys.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(doFetch),
    timeout: STRIPE_TIMEOUT_MS,
    // Retries come from our own jobs (with idempotency keys); a test or an admin page answers at once.
    maxNetworkRetries: 0,
    telemetry: false,
    appInfo: { name: 'Linedesk', url: 'https://github.com/linedesk/linedesk' },
  })
  const secrets = [keys.webhookSecret, keys.webhookSecretPrevious].filter((s): s is string => !!s)

  return {
    name: 'stripe',
    async account() {
      // GET /v1/account: the account of the key, readable with a restricted key too.
      const account = await stripe.accounts.retrieveCurrent()
      return {
        id: account.id,
        mode,
        country: account.country ?? null,
        defaultCurrency: account.default_currency ?? null,
      }
    },
    // Any step refused for our setup (the invoice, its item, a retrieve) is the admins' problem, not a card failure.
    chargeRecharge: input =>
      chargeRecharge(stripe, input).catch(error => {
        throw setupError(error) ?? error
      }),
    rechargeCard: (customerId, subscriptionId) => rechargeCard(stripe, customerId, subscriptionId),
    async checkoutPaymentMethodConfiguration() {
      const all = await stripe.paymentMethodConfigurations.list({ limit: 100 })
      return all.data.find(c => isCheckoutPaymentMethodConfiguration(c) && c.active)?.id ?? null
    },
    async findRechargeInvoice(rechargeId) {
      // The recharge id is ours (letters, digits and _), so it is safe inside the search query.
      if (!/^[a-z0-9_]+$/i.test(rechargeId)) throw new Error('not a recharge id')
      const found = await stripe.invoices.search({
        query: `metadata['${RECHARGE_METADATA}']:'${rechargeId}'`,
        limit: 1,
      })
      return found.data[0]?.id ?? null
    },
    async stopRechargeInvoice(invoiceId, options) {
      const invoice = await stripe.invoices.retrieve(invoiceId)
      // A draft (finalizing was refused) would be finalized and charged on its own an hour later: deleted, or kept
      // as a draft with automatic collection off.
      if (invoice.status === 'draft') {
        if (options.void) await stripe.invoices.del(invoiceId)
        else if (invoice.auto_advance !== false) await stripe.invoices.update(invoiceId, { auto_advance: false })
        return
      }
      if (invoice.status === 'open' && invoice.auto_advance !== false)
        await stripe.invoices.update(invoiceId, { auto_advance: false })
      if (options.void && invoice.status === 'open') await stripe.invoices.voidInvoice(invoiceId)
    },
    async rechargeInvoicePage(invoiceId) {
      return (await stripe.invoices.retrieve(invoiceId)).hosted_invoice_url ?? null
    },

    webhookEvent(rawBody, signature) {
      let event: Stripe.Event | null = null
      for (const secret of secrets) {
        try {
          event = stripe.webhooks.constructEvent(Buffer.from(rawBody), signature, secret, WEBHOOK_TOLERANCE_SECONDS)
          break
        } catch {
          // The next secret, or refused below: Stripe's message is never passed on (it could hold the header).
        }
      }
      if (!event) throw new WebhookRefused('signature')
      if (event.livemode !== (mode === 'live')) throw new WebhookRefused('livemode')
      // The endpoint is pinned to the adapter's version (the bootstrap script creates it so); an event in another
      // version means the endpoint is not, and its payload may not have the shape this code reads.
      if (event.api_version !== STRIPE_API_VERSION) throw new WebhookRefused('api_version', event.api_version ?? null)
      return eventOf(event)
    },

    async invoice(id) {
      let invoice: Stripe.Invoice
      try {
        invoice = await stripe.invoices.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      const lines = invoice.lines.has_more
        ? await stripe.invoices.listLineItems(id, { limit: 100 }).autoPagingToArray({ limit: 1000 })
        : invoice.lines.data
      // Every payment of the invoice, with its payment intent: the paid ones are the money that came in, the latest
      // one says why a payment failed.
      const payments = await stripe.invoicePayments
        .list({ invoice: id, limit: 100, expand: ['data.payment.payment_intent'] })
        .autoPagingToArray({ limit: 1000 })
      const charged = payments
        .filter(p => p.status === 'paid' && (p.payment.type === 'payment_intent' || p.payment.type === 'charge'))
        .reduce((sum, p) => sum + (p.amount_paid ?? 0), 0)
      const latest = [...payments].sort((a, b) => b.created - a.created)[0]
      const intent = latest?.payment.payment_intent
      const failure = typeof intent === 'object' && intent ? paymentFailure(intent) : null
      const subscription = invoice.parent?.subscription_details?.subscription
      const answer: BillingInvoice = {
        id: invoice.id,
        livemode: invoice.livemode,
        customerId: idOf(invoice.customer),
        subscriptionId: idOf(subscription ?? null),
        status: invoice.status,
        billingReason: invoice.billing_reason,
        currency: invoice.currency,
        totalCents: invoice.total,
        taxCents: (invoice.total_taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0),
        amountPaidCents: invoice.amount_paid,
        amountPaidOffStripeCents: invoice.amount_paid_off_stripe ?? 0,
        chargedCents: charged,
        startingBalanceCents: invoice.starting_balance ?? 0,
        paymentFailureCode: failure,
        rechargeId: invoice.metadata?.billing_recharge_id ?? null,
        lines: lines.map(lineOf),
        number: invoice.number,
        periodStart: iso(invoice.period_start),
        periodEnd: iso(invoice.period_end),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        pdfUrl: invoice.invoice_pdf ?? null,
      }
      return answer
    },

    async subscription(id) {
      let sub: Stripe.Subscription
      try {
        sub = await stripe.subscriptions.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      const first = sub.items.data[0]
      const answer: BillingSubscription = {
        id: sub.id,
        customerId: idOf(sub.customer)!,
        status: sub.status,
        currentPeriodStart: iso(first?.current_period_start),
        currentPeriodEnd: iso(first?.current_period_end),
        interval: first?.price.recurring?.interval === 'year' ? 'year' : first ? 'month' : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        trialEnd: iso(sub.trial_end),
        defaultPaymentMethod: idOf(sub.default_payment_method),
        // A price the bootstrap replaced (a new amount) lost its lookup key; its `metadata.linedesk` keeps it.
        items: sub.items.data.map(item => ({
          lookupKey: item.price.lookup_key ?? item.price.metadata?.linedesk ?? null,
          quantity: item.quantity ?? 0,
        })),
      }
      return answer
    },

    // Listed events come in the version they were created in (the account's default), not the endpoint's. The
    // reconciliation stores them anyway: processing reads only the id, type, object id and customer, which every
    // version has, and fetches the objects themselves at the pinned version.
    async recentEvents(sinceSeconds, types, limit = MAX_EVENTS) {
      const found = new Map<string, BillingEvent>()
      let truncated = false
      for (let i = 0; i < types.length; i += EVENT_TYPES_PER_REQUEST) {
        // One more than the limit, to know whether there were more (the newest come first).
        const events = await stripe.events
          .list({ created: { gte: sinceSeconds }, types: types.slice(i, i + EVENT_TYPES_PER_REQUEST), limit: 100 })
          .autoPagingToArray({ limit: limit + 1 })
        if (events.length > limit) truncated = true
        for (const event of events.slice(0, limit)) found.set(event.id, eventOf(event))
      }
      const events = [...found.values()].sort((a, b) => a.created - b.created)
      return { events: events.slice(-limit), truncated: truncated || events.length > limit }
    },
  }
}

/** Events read per type group: one more must fit Stripe's 10,000-item cap on `autoPagingToArray`. */
const MAX_EVENTS = 9_999

/** The invoice metadata that names the recharge attempt (docs/billing.md §3.4: found again after 24 hours). */
export const RECHARGE_METADATA = 'billing_recharge_id'

/**
 * Stripe refused the request for good: a 400 (the invoice cannot be charged as it is: no tax location, no payment
 * method), so the recharge fails instead of staying pending (security review of #864, L3). A card error (402), a
 * conflict (409, a request with the same key still running) and a rate limit (429) are retried; 401, 403 and 404 are
 * our own setup (`BillingSetupError`, see `setupError`), never the customer's card (recheck of #864, L2).
 */
function refusedForGood(error: unknown): string | null {
  const e = error as { statusCode?: number; code?: string }
  return e.statusCode === 400 ? `stripe_${e.code ?? e.statusCode}` : null
}

/** A refusal caused by our keys or account (revoked key, missing permission, an object gone): for the admins. */
function setupError(error: unknown): BillingSetupError | null {
  const e = error as { statusCode?: number; code?: string }
  if (e.statusCode !== 401 && e.statusCode !== 403 && e.statusCode !== 404) return null
  return new BillingSetupError(`stripe_${e.code ?? e.statusCode}`)
}

/** Card errors that need the customer to confirm the payment (3DS) on the invoice's page. */
const NEEDS_CUSTOMER = new Set(['authentication_required', 'invoice_payment_intent_requires_action'])

/** Why a payment intent's last attempt failed, in the recharge's failure codes (`authentication_required` first). */
function paymentFailure(intent: Stripe.PaymentIntent): string | null {
  const error = intent.last_payment_error
  if (intent.status === 'requires_action' || (error?.code && NEEDS_CUSTOMER.has(error.code)))
    return 'authentication_required'
  if (!error) return null
  // `||`, not `??`: Stripe sends an empty `decline_code` with some errors (a 402 `missing` card has `decline_code: ""`).
  return error.decline_code || error.code || 'payment_failed'
}

/**
 * The card a recharge invoice is charged to (provider.ts `RechargeCard`). Stripe charges a standalone invoice to the
 * customer's `invoice_settings.default_payment_method` (or a legacy default source); Checkout in `subscription` mode
 * leaves that empty and stores the card as the subscription's `default_payment_method`, so that one is the fallback.
 * A customer or subscription Stripe no longer has counts as no card.
 */
async function rechargeCard(
  stripe: Stripe,
  customerId: string,
  subscriptionId: string | null,
): Promise<RechargeCard | null> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer
  try {
    customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] })
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  if (customer.deleted) return null
  const own = customer.invoice_settings?.default_payment_method
  if (own) return { id: idOf(own)!, createdAt: typeof own === 'string' ? null : iso(own.created), on: 'customer' }
  // A legacy source is charged too; it has no creation time we read.
  if (customer.default_source) return { id: idOf(customer.default_source)!, createdAt: null, on: 'customer' }
  if (!subscriptionId) return null
  let sub: Stripe.Subscription
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] })
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  const card = sub.default_payment_method
  if (!card || idOf(sub.customer) !== customerId) return null
  return { id: idOf(card)!, createdAt: typeof card === 'string' ? null : iso(card.created), on: 'subscription' }
}

/**
 * A recharge (docs/billing.md §2.2): one invoice per attempt, `charge_automatically` with automatic tax, holding only
 * its own item (`pending_invoice_items_behavior=exclude`), then finalized and paid with the saved card. Every request
 * carries an idempotency key made from the attempt id, so a retried job never makes a second invoice or charge.
 */
async function chargeRecharge(stripe: Stripe, input: RechargeInvoiceInput): Promise<RechargeCharge> {
  const key = (step: string) => ({ idempotencyKey: `${input.rechargeId}:${step}` })
  const metadata = { [RECHARGE_METADATA]: input.rechargeId }
  let invoice = input.invoiceId
    ? await stripe.invoices.retrieve(input.invoiceId)
    : await stripe.invoices.create(
        {
          customer: input.customerId,
          collection_method: 'charge_automatically',
          auto_advance: true,
          automatic_tax: { enabled: true },
          pending_invoice_items_behavior: 'exclude',
          currency: 'usd',
          description: input.description,
          metadata,
        },
        key('invoice'),
      )
  if (invoice.metadata?.[RECHARGE_METADATA] !== input.rechargeId)
    throw new Error(`invoice ${invoice.id} is not the one of recharge ${input.rechargeId}`)
  if (invoice.status === 'draft') {
    if (!invoice.total)
      await stripe.invoiceItems.create(
        {
          customer: input.customerId,
          invoice: invoice.id,
          amount: input.amountCents,
          currency: 'usd',
          description: input.description,
          tax_behavior: 'exclusive',
          metadata,
        },
        key('item'),
      )
    try {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id!, { auto_advance: true }, key('finalize'))
    } catch (error) {
      const failureCode = refusedForGood(error)
      if (!failureCode) throw setupError(error) ?? error
      return { status: 'failed', invoiceId: invoice.id!, failureCode }
    }
  }
  const id = invoice.id!
  if (invoice.status === 'paid') return { status: 'paid', invoiceId: id }
  if (invoice.status !== 'open') return { status: 'failed', invoiceId: id, failureCode: `invoice_${invoice.status}` }
  // The invoice is charged to the customer's invoice default. Checkout saves the card only on the subscription, so the
  // first recharge after it would find none (billing review of 16.11., B1): that card becomes the customer's default.
  const card = await rechargeCard(stripe, input.customerId, input.subscriptionId ?? null)
  if (card?.on === 'subscription')
    await stripe.customers.update(input.customerId, { invoice_settings: { default_payment_method: card.id } })
  try {
    invoice = await stripe.invoices.pay(id, {}, key('pay'))
  } catch (error) {
    const e = error as { statusCode?: number; code?: string; decline_code?: string }
    // 3DS first, whatever the status: the invoice stays open for the owner to confirm (recheck of #864, L1).
    if (e.code && NEEDS_CUSTOMER.has(e.code))
      return { status: 'failed', invoiceId: id, failureCode: 'authentication_required' }
    const refused = refusedForGood(error)
    if (refused) return { status: 'failed', invoiceId: id, failureCode: refused }
    const setup = setupError(error)
    if (setup) throw setup
    // 402: the card was refused; anything else is not an answer about the charge: retried.
    if (e.statusCode !== 402 || !e.code) throw error
    // `||`, not `??`: a 402 `missing` (no card) comes with `decline_code: ""`, which must not become the code.
    return { status: 'failed', invoiceId: id, failureCode: e.decline_code || e.code }
  }
  return { status: invoice.status === 'paid' ? 'paid' : 'open', invoiceId: id }
}
