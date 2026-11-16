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

/** One auto-recharge (docs/billing.md §2.2): an off-session invoice with one item, charged to the saved card. */
export type RechargeInvoiceInput = {
  customerId: string
  amountCents: number
  /** The `billing_recharges.id`: the idempotency key of every request and the invoice's `metadata.billing_recharge_id`. */
  rechargeId: string
  /** The invoice item's text ("Linedesk balance recharge"); the customer sees it on the invoice. */
  description: string
  /** The invoice an earlier try made, when it is known: it is charged instead of a new one. */
  invoiceId?: string | null
}

/**
 * What charging a recharge invoice came to. `paid`: the card was charged (the balance is credited by the webhook, from
 * the invoice fetched again, never from this answer); `open`: finalized and waiting (a payment in progress);
 * `failed`: the charge was refused, with the payment service's code (`authentication_required` when the owner has to
 * confirm the payment on the invoice's page).
 */
export type RechargeCharge =
  | { status: 'paid' | 'open'; invoiceId: string }
  | { status: 'failed'; invoiceId: string; failureCode: string }

/**
 * The interface. It grows with the billing PRs (checkout, invoices, webhooks). `none` answers the account without a
 * network call and refuses every charge.
 */
export type BillingProvider = {
  name: BillingProviderName
  /** The account behind the keys. Throws on a rejected key or a network failure (the caller maps it to a problem). */
  account(): Promise<BillingAccountInfo | null>
  /**
   * Creates (once, by the recharge id), finalizes and charges a recharge invoice. Throws on a network failure or an
   * answer it does not understand: the job tries again with the same keys.
   */
  chargeRecharge(input: RechargeInvoiceInput): Promise<RechargeCharge>
  /** The invoice a recharge made, found by its metadata (for a retry after the idempotency keys expired); null: none. */
  findRechargeInvoice(rechargeId: string): Promise<string | null>
  /**
   * A failed recharge is never charged later behind the owner's back (docs/billing.md §3.4): automatic collection
   * off, so the payment service's retries skip it, and with `void` the invoice is voided too.
   */
  stopRechargeInvoice(invoiceId: string, options: { void: boolean }): Promise<void>
  /** The invoice's own page, where the customer pays it or confirms the payment (a bearer link: never stored). */
  rechargeInvoicePage(invoiceId: string): Promise<string | null>
}

/** The keys of the `stripe` adapter, as stored under Server admin › Providers › Billing. */
export type StripeKeys = { secretKey: string; webhookSecret: string }
