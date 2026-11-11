// The two routes of an impersonation (docs/architecture.md §12): they run the registry actions
// (impersonation.ts) and move Better Auth's session cookie, signed the way Better Auth signs it.
import type { UserImpersonateData } from '@linedesk/actions'
import { session, user } from '@linedesk/db'
import { constantTimeEqual, makeSignature } from 'better-auth/crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import { auth } from './auth.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { IMPERSONATION_SEC } from './impersonation.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { runAction } from './run-action.ts'

// Cookies ---------------------------------------------------------------------------------

type AuthCookie = { name: string; attributes: CookieOptions }

async function cookies() {
  const ctx = await auth.$context
  const pick = ({ name, attributes: a }: { name: string; attributes: Record<string, unknown> }): AuthCookie => ({
    name,
    attributes: {
      path: (a.path as string) ?? '/',
      httpOnly: true,
      secure: Boolean(a.secure),
      sameSite: 'Lax',
      ...(a.domain ? { domain: a.domain as string } : {}),
    },
  })
  return {
    secret: ctx.secret,
    rememberedSec: ctx.sessionConfig.expiresIn,
    sessionToken: pick(ctx.authCookies.sessionToken),
    dontRemember: pick(ctx.authCookies.dontRememberToken),
    /** The admin's own session while they are signed in as someone else: `<token>:<1 if not remembered>`. */
    adminSession: pick(ctx.createAuthCookie('admin_session')),
  }
}
type Cookies = Awaited<ReturnType<typeof cookies>>

/** `value.signature`, HMAC-SHA256 with the auth secret: what Better Auth's `setSignedCookie` writes (Hono URL-encodes it the same way). */
const signed = async (value: string, secret: string) => `${value}.${await makeSignature(value, secret)}`

async function setSigned(c: Context, cookie: AuthCookie, value: string, secret: string, maxAge?: number) {
  setCookie(c, cookie.name, await signed(value, secret), { ...cookie.attributes, ...(maxAge ? { maxAge } : {}) })
}

/** The value of a cookie signed as above, or null when it is missing or the signature does not match. */
async function readSigned(c: Context, name: string, secret: string): Promise<string | null> {
  const raw = getCookie(c, name)
  const dot = raw?.lastIndexOf('.') ?? -1
  if (!raw || dot < 1) return null
  const value = raw.slice(0, dot)
  return constantTimeEqual(raw.slice(dot + 1), await makeSignature(value, secret)) ? value : null
}

const expire = (c: Context, cookie: AuthCookie) => deleteCookie(c, cookie.name, cookie.attributes)

/** Signs the browser in to a session, as Better Auth's `setSessionCookie` does. */
async function signInTo(c: Context, k: Cookies, token: string, remembered: boolean, maxAge?: number) {
  await setSigned(c, k.sessionToken, token, k.secret, maxAge ?? (remembered ? k.rememberedSec : undefined))
  if (remembered) expire(c, k.dontRemember)
  else await setSigned(c, k.dontRemember, 'true', k.secret)
}

/**
 * The admin's session from the admin cookie, if it may be resumed: it exists, has not expired, is
 * no impersonation itself, belongs to `adminId`, and that user is still an enabled instance admin.
 */
async function resumableAdminSession(c: Context, k: Cookies, adminId: string) {
  const value = await readSigned(c, k.adminSession.name, k.secret)
  if (!value) return null
  const [token = '', notRemembered] = value.split(':')
  const [row] = await db
    .select({ session, user })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.token, token), isNull(session.impersonatedBy)))
  if (!row || row.session.userId !== adminId || row.session.expiresAt.getTime() <= Date.now()) return null
  if (row.user.disabledAt || !isInstanceAdmin(row.user)) return null
  return { token, remembered: !notRemembered }
}

// Routes ----------------------------------------------------------------------------------

type Env = { Variables: { actor: Actor } }

export function registerImpersonationRoutes(app: Hono<Env>) {
  // Runs user.impersonate; on success the browser holds the user's new session, and the admin's
  // own session token waits in its own cookie for the way back. Both last the impersonation's hour.
  app.post('/v1/impersonation/start', async c => {
    const own = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } })
    if (!own) return c.json({ ok: false, error: 'not signed in' }, 401)
    const input = await c.req.json().catch(() => ({}))
    const { status, body } = await runAction('user.impersonate', input, c.get('actor'))
    if (!body.ok) return c.json(body, status)
    const data = body.data as UserImpersonateData
    const [started] = await db
      .select({ token: session.token })
      .from(session)
      .where(
        and(eq(session.id, data.sessionId), eq(session.impersonatedBy, own.user.id), eq(session.userId, data.userId)),
      )
    if (!started) return c.json({ ok: false, error: 'the session could not be started' }, 409)
    const k = await cookies()
    const ownRemembered = !(await readSigned(c, k.dontRemember.name, k.secret))
    await setSigned(c, k.adminSession, `${own.session.token}:${ownRemembered ? '' : '1'}`, k.secret, IMPERSONATION_SEC)
    // Not remembered: Better Auth then never extends the session (see also keepImpersonationExpiry).
    await signInTo(c, k, started.token, false, IMPERSONATION_SEC)
    return c.json({ ok: true, data })
  })

  // Runs impersonation.stop (deletes the impersonation session), then signs the browser back in
  // to the admin's own session if it may be resumed; otherwise the browser is signed out.
  app.post('/v1/impersonation/stop', async c => {
    const actor = c.get('actor')
    const { status, body } = await runAction('impersonation.stop', {}, actor)
    if (!body.ok) return c.json(body, status)
    const k = await cookies()
    const resumed = actor.impersonation ? await resumableAdminSession(c, k, actor.impersonation.by) : null
    if (resumed) await signInTo(c, k, resumed.token, resumed.remembered)
    else {
      expire(c, k.sessionToken)
      expire(c, k.dontRemember)
    }
    expire(c, k.adminSession)
    return c.json({ ok: true, resumed: Boolean(resumed) })
  })
}
