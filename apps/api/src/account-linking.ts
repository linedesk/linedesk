// One email, one account (docs/architecture.md, "Sign-in providers and account linking"). A provider
// sign-in lands in the account with the same email, whichever way that account was made (email code,
// invitation, another provider), but only when the provider proves the address is verified. A
// provider that cannot prove it signs nobody in: its user has no email, and Better Auth stops with
// `email_not_found` before it looks up or creates a user. GitHub's rule is in github-sign-in.ts.
import { account, session, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { db } from './db.ts'

/** Microsoft's tenant for personal accounts (Outlook.com, Hotmail, Live): Microsoft verifies their addresses. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'

const isTrue = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1'

/**
 * Whether a Microsoft ID token proves its `email`: a personal account, or a work account whose
 * tenant owns the email's domain (`xms_edov`, an optional claim the app registration must add) or
 * that lists the address as a verified primary email (`verified_primary_email`, optional claim).
 * A plain `email` claim from a work account is not proof: any tenant can set it to any address.
 */
export function microsoftEmailVerified(claims: Record<string, unknown>): boolean {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
  if (!email) return false
  if (claims.tid === MICROSOFT_CONSUMER_TENANT) return true
  if (isTrue(claims.xms_edov)) return true
  const primary = claims.verified_primary_email
  const listed = Array.isArray(primary) ? primary : typeof primary === 'string' ? [primary] : []
  return listed.some(address => typeof address === 'string' && address.toLowerCase() === email)
}

/** Better Auth `mapProfileToUser` for Microsoft: no email unless the token proves it. */
export const mapMicrosoftProfile = (claims: Record<string, unknown>) =>
  microsoftEmailVerified(claims) ? { emailVerified: true } : { email: null, emailVerified: false }

/** Better Auth `mapProfileToUser` for Google: no email unless Google says it is verified. */
export const mapGoogleProfile = (profile: { email_verified?: unknown }) =>
  isTrue(profile.email_verified) ? { emailVerified: true } : { email: null, emailVerified: false }

/** `OIDC_TRUST_EMAIL_DOMAINS`: the domains the OIDC provider owns, lower case. */
export const oidcTrustedEmailDomains = (env: Record<string, string | undefined> = process.env) =>
  (env.OIDC_TRUST_EMAIL_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)

/** Whether `email` is on one of `domains` exactly (a subdomain is another domain the IdP may not own). */
function onTrustedDomain(email: unknown, domains: string[]): boolean {
  if (typeof email !== 'string' || domains.length === 0) return false
  const at = email.lastIndexOf('@')
  return (
    at > 0 &&
    domains.includes(
      email
        .slice(at + 1)
        .trim()
        .toLowerCase(),
    )
  )
}

/**
 * Better Auth `mapProfileToUser` for the OIDC provider: the same rule as Google (`email_verified`),
 * or, opted in with `OIDC_TRUST_EMAIL_DOMAINS`, an address on a domain the provider owns (identity
 * providers like a company's own Keycloak often send no `email_verified`). A provider that does send
 * the claim is taken at its word, also when it says false.
 */
export function mapOidcProfile(
  profile: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
) {
  const proven =
    profile.email_verified === undefined
      ? onTrustedDomain(profile.email, oidcTrustedEmailDomains(env))
      : isTrue(profile.email_verified)
  return proven ? { emailVerified: true } : { email: null, emailVerified: false }
}

/**
 * Better Auth `account.create` hook. A provider account joins a user whose email was never verified
 * (an invitation, `user.invite`, or a password sign-up): the provider just proved the address, so
 * Better Auth marks it verified. Whatever got in before without proof goes: the password and the
 * sessions. Otherwise someone who signed up with another person's address and a password would keep
 * a way into that person's account once they sign in with Google. The new session is made after this.
 */
export async function dropUnprovenAccess(created: { userId: string; providerId: string }) {
  if (created.providerId === 'credential') return
  const [owner] = await db.select({ emailVerified: user.emailVerified }).from(user).where(eq(user.id, created.userId))
  if (!owner || owner.emailVerified) return
  await db.delete(account).where(and(eq(account.userId, created.userId), eq(account.providerId, 'credential')))
  await db.delete(session).where(eq(session.userId, created.userId))
}

export const accountLinkingHooks = {
  account: { create: { after: dropUnprovenAccess } },
}
