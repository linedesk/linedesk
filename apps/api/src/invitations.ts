// Joining a workspace by invitation: what the invitation link shows before sign-in, and the
// checks Better Auth runs when an invitation is accepted (wired in auth.ts).
import type { InvitationPreview } from '@linedesk/actions'
import { invitation, member, organization, user } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'
import { db } from './db.ts'
import type { RequestHost } from './request-host.ts'

/**
 * Public: the invitation page asks whom the link is for before anyone signs in. The id is the
 * secret from the email, so whoever has it may see the address and the workspace name while it is
 * pending. An accepted one says only that (security review of #1324, L-1): its workspace id only
 * to the signed-in account with the invited address, whose link then opens the workspace (only a
 * member can open it; the id alone lets nobody in). Never the address, which would otherwise stay
 * readable for as long as the link exists. On a partner's address only that partner's invitations
 * exist (review L-2, as accept and list there: host-sessions.ts, memberships.ts `onlyHere`).
 */
export async function previewInvitation(
  id: string,
  viewer: { email: string } | null,
  host: RequestHost,
): Promise<InvitationPreview> {
  const [row] = await db
    .select({
      workspaceId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      workspaceName: organization.name,
      invitedBy: user.name,
      partnerId: organization.partnerId,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, id))
  if (!row || (host.kind === 'partner' && row.partnerId !== host.partnerId)) return { status: 'gone' }
  if (row.status === 'accepted') {
    const invited = viewer !== null && viewer.email.toLowerCase() === row.email.toLowerCase()
    return invited ? { status: 'accepted', workspaceId: row.workspaceId } : { status: 'accepted' }
  }
  if (row.status !== 'pending') return { status: 'gone' }
  if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' }
  return {
    status: 'pending',
    email: row.email,
    workspaceName: row.workspaceName,
    invitedBy: row.invitedBy,
    role: row.role ?? 'member',
  }
}

/**
 * Better Auth hook before an invitation is accepted. It has already checked that the signed-in email matches and is
 * verified (by an email code or a provider that proved it; there is no email link). An owner invitation to a workspace that has an owner by now is turned into an admin invitation first:
 * Better Auth reads the invitation again when it marks it accepted and creates the member with that role, so a
 * workspace never gets a second owner (the unique owner index would refuse it anyway).
 */
export async function refuseExistingMember({ invitation: invite, user: account }: { invitation: { id: string; organizationId: string; role?: string | null }; user: { id: string } }) {
  const [existing] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, invite.organizationId), eq(member.userId, account.id)))
  if (existing) throw new APIError('BAD_REQUEST', { code: 'ALREADY_MEMBER', message: 'You are already a member of this workspace.' })
  if (invite.role !== 'owner') return
  const [owner] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, invite.organizationId), eq(member.role, 'owner')))
  if (owner) await db.update(invitation).set({ role: 'admin' }).where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
}
