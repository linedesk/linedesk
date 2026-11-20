// Server admin › Billing (docs/billing.md §11, PR 13): what an instance admin sees of the bills and does to them.
//
// Who: `instance:admin` (the registry, with the admin's passkey check for every Server admin action). Every write here
// also refuses an AI agent's setup link, an API key, a personal key and an impersonation, and needs the
// passkey-confirmed session itself (`refuseMoneyChange`, as for the Stripe keys and the billing switch), so a stolen
// session cookie without the passkey, a leaked key or an agent cannot move money. Every write takes a `reason`, kept
// with its input in the audit log (AUDITED_ACTIONS); every ledger entry here carries the admin as `actor_id`.
//
// Money: entries are posted with `postEntry` under the bill's balance lock (lock order: balance first, then the
// recharge row), with the request id of the page as their source key, so a retried request posts once. A refund picks
// its period and writes a pending `billing_refunds` row, committed on its own, before Stripe is asked (security
// review of #919, M1 and M2); Stripe's idempotency key is that row's id, and the refund posts under Stripe's refund id.
// Sent twice, Stripe answers the same refund and the ledger's unique key keeps one entry; a refund whose entry was not
// posted (the transaction failed after Stripe answered) is found by its row and posted by the next refund of the bill
// or the nightly reconciliation (`settlePendingRefunds`). Seat changes of a move go to Stripe only after the move
// committed (M2). Reports read `amount_micros` for what was paid, never `billable_seconds` (a comped call records
// billable seconds at $0).
import type {
  AdminBillDetail,
  AdminBillingSummary,
  AdminBillRow,
  AdminLedgerEntry,
  AdminRefundable,
  AdminReviewRow,
  AdminStripeEvent,
  BillingEventFilter,
  BillingRulesData,
  SelfServeData,
} from '@linedesk/actions'
import { PLAN_PRICE_FLOOR } from '@linedesk/actions'
import type { BillingInvoice, BillingProvider, InvoiceRefund } from '@linedesk/billing'
import {
  BILLING_DEFAULTS,
  SIGNUP_DEFAULTS,
  billing_accounts,
  billing_balances,
  billing_invoices,
  billing_recharges,
  billing_refunds,
  call_reservations,
  calls,
  concurrentCallCap,
  instance_settings,
  ledger_entries,
  member,
  organization,
  rechargeCapCents,
  stripe_events,
  type Tx,
  user,
} from '@linedesk/db'
import { and, desc, eq, inArray, isNull, like, lt, ne, sql } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import {
  BILLING_RULES_KEY,
  billingRules,
  checkBillingRules,
  mergeBillingRules,
  mergeStoredRules,
  minMicrosPerMinute,
  minPlanCents,
  PLAN_RULE_FIELDS,
  planPriceProblems,
  withoutResets,
} from './billing-rules.ts'
import { syncCatalogAfterCommit } from './billing-catalog.ts'
import { customersWithoutTaxAddress, syncSubscriptionTaxAfterCommit } from './billing-tax.ts'
import { workspacesOnBill } from './billing-owner.ts'
import { billingProvider, billingState, refuseMoneyChange } from './billing-settings.ts'
import type { Actor } from './context.ts'
import { db, ownCommitDb } from './db.ts'
import { type AlertActor, billingRulesAlert, selfServeAlert, signupRulesAlert } from './emails/alerts.ts'
import { syncExtraCallsItem } from './extra-calls.ts'
import { busyCallersByWorkspace } from './billing-recharge.ts'
import { type Handler, Reject } from './handler-context.ts'
import { lockBalance, periodAt, periodForMoney, postEntry } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'
import { legalTerms } from './legal-terms.ts'
import {
  SELF_SERVE_KEY,
  SIGNUP_RULES_KEY,
  selfServeState,
  signupRuleChanges,
  signupRules,
  signupRulesProblems,
  storedSignupRules,
  turnstileKeys,
} from './self-serve.ts'
import { CLIENT_STAYS_ON_PARTNER_BILL, PARTNER_BILL_STAYS } from './partner-refusals.ts'
import { STRIPE_EVENT_ATTEMPTS } from './stripe-events.ts'

// The instance setting that opens sign-up to anyone (docs/billing.md §3.1): self-serve.ts, which reads it.
export { SELF_SERVE_KEY } from './self-serve.ts'

/** How many ledger entries, recharges, invoices and events one page shows. */
const PAGE = 200
const EVENTS_PAGE = 100
/** 1 cent in micro-dollars. */
const MICROS_PER_CENT = 10_000

/** The prefix of a refund entry's note naming the payment it refunded (`refund_of=<entry id>; <reason>`). */
const REFUND_OF = 'refund_of='

// The billing writes are made only by an instance admin signed in as themselves who confirmed with their passkey:
// never an AI agent's setup link, an API key, a personal key or an impersonation (billing-settings.ts, the same check
// as the billing keys; security review of #919, H1).
export { refuseMoneyChange }

const exact = (value: unknown) => {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of range: ${String(value)}`)
  return n
}

type Bill = typeof billing_accounts.$inferSelect

async function billOrReject(tx: Tx, billId: string): Promise<Bill> {
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  if (!bill) throw Reject.t('server.api.billingAdmin.noBill')
  return bill
}

/** Who did it, for the alert emails. */
async function alertActor(actor: Actor): Promise<AlertActor> {
  if (actor.actorId === 'cli') return { operator: true }
  const [who] = await db.select({ email: user.email }).from(user).where(eq(user.id, actor.actorId))
  return { email: who?.email ?? null }
}

/** The workspaces' mirror of their bill's state (`organization.billing_state`), for fast reads. */
function mirroredState(status: Bill['status']): 'pending_payment' | 'active' | 'suspended' {
  if (status === 'pending_payment') return 'pending_payment'
  return status === 'suspended' || status === 'canceled' ? 'suspended' : 'active'
}

async function mirrorState(tx: Tx, billId: string, status: Bill['status']) {
  await tx
    .update(organization)
    .set({ billingState: mirroredState(status) })
    .where(eq(organization.billingAccountId, billId))
}

// ---- Reads ----

async function billRows(tx: Tx, ids?: string[]): Promise<AdminBillRow[]> {
  const bills = await tx
    .select({
      bill: billing_accounts,
      balance: billing_balances.balance_micros,
      reserved: billing_balances.reserved_micros,
      email: user.email,
      name: user.name,
    })
    .from(billing_accounts)
    .leftJoin(billing_balances, eq(billing_balances.billing_account_id, billing_accounts.id))
    .leftJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(ids ? inArray(billing_accounts.id, ids) : undefined)
    .orderBy(desc(billing_accounts.created_at))
  const workspaces = bills.length
    ? await tx
        .select({
          id: organization.id,
          name: organization.name,
          bill: organization.billingAccountId,
          extraCalls: organization.extraCalls,
        })
        .from(organization)
        .where(
          inArray(
            organization.billingAccountId,
            bills.map(b => b.bill.id),
          ),
        )
    : []
  const busy = await busyCallersByWorkspace(
    tx,
    bills.map(b => b.bill.id),
    new Date().toISOString(),
  )
  return bills.map(({ bill, balance, reserved, email, name }) => ({
    id: bill.id,
    kind: bill.kind,
    status: bill.status,
    interval: bill.interval,
    owner: { id: bill.owner_user_id, email, name },
    workspaces: workspaces
      .filter(w => w.bill === bill.id)
      .map(w => ({ id: w.id, name: w.name, extraCalls: w.extraCalls, busyCallers: busy.get(w.id) ?? 0 })),
    balanceMicros: exact(balance),
    reservedMicros: exact(reserved),
    heldForReviewAt: bill.held_for_review_at,
    cardRiskLevel: bill.card_risk_level,
    createdAt: bill.created_at,
  }))
}

/**
 * The payments that put money on the balance (recharges and top-ups), newest first, with what was refunded of each
 * (refund entries name their payment in their note).
 */
async function refundablePayments(tx: Tx, billId: string): Promise<AdminRefundable[]> {
  const credits = await tx
    .select()
    .from(ledger_entries)
    .where(and(eq(ledger_entries.billing_account_id, billId), inArray(ledger_entries.kind, ['recharge', 'topup'])))
    .orderBy(desc(ledger_entries.created_at), desc(ledger_entries.id))
  if (!credits.length) return []
  const refunds = await tx
    .select({ note: ledger_entries.note, amount: ledger_entries.amount_micros })
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.billing_account_id, billId),
        eq(ledger_entries.kind, 'refund'),
        like(ledger_entries.note, `${REFUND_OF}%`),
      ),
    )
  const refunded = new Map<string, number>()
  for (const r of refunds) {
    const of = /^refund_of=([A-Za-z0-9_]+)/.exec(r.note ?? '')?.[1]
    if (of) refunded.set(of, (refunded.get(of) ?? 0) - exact(r.amount))
  }
  const rechargeIds = credits.filter(c => c.kind === 'recharge').map(c => c.source_id)
  const invoices = rechargeIds.length
    ? await tx
        .select({ id: billing_recharges.id, invoice: billing_recharges.stripe_invoice_id })
        .from(billing_recharges)
        .where(inArray(billing_recharges.id, rechargeIds))
    : []
  return credits.map(c => ({
    entryId: c.id,
    kind: c.kind as 'recharge' | 'topup',
    createdAt: c.created_at,
    creditedMicros: exact(c.amount_micros),
    refundedMicros: refunded.get(c.id) ?? 0,
    invoiceId: c.kind === 'recharge' ? (invoices.find(i => i.id === c.source_id)?.invoice ?? null) : null,
  }))
}

async function billDetail(tx: Tx, billId: string): Promise<AdminBillDetail> {
  const bill = await billOrReject(tx, billId)
  const [row] = await billRows(tx, [billId])
  const rules = await billingRules(tx)
  const state = await billingState(tx)
  const workspaceIds = row!.workspaces.map(w => w.id)
  const ledger = await tx
    .select({ entry: ledger_entries, email: user.email })
    .from(ledger_entries)
    .leftJoin(user, eq(user.id, ledger_entries.actor_id))
    .where(eq(ledger_entries.billing_account_id, billId))
    .orderBy(desc(ledger_entries.created_at), desc(ledger_entries.id))
    .limit(PAGE)
  // This period's usage per workspace: what was paid is the sum of the entries' amounts (never billable seconds).
  const period = await periodAt(tx, billId, new Date().toISOString())
  const usage = period
    ? await tx
        .select({
          workspaceId: ledger_entries.workspace_id,
          seconds: sql<number>`coalesce(sum(${ledger_entries.seconds}), 0)::int`,
          paid: sql<string>`coalesce(-sum(${ledger_entries.amount_micros}), 0)`,
        })
        .from(ledger_entries)
        .where(
          and(
            eq(ledger_entries.billing_account_id, billId),
            eq(ledger_entries.period_id, period.id),
            eq(ledger_entries.kind, 'usage'),
          ),
        )
        .groupBy(ledger_entries.workspace_id)
    : []
  const usageNames = usage.length
    ? await tx
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(
          inArray(
            organization.id,
            usage.map(u => u.workspaceId).filter((id): id is string => !!id),
          ),
        )
    : []
  const recharges = await tx
    .select()
    .from(billing_recharges)
    .where(eq(billing_recharges.billing_account_id, billId))
    .orderBy(desc(billing_recharges.created_at))
    .limit(PAGE)
  const invoices = await tx
    .select()
    .from(billing_invoices)
    .where(eq(billing_invoices.billing_account_id, billId))
    .orderBy(desc(billing_invoices.created_at))
    .limit(PAGE)
  const members = workspaceIds.length
    ? await tx
        .selectDistinct({ id: user.id, email: user.email, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(inArray(member.organizationId, workspaceIds))
        .orderBy(user.email)
    : []
  const others = await tx
    .select({
      id: billing_accounts.id,
      kind: billing_accounts.kind,
      status: billing_accounts.status,
      owner: user.email,
    })
    .from(billing_accounts)
    .leftJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(ne(billing_accounts.id, billId))
    .orderBy(user.email)
  return {
    ...row!,
    stripeCustomerId: bill.stripe_customer_id,
    stripeSubscriptionId: bill.stripe_subscription_id,
    dashboardUrl: state.mode ? `https://dashboard.stripe.com${state.mode === 'test' ? '/test' : ''}` : null,
    // Only while the trial runs: a converted bill (also one whose trial ended early) shows no "Trial ends".
    trialEndsAt: bill.status === 'trialing' ? bill.trial_ends_at : null,
    currentPeriodStart: bill.current_period_start,
    currentPeriodEnd: bill.current_period_end,
    autoRecharge: bill.auto_recharge,
    rechargeThresholdCents: bill.recharge_threshold_cents,
    rechargeAmountCents: bill.recharge_amount_cents,
    rechargeCapBaseCents: bill.recharge_cap_base_cents,
    rechargeCapCents: rechargeCapCents(bill.recharge_cap_base_cents, workspaceIds.length, rules),
    concurrentCallsCap: bill.concurrent_calls_cap,
    rulesConcurrentCalls: concurrentCallCap(
      row!.workspaces.map(w => w.extraCalls),
      rules,
    ),
    suspendReason: bill.suspend_reason,
    rechargeFailedAt: bill.recharge_failed_at,
    usage: usage.map(u => ({
      workspaceId: u.workspaceId ?? '',
      workspaceName: usageNames.find(n => n.id === u.workspaceId)?.name ?? null,
      seconds: u.seconds,
      paidMicros: exact(u.paid),
    })),
    ledger: ledger.map(
      ({ entry, email }): AdminLedgerEntry => ({
        id: entry.id,
        createdAt: entry.created_at,
        kind: entry.kind,
        amountMicros: exact(entry.amount_micros),
        workspaceId: entry.workspace_id,
        seconds: entry.seconds,
        priceBasis: entry.price_basis,
        sourceType: entry.source_type,
        sourceId: entry.source_id,
        actor: entry.actor_id ? { id: entry.actor_id, email } : null,
        note: entry.note,
      }),
    ),
    recharges: recharges.map(r => ({
      id: r.id,
      amountCents: r.amount_cents,
      status: r.status,
      invoiceId: r.stripe_invoice_id,
      failureCode: r.failure_code,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    })),
    // The hosted page and PDF are bearer links for the bill owner (docs/billing.md §4.1): the admin opens the
    // invoice in the Stripe Dashboard instead.
    invoices: invoices.map(i => ({
      invoiceId: i.stripe_invoice_id,
      kind: i.kind,
      number: i.number,
      status: i.status,
      totalCents: i.total_cents,
      taxCents: i.tax_cents,
      createdAt: i.created_at,
    })),
    refundable: await refundablePayments(tx, billId),
    members,
    otherBills: others.map(o => ({ id: o.id, kind: o.kind, status: o.status, owner: o.owner })),
  }
}

/** Where an event stands: processed, waiting for its job, given up after 5 attempts, or not handled by this release. */
function eventState(e: typeof stripe_events.$inferSelect): AdminStripeEvent['state'] {
  if (e.processed_at) return 'processed'
  if (e.last_error?.startsWith('unhandled')) return 'unhandled'
  return e.attempts >= STRIPE_EVENT_ATTEMPTS ? 'failed' : 'waiting'
}

function eventFilter(filter: BillingEventFilter) {
  const open = isNull(stripe_events.processed_at)
  const unhandled = like(stripe_events.last_error, 'unhandled%')
  if (filter === 'unhandled') return and(open, unhandled)
  const handled = sql`(${stripe_events.last_error} is null or ${stripe_events.last_error} not like 'unhandled%')`
  if (filter === 'failed') return and(open, handled, sql`${stripe_events.attempts} >= ${STRIPE_EVENT_ATTEMPTS}`)
  if (filter === 'waiting') return and(open, handled, lt(stripe_events.attempts, STRIPE_EVENT_ATTEMPTS))
  return undefined
}

async function events(tx: Tx, filter: BillingEventFilter, before?: string) {
  const rows = await tx
    .select()
    .from(stripe_events)
    .where(and(eventFilter(filter), before ? lt(stripe_events.received_at, before) : undefined))
    .orderBy(desc(stripe_events.received_at), desc(stripe_events.id))
    .limit(EVENTS_PAGE + 1)
  const page = rows.slice(0, EVENTS_PAGE)
  const object = (e: (typeof rows)[number]) =>
    ((e.payload as { data?: { object?: { id?: unknown; customer?: unknown } } }).data?.object ?? {}) as {
      id?: unknown
      customer?: unknown
    }
  const customers = [...new Set(page.map(e => object(e).customer).filter((c): c is string => typeof c === 'string'))]
  const bills = customers.length
    ? await tx
        .select({ id: billing_accounts.id, customer: billing_accounts.stripe_customer_id })
        .from(billing_accounts)
        .where(inArray(billing_accounts.stripe_customer_id, customers))
    : []
  const list: AdminStripeEvent[] = page.map(e => {
    const obj = object(e)
    return {
      id: e.id,
      type: e.type,
      livemode: e.livemode,
      created: e.created,
      receivedAt: e.received_at,
      processedAt: e.processed_at,
      attempts: e.attempts,
      lastError: e.last_error,
      state: eventState(e),
      objectId: typeof obj.id === 'string' ? obj.id : null,
      billId: bills.find(b => b.customer === obj.customer)?.id ?? null,
    }
  })
  return { events: list, next: rows.length > EVENTS_PAGE ? page[page.length - 1]!.received_at : null }
}

/** How far back the review list shows new trials (docs/billing.md §8, fraud review). */
const REVIEW_TRIAL_DAYS = 7

async function reviewList(tx: Tx): Promise<{ held: AdminReviewRow[]; newTrials: AdminReviewRow[] }> {
  const since = new Date(Date.now() - REVIEW_TRIAL_DAYS * 86_400_000).toISOString()
  const rows = await tx
    .select({ bill: billing_accounts, email: user.email, name: user.name })
    .from(billing_accounts)
    .leftJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(
      sql`${billing_accounts.held_for_review_at} is not null or (${billing_accounts.created_at} > ${since} and ${billing_accounts.status} in ('pending_payment', 'trialing'))`,
    )
    .orderBy(desc(billing_accounts.created_at))
    .limit(PAGE)
  const counts = rows.length
    ? await tx
        .select({ bill: organization.billingAccountId, n: sql<number>`count(*)::int` })
        .from(organization)
        .where(
          inArray(
            organization.billingAccountId,
            rows.map(r => r.bill.id),
          ),
        )
        .groupBy(organization.billingAccountId)
    : []
  const toRow = ({ bill, email, name }: (typeof rows)[number]): AdminReviewRow => ({
    billId: bill.id,
    kind: bill.kind,
    status: bill.status,
    owner: { email, name },
    workspaces: counts.find(c => c.bill === bill.id)?.n ?? 0,
    createdAt: bill.created_at,
    heldForReviewAt: bill.held_for_review_at,
    cardRiskLevel: bill.card_risk_level,
  })
  return {
    held: rows.filter(r => r.bill.held_for_review_at).map(toRow),
    newTrials: rows.filter(r => !r.bill.held_for_review_at).map(toRow),
  }
}

/**
 * The top of Server admin › Billing in one read (billing.adminSummary): counts, not rows, so the page shows its status
 * line without loading every list. The same rules as the lists: held and new trials as `reviewList`, event states as
 * `eventState`.
 */
async function summary(tx: Tx): Promise<AdminBillingSummary> {
  const since = new Date(Date.now() - REVIEW_TRIAL_DAYS * 86_400_000).toISOString()
  const statusRows = await tx
    .select({
      status: billing_accounts.status,
      n: sql<number>`count(*)::int`,
      held: sql<number>`count(${billing_accounts.held_for_review_at})::int`,
      newTrials: sql<number>`(count(*) filter (where ${billing_accounts.held_for_review_at} is null and ${billing_accounts.created_at} > ${since} and ${billing_accounts.status} in ('pending_payment', 'trialing')))::int`,
    })
    .from(billing_accounts)
    .groupBy(billing_accounts.status)
  const [events] = await tx
    .select({
      unhandled: sql<number>`(count(*) filter (where ${stripe_events.last_error} like 'unhandled%'))::int`,
      failed: sql<number>`(count(*) filter (where (${stripe_events.last_error} is null or ${stripe_events.last_error} not like 'unhandled%') and ${stripe_events.attempts} >= ${STRIPE_EVENT_ATTEMPTS}))::int`,
      waiting: sql<number>`(count(*) filter (where (${stripe_events.last_error} is null or ${stripe_events.last_error} not like 'unhandled%') and ${stripe_events.attempts} < ${STRIPE_EVENT_ATTEMPTS}))::int`,
    })
    .from(stripe_events)
    .where(isNull(stripe_events.processed_at))
  const state = await selfServeState(tx)
  const bills: AdminBillingSummary['bills'] = {
    pending_payment: 0,
    trialing: 0,
    active: 0,
    past_due: 0,
    suspended: 0,
    canceled: 0,
    comped: 0,
  }
  for (const row of statusRows) bills[row.status] = row.n
  return {
    billing: await billingState(tx),
    selfServe: {
      on: state.on,
      open: state.open,
      closedBecause: state.closedBecause,
      termsMissing: [...legalTerms().missing],
    },
    bills,
    held: statusRows.reduce((sum, row) => sum + row.held, 0),
    newTrials: statusRows.reduce((sum, row) => sum + row.newTrials, 0),
    events: { waiting: events?.waiting ?? 0, failed: events?.failed ?? 0, unhandled: events?.unhandled ?? 0 },
    automaticTax: (await rulesData(tx)).effective.automaticTax,
  }
}

async function rulesData(tx: Tx): Promise<BillingRulesData> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))
  let stored: unknown = null
  try {
    stored = row ? JSON.parse(row.value) : null
  } catch {
    stored = null
  }
  const { rules, problems } = mergeBillingRules(row ? stored : undefined)
  const isObject = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
  return {
    stored: isObject ? (stored as Record<string, unknown>) : null,
    effective: rules,
    defaults: BILLING_DEFAULTS,
    problems,
    minMicrosPerMinute: minMicrosPerMinute(),
    minPlanCents: minPlanCents(rules),
  }
}

/** The switch, whether sign-up is open now and why not (self-serve.ts `selfServeState`), and the sign-up limits. */
async function selfServe(tx: Tx): Promise<SelfServeData> {
  const state = await selfServeState(tx)
  const { problems } = await storedSignupRules(tx)
  return {
    on: state.on,
    billingInEffect: (await billingState(tx)).inEffect === 'stripe',
    open: state.open,
    closedBecause: state.closedBecause,
    turnstileReady: !!(await turnstileKeys(tx)),
    rules: state.rules,
    defaults: SIGNUP_DEFAULTS,
    problems,
    termsMissing: [...legalTerms().missing],
  }
}

async function writeSetting(tx: Tx, key: string, value: string, actor: Actor, now: string) {
  await tx
    .insert(instance_settings)
    .values({ key, value, updated_at: now, updated_by: actor.actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
}

// ---- Money ----

/** The provider that refunds and changes seats: Stripe in effect, or a refusal (nothing is asked of `none`). */
async function stripeOrReject(tx: Tx, override?: BillingProvider): Promise<BillingProvider> {
  const provider = override ?? (await billingProvider(tx))
  if (provider.name === 'none') throw Reject.t('server.api.billingAdmin.stripeNotInEffect')
  return provider
}

/** Tests replace the provider the money actions use (a fake Stripe adapter); null: the one in effect. */
let providerOverride: BillingProvider | null = null
export function setBillingAdminProvider(provider: BillingProvider | null) {
  providerOverride = provider
}

type CreditInput = {
  billingAccountId: string
  kind: 'credit' | 'writeoff' | 'adjustment'
  amountCents: number
  reason: string
  requestId: string
  rechargeId?: string
  reversesEntryId?: string
}

/**
 * An attempt credited by hand was paid another way: its Stripe invoice is voided first (a draft deleted), so neither
 * Stripe's retries nor the customer can pay it as well (security review of #919, L6). An invoice already paid in Stripe
 * stays: its `invoice.paid` posts under the same source key as this credit, so the money is credited once.
 */
async function voidRechargeInvoice(tx: Tx, attempt: typeof billing_recharges.$inferSelect) {
  if (attempt.status === 'paid') return
  const provider = providerOverride ?? (await billingProvider(tx))
  if (provider.name === 'none') {
    if (attempt.stripe_invoice_id) throw Reject.t('server.api.billingAdmin.attemptHasInvoice')
    return
  }
  const invoiceId = attempt.stripe_invoice_id ?? (await provider.findRechargeInvoice(attempt.id))
  if (!invoiceId) return
  const invoice = await provider.invoice(invoiceId)
  if (invoice?.status === 'paid') return
  await provider.stopRechargeInvoice(invoiceId, { void: true })
}

/** A hand credit for a recharge attempt (L6): under the attempt's own source key, and the attempt marked paid. */
async function creditRecharge(tx: Tx, bill: Bill, input: CreditInput, periodId: string, actor: Actor, now: string) {
  const [attempt] = await tx
    .select()
    .from(billing_recharges)
    .where(eq(billing_recharges.id, input.rechargeId!))
    .for('update')
  if (!attempt || attempt.billing_account_id !== bill.id) throw Reject.t('server.api.billingAdmin.noRechargeAttempt')
  if (attempt.amount_cents !== input.amountCents)
    throw Reject.t('server.api.billingAdmin.rechargeOwnAmount', { cents: String(attempt.amount_cents) })
  await voidRechargeInvoice(tx, attempt)
  const posted = await postEntry(tx, {
    billing_account_id: bill.id,
    period_id: periodId,
    kind: 'recharge',
    amount_micros: attempt.amount_cents * MICROS_PER_CENT,
    source_type: 'billing_recharge',
    source_id: attempt.id,
    actor_id: actor.actorId,
    note: `credited by hand: ${input.reason}`,
  })
  if (attempt.status !== 'paid')
    await tx
      .update(billing_recharges)
      .set({ status: 'paid', resolved_at: now })
      .where(eq(billing_recharges.id, attempt.id))
  return posted
}

async function credit(tx: Tx, actor: Actor, now: string, input: CreditInput) {
  refuseMoneyChange(actor)
  await requireLedgerGuards(tx)
  const balance = await lockBalance(tx, input.billingAccountId)
  const bill = await billOrReject(tx, input.billingAccountId)
  const period = await periodAt(tx, bill.id, now)
  if (!period) throw Reject.t('server.api.billingAdmin.entryNoPeriod')
  if (input.rechargeId) return creditRecharge(tx, bill, input, period.id, actor, now)
  const micros = input.amountCents * MICROS_PER_CENT
  if (input.kind === 'writeoff' && micros > -exact(balance.balance_micros))
    throw Reject.t('server.api.billingAdmin.writeoffTooLarge')
  if (input.reversesEntryId) {
    const [corrected] = await tx
      .select({ id: ledger_entries.id })
      .from(ledger_entries)
      .where(and(eq(ledger_entries.id, input.reversesEntryId), eq(ledger_entries.billing_account_id, bill.id)))
    if (!corrected) throw Reject.t('server.api.billingAdmin.noLedgerEntry')
  }
  return postEntry(tx, {
    billing_account_id: bill.id,
    period_id: period.id,
    kind: input.kind,
    amount_micros: micros,
    source_type: 'admin',
    source_id: input.requestId,
    reverses_entry_id: input.reversesEntryId ?? null,
    actor_id: actor.actorId,
    note: input.reason,
  })
}

type RefundInput = { billingAccountId: string; amountCents: number; reason: string; requestId: string }

/** The line of a paid invoice that put this payment on the balance. */
function paymentLine(invoice: BillingInvoice, payment: AdminRefundable, sourceId: string) {
  const items = invoice.lines.filter(l => l.kind === 'invoice_item')
  return payment.kind === 'recharge'
    ? items.find(l => l.rechargeId === sourceId)
    : items.length === 1
      ? items[0]
      : undefined
}

/** A pending refund younger than this may still be waiting on Stripe in its own request; an older one is settled. */
export const REFUND_SETTLE_AFTER_MS = 5 * 60_000
/** Stripe's idempotency key of a refund (also the credit note's `metadata.linedesk_refund`): its row's id. */
const refundKey = (refundId: string) => `refund_${refundId}`
const REFUND_MEMO = 'Refund of unused Linedesk balance'

type RefundRow = typeof billing_refunds.$inferSelect

/** Posts a refund Stripe made: the entry under Stripe's refund id, the row `posted`. Under the bill's balance lock. */
async function postRefund(tx: Tx, row: RefundRow, made: InvoiceRefund, now: string) {
  const posted = await postEntry(tx, {
    billing_account_id: row.billing_account_id,
    period_id: row.period_id,
    kind: 'refund',
    amount_micros: -row.amount_cents * MICROS_PER_CENT,
    source_type: 'stripe_refund',
    source_id: made.refundId ?? made.creditNoteId,
    actor_id: row.actor_id,
    note: `${REFUND_OF}${row.payment_entry_id}; credit_note=${made.creditNoteId}; ${row.reason}`,
  })
  await tx
    .update(billing_refunds)
    .set({
      status: 'posted',
      credit_note_id: made.creditNoteId,
      refunded_cents: made.refundedCents,
      ledger_entry_id: posted.entry.id,
      resolved_at: now,
    })
    .where(eq(billing_refunds.id, row.id))
  return { ...posted, creditNoteId: made.creditNoteId, refundedCents: made.refundedCents }
}

const voidRefund = (tx: Tx, row: RefundRow, now: string) =>
  tx.update(billing_refunds).set({ status: 'void', resolved_at: now }).where(eq(billing_refunds.id, row.id))

const isStale = (row: RefundRow, now: string) => Date.parse(row.created_at) <= Date.parse(now) - REFUND_SETTLE_AFTER_MS

/**
 * Settles the bill's pending refunds older than REFUND_SETTLE_AFTER_MS from Stripe (security review of #919, M2): a
 * credit note with the row's key means the money went back to the card, so its entry is posted now; none means Stripe
 * made no refund, and the row is `void`. Under the bill's balance lock (every refund of the bill holds it while it asks
 * Stripe). `posted`: the refunds that had no entry until now; `waiting`: a younger one is still pending.
 */
export async function settlePendingRefunds(tx: Tx, provider: BillingProvider, billId: string, now: string) {
  const pending = await tx
    .select()
    .from(billing_refunds)
    .where(and(eq(billing_refunds.billing_account_id, billId), eq(billing_refunds.status, 'pending')))
  const posted: { refundId: string; creditNoteId: string }[] = []
  let waiting = false
  for (const row of pending) {
    if (!isStale(row, now)) {
      waiting = true
      continue
    }
    const made = await provider.findRefund(row.stripe_invoice_id, refundKey(row.id))
    if (made) {
      await postRefund(tx, row, made, now)
      posted.push({ refundId: row.id, creditNoteId: made.creditNoteId })
    } else await voidRefund(tx, row, now)
  }
  return { posted, waiting }
}

/** Asks Stripe for the row's refund (its own idempotency key: asked again, Stripe answers the same) and posts it. */
async function makeRefund(tx: Tx, provider: BillingProvider, row: RefundRow, now: string) {
  const made = await provider.refundInvoice({
    invoiceId: row.stripe_invoice_id,
    lineId: row.stripe_line_id,
    amountCents: row.amount_cents,
    idempotencyKey: refundKey(row.id),
    memo: REFUND_MEMO,
  })
  return postRefund(tx, row, made, now)
}

/** The same dialog sent again: its own refund finished (posted, or asked of Stripe again), never a second one. */
async function finishOwnRefund(tx: Tx, provider: BillingProvider, own: RefundRow, input: RefundInput, now: string) {
  if (own.billing_account_id !== input.billingAccountId || own.amount_cents !== input.amountCents)
    throw Reject.t('server.api.billingAdmin.refundIdReused')
  if (own.status === 'posted') {
    const [entry] = await tx.select().from(ledger_entries).where(eq(ledger_entries.id, own.ledger_entry_id!))
    return { entry: entry!, posted: false, creditNoteId: own.credit_note_id!, refundedCents: own.refunded_cents! }
  }
  if (own.status === 'void') throw Reject.t('server.api.billingAdmin.refundNotMade')
  const made = await provider.findRefund(own.stripe_invoice_id, refundKey(own.id))
  if (made) return postRefund(tx, own, made, now)
  // Past Stripe's idempotency window the same key could refund twice: an old request is given up, not asked again.
  if (isStale(own, now)) {
    await voidRefund(tx, own, now)
    throw Reject.t('server.api.billingAdmin.refundNotMade')
  }
  return makeRefund(tx, provider, own, now)
}

async function refund(tx: Tx, actor: Actor, now: string, input: RefundInput) {
  refuseMoneyChange(actor)
  await requireLedgerGuards(tx)
  const provider = await stripeOrReject(tx, providerOverride ?? undefined)
  await lockBalance(tx, input.billingAccountId)
  const bill = await billOrReject(tx, input.billingAccountId)
  const [own] = await tx.select().from(billing_refunds).where(eq(billing_refunds.request_id, input.requestId))
  if (own) return finishOwnRefund(tx, provider, own, input, now)
  // An earlier refund of this bill that did not finish is settled first: what it paid out counts below.
  const { waiting } = await settlePendingRefunds(tx, provider, bill.id, now)
  if (waiting) throw Reject.t('server.api.billingAdmin.refundWaiting')
  const balance = await lockBalance(tx, bill.id)
  const micros = input.amountCents * MICROS_PER_CENT
  const available = exact(balance.balance_micros) - exact(balance.reserved_micros)
  if (micros > available) throw Reject.t('server.api.billingAdmin.refundAboveAvailable')
  // Newest payments first (docs/billing.md §4.5): the newest one with something left to refund.
  const payment = (await refundablePayments(tx, bill.id)).find(p => p.creditedMicros > p.refundedMicros)
  if (!payment) throw Reject.t('server.api.billingAdmin.nothingToRefund')
  if (micros > payment.creditedMicros - payment.refundedMicros)
    throw Reject.t('server.api.billingAdmin.refundOnePayment')
  // The period the entry posts in is known before Stripe is asked (M1): the current one, else the bill's latest (a
  // refund after the bill ended, docs/billing.md decision 10). A bill without any period is refused here.
  const period = await periodForMoney(tx, bill.id, now)
  if (!period) throw Reject.t('server.api.billingAdmin.refundNoPeriod')
  const [entry] = await tx.select().from(ledger_entries).where(eq(ledger_entries.id, payment.entryId))
  const invoiceId =
    payment.invoiceId ?? (payment.kind === 'topup' ? await provider.checkoutInvoice(entry!.source_id) : null)
  if (!invoiceId) throw Reject.t('server.api.billingAdmin.refundInvoiceUnknown')
  const invoice = await provider.invoice(invoiceId)
  if (invoice?.status !== 'paid' || !bill.stripe_customer_id || invoice.customerId !== bill.stripe_customer_id)
    throw Reject.t('server.api.billingAdmin.refundInvoiceNotPaid')
  const line = paymentLine(invoice, payment, entry!.source_id)
  if (!line || line.amountCents < input.amountCents) throw Reject.t('server.api.billingAdmin.refundLineTooSmall')
  const blockers = await provider.refundBlockers(invoiceId)
  if (blockers.length) throw Reject.t('server.api.billingAdmin.refundBlocked', { blockers: blockers.join(', ') })
  // Committed before Stripe is asked (M2): if anything fails once Stripe refunded, this row is how the refund is found
  // and posted. On ownCommitDb, never the main pool: this transaction keeps the balance lock, and the bill's other
  // transactions queued on it can fill the main pool, which would then wait on this write forever (re-review R2).
  const [row] = await ownCommitDb
    .insert(billing_refunds)
    .values({
      id: `rf_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      billing_account_id: bill.id,
      request_id: input.requestId,
      payment_entry_id: payment.entryId,
      stripe_invoice_id: invoiceId,
      stripe_line_id: line.id,
      amount_cents: input.amountCents,
      period_id: period.id,
      actor_id: actor.actorId,
      reason: input.reason,
      created_at: now,
    })
    .returning()
  return makeRefund(tx, provider, row!, now)
}

type MoveInput = { workspaceId: string; toBillingAccountId: string; reason: string; requestId: string }

/**
 * Seats follow the workspaces (docs/billing.md §2.1): the bill's subscription is set to its workspaces as committed now,
 * the target grows (yearly: paid now), the source shrinks (no refund). Runs after the move committed (`onCommit`,
 * security review of #919, M2), so Stripe never charges for a move that did not happen; a failure here is logged and
 * the nightly reconciliation reports the bill's seats (`quantity`) until a recount fixes them.
 */
async function followSeats(provider: BillingProvider, bill: Bill, grows: boolean, requestId: string) {
  if (!bill.stripe_subscription_id) return
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, bill.id))
  await provider.setSeatQuantity({
    subscriptionId: bill.stripe_subscription_id,
    quantity: count?.n ?? 0,
    prorationBehavior: !grows ? 'none' : bill.interval === 'year' ? 'always_invoice' : 'create_prorations',
    idempotencyKey: `move_${requestId}_${bill.id}`,
  })
}

async function moveSeats(provider: BillingProvider, from: Bill, to: Bill, requestId: string, extraCalls: boolean) {
  // The source shrinks first: a target charged while the source still counts the workspace is what M2 was about.
  for (const [bill, grows] of [
    [from, false],
    [to, true],
  ] as const) {
    await followSeats(provider, bill, grows, requestId).catch(e =>
      console.error(`ALERT billing seats: bill ${bill.id} not updated after a move (${requestId})`, e),
    )
    // Extra calls at the same time follow the workspace too (LIN-450): under each bill's own lock, the sum as it is
    // then (security review of #1103, L-3); the target pays above what it already paid this period, the source is not
    // refunded. A failure is emailed to the admins.
    if (extraCalls) await syncExtraCallsItem(provider, bill.id, { charge: grows, key: `move_extra_calls_${requestId}` })
  }
}

async function moveWorkspace(
  tx: Tx,
  actor: Actor,
  input: MoveInput,
  onCommit: ((work: () => Promise<void>) => void) | undefined,
) {
  refuseMoneyChange(actor)
  const [seen] = await tx
    .select({ id: organization.id, bill: organization.billingAccountId, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, input.workspaceId))
  if (!seen) throw Reject.t('server.api.billingAdmin.noWorkspace')
  // A client workspace is always on its partner's bill, and a partner bill pays only for its own clients
  // (docs/white-label.md): those change with the partner (workspace.createForClient, partner.releaseClient,
  // workspace.removePartner), never by a move here.
  if (seen.partnerId) throw new Reject(CLIENT_STAYS_ON_PARTNER_BILL)
  const [target] = await tx
    .select({ kind: billing_accounts.kind })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, input.toBillingAccountId))
  if (target?.kind === 'partner') throw new Reject(CLIENT_STAYS_ON_PARTNER_BILL)
  if (!seen.bill) throw Reject.t('server.api.billingAdmin.moveNoBill')
  if (seen.bill === input.toBillingAccountId) throw Reject.t('server.api.billingAdmin.moveSameBill')
  // Both balance rows, in id order (the lock order of every bill path; two moves never deadlock).
  for (const id of [seen.bill, input.toBillingAccountId].sort()) await lockBalance(tx, id)
  // Read again under the locks (security review of #919, L3): a move that ran meanwhile changed it, and this one would
  // act on a bill the workspace already left.
  const [workspace] = await tx
    .select({ id: organization.id, bill: organization.billingAccountId, extraCalls: organization.extraCalls })
    .from(organization)
    .where(eq(organization.id, input.workspaceId))
    .for('update')
  if (workspace?.bill !== seen.bill) throw Reject.t('server.api.billingAdmin.moveMovedMeanwhile')
  const from = await billOrReject(tx, seen.bill)
  const to = await billOrReject(tx, input.toBillingAccountId)
  if (to.status === 'canceled') throw Reject.t('server.api.billingAdmin.moveToCanceled')
  // A bill in its trial (or still before Checkout) holds at most the sign-up rules' trial workspaces (security review of
  // #1097, L-3). Moving is the one way a workspace joins a bill after sign-up, so the limit is enforced here; the
  // balance lock above keeps two moves onto the same bill from both passing it.
  if (to.status === 'trialing' || to.status === 'pending_payment') {
    const rules = await signupRules(tx)
    // A partner bill has no trial and takes no move (refused above).
    const cap = rules.trialWorkspacesCloud
    if ((await workspacesOnBill(tx, to.id)).length >= cap)
      throw Reject.t('server.api.trialWorkspaceLimit', { count: cap })
  }
  // A running call's usage posts to the bill it started on (L3); while one runs, the workspace stays.
  const [running] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(call_reservations)
    .innerJoin(calls, eq(calls.id, call_reservations.call_id))
    .where(eq(calls.workspace_id, workspace.id))
  if ((running?.n ?? 0) > 0) throw Reject.t('server.api.billingAdmin.moveCallsRunning')
  const seats = !!from.stripe_subscription_id || !!to.stripe_subscription_id
  const provider = seats ? await stripeOrReject(tx, providerOverride ?? undefined) : null
  if (provider && !onCommit) throw new Error('billing.moveWorkspace changes seats after the commit: no onCommit given')
  await tx
    .update(organization)
    // Extra calls are bought on a paid plan: onto a bill without a subscription (trial, comped) the workspace leaves
    // them behind (LIN-450).
    .set({
      billingAccountId: to.id,
      billingState: mirroredState(to.status),
      ...(to.stripe_subscription_id ? {} : { extraCalls: 0 }),
    })
    .where(eq(organization.id, workspace.id))
  if (provider) onCommit!(() => moveSeats(provider, from, to, input.requestId, workspace.extraCalls > 0))
  return { from: from.id, to: to.id }
}

/**
 * An instance admin's suspension (Server admin › Billing: suspend, or deny a held bill). It remembers the status it came
 * from for resume (R3); a bill already suspended (by dunning or a dispute) keeps what it had.
 */
async function suspendByAdmin(tx: Tx, bill: Bill, now: string) {
  const suspended_from =
    bill.status === 'suspended' ? bill.suspended_from : bill.status === 'canceled' ? null : bill.status
  await tx
    .update(billing_accounts)
    .set({ status: 'suspended', suspended_at: now, suspend_reason: 'admin', suspended_from, updated_at: now })
    .where(eq(billing_accounts.id, bill.id))
  await mirrorState(tx, bill.id, 'suspended')
}

type StatusInput = { billingAccountId: string; status: 'comped' | 'suspended' | 'active'; reason: string }

async function setStatus(tx: Tx, actor: Actor, now: string, input: StatusInput) {
  refuseMoneyChange(actor)
  await lockBalance(tx, input.billingAccountId)
  const bill = await billOrReject(tx, input.billingAccountId)
  if (bill.status === 'canceled') throw Reject.t('server.api.billingAdmin.canceledStays')
  // Resume lifts only what an admin can set here (security review of #919, L2): a bill waiting for its first payment
  // goes through Checkout, a past-due one through its unpaid invoice (dunning keeps its clock).
  if (input.status === 'active' && bill.status !== 'suspended' && bill.status !== 'comped')
    throw Reject.t('server.api.billingAdmin.resumeOnly')
  if (input.status === 'suspended') {
    await suspendByAdmin(tx, bill, now)
    return { status: 'suspended' as const, previous: bill.status }
  }
  // Resume goes back to what an admin suspension came from (re-review of #919, R3): a bill waiting for Checkout keeps
  // waiting, a past-due one keeps its dunning clock (past_due_since), a comped one stays comped.
  const from = input.status === 'active' && bill.status === 'suspended' ? bill.suspended_from : null
  const kept = from === 'pending_payment' || from === 'past_due' || from === 'comped' ? from : null
  // Otherwise back in service: trialing while the trial runs, else active.
  const resumed = bill.trial_ends_at && bill.trial_ends_at > now && !bill.stripe_subscription_id ? 'trialing' : 'active'
  const status = input.status === 'active' ? (kept ?? resumed) : input.status
  const cleared = { suspended_at: null, suspend_reason: null, suspended_from: null, updated_at: now }
  await tx
    .update(billing_accounts)
    .set(kept ? { status, ...cleared } : { status, ...cleared, past_due_since: null })
    .where(eq(billing_accounts.id, bill.id))
  await mirrorState(tx, bill.id, status)
  return { status, previous: bill.status }
}

// ---- Handlers ----

export const billingAdminHandlers: Record<string, Handler> = {
  'billing.adminBills': async ({ tx }) => ({ rows: {}, data: { bills: await billRows(tx) } }),
  'billing.adminBill': async ({ tx }, input: { billingAccountId: string }) => ({
    rows: {},
    data: await billDetail(tx, input.billingAccountId),
  }),
  'billing.adminEvents': async ({ tx }, input: { filter?: BillingEventFilter; before?: string }) => ({
    rows: {},
    data: await events(tx, input.filter ?? 'all', input.before),
  }),
  'billing.adminReview': async ({ tx }) => ({ rows: {}, data: await reviewList(tx) }),
  'billing.adminSummary': async ({ tx }) => ({ rows: {}, data: await summary(tx) }),
  'billingRules.get': async ({ tx }) => ({ rows: {}, data: await rulesData(tx) }),
  // What turning Stripe Tax on would mean for paying customers (review #1105, M-1), asked by the confirm dialog only.
  // Through the pool, never the caller's connection: Stripe is asked with no transaction open (N-1).
  'billing.adminTaxAddressMissing': async () => ({
    rows: {},
    data: { taxAddressMissing: await customersWithoutTaxAddress(db) },
  }),
  'signup.getSelfServe': async ({ tx }) => ({ rows: {}, data: await selfServe(tx) }),

  'billing.credit': async ({ tx, actor, now }, input: CreditInput) => {
    const { entry, posted } = await credit(tx, actor, now, input)
    return { rows: {}, data: { entryId: entry.id, posted, amountMicros: exact(entry.amount_micros) } }
  },

  'billing.refund': async ({ tx, actor, now }, input: RefundInput) => {
    const made = await refund(tx, actor, now, input)
    return {
      rows: {},
      data: {
        entryId: made.entry.id,
        posted: made.posted,
        creditNoteId: made.creditNoteId,
        refundedCents: made.refundedCents,
      },
    }
  },

  'billing.adminSetStatus': async ({ tx, actor, now }, input: StatusInput) => ({
    rows: {},
    data: await setStatus(tx, actor, now, input),
  }),

  'billing.setCap': async ({ tx, actor, now }, input: { billingAccountId: string; capBaseCents: number }) => {
    refuseMoneyChange(actor)
    await lockBalance(tx, input.billingAccountId)
    const bill = await billOrReject(tx, input.billingAccountId)
    await tx
      .update(billing_accounts)
      .set({ recharge_cap_base_cents: input.capBaseCents, updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
    return { rows: {}, data: { previous: bill.recharge_cap_base_cents, capBaseCents: input.capBaseCents } }
  },

  'billing.setConcurrency': async (
    { tx, actor, now },
    input: { billingAccountId: string; concurrentCalls: number | null },
  ) => {
    refuseMoneyChange(actor)
    await lockBalance(tx, input.billingAccountId)
    const bill = await billOrReject(tx, input.billingAccountId)
    await tx
      .update(billing_accounts)
      .set({ concurrent_calls_cap: input.concurrentCalls, updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
    return { rows: {}, data: { previous: bill.concurrent_calls_cap, concurrentCalls: input.concurrentCalls } }
  },

  'billing.moveWorkspace': async ({ tx, actor, onCommit }, input: MoveInput) => ({
    rows: {},
    data: await moveWorkspace(tx, actor, input, onCommit),
  }),

  'billing.transferOwner': async ({ tx, actor, now }, input: { billingAccountId: string; userId: string }) => {
    refuseMoneyChange(actor)
    await lockBalance(tx, input.billingAccountId)
    const bill = await billOrReject(tx, input.billingAccountId)
    if (bill.kind === 'partner') throw new Reject(PARTNER_BILL_STAYS)
    if (bill.owner_user_id === input.userId) throw Reject.t('server.api.billingAdmin.ownerAlready')
    const [isMember] = await tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(and(eq(member.userId, input.userId), eq(organization.billingAccountId, bill.id)))
      .limit(1)
    if (!isMember) throw Reject.t('server.api.billingAdmin.ownerNotMember')
    await tx
      .update(billing_accounts)
      .set({ owner_user_id: input.userId, updated_at: now })
      .where(eq(billing_accounts.id, bill.id))
    return { rows: {}, data: { previous: bill.owner_user_id, owner: input.userId } }
  },

  'billing.reviewHold': async (
    { tx, actor, now },
    input: { billingAccountId: string; decision: 'approve' | 'deny' },
  ) => {
    refuseMoneyChange(actor)
    await lockBalance(tx, input.billingAccountId)
    const bill = await billOrReject(tx, input.billingAccountId)
    if (!bill.held_for_review_at) throw Reject.t('server.api.billingAdmin.notHeld')
    // A canceled bill stays canceled (L2): a deny would make it suspended, and a later resume would revive it.
    if (input.decision === 'deny' && bill.status === 'canceled')
      throw Reject.t('server.api.billingAdmin.canceledStaysApprove')
    if (input.decision === 'approve')
      await tx
        .update(billing_accounts)
        .set({ held_for_review_at: null, updated_at: now })
        .where(eq(billing_accounts.id, bill.id))
    else {
      await suspendByAdmin(tx, bill, now)
    }
    return { rows: {}, data: { decision: input.decision } }
  },

  'billingRules.set': async (
    { tx, actor, now, onCommit },
    input: { rules: Record<string, unknown>; reason: string },
  ) => {
    refuseMoneyChange(actor)
    const checked = checkBillingRules(withoutResets(input.rules))
    if (checked.problems.length)
      throw Reject.t('server.api.billingAdmin.rulesInvalid', { fields: checked.problems.join(', ') })
    // Merged over the stored row (I-6): a field left out keeps its value, null resets it to the default.
    const before = (await rulesData(tx)).stored ?? {}
    const next = mergeStoredRules(before, input.rules)
    // The plan fees as they would be in effect: a floor, and yearly at most 12 monthly fees (L-6).
    const effective = mergeBillingRules(next).rules
    const planProblems = planPriceProblems(effective)
    if (planProblems.length)
      throw new Reject(
        // i18n-ignore: the API error body for logs and API clients; the web app shows admin.bills.rules.planFloor by its code
        `These plan prices are below the server's minimum ($${(minPlanCents(effective) / 100).toFixed(2)} a month, 12 times that a year) or a yearly price is more than 12 monthly ones: ${planProblems.join(', ')}. Nothing was changed.`,
        PLAN_PRICE_FLOOR,
      )
    await writeSetting(tx, BILLING_RULES_KEY, JSON.stringify(next), actor, now)
    const keys = [...new Set([...Object.keys(before), ...Object.keys(next)])].sort()
    const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
    const fields = Object.keys(next).length ? changed : []
    onCommit?.(async () =>
      alertInstanceAdmins(billingRulesAlert({ actor: await alertActor(actor), fields, reason: input.reason })),
    )
    // Changed plan prices reach Stripe now, not at a customer's Checkout (security review of #1040, M-1).
    if (changed.some(k => PLAN_RULE_FIELDS.has(k))) syncCatalogAfterCommit(onCommit)
    // The Stripe Tax switch reaches running subscriptions too, not only new Checkouts (security review of #1105, M-1).
    if (mergeBillingRules(before).rules.automaticTax !== effective.automaticTax)
      syncSubscriptionTaxAfterCommit(db, onCommit)
    return { rows: {}, data: { ...(await rulesData(tx)), changed } }
  },

  'signup.setSelfServe': async ({ tx, actor, now, onCommit }, input: { on: boolean; reason: string }) => {
    // On opens the install to anyone: the same check as the money actions. Off is open to every instance admin.
    if (input.on) refuseMoneyChange(actor)
    const before = await selfServe(tx)
    if (input.on && !before.billingInEffect) throw Reject.t('server.api.billingAdmin.selfServeNeedsStripe')
    // No contract without terms (A9): the links and versions come from the environment, never from this page.
    if (input.on && before.termsMissing.length)
      throw Reject.t('server.api.signup.termsMissing', { vars: before.termsMissing.join(', ') })
    await writeSetting(tx, SELF_SERVE_KEY, input.on ? 'on' : 'off', actor, now)
    if (before.on !== input.on)
      onCommit?.(async () =>
        alertInstanceAdmins(selfServeAlert({ actor: await alertActor(actor), on: input.on, reason: input.reason })),
      )
    return { rows: {}, data: await selfServe(tx) }
  },

  'signup.setRules': async (
    { tx, actor, now, onCommit },
    input: { rules: Record<string, unknown>; reason: string },
  ) => {
    // Looser limits or no bot check open the install to abuse: the same check as the money actions.
    refuseMoneyChange(actor)
    const problems = signupRulesProblems(input.rules)
    if (problems.length) throw Reject.t('server.api.signupRules.invalid', { fields: problems.join(', ') })
    const change = { ...input.rules }
    if (Array.isArray(change.blockedDomains))
      change.blockedDomains = [...new Set((change.blockedDomains as string[]).map(d => d.trim().toLowerCase()))]
    // Merged over the stored row: a field left out keeps its value, null resets it to the default.
    const stateBefore = await selfServeState(tx)
    const before = (await storedSignupRules(tx)).stored ?? {}
    const next = mergeStoredRules(before, change)
    await writeSetting(tx, SIGNUP_RULES_KEY, JSON.stringify(next), actor, now)
    const keys = [...new Set([...Object.keys(before), ...Object.keys(next)])].sort()
    const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
    // Old and new values in effect (security review of #1097, L-1): the command's result keeps them, so the audit log
    // shows what each rule was before; the email names them, and says so when this change opened sign-up.
    const stateAfter = await selfServeState(tx)
    const ruleChanges = signupRuleChanges(stateBefore.rules, stateAfter.rules)
    const opened = !stateBefore.open && stateAfter.open
    if (ruleChanges.length || opened)
      onCommit?.(async () =>
        alertInstanceAdmins(
          signupRulesAlert({ actor: await alertActor(actor), changes: ruleChanges, opened, reason: input.reason }),
        ),
      )
    return { rows: {}, data: { ...(await selfServe(tx)), changed, ruleChanges } }
  },
}
