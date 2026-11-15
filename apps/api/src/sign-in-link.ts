// The button in the sign-in code email ("Sign in to <brand>"): one click signs in, the code below it stays the way
// for every other case. Safe against what made us drop email links before (#70, #750):
// - Mail scanners (Outlook Safe Links, Mimecast) open every link. The link only opens the app's own page; the token is
//   in the address's fragment (#sign-in=…), which no server and no Referer ever sees, and nothing signs in until the
//   person clicks Continue on that page (a POST from the app's origin, csrf.ts).
// - It works only in the browser that asked for the code: asking sets a random cookie (`sign_in_browser`), and the
//   link is stored with that cookie's SHA-256. Anywhere else the page says to enter the code, and tells nothing else.
// - The token is 32 random bytes. Stored: its SHA-256 (the row's identifier) and the code, encrypted with a key derived
//   from the token, so the link row adds no new way to read the code (Better Auth's own row already holds an unsalted
//   SHA-256 of it, which a reader of the database can brute-force within its 10 minutes). Using the link signs in
//   with that code through Better Auth's own `/sign-in/email-otp`: the same expiry, tries, lockouts, sign-up gate,
//   invitations and audit as typing it, and either one used ends the other (the code is spent). Rows live in Better
//   Auth's `verification` table and expire with the code.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { verification } from '@linedesk/db'
import { and, desc, eq, gt } from 'drizzle-orm'
import { db } from './db.ts'
import { ALLOWED_TRIES } from './password-reset.ts'

/** How long a link works: the code's lifetime (auth.ts, emailOTP `expiresIn`). */
export const SIGN_IN_LINK_SECONDS = 600
/** The hash parameter of the web app's link page (apps/web/src/SignInLink.tsx). */
export const SIGN_IN_LINK_HASH = 'sign-in'
const PREFIX = 'sign-in-link-'
const KEY_INFO = 'linedesk sign-in link'
/** The full GCM tag: a shorter one is refused. */
const TAG_BYTES = 16

/**
 * The browser cookie: `__Host-` on https (Secure, Path=/, no Domain, so no subdomain can set it), a plain name on
 * http, where a sibling host or the network can plant a value: the binding is strong only on https. Continue gives the
 * browser a new value (sign-in-link-routes.ts), so a planted one works at most once. One day: long enough for any code, and the same browser keeps its value across several codes.
 */
export function browserCookie(secure: boolean) {
  return {
    name: secure ? '__Host-sign_in_browser' : 'sign_in_browser',
    attributes: { secure, httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: 24 * 60 * 60 },
  }
}

type CookieCtx = {
  getCookie: (name: string) => string | null | undefined
  setCookie: (name: string, value: string, attributes?: Record<string, unknown>) => unknown
  context: { createAuthCookie: (name: string) => { attributes: { secure?: boolean } } }
  headers?: Headers
  request?: Request
}

/**
 * The browser's value on the request that asks for a sign-in code (a Better Auth endpoint context): the one it has,
 * or a new one set on the answer. Set for every address alike, so the answer tells nothing about accounts. Null for
 * a server-side call (`auth.api` without a request or headers: no browser gets the cookie), so that email has no
 * button, only the code.
 */
export function browserNonceFor(ctx: unknown): string | null {
  const c = ctx as Partial<CookieCtx> | null | undefined
  if (!c || typeof c.getCookie !== 'function' || typeof c.setCookie !== 'function' || !c.context?.createAuthCookie)
    return null
  if (!c.request && !c.headers) return null
  const cookie = browserCookie(Boolean(c.context.createAuthCookie('sign_in_browser').attributes.secure))
  const present = c.getCookie(cookie.name)
  if (present && /^[A-Za-z0-9_-]{43}$/.test(present)) return present
  const nonce = newBrowserNonce()
  c.setCookie(cookie.name, nonce, cookie.attributes)
  return nonce
}

/** A new browser value: 32 random bytes. */
export const newBrowserNonce = () => randomBytes(32).toString('base64url')

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')
const keyOf = (token: string) => Buffer.from(hkdfSync('sha256', token, '', KEY_INFO, 32))
const sameHash = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

function encrypt(token: string, otp: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(token), iv, { authTagLength: TAG_BYTES })
  const data = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()])
  return [iv, data, cipher.getAuthTag()].map(b => b.toString('base64url')).join('.')
}

function decrypt(token: string, sealed: string): string | null {
  const [iv, data, tag] = sealed.split('.').map(p => Buffer.from(p, 'base64url'))
  if (!iv || !data || tag?.length !== TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(token), iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

type Stored = { email: string; browser: string; otp: string }

/**
 * Where the email's link and its "sign-in page at <site>" point: the origin the code was asked from when it is one
 * of ours (WEB_ORIGIN, or LINEDESK_DEV_ORIGINS in development), else the main one. Never anything a request names
 * that is not on that list, so no link can lead elsewhere.
 */
export function linkOrigin(requestOrigin: string | null | undefined, trusted: readonly string[], main: string): string {
  return requestOrigin && trusted.includes(requestOrigin) ? requestOrigin : main
}

/** The link's address: the app's link page with the token in the fragment. */
export const signInLinkUrl = (origin: string, token: string) => `${origin}/#${SIGN_IN_LINK_HASH}=${token}`

/** Stores a new link for this code and browser; returns the token (never logged). */
export async function createSignInLink(email: string, otp: string, browserNonce: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const value: Stored = { email: email.toLowerCase(), browser: sha256(browserNonce), otp: encrypt(token, otp) }
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: `${PREFIX}${sha256(token)}`,
    value: JSON.stringify(value),
    expiresAt: new Date(Date.now() + SIGN_IN_LINK_SECONDS * 1000),
  })
  return token
}

/**
 * Whether the code behind a link can still sign in: Better Auth's row for it (`sign-in-otp-<email>`, value
 * `<sha256 of the code>:<tries>`, auth.ts `storeOTP: 'hashed'`) holds this code, is not expired and has tries left.
 * A code that was typed, replaced by a newer one, expired or locked makes the link spent too.
 */
async function codeStillValid(email: string, otp: string): Promise<boolean> {
  const [row] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, `sign-in-otp-${email}`))
    // The latest row is the code, as Better Auth reads it: a wrong try adds a row with one more try counted.
    .orderBy(desc(verification.createdAt))
    .limit(1)
  if (!row || row.expiresAt <= new Date()) return false
  const at = row.value.lastIndexOf(':')
  const [hash, tries] = at === -1 ? [row.value, '0'] : [row.value.slice(0, at), row.value.slice(at + 1)]
  return Number(tries) < ALLOWED_TRIES && sameHash(hash, sha256(otp))
}

/**
 * What the link page may show. `other`: unknown, expired, or another browser (one answer for all, nothing told);
 * `spent`: this browser's link, but its code was used, replaced or ran out (the link is deleted); `ready`: Continue.
 */
export type SignInLinkState = { state: 'other' } | { state: 'spent' } | { state: 'ready'; email: string; otp: string }

export async function readSignInLink(token: string, browserNonce: string | null | undefined): Promise<SignInLinkState> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !browserNonce) return { state: 'other' }
  const identifier = `${PREFIX}${sha256(token)}`
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .limit(1)
  if (!row) return { state: 'other' }
  const stored = JSON.parse(row.value) as Stored
  if (!sameHash(stored.browser, sha256(browserNonce))) return { state: 'other' }
  const otp = decrypt(token, stored.otp)
  if (!otp || !(await codeStillValid(stored.email, otp))) {
    await db.delete(verification).where(eq(verification.identifier, identifier))
    return { state: 'spent' }
  }
  return { state: 'ready', email: stored.email, otp }
}

/** Takes the link once: true only for the one request that deleted it (two clicks at once sign in once). */
export async function takeSignInLink(token: string): Promise<boolean> {
  const taken = await db
    .delete(verification)
    .where(eq(verification.identifier, `${PREFIX}${sha256(token)}`))
    .returning({ id: verification.id })
  return taken.length > 0
}
