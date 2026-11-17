// @linedesk/billing: the billing provider behind an interface (docs/billing.md §7). The Stripe SDK is imported only
// by `./stripe/`, through `loadBillingProvider`, never at the top of this module.
import { noneBillingProvider } from './none.ts'
import type { BillingProvider, StripeKeys } from './provider.ts'

export { isStripeWebhookSecret, LIVE_KEYS_REFUSED, liveKeysAllowed, stripeKeyMode } from './keys.ts'
export { noneBillingProvider } from './none.ts'
export { STRIPE_API_VERSION } from './version.ts'
export type {
  BillingAccountInfo,
  BillingChargeSource,
  BillingDispute,
  BillingEvent,
  BillingFraudWarning,
  BillingInvoice,
  BillingInvoiceLine,
  BillingProvider,
  BillingProviderName,
  BillingSubscription,
  InvoiceRefund,
  InvoiceRefundInput,
  CheckoutCard,
  CheckoutInput,
  CheckoutSession,
  CheckoutStarted,
  CustomerPurchases,
  InvoiceItemInput,
  InvoiceTax,
  KeyMode,
  PlanCatalog,
  PortalDesign,
  PortalSync,
  RechargeCard,
  RechargeCharge,
  RechargeInvoiceInput,
  RechargeInvoiceStop,
  RefundBlocker,
  ExtraCallsAnswer,
  ExtraCallsQuantityInput,
  SeatQuantityInput,
  StripeKeys,
  SubscriptionTaxSync,
  TaxSetup,
  WebhookRefusal,
} from './provider.ts'
export {
  BillingSetupError,
  CHECKOUT_PMC_NAME,
  STRIPE_TERMS_URL_MISSING,
  WEBHOOK_EVENTS,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookRefused,
} from './provider.ts'

/** The provider for the keys in effect: `none` without keys, else the Stripe adapter, loaded on first use. */
export async function loadBillingProvider(
  keys: StripeKeys | null,
  doFetch: typeof fetch = fetch,
): Promise<BillingProvider> {
  if (!keys) return noneBillingProvider
  const { createStripeBillingProvider } = await import('./stripe/index.ts')
  return createStripeBillingProvider(keys, doFetch)
}
