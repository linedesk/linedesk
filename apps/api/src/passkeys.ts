// Passkeys (WebAuthn) through Better Auth's passkey plugin. A passkey signs in an existing account
// only: it is added from Account settings by a signed-in member, never created at sign-in, so a
// passkey cannot make a new user and closed sign-up holds (docs/architecture.md, passkeys).
import { passkey } from '@better-auth/passkey'
import { passkey as passkeyTable, user } from '@linedesk/db'
import { APIError, type createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { noteUserVerified, passkeyConfirmed } from './admin-second-factor.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { passkeyChangedEmail } from './emails/templates.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { clearPasskeyEnrolment, ENROLMENT_HEADER, enrolmentCodeValid, enrolmentPending } from './passkey-enrolment.ts'
import { brandName } from './branding.ts'
import { localeForEmail } from './email-locale.ts'

type Env = Record<string, string | undefined>
type AuthCtx = Parameters<typeof getSessionFromCtx>[0]

/**
 * The relying party is the address people open: PUBLIC_URL (docker compose), else WEB_ORIGIN. The
 * browser binds each passkey to this host name, and the server accepts ceremonies only from this
 * origin, never one the request names.
 */
export function passkeyRelyingParty(env: Env) {
  const url = new URL(env.PUBLIC_URL || env.WEB_ORIGIN || 'http://localhost:5173')
  return { rpID: url.hostname, rpName: `${brandName()}`, origin: url.origin }
}

/** Better Auth's plugin, with registration only for a signed-in member (the plugin's default, stated). */
export const passkeyPlugin = (env: Env) =>
  passkey({
    ...passkeyRelyingParty(env),
    // A passkey is two factors only when the device checks the person (fingerprint, face or PIN: WebAuthn user
    // verification). Required when a passkey is added and when one signs in: the browser asks for it, and the plugin
    // refuses a response without it (requireUserVerification). A security key without a PIN only proves possession.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    // A passkey is added to the account of the session that asks, after a recent sign-in (the
    // plugin's fresh-session check). There is no `resolveUser`: no passkey-first sign-up.
    registration: { requireSession: true },
    authentication: {
      afterVerification: async ({ ctx, verification, clientData }) => {
        // Signed in already (a passkey step-up): only one of this account's passkeys counts.
        await refuseOtherAccountsPasskey((await getSessionFromCtx(ctx as AuthCtx))?.user.id ?? null, clientData.id)
        // What the session.create hook reads: only a sign-in the device verified counts as the passkey check.
        if (verification.authenticationInfo.userVerified) noteUserVerified(ctx)
      },
    },
  })

/** The code a passkey sign-in without user verification is refused with (the web app explains it). */
export const PASSKEY_USER_NOT_VERIFIED = 'PASSKEY_USER_NOT_VERIFIED'
/** The WebAuthn flag "user verified" in authenticatorData (byte 32, after the 32-byte hash of the relying party). */
const UV_FLAG = 0x04

/**
 * Before Better Auth's passkey sign-in: a response whose device did not verify the person is refused with a clear
 * code. The plugin refuses it as well (userVerification 'required'), only with a generic "did not work". The flag is
 * read before the signature is checked, so it only ever chooses the refusal's text, never lets anything through.
 */
export function refuseUnverifiedPasskey(ctx: { path: string; body?: unknown }) {
  if (ctx.path !== '/passkey/verify-authentication') return
  const data = (ctx.body as { response?: { response?: { authenticatorData?: unknown } } } | undefined)?.response
    ?.response?.authenticatorData
  if (typeof data !== 'string') return
  const bytes = Buffer.from(data, 'base64url')
  if (bytes.length < 37 || bytes[32]! & UV_FLAG) return
  throw new APIError('FORBIDDEN', {
    code: PASSKEY_USER_NOT_VERIFIED,
    message:
      "This passkey doesn't check your fingerprint, face or PIN. Sign in another way, or ask an admin to reset your passkeys.",
  })
}

/**
 * A passkey sign-in from a signed-in browser is a confirmation of that person (the step-ups, the check before Server
 * admin): the browser already offers only their passkeys (Better Auth lists them as allowCredentials), and the server
 * refuses another account's passkey too, so a confirmation never switches the browser to someone else. Without a
 * session (the sign-in page) any passkey signs its own account in.
 */
export const PASSKEY_OTHER_ACCOUNT = 'PASSKEY_OTHER_ACCOUNT'
export async function refuseOtherAccountsPasskey(signedInUserId: string | null, credentialId: string) {
  if (!signedInUserId) return
  const [row] = await db
    .select({ userId: passkeyTable.userId })
    .from(passkeyTable)
    .where(eq(passkeyTable.credentialID, credentialId))
  if (row && row.userId !== signedInUserId)
    throw new APIError('FORBIDDEN', {
      code: PASSKEY_OTHER_ACCOUNT,
      message: 'That passkey belongs to another account. Use one of your own passkeys.',
    })
}

/** The endpoints that add, rename or remove a passkey. */
const PASSKEY_CHANGE_PATHS = [
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]

/** The endpoints that add a passkey. */
const ADD_PATHS = ['/passkey/generate-register-options', '/passkey/verify-registration']

/** The code the web app answers with "Sign in with your passkey": a session started by a passkey is needed. */
export const PASSKEY_CONFIRMATION_REQUIRED = 'PASSKEY_CONFIRMATION_REQUIRED'
/** An instance admin's first passkey needs the one-time enrolment code (passkey-enrolment.ts). */
export const PASSKEY_ENROLMENT_REQUIRED = 'PASSKEY_ENROLMENT_REQUIRED'

type PasskeySession = { createdAt: Date | string; passkeyVerifiedAt?: Date | string | null }

/** What the rule needs to know about the account and the request. */
export type PasskeyAccount = {
  isAdmin: boolean
  hasPasskey: boolean
  /** An unexpired enrolment code exists. */
  enrolmentPending: boolean
  /** The request carries that code. */
  enrolmentCodeValid: boolean
}

/**
 * Why this request may not change the account's passkeys, or null when it may. Once an account has
 * a passkey, or belongs to an instance admin, passkeys are its second factor: a stolen first factor
 * (mailbox, password, provider) must not add another passkey or remove the real ones.
 * - With a passkey: only in a session started by a passkey sign-in in the last 12 hours (admin-second-factor.ts).
 * - An instance admin without one: the first needs the one-time enrolment code from the admin who
 *   granted the role, or from the CLI (passkey-enrolment.ts). It is checked where the passkey is
 *   stored (verify-registration); asking for options only needs a code to be pending.
 * - Everyone else: Better Auth's fresh age (a day), checked below for removing and by the plugin for
 *   adding. Someone who lost a passkey, or finds one they did not add, asks an instance admin to
 *   remove all of them (user.resetPasskeys), which needs no passkey of theirs.
 */
export function passkeyChangeRefusal(
  account: PasskeyAccount,
  session: PasskeySession,
  path: string,
  now = Date.now(),
): { code: string; message: string } | null {
  if (account.hasPasskey) {
    if (passkeyConfirmed(session.passkeyVerifiedAt, now)) return null
    return { code: PASSKEY_CONFIRMATION_REQUIRED, message: 'Sign in with one of your passkeys first, then try again.' }
  }
  if (!account.isAdmin) return null
  const ok = path === '/passkey/verify-registration' ? account.enrolmentCodeValid : account.enrolmentPending
  if (ok) return null
  return {
    code: PASSKEY_ENROLMENT_REQUIRED,
    message: 'Enter the passkey enrolment code a server admin gave you. Ask them for a new one if it has expired.',
  }
}

async function passkeyAccount(userId: string, code: string | null): Promise<PasskeyAccount> {
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  const [any] = await db
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .limit(1)
  return {
    isAdmin: Boolean(account && isInstanceAdmin(account)),
    hasPasskey: Boolean(any),
    enrolmentPending: Boolean(account && enrolmentPending(account)),
    enrolmentCodeValid: Boolean(account && enrolmentCodeValid(account, code)),
  }
}

/** Runs before Better Auth's passkey endpoints that add, rename or remove one (see passkeyChangeRefusal). */
export async function guardPasskeyChanges(ctx: AuthCtx) {
  if (!PASSKEY_CHANGE_PATHS.includes(ctx.path)) return
  const session = await getSessionFromCtx(ctx).catch(() => null)
  if (!session?.session) return // the endpoint answers 401 itself
  // An address nobody has proven yet: whoever signed up with it may not be its owner, and a passkey
  // they add would survive the owner's confirmation. Adding one waits until the address is confirmed.
  if (ADD_PATHS.includes(ctx.path) && !session.user.emailVerified)
    throw new APIError('FORBIDDEN', {
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Confirm your email address first, then add a passkey.',
    })
  const account = await passkeyAccount(session.user.id, ctx.headers?.get(ENROLMENT_HEADER) ?? null)
  const refusal = passkeyChangeRefusal(account, session.session as PasskeySession, ctx.path)
  if (refusal) throw new APIError('FORBIDDEN', refusal)
  // Removing a passkey takes away a way to sign in, so like adding one it needs a recent sign-in
  // (Better Auth's `freshAge`); the plugin itself only asks for a session there.
  if (ctx.path !== '/passkey/delete-passkey') return
  const freshAgeMs = ctx.context.sessionConfig.freshAge * 1000
  if (freshAgeMs > 0 && Date.now() - new Date(session.session.createdAt).getTime() >= freshAgeMs) {
    throw new APIError('FORBIDDEN', { code: 'SESSION_NOT_FRESH', message: 'Sign in again to remove a passkey.' })
  }
}

export { passkeyChangedEmail }

const CHANGE_BY_PATH: Record<string, 'added' | 'removed'> = {
  '/passkey/verify-registration': 'added',
  '/passkey/delete-passkey': 'removed',
}

/** After Better Auth's endpoints: tells the account when a passkey was added or removed (the audit log has it too, audit.ts). */
export async function notifyPasskeyChange(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const change = CHANGE_BY_PATH[ctx.path]
  if (!change || isAPIError(ctx.context.returned)) return
  const email = (ctx.context.session as { user?: { email?: string } } | null)?.user?.email
  if (!email) return
  // The first passkey is in: an enrolment code is used up.
  if (change === 'added') {
    const userId = (ctx.context.session as { user?: { id?: string } } | null)?.user?.id
    if (userId) await clearPasskeyEnrolment(userId)
  }
  // Not awaited: the change is made; a slow or broken mail server must not fail it. A fresh install has no email yet
  // (its first admin adds a passkey before connecting it): one log line, no error.
  const locale = await localeForEmail(db, email)
  sendNotice({ to: email, ...passkeyChangedEmail(change, undefined, locale) }, 'passkey email')
}
