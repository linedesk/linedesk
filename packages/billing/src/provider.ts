// The billing provider (docs/billing.md §7): what the rest of Linedesk asks of a payment service. Every self-hosted
// install runs `none`; Linedesk Cloud runs `stripe` once an instance admin connected Stripe under Server admin ›
// Providers › Billing and turned billing on. The vendor SDK lives only in its adapter (`./stripe/`), loaded lazily.

/** Test keys charge nothing; live keys charge real cards. Read from the key itself, never from a setting. */
export type KeyMode = 'test' | 'live'

/** What the payment service says about the account the keys belong to (the provider test shows it). */
export type BillingAccountInfo = {
  id: string
  mode: KeyMode
  /** ISO 3166-1 alpha-2, as the service reports it; null when it does not say. */
  country: string | null
  /** ISO 4217, lower case as Stripe sends it; null when it does not say. */
  defaultCurrency: string | null
}

export type BillingProviderName = 'none' | 'stripe'

/**
 * The interface. It grows with the billing PRs (checkout, invoices, webhooks); for now it only reads the account,
 * which is what the provider test needs. `none` answers without a network call.
 */
export type BillingProvider = {
  name: BillingProviderName
  /** The account behind the keys. Throws on a rejected key or a network failure (the caller maps it to a problem). */
  account(): Promise<BillingAccountInfo | null>
}

/** The keys of the `stripe` adapter, as stored under Server admin › Providers › Billing. */
export type StripeKeys = { secretKey: string; webhookSecret: string }
