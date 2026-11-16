// The Stripe adapter: the only place that imports the Stripe SDK. Loaded with a dynamic import (../index.ts), so an
// install without Stripe never loads it.
import Stripe from 'stripe'
import { stripeKeyMode } from '../keys.ts'
import type { BillingProvider, RechargeCharge, RechargeInvoiceInput, StripeKeys } from '../provider.ts'

/**
 * The Stripe API version every request and the webhook endpoint use (docs/billing.md §5.1): the version this SDK
 * release is built for (the SDK constructor accepts only that one). Changing it is its own PR, with the SDK update and a look at Stripe's upgrade notes.
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia' as const

/** No request to Stripe waits longer; billing never sits on the call path, but admin pages should not hang. */
export const STRIPE_TIMEOUT_MS = 8000

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
    chargeRecharge: input => chargeRecharge(stripe, input),
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
  }
}

/** The invoice metadata that names the recharge attempt (docs/billing.md §3.4: found again after 24 hours). */
export const RECHARGE_METADATA = 'billing_recharge_id'

/**
 * Stripe refused the request for good: a 4xx other than a card error (402), a conflict (409, a request with the same
 * key still running) or a rate limit (429), which are retried. The invoice cannot be charged as it is (no tax
 * location, no payment method), so the recharge fails instead of staying pending (security review of #864, L3).
 */
function refusedForGood(error: unknown): string | null {
  const e = error as { statusCode?: number; code?: string }
  if (typeof e.statusCode !== 'number' || e.statusCode < 400 || e.statusCode >= 500) return null
  if ([402, 409, 429].includes(e.statusCode)) return null
  return `stripe_${e.code ?? e.statusCode}`
}

/** Card errors that need the customer to confirm the payment (3DS) on the invoice's page. */
const NEEDS_CUSTOMER = new Set(['authentication_required', 'invoice_payment_intent_requires_action'])

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
      if (!failureCode) throw error
      return { status: 'failed', invoiceId: invoice.id!, failureCode }
    }
  }
  const id = invoice.id!
  if (invoice.status === 'paid') return { status: 'paid', invoiceId: id }
  if (invoice.status !== 'open') return { status: 'failed', invoiceId: id, failureCode: `invoice_${invoice.status}` }
  try {
    invoice = await stripe.invoices.pay(id, {}, key('pay'))
  } catch (error) {
    const e = error as { statusCode?: number; code?: string; decline_code?: string }
    const refused = refusedForGood(error)
    if (refused) return { status: 'failed', invoiceId: id, failureCode: refused }
    // 402: the card was refused (or needs the customer); anything else is not an answer about the charge: retried.
    if (e.statusCode !== 402 || !e.code) throw error
    const failureCode = NEEDS_CUSTOMER.has(e.code) ? 'authentication_required' : (e.decline_code ?? e.code)
    return { status: 'failed', invoiceId: id, failureCode }
  }
  return { status: invoice.status === 'paid' ? 'paid' : 'open', invoiceId: id }
}
