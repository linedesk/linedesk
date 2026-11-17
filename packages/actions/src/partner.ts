// White-label partners in the shared install (docs/white-label.md, slice S1): a partner account with its own team,
// approved or suspended by an instance admin, and client workspaces whose admins are the partner's team. Every partner
// action names its partner; the API checks the caller is on that partner's team (apps/api/src/partners.ts), so a
// member of one partner reaches nothing of another.
import { z } from 'zod'
import { defineAction } from './define.ts'
import { workspaceName } from './settings.ts'

export const PARTNER_STATUSES = ['pending', 'approved', 'suspended'] as const
export type PartnerStatus = (typeof PARTNER_STATUSES)[number]
export type PartnerRole = 'owner' | 'admin'

/**
 * Why a partner action was refused, sent as the rejection's `code`: the web app shows the code's key
 * (`team.partner.error.<code>`); the English stays in the API body for logs and API clients.
 */
export const PARTNER_CODES = [
  'not_found',
  'already_member',
  'already_invited',
  'invitation_invalid',
  'invitation_other_email',
  'email_unverified',
  'owner_taken',
  'owner_stays',
  'member_not_found',
  'no_email',
  'send_failed',
  'invite_limit',
  'client_needs_bill',
  'partner_managed',
  'partner_suspended',
  'partner_pending',
  'client_limit',
  'client_not_found',
  'client_has_owner',
  'owner_on_team',
  'client_no_owner',
  'bill_not_started',
  'bill_inactive',
  'trial_client_limit',
  'calls_running',
  'confirm_mismatch',
  'no_partner',
  'already_partner',
  'client_owner',
] as const
export type PartnerCode = (typeof PARTNER_CODES)[number]

const partnerId = z.string().min(1).max(64)
/**
 * Control characters, line and paragraph separators and the bidi controls that reorder text: stripped from a partner's
 * name, which goes into invitation emails to any address (security review of #1100, L-3).
 */
const PARTNER_NAME_STRIP = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu
export const cleanPartnerName = (name: string) => name.replace(PARTNER_NAME_STRIP, '').trim()
const partnerName = z.string().transform(cleanPartnerName).pipe(z.string().min(1).max(80))
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
/** The invitation link's token (base64url of 32 bytes). */
const token = z.string().min(20).max(128)

// --- The partner team (partner area) ------------------------------------------------------------------------------

export const partnerGet = defineAction({
  name: 'partner.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'One partner you are on the team of: its name and status, your role, the team, open invitations (owner only) and the client workspaces. Refused for a partner you are not on the team of.',
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerUpdate = defineAction({
  name: 'partner.update',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: "Rename the partner (its own company name). The partner's owner only.",
  input: z.object({ partnerId, name: partnerName }),
  permission: 'partner',
})

export const partnerMemberInvite = defineAction({
  name: 'partnerMember.invite',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Invite someone to the partner team as an admin, by email. They become an admin of every client workspace once they accept. The partner's owner only.",
  input: z.object({ partnerId, email }),
  permission: 'partner',
})

export const partnerMemberRevokeInvite = defineAction({
  name: 'partnerMember.revokeInvite',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: "Withdraw an open invitation to the partner team. The partner's owner only.",
  input: z.object({ partnerId, invitationId: z.string().min(1).max(64) }),
  permission: 'partner',
})

export const partnerMemberRemove = defineAction({
  name: 'partnerMember.remove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove an admin from the partner team: they leave every client workspace of the partner at once, and the API keys they made there are revoked. Never the owner. The partner's owner only.",
  input: z.object({ partnerId, userId: z.string().min(1).max(64) }),
  permission: 'partner',
})

export const partnerInvitationView = defineAction({
  name: 'partnerInvitation.view',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'What a partner team invitation link is for: the partner, the role, and whether it is for your address and still open.',
  input: z.object({ token }),
  permission: 'account:own',
  readOnly: true,
  sensitive: ['token'],
})

export const partnerInvitationAccept = defineAction({
  name: 'partnerInvitation.accept',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Join a partner team with the link from the invitation email. Only for the address it was sent to, confirmed.',
  input: z.object({ token }),
  permission: 'account:own',
  sensitive: ['token'],
})

export const workspaceCreateForClient = defineAction({
  name: 'workspace.createForClient',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Create a workspace for a client of the partner. Every member of the partner team becomes an admin of it. With ownerEmail (the partner's owner only), the client's owner is invited at once (else later with workspace.inviteClientOwner). Where billing is on, the workspace goes on the partner bill and adds a seat to its plan; in the free trial at most the trial's number of client workspaces.",
  input: z.object({
    partnerId,
    name: workspaceName,
    ownerEmail: email.optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform(c => c.toUpperCase())
      .optional(),
    timeZone: z.string().max(64).optional(),
  }),
  permission: 'partner',
})

export const workspaceInviteClientOwner = defineAction({
  name: 'workspace.inviteClientOwner',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Invite the owner of a client workspace of the partner, by email: the client's own person, never someone on the partner team. Refused while the workspace has an owner. The partner's owner only (the client's owner can remove the partner).",
  input: z.object({ partnerId, workspaceId: z.string().min(1).max(64), email }),
  permission: 'partner',
})

/** The workspace's name typed again: what removing or releasing a partner asks for. */
const confirmName = z.string().trim().min(1).max(200)

export const partnerReleaseClient = defineAction({
  name: 'partner.releaseClient',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Hand a client workspace over to the client: the partner team leaves it at once (their API keys there are revoked), and where billing is on it moves off the partner bill to a bill of the client's owner, which needs their card before calls are answered again. Only once the client has its owner. Type the workspace's name to confirm. The partner's owner only.",
  input: z.object({ partnerId, workspaceId: z.string().min(1).max(64), confirmName }),
  permission: 'partner',
})

export const workspaceRemovePartner = defineAction({
  name: 'workspace.removePartner',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove this workspace's white-label partner: every member of the partner team leaves it at once (their API keys here are revoked), and where billing is on the workspace moves off the partner's bill to a bill of yours, which needs your card before calls are answered again. Type the workspace's name to confirm. The workspace's owner only.",
  input: z.object({ confirmName }),
  permission: 'workspace:own',
})

// --- Server admin › Partners -------------------------------------------------------------------------------------

export const partnerAdminList = defineAction({
  name: 'partner.adminList',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Every partner on this install: status, owner, team size, client workspaces, bill. Instance admins only.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const partnerCreate = defineAction({
  name: 'partner.create',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Create a partner by hand (no bill) and invite its owner by email. It starts pending until approved. Instance admins only.',
  input: z.object({ name: partnerName, ownerEmail: email }),
  permission: 'instance:admin',
})

export const partnerApprove = defineAction({
  name: 'partner.approve',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Approve a pending partner, or reinstate a suspended one (its team is an admin of its client workspaces again). Instance admins only.',
  input: z.object({ partnerId }),
  permission: 'instance:admin',
})

export const partnerSuspend = defineAction({
  name: 'partner.suspend',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Suspend a partner: its team leaves every client workspace at once and can change nothing until it is approved again. Instance admins only.',
  input: z.object({ partnerId }),
  permission: 'instance:admin',
})

/**
 * Client workspaces per partner on an install without billing (self-host, dev, staging): a ceiling, so one partner
 * cannot make workspaces without end there (security review of #1100, L-2). With billing on they go on the partner
 * bill (S2) instead. Server admin › Partners changes it.
 */
export const PARTNER_CLIENT_LIMIT_DEFAULT = 25
export const PARTNER_CLIENT_LIMIT_MAX = 1000

export const partnerSetClientLimit = defineAction({
  name: 'partner.setClientLimit',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'How many client workspaces each partner may make on this install while billing is off. Instance admins only.',
  input: z.object({ limit: z.number().int().min(1).max(PARTNER_CLIENT_LIMIT_MAX) }),
  permission: 'instance:admin',
})

// --- What the actions answer ------------------------------------------------------------------------------------

/** A partner the signed-in person is on the team of (GET /v1/me `partners`). */
export type MyPartner = { id: string; name: string; status: PartnerStatus; role: PartnerRole }

export type PartnerTeamMember = { userId: string; name: string; email: string; role: PartnerRole; joinedAt: string }
export type PartnerInvitationRow = {
  id: string
  email: string
  role: PartnerRole
  expiresAt: string
  expired: boolean
}
/**
 * Someone in a client workspace who is not there through the partner team, with who invited them when known (security
 * review of #1100, N-1): the partner owner sees who else reads the client's calls.
 */
export type PartnerClientMember = {
  name: string
  email: string
  role: 'owner' | 'admin' | 'member'
  invitedBy: string | null
}
export type PartnerClient = {
  id: string
  name: string
  createdAt: string
  /** The client's own owner: joined, invited (`invited`: the address), or none yet. */
  owner: { name: string; email: string } | { invited: string } | null
  /** The partner owner only: every member who is not on the partner team (N-1); empty for the admins. */
  otherMembers: PartnerClientMember[]
}

/**
 * The partner bill as the partner area shows it (the bill's own page is Partner › Billing, `billing.overview` with the
 * partnerId): null where billing is off or the partner has no bill (made by a server admin on an install without it).
 */
export type PartnerBillSummary = {
  status: 'pending_payment' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'comped'
  /** The most client workspaces in the free trial (the install's sign-up rules). */
  trialClientLimit: number
  /** Whether the person asking owns the bill (the partner's owner): they open its page. */
  mine: boolean
}

/** `partner.get`. Invitations only for the owner (the admins see the team, not who is invited). */
export type PartnerData = {
  partner: { id: string; name: string; status: PartnerStatus }
  role: PartnerRole
  members: PartnerTeamMember[]
  invitations: PartnerInvitationRow[]
  clients: PartnerClient[]
  bill: PartnerBillSummary | null
}

/** `partnerInvitation.view`. `state`: whether the link can be accepted by the signed-in person. */
export type PartnerInvitationView = {
  partnerName: string
  role: PartnerRole
  email: string
  state: 'open' | 'other_email' | 'member'
}

/** One row of Server admin › Partners. */
export type AdminPartner = {
  id: string
  name: string
  status: PartnerStatus
  createdAt: string
  approvedAt: string | null
  owner: { userId: string; name: string; email: string } | null
  /** The owner's invitation while nobody accepted it yet. */
  ownerInvitation: { email: string; expiresAt: string } | null
  members: number
  clients: number
  billingAccountId: string | null
}

/** `partner.adminList`: the partners, and how many client workspaces each may make while billing is off. */
export type AdminPartnerList = { partners: AdminPartner[]; clientLimit: number }
