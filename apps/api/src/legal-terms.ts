// The terms and privacy policy a person accepts when they start a plan on the sign-up page (A9). The links are the
// install's own (TERMS_URL, PRIVACY_URL, also shown under sign-in); the versions (TERMS_VERSION, PRIVACY_VERSION) name
// the text behind each link, so a record says which text was accepted, not just which address. Self-serve sign-up
// stays closed while any of the four is missing (self-serve.ts `selfServeState`): no contract without its terms.
import { readLegalLinks } from './auth-methods.ts'

type Env = Record<string, string | undefined>

/** What the sign-up page shows and `account.signUp` records. */
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
