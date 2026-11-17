// Settings › Billing (Billing.tsx): what the page decides from the bill, without React, so it can be tested. Money
// arrives in cents (prices, recharges) or micro-dollars (the balance, usage); the page shows dollars through
// useFormat().currency.
import type { BillingOverviewBill, BillingStateBill, BillingUsageRow } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'

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

/** The status badge's words and tone. */
export function statusBadge(status: BillingOverviewBill['status']): {
  key: MessageKey
  tone: 'neutral' | 'ok' | 'info' | 'danger'
} {
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
    case 'SIGN_IN_AGAIN':
      return msg('settings.billing.error.signInAgain')
    default:
      return null
  }
}

/** Threshold and amount choices of auto-recharge (cents), within the server's limits and its $5 gap. */
export const THRESHOLD_CHOICES = [500, 1000, 2000, 5000, 10_000] as const
export const AMOUNT_CHOICES = [2000, 3000, 5000, 10_000, 20_000, 50_000] as const
export const amountFits = (thresholdCents: number, amountCents: number) => amountCents >= thresholdCents + 500

/**
 * The one-line banner above every page for the bill owner (docs/billing.md §3.4, §4.3, §11 PR 9), from `billing.state`
 * alone (a cheap read; review of #1007, I-4): the most pressing thing about the bill, or null. Paused calls first, then a canceled plan, a failed payment, a failed recharge, an
 * unpaid number, the monthly cap reached, a low balance with auto-recharge off. It leads to Settings › Billing.
 */
export type BillingBanner = { key: MessageKey; tone: 'warning' | 'danger' }

export function billingBanner(state: BillingStateBill | null): BillingBanner | null {
  if (!state) return null
  if (state.status === 'suspended') return { key: msg('settings.billing.banner.suspended'), tone: 'danger' }
  if (state.status === 'canceled') return { key: msg('settings.billing.banner.canceled'), tone: 'danger' }
  if (state.status === 'past_due') return { key: msg('settings.billing.banner.pastDue'), tone: 'danger' }
  if (state.rechargeFailed)
    return state.rechargeNeedsAction
      ? { key: msg('settings.billing.banner.rechargeConfirm'), tone: 'danger' }
      : { key: msg('settings.billing.banner.rechargeFailed'), tone: 'danger' }
  if (state.unpaidNumbers.length) return { key: msg('settings.billing.banner.unpaidNumber'), tone: 'warning' }
  // Below the threshold with auto-recharge off, or the cap leaves less than one recharge: nothing lifts the balance.
  if (state.lowBalance === 'auto_recharge_off')
    return { key: msg('settings.billing.banner.lowBalance'), tone: 'warning' }
  if (state.lowBalance === 'cap_reached') return { key: msg('settings.billing.banner.capReached'), tone: 'warning' }
  return null
}
