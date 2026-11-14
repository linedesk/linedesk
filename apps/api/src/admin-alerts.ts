// Every instance admin hears about what could take over the admin role (docs/architecture.md §12):
// an admin's sign-in from a device or address not seen before, and admin granted or passkeys reset.
// No sign-in alerts on an instance that runs on localhost: local development, nobody to warn. Sent without waiting: a failed email never stops
// the sign-in or the action it is about.
import { auth_events, user } from '@linedesk/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import { signInMethod } from './audit.ts'
import { db } from './db.ts'
import { type EmailSender, emailSender, sendNotice } from './email.ts'
import { adminAlertEmail } from './emails/templates.ts'
import { instanceAdminEmails, isInstanceAdmin } from './instance-admin.ts'
import { brandName } from './branding.ts'
import { takeSetupSignIn } from './setup.ts'

/**
 * Emails every enabled instance admin. Resolves once the list is read; the sends run on their own. Without email set
 * up: skipped with one log line (no stack, nothing to retry).
 */
export async function alertInstanceAdmins(subject: string, text: string, sender: EmailSender = emailSender) {
  if (sender.kind === 'none') {
    console.log(`Admin alert not sent (email is not set up): ${subject}`)
    return
  }
  for (const to of await instanceAdminEmails())
    sendNotice({ to, ...adminAlertEmail(subject, text) }, 'admin alert email', sender)
}

const methodNames: Record<string, string> = {
  password: 'a password',
  email_code: 'an email code',
  email_link: 'an email link',
  passkey: 'a passkey',
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
  other: 'a sign-in method this server does not recognise',
}

type SignIn = { userId: string; impersonatedBy?: string | null; ipAddress?: string | null; userAgent?: string | null }

/**
 * Whether this account signed in before from this address and browser. Runs after the audit log
 * recorded this sign-in, so one earlier record makes two; unknown address or browser: never known.
 */
async function knownDevice(s: SignIn): Promise<boolean> {
  if (!s.ipAddress || !s.userAgent) return false
  const [row] = await db
    .select({ n: count() })
    .from(auth_events)
    .where(
      and(
        eq(auth_events.user_id, s.userId),
        inArray(auth_events.event, ['sign_in', 'sign_up']),
        eq(auth_events.ip_address, s.ipAddress),
        eq(auth_events.user_agent, s.userAgent),
      ),
    )
  return (row?.n ?? 0) >= 2
}

/**
 * Text from the request (the browser's User-Agent, a provider id) goes into an email: no links that
 * could be clicked, nothing long. URLs become "[link]"; at most 120 characters.
 */
export function plainSnippet(text: string | null | undefined, max = 120): string {
  if (!text) return 'unknown'
  const plain = text.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '[link]').replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain || 'unknown'
}

/** The email about an admin's sign-in; exported for tests. */
export function adminSignInEmail(who: string, method: string, newDevice: boolean, s: SignIn) {
  const how = methodNames[method] ?? plainSnippet(method, 40)
  return {
    subject: `Admin sign-in to ${brandName()}: ${who}`,
    text: [
      `${who}, an instance admin, signed in with ${how}${newDevice ? ' from a device or address not seen before' : ''}.`,
      '',
      `Address: ${plainSnippet(s.ipAddress, 64)}`,
      `Browser: ${plainSnippet(s.userAgent)}`,
      '',
      'If this was not them, sign in with your passkey, then in Server admin › Users: disable the account and reset its passkeys.',
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

/** Better Auth `session.create.after`, merged after the audit log's (auth.ts). */
export async function alertOnAdminSignIn(created: SignIn, ctx: unknown) {
  if (created.impersonatedBy || isLocalInstance()) return
  // The first admin's sign-in at setup: the account was made seconds ago by the person signing in.
  if (takeSetupSignIn(created.userId)) return
  // Every session an admin gets counts; one made by an endpoint not known here is reported as 'other'.
  const method = signInMethod(ctx as Parameters<typeof signInMethod>[0]) ?? 'other'
  try {
    const [account] = await db.select().from(user).where(eq(user.id, created.userId))
    if (!account || !isInstanceAdmin(account)) return
    // Only a device or address not seen before for this account is worth a warning, whatever the method.
    if (await knownDevice(created)) return
    const { subject, text } = adminSignInEmail(account.email, method, true, created)
    await alertInstanceAdmins(subject, text)
  } catch (err) {
    console.error('admin sign-in alert failed', err)
  }
}

export const adminAlertHooks = { session: { create: { after: alertOnAdminSignIn } } }
