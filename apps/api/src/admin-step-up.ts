// What is left of the per-action passkey step-up for instance admins (#293, #694): nothing per action. Since Janik's
// decision of 2026-11-15 every instance-admin action needs a session that passed the passkey check
// (admin-second-factor.ts), so the list of actions that needed a passkey "on top", the 5-minute grant for setup links
// and the private-endpoint exception are gone. Kept here: the refusal code a workspace owner's step-up still uses
// (owner-step-up.ts), and two helpers for the first-run setup and the handlers that hand out enrolment codes.
// The server operator (CLI) needs no passkey.
import { passkey } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'

/** A workspace owner's passkey step-up (owner-step-up.ts); the web app's passkey dialog reacts to it. */
export const PASSKEY_STEP_UP_REQUIRED = 'PASSKEY_STEP_UP_REQUIRED'

/**
 * An instance admin who has no passkey on an install that asks for one: Server admin waits for it (the first-run
 * setup asks for the passkey first, install-setup.ts).
 */
export async function passkeyStillNeeded(userId: string): Promise<boolean> {
  if (!adminSecondFactorRequired()) return false
  const [own] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)
  return !own
}

/** For handlers that hand out an enrolment code: never to a session that is not passkey-confirmed. */
export function mayReceiveEnrolmentCode(actor: Actor): boolean {
  return Boolean(actor.passkeyConfirmed) || !adminSecondFactorRequired()
}
