// Team: who belongs to a workspace and with which role. Members and invitations live in Better
// Auth's tables (not synced to the browser), so every action has a server handler and no patch.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** Roles that can be given by invitation or by a role change. Owner is not one: no ownership transfer yet. */
export const assignableRoles = ['admin', 'member'] as const
export type AssignableRole = (typeof assignableRoles)[number]

/** How long an invitation link works, from when it was sent (or last resent). */
export const INVITATION_DAYS = 7

export type TeamMember = { memberId: string; userId: string; name: string; email: string; role: 'owner' | 'admin' | 'member'; joinedAt: string }
export type TeamInvitation = { invitationId: string; email: string; role: AssignableRole; invitedBy: string; expiresAt: string; expired: boolean }
/** What `team.list` returns in `data`. `canManage`: whether the caller may invite, change roles and remove. */
export type TeamData = { members: TeamMember[]; invitations: TeamInvitation[]; canManage: boolean; me: string }

/** What `GET /v1/invitations/<id>` tells the invitation page before anyone signs in. */
export type InvitationPreview =
  | { status: 'pending'; email: string; workspaceName: string; invitedBy: string; role: string }
  | { status: 'expired' | 'gone' }

export const teamList = defineAction({
  name: 'team.list',
  description: 'List the members of the workspace (name, email, role, joined) and the invitations that were not accepted yet.',
  input: z.object({}),
  permission: 'team:read',
  readOnly: true,
})

export const teamInvite = defineAction({
  name: 'team.invite',
  description: 'Invite someone by email to join the workspace as admin or member. Sends the invitation email; the link works for seven days.',
  input: z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(assignableRoles) }),
  permission: 'team:write',
})

export const teamResendInvite = defineAction({
  name: 'team.resendInvite',
  description: 'Send an invitation email again; the link works for another seven days.',
  input: z.object({ invitationId: z.string().min(1) }),
  permission: 'team:write',
})

export const teamRevokeInvite = defineAction({
  name: 'team.revokeInvite',
  description: 'Revoke an invitation; its link stops working.',
  input: z.object({ invitationId: z.string().min(1) }),
  permission: 'team:write',
})

export const teamSetRole = defineAction({
  name: 'team.setRole',
  description: "Change a member's role to admin or member. Only an owner can change an owner's role, and the last owner keeps it.",
  input: z.object({ memberId: z.string().min(1), role: z.enum(assignableRoles) }),
  permission: 'team:write',
})

/**
 * Leave the workspace you are signed in to. Every member may (also of a disabled workspace), so it
 * needs no more than reading the team; the last owner cannot leave.
 */
export const teamLeave = defineAction({
  name: 'team.leave',
  description: 'Leave the current workspace; you lose access at once. The last owner cannot leave.',
  input: z.object({}),
  permission: 'team:read',
})
/** What `team.leave` returns: the workspace to continue in, or null when none is left. */
export type TeamLeaveData = { nextWorkspaceId: string | null }

export const teamRemoveMember = defineAction({
  name: 'team.removeMember',
  description: 'Remove a member from the workspace; they lose access at once. Only an owner can remove an owner, and never the last one.',
  input: z.object({ memberId: z.string().min(1) }),
  permission: 'team:write',
})
