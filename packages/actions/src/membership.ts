// Memberships across workspaces: the invitee answering an invitation in the app, and the instance
// admin adding people to workspaces directly. A workspace's own owners and admins use team.*.
// Members and invitations are Better Auth's tables (not synced), so every action has a handler.
import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * Roles an instance admin can give. Unlike team.*, owner is one: an admin can hand a workspace over (the owner becomes
 * an admin), or give an owner to a workspace that has none yet (made in Server admin › Workspaces, its owner invited).
 */
export const membershipRoles = ['owner', 'admin', 'member'] as const
export type MembershipRole = (typeof membershipRoles)[number]

/** A pending invitation to the signed-in user's verified email address (`invitation.listMine`). */
export type MyInvitation = { invitationId: string; workspaceId: string; workspaceName: string; role: string; invitedBy: string; expiresAt: string }

const invitationId = z.object({ invitationId: z.string().min(1) })

export const invitationListMine = defineAction({
  name: 'invitation.listMine',
  description: 'List the pending invitations to your verified email address, from other workspaces.',
  input: z.object({}),
  permission: 'invitation:respond',
  readOnly: true,
})

export const invitationAccept = defineAction({
  name: 'invitation.accept',
  description: 'Join a workspace you were invited to. Your email address must be verified and match the invitation.',
  input: invitationId,
  permission: 'invitation:respond',
  sensitive: ['invitationId'],
})

export const invitationDecline = defineAction({
  name: 'invitation.decline',
  description: 'Decline an invitation to your email address; its link stops working.',
  input: invitationId,
  permission: 'invitation:respond',
  sensitive: ['invitationId'],
})

export const membershipAdd = defineAction({
  name: 'membership.add',
  description:
    "Add an existing user to a workspace with a role. An address that is not confirmed yet gets an invitation instead and joins once it is. Owner only for a workspace that has no owner and no pending owner invitation. The workspace's owner is told.",
  input: z.object({ userId: z.string().min(1), workspaceId: z.string().min(1), role: z.enum(membershipRoles) }),
  permission: 'instance:admin',
})

export const membershipSetRole = defineAction({
  name: 'membership.setRole',
  description:
    "Change a member's role in any workspace. Making someone owner hands the workspace over: the previous owner becomes an admin. The owner's own role changes only that way. Owner and admin only for a confirmed address.",
  input: z.object({ memberId: z.string().min(1), role: z.enum(membershipRoles) }),
  permission: 'instance:admin',
})

export const membershipRemove = defineAction({
  name: 'membership.remove',
  description:
    "Remove a member from any workspace; they lose access at once, and the pending invitations they sent to it are canceled. Never the owner: make someone else owner first. When it was their only workspace their account is deleted too (never a server admin's), unless keepAccount is true.",
  input: z.object({ memberId: z.string().min(1), keepAccount: z.boolean().optional() }).strict(),
  permission: 'instance:admin',
})

export const invitationRevoke = defineAction({
  name: 'invitation.revoke',
  description: "Revoke a pending invitation of any workspace; its link stops working.",
  input: invitationId,
  permission: 'instance:admin',
  sensitive: ['invitationId'],
})

export const invitationResend = defineAction({
  name: 'invitation.resend',
  description: 'Send a pending invitation of any workspace again; the link works for another seven days.',
  input: invitationId,
  permission: 'instance:admin',
  sensitive: ['invitationId'],
})
