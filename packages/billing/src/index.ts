// @linedesk/billing: the billing provider behind an interface (docs/billing.md §7). The Stripe SDK is imported only
// by `./stripe/`, through `loadBillingProvider`, never at the top of this module.
import { noneBillingProvider } from './none.ts'
import type { BillingProvider, StripeKeys } from './provider.ts'

export { isStripeWebhookSecret, LIVE_KEYS_REFUSED, liveKeysAllowed, stripeKeyMode } from './keys.ts'
export { noneBillingProvider } from './none.ts'
export type { BillingAccountInfo, BillingProvider, BillingProviderName, KeyMode, StripeKeys } from './provider.ts'

/** The provider for the keys in effect: `none` without keys, else the Stripe adapter, loaded on first use. */
export async function loadBillingProvider(
  keys: StripeKeys | null,
  doFetch: typeof fetch = fetch,
): Promise<BillingProvider> {
  if (!keys) return noneBillingProvider
  const { createStripeBillingProvider } = await import('./stripe/index.ts')
  return createStripeBillingProvider(keys, doFetch)
}

