// An instance admin's first passkey is their second factor (admin-second-factor.ts), so it must not be
// addable by whoever holds their first factor (mailbox, password, provider account). It needs a
// one-time enrolment code instead, issued to the admin who granted the role (instanceAdmin.grant,
// user.invite with admin, user.resetPasskeys, user.issuePasskeyEnrolment) or printed by the CLI (user-passkeys.ts)
// for the first admin of an install. Only the code's SHA-256 is stored; it works once and for ENROLMENT_HOURS.
// Also here: removing every passkey of a user, the recovery path that does not need their passkeys.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  admin_authenticators,
  agent_setup_keys,
  member,
  passkey,
  personal_keys,
  type SetupKeyEndReason,
  session,
  type Tx,
  user,
} from '@linedesk/db'
import { and, eq, gt, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm'
import { forgetAdminDevices } from './admin-devices.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { passkeysResetEmail } from './emails/templates.ts'
import { localeForUserId } from './email-locale.ts'

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
  Boolean(
    account.passkeyEnrolmentHash &&
      account.passkeyEnrolmentExpiresAt &&
      account.passkeyEnrolmentExpiresAt.getTime() > now,
  )

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
 * The per-person lock of setup links (security review #822 F3, N1): making a link (agent-setup.ts insertKey) and every
 * revoke below take it first, inside their transaction, until it ends. So a revoke never misses a link made at the same
 * moment: it waits for that mint to commit and then ends it too, or the mint waits and re-checks what the revoke
 * changed (the session, the role) after it. Callers always lock one person, or several in id order (lockSetupKeysOfAll).
 */
export async function lockSetupKeysOf(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-setup-key:${userId}`}))`)
}

/** lockSetupKeysOf for several people, always in the same (id) order, so two of these never wait on each other. */
async function lockSetupKeysOfAll(tx: Tx, userIds: readonly string[]) {
  for (const id of [...new Set(userIds)].sort()) await lockSetupKeysOf(tx, id)
}

/**
 * Runs `revoke` holding the people's setup-link locks: in the caller's transaction (a savepoint there, the locks held
 * until it ends) or in a transaction of its own when called with the database (a password change's after-hook).
 */
const withSetupKeyLocks = <T>(tx: Tx, userIds: readonly string[], revoke: (t: Tx) => Promise<T>): Promise<T> =>
  tx.transaction(async t => {
    await lockSetupKeysOfAll(t, userIds)
    return revoke(t)
  })

/**
 * Ends every AI agent setup link of the user (agent-setup.ts) wherever all their sessions end: a link is a way in
 * that would outlast them, with email and sign-in too while its passkey confirmation lasts. `reason` is what an agent
 * still using one is told, coarsely (agent-setup.ts setupKeyAccess). Returns how many were working.
 */
export async function revokeSetupKeysOf(tx: Tx, userId: string, reason: SetupKeyEndReason): Promise<number> {
  return withSetupKeyLocks(tx, [userId], async t => {
    await endPersonalKeysOf(t, userId, reason)
    const ended = await t
      .update(agent_setup_keys)
      .set({ revoked_at: new Date().toISOString(), ended_reason: reason })
      .where(and(eq(agent_setup_keys.created_by, userId), isNull(agent_setup_keys.revoked_at)))
      .returning({ id: agent_setup_keys.id })
    return ended.length
  })
}

/**
 * Personal API keys (personal-keys.ts) on the same occasions: a lost admin role takes their server-admin rights for
 * good (a later grant does not bring them back); a password changed or reset, passkeys reset, "sign out everywhere
 * else", or the account disabled or recovered revokes them, so a key made from a stolen session does not outlast the
 * recovery (LIN-339 security review M1).
 */
export async function endPersonalKeysOf(tx: Tx, userId: string, reason: SetupKeyEndReason): Promise<void> {
  const open = and(eq(personal_keys.user_id, userId), isNull(personal_keys.revoked_at))
  if (reason === 'admin_role_removed')
    await tx
      .update(personal_keys)
      .set({ passkey_confirmed: false })
      .where(and(open, eq(personal_keys.passkey_confirmed, true)))
  else if (REVOKES_PERSONAL_KEYS.has(reason)) await revokePersonalKeysOf(tx, userId)
}

/** Revokes every personal key of the person (also after an email change, email-change.ts). */
export async function revokePersonalKeysOf(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(personal_keys)
    .set({ revoked_at: new Date().toISOString() })
    .where(and(eq(personal_keys.user_id, userId), isNull(personal_keys.revoked_at)))
}

/** The cleanups after which none of the person's ways in may last: their personal keys are revoked too. */
const REVOKES_PERSONAL_KEYS: ReadonlySet<SetupKeyEndReason> = new Set([
  'password_changed',
  'password_reset',
  'passkeys_reset',
  'sessions_ended',
  'account_disabled',
  'account_recovery',
])

/**
 * Ends every working workspace setup link for one workspace (agent_setup_keys.workspace_id): when it is handed to
 * another owner or disabled. Ended for good, so a link never works again when the owner or the workspace comes back
 * within its hours. Install links are not touched. Holds the lock of each owner and admin there (the only ones who make
 * these links), so a link one of them is making right now ends too. Returns how many were working.
 */
export async function revokeWorkspaceSetupKeys(
  tx: Tx,
  workspaceId: string,
  reason: SetupKeyEndReason,
): Promise<number> {
  const makers = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, workspaceId), inArray(member.role, ['owner', 'admin'])))
  return withSetupKeyLocks(
    tx,
    makers.map(m => m.userId),
    async t => {
      const ended = await t
        .update(agent_setup_keys)
        .set({ revoked_at: new Date().toISOString(), ended_reason: reason })
        .where(and(eq(agent_setup_keys.workspace_id, workspaceId), isNull(agent_setup_keys.revoked_at)))
        .returning({ id: agent_setup_keys.id })
      return ended.length
    },
  )
}

/**
 * Ends one person's workspace setup links for one workspace, for good: their role there changed (an admin made a member,
 * or anyone made the owner) or they left or were removed. A link acts with its maker's role when it was made
 * (agent_setup_keys.role), so it never outlives that role. Their links elsewhere and install links are not touched.
 */
export async function revokeMemberSetupKeys(
  tx: Tx,
  workspaceId: string,
  userId: string,
  reason: SetupKeyEndReason,
): Promise<number> {
  return withSetupKeyLocks(tx, [userId], async t => {
    const ended = await t
      .update(agent_setup_keys)
      .set({ revoked_at: new Date().toISOString(), ended_reason: reason })
      .where(
        and(
          eq(agent_setup_keys.created_by, userId),
          eq(agent_setup_keys.workspace_id, workspaceId),
          isNull(agent_setup_keys.revoked_at),
        ),
      )
      .returning({ id: agent_setup_keys.id })
    return ended.length
  })
}

/**
 * Ends the person's setup links whose session is gone (security review #822 N2): after one device is signed out in
 * Settings › Account › Sessions (Better Auth `/revoke-session`), or a plain sign-out. A link is tied to the session that
 * made it (agent_setup_keys.session_id); setupKeyAccess ends it on use too, this ends it at once. Returns how many.
 */
export async function revokeSetupKeysOfEndedSessions(tx: Tx, userId: string): Promise<number> {
  return withSetupKeyLocks(tx, [userId], async t => {
    const ended = await t
      .update(agent_setup_keys)
      .set({ revoked_at: new Date().toISOString(), ended_reason: 'session_ended' })
      .where(
        and(
          eq(agent_setup_keys.created_by, userId),
          isNull(agent_setup_keys.revoked_at),
          isNotNull(agent_setup_keys.session_id),
          notExists(
            t
              .select({ one: sql`1` })
              .from(session)
              .where(and(eq(session.id, agent_setup_keys.session_id), gt(session.expiresAt, new Date()))),
          ),
        ),
      )
      .returning({ id: agent_setup_keys.id })
    return ended.length
  })
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
  // The browsers that passed their passkey check before are new again (admin-devices.ts).
  await forgetAdminDevices(tx, target.id)
  // The authenticator app is the other second factor (authenticator.ts): the recovery reset removes both, so whoever
  // added one with a stolen session loses it too.
  await tx.delete(admin_authenticators).where(eq(admin_authenticators.user_id, target.id))
  if (removed.length || target.isAdmin)
    sendNotice(
      { to: target.email, ...passkeysResetEmail(removed.length, undefined, await localeForUserId(tx, target.id)) },
      'passkeys reset email',
    )
  return { removed: removed.length, sessionsEnded: sessions.length, setupLinksEnded }
}
