// Instance admins re-confirm who they are before the admin area (docs/architecture.md §12): the admin
// area and admin actions work only for an admin whose email address is confirmed, in a session
// started by a recent sign-in. Every enabled sign-in method counts (passkey, email code, password,
// Google, Microsoft, GitHub, single sign-on): a passkey sign-in for 12 hours, any other for 1 hour.
// What can take over the admin role or the passkeys (granting admin, resetting passkeys, signing in
// as a user, actions on another admin) needs a passkey sign-in on top (admin-step-up.ts), and
// changing passkeys keeps its own rule (passkeys.ts). Impersonation sessions never count. Installs
// that cannot meet the rule (no email, no https for passkeys) turn it off: ADMIN_SECOND_FACTOR=off.
import type { Permission } from '@linedesk/actions'

/** How long a passkey sign-in counts: for the admin area, admin step-ups and changing passkeys. */
export const PASSKEY_CONFIRM_HOURS = 12
/** How long any other sign-in (email code, password, a provider) opens the admin area. */
export const OTHER_SIGN_IN_ADMIN_HOURS = 1

/** What an instance admin still has to do: confirm their email address, or sign in again. */
export type AdminSecondFactor = 'email' | 'confirm'

/** Read on every request, so tests and operators can switch it without a restart. */
export const adminSecondFactorRequired = (env: Record<string, string | undefined> = process.env) =>
  env.ADMIN_SECOND_FACTOR?.trim().toLowerCase() !== 'off'

/** Whether a sign-in at `at` lies within the last `hours`; a time in the future never counts. */
export function signedInWithin(at: Date | string | null | undefined, hours: number, now = Date.now()): boolean {
  if (!at) return false
  const time = new Date(at).getTime()
  return Number.isFinite(time) && time <= now && now - time < hours * 3_600_000
}

/** Whether a session's passkey sign-in is recent enough (12 hours). */
export const passkeyConfirmed = (passkeyVerifiedAt: Date | string | null | undefined, now = Date.now()) =>
  signedInWithin(passkeyVerifiedAt, PASSKEY_CONFIRM_HOURS, now)

type AdminSession = {
  createdAt: Date | string
  passkeyVerifiedAt?: Date | string | null
  impersonatedBy?: string | null
}

/**
 * null when this instance admin's session may use the admin area; otherwise what is missing. A
 * session's `createdAt` is the sign-in that started it (Better Auth never moves it when it extends
 * the session); `passkeyVerifiedAt` is set only when that sign-in was a passkey (markPasskeySession).
 */
export function adminSecondFactorGap(
  account: { emailVerified: boolean },
  session: AdminSession,
  now = Date.now(),
): AdminSecondFactor | null {
  if (session.impersonatedBy) return 'confirm'
  if (!adminSecondFactorRequired()) return null
  if (!account.emailVerified) return 'email'
  const recent =
    passkeyConfirmed(session.passkeyVerifiedAt, now) ||
    signedInWithin(session.createdAt, OTHER_SIGN_IN_ADMIN_HOURS, now)
  return recent ? null : 'confirm'
}

/** Said loudly at every start while the rule is off (server.ts): it is easy to forget in a .env. */
export function secondFactorOffWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (adminSecondFactorRequired(env)) return null
  const line = '!'.repeat(78)
  return [
    line,
    'WARNING: ADMIN_SECOND_FACTOR=off. The admin area opens for any signed-in instance admin, also an',
    'unconfirmed address or a sign-in days old, and granting admin, resetting passkeys and signing in as',
    "a user need no passkey. Anyone with an admin's mailbox or password controls this install.",
    'Remove the setting once the install has https and email.',
    line,
  ].join('\n')
}

export const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED'

/** The 403 body for an admin request refused for want of a second factor, or null when that is not why. */
export function secondFactorRefusal(actor: { adminSecondFactor?: AdminSecondFactor }, permission: Permission) {
  if (permission !== 'instance:admin' || !actor.adminSecondFactor) return null
  const error =
    actor.adminSecondFactor === 'email'
      ? 'Confirm your email address to use the admin area: sign in with an email code.'
      : 'Sign in again to use the admin area: a passkey sign-in counts for 12 hours, any other for 1 hour.'
  return { ok: false as const, error, code: SECOND_FACTOR_REQUIRED, secondFactor: actor.adminSecondFactor }
}

/**
 * Better Auth `session.create` hook: marks a session started by a passkey sign-in. The path is the
 * endpoint Better Auth is running, not something a client sends; impersonation sessions are made
 * outside it and are never marked.
 */
export function markPasskeySession<S extends { impersonatedBy?: string | null }>(created: S, ctx: unknown) {
  const path = (ctx as { path?: string } | null | undefined)?.path
  if (path !== '/passkey/verify-authentication' || created.impersonatedBy) return undefined
  return { data: { ...created, passkeyVerifiedAt: new Date() } }
}
