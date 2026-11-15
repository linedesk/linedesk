// Changing the address an account signs in with (Account settings › Profile › Change): the new address
// gets a 6-digit code, and typing it in moves the account there. Better Auth's email OTP plugin does the
// change (`/email-otp/request-email-change`, `/email-otp/change-email`); this adds Linedesk's rules:
// - only in a recent sign-in (RECENT_SIGN_IN_MS, as setting a first password or deleting a workspace),
//   and, once the account has a passkey, only after a passkey sign-in (passkeys are its second factor,
//   as for changing passkeys); never while an admin is signed in as the user (impersonation-guard.ts);
// - a confirmed current address must be proven too, with a code sent to it, unless the session is a
//   passkey sign-in of the last 12 hours: a stolen password alone must not move the account to the
//   thief's mailbox for good (security review of #662, finding 2);
// - the code limits of sign-in-limits.ts, counted for the new address (requests and wrong codes per
//   address and IP and per address), plus limits per account, so one account cannot spray codes to
//   many addresses;
// - an address that already has an account, or is reserved for an administrator (INSTANCE_ADMIN_EMAILS),
//   gets no code, while the request runs and answers exactly as for any other address; that mailbox is
//   told instead that it can't be used. At the change step every refused code gets one answer
//   (INVALID_OTP), so neither the status nor the time tells anyone whether an address is taken;
// - after the change: the account's other sessions end (this one stays, Better Auth re-issues its
//   cookie with the new address), the old address is told, and the audit log has both addresses.
// Sign-in providers stay linked: a provider sign-in finds the account by the provider's account id
// first, so it still signs in after the change. Passkeys and the password stay as they are.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { passkey as passkeyTable, session, user } from '@linedesk/db'
import { APIError, type createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { and, eq, ne, sql } from 'drizzle-orm'
import { RECENT_SIGN_IN_MS } from './account.ts'
import { passkeyConfirmed } from './admin-second-factor.ts'
import { recordAuthEvent } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import {
  emailChangeCodeEmail,
  emailChangeConfirmCurrentEmail,
  emailChangedEmail,
  emailChangeRefusedEmail,
} from './emails/templates.ts'
import { envAdminEmails } from './instance-admin.ts'
import { PASSKEY_CONFIRMATION_REQUIRED } from './passkeys.ts'
import { createRateLimiter } from './rate-limit.ts'
import { countWrongCode } from './sign-in-limits.ts'
import { localeForEmail, localeForUserId } from './email-locale.ts'

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]
type InternalAdapter = Ctx['context']['internalAdapter']

export const REQUEST_PATH = '/email-otp/request-email-change'
export const CHANGE_PATH = '/email-otp/change-email'

/**
 * The code is typed up to its 10 minutes after it was asked for, which needed a recent sign-in: the
 * change itself accepts a session up to that much older. A function, not a constant: account.ts
 * reaches this module through auth.ts, so its constant is not there yet while this one loads.
 */
const freshFor = (path: string) => (path === REQUEST_PATH ? RECENT_SIGN_IN_MS : RECENT_SIGN_IN_MS + CODE_MS)
const CODE_MS = 10 * 60_000
const CODE_TRIES = 3

/** 5 new addresses an hour per account, on top of the limits per address (sign-in-limits.ts). */
const allowNewAddressCode = createRateLimiter({ max: 5, windowMs: 60 * 60_000 })
/** 5 codes to the current address an hour per account. */
const allowCurrentAddressCode = createRateLimiter({ max: 5, windowMs: 60 * 60_000 })

/** The answer the web app turns into "Sign in again". */
export const SESSION_NOT_FRESH = 'SESSION_NOT_FRESH'
/** A right code for an address that got an account in the very moment of the change. */
export const EMAIL_UNUSABLE = 'EMAIL_UNUSABLE'

/** The one answer for every refused code at the change step, the same body Better Auth sends for a wrong one. */
const refusedCode = () => new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'Invalid OTP' })

const bodyString = (ctx: Ctx, key: 'newEmail' | 'otp') => {
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value.trim() : null
}
const newEmailOf = (ctx: Ctx) => bodyString(ctx, 'newEmail')?.toLowerCase() || null

/** Better Auth's stored code for this change (email-otp plugin, `change-email` type). */
const changeCodeIdentifier = (userId: string, newEmail: string) => `change-email-otp-${userId}:${newEmail}`
/** The code sent to the current address, and the proof that this session typed it. */
const currentCodeIdentifier = (userId: string) => `email-change-current-otp-${userId}`
const provenIdentifier = (sessionId: string) => `email-change-proven-${sessionId}`

/** Whether `email` belongs to an account other than `userId`. */
async function takenByAnother(email: string, userId: string) {
  const [other] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(sql`lower(${user.email}) = ${email.toLowerCase()}`, ne(user.id, userId)))
    .limit(1)
  return Boolean(other)
}

/** Whether `email` can't be used: another account has it, or it is kept for an administrator. */
const unusable = async (email: string, userId: string) =>
  envAdminEmails().includes(email.toLowerCase()) || (await takenByAnother(email, userId))

async function hasPasskey(userId: string) {
  const [any] = await db
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .limit(1)
  return Boolean(any)
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

/** A new 6-digit code for the current address (replacing an earlier one), stored hashed with its tries. */
async function newCurrentCode(adapter: InternalAdapter, userId: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await adapter.deleteVerificationByIdentifier(currentCodeIdentifier(userId))
  await adapter.createVerificationValue({
    identifier: currentCodeIdentifier(userId),
    value: `${hashCode(code)}:0`,
    expiresAt: new Date(Date.now() + CODE_MS),
  })
  return code
}

/**
 * Checks the current address's code: taken out of the store first, so two guesses never race; a wrong
 * one goes back with one more try, a right one is used up. Expired or out of tries: refused.
 */
async function currentCodeIsRight(adapter: InternalAdapter, userId: string, code: string) {
  const stored = await adapter.consumeVerificationValue(currentCodeIdentifier(userId))
  if (!stored || new Date(stored.expiresAt) < new Date()) return false
  const at = stored.value.lastIndexOf(':')
  const hash = stored.value.slice(0, at)
  const tries = Number.parseInt(stored.value.slice(at + 1) || '0', 10)
  if (tries >= CODE_TRIES) return false
  const given = Buffer.from(hashCode(code))
  const right = given.length === hash.length && timingSafeEqual(given, Buffer.from(hash))
  if (!right)
    await adapter.createVerificationValue({
      identifier: currentCodeIdentifier(userId),
      value: `${hash}:${tries + 1}`,
      expiresAt: new Date(stored.expiresAt),
    })
  return right
}

/** Whether the new address's code has expired or used its tries (`<hash>:<tries>`); such a code is removed. */
async function spentChangeCode(adapter: InternalAdapter, userId: string, newEmail: string) {
  const identifier = changeCodeIdentifier(userId, newEmail)
  const stored = await adapter.findVerificationValue(identifier)
  if (!stored) return false
  const tries = Number.parseInt(stored.value.slice(stored.value.lastIndexOf(':') + 1) || '0', 10)
  if (new Date(stored.expiresAt) >= new Date() && tries < CODE_TRIES) return false
  await adapter.deleteVerificationByIdentifier(identifier)
  return true
}

async function proven(adapter: InternalAdapter, sessionId: string) {
  const row = await adapter.findVerificationValue(provenIdentifier(sessionId))
  return Boolean(row && new Date(row.expiresAt) >= new Date())
}

/**
 * Whether this session must prove the current address: it is confirmed, and the session is not a
 * passkey sign-in of the last 12 hours (a passkey is the stronger proof; passkey-first, finding 2).
 * An unconfirmed address can't be proven, so it is not asked for: the new address is then the first
 * one the account proves.
 */
const needsCurrentAddress = (me: { emailVerified: boolean }, mine: { passkeyVerifiedAt?: Date | null }) =>
  me.emailVerified && !passkeyConfirmed(mine.passkeyVerifiedAt)

/** The old address of a change under way, by session id: read after the change, when the account has the new one. */
const changing = new Map<string, string>()

/**
 * Before both endpoints (after refuseWhileImpersonating and the code limits). Returns a response only
 * where it answers for Better Auth: the first step of proving the current address. Every other request
 * either is refused here or runs Better Auth's endpoint, also for an address that can't be used.
 */
export async function guardEmailChange(ctx: Ctx) {
  if (ctx.path !== REQUEST_PATH && ctx.path !== CHANGE_PATH) return
  const current = await getSessionFromCtx(ctx).catch(() => null)
  if (!current?.session) return // the endpoint answers 401 itself
  const { user: me } = current
  const mine = current.session as typeof current.session & { passkeyVerifiedAt?: Date | null }
  const age = Date.now() - new Date(mine.createdAt).getTime()
  if (age >= freshFor(ctx.path))
    throw new APIError('FORBIDDEN', { code: SESSION_NOT_FRESH, message: 'Sign in again to change your email address.' })
  if ((await hasPasskey(me.id)) && !passkeyConfirmed(mine.passkeyVerifiedAt))
    throw new APIError('FORBIDDEN', {
      code: PASSKEY_CONFIRMATION_REQUIRED,
      message: 'Sign in with one of your passkeys first, then try again.',
    })
  const newEmail = newEmailOf(ctx)
  if (!newEmail) return // the endpoint's own validation answers
  const adapter = ctx.context.internalAdapter
  const mustProve = needsCurrentAddress(me, mine) && !(await proven(adapter, mine.id))

  if (ctx.path === REQUEST_PATH) {
    if (mustProve) {
      const otp = bodyString(ctx, 'otp')
      if (!otp) {
        if (!allowCurrentAddressCode(me.id))
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes asked for. Try again later.' })
        const code = await newCurrentCode(adapter, me.id)
        // Not awaited, as every code email.
        void emailSender
          .send({ to: me.email, ...emailChangeConfirmCurrentEmail(code, undefined, await localeForUserId(db, me.id)) })
          .catch(err => console.error('email change confirmation email failed', err))
        return ctx.json({ success: true, confirmCurrentEmail: true })
      }
      if (!(await currentCodeIsRight(adapter, me.id, otp))) throw refusedCode()
      await adapter.createVerificationValue({
        identifier: provenIdentifier(mine.id),
        value: 'proven',
        expiresAt: new Date(Date.now() + 2 * CODE_MS),
      })
    }
    if (!allowNewAddressCode(me.id))
      throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes asked for. Try again later.' })
    return
  }

  // The change: one answer, and one more wrong code counted, for a session that did not prove the
  // current address, for an address that can't be used (no code exists for it), and for a code that
  // expired or ran out of tries. Better Auth would answer those last two with "expired" (400) or "too
  // many attempts" (403), and an after-hook can change the body but not the status (finding 1).
  if (mustProve || (await unusable(newEmail, me.id)) || (await spentChangeCode(adapter, me.id, newEmail))) {
    countWrongCode(ctx)
    throw refusedCode()
  }
  changing.set(mine.id, me.email)
}

/**
 * The plugin's `sendVerificationOTP` for `change-email` codes, to the new address. Better Auth sends
 * none for an address that has an account; an address kept for an administrator (or taken in between)
 * gets its code removed here and the "can't be used" notice instead, so the request did the same work
 * for every address. Not awaited, as sign-in codes.
 */
export async function sendEmailChangeCode(email: string, otp: string, ctx: unknown) {
  const userId = (ctx as { context?: { session?: { user?: { id?: string } } } } | null)?.context?.session?.user?.id
  if (!userId) return
  if (await unusable(email, userId)) {
    await (ctx as Ctx).context.internalAdapter.deleteVerificationByIdentifier(
      changeCodeIdentifier(userId, email.toLowerCase()),
    )
    sendRefusedNotice(email)
    return
  }
  const locale = userId ? await localeForUserId(db, userId) : null
  void emailSender
    .send({ to: email, ...emailChangeCodeEmail(otp, undefined, locale) })
    .catch(err => console.error('email change code email failed', err))
}

/** In the language of the account that has the address (its owner reads it). */
function sendRefusedNotice(email: string) {
  void localeForEmail(db, email)
    .then(locale => emailSender.send({ to: email, ...emailChangeRefusedEmail(undefined, locale) }))
    .catch(err => console.error('email change refused email failed', err))
}

/**
 * First after Better Auth's endpoints, so it always runs when the address changed (finding 4); never
 * throws. A request for an address with an account: that mailbox gets the "can't be used" notice
 * (Better Auth sent nothing). A change: the other sessions end, the change goes into the audit log
 * with both addresses, and the old address is told.
 */
export async function finishEmailChange(ctx: Ctx) {
  if (ctx.path !== REQUEST_PATH && ctx.path !== CHANGE_PATH) return
  const current = ctx.context.session as {
    user?: { id: string }
    session?: { id: string; ipAddress?: string | null; userAgent?: string | null }
  } | null
  const sessionId = current?.session?.id
  const userId = current?.user?.id
  const newEmail = newEmailOf(ctx)
  try {
    if (ctx.path === REQUEST_PATH) {
      const returned = ctx.context.returned as { confirmCurrentEmail?: boolean } | undefined
      if (isAPIError(returned) || returned?.confirmCurrentEmail || !userId || !newEmail) return
      if (await takenByAnother(newEmail, userId)) sendRefusedNotice(newEmail)
      return
    }
    const oldEmail = sessionId ? changing.get(sessionId) : undefined
    if (sessionId) changing.delete(sessionId)
    if (isAPIError(ctx.context.returned) || !userId || !sessionId) return
    await db.delete(session).where(and(eq(session.userId, userId), ne(session.id, sessionId)))
    await ctx.context.internalAdapter.deleteVerificationByIdentifier(provenIdentifier(sessionId))
    const headers = ctx.request?.headers ?? ctx.headers
    await recordAuthEvent({
      event: 'email_changed',
      userId,
      email: oldEmail ?? null,
      // The new address, kept where other events keep their method (schema.ts, auth_events.method).
      method: newEmail,
      ipAddress: headers?.get(CLIENT_IP_HEADER) ?? current?.session?.ipAddress ?? null,
      userAgent: headers?.get('user-agent') ?? current?.session?.userAgent ?? null,
    })
    if (!oldEmail || !newEmail) return
    // Not awaited: the address is changed; a slow or broken mail server must not fail it.
    void emailSender
      .send({ to: oldEmail, ...emailChangedEmail(newEmail, undefined, await localeForUserId(db, userId)) })
      .catch(err => console.error('email changed email failed', err))
  } catch (err) {
    console.error('email change: follow-up after the endpoint failed', err)
  }
}

/**
 * Last after `/email-otp/change-email`, since it replaces the response: a code that expired or ran out
 * of tries gets the answer of a wrong one (finding 1), as for the password reset. Otherwise a free
 * address would answer "expired" (400) or "too many attempts" (403) where a taken one, which never has
 * a code, answers "invalid". A right code for an address taken in the very moment of the change gets
 * one plain answer (that code proved the asker owns the mailbox).
 */
export function sameAnswerForEmailChange(ctx: Ctx) {
  if (ctx.path !== CHANGE_PATH) return
  const returned = ctx.context.returned
  if (!isAPIError(returned)) return
  const body = returned.body as { code?: unknown; message?: unknown } | undefined
  if (body?.code === 'OTP_EXPIRED' || body?.code === 'TOO_MANY_ATTEMPTS') throw refusedCode()
  if (body?.message === 'Email already in use')
    throw new APIError('BAD_REQUEST', { code: EMAIL_UNUSABLE, message: "That address can't be used." })
}
