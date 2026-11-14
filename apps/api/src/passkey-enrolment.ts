// An instance admin's first passkey is their second factor (admin-second-factor.ts), so it must not be
// addable by whoever holds their first factor (mailbox, password, provider account). It needs a
// one-time enrolment code instead, issued to the admin who granted the role (instanceAdmin.grant,
// user.invite with admin, user.resetPasskeys, user.issuePasskeyEnrolment) or printed by the CLI (user-passkeys.ts)
// for the first admin of an install. Only the code's SHA-256 is stored; it works once and for ENROLMENT_HOURS.
// Also here: removing every passkey of a user, the recovery path that does not need their passkeys.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { agent_setup_keys, passkey, type SetupKeyEndReason, session, type Tx, user } from '@linedesk/db'
import { and, eq, isNull, notExists, sql } from 'drizzle-orm'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
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

/**
 * A code for the first passkey of a user who has none, or null when they have one. One conditional write: the code is
 * stored only while no passkey row exists, so a passkey added at the same moment never ends up next to a fresh code
 * (user.issuePasskeyEnrolment, instanceAdmin.grant).
 */
export async function issueFirstPasskeyEnrolment(
  tx: Tx,
  userId: string,
  now = Date.now(),
): Promise<PasskeyEnrolment | null> {
  const code = randomBytes(18).toString('base64url')
  const expiresAt = new Date(now + ENROLMENT_HOURS * 3_600_000)
  const written = await tx
    .update(user)
    .set({ passkeyEnrolmentHash: sha256(code).toString('hex'), passkeyEnrolmentExpiresAt: expiresAt })
    .where(
      and(eq(user.id, userId), notExists(tx.select({ one: sql`1` }).from(passkey).where(eq(passkey.userId, userId)))),
    )
    .returning({ id: user.id })
  return written.length ? { enrolmentCode: code, enrolmentExpiresAt: expiresAt.toISOString() } : null
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
 * Ends every AI agent setup link of the user (agent-setup.ts) wherever all their sessions end: a link is a way in
 * that would outlast them, with email and sign-in too while its passkey confirmation lasts. `reason` is what an agent
 * still using one is told, coarsely (agent-setup.ts setupKeyAccess). Returns how many were working.
 */
export async function revokeSetupKeysOf(tx: Tx, userId: string, reason: SetupKeyEndReason): Promise<number> {
  const ended = await tx
    .update(agent_setup_keys)
    .set({ revoked_at: new Date().toISOString(), ended_reason: reason })
    .where(and(eq(agent_setup_keys.created_by, userId), isNull(agent_setup_keys.revoked_at)))
    .returning({ id: agent_setup_keys.id })
  return ended.length
}

export type PasskeysRemoved = { removed: number; sessionsEnded: number; setupLinksEnded: number }

/**
 * Removes every passkey of a user and signs them out everywhere, in the caller's transaction: a
 * session started by a passkey someone else added must not outlive it, nor must their AI agent setup links. Never on the caller's own
 * account (user.resetPasskeys refuses that). The user is emailed when there were passkeys,
 * and always when they are an instance admin. For an instance admin who only needs a code for their first passkey,
 * issuePasskeyEnrolment alone (user.issuePasskeyEnrolment) ends nothing.
 */
export async function removeAllPasskeys(
  tx: Tx,
  target: { id: string; email: string; isAdmin: boolean },
): Promise<PasskeysRemoved> {
  const removed = await tx.delete(passkey).where(eq(passkey.userId, target.id)).returning({ id: passkey.id })
  const sessions = await tx.delete(session).where(eq(session.userId, target.id)).returning({ id: session.id })
  // A setup link the admin confirmed with a passkey could still change email and sign-in: it ends with the rest.
  const setupLinksEnded = await revokeSetupKeysOf(tx, target.id, 'passkeys_reset')
  if (removed.length || target.isAdmin)
    sendNotice({ to: target.email, ...passkeysResetEmail(removed.length) }, 'passkeys reset email')
  return { removed: removed.length, sessionsEnded: sessions.length, setupLinksEnded }
}
