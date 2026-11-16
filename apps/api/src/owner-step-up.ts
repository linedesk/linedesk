// An owner deleting their own workspace (workspace.deleteOwn) proves first that it is them at the keyboard, not
// someone with a session left open or a stolen cookie: a sign-in within the last 10 minutes, and when they have a
// passkey, that sign-in must be the passkey. Checked before the action runs (run-action.ts, so the web app gets a
// code it can act on) and again inside its handler. Impersonation sessions never pass. ADMIN_SECOND_FACTOR=off
// (an install without https, where passkeys cannot work) leaves only the 10 minutes.
import type { OwnerStepUp } from '@linedesk/actions'
import { member, passkey, session, type Tx, user } from '@linedesk/db'
import { and, eq, ne } from 'drizzle-orm'
import { RECENT_SIGN_IN_MS, SIGN_IN_AGAIN, signedInRecently } from './account.ts'
import { adminSecondFactorRequired, signedInWithin } from './admin-second-factor.ts'
import { PASSKEY_STEP_UP_REQUIRED } from './admin-step-up.ts'
import { hasAuthenticator } from './authenticator.ts'
import type { Actor } from './context.ts'
import type { db } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'

/** The actions that need it. */
export const OWNER_STEP_UP_ACTIONS: ReadonlySet<string> = new Set(['workspace.deleteOwn'])

const RECENT_HOURS = RECENT_SIGN_IN_MS / 3_600_000

/**
 * What this owner still has to do before deleting, or null. No session (an API key, the agent) or an impersonation:
 * `signIn`, which they can never satisfy that way.
 */
export async function ownerStepUpNeeded(
  tx: Tx | typeof db,
  actor: Actor,
  now = Date.now(),
): Promise<OwnerStepUp | null> {
  if (!actor.sessionId || actor.impersonation) return 'signIn'
  const [own] = await tx
    .select({
      createdAt: session.createdAt,
      passkeyVerifiedAt: session.passkeyVerifiedAt,
      secondFactorMethod: session.secondFactorMethod,
      impersonatedBy: session.impersonatedBy,
    })
    .from(session)
    .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId)))
  if (!own || own.impersonatedBy) return 'signIn'
  const [key] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actor.actorId)).limit(1)
  if (key && adminSecondFactorRequired())
    // A passkey sign-in, not a code from the authenticator app (phishable; LIN-275 security review).
    return signedInWithin(own.passkeyVerifiedAt, RECENT_HOURS, now) && own.secondFactorMethod !== 'authenticator'
      ? null
      : 'passkey'
  return signedInWithin(own.createdAt, RECENT_HOURS, now) ? null : 'signIn'
}

/** The words and code of the refusal for each step-up; the web app reacts to the code. */
export function ownerStepUpRefusal(stepUp: OwnerStepUp) {
  return stepUp === 'passkey'
    ? {
        ok: false as const,
        error: 'Confirm with your passkey to delete this workspace.',
        code: PASSKEY_STEP_UP_REQUIRED,
        stepUp: 'confirm' as const,
      }
    : { ok: false as const, error: 'Sign in again to delete this workspace.', code: SIGN_IN_AGAIN }
}

/** team.leave deleting the account without a sign-in in the last 10 minutes (Janik, 2026-11-15; LIN-264). */
export const LEAVE_SIGN_IN_AGAIN =
  'Sign in again to delete your account. Deleting it needs a sign-in from the last 10 minutes.'

/** The refusal run-action answers before the leave runs: the web app offers "Sign in again" on the code. */
export const leaveSignInRefusal = { ok: false as const, error: LEAVE_SIGN_IN_AGAIN, code: SIGN_IN_AGAIN }

/**
 * Whether this actor's own session started with a sign-in within the last 10 minutes: the session's own creation time,
 * as for setting a password (account.ts). No session (an API key, the agent) or an impersonation never passes.
 */
async function signedInJustNow(tx: Tx | typeof db, actor: Actor, now: number): Promise<boolean> {
  if (!actor.sessionId || actor.impersonation) return false
  const [own] = await tx
    .select({ createdAt: session.createdAt, impersonatedBy: session.impersonatedBy })
    .from(session)
    .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId)))
  return !!own && !own.impersonatedBy && signedInRecently(own.createdAt, now)
}

/**
 * Leaving one's last workspace with deleteAccount: true (team.leave) needs a sign-in within the last 10 minutes
 * (signedInJustNow): whoever finds a session left open must not delete the account with it. No passkey step on top.
 * Leaving with another workspace left deletes nothing and needs none. Checked by run-action before the transaction
 * (so the web app gets SIGN_IN_AGAIN) and again in the handler.
 */
export async function leaveNeedsFreshSignIn(
  tx: Tx | typeof db,
  actor: Actor,
  input: { deleteAccount?: unknown },
  now = Date.now(),
): Promise<boolean> {
  if (input.deleteAccount !== true || !actor.workspaceId) return false
  const [other] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, actor.actorId), ne(member.organizationId, actor.workspaceId)))
    .limit(1)
  if (other) return false
  return !(await signedInJustNow(tx, actor, now))
}

/** team.removeMember deleting the removed person's account without a sign-in in the last 10 minutes (LIN-264 review F3). */
export const REMOVE_SIGN_IN_AGAIN =
  "Sign in again to delete their account. Deleting someone's account needs a sign-in from the last 10 minutes."

/** The refusal run-action answers before the removal runs: the web app offers "Sign in again" on the code. */
export const removeSignInRefusal = { ok: false as const, error: REMOVE_SIGN_IN_AGAIN, code: SIGN_IN_AGAIN }

/**
 * The owner removing someone and deleting their account (team.removeMember with deleteAccount) needs the same recent
 * sign-in as deleting their own (Janik, 2026-11-15, LIN-264 review F3): a session left open must not delete other people's accounts either. Only the owner is held to it here:
 * anyone else is refused by the handler (ONLY_OWNER_DELETES_ACCOUNTS), which checks both again under its lock.
 */
export async function removeNeedsFreshSignIn(
  tx: Tx | typeof db,
  actor: Actor,
  input: { deleteAccount?: unknown },
  now = Date.now(),
): Promise<boolean> {
  if (input.deleteAccount !== true || !actor.workspaceId) return false
  const [owner] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, actor.workspaceId), eq(member.role, 'owner')))
  if (owner?.userId !== actor.actorId) return false
  return !(await signedInJustNow(tx, actor, now))
}

/** agentSetup.createWorkspaceKey without a sign-in in the last 10 minutes (security review #822 F2, F4). */
export const SETUP_LINK_SIGN_IN_AGAIN =
  'Sign in again to create a setup link. Creating one needs a sign-in from the last 10 minutes.'

/** The refusal run-action answers before the link is made: the setup page offers "Sign in again" on the code. */
export const setupLinkSignInRefusal = { ok: false as const, error: SETUP_LINK_SIGN_IN_AGAIN, code: SIGN_IN_AGAIN }

/**
 * A workspace owner's setup link (agentSetup.createWorkspaceKey) needs a sign-in within the last 10 minutes
 * (signedInJustNow): the link reaches the workspace's numbers and transfer number for 4 hours, and owners need no
 * passkey for it, so a stolen or forgotten long-lived session must not hand one out.
 */
export async function setupLinkNeedsFreshSignIn(tx: Tx | typeof db, actor: Actor, now = Date.now()): Promise<boolean> {
  return !(await signedInJustNow(tx, actor, now))
}

/** personalKey.create without a sign-in in the last 10 minutes (LIN-339 security review M2). */
export const PERSONAL_KEY_SIGN_IN_AGAIN =
  'Sign in again to create a personal API key. Creating one needs a sign-in from the last 10 minutes.'

/** personalKey.create by someone with a passkey, not confirmed in the last 10 minutes. */
export const PERSONAL_KEY_CONFIRM =
  'Confirm with your passkey or authenticator app to create a personal API key. Creating one needs a confirmation from the last 10 minutes.'

/** What the person still has to do before making a personal key; `authenticator`: the app is offered next to the passkey. */
export type PersonalKeyStepUp = { stepUp: OwnerStepUp; authenticator: boolean }

/**
 * A personal API key (personalKey.create) acts as its maker in every workspace and never expires, so a session left
 * open or stolen must not make one (security review M2). Someone with a passkey confirms it in place (Tim,
 * 2026-11-16): their passkey, or an instance admin's authenticator app, within the last 10 minutes (the check sets
 * passkeyVerifiedAt either way). Without a passkey, or with ADMIN_SECOND_FACTOR=off: a sign-in within the last
 * 10 minutes. No session (an API key, the agent) or an impersonation: `signIn`, which they can never satisfy that way.
 */
export async function personalKeyStepUpNeeded(
  tx: Tx | typeof db,
  actor: Actor,
  now = Date.now(),
): Promise<PersonalKeyStepUp | null> {
  const signIn = { stepUp: 'signIn' as const, authenticator: false }
  if (!actor.sessionId || actor.impersonation) return signIn
  const [own] = await tx
    .select({
      createdAt: session.createdAt,
      passkeyVerifiedAt: session.passkeyVerifiedAt,
      impersonatedBy: session.impersonatedBy,
    })
    .from(session)
    .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId)))
  if (!own || own.impersonatedBy) return signIn
  const [key] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actor.actorId)).limit(1)
  if (key && adminSecondFactorRequired()) {
    if (signedInWithin(own.passkeyVerifiedAt, RECENT_HOURS, now)) return null
    // Only instance admins can check a code from the app (account.authenticatorCheck, by the account, not the
    // session: before its passkey confirmation an admin's session has no instance:admin).
    const [account] = await tx.select().from(user).where(eq(user.id, actor.actorId))
    const app = !!account && isInstanceAdmin(account) && (await hasAuthenticator(tx, actor.actorId))
    return { stepUp: 'passkey', authenticator: app }
  }
  return signedInWithin(own.createdAt, RECENT_HOURS, now) ? null : signIn
}

/** The refusal run-action answers before the key is made: Settings › Personal API keys acts on the code. */
export function personalKeyStepUpRefusal({ stepUp, authenticator }: PersonalKeyStepUp) {
  return stepUp === 'passkey'
    ? {
        ok: false as const,
        error: PERSONAL_KEY_CONFIRM,
        code: PASSKEY_STEP_UP_REQUIRED,
        stepUp: 'confirm' as const,
        authenticator,
      }
    : { ok: false as const, error: PERSONAL_KEY_SIGN_IN_AGAIN, code: SIGN_IN_AGAIN }
}
