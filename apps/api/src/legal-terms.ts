// The terms and privacy policy a person accepts once, when they make an account on the sign-up page (A9; docs/billing.md
// §3.1); the activation step and Checkout do not ask again, and a new version is accepted in the app (terms-update.ts). The links are the install's own (TERMS_URL, PRIVACY_URL, also shown under sign-in); the versions (TERMS_VERSION, PRIVACY_VERSION) name
// the text behind each link, so a record says which text was accepted, not just which address. Self-serve sign-up
// stays closed while any of the four is missing (self-serve.ts `selfServeState`): no contract without its terms.
import {
  type ActivationDisclosure,
  type AutoRechargeDisclosure,
  type ExtraCallsDisclosure,
  session,
  type TrialRechargeDisclosure,
  type Tx,
  terms_acceptances,
} from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { readLegalLinks } from './auth-methods.ts'

type Env = Record<string, string | undefined>

/**
 * The rejection code when the terms changed while the page that showed them was open (the sign-up page, the "We updated
 * our terms" dialog): the page loads them again. Also `billing.startCheckout`'s while the bill's owner has not accepted
 * the terms in effect: the app asks them first.
 */
export const TERMS_CHANGED = 'terms_changed'

/** What the sign-up page shows, and `account.signUp` and `billing.startCheckout` record. */
export type LegalTerms = { termsUrl: string; termsVersion: string; privacyUrl: string; privacyVersion: string }

/** The variables self-serve sign-up needs, in the order an admin is told about them. */
export const LEGAL_TERMS_VARS = ['TERMS_URL', 'TERMS_VERSION', 'PRIVACY_URL', 'PRIVACY_VERSION'] as const
export type LegalTermsVar = (typeof LEGAL_TERMS_VARS)[number]

/** A version is a short label such as a date (2026-11-17) or a number (3, v1.2). */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

const version = (value?: string) => {
  const v = value?.trim()
  return v && VERSION.test(v) ? v : null
}

/**
 * The terms in effect, read from the environment on every call (tests set it per case), or null with the variables
 * that are missing (or not a valid version). A malformed link already stops the server at start (readLegalLinks).
 */
export function legalTerms(env: Env = process.env): { terms: LegalTerms | null; missing: LegalTermsVar[] } {
  const links = readLegalLinks(env)
  const found: Record<LegalTermsVar, string | null> = {
    TERMS_URL: links.terms,
    TERMS_VERSION: version(env.TERMS_VERSION),
    PRIVACY_URL: links.privacy,
    PRIVACY_VERSION: version(env.PRIVACY_VERSION),
  }
  const missing = LEGAL_TERMS_VARS.filter(name => !found[name])
  if (missing.length) return { terms: null, missing }
  return {
    terms: {
      termsUrl: found.TERMS_URL!,
      termsVersion: found.TERMS_VERSION!,
      privacyUrl: found.PRIVACY_URL!,
      privacyVersion: found.PRIVACY_VERSION!,
    },
    missing: [],
  }
}

/**
 * Records that this person accepted these terms and this privacy policy now (A9), with the IP address and browser of
 * the session that accepted (Better Auth keeps them on the session; null when it has none). `source`: the sign-up
 * page (`signup`), the activation step before Checkout (`activation`, with what it showed next to its button), or
 * "Keep calls answered" in the trial (`trial_recharge`, with what the banner showed; docs/billing.md §3.2 step 7), or
 * more calls at the same time (`extra_calls`, with what the dialog or the busy-line banner said; LIN-450), or
 * auto-recharge turned on in Settings › Billing (`auto_recharge`, with the line next to the switch), or a new terms
 * version accepted in the app by a bill's owner (`terms_update`, terms-update.ts).
 */
export async function recordAcceptance(
  tx: Tx,
  o: {
    userId: string
    billId: string
    sessionId: string
    terms: LegalTerms
    now: string
    source: 'signup' | 'activation' | 'trial_recharge' | 'extra_calls' | 'auto_recharge' | 'terms_update'
    disclosure?: ActivationDisclosure | TrialRechargeDisclosure | ExtraCallsDisclosure | AutoRechargeDisclosure
  },
) {
  const [from] = await tx
    .select({ ip: session.ipAddress, userAgent: session.userAgent })
    .from(session)
    .where(eq(session.id, o.sessionId))
  await tx.insert(terms_acceptances).values({
    id: crypto.randomUUID(),
    user_id: o.userId,
    billing_account_id: o.billId,
    source: o.source,
    terms_url: o.terms.termsUrl,
    terms_version: o.terms.termsVersion,
    privacy_url: o.terms.privacyUrl,
    privacy_version: o.terms.privacyVersion,
    ip_address: from?.ip || null,
    user_agent: from?.userAgent ? from.userAgent.slice(0, 512) : null,
    disclosure: o.disclosure ?? null,
    accepted_at: o.now,
  })
}
