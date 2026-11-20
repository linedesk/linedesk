// Trial Checkout on an install that bills its workspaces. Only the owner of the bill runs these,
// signed in to the app (no API key, no impersonation): they start payments and change what the bill pays.
import { EXTRA_CALLS_STEP } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * Which bill a billing action is about: the workspace's (no `partnerId`), or a white-label partner's bill, managed by the
 * partner's owner from the partner area, also with no workspace (docs/white-label.md). The API checks the caller owns
 * that partner and its bill.
 */
export const billTarget = { partnerId: z.string().min(1).max(64).optional() }

/** "Buy minutes": the amounts allowed at a time, in cents before tax. */
export const TOPUP_CENTS = { min: 500, max: 50_000 } as const

export const billingStartCheckout = defineAction({
  name: 'billing.startCheckout',
  description:
    "Start Checkout for this workspace's bill: the plan with a 14-day free trial (or without one when this card had a trial), with any extra calls at the same time added (`extraCalls`), billed monthly or yearly (`interval`, default the bill's). Answers the Checkout link to open. The terms are accepted once, at sign-up: neither this nor Checkout asks for them again. While the bill's owner has not accepted the terms in effect (they changed since sign-up), it is refused with `terms_changed` until the owner accepts them in the app. A business's start records the consent to the trial and its first charge with what the activation step showed.",
  input: z.object({
    ...billTarget,
    /**
     * A business's bill (LIN-450): extra calls at the same time added on the activation step, a multiple of 5 up to the
     * install's most per workspace. They are a line of the plan's subscription, so in a trial they are charged with the
     * plan at its end.
     */
    extraCalls: z.number().int().min(0).max(1000).multipleOf(EXTRA_CALLS_STEP).optional(),
    /**
     * Monthly or yearly, as picked in the Start your free trial dialog; absent: the bill's interval (the sign-up's).
     * Stored on the bill once Checkout opens; nothing was charged before it, so switching is free.
     */
    interval: z.enum(['month', 'year']).optional(),
  }),
  permission: 'billing:manage',
  // The Checkout link pays this bill: in the answer only, never in the command log.
  secretResult: ['url'],
})
/** `data` of `billing.startCheckout` and `billing.startTopUp`. */
export type CheckoutStartData = { url: string }

export const billingConfirmCheckout = defineAction({
  name: 'billing.confirmCheckout',
  description:
    'Confirm a finished Checkout of this bill when its owner comes back from it: starts the trial (or the plan), or credits minutes bought.',
  input: z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/), ...billTarget }),
  permission: 'billing:manage',
})
/** `data` of `billing.confirmCheckout`. */
export type CheckoutConfirmData =
  | { status: 'trialing' | 'active'; heldForReview: boolean }
  | { status: 'trial_refused'; reason: 'card_used' | 'prepaid' | 'account_used' }
  | { status: 'topup'; credited: boolean; amountCents: number }

export const billingStartTopUp = defineAction({
  name: 'billing.startTopUp',
  description:
    'Buy call minutes for the balance: $5 to $500 at a time. With savedCard it first answers which card on file would be charged; called again with that card as confirmCard (after the owner confirmed it is them), the card is charged at once, at most $500 in 24 hours. Without a card, over that limit, when the bank asks to confirm, or on a decline, it answers a Checkout link instead. With trialRecharge (in the free trial: "Keep calls answered"), the amount is the auto-recharge amount of the bill, charged to the saved card; once charged, auto-recharge runs in the trial too, and the consent of the owner is recorded.',
  input: z.object({
    amountCents: z.number().int().min(TOPUP_CENTS.min).max(TOPUP_CENTS.max),
    savedCard: z.boolean().optional(),
    /** The card the owner was shown and confirmed (`kind: 'confirm'`); a card changed since is shown again. */
    confirmCard: z
      .string()
      .regex(/^(pm|card|src)_[A-Za-z0-9]{1,250}$/)
      .optional(),
    /**
     * "Keep calls answered" in the trial: with `savedCard`, `amountCents` must be the
     * bill's auto-recharge amount; charged, the bill's trial recharge is on (auto-recharge in the trial too).
     */
    trialRecharge: z.boolean().optional(),
    ...billTarget,
  }),
  permission: 'billing:manage',
  secretResult: ['url'],
})
/**
 * `data` of `billing.startTopUp`: the saved card to confirm (brand and last four), a Checkout to open (`fallback`: why the saved card was not charged), the saved card
 * charged (`credited`: the balance has it now; else it follows within a minute), or a payment still in progress.
 */
export type TopUpData =
  | { kind: 'confirm'; card: { id: string; brand: string | null; last4: string | null } }
  | { kind: 'checkout'; url: string; fallback?: 'no_card' | 'authentication_required' | 'declined' | 'daily_limit' }
  | { kind: 'paid'; amountCents: number; credited: boolean }
  | { kind: 'pending'; amountCents: number }

export const billingCancel = defineAction({
  name: 'billing.cancel',
  description:
    'Cancel the plan at the end of the trial or the paid period: nothing more is charged, the workspace keeps working until then.',
  input: z.object(billTarget),
  permission: 'billing:manage',
})

export const billingResume = defineAction({
  name: 'billing.resume',
  description: 'Undo a cancellation before the trial or the paid period ends: the plan renews as before.',
  input: z.object(billTarget),
  permission: 'billing:manage',
})
/** `data` of `billing.cancel` and `billing.resume`. */
export type CancelData = { cancelAtPeriodEnd: boolean; endsAt: string | null }
