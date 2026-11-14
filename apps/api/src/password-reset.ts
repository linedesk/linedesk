// "Forgot password?" on the sign-in page: a code by email, then the code with a new password, through
// Better Auth's email OTP plugin (`/email-otp/request-password-reset`, `/email-otp/reset-password`).
// Only where password sign-in is on and email is delivered (auth.ts keeps both paths off otherwise).
// The reset proves the mailbox, exactly what a code sign-in proves, so it gets the same rules:
// - the same answer for every address, a code only to an existing account that is not disabled, and at
//   the reset step one answer for every refused code (wrong, expired, out of tries, no account);
// - the code limits of sign-in-limits.ts (requests and wrong codes per address and IP and per address,
//   3 tries per code); the new password is checked before the code, so a typo in it costs no try;
// - an address nobody had proven loses whatever got in before (account-linking.ts), as with a code
//   sign-in; only the new password stays;
// - every session of the account ends, and its agent setup keys (agent-setup.ts); the browser then
//   signs in with the new password, a plain password sign-in. Passkeys stay as they are, and that
//   session is no passkey sign-in, so changing passkeys and the admin step-ups still need one
//   (passkeys.ts, admin-step-up.ts);
// - the account is told by email, and the audit log has it.
import { account, agent_setup_keys, session, user } from '@linedesk/db'
import { APIError, type createAuthMiddleware, isAPIError } from 'better-auth/api'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { dropUnprovenAccessOf } from './account-linking.ts'
import { recordAuthEvent } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { passwordChangedEmail, passwordResetCodeEmail } from './emails/templates.ts'
import { countWrongCode } from './sign-in-limits.ts'

/** Better Auth's two endpoints of the reset; off over HTTP unless password sign-in is on. */
export const PASSWORD_RESET_PATHS = ['/email-otp/request-password-reset', '/email-otp/reset-password']

const RESET_PATH = '/email-otp/reset-password'

async function accountByEmail(email: string) {
  const [row] = await db
    .select({ id: user.id, disabledAt: user.disabledAt })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1)
  return row ?? null
}

/**
 * The plugin's `sendVerificationOTP` for `forget-password` codes. Better Auth only calls it for an
 * existing account; a disabled one gets nothing. Not awaited, as sign-in codes: waiting for SMTP only
 * for real accounts would tell anyone which addresses have one.
 */
export async function sendPasswordResetCode(email: string, otp: string) {
  const target = await accountByEmail(email)
  if (!target || target.disabledAt) return
  void emailSender
    .send({ to: email, ...passwordResetCodeEmail(otp) })
    .catch(err => console.error('password reset email failed', err))
}

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

const bodyField = (ctx: Ctx, key: 'email' | 'password') => {
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value : null
}

/** The one answer for every refused code at the reset step. */
const refusedCode = () => new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'Invalid OTP' })

/**
 * Before `/email-otp/reset-password`:
 * - the new password is checked first (the sign-up rules), so a typo in it never spends the code or
 *   counts as a wrong one;
 * - a disabled account cannot sign in, so it cannot set a password either: refused with the answer a
 *   wrong code gets, and counted like one, so it tells nothing about the address;
 * - a code that has expired or has no tries left is refused the same way (and removed), before Better
 *   Auth answers "expired" (400) or "too many attempts" (403). Better Auth keeps a reset code only for
 *   an existing account, so those answers would tell anyone who asked for a code, waited and tried
 *   again that the address has one (review M1).
 */
export async function guardPasswordReset(ctx: Ctx) {
  if (ctx.path !== RESET_PATH) return
  const password = bodyField(ctx, 'password')
  if (password !== null) {
    const { minPasswordLength, maxPasswordLength } = ctx.context.password.config
    if (password.length < minPasswordLength)
      throw new APIError('BAD_REQUEST', { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' })
    if (password.length > maxPasswordLength)
      throw new APIError('BAD_REQUEST', { code: 'PASSWORD_TOO_LONG', message: 'Password too long' })
  }
  const email = bodyField(ctx, 'email')
  if (!email) return // the endpoint's own validation answers
  if ((await accountByEmail(email))?.disabledAt || (await spentCode(ctx, email))) {
    countWrongCode(ctx)
    throw refusedCode()
  }
}

/** Better Auth's stored reset code for this address: `<hash>:<tries>` (email-otp plugin). */
const resetCodeIdentifier = (email: string) => `forget-password-otp-${email.toLowerCase()}`

/** Whether the address's reset code has expired or used its 3 tries; such a code is removed. */
async function spentCode(ctx: Ctx, email: string): Promise<boolean> {
  const identifier = resetCodeIdentifier(email)
  const stored = await ctx.context.internalAdapter.findVerificationValue(identifier)
  if (!stored) return false
  const tries = Number.parseInt(stored.value.slice(stored.value.lastIndexOf(':') + 1) || '0', 10)
  if (new Date(stored.expiresAt) >= new Date() && !(tries >= ALLOWED_TRIES)) return false
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier)
  return true
}

/** The tries a code allows (auth.ts, emailOTP `allowedAttempts`). */
export const ALLOWED_TRIES = 3

/**
 * The same, after Better Auth's answer: a code that expired or ran out of tries between the check
 * above and Better Auth's own gets the body of a wrong code (it was counted as one before this, in
 * countSignInFailures). Better Auth keeps the status it chose, so this covers only that narrow race.
 */
export function sameAnswerForRefusedCodes(ctx: Ctx) {
  if (ctx.path !== RESET_PATH) return
  const returned = ctx.context.returned
  if (!isAPIError(returned)) return
  const code = (returned.body as { code?: unknown } | undefined)?.code
  if (code === 'OTP_EXPIRED' || code === 'TOO_MANY_ATTEMPTS') throw refusedCode()
}

/**
 * After a successful `/email-otp/reset-password`: every session of the account goes once more. A
 * provider sign-in that was under way while the reset cleaned up could still have made one (as
 * endSessionsAfterEmailLink does for the email link); the reset itself makes none.
 */
export async function endSessionsAfterReset(ctx: Ctx) {
  if (ctx.path !== RESET_PATH || isAPIError(ctx.context.returned)) return
  const email = bodyField(ctx, 'email')
  const target = email ? await accountByEmail(email) : null
  if (target) await db.delete(session).where(eq(session.userId, target.id))
}

/**
 * Better Auth `emailAndPassword.onPasswordReset`: the code was right and the new password is stored,
 * every session already ended (`revokeSessionsOnPasswordReset`). `resetUser` is the account as it was
 * before. The account's agent setup keys end too: they act as the admin, and the notice says "signed
 * out everywhere" (workspace API keys are integrations and stay). An address nobody had proven: the
 * code proves it now, so whatever got in before goes, except the password just set
 * (dropUnprovenAccessOf), before Better Auth marks the address verified. If that fails, the new
 * password is already set (Better Auth stored it first) but the address stays unverified with its
 * limits; the change still goes into the audit log, then the error goes on (a 500).
 */
export async function afterPasswordReset(
  { user: resetUser }: { user: { id: string; email: string; emailVerified: boolean } },
  request?: Request,
) {
  const record = () =>
    recordAuthEvent({
      event: 'password_changed',
      userId: resetUser.id,
      method: 'email_code',
      ipAddress: request?.headers.get(CLIENT_IP_HEADER) ?? null,
      userAgent: request?.headers.get('user-agent') ?? null,
    })
  try {
    await db
      .update(agent_setup_keys)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(eq(agent_setup_keys.created_by, resetUser.id), isNull(agent_setup_keys.revoked_at)))
    if (!resetUser.emailVerified) {
      const [credential] = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, resetUser.id), eq(account.providerId, 'credential')))
        .limit(1)
      await dropUnprovenAccessOf(resetUser.id, credential?.id)
    }
  } catch (err) {
    console.error('password reset: cleanup failed after the new password was set', err)
    await record()
    throw err
  }
  await record()
  // Not awaited: the password is changed; a slow or broken mail server must not fail it.
  void emailSender
    .send({ to: resetUser.email, ...passwordChangedEmail() })
    .catch(err => console.error('password changed email failed', err))
}
