// The two steps of the authenticator app that pass the Server admin check (authenticator.ts): confirming a new app and
// checking with one. They run the registry actions, then remember this browser with the device cookie and alert every
// admin for a browser not seen before, as a passkey check does (admin-alerts.ts). An action cannot set cookies, so
// the generic action route refuses these two (app.ts).
import { user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { alertOnAuthenticatorCheck } from './admin-alerts.ts'
import { auth } from './auth.ts'
import { clientIpOf } from './client-ip.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { runAction } from './run-action.ts'

type Env = { Variables: { actor: Actor } }

const STEPS = { confirm: 'account.authenticatorConfirm', check: 'account.authenticatorCheck' } as const

export function registerAuthenticatorRoutes(app: Hono<Env>) {
  app.post('/v1/account/authenticator/:step', async c => {
    const name = STEPS[c.req.param('step') as keyof typeof STEPS]
    if (!name) return c.json({ ok: false, error: 'unknown step' }, 404)
    const actor = c.get('actor')
    const input = await c.req.json().catch(() => ({}))
    const { status, body } = await runAction(name, input, actor, c.req.header('idempotency-key'))
    if (!body.ok) return c.json(body, status)
    const [account] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, actor.actorId))
    if (account) {
      const secure = Boolean((await auth.$context).createAuthCookie('admin_device').attributes.secure)
      await alertOnAuthenticatorCheck(
        account,
        {
          secure,
          get: cookieName => getCookie(c, cookieName),
          set: (cookieName, value, a) =>
            setCookie(c, cookieName, value, {
              secure: a.secure,
              httpOnly: a.httpOnly,
              sameSite: 'Lax',
              path: a.path,
              maxAge: a.maxAge,
            }),
        },
        { ipAddress: clientIpOf(c), userAgent: c.req.header('user-agent') ?? null },
      )
    }
    return c.json(body, status)
  })
}
