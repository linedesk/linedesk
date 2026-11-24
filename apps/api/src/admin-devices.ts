// The browsers in which a server admin passed the passkey check (admin-alerts.ts, docs/architecture.md §12): only a
// check from a browser that is not one of them emails every server admin.
//
// The browser keeps a random token in a long-lived cookie; only its SHA-256 is stored, one row per admin and browser
// (`admin_devices`). The token is never logged. Every check issues a new token and replaces the row's hash, so a cookie
// copied off the machine shows up as a new device at the next check of either browser. A presented token is never
// stored as it is: one the server did not issue (planted from another subdomain, made up) finds no row and the browser
// counts as new. On https the cookie is `__Host-` (Secure, Path=/, no Domain), so no subdomain can set it.
// One browser shared by two admins: each check replaces the token, so after the other admin's check the next one there
// counts as new again (one alert per switch; accepted, it is rare).
import { createHash, randomBytes } from 'node:crypto'
import { admin_devices, type Tx } from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import type { db as Db } from './db.ts'

/** The longest a browser keeps a cookie; also how long an unused device row is kept (pruneOldAdminDevices). */
export const DEVICE_MAX_AGE_DAYS = 400
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes, base64url

export const deviceHash = (token: string) => createHash('sha256').update(token).digest('hex')

type CookieCtx = {
  getCookie: (name: string) => string | null | undefined
  setCookie: (name: string, value: string, attributes?: Record<string, unknown>) => unknown
  context: { createAuthCookie: (name: string) => { attributes: { secure?: boolean } } }
}
/** The Better Auth endpoint context of this sign-in, when there is one that can read and set cookies. */
function cookieCtx(ctx: unknown): CookieCtx | null {
  const c = ctx as Partial<CookieCtx> | null | undefined
  return c &&
    typeof c.getCookie === 'function' &&
    typeof c.setCookie === 'function' &&
    typeof c.context?.createAuthCookie === 'function'
    ? (c as CookieCtx)
    : null
}

/**
 * The device cookie's name and attributes. Secure exactly when Better Auth's own cookies are (https): then
 * `__Host-admin_device`, which browsers accept only with Secure, Path=/ and no Domain. On http a plain name.
 */
export function deviceCookie(secure: boolean) {
  return {
    name: secure ? '__Host-admin_device' : 'admin_device',
    attributes: {
      secure,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: DEVICE_MAX_AGE_DAYS * 24 * 60 * 60,
    },
  }
}

/**
 * Whether this browser passed this admin's passkey check before. Either way it gets a new token, stored as the row's
 * hash (the old one replaced), in one statement. Without a request to read the cookie from: never known, nothing
 * stored.
 */
export async function knownDevice(db: typeof Db, userId: string, ctx: unknown): Promise<boolean> {
  const c = cookieCtx(ctx)
  if (!c) return false
  return knownDeviceWith(db, userId, {
    secure: Boolean(c.context.createAuthCookie('admin_device').attributes.secure),
    get: name => c.getCookie(name),
    set: (name, value, attributes) => void c.setCookie(name, value, attributes),
  })
}

/** The browser's cookies, from wherever the check runs: a Better Auth endpoint, or our own route (authenticator-routes.ts). */
export type DeviceCookieJar = {
  secure: boolean
  get: (name: string) => string | null | undefined
  set: (name: string, value: string, attributes: ReturnType<typeof deviceCookie>['attributes']) => void
}

/** knownDevice with the cookies given directly. */
export async function knownDeviceWith(db: typeof Db, userId: string, jar: DeviceCookieJar): Promise<boolean> {
  const c = { getCookie: jar.get, setCookie: jar.set }
  const cookie = deviceCookie(jar.secure)
  const present = c.getCookie(cookie.name)
  const oldHash = present && DEVICE_TOKEN.test(present) ? deviceHash(present) : null
  const token = randomBytes(32).toString('base64url')
  const newHash = deviceHash(token)
  // Known: the row with the presented token's hash gets the new hash. Not known: a new row with the new hash only.
  const result = await db.execute<{ known: boolean }>(sql`
    with rotated as (
      update ${admin_devices} set device_hash = ${newHash}, last_seen_at = now()
      where user_id = ${userId} and device_hash = ${oldHash}
      returning 1
    ), added as (
      insert into ${admin_devices} (user_id, device_hash)
      select ${userId}, ${newHash} where not exists (select 1 from rotated)
      returning 1
    )
    select exists (select 1 from rotated) as known`)
  c.setCookie(cookie.name, token, cookie.attributes)
  return result.rows[0]?.known === true
}

/** Forgets every browser of a user: passkeys reset, admin revoked, account disabled. Their next check alerts again. */
export async function forgetAdminDevices(tx: Tx, userId: string): Promise<void> {
  await tx.delete(admin_devices).where(eq(admin_devices.user_id, userId))
}

/** Daily (jobs.ts): rows not seen for longer than the cookie can live. */
export async function pruneOldAdminDevices(db: typeof Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEVICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const pruned = await db
    .delete(admin_devices)
    .where(sql`${admin_devices.last_seen_at} < ${cutoff}`)
    .returning({ user_id: admin_devices.user_id })
  return pruned.length
}
