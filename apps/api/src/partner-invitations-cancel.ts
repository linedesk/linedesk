// Its own small module, not partners.ts: admin-handlers.ts needs it, and partners.ts reaches handlers.ts through
// workspace-creation-handlers.ts, which imports admin-handlers.ts back. That cycle left the action registry without
// Server admin's handlers whenever admin-handlers.ts was loaded first ("provider.setKeys has neither a patch nor a
// handler").
import { partner_invitations, type Tx } from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Cancels the open partner team invitations `userId` sent, in every partner (user.disable, LIN-441): accepted with a
 * second address, one would bring a disabled account back onto the team, and so into every client workspace.
 */
export async function cancelPartnerInvitationsFrom(tx: Tx, userId: string, now: string) {
  await tx
    .update(partner_invitations)
    .set({ canceled_at: now })
    .where(
      and(
        eq(partner_invitations.invited_by, userId),
        isNull(partner_invitations.accepted_at),
        isNull(partner_invitations.canceled_at),
      ),
    )
}
