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
