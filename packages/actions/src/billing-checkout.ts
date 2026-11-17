// Trial Checkout on an install that bills its workspaces (docs/billing.md §3.2, §2.2; billing PR 8). Only the owner of the bill runs these,
// signed in to the app (no API key, no impersonation): they start payments and change what the bill pays.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** "Buy minutes": the amounts allowed at a time, in cents before tax (docs/billing.md §2.2). */
export const TOPUP_CENTS = { min: 500, max: 50_000 } as const

export const billingStartCheckout = defineAction({
  name: 'billing.startCheckout',
  description:
    "Start Checkout for this workspace's bill: the plan with a 14-day free trial (or without one when this card had a trial). Answers the Checkout link to open.",
  input: z.object({}),
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
  input: z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/) }),
  permission: 'billing:manage',
})
/** `data` of `billing.confirmCheckout`. */
export type CheckoutConfirmData =
  | { status: 'trialing' | 'active'; heldForReview: boolean }
  | { status: 'trial_refused'; reason: 'card_used' | 'prepaid' }
  | { status: 'topup'; credited: boolean; amountCents: number }

export const billingStartTopUp = defineAction({
  name: 'billing.startTopUp',
  description: 'Buy call minutes for the balance: $5 to $500 at a time, paid at Checkout. Answers the Checkout link.',
  input: z.object({ amountCents: z.number().int().min(TOPUP_CENTS.min).max(TOPUP_CENTS.max) }),
  permission: 'billing:manage',
  secretResult: ['url'],
})

export const billingCancel = defineAction({
  name: 'billing.cancel',
  description:
    'Cancel the plan at the end of the trial or the paid period: nothing more is charged, the workspace keeps working until then.',
  input: z.object({}),
  permission: 'billing:manage',
})

export const billingResume = defineAction({
  name: 'billing.resume',
  description: 'Undo a cancellation before the trial or the paid period ends: the plan renews as before.',
  input: z.object({}),
  permission: 'billing:manage',
})
/** `data` of `billing.cancel` and `billing.resume`. */
export type CancelData = { cancelAtPeriodEnd: boolean; endsAt: string | null }
