// "This browser signed in to this account before" (LIN-442): a cookie set at every sign-in, so the person's own browser
// is not kept out of code sign-in and password reset by the caps across every IP (sign-in-limits.ts), which anyone
// with enough networks can fill for an address. The limits per address and IP still apply to it.
// - The value is the account's id and the time it was issued, signed (HMAC-SHA256) with a key derived from
//   BETTER_AUTH_SECRET: nobody can make one, change its account or extend it. A cookie only counts for the account it
//   names, and only for that account's current address (checked in sign-in-limits.ts).
// - 90 days from the last sign-in; every sign-in (and session refresh) in that browser issues a new one.
// - Not the `sign_in_browser` cookie (sign-in-link.ts): that one is a random value every visitor gets by asking for a
//   code, for any address, and proves no sign-in.
// - httpOnly, `__Host-` on https (Secure, Path=/, no Domain), SameSite=Lax. A cookie planted on plain http is still
//   only a valid one, which helps only for its own account.
import { type createAuthMiddleware, isAPIError } from 'better-auth/api'
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How long a browser counts as known after its last sign-in. */
export const KNOWN_BROWSER_DAYS = 90
const MAX_AGE_MS = KNOWN_BROWSER_DAYS * 24 * 60 * 60_000
/** A clock a little ahead on another API process does not make a new cookie invalid. */
const SKEW_MS = 5 * 60_000
/** Far longer than any real value; anything longer is not read at all. */
const MAX_LENGTH = 512

type Env = Record<string, string | undefined>

/** The cookie: `__Host-known_browser` on https, `known_browser` on http (as `browserCookie` in sign-in-link.ts). */
export function knownBrowserCookie(secure: boolean) {
  return {
    name: secure ? '__Host-known_browser' : 'known_browser',
    attributes: {
      secure,
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: KNOWN_BROWSER_DAYS * 24 * 60 * 60,
    },
  }
}
/** Both names are read: a value is only trusted for its signature, whichever name it came in. */
const COOKIE_NAMES = [knownBrowserCookie(true).name, knownBrowserCookie(false).name]

/** Null without BETTER_AUTH_SECRET: then no browser is known, and every request gets the caps across IPs. */
function signingKey(env: Env): Buffer | null {
  const secret = env.BETTER_AUTH_SECRET
  return secret ? createHmac('sha256', secret).update('linedesk known browser v1').digest() : null
}

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(`v1.${payload}`).digest()

/** A new value for this account, issued now; null without a signing key. */
export function signKnownBrowser(userId: string, nowMs = Date.now(), env: Env = process.env): string | null {
  const key = signingKey(env)
  if (!key) return null
  const payload = Buffer.from(JSON.stringify({ u: userId, t: nowMs })).toString('base64url')
  return `${payload}.${mac(key, payload).toString('base64url')}`
}

export type KnownBrowser = { userId: string; issuedAt: number }

/** The account and issue time of a valid, unexpired value; null for anything else. Never throws. */
export function verifyKnownBrowser(
  value: string | null | undefined,
  nowMs = Date.now(),
  env: Env = process.env,
): KnownBrowser | null {
  const key = signingKey(env)
  if (!key || !value || value.length > MAX_LENGTH) return null
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra !== undefined) return null
  const given = Buffer.from(signature, 'base64url')
  const expected = mac(key, payload)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; t?: unknown }
    if (typeof u !== 'string' || !u || typeof t !== 'number' || !Number.isFinite(t)) return null
    if (t > nowMs + SKEW_MS || nowMs - t >= MAX_AGE_MS) return null
    return { userId: u, issuedAt: t }
  } catch {
    return null
  }
}

/**
 * The values of the known-browser cookies in a Cookie header: the first one of each name, so at most two, however many
 * a request sends.
 */
export function knownBrowserValues(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return []
  const found = new Map<string, string>()
  for (const part of cookieHeader.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    const name = part.slice(0, at).trim()
    if (COOKIE_NAMES.includes(name) && !found.has(name)) found.set(name, part.slice(at + 1).trim())
  }
  return COOKIE_NAMES.flatMap(name => (found.has(name) ? [found.get(name)!] : []))
}

type AfterCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/**
 * After Better Auth's endpoints: whenever one gave this browser a session (any sign-in method, and a session's daily
 * refresh), the browser gets a new known-browser value for that account. A provider sign-in ends in a redirect, which
 * Better Auth returns as an APIError with a 3xx status: that is a sign-in too; only a 4xx or 5xx answer is not. Never
 * for an admin signed in as the user (impersonation.ts): that browser is the admin's.
 */
export function rememberKnownBrowser(ctx: AfterCtx) {
  const { returned, newSession } = ctx.context
  const userId = newSession?.user?.id
  if (!userId || newSession.session?.impersonatedBy || (isAPIError(returned) && returned.statusCode >= 400)) return
  const value = signKnownBrowser(userId)
  if (!value) return
  const cookie = knownBrowserCookie(Boolean(ctx.context.createAuthCookie('known_browser').attributes.secure))
  ctx.setCookie(cookie.name, value, cookie.attributes)
}
