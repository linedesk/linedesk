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
//   at most 3 attempts in 24 hours, §3.4). The owner, signed in as themselves in the app (`ownBill` refuses API keys,
//   personal keys, setup links and impersonation), under the bill's lock order (its balance row first).
//
// Refusals carry a `code` the page words itself (BILLING_PAGE_CODES); the English message is for logs and the API.
import type {
  AutoRechargeData,
  BillingInvoiceRow,
  BillingOverviewBill,
  BillingOverviewData,
  BillingUsageRow,
  PortalData,
  RechargeCapData,
  RetryRechargeData,
} from '@linedesk/actions'
import { RECHARGE_RETRIES_PER_DAY } from '@linedesk/actions'
import {
  billing_accounts,
  billing_balances,
  billing_invoices,
  billing_recharges,
  ledger_entries,
  organization,
  planPrice,
  RECHARGE_CAP_SELF_SERVE_MAX_CENTS,
  RECHARGE_LIMITS,
  rechargeCapCents,
  type Tx,
  usage_counters,
} from '@linedesk/db'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { SIGN_IN_AGAIN } from './account.ts'
import { PASSKEY_STEP_UP_REQUIRED } from './admin-step-up.ts'
import { BUYS_MINUTES, ownBill, setupFailed } from './billing-checkout.ts'
import { billingRules } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { afterDebit } from './call-billing.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { appLink, WEB_ORIGIN } from './emails/templates.ts'
import { BILLING_PATH } from './emails/billing-lifecycle.ts'
import { type Handler, type HandlerCtx, type Preparer, Reject } from './handler-context.ts'
import { decideRecharge, periodAt } from './ledger.ts'
import { ownerStepUpNeeded } from './owner-step-up.ts'
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
    .select({ id: organization.id, name: organization.name })
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
        gte(billing_recharges.created_at, monthStart(now)),
      ),
    )
  return row?.cents ?? 0
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
  if (bill.status === 'trialing' || bill.status === 'active') {
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

/** This period's usage per workspace of the bill and level, from the bill's own ledger and counters. */
async function periodUsage(
  tx: Reader,
  billId: string,
  periodId: string,
  workspaces: { id: string; name: string }[],
  allowanceSeconds: number,
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
      ),
    )
    .groupBy(ledger_entries.workspace_id, ledger_entries.price_basis)
  const counters = await tx
    .select({ workspaceId: usage_counters.workspace_id, used: usage_counters.included_seconds_used })
    .from(usage_counters)
    .where(and(eq(usage_counters.billing_account_id, billId), eq(usage_counters.period_id, periodId)))
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

async function overview({
  tx,
  actor,
  now,
}: HandlerCtx): Promise<{ rows: Record<string, never>; data: BillingOverviewData }> {
  refuseBillingActor(actor)
  const billingOn = (await billingState(tx as Tx)).inEffect === 'stripe'
  const none = { rows: {}, data: { billingOn, bill: null } }
  if (!billingOn || !actor.workspaceId) return none
  const [found] = await tx
    .select({ bill: billing_accounts })
    .from(organization)
    .innerJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, actor.workspaceId))
  const bill = found?.bill
  if (!bill || bill.owner_user_id !== actor.actorId) return none

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
    canBuyMinutes: !!bill.stripe_customer_id && BUYS_MINUTES.includes(bill.status),
    hasPortal: !!bill.stripe_customer_id,
    period: period ? { startsAt: period.starts_at, endsAt: period.ends_at, kind: period.kind } : null,
    usage: period ? await periodUsage(tx, bill.id, period.id, workspaces, rules.includedStandardSeconds) : [],
    invoices: invoices.map(
      (i): BillingInvoiceRow => ({
        id: i.stripe_invoice_id,
        kind: i.kind,
        number: i.number,
        status: i.status,
        totalCents: i.total_cents,
        createdAt: i.created_at,
        url: i.hosted_invoice_url,
      }),
    ),
  }
  return { rows: {}, data: { billingOn, bill: data } }
}

// ---- Auto-recharge and the cap ---------------------------------------------------------------------------------

/** The bill locked for a change of auto-recharge or the cap: the owner's, with a running plan. */
async function billToChange(tx: Tx, actor: Actor) {
  const bill = await ownBill(tx, actor, { lock: true })
  if (!CHANGES_RECHARGE.includes(bill.status)) throw refuse('notRunning')
  return bill
}

/** After a change that can make a recharge due (on again, a higher cap): the decision runs now, like after a debit. */
async function rechargeNow(tx: Tx, billId: string, now: string) {
  const outcome = await decideRecharge(tx, billId, now)
  await afterDebit(tx, billId, outcome, now)
  return outcome.kind === 'recharge'
}

async function setAutoRecharge(
  { tx, actor, now }: HandlerCtx,
  input: { on: boolean; thresholdCents: number; amountCents: number },
): Promise<{ rows: Record<string, never>; data: AutoRechargeData }> {
  const bill = await billToChange(tx, actor)
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
  input: { baseCents: number },
): Promise<{ rows: Record<string, never>; data: RechargeCapData }> {
  const bill = await billToChange(tx, actor)
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

const preparePortal: Preparer = async ({ actor }) => {
  const bill = await db.transaction(tx => ownBill(tx, actor))
  if (!bill.stripe_customer_id) throw refuse('noCustomer')
  const provider = await billingProvider(db)
  const url = await provider
    .portalSession({ customerId: bill.stripe_customer_id, returnUrl: billingPage(actor.workspaceId!) })
    .catch(setupFailed)
  return { billId: bill.id, url }
}

const openPortal: Handler = async ({ tx, actor, prepared }) => {
  const done = prepared as { billId: string; url: string }
  const bill = await ownBill(tx, actor)
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

const prepareRetry: Preparer = async ({ actor }): Promise<PreparedRetry> => {
  const bill = await db.transaction(tx => ownBill(tx, actor))
  if (!bill.recharge_failed_at) return { billId: bill.id, confirm: null }
  // Before Stripe is asked for a payment page: never pushed for a bill that is held or canceled (L-1).
  if (!retriesRecharge(bill)) throw notRetrying()
  const failed = await lastFailedAttempt(db, bill.id)
  if (!failed?.needsAction || !failed.stripe_invoice_id) return { billId: bill.id, confirm: null }
  const provider = await billingProvider(db)
  const url = await provider.rechargeInvoicePage(failed.stripe_invoice_id).catch(setupFailed)
  // No page (Stripe has none for it now): never a second charge instead, the owner tries again later.
  if (!url) throw refuse('invoicePageUnavailable')
  return { billId: bill.id, confirm: { rechargeId: failed.id, url } }
}

async function retryRecharge({
  tx,
  actor,
  now,
  prepared,
}: HandlerCtx): Promise<{ rows: Record<string, never>; data: RetryRechargeData }> {
  const done = prepared as PreparedRetry
  const bill = await ownBill(tx, actor, { lock: true })
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
  'billing.openPortal': openPortal,
  'billing.retryRecharge': retryRecharge,
}
