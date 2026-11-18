// Self-serve sign-up on an install that bills its workspaces (docs/billing.md §3.1, §3.2): open only while the billing provider in effect is
// Stripe and an instance admin turned `signup.selfServe` on. A person proves their address with an email code on the
// sign-up page, then `account.signUp` makes their bill and their workspace, waiting for Checkout (`pending_payment`).
import { z } from 'zod'
import { defineAction } from './define.ts'
import { workspaceName } from './settings.ts'
import { countryHintSchema } from './workspace-locale.ts'

/**
 * The plans a sign-up can start: `cloud` (a bill with the business's workspace), or `partner` (a white-label partner
 * with its partner bill and no workspace yet: its clients come later, docs/white-label.md).
 */
export const SIGNUP_PLANS = ['cloud', 'partner'] as const
export const SIGNUP_INTERVALS = ['year', 'month'] as const

export const accountSignUp = defineAction({
  name: 'account.signUp',
  description:
    "Start a plan on this server for your business: makes your bill and your workspace (you are its owner), waiting for a card at Checkout. With plan `partner`: a white-label partner account instead (you are its owner, pending a server admin's approval) with the partner bill and no workspace yet. Your name and the versions of the terms and privacy policy the sign-up page showed (you accept them by starting); for a partner also its company name. The business's name and country are set in the onboarding's first step; until then the workspace has a placeholder name and the country the request comes from, worked out (only US, CA and PR are served: from anywhere else the first step asks which of these the business is in, and Checkout refuses another one). One waiting sign-up per account: asked again, it answers the one there is.",
  input: z
    .object({
      name: z.string().trim().min(1).max(80),
      /** The workspace's name (plan `cloud`, optional: a placeholder until the Business step) or the partner's (required). */
      businessName: workspaceName.optional(),
      /** ISO 3166-1 alpha-2, optional: only the sign-up countries are taken (the handler says "not yet" to others). */
      country: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/)
        .transform(c => c.toUpperCase())
        .optional(),
      /**
       * Where the request comes from (countryHintOf): set by POST /v1/signup from the request itself, never taken from
       * the caller. It only prefills the workspace's country (worked out, never set) and never refuses a sign-up.
       */
      countryHint: countryHintSchema.optional(),
      plan: z.enum(SIGNUP_PLANS),
      interval: z.enum(SIGNUP_INTERVALS),
      timeZone: z.string().max(64).optional(),
      /**
       * The terms and privacy policy versions the page showed next to its button (GET /v1/signup/config): starting the
       * plan accepts them (A9). The server records them only when they are still the ones in effect.
       */
      acceptedTerms: z.object({
        termsVersion: z.string().trim().min(1).max(40),
        privacyVersion: z.string().trim().min(1).max(40),
      }),
    })
    // A partner's company name is its brand until a server admin approves it: required for a partner.
    .refine(input => input.plan !== 'partner' || !!input.businessName, { path: ['businessName'] }),
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

/**
 * A new terms version for existing customers (LIN-420): the app asks a bill's owner once TERMS_VERSION changed
 * (`/v1/me` `termsUpdate`), and accepting records it for each bill they own that has not accepted that version.
 */
export const accountAcceptTerms = defineAction({
  name: 'account.acceptTerms',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Accept the terms of service in effect now (and acknowledge the privacy policy) after they changed: recorded for each plan you own that has not accepted that version yet. Only in the app, signed in as yourself. Takes the versions the app showed; other versions than in effect are refused with `terms_changed`.',
  input: z.object({
    termsVersion: z.string().trim().min(1).max(40),
    privacyVersion: z.string().trim().min(1).max(40),
  }),
  permission: 'account:own',
})
/** What `account.acceptTerms` recorded: the number of bills (0 when none was waiting for this version). */
export type AccountAcceptTermsData = { accepted: number }
