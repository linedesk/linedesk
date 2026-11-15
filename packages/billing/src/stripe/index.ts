// The Stripe adapter: the only place that imports the Stripe SDK. Loaded with a dynamic import (../index.ts), so an
// install without Stripe never loads it.
import Stripe from 'stripe'
import { stripeKeyMode } from '../keys.ts'
import type { BillingProvider, StripeKeys } from '../provider.ts'

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
  }
}
