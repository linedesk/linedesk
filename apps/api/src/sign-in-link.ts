// The button in the sign-in code email ("Sign in to <brand>"): one click signs in, the code below it stays the way
// for every other case. Safe against what made us drop email links before (#70, #750):
// - Mail scanners (Outlook Safe Links, Mimecast) open every link. The link only opens the app's own page; the token is
//   in the address's fragment (#sign-in=…), which no server and no Referer ever sees, and nothing signs in until the
//   person clicks Continue on that page (a POST from the app's origin, csrf.ts).
// - It works in any browser, like the code: mail apps often open links in another browser or their own in-app one.
//   Continue signs in the browser that clicks it, with a new session there; it never signs in or approves the browser
//   that asked for the code (no cross-device approval). The page shows the address before Continue, so a link someone
//   forwards from their own email cannot slip another account in unnoticed.
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

type Stored = { email: string; otp: string }

/**
 * Where the email's link and its "sign-in page at <site>" point: the origin the code was asked from when it is one
 * of ours (WEB_ORIGIN, or LINEDESK_DEV_ORIGINS in development), else the main one. Never anything a request names
 * that is not on that list, so no link can lead elsewhere.
 */
export function linkOrigin(requestOrigin: string | null | undefined, trusted: readonly string[], main: string): string {
  return requestOrigin && trusted.includes(requestOrigin) ? requestOrigin : main
}

/**
 * The link's address: the app's link page with the token in the fragment. `path` is the page the flow goes on at
 * after Continue (`/signup?…` for a code from the sign-up page, signup-gate.ts `signupPageLinkPath`), else the app.
 */
export const signInLinkUrl = (origin: string, token: string, path = '/') =>
  `${origin}${path}#${SIGN_IN_LINK_HASH}=${token}`

/** Stores a new link for this code; returns the token (never logged). */
export async function createSignInLink(email: string, otp: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const value: Stored = { email: email.toLowerCase(), otp: encrypt(token, otp) }
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
 * What the link page may show, in any browser. `spent`: unknown, expired, used, or its code was used, replaced or ran
 * out (one answer for all; a spent link's row is deleted); `ready`: Continue, with the address it signs in.
 */
export type SignInLinkState = { state: 'spent' } | { state: 'ready'; email: string; otp: string }

export async function readSignInLink(token: string): Promise<SignInLinkState> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'spent' }
  const identifier = `${PREFIX}${sha256(token)}`
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .limit(1)
  if (!row) return { state: 'spent' }
  const stored = JSON.parse(row.value) as Stored
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
