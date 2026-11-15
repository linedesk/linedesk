// Server admin needs a passkey (docs/architecture.md §12, Janik's decision 2026-11-15): two levels.
// - Workspace users (owner, admin, member) sign in with any method this install offers; a passkey is optional.
// - Server admin (`instance:admin`: every Server admin page, provider key and setting, setup links, impersonation,
//   every instance-admin action and GET /v1/admin/*) only in a session that passed a passkey check in the last
//   ADMIN_PASSKEY_HOURS. The check is a passkey sign-in in that browser (session.passkey_verified_at, set by the
//   session.create hook below, server-side and bound to that session; never a client flag). An admin may sign in with
//   anything and use their workspaces; opening Server admin asks for the passkey once. No email code, password or
//   provider sign-in counts for the admin level. The one fallback is a code from the admin's authenticator app (TOTP,
//   authenticator.ts; Tim's decisions 2026-11-15, LIN-275): it marks the session the same way, but the account must
//   have a passkey all the same (no passkey: `enrol`, whatever was checked).
// An admin without a passkey adds one first, with a one-time enrolment code (passkey-enrolment.ts: from another admin,
// the first-run setup, the API log at start, or `user-passkeys.ts --enrol` / `--remove` on the server).
// Impersonation sessions never count. Installs that cannot use passkeys at all (no https) turn the rule off with
// ADMIN_SECOND_FACTOR=off; the API then warns at every start. An install on this machine only (its addresses are
// localhost, 127.0.0.1, [::1] or a *.localhost name: local development, localOnlyInstall) has it off by itself, for admins and for the
// owner's step-ups (Tim, 2026-11-15); ADMIN_SECOND_FACTOR=on turns it on there, to try the passkey check.
import type { Permission } from '@linedesk/actions'
import { passkeySignInEnabled } from './auth-methods.ts'

/** How long a passkey check counts for Server admin, in that session (and for changing passkeys, passkeys.ts). */
export const ADMIN_PASSKEY_HOURS = 12

/**
 * What an instance admin still has to do before Server admin: confirm their email address (needed to add a passkey),
 * add their first passkey (`enrol`, with an enrolment code), or confirm with a passkey in this session (`confirm`).
 */
export type AdminSecondFactor = 'email' | 'enrol' | 'confirm'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The addresses an install is reached at; each one that is set must be local for a local install. */
const ADDRESS_VARS = ['PUBLIC_URL', 'WEB_ORIGIN', 'BETTER_AUTH_URL'] as const

const isLocalAddress = (url: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * Whether the install runs on this machine only: every address that is set (PUBLIC_URL, WEB_ORIGIN, BETTER_AUTH_URL)
 * is localhost, 127.0.0.1, [::1] or a *.localhost name, and at least one is set. A tunnel (scripts/tunnel.sh,
 * scripts/local-public.sh) or any server sets a public one, so this is false there. Also what keeps the admin alerts
 * quiet in local development (admin-alerts.ts).
 */
export function localOnlyInstall(env: Record<string, string | undefined> = process.env): boolean {
  const set = ADDRESS_VARS.map(name => env[name]?.trim()).filter((url): url is string => Boolean(url))
  return set.length > 0 && set.every(isLocalAddress)
}

/** Read on every request, so tests and operators can switch it without a restart. */
export function adminSecondFactorRequired(env: Record<string, string | undefined> = process.env): boolean {
  const setting = env.ADMIN_SECOND_FACTOR?.trim().toLowerCase()
  if (setting === 'off') return false
  if (setting === 'on') return true
  return !localOnlyInstall(env)
}

/** Whether a sign-in at `at` lies within the last `hours`; a time in the future never counts. */
export function signedInWithin(at: Date | string | null | undefined, hours: number, now = Date.now()): boolean {
  if (!at) return false
  const time = new Date(at).getTime()
  return Number.isFinite(time) && time <= now && now - time < hours * 3_600_000
}

/** Whether a session's passkey check is recent enough (12 hours). */
export const passkeyConfirmed = (passkeyVerifiedAt: Date | string | null | undefined, now = Date.now()) =>
  signedInWithin(passkeyVerifiedAt, ADMIN_PASSKEY_HOURS, now)

/** What set a session's check: a passkey sign-in, or a code from the authenticator app (the fallback). */
export type SecondFactorMethod = 'passkey' | 'authenticator'

/**
 * Whether the session's check of the last 12 hours was a passkey sign-in, not a code from the authenticator app. A
 * code is phishable, a passkey is not, so what can take over the account (changing passkeys other than adding one,
 * the email change without the old-address code, the owner's workspace delete) needs the passkey itself; the app only
 * opens Server admin and adds a passkey on the computer at hand. A session from before the method was stored was a
 * passkey sign-in.
 */
export const passkeySignedIn = (
  session: { passkeyVerifiedAt?: Date | string | null; secondFactorMethod?: string | null },
  now = Date.now(),
) => passkeyConfirmed(session.passkeyVerifiedAt, now) && session.secondFactorMethod !== 'authenticator'

type AdminSession = {
  passkeyVerifiedAt?: Date | string | null
  impersonatedBy?: string | null
}

/**
 * null when this instance admin's session may use Server admin; otherwise what is missing. The account must have a
 * passkey (else `enrol`, also after a check with the authenticator app), and the session a check of the last 12 hours
 * (`passkeyVerifiedAt`: set when the session was started by a passkey, markPasskeySession, or by a code from the
 * admin's authenticator app, the fallback, authenticator.ts).
 */
export function adminSecondFactorGap(
  account: { emailVerified: boolean },
  session: AdminSession,
  hasPasskey: boolean,
  now = Date.now(),
): AdminSecondFactor | null {
  if (session.impersonatedBy) return 'confirm'
  if (!adminSecondFactorRequired()) return null
  if (!hasPasskey) return account.emailVerified ? 'enrol' : 'email'
  if (passkeyConfirmed(session.passkeyVerifiedAt, now)) return null
  return 'confirm'
}

/** Said loudly at every start while the rule is off (server.ts): it is easy to forget in a .env. */
export function secondFactorOffWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (adminSecondFactorRequired(env)) return null
  if (env.ADMIN_SECOND_FACTOR?.trim().toLowerCase() !== 'off')
    return 'Server admin opens without a passkey: this install has only local addresses (local development). ADMIN_SECOND_FACTOR=on turns the check on.'
  const line = '!'.repeat(78)
  return [
    line,
    'WARNING: ADMIN_SECOND_FACTOR=off. Server admin opens for any signed-in instance admin without a passkey:',
    'provider keys, email and sign-in settings, setup links, granting admin and signing in as a user.',
    "Anyone with an admin's mailbox or password controls this install.",
    'Remove the setting once the install has https, so admins can use passkeys.',
    line,
  ].join('\n')
}

/**
 * Said loudly at every start when the rule is on but passkeys are off as a sign-in method (AUTH_PASSKEY_ENABLED=false):
 * no admin can add or confirm a passkey, so nobody can open Server admin. No enrolment codes are issued at start then
 * (admin-passkey-codes.ts): they could not be used.
 */
export function passkeysOffWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (!adminSecondFactorRequired(env) || passkeySignInEnabled(env)) return null
  const line = '!'.repeat(78)
  return [
    line,
    'WARNING: AUTH_PASSKEY_ENABLED=false, but Server admin needs a passkey. No instance admin can add or confirm',
    'one, so nobody can open Server admin (provider keys, setup links, users).',
    'Fix: remove AUTH_PASSKEY_ENABLED=false (passkeys need https) and restart. No passkey enrolment codes',
    'are issued until then.',
    line,
  ].join('\n')
}

export const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED'

const REFUSAL_TEXT: Record<AdminSecondFactor, string> = {
  confirm:
    'Server admin needs your passkey or authenticator app: confirm with it once, then it counts for 12 hours in this browser.',
  enrol:
    'Server admin needs a passkey. Add your first one with the enrolment code from the server (user-passkeys.ts --enrol) or another admin.',
  email: 'Confirm your email address first, then add a passkey for Server admin.',
}

/** The 403 body for an admin request refused for want of the passkey check, or null when that is not why. */
export function secondFactorRefusal(actor: { adminSecondFactor?: AdminSecondFactor }, permission: Permission) {
  if (permission !== 'instance:admin' || !actor.adminSecondFactor) return null
  return {
    ok: false as const,
    error: REFUSAL_TEXT[actor.adminSecondFactor],
    code: SECOND_FACTOR_REQUIRED,
    secondFactor: actor.adminSecondFactor,
  }
}

/**
 * The same refusal for an actor that holds `instance:admin` without the passkey check, which should never happen
 * (context.ts grants it only with one; a setup key and the CLI carry it): checked once more before every
 * instance-admin action (run-action.ts) and admin read (admin-routes.ts), so no other way in skips the rule.
 */
export function adminPasskeyRefusal(
  actor: { passkeyConfirmed?: true; adminSecondFactor?: AdminSecondFactor },
  permission: Permission,
) {
  if (permission !== 'instance:admin' || !adminSecondFactorRequired() || actor.passkeyConfirmed) return null
  return secondFactorRefusal({ adminSecondFactor: actor.adminSecondFactor ?? 'confirm' }, permission)
}

/**
 * The passkey sign-ins whose response reported user verification, by their request's Better Auth context: the plugin's
 * afterVerification (passkeys.ts) and the session.create hook below see the same object. Gone with the request.
 */
const userVerifiedSignIns = new WeakSet<object>()
const contextOf = (ctx: unknown) => {
  const context = (ctx as { context?: unknown } | null | undefined)?.context
  return context && typeof context === 'object' ? context : null
}
/** Notes that this request's passkey sign-in was verified by the device (fingerprint, face or PIN). */
export function noteUserVerified(ctx: unknown) {
  const context = contextOf(ctx)
  if (context) userVerifiedSignIns.add(context)
}
/** Whether this request's passkey sign-in was verified by the device. */
export function signInUserVerified(ctx: unknown): boolean {
  const context = contextOf(ctx)
  return Boolean(context && userVerifiedSignIns.has(context))
}

/**
 * Better Auth `session.create` hook: marks a session started by a passkey sign-in that the device verified (fingerprint,
 * face or PIN: the response's user-verified flag, noted by the plugin's afterVerification, passkeys.ts). The path is the
 * endpoint Better Auth is running, not something a client sends; impersonation sessions are made outside it and are
 * never marked. A passkey sign-in without user verification (the plugin refuses one already) would never count.
 */
export function markPasskeySession<S extends { impersonatedBy?: string | null }>(created: S, ctx: unknown) {
  const path = (ctx as { path?: string } | null | undefined)?.path
  if (path !== '/passkey/verify-authentication' || created.impersonatedBy || !signInUserVerified(ctx)) return undefined
  return { data: { ...created, passkeyVerifiedAt: new Date(), secondFactorMethod: 'passkey' } }
}
