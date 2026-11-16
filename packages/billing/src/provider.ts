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
 * A webhook event whose signature was checked (or one listed from the API by the nightly reconciliation), cut to what
 * billing reads: which object and which customer, only to find the object to fetch and to skip customers this install
 * does not know, never to act on. The rest of Stripe's payload (names, emails, addresses, also of other integrations'
 * customers on the same account) is never kept (security review of #865, L4).
 */
export type BillingEvent = {
  id: string
  type: string
  livemode: boolean
  /** Unix seconds, as Stripe sends it. */
  created: number
  objectId: string | null
  /** The object's kind (`invoice`, `customer`, …). */
  objectType: string | null
  customerId: string | null
}

/** One line of an invoice, as fetched: its pre-tax amount and what it charges. */
export type BillingInvoiceLine = {
  id: string
  /** Pre-tax (our prices are tax-exclusive), in cents. */
  amountCents: number
  currency: string
  /** An invoice item (a recharge) or a subscription item (a seat, the partner base). */
  kind: 'invoice_item' | 'subscription' | 'other'
  /** `metadata.billing_recharge_id` of the line (set on the invoice item by the recharge job). */
  rechargeId: string | null
  /**
   * Whether discounts or pre-tax credits (coupons, credit grants) were applied to this line: non-zero means yes. Not an
   * amount: Stripe lists a discount in both `discount_amounts` and `pretax_credit_amounts`, so it is counted twice here.
   * Never use it to compute what was paid or credited.
   */
  discountCents: number
}

/** An invoice fetched from the service (fetch-before-act): only what billing decides on. */
export type BillingInvoice = {
  id: string
  livemode: boolean
  customerId: string | null
  subscriptionId: string | null
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null
  billingReason: string | null
  currency: string
  totalCents: number
  taxCents: number
  /** What the customer paid on it (not what a credit balance covered). */
  amountPaidCents: number
  /** Marked paid outside Stripe in the Dashboard: never a real payment. */
  amountPaidOffStripeCents: number
  /** The sum of its paid payments that are a charge or a payment intent: money that really came in. */
  chargedCents: number
  /** The customer's credit balance applied to it (Stripe's `starting_balance`; negative is a credit). */
  startingBalanceCents: number
  /** Why its last payment failed: `authentication_required` when the customer has to confirm it, else the decline. */
  paymentFailureCode: string | null
  /** `metadata.billing_recharge_id` of the invoice. */
  rechargeId: string | null
  lines: BillingInvoiceLine[]
  number: string | null
  /** ISO times. */
  periodStart: string | null
  periodEnd: string | null
  hostedInvoiceUrl: string | null
  pdfUrl: string | null
}

/** A subscription fetched from the service: its state, period and items. */
export type BillingSubscription = {
  id: string
  customerId: string
  status: string
  /** ISO times, from its items (they share one interval). */
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  interval: 'month' | 'year' | null
  cancelAtPeriodEnd: boolean
  trialEnd: string | null
  defaultPaymentMethod: string | null
  items: { lookupKey: string | null; quantity: number }[]
}

/**
 * Stripe refused a request because of our own setup, not the customer's card: the key lacks a permission (403), is
 * revoked (401), or an object is gone (404). Never a failed card payment (no owner email); the admins are told
 * (security review of #864 recheck, L2).
 */
export class BillingSetupError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`the payment service refused the request (${code}): check the keys and the account`)
    this.code = code
  }
}

/** Why a webhook request is refused: a signature that does not match any secret, or an event of the other mode. */
/**
 * Why a webhook delivery was refused. `signature`: not from Stripe (or changed, or too old). `livemode` and
 * `api_version` come with a valid signature: Stripe sent them, but the endpoint is set up wrong (another mode, or not
 * pinned to the API version the adapter reads).
 */
export type WebhookRefusal = 'signature' | 'livemode' | 'api_version'

export class WebhookRefused extends Error {
  readonly reason: WebhookRefusal
  /** For `api_version`: the version the event came in (Stripe's, safe to log). */
  readonly apiVersion: string | null
  constructor(reason: WebhookRefusal, apiVersion: string | null = null) {
    super(
      reason === 'signature'
        ? 'webhook signature does not match'
        : reason === 'livemode'
          ? 'webhook event is of the other mode'
          : 'webhook event is of another API version',
    )
    this.reason = reason
    this.apiVersion = apiVersion
  }
}

/** The event types the webhook endpoint subscribes to (docs/billing.md §5.1); the bootstrap script sets them. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.created',
  'invoice.finalized',
  'invoice.finalization_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.voided',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
  'customer.updated',
  'payment_method.attached',
  'setup_intent.succeeded',
] as const

/** Stripe's default: a signature older than five minutes is refused (replays). */
export const WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * The interface. `none` answers without a network call: no account, no events, nothing to fetch, every webhook and
 * every charge refused.
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
  /**
   * Checks a webhook's `Stripe-Signature` over the raw body with the signing secret and, during a rotation, the
   * previous one, within the tolerance; refuses an event of the other mode than the key. Throws `WebhookRefused`.
   */
  webhookEvent(rawBody: Uint8Array, signature: string): BillingEvent
  /** The invoice as it is now, with all its lines and payments; null when the service does not know it. */
  invoice(id: string): Promise<BillingInvoice | null>
  /** The subscription as it is now; null when the service does not know it. */
  subscription(id: string): Promise<BillingSubscription | null>
  /**
   * The events of the given types created since `sinceSeconds` (Unix), oldest first, at most `limit`; `truncated`
   * when there were more (the reconciliation then says so, it never drops them silently).
   */
  recentEvents(
    sinceSeconds: number,
    types: readonly string[],
    limit?: number,
  ): Promise<{ events: BillingEvent[]; truncated: boolean }>
}

/** The keys of the `stripe` adapter, as stored under Server admin › Providers › Billing. */
export type StripeKeys = {
  secretKey: string
  webhookSecret: string
  /** The signing secret before a rotation, accepted beside the new one until it is removed. */
  webhookSecretPrevious?: string | null
}
