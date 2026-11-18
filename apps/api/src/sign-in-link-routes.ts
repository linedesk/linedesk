// The link page's two requests (sign-in-link.ts): what the page may show, and Continue. Public, before the workspace
// guard; both are POSTs with the token in a JSON body, never in an address, and from the app's own origin only.
// Continue signs in through Better Auth's `/sign-in/email-otp` with the link's code, so every hook of a typed code
// runs: the before-hook's lockouts, the tries of the code, the sign-up gate and invitations, the unproven-access
// cleanup, the audit log (method `email_code`) and the admin alerts. Any browser may Continue: the session is made for
// the browser that clicks, never for the one that asked for the code. A link works only on the address its code was
// asked on (host-sessions.ts codeFitsHost; security review of S5.2, H-1): on any other it is spent, never `Origin`
// alone deciding, which a server in the middle sets as it likes.
import { isAPIError } from 'better-auth/api'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { auth, trustedOrigins } from './auth.ts'
import { addressBucket, CLIENT_IP_HEADER, clientIpOf } from './client-ip.ts'
import type { Actor } from './context.ts'
import { createRateLimiter } from './rate-limit.ts'
import { codeFitsHost } from './host-sessions.ts'
import { rememberRequestHost, requestHostOf } from './request-host.ts'
import { readSignInLink, type SignInLinkState, takeSignInLink } from './sign-in-link.ts'

type Env = { Variables: { actor: Actor } }

/** 30 requests a minute per address: a token is 32 random bytes, this only keeps the page from being hammered. */
const allow = createRateLimiter({ max: 30, windowMs: 60_000 })

/** A token body is under 100 bytes. */
const MAX_BODY_BYTES = 1024

async function tokenOf(c: Context): Promise<string> {
  const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null
  return typeof body?.token === 'string' ? body.token : ''
}

/** The request's headers as Better Auth sees them (app.ts, withClientIp): our client IP header, never the client's. */
function authHeaders(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers)
  headers.delete(CLIENT_IP_HEADER)
  headers.delete('content-length')
  const ip = clientIpOf(c)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  // The address the host middleware resolved for this request: the session is made for it (host-sessions.ts).
  rememberRequestHost(headers, requestHostOf(c))
  return headers
}

/**
 * Only from the app's own pages (csrf.ts already refuses a cookie-signed one from elsewhere; this needs no cookie): the
 * install's origins, or the request's own partner address while it is live (S5).
 */
const fromApp = (c: Context) => trustedOrigins(c).includes(c.req.header('origin') ?? '')

/** The link as this address sees it: spent unless its code was asked on this address. */
async function linkHere(c: Context, token: string): Promise<SignInLinkState> {
  const link = await readSignInLink(token)
  if (link.state !== 'ready') return link
  return (await codeFitsHost('sign-in', link.email, requestHostOf(c))) ? link : { state: 'spent' }
}

export function registerSignInLinkRoutes(app: Hono<Env>) {
  app.use('/v1/sign-in-link/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: c => c.json({ ok: false }, 413) }))

  app.post('/v1/sign-in-link/check', async c => {
    c.header('cache-control', 'no-store')
    if (!fromApp(c)) return c.json({ ok: false, code: 'cross_site_refused' }, 403)
    if (!allow(addressBucket(clientIpOf(c)))) return c.json({ ok: false, code: 'TOO_MANY_REQUESTS' }, 429)
    const link = await linkHere(c, await tokenOf(c))
    if (link.state === 'ready') return c.json({ ok: true, state: 'ready', email: link.email })
    return c.json({ ok: true, state: link.state })
  })

  app.post('/v1/sign-in-link/use', async c => {
    c.header('cache-control', 'no-store')
    if (!fromApp(c)) return c.json({ ok: false, code: 'cross_site_refused' }, 403)
    if (!allow(addressBucket(clientIpOf(c)))) return c.json({ ok: false, code: 'TOO_MANY_REQUESTS' }, 429)
    const token = await tokenOf(c)
    // Checked before the link is taken: a try on another address does not use it up.
    const link = await linkHere(c, token)
    if (link.state !== 'ready') return c.json({ ok: false, state: link.state }, 400)
    // Single use: only the request that deleted the link goes on.
    if (!(await takeSignInLink(token))) return c.json({ ok: false, state: 'spent' }, 400)
    let signedIn: Response
    try {
      signedIn = await auth.api.signInEmailOTP({
        body: { email: link.email, otp: link.otp },
        headers: authHeaders(c),
        asResponse: true,
      })
    } catch (err) {
      // A before-hook's refusal (too many wrong codes, sign-in limits) is thrown even with asResponse.
      if (!isAPIError(err)) throw err
      const code = (err.body as { code?: string } | undefined)?.code ?? null
      return c.json({ ok: false, code }, err.statusCode as 400)
    }
    // Better Auth's answer with its session cookie; its body (the session token) stays on the server.
    const headers = new Headers()
    for (const cookie of signedIn.headers.getSetCookie()) headers.append('set-cookie', cookie)
    headers.set('content-type', 'application/json')
    headers.set('cache-control', 'no-store')
    if (signedIn.ok) return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
    const error = (await signedIn.json().catch(() => ({}))) as { code?: string }
    return new Response(JSON.stringify({ ok: false, code: error.code ?? null }), { status: signedIn.status, headers })
  })
}
