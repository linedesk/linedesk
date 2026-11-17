// People a white-label partner's team invited into one of its client workspaces (security review of #1109, L-4; of
// #1113, M-1): not members through the team (no `member.partner_id`), yet let in by it, for example an admin's second
// address or staff the partner onboarded. When the client's owner removes the partner or the partner hands the
// workspace over, the confirmation lists them and the person chooses who leaves too; nobody is picked by default
// (partners.ts detachClient). The client's owner, and anyone who ever owned the workspace, are never among them.
import { commands, invitation, member, partner_members, type Tx, user } from '@linedesk/db'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'

export type InvitedByPartner = { memberId: string; userId: string; name: string; email: string }

/**
 * The members of `workspaceId` whose latest accepted invitation there came from someone on the team of `partnerId`
 * (owner or admin, as the team is now) and who are not there through the team themselves. Never the workspace's owner,
 * never a former owner: an address that was ever invited as owner, or someone who handed ownership on or received it
 * (`team.transferOwnership`).
 */
export async function invitedByPartnerTeam(
  tx: Pick<Tx, 'select'>,
  workspaceId: string,
  partnerId: string,
): Promise<InvitedByPartner[]> {
  return tx
    .select({ memberId: member.id, userId: member.userId, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, workspaceId),
        isNull(member.partnerId),
        ne(member.role, 'owner'),
        // The latest accepted invitation of the address decides who let them in.
        sql`(
          select ${invitation.inviterId} from ${invitation}
          where ${invitation.organizationId} = ${workspaceId}
            and lower(${invitation.email}) = lower(${user.email})
            and ${invitation.status} = 'accepted'
          order by ${invitation.createdAt} desc, ${invitation.id} desc
          limit 1
        ) in (select ${partner_members.user_id} from ${partner_members} where ${partner_members.partner_id} = ${partnerId})`,
        // Never a former owner: invited as the owner once (workspace.inviteClientOwner) ...
        sql`not exists (
          select 1 from ${invitation}
          where ${invitation.organizationId} = ${workspaceId}
            and lower(${invitation.email}) = lower(${user.email})
            and ${invitation.role} = 'owner'
            and ${invitation.status} = 'accepted'
        )`,
        // ... or on either side of an ownership transfer here.
        sql`not exists (
          select 1 from ${commands}
          where ${commands.workspace_id} = ${workspaceId}
            and ${commands.action} = 'team.transferOwnership'
            and not ${commands.rejected}
            and (${commands.actor_id} = ${member.userId} or ${commands.input}->>'memberId' = ${member.id})
        )`,
      ),
    )
    .orderBy(user.name, user.email)
}
