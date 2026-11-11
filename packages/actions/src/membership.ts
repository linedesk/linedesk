// Memberships across workspaces: the invitee answering an invitation in the app, and the instance
// admin adding people to workspaces directly. A workspace's own owners and admins use team.*.
// Members and invitations are Better Auth's tables (not synced), so every action has a handler.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** Roles an instance admin can give. Unlike team.*, owner is one: an admin can hand a workspace over. */
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
  description: 'Add an existing user to a workspace with a role, without an invitation email.',
  input: z.object({ userId: z.string().min(1), workspaceId: z.string().min(1), role: z.enum(membershipRoles) }),
  permission: 'instance:admin',
})

export const membershipSetRole = defineAction({
  name: 'membership.setRole',
  description: "Change a member's role in any workspace. A workspace keeps at least one owner.",
  input: z.object({ memberId: z.string().min(1), role: z.enum(membershipRoles) }),
  permission: 'instance:admin',
})

export const membershipRemove = defineAction({
  name: 'membership.remove',
  description: 'Remove a member from any workspace; they lose access at once. Never the last owner.',
  input: z.object({ memberId: z.string().min(1) }),
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
