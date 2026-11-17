// The Stripe adapter: the only place that imports the Stripe SDK. Loaded with a dynamic import (../index.ts), so an
// install without Stripe never loads it.
import { EXTRA_CALLS_LOOKUP_PREFIX } from '@linedesk/db/types'
import Stripe from 'stripe'
import { stripeKeyMode } from '../keys.ts'
import { catalogWriteAccess, ensureCatalog, ensureProduct, productId } from './catalog.ts'
import { findPortalConfiguration, portalAllowsPlanChanges, portalFits, portalParams } from './portal.ts'
import {
  type BillingChargeSource,
  type BillingEvent,
  type BillingInvoice,
  type BillingInvoiceLine,
  type BillingProvider,
  BillingSetupError,
  type BillingSubscription,
  CHECKOUT_PMC_NAME,
  type CheckoutCard,
  type CheckoutInput,
  type CheckoutSession,
  type CustomerPurchases,
  type RechargeCard,
  type RechargeCharge,
  type RechargeInvoiceInput,
  type RefundBlocker,
  type StripeKeys,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookRefused,
} from '../provider.ts'

import { STRIPE_API_VERSION } from '../version.ts'

export { STRIPE_API_VERSION } from '../version.ts'

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

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
const metadataOf = (value: unknown) =>
  value && typeof value === 'object' ? (value as { metadata?: Record<string, unknown> }).metadata : undefined

/**
 * The fields of an event billing reads before it fetches anything: which object, which customer, and our own ids the
 * object carries (only as a hint that the event may be this install's; stripe-events.ts). Read defensively, so an
 * event in any API version gives what it has: the object itself is fetched again at the adapter's version.
 */
export function eventOf(event: Stripe.Event): BillingEvent {
  const object = (event.data?.object ?? {}) as {
    id?: unknown
    object?: unknown
    customer?: unknown
    client_reference_id?: unknown
    metadata?: Record<string, unknown>
    parent?: { subscription_details?: { metadata?: Record<string, unknown> } }
    subscription_details?: { metadata?: Record<string, unknown> }
  }
  const customer =
    object.object === 'customer' ? object.id : (object.customer as string | { id: string } | null | undefined)
  // A subscription's invoice carries the subscription's metadata (where the bill id is) under `parent` since
  // 2025-03-31.basil, under `subscription_details` before.
  const subscriptionMetadata =
    metadataOf(object.parent?.subscription_details) ?? metadataOf(object.subscription_details)
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created,
    objectId: typeof object.id === 'string' ? object.id : null,
    objectType: typeof object.object === 'string' ? object.object : null,
    customerId: typeof customer === 'string' ? customer : idOf((customer ?? null) as { id: string } | string | null),
    billHint:
      text(object.metadata?.[BILL_METADATA]) ??
      text(subscriptionMetadata?.[BILL_METADATA]) ??
      (object.object === 'checkout.session' ? text(object.client_reference_id) : null),
    rechargeHint: text(object.metadata?.[RECHARGE_METADATA]),
    apiVersion: text((event as { api_version?: unknown }).api_version),
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
      try {
        return (await findCheckoutConfiguration(stripe, c => c.active))?.id ?? null
      } catch (error) {
        // A restricted key without the permission (403), a revoked key: our setup, for the admins (review of #876, I2).
        throw setupError(error) ?? error
      }
    },
    async createCustomer({ billId, email, name }) {
      try {
        const customer = await stripe.customers.create(
          { email, name, metadata: { [BILL_METADATA]: billId } },
          { idempotencyKey: `${billId}:customer` },
        )
        return customer.id
      } catch (error) {
        throw setupError(error) ?? error
      }
    },
    startCheckout: input =>
      startCheckout(stripe, input).catch(error => {
        // A 400 here is our setup too (a price, the tax settings, the terms URL): never the owner's card.
        throw setupError(error) ?? refusedSetup(error) ?? error
      }),
    syncCatalog: catalog =>
      ensureCatalog(stripe, catalog).then(
        prices => Object.fromEntries(prices),
        error => {
          if (error instanceof BillingSetupError) throw error
          throw setupError(error) ?? refusedSetup(error) ?? error
        },
      ),
    catalogWriteAccess: () => catalogWriteAccess(stripe),
    async portalWriteAccess() {
      // An empty update of a configuration that does not exist: 403 without the permission, 404 with it.
      try {
        await stripe.billingPortal.configurations.update(PORTAL_PROBE_ID, {})
        return true
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 403 || status === 401) return false
        if (status === 404) return true
        return null
      }
    },
    async checkoutTermsReady(successUrl) {
      // Stripe checks the terms URL when a session asks for the terms checkbox. A setup-mode session saves nothing
      // until someone completes it, and it is expired at once, so nobody can.
      let id: string
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'setup',
          currency: 'usd',
          success_url: successUrl,
          consent_collection: { terms_of_service: 'required' },
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
          metadata: { linedesk_check: 'terms_url' },
        })
        id = session.id
      } catch (error) {
        return termsUrlRefused(error) ? false : null
      }
      if (id)
        await stripe.checkout.sessions.expire(id).catch(error => {
          // Harmless (it ends by itself within 30 minutes, and its link was never handed out), but worth seeing.
          console.warn(`billing: the terms check session ${id} could not be expired: ${(error as Error).message}`)
        })
      return true
    },
    async taxSetup() {
      // Reads only (GET /v1/tax/settings, GET /v1/tax/registrations): the head office and registrations are set by a
      // person in the Dashboard (docs/runbook.md, "Stripe account setup"), never by the app.
      try {
        const settings = await stripe.tax.settings.retrieve()
        let registrations = 0
        for await (const _ of stripe.tax.registrations.list({ status: 'active', limit: 100 })) registrations++
        return {
          status: settings.status,
          missingFields: settings.status_details?.pending?.missing_fields ?? [],
          registrations,
        }
      } catch {
        // A restricted key without the Tax permission, a network failure: not known, never a reason to fail the test.
        return null
      }
    },
    async customerTaxReady(customerId) {
      const customer = await stripe.customers.retrieve(customerId, { expand: ['tax'] })
      if ('deleted' in customer && customer.deleted) return false
      return !untaxable(customer as Stripe.Customer)
    },
    async customersWithoutTaxAddress(customerIds) {
      // Only these customers, each asked for by id (a few at a time), never a list of the whole account: one Stripe
      // account may serve other installs and integrations (security review of #1105, N-1). One that is gone counts as
      // nothing.
      const ids = [...new Set(customerIds)]
      let count = 0
      let next = 0
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++]!
          let customer: Stripe.Customer | Stripe.DeletedCustomer
          try {
            customer = await stripe.customers.retrieve(id, { expand: ['tax'] })
          } catch (error) {
            if (missing(error)) continue
            throw error
          }
          if (!('deleted' in customer && customer.deleted) && untaxable(customer as Stripe.Customer)) count++
        }
      }
      await Promise.all(Array.from({ length: Math.min(TAX_ADDRESS_READS, ids.length) }, worker))
      return count
    },
    async syncSubscriptionTax(subscriptionId, enabled) {
      let sub: Stripe.Subscription
      try {
        sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['customer.tax'] })
      } catch (error) {
        if (missing(error)) return 'gone'
        throw error
      }
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'gone'
      if ((sub.automatic_tax?.enabled ?? false) === enabled) return 'unchanged'
      // Turning tax on for a customer without an address would make its next invoice fail to finalize: it stays off
      // until the customer adds one, and a later run (the nightly reconciliation) sets it.
      const customer = sub.customer
      if (
        enabled &&
        typeof customer !== 'string' &&
        !('deleted' in customer && customer.deleted) &&
        untaxable(customer)
      )
        return 'no_address'
      // Only the tax flag: no proration, nothing charged now; the next invoice is computed with or without tax.
      await stripe.subscriptions.update(subscriptionId, { automatic_tax: { enabled }, proration_behavior: 'none' })
      return 'updated'
    },
    async syncPortal(design) {
      const wanted = { headline: design.headline, termsUrl: design.termsUrl, privacyUrl: design.privacyUrl }
      try {
        const found = await findPortalConfiguration(stripe)
        if (!found) {
          // A new configuration needs the links Stripe shows in the portal; without them it is the bootstrap's job.
          if (!design.termsUrl || !design.privacyUrl) throw new BillingSetupError('portal_configuration_missing')
          const made = await stripe.billingPortal.configurations.create(portalParams(wanted))
          return { configuration: made.id, changed: true }
        }
        // One configuration serves every install on a Stripe account (a shared sandbox): the app only fills in a
        // headline or link that is not set, never writes over one (another install's name and legal links stay; the
        // bootstrap, run by a person, changes them). The features are always the design (review of #1102, L-3).
        const profile = found.business_profile
        const fill = {
          headline: profile.headline ? undefined : wanted.headline,
          termsUrl: profile.terms_of_service_url ? undefined : wanted.termsUrl,
          privacyUrl: profile.privacy_policy_url ? undefined : wanted.privacyUrl,
        }
        if (portalFits(found, fill)) return { configuration: found.id, changed: false }
        await stripe.billingPortal.configurations.update(found.id, portalParams(fill))
        return { configuration: found.id, changed: true }
      } catch (error) {
        if (error instanceof BillingSetupError) throw error
        throw setupError(error) ?? refusedSetup(error) ?? error
      }
    },
    checkoutSession: id => checkoutSession(stripe, id),
    async expireOpenCheckouts(customerId) {
      let expired = 0
      for await (const session of stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 })) {
        try {
          await stripe.checkout.sessions.expire(session.id)
          expired++
        } catch (error) {
          // Completed (or expired) between the list and now: nothing to expire; the confirmation handles a completed one.
          const e = error as { statusCode?: number }
          if (e.statusCode !== 400 && !missing(error)) throw setupError(error) ?? error
        }
      }
      return expired
    },
    async customerPurchases(customerId) {
      const found: CustomerPurchases = { subscriptionId: null, checkoutSessionId: null }
      try {
        // Every status, filtered here, so what counts as running is decided in one place.
        for await (const sub of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
          if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
            found.subscriptionId = sub.id
            break
          }
        }
        for await (const session of stripe.checkout.sessions.list({
          customer: customerId,
          status: 'complete',
          limit: 100,
        })) {
          // A subscription Checkout counts through its subscription above: once that is canceled (a refused trial),
          // nothing is left to keep. A payment (a top-up) or a saved card is kept whatever happened since.
          if (session.mode === 'subscription') continue
          found.checkoutSessionId = session.id
          break
        }
      } catch (error) {
        // No answer, not "nothing": even a 404 (a key of another account) may hide a running subscription.
        throw setupError(error) ?? error
      }
      return found
    },
    async deleteCustomer(customerId) {
      try {
        await stripe.customers.del(customerId)
      } catch (error) {
        if (missing(error)) return
        throw setupError(error) ?? error
      }
    },
    async cancelSubscription(id, { now }) {
      let sub: Stripe.Subscription
      try {
        sub = await stripe.subscriptions.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return subscriptionOf(sub)
      if (now) return subscriptionOf(await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }))
      if (sub.cancel_at_period_end) return subscriptionOf(sub)
      return subscriptionOf(await stripe.subscriptions.update(id, { cancel_at_period_end: true }))
    },
    async resumeSubscription(id) {
      let sub: Stripe.Subscription
      try {
        sub = await stripe.subscriptions.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      if (!sub.cancel_at_period_end || sub.status === 'canceled') return subscriptionOf(sub)
      return subscriptionOf(await stripe.subscriptions.update(id, { cancel_at_period_end: false }))
    },
    async addInvoiceItem(input) {
      const item = await stripe.invoiceItems.create(
        {
          customer: input.customerId,
          invoice: input.invoiceId,
          amount: input.amountCents,
          currency: 'usd',
          tax_behavior: 'exclusive',
          tax_code: input.taxCode,
          metadata: { [RECHARGE_METADATA]: input.rechargeId },
        },
        { idempotencyKey: `${input.rechargeId}:item` },
      )
      await describeItem(stripe, item, input.description)
    },
    async findRechargeInvoice(rechargeId) {
      return (await searchRechargeInvoice(stripe, rechargeId))?.id ?? null
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
      // An uncollectible invoice stays payable by the customer: voided too, or a hand credit and a later payment
      // would charge twice for one credit (security re-review of #919, R4).
      if (options.void && (invoice.status === 'open' || invoice.status === 'uncollectible'))
        await stripe.invoices.voidInvoice(invoiceId)
    },
    async rechargeInvoicePage(invoiceId) {
      return (await stripe.invoices.retrieve(invoiceId)).hosted_invoice_url ?? null
    },
    async portalSession({ customerId, returnUrl }) {
      try {
        const configuration = await findPortalConfiguration(stripe)
        if (!configuration) throw new BillingSetupError('portal_configuration_missing')
        // Cancel and plan changes stay in the app (§2.4): switched on in the Dashboard, they are switched off again
        // before the owner sees the portal; a key that may not do that opens no portal at all.
        if (portalAllowsPlanChanges(configuration))
          await stripe.billingPortal.configurations
            .update(configuration.id, {
              features: { subscription_cancel: { enabled: false }, subscription_update: { enabled: false } },
            })
            .catch(error => {
              console.error(
                `billing: the portal offers cancel and could not be fixed (${setupError(error)?.code ?? 'error'})`,
              )
              throw new BillingSetupError('portal_allows_cancel')
            })
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          configuration: configuration.id,
          return_url: returnUrl,
        })
        return session.url
      } catch (error) {
        if (error instanceof BillingSetupError) throw error
        throw setupError(error) ?? refusedSetup(error) ?? error
      }
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
      // Any API version is taken (docs/billing.md §5.1): the bootstrap pins the endpoint to STRIPE_API_VERSION, but
      // `stripe listen`, an endpoint made by hand and the reconciliation's list come in the account's default version.
      // eventOf reads only the event's id, type, object id, customer and our own metadata, which every version has,
      // and processing fetches each object again through this adapter, at the pinned version.
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
      try {
        return subscriptionOf(await stripe.subscriptions.retrieve(id))
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
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

    // Money leaves only through these, each with the caller's idempotency key; refused for our setup → BillingSetupError.
    refundBlockers: invoiceId =>
      refundBlockers(stripe, invoiceId).catch(error => {
        throw setupError(error) ?? error
      }),

    async refundInvoice(input) {
      try {
        const lines = [
          { type: 'invoice_line_item' as const, invoice_line_item: input.lineId, amount: input.amountCents },
        ]
        // The preview says what the line comes to with its tax, so the card gets back what it paid for that part.
        const preview = await stripe.creditNotes.preview({ invoice: input.invoiceId, lines })
        const note = await stripe.creditNotes.create(
          {
            invoice: input.invoiceId,
            lines,
            refund_amount: preview.total,
            memo: input.memo.slice(0, 500),
            metadata: { linedesk_refund: input.idempotencyKey },
          },
          { idempotencyKey: `${input.idempotencyKey}:credit_note` },
        )
        const refund = note.refunds?.[0]?.refund
        return { creditNoteId: note.id, refundId: idOf(refund ?? null), refundedCents: note.total }
      } catch (error) {
        throw setupError(error) ?? error
      }
    },

    async findRefund(invoiceId, idempotencyKey) {
      try {
        const notes = await stripe.creditNotes
          .list({ invoice: invoiceId, limit: 100 })
          .autoPagingToArray({ limit: 1000 })
        const note = notes.find(n => n.metadata?.linedesk_refund === idempotencyKey)
        if (!note) return null
        return { creditNoteId: note.id, refundId: idOf(note.refunds?.[0]?.refund ?? null), refundedCents: note.total }
      } catch (error) {
        throw setupError(error) ?? error
      }
    },

    async checkoutInvoice(sessionId) {
      try {
        return idOf((await stripe.checkout.sessions.retrieve(sessionId)).invoice ?? null)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },

    async setSeatQuantity(input) {
      try {
        const sub = await stripe.subscriptions.retrieve(input.subscriptionId)
        const seat = sub.items.data.find(item =>
          (item.price.lookup_key ?? item.price.metadata?.linedesk ?? '').startsWith(SEAT_LOOKUP_PREFIX),
        )
        // No seat item: added only with a seat price and seats to add (a partner bill's first client workspace).
        if (!seat && (!input.seatPrice || input.quantity === 0)) return 'no_seat_item'
        if (seat?.quantity === input.quantity) return 'unchanged'
        await stripe.subscriptions.update(
          input.subscriptionId,
          {
            items: [
              seat ? { id: seat.id, quantity: input.quantity } : { price: input.seatPrice, quantity: input.quantity },
            ],
            proration_behavior: input.prorationBehavior,
          },
          { idempotencyKey: input.idempotencyKey },
        )
        return 'updated'
      } catch (error) {
        throw setupError(error) ?? error
      }
    },

    async setExtraCallsQuantity(input) {
      try {
        const sub = await stripe.subscriptions.retrieve(input.subscriptionId)
        const item = sub.items.data.find(i =>
          (i.price.lookup_key ?? i.price.metadata?.linedesk ?? '').startsWith(EXTRA_CALLS_LOOKUP_PREFIX),
        )
        const current = item?.quantity ?? 0
        if (current === input.quantity) return 'unchanged'
        // The item stays at 0 instead of being removed: Stripe prorates a later raise of a kept item against what it
        // charged before, while a new item after a free re-add would be charged in full (checked in the sandbox).
        const items = (itemId: string | undefined, quantity: number): Stripe.SubscriptionUpdateParams.Item[] =>
          !itemId ? [{ price: input.priceId, quantity }] : [{ id: itemId, quantity }]
        const update = (quantity: number, itemId: string | undefined, charged: boolean, step: string) =>
          stripe.subscriptions.update(
            input.subscriptionId,
            charged
              ? {
                  items: items(itemId, quantity),
                  proration_behavior: 'always_invoice',
                  payment_behavior: 'error_if_incomplete',
                }
              : { items: items(itemId, quantity), proration_behavior: 'none' },
            { idempotencyKey: `${input.idempotencyKey}:${step}` },
          )
        const itemOf = (s: Stripe.Subscription) =>
          s.items.data.find(i =>
            (i.price.lookup_key ?? i.price.metadata?.linedesk ?? '').startsWith(EXTRA_CALLS_LOOKUP_PREFIX),
          )?.id
        // Fewer, or never charged: no refund, no charge.
        if (input.quantity < current || !input.charge) {
          await update(input.quantity, item?.id, false, 'set')
          return 'updated'
        }
        // More: free up to what this period already paid for, then the rest charged now.
        const free = Math.min(input.quantity, Math.max(current, input.paidUpTo))
        let itemId = item?.id
        if (free > current) itemId = itemOf(await update(free, itemId, false, 'free'))
        if (input.quantity === free) return 'updated'
        try {
          await update(input.quantity, itemId, true, 'paid')
        } catch (error) {
          const e = error as { statusCode?: number }
          if (e.statusCode !== 402) throw error
          // The card was refused: back to what was there, so nothing unpaid stays on the subscription.
          if (free > current) await update(current, itemId, false, 'undo')
          return 'payment_failed'
        }
        return 'updated'
      } catch (error) {
        throw setupError(error) ?? error
      }
    },

    async dispute(id) {
      let dispute: Stripe.Dispute
      try {
        dispute = await stripe.disputes.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      const chargeId = idOf(dispute.charge)!
      return {
        id: dispute.id,
        status: dispute.status,
        amountCents: dispute.amount,
        currency: dispute.currency,
        ...(await chargeSource(stripe, chargeId)),
      }
    },

    async earlyFraudWarning(id) {
      let warning: Stripe.Radar.EarlyFraudWarning
      try {
        warning = await stripe.radar.earlyFraudWarnings.retrieve(id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      return { id: warning.id, ...(await chargeSource(stripe, idOf(warning.charge)!)) }
    },

    async charge(id) {
      try {
        return await chargeSource(stripe, id)
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
  }
}

/** The seat prices' lookup keys (`ws_monthly`, `ws_yearly`): docs/billing.md §2.1. */
const SEAT_LOOKUP_PREFIX = 'ws_'

/** Dispute statuses after which a refund pays nothing out twice: the business won, or a warning closed. */
const SETTLED_DISPUTES = new Set(['won', 'warning_closed'])

/**
 * What stops refunding a paid invoice's payment (docs/billing.md §4.5, M4): for each card payment of it, an open or
 * lost dispute, or an early fraud warning on its charge. No card payment at all: `no_charge`.
 */
async function refundBlockers(stripe: Stripe, invoiceId: string): Promise<RefundBlocker[]> {
  const payments = await stripe.invoicePayments
    .list({ invoice: invoiceId, limit: 100, expand: ['data.payment.payment_intent'] })
    .autoPagingToArray({ limit: 1000 })
  const charges = payments
    .filter(p => p.status === 'paid')
    .map(p => {
      if (p.payment.type === 'charge') return idOf(p.payment.charge ?? null)
      const intent = p.payment.payment_intent
      return typeof intent === 'object' && intent ? idOf(intent.latest_charge ?? null) : null
    })
    .filter((id): id is string => !!id)
  if (!charges.length) return ['no_charge']
  const found = new Set<RefundBlocker>()
  for (const charge of charges) {
    const disputes = await stripe.disputes.list({ charge, limit: 100 })
    if (disputes.data.some(d => !SETTLED_DISPUTES.has(d.status))) found.add('dispute')
    const warnings = await stripe.radar.earlyFraudWarnings.list({ charge, limit: 1 })
    if (warnings.data.length) found.add('early_fraud_warning')
  }
  return [...found]
}

/** A subscription, cut to what billing reads. */
function subscriptionOf(sub: Stripe.Subscription): BillingSubscription {
  const first = sub.items.data[0]
  return {
    id: sub.id,
    customerId: idOf(sub.customer)!,
    status: sub.status,
    currentPeriodStart: iso(first?.current_period_start),
    currentPeriodEnd: iso(first?.current_period_end),
    billingCycleAnchor: iso(sub.billing_cycle_anchor),
    interval: first?.price.recurring?.interval === 'year' ? 'year' : first ? 'month' : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    trialEnd: iso(sub.trial_end),
    defaultPaymentMethod: idOf(sub.default_payment_method),
    // A price the bootstrap replaced (a new amount) lost its lookup key; its `metadata.linedesk` keeps it.
    items: sub.items.data.map(item => ({
      lookupKey: item.price.lookup_key ?? item.price.metadata?.linedesk ?? null,
      quantity: item.quantity ?? 0,
      unitAmountCents: item.price.unit_amount ?? null,
      productId: idOf(item.price.product),
    })),
  }
}

/** The metadata that names the bill on a customer and a Checkout Session. */
export const BILL_METADATA = 'billing_account_id'
/** The metadata that says which Checkout a session is (`trial`, `plan`, `topup`). */
export const CHECKOUT_METADATA = 'linedesk_checkout'
/** The product of "Buy minutes" (our own id; made by the catalog sync, or by a top-up when missing, catalog.ts). */
export const TOPUP_PRODUCT = productId('balance_topup')

/**
 * The payment method configuration "Linedesk Checkout", read over every page (an account with more than 100
 * configurations, from Connect or old experiments, still finds it; review of #876, I2). The bootstrap uses it too.
 */
export async function findCheckoutConfiguration(
  stripe: Stripe,
  also: (config: Stripe.PaymentMethodConfiguration) => boolean = () => true,
) {
  for await (const config of stripe.paymentMethodConfigurations.list({ limit: 100 }))
    if (isCheckoutPaymentMethodConfiguration(config) && also(config)) return config
  return null
}

/** An id no portal configuration has: the write-access probe's (nothing is written). */
const PORTAL_PROBE_ID = 'bpc_linedesk_permission_check'

/**
 * Stripe refuses the terms checkbox when the account has no Terms of Service URL (Dashboard › Settings › Public
 * details): a 400 without its own code, told by its parameter or message (as Checkout's own mapping to
 * `stripe_terms_url_missing` does). The checkbox is never left out to get past it.
 */
function termsUrlRefused(error: unknown) {
  const e = error as { statusCode?: number; message?: unknown; param?: unknown }
  if (e.statusCode !== 400) return false
  const about = `${typeof e.param === 'string' ? e.param : ''} ${typeof e.message === 'string' ? e.message : ''}`
  return /terms[ _]of[ _]service/i.test(about)
}

/** A 400 when a Checkout is made: the account is not set up for it (a price, tax, the terms URL). For the admins. */
function refusedSetup(error: unknown): BillingSetupError | null {
  const e = error as { statusCode?: number; code?: string }
  return e.statusCode === 400 ? new BillingSetupError(`stripe_${e.code ?? 400}`) : null
}

/**
 * Checkout's tax fields (docs/billing.md §5.2). With the install's Stripe Tax on: automatic tax (a subscription made by
 * the session keeps it for all its invoices: renewals, seat changes, the trial's first invoice), the full billing
 * address required, and tax IDs collected ("I'm purchasing as a business"); the address and tax ID are saved on the
 * customer (`customer_update`), so the app's own invoices (recharges) are taxed at the same address. Off: no tax, and
 * Stripe asks for the address only when the card needs it.
 */
export function checkoutTax(automaticTax: boolean) {
  return {
    automatic_tax: { enabled: automaticTax },
    billing_address_collection: automaticTax ? ('required' as const) : ('auto' as const),
    customer_update: { address: 'auto' as const, name: 'auto' as const },
    tax_id_collection: { enabled: automaticTax },
  }
}

/**
 * A Checkout Session (docs/billing.md §3.2 step 3, §2.2): the card-only configuration and never
 * `payment_method_types` (§2.4), our exclusive prices with the install's tax fields (`checkoutTax`), the terms for a
 * plan. A plan saves its card on the subscription; no `setup_future_usage` in subscription mode.
 */
async function startCheckout(stripe: Stripe, input: CheckoutInput) {
  const metadata = { [BILL_METADATA]: input.billId, [CHECKOUT_METADATA]: input.kind }
  const common = {
    customer: input.customerId,
    client_reference_id: input.billId,
    payment_method_configuration: input.paymentMethodConfiguration,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    ...checkoutTax(input.catalog.automaticTax),
    custom_text: {
      submit: { message: input.submitText.slice(0, CUSTOM_TEXT_MAX) },
    },
    ...(input.branding ? { branding_settings: brandingOf(input.branding) } : {}),
    expires_at: input.expiresAt,
    metadata,
  }
  let session: Stripe.Checkout.Session
  if (input.kind === 'topup') {
    if (!input.amountCents) throw new Error('a top-up needs its amount')
    // Only its own product, never the plan prices (security review of #1040, M-1): found (a read), made only when
    // missing; its name is not the install's, so it is never renamed here.
    const topup = input.catalog.products.balance_topup
    if (topup) await ensureProduct(stripe, 'balance_topup', topup, input.catalog.taxCode, { rename: false })
    session = await stripe.checkout.sessions.create(
      {
        ...common,
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: input.catalog.currency,
              product: TOPUP_PRODUCT,
              unit_amount: input.amountCents,
              tax_behavior: 'exclusive',
            },
            quantity: 1,
          },
        ],
        payment_intent_data: { metadata },
        invoice_creation: { enabled: true, invoice_data: { metadata } },
      },
      { idempotencyKey: input.idempotencyKey },
    )
  } else {
    const items = input.items ?? []
    if (!items.length) throw new Error('a plan needs its items')
    // The price ids the last catalog sync stored (an admin's save); Checkout never makes or changes prices.
    const prices = input.prices ?? {}
    for (const i of items) if (!prices[i.lookupKey]) throw new BillingSetupError('stripe_catalog_not_synced')
    session = await stripe.checkout.sessions.create(
      {
        ...common,
        mode: 'subscription',
        line_items: items.map(i => ({ price: prices[i.lookupKey]!, quantity: i.quantity })),
        payment_method_collection: 'always',
        consent_collection: { terms_of_service: 'required' },
        subscription_data: {
          metadata,
          ...(input.kind === 'trial' && input.trialDays
            ? {
                trial_period_days: input.trialDays,
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
              }
            : {}),
        },
      },
      { idempotencyKey: input.idempotencyKey },
    )
  }
  if (!session.url) throw new Error(`Checkout Session ${session.id} has no URL`)
  return { id: session.id, url: session.url }
}

/** Stripe's limit on each Checkout custom text. */
const CUSTOM_TEXT_MAX = 1200

/**
 * Checkout's own branding per session (Stripe's `branding_settings`): the install's name at the top instead of the
 * Stripe account's, and its color on the button when it is a hex color. The logo stays the account's: Stripe would
 * fetch a URL at once, and an install's logo is not always reachable from the internet (a server on a private
 * network, dev). Receipts, invoices, the statement descriptor and the portal keep the account's name (§2.4).
 */
function brandingOf(branding: NonNullable<CheckoutInput['branding']>) {
  const color = branding.buttonColor && /^#[0-9a-f]{6}$/i.test(branding.buttonColor) ? branding.buttonColor : null
  return { display_name: branding.displayName.slice(0, 100), ...(color ? { button_color: color } : {}) }
}

const cardOf = (pm: string | Stripe.PaymentMethod | null | undefined): CheckoutCard | null =>
  pm && typeof pm === 'object' && pm.card
    ? { fingerprint: pm.card.fingerprint ?? null, funding: pm.card.funding ?? null, country: pm.card.country ?? null }
    : null

const riskOf = (charge: string | Stripe.Charge | null | undefined) =>
  charge && typeof charge === 'object' ? (charge.outcome?.risk_level ?? null) : null

/**
 * A Checkout Session with what the trial checks read (docs/billing.md §3.2 step 4): the subscription and the card it
 * charges, or the payment and its card; Radar's risk level where a charge was made.
 */
async function checkoutSession(stripe: Stripe, id: string): Promise<CheckoutSession | null> {
  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.retrieve(id, {
      expand: [
        'subscription',
        'subscription.default_payment_method',
        'payment_intent',
        'payment_intent.payment_method',
        'payment_intent.latest_charge',
      ],
    })
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  const sub = typeof session.subscription === 'object' ? session.subscription : null
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null
  let card = cardOf(sub?.default_payment_method) ?? cardOf(intent?.payment_method)
  let riskLevel = riskOf(intent?.latest_charge)
  // A plan paid now: its first invoice's payment holds the charge (and the card, when the subscription has none).
  const latestInvoice = sub ? idOf(sub.latest_invoice) : null
  if (sub && latestInvoice && sub.status !== 'trialing') {
    const payments = await stripe.invoicePayments
      .list({
        invoice: latestInvoice,
        limit: 10,
        expand: ['data.payment.payment_intent.latest_charge', 'data.payment.payment_intent.payment_method'],
      })
      .autoPagingToArray({ limit: 100 })
    for (const p of payments) {
      const pi = p.payment.payment_intent
      if (p.status !== 'paid' || !pi || typeof pi !== 'object') continue
      riskLevel ??= riskOf(pi.latest_charge)
      card ??= cardOf(pi.payment_method)
    }
  }
  const charge = intent?.latest_charge
  return {
    id: session.id,
    livemode: session.livemode,
    mode: session.mode,
    status: session.status,
    paymentStatus: session.payment_status,
    customerId: idOf(session.customer as string | { id: string } | null),
    clientReferenceId: session.client_reference_id,
    kind: session.metadata?.[CHECKOUT_METADATA] ?? null,
    subscription: sub ? subscriptionOf(sub) : null,
    card,
    riskLevel,
    amountSubtotalCents: session.amount_subtotal,
    currency: session.currency,
    charged: intent?.status === 'succeeded' && !!charge && typeof charge === 'object' && charge.paid,
  }
}

/**
 * What a charge paid for: its customer, and through its payment intent the invoice (a recharge or plan invoice, by its
 * invoice payment) or the Checkout session (a top-up). Ids only.
 */
async function chargeSource(stripe: Stripe, chargeId: string): Promise<BillingChargeSource> {
  const charge = await stripe.charges.retrieve(chargeId)
  const intent = idOf(charge.payment_intent)
  let invoiceId: string | null = null
  let checkoutSessionId: string | null = null
  if (intent) {
    const payments = await stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: intent },
      limit: 1,
    })
    invoiceId = idOf(payments.data[0]?.invoice as string | { id: string } | undefined)
    // Always, not only without an invoice: a top-up's Checkout session makes an invoice paid by the same payment
    // intent, so a top-up's charge has both, and its credit is found only through the session (#920 review, M5).
    const sessions = await stripe.checkout.sessions.list({ payment_intent: intent, limit: 1 })
    checkoutSessionId = sessions.data[0]?.id ?? null
  }
  return {
    chargeId,
    customerId: idOf(charge.customer),
    invoiceId,
    checkoutSessionId,
    chargeAmountCents: charge.amount,
    refunded: charge.refunded,
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

/**
 * 400 codes that are about our Stripe account or the app's request, never about one customer: Stripe Tax not active,
 * a closed or invalid account, a key of the other mode, a parameter Stripe does not take. Every bill's recharge would
 * fail the same way, so they go to the instance admins as a setup error (the recharge job gives up through
 * `setupGaveUp`: one alert per code a day), not to each owner as a failed recharge (security review of #1105, N-2). Customer refusals (`customer_tax_location_invalid`, `tax_id_invalid`, a
 * card) stay the owner's, and so does `taxes_calculation_failed`: it can come from one customer's address (security
 * review of #1110, R-2).
 */
const ACCOUNT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'stripe_tax_inactive',
  'account_closed',
  'account_invalid',
  'account_country_invalid_address',
  'account_information_mismatch',
  'api_key_expired',
  'platform_api_key_expired',
  'platform_account_required',
  'secret_key_required',
  'livemode_mismatch',
  'testmode_charges_only',
  'no_account',
  'not_allowed_on_standard_account',
  'request_blocked',
  'tls_version_unsupported',
  'product_inactive',
  'parameter_unknown',
  'parameter_missing',
  'parameter_invalid_empty',
  'parameter_invalid_integer',
  'parameter_invalid_string_blank',
  'parameter_invalid_string_empty',
  'parameters_exclusive',
])

/** A 400 caused by our own account or request (ACCOUNT_REFUSAL_CODES): a setup error for the admins. */
function accountRefusal(error: unknown): BillingSetupError | null {
  const e = error as { statusCode?: number; code?: string }
  return e.statusCode === 400 && e.code && ACCOUNT_REFUSAL_CODES.has(e.code)
    ? new BillingSetupError(`stripe_${e.code}`)
    : null
}

/**
 * The invoice an earlier try of this recharge made, after Stripe refused its reused idempotency key (N-3): found by
 * the attempt id in its metadata. Stripe's search can lag a new invoice by a moment: not found yet, the refusal is
 * thrown and the job tries again (its retries run for about an hour).
 */
async function earlierRechargeInvoice(stripe: Stripe, rechargeId: string, refusal: unknown): Promise<Stripe.Invoice> {
  const found = await searchRechargeInvoice(stripe, rechargeId)
  if (!found) throw refusal
  return found
}

/** The invoice whose `metadata.billing_recharge_id` is this attempt's, or null. */
async function searchRechargeInvoice(stripe: Stripe, rechargeId: string): Promise<Stripe.Invoice | null> {
  // The recharge id is ours (letters, digits and _), so it is safe inside the search query.
  if (!/^[a-z0-9_]+$/i.test(rechargeId)) throw new Error('not a recharge id')
  const found = await stripe.invoices.search({ query: `metadata['${RECHARGE_METADATA}']:'${rechargeId}'`, limit: 1 })
  return found.data[0] ?? null
}

/** Stripe refused a reused idempotency key with other parameters: the earlier request did happen. */
function idempotencyRefusal(error: unknown): boolean {
  const e = error as { type?: string; rawType?: string }
  return e.type === 'StripeIdempotencyError' || e.rawType === 'idempotency_error'
}

/** How many customers `customersWithoutTaxAddress` reads at once (Stripe's rate limit is shared with recharges). */
const TAX_ADDRESS_READS = 4

/** Stripe Tax does not know where this customer is (no billing address): it cannot tax them. */
function untaxable(customer: Stripe.Customer): boolean {
  return customer.tax?.automatic_tax === 'unrecognized_location'
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
  if (own)
    return {
      id: idOf(own)!,
      createdAt: typeof own === 'string' ? null : iso(own.created),
      on: 'customer',
      ...brandOfCard(own),
    }
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
  return {
    id: idOf(card)!,
    createdAt: typeof card === 'string' ? null : iso(card.created),
    on: 'subscription',
    ...brandOfCard(card),
  }
}

/** The brand and last four digits of an expanded card payment method, for the owner's confirmation. */
function brandOfCard(method: string | Stripe.PaymentMethod) {
  const card = typeof method === 'string' ? null : method.card
  return { brand: card?.brand ?? null, last4: card?.last4 ?? null }
}

/** The text of a recharge's invoice item, set apart from its idempotent create (review of #1040, L-5). */
async function describeItem(stripe: Stripe, item: Stripe.InvoiceItem, description: string) {
  if (item.description !== description) await stripe.invoiceItems.update(item.id, { description })
}

/**
 * A recharge (docs/billing.md §2.2): one invoice per attempt, `charge_automatically` with the install's automatic tax
 * (the item carries our tax code; tax is computed at the customer's saved address and added on top), holding only
 * its own item (`pending_invoice_items_behavior=exclude`), then finalized and paid with the saved card. Every request
 * carries an idempotency key made from the attempt id, so a retried job never makes a second invoice or charge.
 */
async function chargeRecharge(stripe: Stripe, input: RechargeInvoiceInput): Promise<RechargeCharge> {
  const key = (step: string) => ({ idempotencyKey: `${input.rechargeId}:${step}` })
  const metadata = { [RECHARGE_METADATA]: input.rechargeId }
  let invoice: Stripe.Invoice
  if (input.invoiceId) invoice = await stripe.invoices.retrieve(input.invoiceId)
  else
    try {
      invoice = await stripe.invoices.create(
        {
          customer: input.customerId,
          collection_method: 'charge_automatically',
          auto_advance: true,
          automatic_tax: { enabled: input.tax.automatic },
          pending_invoice_items_behavior: 'exclude',
          currency: 'usd',
          metadata,
        },
        key('invoice'),
      )
    } catch (error) {
      // A reused key with other parameters: an earlier try of this attempt made the invoice (it was sent with other
      // tax, before the attempt's tax was kept). It is looked up by the attempt in its metadata and carried on with;
      // the draft's tax is set to this attempt's below (security review of #1105, N-3).
      if (idempotencyRefusal(error)) invoice = await earlierRechargeInvoice(stripe, input.rechargeId, error)
      else {
        // A refusal caused by our own account (Stripe Tax not active, a key of the other mode): for the admins, never
        // the owner's failed recharge (N-2).
        const account = accountRefusal(error)
        if (account) throw account
        // Any other 400 (a tax location Stripe refuses, a customer it cannot invoice) is an answer about this
        // customer, like at finalize: the owner's failed-recharge path, not a retried job that ends quietly (L-3).
        const failureCode = refusedForGood(error)
        if (!failureCode) throw setupError(error) ?? error
        return { status: 'failed', invoiceId: null, failureCode }
      }
    }
  if (invoice.metadata?.[RECHARGE_METADATA] !== input.rechargeId)
    throw new Error(`invoice ${invoice.id} is not the one of recharge ${input.rechargeId}`)
  // Stored on the attempt before anything else can be refused (R-1): every give-up path then finds it to stop.
  if (!input.invoiceId && input.onInvoice) await input.onInvoice(invoice.id!)
  if (invoice.status === 'draft') {
    // The texts carry the install's name, which an admin may change between two tries of one attempt: they are set
    // by plain updates, never in a request with an idempotency key, so a retry after a rename is not refused as an
    // `idempotency_error` (security review of #1040, L-5).
    // The draft's tax is this attempt's too: a draft made by an earlier try with other tax (N-3) is set right before
    // it is finalized. Also a plain update, for the same reason.
    const changes: Stripe.InvoiceUpdateParams = {}
    if (invoice.description !== input.description) changes.description = input.description
    if (invoice.automatic_tax && invoice.automatic_tax.enabled !== input.tax.automatic)
      changes.automatic_tax = { enabled: input.tax.automatic }
    if (Object.keys(changes).length) await stripe.invoices.update(invoice.id!, changes)
    if (!invoice.total) {
      let item: Stripe.InvoiceItem
      try {
        item = await stripe.invoiceItems.create(
          {
            customer: input.customerId,
            invoice: invoice.id,
            amount: input.amountCents,
            currency: 'usd',
            tax_behavior: 'exclusive',
            tax_code: input.tax.code,
            metadata,
          },
          key('item'),
        )
      } catch (error) {
        // As at create: our account's refusal is the admins' (N-2); otherwise the draft is handed back as failed, and
        // the failed-recharge path deletes it (L-3).
        const account = accountRefusal(error)
        if (account) throw account
        const failureCode = refusedForGood(error)
        if (!failureCode) throw setupError(error) ?? error
        return { status: 'failed', invoiceId: invoice.id!, failureCode }
      }
      await describeItem(stripe, item, input.description)
    }
    try {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id!, { auto_advance: true }, key('finalize'))
    } catch (error) {
      const account = accountRefusal(error)
      if (account) throw account
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
    // On-session: the owner just confirmed this payment in the app; 3D Secure fails at once, never later.
    invoice = await stripe.invoices.pay(id, input.onSession ? { off_session: false } : {}, key('pay'))
  } catch (error) {
    const e = error as { statusCode?: number; code?: string; decline_code?: string }
    // 3DS first, whatever the status: the invoice stays open for the owner to confirm (recheck of #864, L1).
    if (e.code && NEEDS_CUSTOMER.has(e.code))
      return { status: 'failed', invoiceId: id, failureCode: 'authentication_required' }
    const account = accountRefusal(error)
    if (account) throw account
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
