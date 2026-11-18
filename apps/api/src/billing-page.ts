// Settings › Billing (docs/billing.md §8, §11 PR 9): what the bill owner reads and changes in the app.
//
// - `billing.overview` (read): the plan, the balance, auto-recharge and the cap, this period's usage per workspace and
//   level, a failed recharge and the latest invoices. Only for the bill's owner (the workspace owner is not always the
//   bill owner); anyone else, and every workspace while billing is not in effect, gets `bill: null`. Like the writes,
//   never answered to an impersonation, an API key, a personal key or a setup link (security review of #1007, M-1:
//   the invoices' Stripe links work without a login). Every row is read through the bill's id, never the workspace's
//   alone (tenancy, §8).
// - `billing.setAutoRecharge`, `billing.setRechargeCap` (raising it needs the owner step-up, §8), `billing.openPortal`
//   (the Stripe customer portal: card, details, invoices) and `billing.retryRecharge` (Retry after a failed recharge,
//   at most 3 attempts in 24 hours, §3.4), `billing.setExtraCalls` (extra calls at the same time per workspace,
//   LIN-450; billed as the subscription's extra-calls item). The owner, signed in as themselves in the app (`ownBill` refuses API keys,
//   personal keys, setup links and impersonation), under the bill's lock order (its balance row first).
//
// Refusals carry a `code` the page words itself (BILLING_PAGE_CODES); the English message is for logs and the API.
import type {
  AutoRechargeData,
  BillingCalls,
  BillingInvoiceRow,
  BillingOverviewBill,
  BillingOverviewData,
  BillingUsageRow,
  BillingWorkspaceUsageData,
  ExtraCallsData,
  PortalData,
  RechargeCapData,
  RetryRechargeData,
} from '@linedesk/actions'
import { RECHARGE_RETRIES_PER_DAY } from '@linedesk/actions'
import { BillingSetupError } from '@linedesk/billing'
import {
  billing_accounts,
  billing_balances,
  billing_invoices,
  billing_recharges,
  type ActivationFacts,
  type BillingRules,
  EXTRA_CALLS_STEP,
  ledger_entries,
  maxExtraCalls,
  organization,
  planPrice,
  RECHARGE_CAP_SELF_SERVE_MAX_CENTS,
  RECHARGE_LIMITS,
  rechargeCapCents,
  type Tx,
  usage_counters,
  workspaceCallLimit,
} from '@linedesk/db'
import { msg } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { SIGN_IN_AGAIN } from './account.ts'
import { PASSKEY_STEP_UP_REQUIRED } from './admin-step-up.ts'
import { syncBillingCatalog } from './billing-catalog.ts'
import { managesBill, tellBillOwner } from './bill-manager.ts'
import {
  activationFacts,
  BUYS_MINUTES,
  ownBill,
  setupFailed,
  stillManages,
  trialOffered,
} from './billing-checkout.ts'
import { PARTNER_BILLING_URL, partnerBillOf } from './partner-billing.ts'
import { billingRules } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { busyCallersByWorkspace } from './billing-recharge.ts'
import { afterDebit } from './call-billing.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { localeForUserId } from './email-locale.ts'
import { appLink, WEB_ORIGIN } from './emails/templates.ts'
import { BILLING_PATH } from './emails/billing-lifecycle.ts'
import {
  extraCallsPriceId,
  lockExtraCalls,
  paidAfter,
  paidExtraCalls,
  periodEnded,
  syncExtraCallsItem,
} from './extra-calls.ts'
import { Forbidden, type Handler, type HandlerCtx, type Preparer, Reject } from './handler-context.ts'
import { decideRecharge, periodAt } from './ledger.ts'
import { type LegalTerms, legalTerms, recordAcceptance } from './legal-terms.ts'
import { ownerStepUpNeeded } from './owner-step-up.ts'
import { createRateLimiter } from './rate-limit.ts'
import { refuseBillingActor } from './usage-levels.ts'

type Bill = typeof billing_accounts.$inferSelect
type Reader = Tx | typeof db

/** The codes of this page's refusals (the web app has a text for each). */
export const BILLING_PAGE_CODES = {
  notRunning: 'billing_not_running',
  capAboveOwnerMax: 'billing_cap_above_owner_max',
  noFailure: 'billing_no_failed_recharge',
  retryLimit: 'billing_retry_limit',
  noCustomer: 'billing_no_customer',
  autoRechargeOff: 'billing_auto_recharge_off',
  invoicePageUnavailable: 'billing_invoice_page_unavailable',
  extraCallsPaidPlan: 'billing_extra_calls_paid_plan',
  extraCallsAboveMax: 'billing_extra_calls_above_max',
  notOnBill: 'billing_workspace_not_on_bill',
  extraCallsCanceling: 'billing_extra_calls_canceling',
  extraCallsPaymentFailed: 'billing_extra_calls_payment_failed',
  extraCallsTooOften: 'billing_extra_calls_too_often',
  extraCallsRenewing: 'billing_extra_calls_renewing',
} as const
type BillingPageCode = keyof typeof BILLING_PAGE_CODES

/** A refusal with its code: the web app shows the code's key (settings.billing.error.*). */
// i18n-ignore: API error bodies for logs and API clients; the web app shows the key of the code
const REFUSALS: Record<BillingPageCode, string> = {
  notRunning: 'Auto-recharge and the cap can be changed while the plan runs.',
  capAboveOwnerMax: 'The monthly cap can be at most $1,000. Ask the server admins for more.',
  noFailure: 'No recharge waits for a retry.',
  retryLimit: 'Three recharge attempts were made in the last 24 hours. Try again later or add a new card.',
  noCustomer: 'This bill has no Stripe customer yet.',
  autoRechargeOff: 'Auto-recharge is off. Turn it on to try the card again, or buy minutes.',
  invoicePageUnavailable: 'The invoice page is not available right now. Try again in a few minutes.',
  extraCallsPaidPlan: 'More calls at the same time can be added once the plan is paid (after the trial).',
  extraCallsAboveMax:
    'That is more calls at the same time than a workspace can have here. Ask the server admins for more.',
  notOnBill: 'This workspace is not on your bill.',
  extraCallsCanceling: 'The plan ends at the end of this period: more calls at the same time cannot be added now.',
  extraCallsPaymentFailed: 'The card was refused, so no calls were added. Update the card and try again.',
  extraCallsTooOften: 'Calls at the same time were changed many times in the last hour. Try again later.',
  extraCallsRenewing: 'The plan is renewing right now. Try again in a few minutes.',
}
const refuse = (code: BillingPageCode) => new Reject(REFUSALS[code], BILLING_PAGE_CODES[code])

/** How many invoices the page lists; the portal has them all. */
const INVOICES_SHOWN = 12
const DAY_MS = 86_400_000

/** Statuses in which the owner changes auto-recharge and the cap: a running plan (not suspended, canceled or waiting). */
const CHANGES_RECHARGE: readonly Bill['status'][] = ['trialing', 'active', 'past_due']

/**
 * Whether a failed recharge may be retried or confirmed now (§3.4): while the plan is paid or past due, or suspended
 * only for an unpaid plan. Never on a bill held for a dispute, a fraud warning or by an admin, nor a canceled one
 * (security review of #1007, L-1).
 */
const retriesRecharge = (bill: Pick<Bill, 'status' | 'suspend_reason'>) =>
  bill.status === 'active' ||
  bill.status === 'past_due' ||
  (bill.status === 'suspended' && bill.suspend_reason === 'payment')

const exactMicros = (value: unknown) => {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n)) throw new Error(`billing amount out of range: ${String(value)}`)
  return n
}

/** The first of the current UTC calendar month (the recharge cap's month, ledger.ts). */
const monthStart = (now: string) => `${now.slice(0, 7)}-01T00:00:00.000Z`

async function workspacesOf(tx: Reader, billId: string) {
  return tx
    .select({ id: organization.id, name: organization.name, extraCalls: organization.extraCalls })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
    .orderBy(organization.name)
}

/** Pending, failed-but-payable and paid recharges created this month: what counts towards the cap (§4.3). */
async function usedThisMonthCents(tx: Reader, billId: string, now: string) {
  const [row] = await tx
    .select({ cents: sql<number>`coalesce(sum(${billing_recharges.amount_cents}), 0)::int` })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.billing_account_id, billId),
        inArray(billing_recharges.status, ['pending', 'failed', 'paid']),
        // "Buy minutes" with the saved card is the owner's own purchase, not an automatic recharge.
        eq(billing_recharges.manual, false),
        gte(billing_recharges.created_at, monthStart(now)),
      ),
    )
  return row?.cents ?? 0
}

/** The bill's newest recharge charged to the card and not paid yet, or null (the page's "recharge on its way" note). */
async function pendingRecharge(tx: Reader, billId: string) {
  const [row] = await tx
    .select({ amountCents: billing_recharges.amount_cents })
    .from(billing_recharges)
    .where(and(eq(billing_recharges.billing_account_id, billId), eq(billing_recharges.status, 'pending')))
    .orderBy(desc(billing_recharges.created_at))
    .limit(1)
  return row ?? null
}

/** Recharge attempts of the bill in the last 24 hours (the Retry limit counts every attempt). */
async function attemptsLastDay(tx: Reader, billId: string, now: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.billing_account_id, billId),
        gte(billing_recharges.created_at, new Date(Date.parse(now) - DAY_MS).toISOString()),
      ),
    )
  return row?.n ?? 0
}

/** The bill's latest recharge attempt that failed, with its code; `needsAction`: kept open for 3D Secure. */
/** How the bill's last recharge attempt that got as far as Stripe was taxed (`billing_recharges.tax`). */
async function lastAttemptTax(tx: Reader, billId: string) {
  const [row] = await tx
    .select({ tax: billing_recharges.tax })
    .from(billing_recharges)
    .where(and(eq(billing_recharges.billing_account_id, billId), isNotNull(billing_recharges.tax)))
    .orderBy(desc(billing_recharges.created_at))
    .limit(1)
  return row?.tax ?? null
}

async function lastFailedAttempt(tx: Reader, billId: string) {
  const [row] = await tx
    .select()
    .from(billing_recharges)
    .where(
      and(eq(billing_recharges.billing_account_id, billId), inArray(billing_recharges.status, ['failed', 'canceled'])),
    )
    .orderBy(desc(billing_recharges.created_at))
    .limit(1)
  if (!row) return null
  return { ...row, needsAction: row.status === 'failed' && !!row.stripe_invoice_id }
}

/**
 * The banner's flags about the balance and a failed recharge (`billing.state`, docs/billing.md §11 PR 9): the few rows
 * they need, not the overview (security review of #1007, I-4). `lowBalance` only in the trial or paid.
 */
export async function balanceFlags(tx: Reader, bill: Bill, now: string) {
  const failed = bill.recharge_failed_at ? await lastFailedAttempt(tx, bill.id) : null
  let lowBalance: 'auto_recharge_off' | 'cap_reached' | null = null
  // In the trial only once "Keep calls answered" was pressed: before, its balance is $0 by design (the included minutes
  // and the minutes prompt cover it), and auto-recharge starts off since 2026-11-17.
  if ((bill.status === 'trialing' && bill.trial_recharge_at) || bill.status === 'active') {
    const [balance] = await tx.select().from(billing_balances).where(eq(billing_balances.billing_account_id, bill.id))
    const available = exactMicros(balance?.balance_micros) - exactMicros(balance?.reserved_micros)
    if (available < bill.recharge_threshold_cents * 10_000) {
      if (!bill.auto_recharge) lowBalance = 'auto_recharge_off'
      else {
        const rules = await billingRules(tx as Tx)
        const capCents = rechargeCapCents(bill.recharge_cap_base_cents, (await workspacesOf(tx, bill.id)).length, rules)
        if (capCents - (await usedThisMonthCents(tx, bill.id, now)) < RECHARGE_LIMITS.amountCents.min)
          lowBalance = 'cap_reached'
      }
    }
  }
  return { rechargeNeedsAction: !!failed?.needsAction, lowBalance }
}

/** The largest base the owner may set alone: the cap in effect stays at most $1,000 (§8). */
const ownerMaxBase = (workspaces: number, perWorkspaceCents: number) =>
  Math.max(0, RECHARGE_CAP_SELF_SERVE_MAX_CENTS - perWorkspaceCents * Math.max(0, workspaces - 1))

/**
 * This period's usage per workspace of the bill and level, from the bill's own ledger and counters. `only`: one
 * workspace's rows alone (billing.workspaceUsage), never the others'.
 */
async function periodUsage(
  tx: Reader,
  billId: string,
  periodId: string,
  workspaces: { id: string; name: string }[],
  allowanceSeconds: number,
  only?: string,
): Promise<BillingUsageRow[]> {
  const entries = await tx
    .select({
      workspaceId: ledger_entries.workspace_id,
      basis: ledger_entries.price_basis,
      seconds: sql<number>`coalesce(sum(${ledger_entries.seconds}), 0)::int`,
      micros: sql<string>`coalesce(-sum(${ledger_entries.amount_micros}), 0)`,
    })
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.billing_account_id, billId),
        eq(ledger_entries.period_id, periodId),
        eq(ledger_entries.kind, 'usage'),
        only ? eq(ledger_entries.workspace_id, only) : undefined,
      ),
    )
    .groupBy(ledger_entries.workspace_id, ledger_entries.price_basis)
  const counters = await tx
    .select({ workspaceId: usage_counters.workspace_id, used: usage_counters.included_seconds_used })
    .from(usage_counters)
    .where(
      and(
        eq(usage_counters.billing_account_id, billId),
        eq(usage_counters.period_id, periodId),
        only ? eq(usage_counters.workspace_id, only) : undefined,
      ),
    )
  const rows = new Map<string, BillingUsageRow>()
  const row = (workspaceId: string) => {
    let found = rows.get(workspaceId)
    if (!found) {
      found = {
        workspaceId,
        name: workspaces.find(w => w.id === workspaceId)?.name ?? null,
        allowanceUsedSeconds: 0,
        allowanceSeconds,
        levels: {},
      }
      rows.set(workspaceId, found)
    }
    return found
  }
  for (const w of workspaces) row(w.id)
  for (const c of counters) row(c.workspaceId).allowanceUsedSeconds = c.used
  for (const e of entries) {
    if (!e.workspaceId || !e.basis) continue
    // `fixed_5c` and `cost_plus_10` are 0107 values that are no longer written (schema.ts): shown as Standard.
    const level = e.basis === 'premium' || e.basis === 'ultra' || e.basis === 'own_keys' ? e.basis : 'standard'
    const target = row(e.workspaceId).levels
    const before = target[level] ?? { seconds: 0, micros: 0 }
    target[level] = { seconds: before.seconds + e.seconds, micros: before.micros + exactMicros(e.micros) }
  }
  return [...rows.values()]
}

// ---- billing.overview ------------------------------------------------------------------------------------------

/** How long a subscription's seat price read from Stripe is reused for the page (it changes only by a new Checkout). */
export const SEAT_PRICE_TTL_MS = 10 * 60_000
const seatPrices = new Map<string, { cents: number; at: number }>()

/**
 * The seat price a running subscription charges, before tax, as Stripe has it (its plan item's own price), read at
 * most once per SEAT_PRICE_TTL_MS per subscription. Null when it cannot be read: the page then shows the install's
 * price, never an error.
 */
async function seatCentsOf(subscriptionId: string, lookupKey: string, now = Date.now()): Promise<number | null> {
  const hit = seatPrices.get(subscriptionId)
  if (hit && now - hit.at < SEAT_PRICE_TTL_MS) return hit.cents
  try {
    const sub = await (await billingProvider(db)).subscription(subscriptionId)
    const item =
      sub?.items.find(i => i.lookupKey === lookupKey) ??
      sub?.items.find(i => i.productId === 'linedesk_workspace' || i.productId === 'linedesk_partner')
    const cents = item?.unitAmountCents
    if (typeof cents !== 'number') return null
    if (seatPrices.size > 10_000) seatPrices.clear()
    seatPrices.set(subscriptionId, { cents, at: now })
    return cents
  } catch (error) {
    console.error(`billing: the seat price of subscription ${subscriptionId} could not be read:`, error)
    return null
  }
}

/** Forgets the seat prices read (tests). */
export function forgetSeatPrices() {
  seatPrices.clear()
}

async function overview(
  { tx, actor, now }: HandlerCtx,
  input: { partnerId?: string } = {},
): Promise<{ rows: Record<string, never>; data: BillingOverviewData }> {
  refuseBillingActor(actor)
  // A partner's bill (Partner › Billing): only its owner, who owns the bill, reads it (partnerBillOf refuses others,
  // also where billing is off).
  const partnerBill = input.partnerId ? await partnerBillOf(tx as Tx, actor, input.partnerId) : null
  const billingOn = (await billingState(tx as Tx)).inEffect === 'stripe'
  const none = { rows: {}, data: { billingOn, bill: null } }
  if (!billingOn) return none
  if (!partnerBill && !actor.workspaceId) return none
  const [found] = partnerBill
    ? await tx.select({ bill: billing_accounts }).from(billing_accounts).where(eq(billing_accounts.id, partnerBill))
    : await tx
        .select({ bill: billing_accounts })
        .from(organization)
        .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
        .where(eq(organization.id, actor.workspaceId!))
  const bill = found?.bill
  // Its owner, or an owner or admin of the only workspace it pays for (managesBill); anyone else: the usage view.
  if (!bill || !(await managesBill(tx as Tx, actor, bill))) return none

  const rules = await billingRules(tx as Tx)
  const workspaces = await workspacesOf(tx, bill.id)
  const [balance] = await tx.select().from(billing_balances).where(eq(billing_balances.billing_account_id, bill.id))
  const balanceMicros = exactMicros(balance?.balance_micros)
  const reservedMicros = exactMicros(balance?.reserved_micros)
  const period = await periodAt(tx as Tx, bill.id, now)
  const failed = bill.recharge_failed_at ? await lastFailedAttempt(tx, bill.id) : null
  const invoices = await tx
    .select()
    .from(billing_invoices)
    .where(
      and(
        eq(billing_invoices.billing_account_id, bill.id),
        inArray(billing_invoices.status, ['open', 'paid', 'void', 'uncollectible']),
      ),
    )
    .orderBy(desc(billing_invoices.created_at))
    .limit(INVOICES_SHOWN)
  const lookupKey = bill.kind === 'partner' ? `partner_${bill.interval}ly` : `ws_${bill.interval}ly`
  // What the subscription charges a seat (security review of #1040, L-4): a price change applies to new Checkouts
  // only, so a bill on an older price is shown that one. The install's price now only for a bill without a plan yet.
  const charged = bill.stripe_subscription_id ? await seatCentsOf(bill.stripe_subscription_id, lookupKey) : null
  const seat = planPrice(lookupKey, rules)
  const data: BillingOverviewBill = {
    status: bill.status,
    interval: bill.interval,
    seatCents: charged ?? seat?.cents ?? 0,
    workspaces: workspaces.length,
    trialEndsAt: bill.status === 'trialing' ? bill.trial_ends_at : null,
    currentPeriodEnd: bill.current_period_end,
    cancelAtPeriodEnd: bill.cancel_at_period_end,
    balanceMicros,
    availableMicros: balanceMicros - reservedMicros,
    autoRecharge: {
      on: bill.auto_recharge,
      thresholdCents: bill.recharge_threshold_cents,
      amountCents: bill.recharge_amount_cents,
    },
    cap: {
      baseCents: bill.recharge_cap_base_cents,
      effectiveCents: rechargeCapCents(bill.recharge_cap_base_cents, workspaces.length, rules),
      usedThisMonthCents: await usedThisMonthCents(tx, bill.id, now),
      ownerMaxBaseCents: ownerMaxBase(workspaces.length, rules.rechargeCapPerWorkspaceCents),
    },
    rechargeFailure: bill.recharge_failed_at
      ? {
          at: bill.recharge_failed_at,
          code: failed?.failure_code ?? null,
          needsAction: !!failed?.needsAction,
          retriesLeft: Math.max(0, RECHARGE_RETRIES_PER_DAY - (await attemptsLastDay(tx, bill.id, now))),
        }
      : null,
    rechargePending: await pendingRecharge(tx, bill.id),
    heldForReview: !!bill.held_for_review_at,
    // A comped bill pays nothing for its numbers either (docs/billing.md §2).
    extraNumberCents: bill.status === 'comped' ? 0 : rules.extraNumberCents,
    canBuyMinutes: !!bill.stripe_customer_id && BUYS_MINUTES.includes(bill.status),
    hasPortal: !!bill.stripe_customer_id,
    // Stripe Tax on (Server admin › Billing): what the page states is before tax, and tax is added on top.
    taxed: rules.automaticTax && bill.status !== 'comped',
    taxAddressMissing:
      rules.automaticTax && bill.status !== 'comped' && (await lastAttemptTax(tx, bill.id)) === 'no_address',
    period: period ? { startsAt: period.starts_at, endsAt: period.ends_at, kind: period.kind } : null,
    calls: callsOf(bill, workspaces, rules, now, await busyCallersByWorkspace(tx, [bill.id], now)),
    usage: period ? await periodUsage(tx, bill.id, period.id, workspaces, rules.includedStandardSeconds) : [],
    invoices: invoices.map(
      (i): BillingInvoiceRow => ({
        id: i.stripe_invoice_id,
        kind: i.kind,
        number: i.number,
        status: i.status,
        totalCents: i.total_cents,
        taxCents: i.tax_cents,
        createdAt: i.created_at,
        url: i.hosted_invoice_url,
      }),
    ),
  }
  return { rows: {}, data: { billingOn, bill: data } }
}

// ---- What /v1/me tells the app about the workspace's bill ------------------------------------------------------

/**
 * The few bill facts every member's app needs (/v1/me), read only for a workspace on a bill while billing runs through
 * Stripe: while `pending_payment`, the trial's length and the plan's price at the bill's interval (the install's rules,
 * the price the Checkout will charge); and what an extra number costs a month (null on a comped bill: free).
 */
export type WorkspaceBillFacts = {
  trialDays: number | null
  plan: { interval: 'month' | 'year'; cents: number } | null
  extraNumberCents: number | null
  /**
   * A white-label client on its partner's bill: its people see no prices (docs/white-label.md; review of #1109, L-2),
   * so the plan and the extra number's price are null, and the app says no price instead of the carrier's.
   */
  partnerManaged: boolean
  /** In the free trial (the bill is `trialing`): when it ends, the day of the first charge; else null. */
  trialEndsAt: string | null
  /**
   * While `pending_payment`, for the bill's owner: what the onboarding's last step (`activate`) shows next to its
   * button (the price, the trial, the first charge's date, the reminders, the auto-recharge); else null.
   */
  activation: (ActivationFacts & { terms: LegalTerms | null }) | null
}

export async function workspaceBillFacts(workspaceId: string, actorId?: string): Promise<WorkspaceBillFacts> {
  const none: WorkspaceBillFacts = {
    trialDays: null,
    plan: null,
    extraNumberCents: null,
    partnerManaged: false,
    trialEndsAt: null,
    activation: null,
  }
  return db.transaction(async tx => {
    // A white-label client: its partner bills it, so the workspace shows none of our prices, billing in effect or not.
    const [client] = await tx
      .select({ partnerId: organization.partnerId })
      .from(organization)
      .where(eq(organization.id, workspaceId))
    if (client?.partnerId) return { ...none, partnerManaged: true }
    if ((await billingState(tx)).inEffect !== 'stripe') return none
    const [row] = await tx
      .select({ bill: billing_accounts })
      .from(organization)
      .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
      .where(eq(organization.id, workspaceId))
    if (!row) return none
    const found = row.bill
    const rules = await billingRules(tx)
    const pending = found.status === 'pending_payment'
    const price = pending
      ? planPrice(`${found.kind === 'partner' ? 'partner' : 'ws'}_${found.interval}ly`, rules)
      : null
    return {
      // No trial for this bill (refused, the account had one, or a partner's plan): none promised.
      trialDays: pending && (await trialOffered(tx as Tx, found)) ? rules.trialDays : null,
      plan: price ? { interval: found.interval, cents: price.cents } : null,
      extraNumberCents: found.status === 'comped' ? null : rules.extraNumberCents,
      partnerManaged: false,
      trialEndsAt: found.status === 'trialing' ? found.trial_ends_at : null,
      // Only the bill's owner starts the trial, so only they are told what it charges.
      activation:
        pending && actorId === found.owner_user_id
          ? {
              ...(await activationFacts(tx as Tx, found, rules, new Date().toISOString())),
              terms: legalTerms().terms,
            }
          : null,
    }
  })
}

// ---- billing.workspaceUsage ------------------------------------------------------------------------------------

/**
 * Workspace settings › Billing for the workspace's owners and admins who do not own the bill (docs/billing.md §8:
 * workspace admins see usage only): this workspace's row of the current period, read through the bill the workspace
 * is on. Never another workspace of the bill, the balance, the plan or an invoice link.
 */
async function workspaceUsage({
  tx,
  actor,
  now,
}: HandlerCtx): Promise<{ rows: Record<string, never>; data: BillingWorkspaceUsageData }> {
  // The same key policy as the owner's overview (security review of #1098, L-2): billing figures stay in the app, so
  // no workspace API key, personal key or setup link reads them. An impersonating instance admin may (support sees
  // what the admin sees; read-only, and the overview's bearer invoice links are not here).
  if (actor.apiKeyId || actor.personalKeyId || actor.setupKeyId)
    // i18n-ignore: the API error body for API clients; the web app never sends a key
    throw new Forbidden('billing usage is read in the app, signed in as yourself')
  const none = { rows: {}, data: { usage: null } }
  if (!actor.workspaceId || (await billingState(tx as Tx)).inEffect !== 'stripe') return none
  const [found] = await tx
    .select({ billId: organization.billingAccountId, name: organization.name, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, actor.workspaceId))
  if (!found?.billId) return none
  const rules = await billingRules(tx as Tx)
  const period = await periodAt(tx as Tx, found.billId, now)
  if (!period) return { rows: {}, data: { usage: { period: null, row: null, minutesOnly: !!found.partnerId } } }
  const [row] = await periodUsage(
    tx,
    found.billId,
    period.id,
    [{ id: actor.workspaceId, name: found.name }],
    rules.includedStandardSeconds,
    actor.workspaceId,
  )
  // On a white-label partner's bill the client's people see minutes, never our prices: the partner sets what it
  // charges them (docs/white-label.md). The partner's owner reads the amounts on the bill's own page.
  const minutesOnly = !!found.partnerId
  return {
    rows: {},
    data: {
      usage: {
        period: { startsAt: period.starts_at, endsAt: period.ends_at, kind: period.kind },
        row: row && minutesOnly ? withoutAmounts(row) : (row ?? null),
        minutesOnly,
      },
    },
  }
}

// ---- Calls at the same time (LIN-450) ---------------------------------------------------------------------------

/** More extra calls only on a paid plan: never in the trial (free) or while a payment is open. */
const ADDS_CALLS: readonly Bill['status'][] = ['active']

function callsOf(
  bill: Bill,
  workspaces: { id: string; name: string; extraCalls: number }[],
  rules: BillingRules,
  now: string,
  busyCallers: Map<string, number>,
): BillingCalls {
  return {
    includedPerWorkspace: rules.concurrentCallsPerWorkspace,
    extraCallCents: rules.extraCallCents,
    step: EXTRA_CALLS_STEP,
    maxExtra: maxExtraCalls(rules),
    canAdd: ADDS_CALLS.includes(bill.status) && !!bill.stripe_subscription_id && !bill.cancel_at_period_end,
    paidExtra: paidExtraCalls(
      bill,
      workspaces.reduce((sum, w) => sum + w.extraCalls, 0),
      now,
    ),
    workspaces: workspaces.map(w => ({
      workspaceId: w.id,
      name: w.name,
      extraCalls: w.extraCalls,
      limit: bill.concurrent_calls_cap ?? workspaceCallLimit(w.extraCalls, rules),
      busyCallers: busyCallers.get(w.id) ?? 0,
    })),
  }
}

/**
 * How often one bill's extra calls may change an hour (security review of #1103, M-1): every change asks Stripe, and a
 * raise charges the card. Per API process, like the other in-memory limits.
 */
export const EXTRA_CALLS_CHANGES_PER_HOUR = 10
let allowExtraCallsChange = createRateLimiter({ max: EXTRA_CALLS_CHANGES_PER_HOUR, windowMs: 3_600_000 })
/** Forgets every bill's changes (tests). */
export function resetExtraCallsLimit() {
  allowExtraCallsChange = createRateLimiter({ max: EXTRA_CALLS_CHANGES_PER_HOUR, windowMs: 3_600_000 })
}

/**
 * The extra-calls price of the bill's interval, as the last catalog sync stored it. Missing (a catalog synced before
 * the extra-calls prices existed), the sync runs on its own, never under this change's lock (security review of #1103,
 * L-2), and the owner is told to try again later; the admins hear of it if the sync fails.
 */
async function extraCallsPrice(tx: Tx, interval: 'month' | 'year') {
  const found = await extraCallsPriceId(tx, interval)
  if (found) return found
  void syncBillingCatalog().catch(e => console.error('billing: the catalog sync for extra calls failed:', e))
  return setupFailed(new BillingSetupError('stripe_catalog_not_synced'))
}

/**
 * `billing.setExtraCalls`: the owner sets one workspace's extra calls; the subscription's extra-calls item becomes the
 * sum over the bill's workspaces (docs/billing.md §2.1c). Under the bill's extra-calls lock, never the balance lock the
 * call gate waits on (security review of #1103, L-2).
 *
 * - More: an active plan that does not end at the period end, a recent sign-in or passkey, at most
 *   `EXTRA_CALLS_CHANGES_PER_HOUR` changes. Up to what the bill already paid this period it is free; above it, Stripe
 *   charges at once and the calls are granted only once the card paid (M-1, L-1). Asked inside the transaction: a
 *   refusal changes nothing here; a commit that fails after Stripe raised it leaves the customer paid but not granted,
 *   and the retry finds Stripe at the new quantity and only stores it.
 * - Fewer: stored first, at once and without a refund; Stripe follows after the commit, so a failed commit never leaves
 *   Stripe charging less than the app grants.
 */
async function setExtraCalls(
  { tx, actor, now, onCommit }: HandlerCtx,
  input: {
    workspaceId: string
    extraCalls: number
    from?: 'settings' | 'busy_line' | undefined
    partnerId?: string | undefined
  },
): Promise<{ rows: Record<string, never>; data: ExtraCallsData }> {
  const owned = await ownBill(tx, actor, { partnerId: input.partnerId })
  await lockExtraCalls(tx, owned.id)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, owned.id))
  if (!bill || !CHANGES_RECHARGE.includes(bill.status)) throw refuse('notRunning')
  const rules = await billingRules(tx)
  const workspaces = await workspacesOf(tx, bill.id)
  const workspace = workspaces.find(w => w.id === input.workspaceId)
  if (!workspace) throw refuse('notOnBill')
  const limit = (extra: number) => bill.concurrent_calls_cap ?? workspaceCallLimit(extra, rules)
  const done = { workspaceId: workspace.id, extraCalls: input.extraCalls, limit: limit(input.extraCalls) }
  if (input.extraCalls === workspace.extraCalls) return { rows: {}, data: done }
  const raising = input.extraCalls > workspace.extraCalls
  if (raising) {
    if (input.extraCalls > maxExtraCalls(rules)) throw refuse('extraCallsAboveMax')
    if (!ADDS_CALLS.includes(bill.status) || !bill.stripe_subscription_id) throw refuse('extraCallsPaidPlan')
    if (bill.cancel_at_period_end) throw refuse('extraCallsCanceling')
    // Until the renewal reached us, what this period paid is not known (security review of #1103, V-1).
    if (periodEnded(bill, now)) throw refuse('extraCallsRenewing')
    // More calls charge the card without the owner at hand next time: they confirm it is them first (§8).
    const stepUp = await ownerStepUpNeeded(tx, actor)
    if (stepUp === 'passkey')
      // i18n-ignore: the API error body for logs and API clients; the web app opens the passkey dialog for the code
      throw new Reject('Confirm with your passkey to add calls at the same time.', PASSKEY_STEP_UP_REQUIRED)
    if (stepUp)
      // i18n-ignore: the API error body for logs and API clients; the web app shows the key of the code
      throw new Reject('Sign in again to add calls at the same time.', SIGN_IN_AGAIN)
  }
  if (!allowExtraCallsChange(bill.id)) throw refuse('extraCallsTooOften')
  const before = workspaces.reduce((sum, w) => sum + w.extraCalls, 0)
  const total = before - workspace.extraCalls + input.extraCalls
  // The same change from the same state (a retried command) has the same key; any committed change moves updated_at.
  const key = `extra_calls:${bill.id}:${bill.updated_at}:${before}:${total}`
  if (raising) {
    const provider = await billingProvider(tx)
    const priceId = await extraCallsPrice(tx, bill.interval)
    const paid = paidExtraCalls(bill, before, now)
    const answer = await provider
      .setExtraCallsQuantity({
        subscriptionId: bill.stripe_subscription_id!,
        priceId,
        quantity: total,
        paidUpTo: paid,
        charge: true,
        idempotencyKey: key,
      })
      .catch(setupFailed)
    if (answer === 'payment_failed') throw refuse('extraCallsPaymentFailed')
    await tx
      .update(billing_accounts)
      .set({ ...paidAfter(bill, paid, total), updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
    // The consent is kept, like the other purchases: the terms in effect, the session's IP and browser, what was said.
    const { terms } = legalTerms()
    if (terms && actor.sessionId)
      await recordAcceptance(tx, {
        userId: actor.actorId,
        billId: bill.id,
        sessionId: actor.sessionId,
        terms,
        now,
        source: 'extra_calls',
        disclosure: {
          kind: 'extra_calls',
          workspaceId: workspace.id,
          before: workspace.extraCalls,
          after: input.extraCalls,
          monthlyCents: input.extraCalls * rules.extraCallCents,
          chargedNow: total > paid,
          from: input.from ?? 'settings',
        },
      })
  } else {
    // What was paid stays paid for the rest of the period: going back up to it is free (M-1).
    await tx
      .update(billing_accounts)
      .set({ ...paidAfter(bill, paidExtraCalls(bill, before, now), 0), updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
    if (bill.stripe_subscription_id) {
      if (!onCommit) throw new Error('billing.setExtraCalls changes Stripe after the commit: no onCommit given')
      const provider = await billingProvider(tx)
      onCommit(() => syncExtraCallsItem(provider, bill.id, { charge: false, key }))
    }
  }
  await tx
    .update(organization)
    .set({ extraCalls: input.extraCalls })
    .where(and(eq(organization.id, workspace.id), eq(organization.billingAccountId, bill.id)))
  await tellBillOwner(tx, actor, bill, { change: 'extraCalls', from: workspace.extraCalls, to: input.extraCalls }, now)
  return { rows: {}, data: done }
}

/** A usage row with its minutes and no amounts. */
const withoutAmounts = (row: BillingUsageRow): BillingUsageRow => ({
  ...row,
  levels: Object.fromEntries(
    Object.entries(row.levels).map(([level, part]) => [level, { seconds: part.seconds, micros: 0 }]),
  ),
})

// ---- Auto-recharge and the cap ---------------------------------------------------------------------------------

/** The bill locked for a change of auto-recharge or the cap: the owner's, with a running plan. */
async function billToChange(tx: Tx, actor: Actor, partnerId: string | undefined) {
  const bill = await ownBill(tx, actor, { lock: true, partnerId })
  if (!CHANGES_RECHARGE.includes(bill.status)) throw refuse('notRunning')
  return bill
}

/** After a change that can make a recharge due (on again, a higher cap): the decision runs now, like after a debit. */
async function rechargeNow(tx: Tx, billId: string, now: string) {
  const outcome = await decideRecharge(tx, billId, now)
  await afterDebit(tx, billId, outcome, now)
  return outcome.kind === 'recharge'
}

/** The line Settings › Billing shows next to the switch while auto-recharge is off: what turning it on agrees to. */
export const AUTO_RECHARGE_TERMS = msg('settings.billing.auto.offTerms')
export const AUTO_RECHARGE_TERMS_TAXED = msg('settings.billing.auto.offTermsTaxed')

/**
 * Records that the owner turned auto-recharge on in Settings › Billing (`terms_acceptances.source = auto_recharge`),
 * with the line next to the switch as the page words it (the owner's language, the same amounts): the amount, the
 * threshold, the monthly cap and whether tax is added. Needs the terms in effect and a session, like the other records.
 */
async function recordAutoRechargeConsent(
  tx: Tx,
  actor: Actor,
  bill: { id: string; recharge_cap_base_cents: number },
  input: { thresholdCents: number; amountCents: number },
  now: string,
) {
  const { terms } = legalTerms()
  if (!terms || !actor.sessionId) return
  const rules = await billingRules(tx)
  const capCents = rechargeCapCents(bill.recharge_cap_base_cents, (await workspacesOf(tx, bill.id)).length, rules)
  const taxed = rules.automaticTax
  const key = taxed ? AUTO_RECHARGE_TERMS_TAXED : AUTO_RECHARGE_TERMS
  const words = getT(await localeForUserId(tx, actor.actorId))
  const money = (cents: number) => words.format.currency(cents / 100, 'USD', { maximumFractionDigits: 0 })
  await recordAcceptance(tx, {
    userId: actor.actorId,
    billId: bill.id,
    sessionId: actor.sessionId,
    terms,
    now,
    source: 'auto_recharge',
    disclosure: {
      kind: 'auto_recharge',
      key,
      text: words.t(key, {
        amount: money(input.amountCents),
        threshold: money(input.thresholdCents),
        cap: money(capCents),
      }),
      amountCents: input.amountCents,
      thresholdCents: input.thresholdCents,
      capCents,
      taxed,
    },
  })
}

async function setAutoRecharge(
  { tx, actor, now }: HandlerCtx,
  { partnerId, ...input }: { on: boolean; thresholdCents: number; amountCents: number; partnerId?: string },
): Promise<{ rows: Record<string, never>; data: AutoRechargeData }> {
  const bill = await billToChange(tx, actor, partnerId)
  // Turned on: the consent to the automatic charges is kept like "Keep calls answered"'s (Janik, 2026-11-18): the terms
  // in effect, the session's IP and browser, and the line the switch showed. Turned off, or changed while on: none.
  if (input.on && !bill.auto_recharge) await recordAutoRechargeConsent(tx, actor, bill, input, now)
  await tx
    .update(billing_accounts)
    .set({
      auto_recharge: input.on,
      recharge_threshold_cents: input.thresholdCents,
      recharge_amount_cents: input.amountCents,
      updated_at: now,
    })
    .where(eq(billing_accounts.id, bill.id))
  const recharging = await rechargeNow(tx, bill.id, now)
  return { rows: {}, data: { ...input, recharging } }
}

async function setRechargeCap(
  { tx, actor, now }: HandlerCtx,
  input: { baseCents: number; partnerId?: string },
): Promise<{ rows: Record<string, never>; data: RechargeCapData }> {
  const bill = await billToChange(tx, actor, input.partnerId)
  const rules = await billingRules(tx)
  const workspaces = (await workspacesOf(tx, bill.id)).length
  const raising = input.baseCents > bill.recharge_cap_base_cents
  if (raising) {
    // Above $1,000 in effect only an instance admin raises it (Server admin › Billing); lowering always works.
    if (input.baseCents > ownerMaxBase(workspaces, rules.rechargeCapPerWorkspaceCents)) throw refuse('capAboveOwnerMax')
    // Raising it lets more be charged to the card without the owner: they confirm it is them first (§8).
    const stepUp = await ownerStepUpNeeded(tx, actor)
    // The web app answers both codes itself: the passkey dialog, and settings.billing.error.signInAgain.
    if (stepUp === 'passkey')
      // i18n-ignore: the API error body for logs and API clients; the web app opens the passkey dialog for the code
      throw new Reject('Confirm with your passkey to raise the cap.', PASSKEY_STEP_UP_REQUIRED)
    if (stepUp)
      // i18n-ignore: the API error body for logs and API clients; the web app shows the key of the code
      throw new Reject('Sign in again to raise the cap.', SIGN_IN_AGAIN)
  }
  await tx
    .update(billing_accounts)
    .set({ recharge_cap_base_cents: input.baseCents, updated_at: now })
    .where(eq(billing_accounts.id, bill.id))
  const recharging = raising ? await rechargeNow(tx, bill.id, now) : false
  return {
    rows: {},
    data: {
      baseCents: input.baseCents,
      effectiveCents: rechargeCapCents(input.baseCents, workspaces, rules),
      recharging,
    },
  }
}

// ---- The portal ------------------------------------------------------------------------------------------------

/** Settings › Billing of this workspace: where the portal's "back" goes. */
const billingPage = (workspaceId: string) => appLink(WEB_ORIGIN, workspaceId, BILLING_PATH)

const preparePortal: Preparer = async ({ actor }, input: { partnerId?: string }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
  if (!bill.stripe_customer_id) throw refuse('noCustomer')
  const provider = await billingProvider(db)
  await stillManages(actor, bill.id, input.partnerId)
  const back = input.partnerId ? PARTNER_BILLING_URL() : billingPage(actor.workspaceId!)
  const url = await provider.portalSession({ customerId: bill.stripe_customer_id, returnUrl: back }).catch(setupFailed)
  return { billId: bill.id, url }
}

const openPortal: Handler = async ({ tx, actor, prepared }, input: { partnerId?: string }) => {
  const done = prepared as { billId: string; url: string }
  const bill = await ownBill(tx, actor, { partnerId: input.partnerId })
  if (bill.id !== done.billId) throw new Reject('the bill changed; try again')
  return { rows: {}, data: { url: done.url } satisfies PortalData }
}

// ---- Retry -----------------------------------------------------------------------------------------------------

/**
 * Retry (§3.4): an attempt kept open for 3D Secure is paid on its invoice's page (a new charge would charge twice),
 * so the page is fetched from Stripe before the transaction; any other failure starts a new attempt in the handler.
 */
type PreparedRetry = { billId: string; confirm: { rechargeId: string; url: string } | null }

const notRetrying = () => refuse('notRunning')

const prepareRetry: Preparer = async ({ actor }, input: { partnerId?: string }): Promise<PreparedRetry> => {
  const bill = await db.transaction(tx => ownBill(tx, actor, { partnerId: input.partnerId }))
  if (!bill.recharge_failed_at) return { billId: bill.id, confirm: null }
  // Before Stripe is asked for a payment page: never pushed for a bill that is held or canceled (L-1).
  if (!retriesRecharge(bill)) throw notRetrying()
  const failed = await lastFailedAttempt(db, bill.id)
  if (!failed?.needsAction || !failed.stripe_invoice_id) return { billId: bill.id, confirm: null }
  const provider = await billingProvider(db)
  await stillManages(actor, bill.id, input.partnerId)
  const url = await provider.rechargeInvoicePage(failed.stripe_invoice_id).catch(setupFailed)
  // No page (Stripe has none for it now): never a second charge instead, the owner tries again later.
  if (!url) throw refuse('invoicePageUnavailable')
  return { billId: bill.id, confirm: { rechargeId: failed.id, url } }
}

async function retryRecharge(
  { tx, actor, now, prepared }: HandlerCtx,
  input: { partnerId?: string },
): Promise<{ rows: Record<string, never>; data: RetryRechargeData }> {
  const done = prepared as PreparedRetry
  const bill = await ownBill(tx, actor, { lock: true, partnerId: input.partnerId })
  if (bill.id !== done.billId) throw new Reject('the bill changed; try again')
  if (!bill.recharge_failed_at) throw refuse('noFailure')
  // Read again under the bill's lock: the status, and for a payment page that its attempt is still the one waiting.
  if (!retriesRecharge(bill)) throw notRetrying()
  const failed = await lastFailedAttempt(tx, bill.id)
  if (done.confirm) {
    if (failed?.id !== done.confirm.rechargeId || !failed.needsAction)
      throw new Reject('the failed recharge changed; try again')
    return { rows: {}, data: { kind: 'confirm', url: done.confirm.url } }
  }
  // An attempt kept open for 3D Secure since prepare looked: it is paid on its page, never charged a second time.
  if (failed?.needsAction) throw new Reject('the failed recharge changed; try again')
  if (bill.status === 'suspended') throw notRetrying()
  // Auto-recharge off: nothing would be charged, and the failure stays recorded, so turning it on again later still
  // waits for a new card instead of charging the declined one at once (security review of #1007, L-2).
  if (!bill.auto_recharge) throw refuse('autoRechargeOff')
  if ((await attemptsLastDay(tx, bill.id, now)) >= RECHARGE_RETRIES_PER_DAY) throw refuse('retryLimit')
  // Only the failure that was read: a newer one (a decline since) is the next Retry's.
  await tx
    .update(billing_accounts)
    .set({ recharge_failed_at: null, updated_at: now })
    .where(and(eq(billing_accounts.id, bill.id), eq(billing_accounts.recharge_failed_at, bill.recharge_failed_at)))
  const outcome = await decideRecharge(tx, bill.id, now)
  await afterDebit(tx, bill.id, outcome, now)
  const kind = outcome.kind === 'recharge' ? 'retrying' : outcome.kind === 'cap_reached' ? 'cap_reached' : 'not_needed'
  return { rows: {}, data: { kind } }
}

export const billingPagePreparers: Record<string, Preparer> = {
  'billing.openPortal': preparePortal,
  'billing.retryRecharge': prepareRetry,
}

export const billingPageHandlers: Record<string, Handler> = {
  'billing.overview': overview,
  'billing.setAutoRecharge': setAutoRecharge,
  'billing.setRechargeCap': setRechargeCap,
  'billing.setExtraCalls': setExtraCalls,
  'billing.openPortal': openPortal,
  'billing.retryRecharge': retryRecharge,
  'billing.workspaceUsage': workspaceUsage,
}
