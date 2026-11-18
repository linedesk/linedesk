// Setting a first password: for a member who signed up by email link or SSO. Better Auth only
// offers this on the server and asks for nothing but a session, so the proof that the person at
// the keyboard owns the account is added here: they must have signed in a few minutes ago.
import { APIError } from 'better-auth/api'
import type { Context } from 'hono'
import { authMethods } from './auth-methods.ts'
import { auth } from './auth.ts'
import { type SessionHost, sessionFitsHost } from './host-sessions.ts'
import { requestHostOf } from './request-host.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { db } from './db.ts'
import { revokeSetupKeysOf } from './passkey-enrolment.ts'
import { createRateLimiter } from './rate-limit.ts'

export const RECENT_SIGN_IN_MS = 10 * 60_000
/** The code the web app reacts to by offering "Sign in again". */
export const SIGN_IN_AGAIN = 'SIGN_IN_AGAIN'

export const signedInRecently = (createdAt: Date, now = Date.now()) => now - createdAt.getTime() < RECENT_SIGN_IN_MS

const allowAttempt = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })

export async function setFirstPassword(c: Context) {
  const refuse = (status: 400 | 401 | 403 | 422 | 429, error: string, code?: string) =>
    c.json({ ok: false, error, code }, status)
  if (!authMethods.password) return refuse(400, 'Password sign-in is turned off')
  // Another site cannot send this with the session cookie: refuseCrossSite (csrf.ts) runs before every /v1 route.
  const headers = c.req.raw.headers
  // Only a session made on this address (host-sessions.ts): never one taken from a partner's address.
  const found = await auth.api.getSession({ headers })
  const session = found && sessionFitsHost(found.session as SessionHost, requestHostOf(c)) ? found : null
  if (!session) return refuse(401, 'not signed in')
  if (session.session.impersonatedBy) return refuse(403, NOT_WHILE_IMPERSONATING)
  if (!allowAttempt(session.user.id)) return refuse(429, 'Too many attempts. Try again in a few minutes.')
  if (!signedInRecently(session.session.createdAt))
    return refuse(403, 'Sign in again to set a password.', SIGN_IN_AGAIN)
  const { newPassword } = await c.req.json<{ newPassword?: unknown }>().catch(() => ({ newPassword: undefined }))
  if (typeof newPassword !== 'string') return refuse(422, 'newPassword is required')
  try {
    // Refused by Better Auth when a password already exists (that goes through change-password).
    await auth.api.setPassword({ body: { newPassword }, headers })
  } catch (err) {
    if (err instanceof APIError) return refuse(400, err.message)
    throw err
  }
  // Anyone else holding a session of this account is signed out.
  await auth.api.revokeOtherSessions({ headers })
  // And their setup links: a password set from a session someone else may hold ends those too (review #822 F2).
  await revokeSetupKeysOf(db, session.user.id, 'password_changed')
  return c.json({ ok: true })
}
