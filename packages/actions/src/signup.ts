// Self-serve sign-up on an install that bills its workspaces (docs/billing.md §3.1, §3.2): open only while the billing provider in effect is
// Stripe and an instance admin turned `signup.selfServe` on. A person proves their address with an email code on the
// sign-up page, then `account.signUp` makes their bill and their workspace, waiting for Checkout (`pending_payment`).
import { z } from 'zod'
import { defineAction } from './define.ts'
import { workspaceName } from './settings.ts'

/**
 * The plans a sign-up can start: `cloud` (a bill with the business's workspace), or `partner` (a white-label partner
 * with its partner bill and no workspace yet: its clients come later, docs/white-label.md).
 */
export const SIGNUP_PLANS = ['cloud', 'partner'] as const
export const SIGNUP_INTERVALS = ['year', 'month'] as const

export const accountSignUp = defineAction({
  name: 'account.signUp',
  description:
    "Start a plan on this server for your business: makes your bill and your workspace (you are its owner), waiting for a card at Checkout. With plan `partner`: a white-label partner account instead (you are its owner, pending a server admin's approval) with the partner bill and no workspace yet. Your name, the business's name and its country (US, CA or PR). One waiting sign-up per account: asked again, it answers the one there is.",
  input: z.object({
    name: z.string().trim().min(1).max(80),
    businessName: workspaceName,
    /** ISO 3166-1 alpha-2; only the sign-up countries are taken (the handler says "not yet" to others). */
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform(c => c.toUpperCase()),
    plan: z.enum(SIGNUP_PLANS),
    interval: z.enum(SIGNUP_INTERVALS),
    timeZone: z.string().max(64).optional(),
  }),
  permission: 'account:signUp',
})
/** What `account.signUp` made (or found: one waiting sign-up per account). */
export type AccountSignUpData = {
  billId: string
  /** The business's workspace (plan `cloud`); null for a partner, whose client workspaces come later. */
  workspace: { id: string; name: string } | null
  /** The partner made (plan `partner`), else null. */
  partner: { id: string; name: string } | null
  /** True when the account already had a sign-up waiting for Checkout, which is answered instead of a new one. */
  existing: boolean
}
