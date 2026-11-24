// Server admin › Billing: the bills of this install, their ledger and payments, the
// Stripe event inbox, the review holds, the install's billing rules and whether anyone may sign up. Instance admins
// only. Every write that moves money or changes what a bill may spend also needs the admin signed in as themselves
// with their passkey (no setup link, API key, personal key or impersonation), carries a reason for the audit log, and the ones that
// ask Stripe carry a request id, the idempotency key of every Stripe request it makes.
import type { BillingRules, SignupRules } from '@linedesk/db/types'
import type { BillingEnabledData } from './billing.ts'
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import { defineAction } from './define.ts'

const billId = z.string().min(1).max(100)
/** Why the admin did it: kept in the audit log with the action (the command log's input). */
const reason = z.string().trim().min(3).max(500)
/** Made by the page once per dialog: the same request sent twice moves money once (Stripe's idempotency key). */
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, msg('server.input.billing.requestId'))
/** Money in whole cents, at most $100,000 per action. */
const cents = z.number().int().min(1).max(10_000_000)

// ---- Reads ----

export const billingAdminBills = defineAction({
  name: 'billing.adminBills',
  description: 'Every bill on this install: kind, status, owner, balance and its workspaces. Instance admins only.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingAdminBill = defineAction({
  name: 'billing.adminBill',
  description:
    'One bill with its balance, ledger entries, recharge attempts, invoices, workspaces and what can be refunded. Instance admins only.',
  input: z.object({ billingAccountId: billId }),
  permission: 'instance:admin',
  readOnly: true,
})

export const BILLING_EVENT_FILTERS = ['all', 'waiting', 'failed', 'unhandled'] as const
export type BillingEventFilter = (typeof BILLING_EVENT_FILTERS)[number]

export const billingAdminEvents = defineAction({
  name: 'billing.adminEvents',
  description:
    'The Stripe webhook inbox, newest first: each event with its status (processed, waiting, failed, not handled yet). Instance admins only.',
  input: z.object({
    filter: z.enum(BILLING_EVENT_FILTERS).optional(),
    /** The `next` of the previous page: events received before it. */
    before: z.iso.datetime({ offset: true }).optional(),
  }),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingAdminSummary = defineAction({
  name: 'billing.adminSummary',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Server admin › Billing at a glance, in one read: whether billing through Stripe is on and in which mode, whether self-serve sign-up is open (and why not), how many bills are in each status or held for review, how many trials started in the last 7 days, the Stripe events that wait, failed or are not handled, and whether Stripe Tax is on. Instance admins only.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingAdminReview = defineAction({
  name: 'billing.adminReview',
  description:
    'Bills held for review (Radar risk, number purchase) and trials started in the last 7 days. Instance admins only.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingRulesGet = defineAction({
  name: 'billingRules.get',
  description:
    "The install's billing rules: prices per minute, included minutes, buffer, concurrency and caps, over the defaults.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingAdminCustomer = defineAction({
  name: 'billing.adminCustomer',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The name and email of a bill's Stripe customer, asked of Stripe now. Null when the bill has no customer, billing through Stripe is off or Stripe did not answer. Instance admins only.",
  input: z.object({ billingAccountId: billId }),
  permission: 'instance:admin',
  readOnly: true,
})

export const billingAdminTaxAddressMissing = defineAction({
  name: 'billing.adminTaxAddressMissing',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "How many paying customers have no billing address Stripe Tax can use: asked of Stripe for this install's customers only, kept for 5 minutes. Null when billing is off or Stripe did not answer.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const signupGetSelfServe = defineAction({
  name: 'signup.getSelfServe',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Whether anyone may sign up and start a trial on their own, whether sign-up is actually open now (and why not), and the sign-up limits (`signup.rules`) over the defaults.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

// ---- Writes ----

export const BILLING_CREDIT_KINDS = ['credit', 'writeoff', 'adjustment'] as const

export const billingCredit = defineAction({
  name: 'billing.credit',
  description:
    "A ledger entry by hand on a bill's balance: `credit` (goodwill, adds), `writeoff` (forgives a negative balance, at most what is below zero), `adjustment` (either way, optionally correcting one entry). With `rechargeId`, credits that recharge attempt under its own key and marks it paid, so the automatic credit never adds it again.",
  input: z
    .object({
      billingAccountId: billId,
      kind: z.enum(BILLING_CREDIT_KINDS),
      /** Cents; negative only for an adjustment. */
      amountCents: z.number().int().min(-10_000_000).max(10_000_000),
      reason,
      requestId,
      rechargeId: z.string().min(1).max(100).optional(),
      reversesEntryId: z.string().min(1).max(100).optional(),
    })
    .refine(i => i.amountCents !== 0, { message: msg('server.input.billing.amountNotZero'), path: ['amountCents'] })
    .refine(i => i.kind === 'adjustment' || i.amountCents > 0, {
      message: msg('server.input.billing.creditAdds'),
      path: ['amountCents'],
    })
    .refine(i => !i.reversesEntryId || i.kind === 'adjustment', {
      message: msg('server.input.billing.onlyAdjustmentCorrects'),
      path: ['reversesEntryId'],
    })
    .refine(i => !i.rechargeId || i.kind === 'credit', {
      message: msg('server.input.billing.rechargeIsCredit'),
      path: ['rechargeId'],
    }),
  permission: 'instance:admin',
})

export const BILLING_ADMIN_STATUSES = ['comped', 'suspended', 'active'] as const

export const billingAdminSetStatus = defineAction({
  name: 'billing.adminSetStatus',
  description:
    "Comp a bill (its calls cost nothing), suspend it (new calls get the fixed line; a payment does not lift it), or make it active again. The bill's workspaces follow.",
  input: z.object({ billingAccountId: billId, status: z.enum(BILLING_ADMIN_STATUSES), reason }),
  permission: 'instance:admin',
})

export const billingRefund = defineAction({
  name: 'billing.refund',
  description:
    'Refund unused balance to the card: at most the available balance, from the newest payment that still has something to refund, never a payment with an open or lost dispute or an early fraud warning. A credit note refunds the card (tax included) and a refund entry takes the amount off the balance.',
  input: z.object({ billingAccountId: billId, amountCents: cents, reason, requestId }),
  permission: 'instance:admin',
})

export const billingSetCap = defineAction({
  name: 'billing.setCap',
  description:
    "Set a bill's monthly recharge cap base (the cap in effect adds the per-workspace part); an instance admin may set it above the owner's $1,000.",
  input: z.object({ billingAccountId: billId, capBaseCents: z.number().int().min(0).max(10_000_000), reason }),
  permission: 'instance:admin',
})

export const billingSetConcurrency = defineAction({
  name: 'billing.setConcurrency',
  description: "Set how many calls a bill may have running at once; null goes back to the install's rules.",
  input: z.object({ billingAccountId: billId, concurrentCalls: z.number().int().min(1).max(1000).nullable(), reason }),
  permission: 'instance:admin',
})

export const billingMoveWorkspace = defineAction({
  name: 'billing.moveWorkspace',
  description:
    'Move a workspace to another bill: refused while it has calls running. The seat quantities of both subscriptions follow in Stripe.',
  input: z.object({ workspaceId: z.string().min(1).max(100), toBillingAccountId: billId, reason, requestId }),
  permission: 'instance:admin',
})

export const billingTransferOwner = defineAction({
  name: 'billing.transferOwner',
  description: "Give a bill to another owner: a member of one of the bill's workspaces.",
  input: z.object({ billingAccountId: billId, userId: z.string().min(1).max(100), reason }),
  permission: 'instance:admin',
})

export const billingReviewHold = defineAction({
  name: 'billing.reviewHold',
  description:
    'Decide a bill held for review: approve lifts the hold (number purchase, client workspaces); deny suspends the bill.',
  input: z.object({ billingAccountId: billId, decision: z.enum(['approve', 'deny']), reason }),
  permission: 'instance:admin',
})

export const billingRulesSet = defineAction({
  name: 'billingRules.set',
  description:
    "Set the install's billing rules. Every field is checked; anything out of range refuses the whole change. Merged over the stored rules: a field left out keeps its value, a field set to null goes back to its default (a level too, inside levels). Plan prices have a floor (the server's BILLING_MIN_PLAN_CENTS, else the included minutes at the Standard price; yearly 12 times it) and a yearly price is at most 12 monthly ones. Every instance admin is emailed.",
  input: z.object({ rules: z.record(z.string(), z.unknown()), reason }),
  permission: 'instance:admin',
})

export const signupSetSelfServe = defineAction({
  name: 'signup.setSelfServe',
  description:
    'Let anyone sign up and start a trial on their own (off by default). Works only while billing through Stripe is in effect.',
  input: z.object({ on: z.boolean(), reason }),
  permission: 'instance:admin',
})

export const signupSetRules = defineAction({
  name: 'signup.setRules',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Set the install's sign-up limits (`signup.rules`): codes per address and IP, the install's hourly cap, days a sign-up may wait for Checkout, the Turnstile check, blocked domains, trial workspaces and numbers, and the Radar risk levels that hold a bill for review. Every field is checked; anything out of range refuses the whole change. Merged over the stored rules: a field left out keeps its value, null resets it to its default. Every instance admin is emailed.",
  input: z.object({ rules: z.record(z.string(), z.unknown()), reason }),
  permission: 'instance:admin',
})

// ---- What the reads answer (`data`) ----

export type AdminBillStatus =
  | 'pending_payment'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'canceled'
  | 'comped'

export type AdminBillRow = {
  id: string
  kind: 'cloud' | 'partner'
  status: AdminBillStatus
  interval: 'month' | 'year'
  owner: { id: string; email: string | null; name: string | null }
  /**
   * `extraCalls`: the extra calls at the same time the bill owner bought for the workspace (LIN-450); `busyCallers`: the
   * callers who heard a busy line there in the last 30 days.
   */
  workspaces: { id: string; name: string; extraCalls: number; busyCallers: number }[]
  balanceMicros: number
  reservedMicros: number
  heldForReviewAt: string | null
  /** Stripe Radar's risk level of the trial's card check (`normal`, `elevated`, `highest`, …); null before the check. */
  cardRiskLevel: string | null
  createdAt: string
}

export type AdminLedgerEntry = {
  id: string
  createdAt: string
  kind: 'usage' | 'number' | 'recharge' | 'topup' | 'refund' | 'credit' | 'adjustment' | 'writeoff'
  /** What it moved: the money, never seconds (a comped call records billable seconds at $0). */
  amountMicros: number
  workspaceId: string | null
  seconds: number | null
  priceBasis: string | null
  sourceType: string
  sourceId: string
  actor: { id: string; email: string | null } | null
  note: string | null
}

/** A payment that put money on the balance, with what is left to refund of it (newest first). */
export type AdminRefundable = {
  entryId: string
  kind: 'recharge' | 'topup'
  createdAt: string
  creditedMicros: number
  refundedMicros: number
  invoiceId: string | null
}

export type AdminBillDetail = AdminBillRow & {
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  /** The Stripe Dashboard's base for this install's mode (`https://dashboard.stripe.com/test`), null without Stripe. */
  dashboardUrl: string | null
  trialEndsAt: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  autoRecharge: boolean
  rechargeThresholdCents: number
  rechargeAmountCents: number
  rechargeCapBaseCents: number
  rechargeCapCents: number
  concurrentCallsCap: number | null
  /** The cap the rules give without an override: the included calls of every workspace plus the extra calls bought. */
  rulesConcurrentCalls: number
  suspendReason: string | null
  rechargeFailedAt: string | null
  /** This period's usage per workspace: paid is the sum of `amount_micros`, never of billable seconds. */
  usage: { workspaceId: string; workspaceName: string | null; seconds: number; paidMicros: number }[]
  ledger: AdminLedgerEntry[]
  recharges: {
    id: string
    amountCents: number
    status: 'pending' | 'paid' | 'failed' | 'canceled'
    invoiceId: string | null
    failureCode: string | null
    createdAt: string
    resolvedAt: string | null
  }[]
  invoices: {
    invoiceId: string
    kind: 'subscription' | 'recharge' | 'topup'
    number: string | null
    status: string
    totalCents: number
    taxCents: number
    createdAt: string
  }[]
  refundable: AdminRefundable[]
  /** Members of the bill's workspaces: whom the bill can be given to. */
  members: { id: string; email: string; name: string }[]
  /** Every other bill, to move a workspace to. */
  otherBills: { id: string; owner: string | null; kind: 'cloud' | 'partner'; status: AdminBillStatus }[]
}

export type AdminStripeEvent = {
  id: string
  type: string
  livemode: boolean
  created: string
  receivedAt: string
  processedAt: string | null
  attempts: number
  lastError: string | null
  state: 'processed' | 'waiting' | 'failed' | 'unhandled'
  objectId: string | null
  billId: string | null
}

export type AdminReviewRow = {
  billId: string
  kind: 'cloud' | 'partner'
  status: AdminBillStatus
  owner: { email: string | null; name: string | null }
  workspaces: number
  createdAt: string
  heldForReviewAt: string | null
  /** Stripe Radar's risk level of the trial's card check; null before the check. */
  cardRiskLevel: string | null
}

/** billing.adminSummary: the facts the top of Server admin › Billing shows, counted on the server. */
export type AdminBillingSummary = {
  billing: BillingEnabledData
  selfServe: Pick<SelfServeData, 'on' | 'open' | 'closedBecause' | 'termsMissing'>
  /** Bills per status (every status, 0 when none). */
  bills: Record<AdminBillStatus, number>
  /** Bills held for review. */
  held: number
  /** Trials (or sign-ups waiting for Checkout) started in the last 7 days and not held: the review list's second part. */
  newTrials: number
  /** The Stripe events not processed, by state (as `billing.adminEvents` filters them). */
  events: { waiting: number; failed: number; unhandled: number }
  automaticTax: boolean
}

export type BillingRulesData = {
  /** What is stored in `billing.rules` (null: nothing, the defaults apply). */
  stored: Record<string, unknown> | null
  /** The rules in effect: the stored fields over the defaults. */
  effective: BillingRules
  defaults: BillingRules
  /** Stored fields that are ignored (out of range): they keep their default. */
  problems: string[]
  /** The lowest price per minute this server allows for a level (BILLING_MIN_MICROS_PER_MINUTE); 0 without one. */
  minMicrosPerMinute: number
  /** The lowest monthly plan fee for the rules in effect (BILLING_MIN_PLAN_CENTS); a yearly fee is at least 12 times it. */
  minPlanCents: number
}

/**
 * billing.adminTaxAddressMissing: how many paying customers have no address Stripe can tax, shown before the admin
 * turns Stripe Tax on (their recharges are then charged without tax until they add one). Null: not known (billing off,
 * Stripe not answering).
 */
export type TaxAddressMissingData = { taxAddressMissing: number | null }

/** billing.adminCustomer: the bill's Stripe customer as Stripe has it now; null: not known (no customer, billing off, no answer). */
export type AdminBillCustomer = { customer: { name: string | null; email: string | null } | null }

/** billingRules.set's refusal code when a plan fee is below the floor or a yearly fee above 12 monthly ones. */
export const PLAN_PRICE_FLOOR = 'plan_price_floor'

/** Stripe Radar's risk levels of a card check (Charge.outcome.risk_level). */
export const RADAR_RISK_LEVELS = ['normal', 'elevated', 'highest', 'not_assessed', 'unknown'] as const
export type RadarRiskLevel = (typeof RADAR_RISK_LEVELS)[number]

/** Why sign-up is closed while it is switched on, or off (null: open). */
export type SignupClosedBecause = 'switched_off' | 'billing_not_in_effect' | 'terms_missing' | 'bot_check_missing'

export type SelfServeData = {
  /** The switch (`signup.selfServe`). */
  on: boolean
  billingInEffect: boolean
  /** Whether a new person can sign up right now: the switch is on and nothing it needs is missing. */
  open: boolean
  closedBecause: SignupClosedBecause | null
  /** Whether the Turnstile keys are set up (Server admin › Billing › Sign-up). */
  turnstileReady: boolean
  /** The sign-up limits in effect: the stored `signup.rules` over the defaults. */
  rules: SignupRules
  defaults: SignupRules
  /** Stored fields that are ignored (out of range or unknown): they keep their default. */
  problems: string[]
  /**
   * The environment variables still unset (TERMS_URL, TERMS_VERSION, PRIVACY_URL, PRIVACY_VERSION, A9); sign-up stays
   * closed (`terms_missing`), even when switched on, until they are set.
   */
  termsMissing: string[]
}
