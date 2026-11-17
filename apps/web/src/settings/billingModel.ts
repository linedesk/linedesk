// Settings › Billing (Billing.tsx): what the page decides from the bill, without React, so it can be tested. Money
// arrives in cents (prices, recharges) or micro-dollars (the balance, usage); the page shows dollars through
// useFormat().currency.
import type {
  BillingCalls,
  BillingOverviewBill,
  BillingStateBill,
  BillingUsageRow,
  TrialMinutesPrompt,
  BusyLinePrompt,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import type { Me } from '../auth.ts'

/** Settings › Billing opens the add-calls dialog (`?addCalls=1`; the busy-line email and banner link there, LIN-450). */
export const ADD_CALLS_PARAM = 'addCalls'

export const centsToDollars = (cents: number) => cents / 100
export const microsToDollars = (micros: number) => micros / 1_000_000

/** "Buy minutes" amounts offered at once (docs/billing.md §3.2 step 7), in cents; any other within the limits. */
export const TOP_UP_CHOICES = [500, 1000, 2000] as const

/** Whole dollars typed by the owner → cents, or null when it is not a whole number of dollars in range. */
export function dollarsToCents(text: string, min: number, max: number): number | null {
  const trimmed = text.trim().replace(/^\$/, '')
  if (!/^\d{1,6}$/.test(trimmed)) return null
  const cents = Number(trimmed) * 100
  return cents >= min && cents <= max ? cents : null
}

/** Whole days from now until `iso`, at least 0 (the trial countdown). */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000))
}

/**
 * The status badge's words and tone. A bill held for review says so, not "Active": no number can be bought until the
 * review is done (docs/billing.md §3.2 step 5).
 */
export function statusBadge(
  status: BillingOverviewBill['status'],
  heldForReview = false,
): {
  key: MessageKey
  tone: 'neutral' | 'ok' | 'info' | 'danger'
} {
  if (heldForReview && (status === 'active' || status === 'trialing'))
    return { key: msg('settings.billing.status.held'), tone: 'info' }
  switch (status) {
    case 'trialing':
      return { key: msg('settings.billing.status.trialing'), tone: 'info' }
    case 'active':
      return { key: msg('settings.billing.status.active'), tone: 'ok' }
    case 'comped':
      return { key: msg('settings.billing.status.comped'), tone: 'ok' }
    case 'past_due':
      return { key: msg('settings.billing.status.pastDue'), tone: 'danger' }
    case 'suspended':
      return { key: msg('settings.billing.status.suspended'), tone: 'danger' }
    case 'canceled':
      return { key: msg('settings.billing.status.canceled'), tone: 'neutral' }
    default:
      return { key: msg('settings.billing.status.pending'), tone: 'neutral' }
  }
}

/** What the plan card says about its dates: the trial's end, the renewal, or the end after a cancellation. */
export type PlanLine = { key: MessageKey; date: string; days?: number } | null

export function planLine(bill: BillingOverviewBill, now = Date.now()): PlanLine {
  if (bill.status === 'trialing' && bill.trialEndsAt)
    return bill.cancelAtPeriodEnd
      ? {
          key: msg('settings.billing.plan.trialEndsCanceled'),
          date: bill.trialEndsAt,
          days: daysLeft(bill.trialEndsAt, now),
        }
      : { key: msg('settings.billing.plan.trialEnds'), date: bill.trialEndsAt, days: daysLeft(bill.trialEndsAt, now) }
  if (!bill.currentPeriodEnd || !['active', 'past_due'].includes(bill.status)) return null
  return bill.cancelAtPeriodEnd
    ? { key: msg('settings.billing.plan.ends'), date: bill.currentPeriodEnd }
    : { key: msg('settings.billing.plan.renews'), date: bill.currentPeriodEnd }
}

/**
 * Whether the plan can be canceled or resumed here (`billing.cancel`): a running plan, or one whose calls are paused
 * (suspended). The Stripe portal has no cancel, so this is the one place to cancel.
 */
const CANCELS = ['trialing', 'active', 'past_due', 'suspended']
export const canCancel = (bill: BillingOverviewBill) => CANCELS.includes(bill.status) && !bill.cancelAtPeriodEnd
export const canResume = (bill: BillingOverviewBill) => CANCELS.includes(bill.status) && bill.cancelAtPeriodEnd
/** Auto-recharge and the cap change while the plan runs (the server refuses otherwise). */
export const changesRecharge = (bill: BillingOverviewBill) => ['trialing', 'active', 'past_due'].includes(bill.status)

/**
 * The state note in plain words (billing.state, docs/billing.md §3.4): why the plan is not running normally and what
 * happens next. Null while it runs normally.
 */
export type StateNote = {
  tone: 'warning' | 'danger'
  title: MessageKey
  text: MessageKey
  values: Record<string, string>
}

export function stateNote(state: BillingStateBill | null, fmtDate: (iso: string) => string): StateNote | null {
  if (!state) return null
  const date = (iso: string | null) => (iso ? fmtDate(iso) : '')
  if (state.status === 'past_due')
    return {
      tone: 'warning',
      title: msg('settings.billing.state.pastDue.title'),
      text: state.suspendsAt
        ? msg('settings.billing.state.pastDue.text')
        : msg('settings.billing.state.pastDue.textNoDate'),
      values: { date: date(state.suspendsAt) },
    }
  if (state.status === 'suspended') {
    const reason = state.suspendedReason ?? 'admin'
    const text: Record<typeof reason, MessageKey> = {
      payment: msg('settings.billing.state.suspended.payment'),
      dispute: msg('settings.billing.state.suspended.dispute'),
      early_fraud_warning: msg('settings.billing.state.suspended.fraud'),
      admin: msg('settings.billing.state.suspended.admin'),
    }
    return {
      tone: 'danger',
      title: msg('settings.billing.state.suspended.title'),
      text:
        reason === 'payment' && !state.cancelsAt ? msg('settings.billing.state.suspended.paymentNoDate') : text[reason],
      values: { date: date(state.cancelsAt) },
    }
  }
  if (state.status === 'canceled')
    return {
      tone: 'danger',
      title: msg('settings.billing.state.canceled.title'),
      text: state.numbersReleaseAt
        ? msg('settings.billing.state.canceled.text')
        : msg('settings.billing.state.canceled.textNoNumbers'),
      values: { numbers: date(state.numbersReleaseAt), data: date(state.dataUntil) },
    }
  return null
}

/** Whether the bill pays anything: a comped bill has no plan fee, no balance to recharge and free numbers. */
export const paysCharges = (bill: Pick<BillingOverviewBill, 'status'>) => bill.status !== 'comped'

/** How long after a payment a yearly plan is refunded in full on request (the terms, docs/billing.md §3.2 step 10). */
export const YEARLY_REFUND_DAYS = 14

/**
 * The cancel dialog's line about the plan fee already paid (the terms' "Refunds"; docs/billing.md §4.5): a yearly plan
 * paid in the last 14 days is refunded in full on request, until when; later, the rest of the year is not refunded.
 * Nothing for a monthly plan or in the trial (nothing was charged).
 */
export type RefundLine = { key: MessageKey; values: Record<string, string> } | null

export function yearlyRefundLine(
  bill: Pick<BillingOverviewBill, 'status' | 'interval' | 'invoices'>,
  fmtDate: (iso: string) => string,
  now = Date.now(),
): RefundLine {
  if (bill.interval !== 'year' || bill.status === 'trialing') return null
  const paid = bill.invoices
    .filter(i => i.kind === 'subscription' && i.status === 'paid' && i.totalCents > 0)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const until = paid ? Date.parse(paid.createdAt) + YEARLY_REFUND_DAYS * 86_400_000 : 0
  if (paid && until > now)
    return {
      key: msg('settings.billing.cancel.yearlyRefund'),
      values: { date: fmtDate(new Date(until).toISOString()) },
    }
  return { key: msg('settings.billing.cancel.yearlyNoRefund'), values: {} }
}

/** One workspace's usage line: billed minutes per level (rounded up) and what they cost, in micro-dollars. */
export function usageLine(row: BillingUsageRow) {
  const minutes = (seconds: number | undefined) => Math.ceil((seconds ?? 0) / 60)
  const levels = row.levels
  return {
    includedUsedMinutes: Math.min(minutes(row.allowanceUsedSeconds), Math.floor(row.allowanceSeconds / 60)),
    includedMinutes: Math.floor(row.allowanceSeconds / 60),
    standard: minutes(levels.standard?.seconds),
    premium: minutes(levels.premium?.seconds),
    ultra: minutes(levels.ultra?.seconds),
    ownKeys: minutes(levels.own_keys?.seconds),
    costMicros: Object.values(levels).reduce((sum, l) => sum + (l?.micros ?? 0), 0),
  }
}

/** The text of a refusal by its code (apps/api/src/billing-page.ts BILLING_PAGE_CODES); null: show the generic one. */
export function refusalKey(code: string | undefined): MessageKey | null {
  switch (code) {
    case 'billing_not_running':
      return msg('settings.billing.error.notRunning')
    case 'billing_cap_above_owner_max':
      return msg('settings.billing.error.capAboveMax')
    case 'billing_retry_limit':
      return msg('settings.billing.error.retryLimit')
    case 'billing_no_failed_recharge':
      return msg('settings.billing.error.noFailure')
    case 'billing_no_customer':
      return msg('settings.billing.error.noCustomer')
    case 'billing_auto_recharge_off':
      return msg('settings.billing.error.autoRechargeOff')
    case 'billing_invoice_page_unavailable':
      return msg('settings.billing.error.invoicePageUnavailable')
    case 'billing_extra_calls_paid_plan':
      return msg('settings.billing.error.extraCallsPaidPlan')
    case 'billing_extra_calls_above_max':
      return msg('settings.billing.error.extraCallsAboveMax')
    case 'billing_workspace_not_on_bill':
      return msg('settings.billing.error.notOnBill')
    case 'billing_extra_calls_canceling':
      return msg('settings.billing.error.extraCallsCanceling')
    case 'billing_extra_calls_payment_failed':
      return msg('settings.billing.error.extraCallsPaymentFailed')
    case 'billing_extra_calls_too_often':
      return msg('settings.billing.error.extraCallsTooOften')
    case 'billing_extra_calls_renewing':
      return msg('settings.billing.error.extraCallsRenewing')
    case 'SIGN_IN_AGAIN':
      return msg('settings.billing.error.signInAgain')
    default:
      return null
  }
}

/**
 * The extra calls a workspace can pick (LIN-450): none, then every step up to the most per workspace; the workspace's
 * own number too when it is not one of them (an admin lowered the most since).
 */
export function extraCallChoices(calls: Pick<BillingCalls, 'step' | 'maxExtra'>, current = 0): number[] {
  const choices: number[] = []
  for (let extra = 0; extra <= calls.maxExtra; extra += calls.step) choices.push(extra)
  if (!choices.includes(current)) choices.push(current)
  return choices.sort((a, b) => a - b)
}

/**
 * A raise that costs nothing now: the bill's new total of extra calls stays within what this billing period already
 * paid for (lowering is never refunded, so going back up to it is free).
 */
export function freeExtraCalls(
  calls: Pick<BillingCalls, 'paidExtra' | 'workspaces'>,
  change: { workspaceId: string; to: number },
): boolean {
  const total = calls.workspaces.reduce(
    (sum, w) => sum + (w.workspaceId === change.workspaceId ? change.to : w.extraCalls),
    0,
  )
  return total <= calls.paidExtra
}

/**
 * Whether a failed call may still have done its work: no answer reached us (network) or the server failed (5xx). A
 * refusal (4xx) is a definite answer, stored under its command id (security review of #1102, L-1).
 */
export const outcomeUnknown = (err: unknown) => {
  const status = (err as { status?: number } | null)?.status
  return status === undefined || status >= 500
}

/**
 * One idempotency key per purchase with the saved card (security review of #1102, L-1): pressing "Charge" again after
 * a lost answer or a server error sends the same command, so the server finds the purchase it may have made instead
 * of charging again. A definite answer (paid, a refusal, Checkout) ends the purchase: the next press is a new one, as
 * is another amount or card (`what`).
 */
export function purchaseKeys(newKey: () => string = () => crypto.randomUUID()) {
  let held: { key: string; what: string } | null = null
  return {
    keyFor(what: string) {
      if (held?.what !== what) held = { key: newKey(), what }
      return held.key
    },
    /** After the call: `err` undefined for an answer; the key is kept only when the outcome is unknown. */
    settle(err?: unknown) {
      if (err === undefined || !outcomeUnknown(err)) held = null
    },
  }
}

/** Threshold and amount choices of auto-recharge (cents), within the server's limits and its $5 gap. */
export const THRESHOLD_CHOICES = [500, 1000, 2000, 5000, 10_000] as const
export const AMOUNT_CHOICES = [2000, 2500, 3000, 5000, 10_000, 20_000, 50_000] as const
export const amountFits = (thresholdCents: number, amountCents: number) => amountCents >= thresholdCents + 500

/**
 * The one-line banner above every page for the bill owner (docs/billing.md §3.4, §4.3, §11 PR 9), from `billing.state`
 * alone (a cheap read; review of #1007, I-4): the most pressing thing about the bill, or null. Paused calls first,
 * then a canceled plan, a failed payment, a card held for review, a failed recharge, an unpaid number, the trial
 * prompt (with its own button), the monthly cap reached, a low balance with auto-recharge off. It leads to Settings ›
 * Billing.
 */
export type BillingBanner = {
  key: MessageKey
  tone: 'warning' | 'danger'
  /** The trial prompt (docs/billing.md §3.2 step 7): the banner has "Keep calls answered" instead of the link. */
  trial?: TrialMinutesPrompt
  /** Callers got a busy line today (LIN-450): the banner offers one step more calls at the same time. */
  busy?: BusyLinePrompt
}

/** The trial prompt's line by its stage: minutes nearly used, used up (calls on the grace), the grace used too. */
const TRIAL_KEYS = {
  low: msg('settings.billing.banner.trialLow'),
  grace: msg('settings.billing.banner.trialGrace'),
  paused: msg('settings.billing.banner.trialPaused'),
} as const

export function billingBanner(state: BillingStateBill | null): BillingBanner | null {
  if (!state) return null
  if (state.status === 'suspended') return { key: msg('settings.billing.banner.suspended'), tone: 'danger' }
  if (state.status === 'canceled') return { key: msg('settings.billing.banner.canceled'), tone: 'danger' }
  if (state.status === 'past_due') return { key: msg('settings.billing.banner.pastDue'), tone: 'danger' }
  // Held for review: no number until it is done (docs/billing.md §3.2 step 5).
  if (state.heldForReview && (state.status === 'active' || state.status === 'trialing'))
    return { key: msg('settings.billing.banner.held'), tone: 'warning' }
  if (state.rechargeFailed)
    return state.rechargeNeedsAction
      ? { key: msg('settings.billing.banner.rechargeConfirm'), tone: 'danger' }
      : { key: msg('settings.billing.banner.rechargeFailed'), tone: 'danger' }
  if (state.unpaidNumbers.length) return { key: msg('settings.billing.banner.unpaidNumber'), tone: 'warning' }
  // In the trial, most of its minutes used: one tap keeps every call answered (a purchase, then auto-recharge).
  if (state.trialMinutes)
    return {
      key: TRIAL_KEYS[state.trialMinutes.stage],
      tone: state.trialMinutes.stage === 'paused' ? 'danger' : 'warning',
      trial: state.trialMinutes,
    }
  // Below the threshold with auto-recharge off, or the cap leaves less than one recharge: nothing lifts the balance.
  if (state.lowBalance === 'auto_recharge_off')
    return { key: msg('settings.billing.banner.lowBalance'), tone: 'warning' }
  if (state.lowBalance === 'cap_reached') return { key: msg('settings.billing.banner.capReached'), tone: 'warning' }
  // The least pressing: callers got a busy line today because all calls at the same time were in use.
  if (state.busyLine) return { key: msg('settings.billing.banner.busyLine'), tone: 'warning', busy: state.busyLine }
  return null
}

/**
 * What "Keep calls answered" sends (`billing.startTopUp`, docs/billing.md §3.2 step 7): the bill's recharge amount on
 * the saved card, as the trial recharge, naming the card the banner showed (none known: the server names it first and
 * charges nothing).
 */
export function trialRechargeInput(prompt: Pick<TrialMinutesPrompt, 'amountCents'>, card: { id: string } | null) {
  return {
    amountCents: prompt.amountCents,
    savedCard: true,
    trialRecharge: true,
    ...(card ? { confirmCard: card.id } : {}),
  }
}

/**
 * Workspace settings › Billing (docs/billing.md §8): the bill's page for owners and admins (`owner`; the server says
 * whether they manage this bill, else they read this workspace's usage), the usage alone for anyone else with
 * settings:write (`usage`), and on an install that bills without a bill for this workspace, the "not on a bill" view
 * (`none`) for owners and admins. Off billing, and for members, no section. A white-label client without a bill: none.
 */
export function workspaceBillingView(me: Pick<Me, 'permissions' | 'workspace'>): 'owner' | 'usage' | 'none' | null {
  const workspace = me.workspace
  if (!workspace) return null
  const manages = me.permissions.includes('billing:manage')
  if (!workspace.billingState) return workspace.billingOn && !workspace.partnerManaged && manages ? 'none' : null
  if (manages) return 'owner'
  return me.permissions.includes('settings:write') ? 'usage' : null
}
