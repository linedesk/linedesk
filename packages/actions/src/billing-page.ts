// Settings › Billing (docs/billing.md §8, §11 PR 9): what the bill owner reads and changes about their bill in the app.
// Cancel, resume and "Buy minutes" are billing-checkout.ts; the status and its dates are `billing.state`. Only the owner
// of the bill (the handlers check it is the bill's owner, not only the workspace's), signed in to the app: never an API
// key, a personal key, a setup link or an impersonation, for the overview (its invoice links) as for the writes.
import { RECHARGE_CAP_SELF_SERVE_MAX_CENTS, RECHARGE_LIMITS } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

/** Recharge attempts a bill may have in 24 hours when the owner presses Retry (docs/billing.md §3.4). */
export const RECHARGE_RETRIES_PER_DAY = 3

export const billingOverview = defineAction({
  name: 'billing.overview',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The workspace's bill as its owner sees it under Settings › Billing: the plan, the balance, auto-recharge and the monthly cap, this period's usage per workspace and level, a failed recharge, and the latest invoices. Only the bill owner, signed in to the app as themselves (never an impersonation, an API key, a personal key or a setup link); `bill` is null for anyone else and while billing is off.",
  input: z.object({}),
  permission: 'billing:manage',
  readOnly: true,
})

/** One usage level's part of a workspace's period: billed seconds and what they cost (micro-dollars, positive). */
export type BillingUsageLevel = { seconds: number; micros: number }
/** A workspace on the bill and its usage in the current period. `name` null: the workspace was deleted. */
export type BillingUsageRow = {
  workspaceId: string
  name: string | null
  /** The included allowance used, in Standard seconds, and the allowance per workspace and period. */
  allowanceUsedSeconds: number
  allowanceSeconds: number
  levels: Partial<Record<'standard' | 'premium' | 'ultra' | 'own_keys', BillingUsageLevel>>
}
/**
 * An invoice of the bill (plan fees and recharges), with Stripe's own page for it (it has the PDF). The link is a
 * bearer link: never answered to an impersonation, an API key, a personal key or a setup link.
 */
export type BillingInvoiceRow = {
  id: string
  kind: 'subscription' | 'recharge' | 'topup'
  number: string | null
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
  totalCents: number
  createdAt: string
  url: string | null
}
/** `data` of `billing.overview`. `billingOn`: billing through Stripe is in effect on this server. */
export type BillingOverviewData = { billingOn: boolean; bill: BillingOverviewBill | null }
export type BillingOverviewBill = {
  status: 'pending_payment' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'comped'
  interval: 'month' | 'year'
  /** The plan's price per workspace and interval, before tax. */
  seatCents: number
  workspaces: number
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  /** The balance (it can be below zero) and what is free of running calls' reservations, in micro-dollars. */
  balanceMicros: number
  availableMicros: number
  autoRecharge: { on: boolean; thresholdCents: number; amountCents: number }
  /** The monthly recharge cap: its base, the cap in effect, what recharges used this month, the most the owner sets. */
  cap: { baseCents: number; effectiveCents: number; usedThisMonthCents: number; ownerMaxBaseCents: number }
  /**
   * The last automatic recharge failed: when, Stripe's code, and whether the owner has to confirm the payment on the
   * invoice's page (3D Secure) instead of trying the card again. `retriesLeft`: Retry presses left in 24 hours.
   */
  rechargeFailure: { at: string; code: string | null; needsAction: boolean; retriesLeft: number } | null
  /**
   * A recharge charged to the card and not paid yet (its amount, before tax): the balance goes up once it is paid.
   * Null when none is pending.
   */
  rechargePending: { amountCents: number } | null
  /**
   * The bill is held for review (Radar flagged the card): no number can be bought until an instance admin approves
   * it (docs/billing.md §3.2 step 5).
   */
  heldForReview: boolean
  /** The monthly price of each extra number (paid from the balance), the install's rules; 0 on a comped bill. */
  extraNumberCents: number
  /** Buy minutes and the Stripe portal are open (a Stripe customer, in the trial or paid). */
  canBuyMinutes: boolean
  hasPortal: boolean
  period: { startsAt: string; endsAt: string; kind: 'trial' | 'month' } | null
  usage: BillingUsageRow[]
  invoices: BillingInvoiceRow[]
}

export const billingWorkspaceUsage = defineAction({
  name: 'billing.workspaceUsage',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "This workspace's call usage in the bill's current period, read-only, for the workspace's owners and admins (docs/billing.md §8: workspace admins see usage only): the included minutes used and the paid minutes per level with their cost. Never other workspaces of the bill, the balance, the plan or invoices. `usage` is null while billing is off or the workspace is not on a bill.",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})
/** `data` of `billing.workspaceUsage`. */
export type BillingWorkspaceUsageData = {
  usage: {
    period: { startsAt: string; endsAt: string; kind: 'trial' | 'month' } | null
    row: BillingUsageRow | null
  } | null
}

/** Auto-recharge as the owner sets it (docs/billing.md §2.2, §4.3): the amount lifts the balance clear of the threshold. */
const autoRechargeInput = z
  .object({
    on: z.boolean(),
    thresholdCents: z.number().int().min(RECHARGE_LIMITS.thresholdCents.min).max(RECHARGE_LIMITS.thresholdCents.max),
    amountCents: z.number().int().min(RECHARGE_LIMITS.amountCents.min).max(RECHARGE_LIMITS.amountCents.max),
  })
  .refine(v => v.amountCents >= v.thresholdCents + 500, {
    message: 'the amount must be at least $5 more than the threshold',
    path: ['amountCents'],
  })

export const billingSetAutoRecharge = defineAction({
  name: 'billing.setAutoRecharge',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Turn auto-recharge on or off and set when it charges the saved card (the balance falls below the threshold, $5 to $100) and how much ($20 to $500, at least $5 above the threshold). Only the bill owner.',
  input: autoRechargeInput,
  permission: 'billing:manage',
})
/** `data` of `billing.setAutoRecharge`: what is stored now, and whether a recharge was started by the change. */
export type AutoRechargeData = { on: boolean; thresholdCents: number; amountCents: number; recharging: boolean }

export const billingSetRechargeCap = defineAction({
  name: 'billing.setRechargeCap',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Set the base of the bill's monthly recharge cap (each further workspace adds $25). Raising it needs the owner to confirm it is them (a recent sign-in, the passkey when they have one), and the cap in effect stays at most $1,000; above that an instance admin raises it. Only the bill owner.",
  input: z.object({
    baseCents: z.number().int().min(RECHARGE_LIMITS.amountCents.min).max(RECHARGE_CAP_SELF_SERVE_MAX_CENTS),
  }),
  permission: 'billing:manage',
})
/** `data` of `billing.setRechargeCap`. */
export type RechargeCapData = { baseCents: number; effectiveCents: number; recharging: boolean }

export const billingOpenPortal = defineAction({
  name: 'billing.openPortal',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Open the bill's Stripe customer portal: the card, the billing address and tax id, and every invoice and receipt. Answers the portal link, valid for a short time. Only the bill owner.",
  input: z.object({}),
  permission: 'billing:manage',
  // The portal link signs the owner in to their Stripe customer: in the answer only, never in the command log.
  secretResult: ['url'],
})
/** `data` of `billing.openPortal`. */
export type PortalData = { url: string }

export const billingRetryRecharge = defineAction({
  name: 'billing.retryRecharge',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Try a failed automatic recharge again (at most 3 attempts in 24 hours). When the bank wants the payment confirmed, answers the invoice page to confirm it on instead. Only the bill owner.',
  input: z.object({}),
  permission: 'billing:manage',
  secretResult: ['url'],
})
/**
 * `data` of `billing.retryRecharge`. `retrying`: a new attempt is being charged; `confirm`: open `url` to confirm the
 * payment there; `not_needed`: the balance is above the threshold, nothing to charge; `cap_reached`: the monthly cap
 * leaves less than $20.
 */
export type RetryRechargeData = { kind: 'retrying' | 'not_needed' | 'cap_reached' } | { kind: 'confirm'; url: string }
