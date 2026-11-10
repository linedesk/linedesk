// What an instance admin may not do while signed in as another user (docs/architecture.md §12):
// nothing that changes the account's credentials or security, and nothing that would let the
// impersonation outlive its hour. Runs before Better Auth's own endpoints.
import { IMPERSONATION_MINUTES } from '@callfront/actions'
import { APIError, getSessionFromCtx } from 'better-auth/api'

type AuthCtx = Parameters<typeof getSessionFromCtx>[0]

/**
 * Better Auth endpoints refused while impersonating: passwords, email, deleting the account, other
 * sessions (listing them would hand out their tokens), linked sign-in accounts and their tokens.
 */
export const IMPERSONATION_REFUSED_PATHS = [
  '/change-password',
  '/set-password',
  '/change-email',
  '/delete-user',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/update-session',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/account-info',
  '/get-access-token',
  '/refresh-token',
  '/oauth2/link',
] as const

export const NOT_WHILE_IMPERSONATING = 'Not possible while signed in as another user.'

const refusedPath = (path: string) => IMPERSONATION_REFUSED_PATHS.some(p => path === p || path.startsWith(`${p}/`))

/** Throws 403 when the request is for a refused endpoint and its session is an impersonation. */
export async function refuseWhileImpersonating(ctx: AuthCtx) {
  if (!refusedPath(ctx.path)) return
  const session = await getSessionFromCtx(ctx).catch(() => null)
  if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
    throw new APIError('FORBIDDEN', { message: NOT_WHILE_IMPERSONATING })
  }
}

/** An impersonation ends at the latest this long after it started, whatever the session's expiry says. */
export const impersonationEndsAt = (createdAt: Date) => new Date(createdAt.getTime() + IMPERSONATION_MINUTES * 60_000)

type SessionUpdate = { expiresAt?: Date }

/**
 * Better Auth extends a session when it is used (`updateAge`). An impersonation keeps the expiry it
 * started with. Runs in Better Auth's `session.update.before` database hook; the session being
 * refreshed is the request's (`ctx.context.session`).
 */
export function keepImpersonationExpiry(
  data: SessionUpdate,
  ctx: { context?: { session?: unknown } } | null | undefined,
) {
  const current = (ctx?.context?.session as { session?: { impersonatedBy?: string | null; expiresAt: Date } } | null)
    ?.session
  if (!data.expiresAt || !current?.impersonatedBy) return undefined
  return { data: { ...data, expiresAt: current.expiresAt } }
}
