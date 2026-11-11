// Instance admins need a second factor (docs/architecture.md §12): the admin area and admin actions
// work only in a session started by a passkey sign-in in the last 12 hours. An email code, a
// password or a provider sign-in alone is not enough. Impersonation sessions never count (they never
// carry instance:admin). Self-hosters without https (no passkeys) can turn it off: ADMIN_SECOND_FACTOR=off.
import type { Permission } from '@linedesk/actions'
import { passkey } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'

/** How long a passkey sign-in counts for the admin area. */
export const PASSKEY_CONFIRM_HOURS = 12

/** What an instance admin still has to do: add a passkey, or sign in with it again. */
export type AdminSecondFactor = 'setup' | 'confirm'

/** Read on every request, so tests and operators can switch it without a restart. */
export const adminSecondFactorRequired = (env: Record<string, string | undefined> = process.env) =>
  env.ADMIN_SECOND_FACTOR?.trim().toLowerCase() !== 'off'

/** Whether a session's passkey sign-in is recent enough. */
export function passkeyConfirmed(passkeyVerifiedAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!passkeyVerifiedAt) return false
  const at = new Date(passkeyVerifiedAt).getTime()
  return Number.isFinite(at) && at <= now && now - at < PASSKEY_CONFIRM_HOURS * 3_600_000
}

/** null when this instance admin's session may use the admin area; otherwise what is missing. */
export async function adminSecondFactorGap(
  userId: string,
  session: { passkeyVerifiedAt?: Date | string | null },
): Promise<AdminSecondFactor | null> {
  if (!adminSecondFactorRequired() || passkeyConfirmed(session.passkeyVerifiedAt)) return null
  const [any] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)
  return any ? 'confirm' : 'setup'
}

export const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED'

/** The 403 body for an admin request refused for want of a second factor, or null when that is not why. */
export function secondFactorRefusal(actor: { adminSecondFactor?: AdminSecondFactor }, permission: Permission) {
  if (permission !== 'instance:admin' || !actor.adminSecondFactor) return null
  const error =
    actor.adminSecondFactor === 'setup'
      ? 'Add a passkey under Account, Sign-in & security, then sign in with it to use the admin area.'
      : 'Confirm with your passkey to use the admin area.'
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
