// Cross-site request forgery: the session cookie is SameSite=Lax, so a page on another subdomain of
// the same site still sends it, and a plain `text/plain` POST needs no preflight. Every request under
// /v1 that changes something and is signed in by the cookie must therefore come from the web app's
// own origin and carry JSON (which a cross-origin page cannot send without a preflight we never
// allow). Bearer requests (API keys, the voice agent) carry no ambient credential and are not
// affected; a request without a cookie has no session to abuse and gets its usual 401.
// Better Auth checks the Origin of /api/auth itself (trustedOrigins in auth.ts).
import type { MiddlewareHandler } from 'hono'
import { brandName } from './branding.ts'

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

type Request = { method: string; header: (name: string) => string | undefined }

/** Why a request must be refused as possibly cross-site, or null when it may run. */
export function crossSiteRefusal(req: Request, trustedOrigins: readonly string[]): string | null {
  if (SAFE_METHODS.includes(req.method.toUpperCase())) return null
  if (/^Bearer\s/i.test(req.header('authorization') ?? '')) return null
  if (!req.header('cookie')) return null
  const origin = req.header('origin')
  if (!origin || !trustedOrigins.includes(origin)) return `This request must come from the ${brandName()} app.`
  const mediaType = req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return 'This request must be sent as application/json.'
  return null
}

/** Hono middleware for /v1/*: 403 for a cookie-signed write from another origin or without JSON. */
export const refuseCrossSite =
  (trustedOrigins: readonly string[]): MiddlewareHandler =>
  async (c, next) => {
    const refusal = crossSiteRefusal({ method: c.req.method, header: name => c.req.header(name) }, trustedOrigins)
    if (refusal) return c.json({ ok: false, error: refusal, code: 'cross_site_refused' }, 403)
    await next()
  }
