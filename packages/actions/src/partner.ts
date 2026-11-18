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
  'calls_running',
  'confirm_mismatch',
  'no_partner',
  'already_partner',
  'client_owner',
  'client_not_billed',
  'member_not_invited',
  'same_partner',
  'client_bill_inactive',
  'unpaid_client_limit',
  'activate_first',
] as const
export type PartnerCode = (typeof PARTNER_CODES)[number]

/**
 * Client workspaces a partner may prepare before White-label Cloud is activated (its Checkout, docs/white-label.md):
 * drafts that cost nothing and cannot go live (no number, no calls, no owner invitation) until the plan is paid.
 */
export const UNPAID_PARTNER_CLIENTS = 3

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
/**
 * Of the people the partner's team invited into the workspace (`PartnerClient.invitedByTeam`, `TeamMember.invitedByPartner`),
 * the member ids that leave with the team; none by default (security review of #1113, M-1). Each must be one of them.
 */
const removeMemberIds = z.array(z.string().min(1).max(64)).max(200).default([])

export const partnerReleaseClient = defineAction({
  name: 'partner.releaseClient',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Hand a client workspace over to the client: the partner team leaves it at once (their API keys there are revoked), and where billing is on it moves off the partner bill to a bill of the client's owner, which needs their card before calls are answered again. Only once the client has its owner. People your team invited into the workspace stay unless named in removeMemberIds. Type the workspace's name to confirm. The partner's owner only.",
  input: z.object({ partnerId, workspaceId: z.string().min(1).max(64), confirmName, removeMemberIds }),
  permission: 'partner',
})

export const partnerDeleteClient = defineAction({
  name: 'partner.deleteClient',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Delete a client workspace that has no owner yet (none, or only invited) with all its data: calls, contacts, settings, recordings and phone numbers. Its seat leaves the partner bill. The partner team's accounts stay; people your team invited lose their accounts when they belong to no other workspace. Once the client's owner joined, hand the workspace over instead. Type the workspace's name to confirm. The partner's owner only.",
  input: z.object({ partnerId, workspaceId: z.string().min(1).max(64), confirmName }),
  permission: 'partner',
})

export const workspaceRemovePartner = defineAction({
  name: 'workspace.removePartner',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove this workspace's white-label partner: every member of the partner team leaves it at once (their API keys here are revoked), and where billing is on the workspace moves off the partner's bill to a bill of yours, which needs your card before calls are answered again. People the partner's team invited here stay unless named in removeMemberIds. Type the workspace's name to confirm. The workspace's owner only.",
  input: z.object({ confirmName, removeMemberIds }),
  permission: 'workspace:own',
})

// --- Partner › Clients (slice S3) ---------------------------------------------------------------------------------

/** The most a client's monthly usage limit can be, in USD: a typo should not lift it to nothing. */
export const CLIENT_USAGE_LIMIT_MAX_USD = 100_000
/** The least: one dollar (organization_usage_limit in the database). */
export const CLIENT_USAGE_LIMIT_MIN_USD = 1

export const partnerListClients = defineAction({
  name: 'partner.listClients',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The partner's client workspaces with how each is doing this billing period: owner, number, forwarding, last real call, calls, minutes and cost (from the bill's ledger), the share of its monthly usage limit, and its problems. Problems first. Never call content. Refused for a partner you are not on the team of.",
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerSetClientUsageLimit = defineAction({
  name: 'partner.setClientUsageLimit',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Set a client workspace's monthly usage limit in USD on the partner bill (null: no limit). At 80 % and 100 % the partner team gets an email; at the limit new calls are not answered (the caller hears the business will call back, the call is filed as missed) until the next billing period. Running calls are never cut. Only for a client on the partner bill. The partner's owner sets any value; an admin of the team may only lower it or set one where there is none.",
  input: z.object({
    partnerId,
    workspaceId: z.string().min(1).max(64),
    limitUsd: z.number().min(CLIENT_USAGE_LIMIT_MIN_USD).max(CLIENT_USAGE_LIMIT_MAX_USD).nullable(),
  }),
  permission: 'partner',
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

export const partnerAdminMoveClient = defineAction({
  name: 'partner.adminMoveClient',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Move a workspace to another partner, add a workspace to a partner, or take it from its partner (toPartnerId null). The old partner's team leaves it at once and the new partner's team becomes an admin of it; the owner, data, numbers and calls stay. Where billing is on, the workspace goes on the new partner's bill (its seat moves, prorated as docs/billing.md §6) or, taken from its partner, on a new bill of its owner that waits for their card; that needs an instance admin signed in with their passkey. Refused while calls run, for a bill that is past due or suspended, for a partner that is suspended or cannot take more clients, and for a workspace without an owner taken from its partner. Type the workspace's name to confirm. Instance admins only.",
  input: z.object({
    workspaceId: z.string().min(1).max(64),
    toPartnerId: partnerId.nullable(),
    confirmName,
    reason: z.string().trim().min(3).max(500),
  }),
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
  /**
   * The partner owner only: who of them the partner team invited. The hand-over lists them to pick who leaves with
   * the team, none by default (security reviews of #1109, L-4, and #1113, M-1); empty for the admins.
   */
  invitedByTeam: PartnerInvitedMember[]
}

/** Someone the partner team invited into a client workspace (`partner-invited.ts` in the API). */
export type PartnerInvitedMember = { memberId: string; name: string; email: string }

/**
 * The partner bill as the partner area shows it (the bill's own page is Partner › Billing, `billing.overview` with the
 * partnerId): null where billing is off or the partner has no bill (made by a server admin on an install without it).
 */
export type PartnerBillSummary = {
  status: 'pending_payment' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'comped'
  /** Whether the person asking owns the bill (the partner's owner): they open its page. */
  mine: boolean
  /**
   * What White-label Cloud costs at the bill's interval, a month in cents before tax: its base fee and each client
   * workspace's seat ("Activate White-label Cloud" shows it while the bill waits for its Checkout).
   */
  price: { interval: 'month' | 'year'; planCents: number; seatCents: number }
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
  /** The partner bill's status (Server admin › Partners shows it); null without a bill. */
  billStatus: PartnerBillSummary['status'] | null
}

/** `partner.adminList`: the partners, and how many client workspaces each may make while billing is off. */
export type AdminPartnerList = { partners: AdminPartner[]; clientLimit: number }

/**
 * What can be wrong with a client workspace (Partner › Clients), worst first: the bill does not run, the workspace is
 * disabled, the usage limit is reached or near, no number yet, the forwarding check failed or never ran, a provider
 * failed on one of its calls in the last 7 days.
 */
export const CLIENT_PROBLEMS = [
  'bill_inactive',
  'disabled',
  'limit_reached',
  'limit_near',
  'no_number',
  'forwarding_failed',
  'forwarding_unverified',
  'provider_errors',
] as const
export type ClientProblem = (typeof CLIENT_PROBLEMS)[number]

/** One row of Partner › Clients (`partner.listClients`): aggregates only, never call content. */
export type PartnerClientRow = {
  id: string
  name: string
  /** The client's own owner: joined (`accepted`), invited, or none yet. */
  owner: { state: 'accepted'; name: string; email: string } | { state: 'invited'; email: string } | null
  /** The first of its numbers (E.164), and how many it has. */
  number: string | null
  numbers: number
  /** Whether calls reach the number: forwarding checked and working, not needed (a new or ported number), or not yet. */
  forwarding: 'verified' | 'not_needed' | 'unverified' | null
  /** The last call from a real caller (not a test, sample, spam or the owner's own phone). */
  lastRealCallAt: string | null
  /** Real callers' calls this period. */
  calls: number
  /** Seconds billed this period, from the ledger's usage entries. */
  seconds: number
  /** What the client used this period from the partner bill, in US cents (the ledger's usage, numbers and adjustments). Null where billing is off. */
  costCents: number | null
  /** The monthly usage limit in US cents (null: none), and the cost as a share of it (0..100+, null without a limit). */
  limitCents: number | null
  limitPercent: number | null
  /** On the partner bill: the limit applies only there. */
  billed: boolean
  problems: ClientProblem[]
}

/** `partner.listClients`. `period`: the partner bill's current period, else the UTC month (billing off). */
export type PartnerClientList = {
  period: { startsAt: string; endsAt: string } | null
  clients: PartnerClientRow[]
}
