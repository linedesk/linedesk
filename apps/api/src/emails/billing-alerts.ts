// What the instance admins hear about Stripe's webhook events (stripe-events.ts) and the nightly reconciliation with
// Stripe (billing-reconcile.ts). Every word comes from packages/i18n/locales/en/email.json; the ids are Stripe's and
// ours, and Stripe's error text stays as it came.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import type { AdminAlertText } from './alerts.ts'

/** A stored Stripe event failed to process five times: nobody retries it until an admin reprocesses it. */
export const stripeEventFailedAlert =
  ({
    eventId,
    type,
    attempts,
    error,
  }: {
    eventId: string
    type: string
    attempts: number
    error: string
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.stripeEventFailed.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.stripeEventFailed.text', { attempts }) },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.stripeEventFailed.event'), eventId],
            [t('email.adminAlert.stripeEventFailed.type'), type],
            [t('email.adminAlert.stripeEventFailed.error'), error],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.stripeEventFailed.next') },
      ],
    }
  }

/** Why a paid recharge invoice credited nothing (docs/billing.md §2.2, "Credit only for a real payment"). */
export type NotCreditedReason =
  | 'out_of_band'
  | 'not_charged'
  | 'discounted'
  | 'not_covered'
  | 'amount_mismatch'
  | 'no_line'
  | 'currency'
  | 'customer_mismatch'
  | 'canceled'

/** A recharge invoice is paid in Stripe, but not by a real payment of the right amount: nothing was credited. */
export const rechargeNotCreditedAlert =
  ({
    bill,
    recharge,
    invoice,
    reason,
  }: {
    bill: string
    recharge: string
    invoice: string
    reason: NotCreditedReason
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.rechargeNotCredited.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.rechargeNotCredited.reason', { reason }) },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.rechargeNotCredited.bill'), bill],
            [t('email.adminAlert.rechargeNotCredited.recharge'), recharge],
            [t('email.adminAlert.rechargeNotCredited.invoice'), invoice],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.rechargeNotCredited.next') },
      ],
    }
  }

/** One thing the nightly reconciliation found that differs between a bill and Stripe. */
export type ReconcileFinding =
  | { kind: 'missed_events'; count: number }
  /** Stripe listed more events than the run reads: the oldest of them were not compared (security review of #865, L5). */
  | { kind: 'events_truncated'; count: number }
  | { kind: 'status' | 'period' | 'quantity' | 'payment_method'; bill: string; ours: string; stripe: string }
  /** A refund Stripe made whose ledger entry was missing: posted by this run (`ours`: the refund row, `stripe`: the credit note). */
  | { kind: 'refund'; bill: string; ours: string; stripe: string }
  | { kind: 'failed_events'; count: number }
  /** The run itself failed (Stripe unreachable, the ledger guards missing): nothing was compared. */
  | { kind: 'run_failed'; error: string }

/** The nightly reconciliation with Stripe found differences. */
export const billingReconcileAlert =
  (findings: ReconcileFinding[]): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    const rows = findings.map((f): [string, string] => [
      t('email.adminAlert.billingReconcile.kind', { kind: f.kind }),
      f.kind === 'missed_events' || f.kind === 'failed_events' || f.kind === 'events_truncated'
        ? t('email.adminAlert.billingReconcile.count', { count: f.count })
        : f.kind === 'run_failed'
          ? f.error
          : t('email.adminAlert.billingReconcile.differs', { bill: f.bill, ours: f.ours, stripe: f.stripe }),
    ])
    return {
      subject: t('email.adminAlert.billingReconcile.subject', { brand: brandName(), count: findings.length }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingReconcile.text') },
        { kind: 'facts', rows },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.billingReconcile.nightly') },
      ],
    }
  }

/**
 * A recharge failed on our own setup (a revoked key, a missing permission, a customer gone: recheck of #864, L2): the
 * attempt is canceled, the owner is not told (it is not their card), and the instance admins are.
 */
export const rechargeSetupAlert =
  ({ bill, recharge, code }: { bill: string; recharge: string; code: string }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.rechargeSetup.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.rechargeSetup.text', { code }) },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.rechargeSetup.bill'), bill],
            [t('email.adminAlert.rechargeSetup.recharge'), recharge],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.rechargeSetup.check') },
      ],
    }
  }

/**
 * Checkout could not start because of our own Stripe setup (docs/billing.md §3.2 step 3, security review I2): no
 * card-only payment method configuration, a key without a permission, a missing price. The owner was told to try later.
 */
export const checkoutSetupAlert =
  (code: string): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.checkoutSetup.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.checkoutSetup.text', { code }) },
        { kind: 'text', text: t('email.adminAlert.checkoutSetup.check') },
      ],
    }
  }

/** A second Checkout completed after the bill's own (security review of #961, G1): its subscription was canceled. */
export const checkoutExtraAlert =
  (o: { bill: string; session: string; subscription: string; paid: boolean }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.checkoutExtra.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.checkoutExtra.text', o) },
        {
          kind: 'text',
          text: t(o.paid ? 'email.adminAlert.checkoutExtra.refund' : 'email.adminAlert.checkoutExtra.trial'),
        },
      ],
    }
  }

/** A completed Checkout the server refused (security review of #961, G5): a person checks what Stripe charged. */
export const checkoutRefusedAlert =
  (o: { bill: string; session: string; reason: string }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.checkoutRefused.subject', { brand: brandName() }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.checkoutRefused.text', o) },
        { kind: 'text', text: t('email.adminAlert.checkoutRefused.check') },
      ],
    }
  }

/** One run of the hourly billing periods job had steps that failed (billing-periods.ts): the next run tries again. */
export const billingPeriodsFailedAlert =
  (failed: string[]): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.billingPeriodsFailed.subject', { brand: brandName(), count: failed.length }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingPeriodsFailed.text') },
        { kind: 'list', title: t('email.adminAlert.billingPeriodsFailed.steps'), items: failed },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.billingPeriodsFailed.next') },
      ],
    }
  }

/** One run of the hourly dunning job had steps that failed (billing-lifecycle.ts): the next run tries again. */
export const billingLifecycleFailedAlert =
  (failed: string[]): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.billingLifecycleFailed.subject', { brand: brandName(), count: failed.length }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingLifecycleFailed.text') },
        { kind: 'list', title: t('email.adminAlert.billingLifecycleFailed.steps'), items: failed },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.billingLifecycleFailed.next') },
      ],
    }
  }

/**
 * A card dispute or an early fraud warning suspended a bill (docs/billing.md §3.4, M4): the instance admins answer
 * the dispute or refund the charge. `adjustedCents`: what was taken off the balance (a disputed recharge or top-up).
 */
export const billingDisputeAlert =
  (facts: {
    bill: string
    kind: 'dispute' | 'fraud_warning'
    object: string
    charge: string
    adjustedCents: number | null
  }): AdminAlertText =>
  locale => {
    const { t, format } = getT(locale)
    const rows: [string, string][] = [
      [t('email.adminAlert.billingDispute.bill'), facts.bill],
      [t('email.adminAlert.billingDispute.charge'), facts.charge],
      [t('email.adminAlert.billingDispute.object'), facts.object],
    ]
    if (facts.adjustedCents !== null)
      rows.push([t('email.adminAlert.billingDispute.adjusted'), format.currency(facts.adjustedCents / 100, 'USD')])
    return {
      subject: t('email.adminAlert.billingDispute.subject', { brand: brandName(), kind: facts.kind, bill: facts.bill }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.billingDispute.text', { kind: facts.kind }) },
        { kind: 'facts', rows },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.billingDispute.next', { kind: facts.kind }) },
      ],
    }
  }

/**
 * A dispute closed or a fraud warning settled (security review of #920, M4): what Stripe says now, what went back on
 * the balance, and whether the suspension lifted. Lost, or still held by something else: the bill stays suspended
 * until an instance admin resumes it.
 */
export const billingDisputeClosedAlert =
  (facts: {
    bill: string
    object: string
    charge: string
    status: string
    returnedCents: number | null
    lifted: boolean
  }): AdminAlertText =>
  locale => {
    const { t, format } = getT(locale)
    const rows: [string, string][] = [
      [t('email.adminAlert.billingDispute.bill'), facts.bill],
      [t('email.adminAlert.billingDispute.charge'), facts.charge],
      [t('email.adminAlert.billingDispute.object'), facts.object],
      [t('email.adminAlert.billingDisputeClosed.status'), facts.status],
    ]
    if (facts.returnedCents !== null)
      rows.push([
        t('email.adminAlert.billingDisputeClosed.returned'),
        format.currency(facts.returnedCents / 100, 'USD'),
      ])
    return {
      subject: t('email.adminAlert.billingDisputeClosed.subject', {
        brand: brandName(),
        bill: facts.bill,
        lifted: facts.lifted ? 'yes' : 'no',
      }),
      blocks: [
        {
          kind: 'text',
          text: t('email.adminAlert.billingDisputeClosed.text', { lifted: facts.lifted ? 'yes' : 'no' }),
        },
        { kind: 'facts', rows },
      ],
    }
  }
