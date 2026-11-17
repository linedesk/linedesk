// Team: who belongs to a workspace and with which role. Members and invitations live in Better
// Auth's tables (not synced to the browser), so every action has a server handler and no patch.
import { z } from 'zod'
import { LOGO_MAX_BYTES } from './branding.ts'
import { defineAction } from './define.ts'
import type { ChangedBy, NotificationSettingsData } from './notifications.ts'

/**
 * Roles an invitation or a role change (team.setRole) can give. Owner is not one: a workspace has exactly one owner,
 * who hands it over with team.transferOwnership.
 */
export const assignableRoles = ['admin', 'member'] as const
export type AssignableRole = (typeof assignableRoles)[number]
/** Every workspace role. Owner: exactly one per workspace (a unique index on member), admins and members: any number. */
export const teamRoles = ['owner', 'admin', 'member'] as const
export type TeamRole = (typeof teamRoles)[number]

/** How long an invitation link works, from when it was sent (or last resent). */
export const INVITATION_DAYS = 7

/** `avatarUrl`: the profile picture (user-avatar.ts), null without one (absent in a list an older version cached). */
export type TeamMember = {
  memberId: string
  userId: string
  name: string
  email: string
  role: 'owner' | 'admin' | 'member'
  joinedAt: string
  avatarUrl?: string | null
  /**
   * In the workspace through its white-label partner's team (docs/white-label.md): the partner's company name. The
   * Team page shows a "Partner" badge; only the partner changes or removes these memberships.
   */
  partner?: string | null
  /**
   * Invited into this workspace by someone on its white-label partner's team (security review of #1109, L-4): they
   * leave with the partner when it is removed or hands the workspace over.
   */
  invitedByPartner?: boolean
}
/** `invitedById`: the sender's user id (the remove dialog counts the invitations a removal cancels). */
export type TeamInvitation = {
  invitationId: string
  email: string
  role: AssignableRole
  invitedBy: string
  invitedById: string
  expiresAt: string
  expired: boolean
}
/** What `team.list` returns in `data`. `canManage`: whether the caller may invite, change roles and remove. */
export type TeamData = {
  members: TeamMember[]
  invitations: TeamInvitation[]
  canManage: boolean
  me: string
  /** The workspace's white-label partner (docs/white-label.md), also while its team is suspended; null without one. */
  partner: string | null
}

/** What `GET /v1/invitations/<id>` tells the invitation page before anyone signs in. */
export type InvitationPreview =
  | { status: 'pending'; email: string; workspaceName: string; invitedBy: string; role: string }
  | { status: 'expired' | 'gone' }

export const teamList = defineAction({
  name: 'team.list',
  description:
    'List the members of the workspace (name, email, role, joined) and the invitations that were not accepted yet.',
  input: z.object({}),
  permission: 'team:read',
  readOnly: true,
})

export const teamInvite = defineAction({
  name: 'team.invite',
  description:
    'Invite someone by email to join the workspace as admin or member. Sends the invitation email; the link works for seven days.',
  input: z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(assignableRoles) }),
  permission: 'team:write',
  sensitive: ['invitationId'],
})

export const teamResendInvite = defineAction({
  name: 'team.resendInvite',
  description: 'Send an invitation email again; the link works for another seven days.',
  input: z.object({ invitationId: z.string().min(1) }),
  permission: 'team:write',
  sensitive: ['invitationId'],
})

export const teamRevokeInvite = defineAction({
  name: 'team.revokeInvite',
  description: 'Revoke an invitation; its link stops working.',
  input: z.object({ invitationId: z.string().min(1) }),
  permission: 'team:write',
  sensitive: ['invitationId'],
})

export const teamSetRole = defineAction({
  name: 'team.setRole',
  description:
    "Change a member's role to admin or member. Never the owner's: the owner hands the workspace over with team.transferOwnership.",
  input: z.object({ memberId: z.string().min(1), role: z.enum(assignableRoles) }),
  permission: 'team:write',
})

/**
 * The owner hands the workspace over: the member becomes its owner and the owner an admin, in one transaction. Only
 * the owner (workspace:own), never while impersonating, and only to a member whose address is confirmed.
 */
export const teamTransferOwnership = defineAction({
  name: 'team.transferOwnership',
  description:
    'Make another member the owner of this workspace. You become an admin. Only the owner can do this; the new owner must have confirmed their email address.',
  input: z.object({ memberId: z.string().min(1) }),
  permission: 'workspace:own',
})

/**
 * Leave the workspace you are signed in to. Every member may (also of a disabled workspace), so it
 * needs no more than reading the team; the owner cannot leave (they transfer ownership first).
 */
export const teamLeave = defineAction({
  name: 'team.leave',
  description:
    "Leave the current workspace; you lose access at once. The owner cannot leave: they hand the workspace over first. When it is your only workspace, deleteAccount must say whether your account goes too (true deletes it, never a server admin's, and needs a sign-in within the last 10 minutes; false keeps it); without it the leave is refused.",
  input: z.object({ deleteAccount: z.boolean().optional() }).strict(),
  permission: 'team:read',
})
/** What `team.leave` returns: the workspace to continue in, or null when none is left; whether the account went too. */
export type TeamLeaveData = { nextWorkspaceId: string | null; accountDeleted: boolean }

export const teamRemoveMember = defineAction({
  name: 'team.removeMember',
  description:
    "Remove a member from the workspace; they lose access at once, and the pending invitations they sent to it are canceled. Never the owner. Their account stays (without a workspace they wait for an invitation). Only the workspace's owner may set deleteAccount, with a sign-in within the last 10 minutes: when it was their only workspace their account is deleted too (never a server admin's) and they are emailed.",
  input: z.object({ memberId: z.string().min(1), deleteAccount: z.boolean().optional() }).strict(),
  permission: 'team:write',
})

// Editing a teammate (Workspace settings › Team › Edit): owners and admins change another member's profile (name,
// picture) and their own notification settings in this workspace. Never their email, password, passkeys, sign-in
// methods, sessions or API keys: those stay with the person. The handlers (apps/api/src/team-member-edit.ts) check
// the target is in the caller's workspace, that only an owner edits an owner, and refuse an impersonated session.
// Every change is in the audit log and the member's own page says who made it.

/** Longest name, as an instance admin gives one (user.invite). */
export const MEMBER_NAME_MAX = 80

/**
 * Invisible characters that change how a name reads without showing: zero-width spaces and joiners, direction marks,
 * bidi embeddings, overrides and isolates, word joiners, the byte-order mark. A name with an override can show as
 * another person's ("Mike" written backwards), so names never keep them.
 */
const INVISIBLE_IN_NAMES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/** A person's name as it is stored: without invisible characters, trimmed. For every name a person is given. */
export const cleanPersonName = (name: string) => name.replace(INVISIBLE_IN_NAMES, '').trim()

/** What `team.getMember` returns in `data`: everything the Edit dialog shows. */
export type MemberEditData = {
  member: TeamMember
  /**
   * Whether the caller may change their name and picture. Both belong to the account, so only when the caller
   * manages the team in every workspace the member is in (and is an owner wherever the member is one); else only
   * they can. Their notifications here stay editable either way.
   */
  profileEditable: boolean
  /** The member is in other workspaces too: their name and picture change there as well. */
  inOtherWorkspaces: boolean
  /** The member's notification settings in this workspace, as they see them (their push devices only counted). */
  notifications: NotificationSettingsData
  /** Whether calls can be assigned here (a second member): the assigned-call email then applies. */
  canAssign: boolean
  /** The last change to their profile by someone else, null when the last change was theirs. */
  profileChangedBy: ChangedBy | null
}

const memberId = z.string().min(1)

export const teamGetMember = defineAction({
  name: 'team.getMember',
  description: "Read a teammate's profile and notification settings in this workspace, for editing them.",
  input: z.object({ memberId }),
  permission: 'team:write',
  readOnly: true,
})

export const teamUpdateMemberProfile = defineAction({
  name: 'team.updateMemberProfile',
  description:
    "Change a teammate's name. The name belongs to their account: it changes in every workspace they are in, so only when you manage the team in each of them. Only an owner changes an owner's.",
  input: z.object({
    memberId,
    name: z.string().transform(cleanPersonName).pipe(z.string().min(1, 'Enter a name.').max(MEMBER_NAME_MAX)),
  }),
  permission: 'team:write',
})

const AVATAR_PREFIX = 'data:image/png;base64,'

export const teamSetMemberAvatar = defineAction({
  name: 'team.setMemberAvatar',
  description:
    "Set a teammate's profile picture (as account.setAvatar does for your own): a PNG data URL, at most 512×512 pixels and 512 KB. Answers with `avatarUrl`.",
  input: z.object({
    memberId,
    avatar: z
      .string()
      .startsWith(AVATAR_PREFIX, 'The picture must be a PNG.')
      .max(AVATAR_PREFIX.length + Math.ceil(LOGO_MAX_BYTES / 3) * 4, 'The picture is too large.'),
  }),
  permission: 'team:write',
  // The command log notes that a picture was sent, not the image.
  sensitive: ['avatar'],
})

export const teamRemoveMemberAvatar = defineAction({
  name: 'team.removeMemberAvatar',
  description: "Remove a teammate's profile picture: their initials show again.",
  input: z.object({ memberId }),
  permission: 'team:write',
})

export const teamUpdateMemberNotifications = defineAction({
  name: 'team.updateMemberNotifications',
  description:
    "Change a teammate's own new-call notifications in this workspace (as notifications.update does for yours). null goes back to the workspace default. The push summary can only be turned off.",
  input: z.object({
    memberId,
    email: z.boolean().nullable().optional(),
    /** Only off: a teammate's lock-screen summary is theirs to turn on (it can show what a call was about). */
    pushSummary: z.literal(false).optional(),
    assignedEmail: z.boolean().optional(),
    setupEmails: z.boolean().optional(),
  }),
  permission: 'team:write',
})
