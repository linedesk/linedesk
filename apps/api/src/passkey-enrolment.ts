// An instance admin's first passkey is their second factor (admin-second-factor.ts), so it must not be
// addable by whoever holds their first factor (mailbox, password, provider account). It needs a
// one-time enrolment code instead, issued to the admin who granted the role (instanceAdmin.grant,
// user.invite with admin, user.resetPasskeys) or printed by the CLI (user-passkeys.ts) for the first
// admin of an install. Only the code's SHA-256 is stored; it works once and for ENROLMENT_HOURS.
// Also here: removing every passkey of a user, the recovery path that does not need their passkeys.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { passkey, session, type Tx, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { passkeysResetEmail } from './emails/templates.ts'

export const ENROLMENT_HOURS = 24

/** The browser sends the code with the request that stores the passkey (verify-registration). */
export const ENROLMENT_HEADER = 'x-passkey-enrolment'

const sha256 = (value: string) => createHash('sha256').update(value).digest()

export type PasskeyEnrolment = { enrolmentCode: string; enrolmentExpiresAt: string }

/** A new code for this user; an older one stops working. */
export async function issuePasskeyEnrolment(tx: Tx, userId: string, now = Date.now()): Promise<PasskeyEnrolment> {
  const code = randomBytes(18).toString('base64url')
  const expiresAt = new Date(now + ENROLMENT_HOURS * 3_600_000)
  await tx
    .update(user)
    .set({ passkeyEnrolmentHash: sha256(code).toString('hex'), passkeyEnrolmentExpiresAt: expiresAt })
    .where(eq(user.id, userId))
  return { enrolmentCode: code, enrolmentExpiresAt: expiresAt.toISOString() }
}

type EnrolmentRow = { passkeyEnrolmentHash: string | null; passkeyEnrolmentExpiresAt: Date | null }

/** Whether the account has a code that has not expired (whatever it is). */
export const enrolmentPending = (account: EnrolmentRow, now = Date.now()) =>
  Boolean(account.passkeyEnrolmentHash && account.passkeyEnrolmentExpiresAt && account.passkeyEnrolmentExpiresAt.getTime() > now)

/** Whether `code` is the account's current, unexpired code. Constant time. */
export function enrolmentCodeValid(account: EnrolmentRow, code: string | null | undefined, now = Date.now()): boolean {
  if (!code || !enrolmentPending(account, now)) return false
  const stored = Buffer.from(account.passkeyEnrolmentHash!, 'hex')
  const given = sha256(code.trim())
  return stored.length === given.length && timingSafeEqual(stored, given)
}

/** A passkey was added: the code is used up. */
export async function clearPasskeyEnrolment(userId: string) {
  await db.update(user).set({ passkeyEnrolmentHash: null, passkeyEnrolmentExpiresAt: null }).where(eq(user.id, userId))
}

export { passkeysResetEmail }

/**
 * Removes every passkey of a user and signs them out everywhere, in the caller's transaction: a
 * session started by a passkey someone else added must not outlive it. Never on the caller's own
 * account (user.resetPasskeys refuses that). The user is emailed when there were passkeys,
 * and always when they are an instance admin. Returns how many passkeys there were.
 */
export async function removeAllPasskeys(
  tx: Tx,
  target: { id: string; email: string; isAdmin: boolean },
): Promise<number> {
  const removed = await tx.delete(passkey).where(eq(passkey.userId, target.id)).returning({ id: passkey.id })
  await tx
    .delete(session)
    .where(eq(session.userId, target.id))
  if (removed.length || target.isAdmin) {
    void emailSender
      .send({ to: target.email, ...passkeysResetEmail(removed.length) })
      .catch(err => console.error('passkeys reset email failed', err))
  }
  return removed.length
}
