// Every instance admin hears about what could take over the admin role (docs/architecture.md §12):
// an admin passing the passkey check from a browser not seen before, and admin granted or passkeys reset.
// No sign-in alerts on an instance that runs on localhost: local development, nobody to warn. Sent without waiting: a failed email never stops
// the sign-in or the action it is about.
import { user } from '@linedesk/db'
import { SOURCE } from '@linedesk/i18n'
import { eq } from 'drizzle-orm'
import { type DeviceCookieJar, knownDevice, knownDeviceWith } from './admin-devices.ts'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { signInMethod } from './audit.ts'
import { brandName } from './branding.ts'
import { db } from './db.ts'
import { type EmailSender, emailSender, sendNotice } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { adminAlertEmail } from './emails/templates.ts'
import { instanceAdminEmails, isInstanceAdmin } from './instance-admin.ts'
import { takeSetupSignIn } from './setup.ts'

/**
 * Emails every enabled instance admin. Resolves once the list and their languages are read; the sends run on their own. Without email set
 * up: skipped with one log line (no stack, nothing to retry).
 */
export async function alertInstanceAdmins(subject: string, text: string, sender: EmailSender = emailSender) {
  if (sender.kind === 'none') {
    console.log(`Admin alert not sent (email is not set up): ${subject}`)
    return
  }
  // The frame in each admin's language; the alert itself (subject and text) stays English.
  const admins = await instanceAdminEmails()
  const locales = await Promise.all(admins.map(to => localeForEmail(db, to).catch(() => SOURCE)))
  admins.forEach((to, i) =>
    sendNotice({ to, ...adminAlertEmail(subject, text, undefined, locales[i]) }, 'admin alert email', sender),
  )
}

const methodNames: Record<string, string> = {
  password: 'a password',
  email_code: 'an email code',
  email_link: 'an email link',
  passkey: 'a passkey',
  authenticator: 'their authenticator app',
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
  other: 'a sign-in method this server does not recognise',
}

type SignIn = {
  userId: string
  impersonatedBy?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  /** Set only on a session started by a passkey sign-in the device verified (admin-second-factor.ts). */
  passkeyVerifiedAt?: Date | string | null
}

/**
 * Text from the request (the browser's User-Agent, a provider id) goes into an email: no links that
 * could be clicked, nothing long. URLs become "[link]"; at most 120 characters.
 */
export function plainSnippet(text: string | null | undefined, max = 120): string {
  if (!text) return 'unknown'
  const plain = text
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '[link]')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain || 'unknown'
}

/** "Chrome on macOS" from a User-Agent; null when neither is recognised. Approximate: the header is the browser's say. */
export function browserOf(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const ua = userAgent
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? (os ? `a browser on ${os}` : null)
}

/** The email about an admin's passkey check (or, with the rule off, sign-in) from a new device; exported for tests. */
export function adminSignInEmail(who: string, method: string, s: SignIn, at = new Date()) {
  const how = methodNames[method] ?? plainSnippet(method, 40)
  const what =
    method === 'passkey'
      ? `${who}, a server admin, confirmed with their passkey from a device not seen before for them.`
      : method === 'authenticator'
        ? `${who}, a server admin, confirmed with their authenticator app from a device not seen before for them.`
        : `${who}, a server admin, signed in with ${how} from a device not seen before for them.`
  return {
    subject: `Admin sign-in from a new device on ${brandName()}: ${who}`,
    text: [
      what,
      '',
      `Time: ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      `Browser: ${browserOf(s.userAgent) ?? plainSnippet(s.userAgent)}`,
      `Address: ${plainSnippet(s.ipAddress, 64)}`,
      '',
      'If this was them, nothing to do. If not, someone has their passkey, authenticator app or device: sign in with your own passkey, then in Server admin › Users disable the account and reset its passkeys.',
    ].join('\n'),
  }
}

/** Whether this instance is opened on localhost (PUBLIC_URL, else WEB_ORIGIN): local development. */
export function isLocalInstance(env: Record<string, string | undefined> = process.env): boolean {
  const origin = env.PUBLIC_URL || env.WEB_ORIGIN || 'http://localhost'
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * Whether this sign-in is the admin's passkey check: the one that opens Server admin (admin-second-factor.ts). With the
 * rule off (ADMIN_SECOND_FACTOR=off) every sign-in opens it, so every sign-in counts.
 */
const passedAdminCheck = (s: SignIn) => !adminSecondFactorRequired() || Boolean(s.passkeyVerifiedAt)

/**
 * Better Auth `session.create.after`, merged after the audit log's (auth.ts), which records every sign-in either way.
 * Emails every admin only when an admin passes the passkey check from a browser that has not passed theirs before.
 */
export async function alertOnAdminSignIn(created: SignIn, ctx: unknown) {
  // Impersonation is never a check and never remembers a device.
  if (created.impersonatedBy || isLocalInstance()) return
  // The first admin's sign-in at setup: the account was made seconds ago by the person signing in.
  const setupSignIn = takeSetupSignIn(created.userId)
  if (!passedAdminCheck(created)) return
  // A check from an endpoint not known here is reported as 'other'.
  const method = signInMethod(ctx as Parameters<typeof signInMethod>[0]) ?? 'other'
  try {
    const [account] = await db.select().from(user).where(eq(user.id, created.userId))
    if (!account || !isInstanceAdmin(account)) return
    // A failure to read or store the device counts as a new device: the alert goes out (fails closed).
    const known = await knownDevice(db, account.id, ctx).catch(err => {
      console.error('admin device check failed', err)
      return false
    })
    if (known || setupSignIn) return
    const { subject, text } = adminSignInEmail(account.email, method, created)
    await alertInstanceAdmins(subject, text)
  } catch (err) {
    console.error('admin sign-in alert failed', err)
  }
}

export const adminAlertHooks = { session: { create: { after: alertOnAdminSignIn } } }

/**
 * After an admin's check with their authenticator app (authenticator-routes.ts): the same rule as for a passkey check,
 * an email to every admin only from a browser that has not passed their check before.
 */
export async function alertOnAuthenticatorCheck(
  account: { id: string; email: string },
  jar: DeviceCookieJar,
  request: { ipAddress?: string | null; userAgent?: string | null },
) {
  if (isLocalInstance()) return
  try {
    const known = await knownDeviceWith(db, account.id, jar).catch(err => {
      console.error('admin device check failed', err)
      return false
    })
    if (known) return
    const { subject, text } = adminSignInEmail(account.email, 'authenticator', { userId: account.id, ...request })
    await alertInstanceAdmins(subject, text)
  } catch (err) {
    console.error('admin authenticator alert failed', err)
  }
}
