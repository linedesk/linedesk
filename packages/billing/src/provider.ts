// The billing provider (docs/billing.md §7): what the rest of Linedesk asks of a payment service. An install runs
// `none` by default; it runs `stripe` once an instance admin connected the install's own Stripe account under Server
// admin › Providers › Billing and turned billing on (Linedesk Cloud is one such install). The vendor SDK lives only in its adapter (`./stripe/`), loaded lazily.

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
  /** The invoice item's text ("<product name> balance recharge"); the customer sees it on the invoice. */
  description: string
  /** The invoice an earlier try made, when it is known: it is charged instead of a new one. */
  invoiceId?: string | null
  /**
   * The owner is in the app and confirmed this payment ("Buy minutes" with the saved card, docs/billing.md §2.2): the
   * card is charged on-session, so a card that needs 3D Secure fails with `authentication_required` at once (the app
   * then falls back to Checkout) instead of being tried off-session. Auto-recharges leave it out.
   */
  onSession?: boolean
  /**
   * The bill's subscription. Checkout in `subscription` mode saves the card on the subscription, not as the customer's
   * invoice default; a recharge invoice stands alone, so without a customer default the subscription's card is made it
   * before the charge (see `rechargeCard`).
   */
  subscriptionId?: string | null
  /**
   * Automatic tax on the invoice (the install's switch) and the tax code of its item. The balance is credited with the
   * item's pre-tax amount only; the tax is the tax authority's, never balance.
   */
  tax: InvoiceTax
  /**
   * Called with the invoice's id as soon as it exists (made, or found again), before its item, finalize and pay: the
   * caller stores it on the attempt, so a later give-up can stop that invoice whatever refused after it (security review
   * of #1110, R-1). A failure here is thrown, and the job tries again with the same idempotency keys.
   */
  onInvoice?: (invoiceId: string) => Promise<void>
}

/** What `stopRechargeInvoice` found: the invoice was already paid, or it is stopped now. */
export type RechargeInvoiceStop = 'paid' | 'stopped'

/**
 * The card an auto-recharge charges (docs/billing.md §2.2): the customer's invoice default (what the portal sets), else
 * the subscription's default (what Checkout saves), which the recharge then makes the customer's default. `createdAt`
 * (ISO; null for a legacy source) tells a card added after a failed recharge from the one that failed.
 */
export type RechargeCard = {
  id: string
  createdAt: string | null
  on: 'customer' | 'subscription'
  /** What the owner is shown before Buy minutes charges it (`visa`, `4242`); null when Stripe did not say (a legacy source). */
  brand?: string | null
  last4?: string | null
}

/**
 * What charging a recharge invoice came to. `paid`: the card was charged (the balance is credited by the webhook, from
 * the invoice fetched again, never from this answer); `open`: finalized and waiting (a payment in progress);
 * `failed`: the charge was refused, with the payment service's code (`authentication_required` when the owner has to
 * confirm the payment on the invoice's page).
 */
export type RechargeCharge =
  | { status: 'paid' | 'open'; invoiceId: string }
  // invoiceId null: Stripe refused the invoice itself (a 400 at create), so there is none to stop (review #1105, L-3).
  | { status: 'failed'; invoiceId: string | null; failureCode: string }

/**
 * A Checkout Session to start (docs/billing.md §3.2 step 3, §2.2 top-ups). `trial`: the plan with the free trial (a
 * SetupIntent checks the card, nothing is charged); `plan`: the plan paid now, no trial (a card that already had a
 * trial, or a prepaid one); `topup`: "Buy minutes", a one-off payment of `amountCents` (pre-tax), built on the server.
 * Always the card-only payment method configuration (`paymentMethodConfiguration`), never `payment_method_types`.
 */
export type CheckoutInput = {
  kind: 'trial' | 'plan' | 'topup'
  billId: string
  customerId: string
  paymentMethodConfiguration: string
  /**
   * What the install sells (`PlanCatalog`): its currency, and for `topup` the top-up product, made when missing (never
   * renamed). The plan prices are never made or changed here (security review of #1040, M-1): see `prices`.
   */
  catalog: PlanCatalog
  /**
   * `trial`, `plan`: the price ids by lookup key, as the last catalog sync stored them (`syncCatalog`). A lookup key of
   * `items` missing here is our setup (`BillingSetupError('stripe_catalog_not_synced')`), never a write at Checkout.
   */
  prices?: Readonly<Record<string, string>>
  /** The plan's prices by lookup key and their quantity (`trial`, `plan`). */
  items?: { lookupKey: string; quantity: number }[]
  trialDays?: number
  /** `topup`: the amount before tax, in cents. */
  amountCents?: number
  /** The text Checkout shows above its button (the trial's terms with the auto-recharge rules, or what the top-up is). */
  submitText: string
  /**
   * What Checkout shows at its top for this install (Server admin › Branding): its name instead of the Stripe
   * account's, and its color on the button. The rest (receipts, the statement descriptor, the portal) is the account's.
   */
  branding?: { displayName: string; buttonColor?: string | null }
  successUrl: string
  cancelUrl: string
  /** One per attempt: a retried request never makes a second session. */
  idempotencyKey: string
  /** When the session expires (unix seconds; Stripe allows 30 minutes to 24 hours from now). */
  expiresAt: number
}

/**
 * What an install sells, from its own settings (docs/billing.md §2.1, §7b): products by our key (the Stripe product
 * id is `linedesk_<key>`, never shown to a customer) with their names on invoices, and the plan prices by lookup key.
 * The adapter makes what is missing in the connected account and finds the rest, idempotently: a product whose name
 * changed is renamed; a plan amount that changed is a new price that takes the lookup key over, while running
 * subscriptions keep the price they were started on (it keeps `metadata.linedesk` = its lookup key). USD only.
 */
export type PlanCatalog = {
  products: Record<string, string>
  prices: readonly { lookupKey: string; product: string; cents: number; interval: 'month' | 'year' }[]
  /** The Stripe Tax code of every product (`txcd_10103001`, SaaS business use); set on each product by the sync. */
  taxCode: string
  /**
   * The install's Stripe Tax switch (`BillingRules.automaticTax`, docs/billing.md §5.2). On: Checkout computes tax
   * (`automatic_tax`), needs the full billing address and collects tax IDs, and the subscription it makes keeps
   * automatic tax for its invoices. Off: no tax is computed and the address is asked only when the card needs it.
   */
  automaticTax: boolean
  currency: 'usd'
}

/** How an invoice the app makes itself is taxed (a recharge, Buy minutes with the saved card, a trial's first recharge). */
export type InvoiceTax = { automatic: boolean; code: string }

/**
 * Whether Stripe Tax can compute tax on the account (the provider test; read only, nothing is changed). `status`:
 * Stripe's (`active`, or `pending` while required settings such as the head office address are missing, named in
 * `missingFields`). `registrations`: how many tax registrations are active now; with none, Stripe Tax computes $0
 * everywhere and only monitors thresholds.
 */
export type TaxSetup = { status: string; missingFields: string[]; registrations: number }

/**
 * What `syncSubscriptionTax` did with one subscription: `updated` (automatic tax set to the switch), `unchanged` (it was
 * already), `no_address` (tax on, but its customer has no address Stripe can tax: left untaxed until one is added, so
 * its next invoice does not fail), `gone` (no such subscription, or ended).
 */
export type SubscriptionTaxSync = 'updated' | 'unchanged' | 'no_address' | 'gone'

/** A started Checkout Session: where the owner pays. The URL is a bearer link, never stored. */
export type CheckoutStarted = { id: string; url: string }

/** The card a Checkout saved or charged, as Stripe has it: what the trial checks read (§3.2 step 4). */
export type CheckoutCard = {
  /** The same card number gives the same fingerprint in one Stripe account. */
  fingerprint: string | null
  /** `credit`, `debit`, `prepaid` or `unknown`. */
  funding: string | null
  country: string | null
}

/** A Checkout Session fetched from the service (fetch-before-act): only what billing decides on. */
export type CheckoutSession = {
  id: string
  livemode: boolean
  mode: 'subscription' | 'payment' | 'setup'
  status: 'open' | 'complete' | 'expired' | null
  /** `paid`, `unpaid` or `no_payment_required` (a trial). */
  paymentStatus: string
  customerId: string | null
  /** Our bill id (set when the session was made). */
  clientReferenceId: string | null
  /** `metadata.linedesk_checkout`: `trial`, `plan` or `topup`. */
  kind: string | null
  subscription: BillingSubscription | null
  /** The card the subscription will charge, or the one the payment was made with. */
  card: CheckoutCard | null
  /**
   * Radar's risk level of the charge (`normal`, `elevated`, `highest`), when there was one: a paid plan or a top-up.
   * A trial's card check is a SetupIntent, for which Stripe reports no risk level: null then.
   */
  riskLevel: string | null
  /** The pre-tax amount (`amount_subtotal`): what a top-up credits once it is paid. */
  amountSubtotalCents: number | null
  currency: string | null
  /** The session's payment intent was charged (a real payment, not a credit balance): `topup` only. */
  charged: boolean
}

/** What a customer bought at the service (`customerPurchases`): the first of each found, else null. */
export type CustomerPurchases = {
  /** A subscription that still runs (not `canceled` or `incomplete_expired`). */
  subscriptionId: string | null
  /**
   * A Checkout Session with status `complete` outside a subscription (a payment or a saved card). A completed
   * subscription Checkout counts through its subscription, so a refused trial (its subscription canceled) is not one.
   */
  checkoutSessionId: string | null
}

/** A first recharge added to the trial's first invoice while it is a draft (docs/billing.md §3.2 step 9). */
export type InvoiceItemInput = {
  customerId: string
  invoiceId: string
  amountCents: number
  description: string
  /** The `billing_recharges.id`: the idempotency key and the item's `metadata.billing_recharge_id`. */
  rechargeId: string
  /** The item's tax code; whether tax is computed is the subscription's own `automatic_tax` (set by its Checkout). */
  taxCode: string
}

/** A webhook event whose signature was checked (or one listed from the API by the nightly reconciliation), cut to what
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
  /**
   * Our own ids the object carries, when it has them: `metadata.billing_account_id` (a customer, a Checkout Session,
   * a subscription and its invoices, a top-up's payment) or `client_reference_id` (a Checkout Session), and
   * `metadata.billing_recharge_id` (a recharge invoice). Never acted on: they only tell, without a request to Stripe,
   * that an event of a customer this install does not know yet may still be its own (stripe-events.ts `eventOwner`).
   */
  billHint?: string | null
  rechargeHint?: string | null
  /** The API version the event was rendered in (the webhook endpoint's, or the account's default); null if not sent. */
  apiVersion?: string | null
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
  /**
   * The fixed point the subscription's periods are counted from (Stripe's `billing_cycle_anchor`, ISO): a period
   * start is clamped in short months (an anchor on the 31st starts one on Feb 28), the anchor keeps its day.
   */
  billingCycleAnchor: string | null
  interval: 'month' | 'year' | null
  cancelAtPeriodEnd: boolean
  trialEnd: string | null
  defaultPaymentMethod: string | null
  /** `unitAmountCents`: the item's price per unit before tax (the renewal reminder names it); null when Stripe has none. */
  /** `productId`: the Stripe product of the item's price (`linedesk_workspace`, …); only ours make a Linedesk plan. */
  items: { lookupKey: string | null; quantity: number; unitAmountCents?: number | null; productId?: string | null }[]
}

/**
 * What a disputed or fraud-warned charge paid for, as fetched (docs/billing.md §3.4): the customer, and the invoice
 * (a recharge or a plan invoice) or the Checkout session (a top-up) the charge belongs to, found through its payment
 * intent. Ids only: billing finds the bill and the credit through ids it stored.
 */
export type BillingChargeSource = {
  chargeId: string
  customerId: string | null
  /**
   * Both are looked up: a top-up's Checkout session creates an invoice too (`invoice_creation`), paid by the same
   * payment intent, so the charge has an invoice and a session (security review of #920, M5).
   */
  invoiceId: string | null
  checkoutSessionId: string | null
  /** The charge's amount (with tax), in cents; a partial dispute takes off its share of the credit. */
  chargeAmountCents: number
  /** The charge is refunded in full. */
  refunded: boolean
}

/** A card dispute as it is now. `status`: Stripe's (`warning_needs_response`, `needs_response`, `under_review`, `won`, `lost`, …). */
export type BillingDispute = BillingChargeSource & { id: string; status: string; amountCents: number; currency: string }

/** A Radar early fraud warning: the card issuer reported the charge as fraud; a dispute may follow. */
export type BillingFraudWarning = BillingChargeSource & { id: string }

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

/**
 * Stripe's refusal when Checkout asks for terms consent (`consent_collection.terms_of_service`) but the account has no
 * terms of service URL in its public details (Dashboard › Settings › Public details; the API cannot set it). A9.
 */
export const STRIPE_TERMS_URL_MISSING = 'stripe_terms_url_missing'

/**
 * Why a webhook delivery was refused. `signature`: not from Stripe (or changed, or too old). `livemode` comes with a
 * valid signature: Stripe sent it, but the endpoint is of the other mode than the key. An event in another API version
 * than the adapter's is not refused (docs/billing.md §5.1): processing reads only fields every version has, and
 * fetches each object again at the pinned version.
 */
export type WebhookRefusal = 'signature' | 'livemode'

export class WebhookRefused extends Error {
  readonly reason: WebhookRefusal
  constructor(reason: WebhookRefusal) {
    super(reason === 'signature' ? 'webhook signature does not match' : 'webhook event is of the other mode')
    this.reason = reason
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

/** The metadata that marks the customer portal configuration the bootstrap makes (docs/billing.md §2.4). */
export const PORTAL_METADATA = { linedesk: 'portal' } as const

/**
 * The customer portal as the design has it (docs/billing.md §2.4): invoices, cards and the customer's details; no plan
 * changes and no cancel (those happen in the app only). `headline`: the install's name at the top of the portal (the
 * rest of the portal's look is the Stripe account's branding, the same for every install on that account).
 */
export type PortalDesign = {
  headline: string | null
  termsUrl: string | null
  privacyUrl: string | null
}

/** What `syncPortal` did: made, changed or found as designed. */
export type PortalSync = { configuration: string; changed: boolean }

/** The name of the card-only payment method configuration the bootstrap makes and Checkout uses (docs/billing.md §2.4). */
export const CHECKOUT_PMC_NAME = 'Linedesk Checkout'

/**
 * Why a paid invoice's payment may not be refunded from the balance (docs/billing.md §4.5, M4): a dispute that is open
 * or lost (a refund would pay the money out twice), an early fraud warning (the instance admin refunds that charge
 * itself, PR 11), or no card payment at all (paid out of band or from a credit balance).
 */
export type RefundBlocker = 'dispute' | 'early_fraud_warning' | 'no_charge'

/** A refund of part of a paid invoice's line (a recharge or a top-up): a credit note that refunds the card. */
export type InvoiceRefundInput = {
  invoiceId: string
  /** The line refunded (the recharge's or top-up's invoice item). */
  lineId: string
  /** Pre-tax, in cents: what leaves the balance. The tax on it is refunded with it (the credit note computes it). */
  amountCents: number
  /** The Stripe idempotency key: the same request never refunds twice. */
  idempotencyKey: string
  /** The credit note's memo (the customer sees it). */
  memo: string
}

/** What a refund came to: the credit note, the card refund it made, and what went back to the card (tax included). */
export type InvoiceRefund = { creditNoteId: string; refundId: string | null; refundedCents: number }

/**
 * The seat quantity of a subscription (docs/billing.md §2.1): `always_invoice` on a yearly bill that grows (paid now),
 * `create_prorations` on a monthly one, `none` when it shrinks (no refund for the rest of the period).
 */
export type SeatQuantityInput = {
  subscriptionId: string
  quantity: number
  prorationBehavior: 'always_invoice' | 'create_prorations' | 'none'
  idempotencyKey: string
  /**
   * The seat price to add when the subscription has no seat item yet (a partner bill starts with its base fee alone,
   * since Checkout takes no item of quantity 0): with it, a missing seat item is added with `quantity`.
   */
  seatPrice?: string
}

/**
 * The extra-calls item of a subscription (LIN-450): `quantity` extra calls at once over the bill's workspaces, at
 * `priceId` (the synced `extra_calls_monthly` or `extra_calls_yearly`, matching the plan's interval). An item already
 * there keeps its price, and stays at quantity 0 instead of being removed (a raise later is prorated against it).
 *
 * Money (security review of #1103, M-1, L-1): shrinking is never refunded (`none`). Growing up to `paidUpTo` (what the
 * bill already paid for this period) is not charged again (`none`); growing above it is invoiced and paid at once
 * (`always_invoice`, `error_if_incomplete`), so the quantity changes only once the card paid. A refused card answers
 * `payment_failed` and leaves the item as it was. `charge: false` never charges (a lowering, a move's source).
 */
export type ExtraCallsQuantityInput = {
  subscriptionId: string
  priceId: string
  quantity: number
  paidUpTo: number
  charge: boolean
  idempotencyKey: string
}
export type ExtraCallsAnswer = 'updated' | 'unchanged' | 'payment_failed'

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
  /**
   * The card the next recharge charges (see `RechargeCard`); null when there is none and a recharge would fail. The
   * nightly reconciliation checks this, and a new card after a failed recharge is told from it.
   */
  rechargeCard(customerId: string, subscriptionId: string | null): Promise<RechargeCard | null>
  /**
   * The id of the payment method configuration "Linedesk Checkout" (card only: no wallets, no Link; decision 7), made
   * by the bootstrap script and found by its name, never written into the code. Every Checkout Session passes it as
   * `payment_method_configuration` (and no `payment_method_types`); null when the bootstrap has not run. Reads every
   * page of configurations. A key that may not read them (a restricted key without the permission) throws
   * `BillingSetupError`: the admins' problem, not the owner's (security review of #876, I2).
   */
  checkoutPaymentMethodConfiguration(): Promise<string | null>
  /** The customer of a bill, made once (the bill id is the idempotency key and `metadata.billing_account_id`). */
  createCustomer(input: { billId: string; email: string; name: string }): Promise<string>
  /** Starts a Checkout Session (see `CheckoutInput`). A refusal for our setup throws `BillingSetupError`. */
  startCheckout(input: CheckoutInput): Promise<CheckoutStarted>
  /**
   * Makes the account sell what the catalog says (products named, plan prices at their amounts; docs/billing.md §7b)
   * and answers the plan price ids by lookup key. Run when an instance admin saves prices or the product name, never
   * on a customer's Checkout. A key that may not write Products or Prices, or a lookup key held by another product,
   * throws `BillingSetupError`.
   */
  syncCatalog(catalog: PlanCatalog): Promise<Record<string, string>>
  /**
   * Whether the key may write Products and Prices, which the catalog sync needs (the provider test; nothing is
   * written). `null`: not known (no answer).
   */
  catalogWriteAccess(): Promise<{ products: boolean | null; prices: boolean | null }>
  /**
   * Whether the key may write the customer portal configuration, which `syncPortal` needs (the provider test; nothing
   * is written). `null`: not known.
   */
  portalWriteAccess(): Promise<boolean | null>
  /**
   * Whether the Stripe account has a Terms of Service URL, which a plan's Checkout needs for its terms checkbox
   * (Dashboard › Settings › Public details; the API cannot set it). Asked by making a setup-mode Checkout Session with
   * the terms checkbox and expiring it at once (nothing is charged or saved). `null`: not known (another refusal).
   * `successUrl`: the install's own address (the session needs one; nobody can reach it, it is expired at once).
   */
  checkoutTermsReady(successUrl: string): Promise<boolean | null>
  /**
   * Stripe Tax on the account (`TaxSetup`): its settings and active registrations, read only. `null`: not known (a key
   * without the permission, no answer). The provider test warns from it; account settings are never written here.
   */
  taxSetup(): Promise<TaxSetup | null>
  /**
   * Whether Stripe Tax can tax this customer: false only when Stripe says it does not know where the customer is
   * (`tax.automatic_tax = unrecognized_location`, no billing address). A recharge for such a customer is charged without
   * tax instead of failing (security review of #1105, M-1).
   */
  customerTaxReady(customerId: string): Promise<boolean>
  /** How many of these customers Stripe Tax cannot tax (see `customerTaxReady`), for the admin before turning tax on. */
  customersWithoutTaxAddress(customerIds: string[]): Promise<number>
  /** Sets automatic tax on one running subscription to the install's switch (idempotent; see `SubscriptionTaxSync`). */
  syncSubscriptionTax(subscriptionId: string, enabled: boolean): Promise<SubscriptionTaxSync>
  /**
   * Makes the customer portal configuration (`PORTAL_METADATA`) match the design (`PortalDesign`): made when missing,
   * its features and links set when they differ (a cancel switched on in the Dashboard is switched off again). Run
   * with the catalog sync (Server admin › Billing saves, billing turned on). A key without the permission throws
   * `BillingSetupError`.
   */
  syncPortal(design: PortalDesign): Promise<PortalSync>
  /** The session as it is now, with its subscription, card and charge; null when the service does not know it. */
  checkoutSession(id: string): Promise<CheckoutSession | null>
  /**
   * Expires every open Checkout Session of the customer, so none of them can be completed any more (a new Checkout
   * replaces it; the sign-up sweep before it deletes a bill). A session completed meanwhile is left as it is. Answers
   * how many were expired.
   */
  expireOpenCheckouts(customerId: string): Promise<number>
  /**
   * What the customer bought at the service, as the service has it now (not our database): its first subscription
   * that still runs (any status but `canceled` and `incomplete_expired`) and its first completed Checkout Session
   * outside a subscription; null for each when there is none. Any error throws (a 401, 403 or 404 as
   * `BillingSetupError`): an unknown customer is no answer either. The sign-up sweep asks this
   * before it deletes a bill, so a Checkout whose webhook is late is never undone (security verification of #961, V-1).
   */
  customerPurchases(customerId: string): Promise<CustomerPurchases>
  /** Deletes the customer (which cancels its subscriptions at once); a customer the service does not know is fine. */
  deleteCustomer(customerId: string): Promise<void>
  /**
   * Ends a subscription. `now`: at once, nothing charged or prorated (a trial refused at Checkout); else at the trial
   * or period end (`billing.cancel`). Idempotent.
   */
  cancelSubscription(id: string, options: { now: boolean }): Promise<BillingSubscription | null>
  /** Undoes a cancel at the period end, while the subscription still runs (`billing.resume`). */
  resumeSubscription(id: string): Promise<BillingSubscription | null>
  /** Adds the first recharge to a draft invoice (the trial's conversion invoice), once per recharge id. */
  addInvoiceItem(input: InvoiceItemInput): Promise<void>
  /** The invoice a recharge made, found by its metadata (for a retry after the idempotency keys expired); null: none. */
  findRechargeInvoice(rechargeId: string): Promise<string | null>
  /**
   * A failed recharge is never charged later behind the owner's back (docs/billing.md §3.4): automatic collection
   * off, so the payment service's retries skip it, and with `void` the invoice is voided too. `paid`: the invoice was
   * paid already (the payment service's own collection got there first), so nothing was stopped and the caller credits
   * it instead of giving the attempt up (security review of #1110, V-1); `stopped` otherwise.
   */
  stopRechargeInvoice(invoiceId: string, options: { void: boolean }): Promise<RechargeInvoiceStop>
  /** The invoice's own page, where the customer pays it or confirms the payment (a bearer link: never stored). */
  rechargeInvoicePage(invoiceId: string): Promise<string | null>
  /**
   * A customer portal session (docs/billing.md §2.4): the card, the billing details, invoices and receipts. Always the
   * portal configuration the bootstrap or the catalog sync made (found by its metadata, never an id in the code);
   * without it no session starts and `BillingSetupError('portal_configuration_missing')` is thrown. A configuration
   * that offers cancel or plan changes (switched on in the Dashboard) is switched back first; a key that may not do
   * that gets no session (`BillingSetupError('portal_allows_cancel')`). The URL is a bearer link: never stored.
   */
  portalSession(input: { customerId: string; returnUrl: string }): Promise<string>
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
  /** What stops a refund of this paid invoice's payment; empty: none (Server admin › Billing, `billing.refund`). */
  refundBlockers(invoiceId: string): Promise<RefundBlocker[]>
  /** Refunds part of a paid invoice's line to the card, with a credit note (keeps the tax right). */
  refundInvoice(input: InvoiceRefundInput): Promise<InvoiceRefund>
  /**
   * The refund `refundInvoice` made on this invoice with this idempotency key (the credit note's `metadata.linedesk_refund`),
   * or null when there is none: how a refund whose ledger entry was not posted is settled later (review of #919, M2).
   */
  findRefund(invoiceId: string, idempotencyKey: string): Promise<InvoiceRefund | null>
  /** The invoice a paid Checkout session made ("Buy minutes": `invoice_creation`), or null. */
  checkoutInvoice(sessionId: string): Promise<string | null>
  /** Sets the seat item's quantity; `no_seat_item` when the subscription has none (a seat price is `ws_…`). */
  setSeatQuantity(input: SeatQuantityInput): Promise<'updated' | 'unchanged' | 'no_seat_item'>
  /** Sets the extra-calls item's quantity (see `ExtraCallsQuantityInput`): adds it, changes it, or removes it at 0. */
  setExtraCallsQuantity(input: ExtraCallsQuantityInput): Promise<ExtraCallsAnswer>
  /** The dispute as it is now, with what its charge paid for; null when the service does not know it. */
  dispute(id: string): Promise<BillingDispute | null>
  /** The early fraud warning as it is now, with what its charge paid for; null when the service does not know it. */
  earlyFraudWarning(id: string): Promise<BillingFraudWarning | null>
  /** The charge as it is now, with what it paid for (`charge.refunded`); null when the service does not know it. */
  charge(id: string): Promise<BillingChargeSource | null>
}

/** The keys of the `stripe` adapter, as stored under Server admin › Providers › Billing. */
export type StripeKeys = {
  secretKey: string
  webhookSecret: string
  /** The signing secret before a rotation, accepted beside the new one until it is removed. */
  webhookSecretPrevious?: string | null
}
