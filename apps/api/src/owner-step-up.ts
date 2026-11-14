// An owner deleting their own workspace (workspace.deleteOwn) proves first that it is them at the keyboard, not
// someone with a session left open or a stolen cookie: a sign-in within the last 10 minutes, and when they have a
// passkey, that sign-in must be the passkey. Checked before the action runs (run-action.ts, so the web app gets a
// code it can act on) and again inside its handler. Impersonation sessions never pass. ADMIN_SECOND_FACTOR=off
// (an install without https, where passkeys cannot work) leaves only the 10 minutes.
import type { OwnerStepUp } from '@linedesk/actions'
import { passkey, session, type Tx } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { RECENT_SIGN_IN_MS, SIGN_IN_AGAIN } from './account.ts'
import { adminSecondFactorRequired, signedInWithin } from './admin-second-factor.ts'
import { PASSKEY_STEP_UP_REQUIRED } from './admin-step-up.ts'
import type { Actor } from './context.ts'
import type { db } from './db.ts'

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
      impersonatedBy: session.impersonatedBy,
    })
    .from(session)
    .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId)))
  if (!own || own.impersonatedBy) return 'signIn'
  const [key] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actor.actorId)).limit(1)
  if (key && adminSecondFactorRequired())
    return signedInWithin(own.passkeyVerifiedAt, RECENT_HOURS, now) ? null : 'passkey'
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
