// Passkeys (WebAuthn) through Better Auth's passkey plugin. A passkey signs in an existing account
// only: it is added from Account settings by a signed-in member, never created at sign-in, so a
// passkey cannot make a new user and closed sign-up holds (docs/architecture.md, passkeys).
import { passkey } from '@better-auth/passkey'
import { APIError, getSessionFromCtx } from 'better-auth/api'

type Env = Record<string, string | undefined>
type AuthCtx = Parameters<typeof getSessionFromCtx>[0]

/**
 * The relying party is the address people open: PUBLIC_URL (docker compose), else WEB_ORIGIN. The
 * browser binds each passkey to this host name, and the server accepts ceremonies only from this
 * origin, never one the request names.
 */
export function passkeyRelyingParty(env: Env) {
  const url = new URL(env.PUBLIC_URL || env.WEB_ORIGIN || 'http://localhost:5173')
  return { rpID: url.hostname, rpName: 'Linedesk', origin: url.origin }
}

/** Better Auth's plugin, with registration only for a signed-in member (the plugin's default, stated). */
export const passkeyPlugin = (env: Env) =>
  passkey({
    ...passkeyRelyingParty(env),
    // A passkey is added to the account of the session that asks, after a recent sign-in (the
    // plugin's fresh-session check). There is no `resolveUser`: no passkey-first sign-up.
    registration: { requireSession: true },
  })

/**
 * Removing a passkey takes away a way to sign in, so like adding one it needs a recent sign-in
 * (Better Auth's `freshAge`). Runs before Better Auth's endpoints; the plugin itself only asks for
 * a session there.
 */
export async function requireFreshSessionToRemovePasskey(ctx: AuthCtx) {
  if (ctx.path !== '/passkey/delete-passkey') return
  const session = await getSessionFromCtx(ctx).catch(() => null)
  if (!session?.session) return // the endpoint answers 401 itself
  const freshAgeMs = ctx.context.sessionConfig.freshAge * 1000
  if (freshAgeMs > 0 && Date.now() - new Date(session.session.createdAt).getTime() >= freshAgeMs) {
    throw new APIError('FORBIDDEN', { code: 'SESSION_NOT_FRESH', message: 'Sign in again to remove a passkey.' })
  }
}
