// How partner actions say no (partners.ts), apart from it so team.ts and memberships.ts can refuse a partner's
// membership without importing the partner handlers.
import { type PartnerCode, UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import { member, partner_members, type Tx } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { Reject } from './handler-context.ts'

/**
 * A refusal with its code: the web app shows the code's key (PARTNER_CODES, team.partner.error.*); the English stays
 * in the API body for logs and API clients.
 */
// i18n-ignore: API error bodies for logs and API clients; the web app shows the key of the code
const REFUSALS: Record<PartnerCode, string> = {
  not_found: 'partner not found',
  already_member: 'this address is on the partner team already',
  already_invited: 'this address is invited already; withdraw the invitation to send a new one',
  invitation_invalid: 'this invitation link is not valid any more; ask for a new one',
  invitation_other_email: 'this invitation is for another email address: sign in with that address',
  email_unverified: 'confirm your email address first',
  owner_taken: 'this partner has an owner already',
  owner_stays: "the partner's owner cannot be removed from the team",
  member_not_found: 'not on the partner team',
  no_email: 'email is not set up, so invitations cannot be sent (connect it in Server admin › Providers › Email)',
  send_failed: 'could not send the invitation email; try again in a moment',
  invite_limit: 'too many invitations in the last hour; try again later',
  client_needs_bill:
    'billing is on: client workspaces need the partner bill, which comes with the partner sign-up (?plan=partner); this partner has none',
  partner_managed:
    "this membership comes from the workspace's partner: the partner changes it on its team (docs/white-label.md)",
  partner_suspended: 'this partner is suspended',
  partner_pending: 'client workspaces can be made once a server admin approved the partner',
  client_limit:
    'this partner has as many client workspaces as this server allows; ask a server admin to raise the limit',
  client_not_found: 'no client workspace of this partner with this id',
  client_has_owner: 'this client workspace has an owner already',
  owner_on_team: "someone on the partner team cannot be a client's owner: invite the client's own person",
  client_no_owner: 'the client has no owner yet: invite its owner first, then hand the workspace over',
  bill_not_started: 'add a card for the partner plan first (Partner › Billing)',
  bill_inactive: 'the partner bill is not running: pay the open invoice or start the plan again',
  calls_running: 'calls are running in this workspace: try again once they ended',
  confirm_mismatch: "type the workspace's name exactly to confirm",
  no_partner: 'this workspace has no partner',
  already_partner: 'this account owns a partner already: open the partner area',
  client_owner: "the owner of one of this partner's client workspaces cannot join its team",
  client_not_billed: 'this client workspace is not on the partner bill: a usage limit applies only there',
  member_not_invited:
    "one of the people to remove is not someone the partner's team invited into this workspace, or is or was its owner",
  same_partner: 'the workspace is with this partner already',
  client_bill_inactive:
    "the workspace's bill is past due or suspended: it changes partner once the bill is paid or resumed",
  unpaid_client_limit: `before White-label Cloud is activated a partner prepares at most ${UNPAID_PARTNER_CLIENTS} client workspaces: activate it to add more`,
  activate_first:
    'activate White-label Cloud first (its Checkout): invitations, numbers and calls start once it is paid',
}
export const refusePartner = (code: PartnerCode) => new Reject(REFUSALS[code], code)

/** A partner bill is the partner owner's (docs/white-label.md): it changes hands only with the partner. */
// i18n-ignore: API error bodies for logs, API clients and Server admin; the web app words its own refusals
export const PARTNER_BILL_STAYS = "a partner bill belongs to the partner's owner and is not handed over"
/** A client workspace stays on its partner's bill, and a partner bill pays only for its clients. */
// i18n-ignore: API error bodies for logs, API clients and Server admin; the web app words its own refusals
export const CLIENT_STAYS_ON_PARTNER_BILL =
  "client workspaces are always on their partner's bill, and a partner bill pays only for its clients: the partner releases a client, or its owner removes the partner"

/** What a caller who may not do it hears (403). */
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const NOT_ON_PARTNER_TEAM = 'you are not on the team of this partner'
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const PARTNER_OWNER_ONLY = "only the partner's owner can do this"
/** A client's usage limit raised or removed (security review of #1113, L-1). */
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const LIMIT_OWNER_ONLY =
  "only the partner's owner can raise or remove a client's usage limit; an admin may lower it or set one"
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const PARTNER_SUSPENDED = 'this partner is suspended: nothing can be changed until it is approved again'

/**
 * A membership that comes from a partner team is changed only with the team (docs/white-label.md): never made owner,
 * given another role, removed or left on its own in the workspace. team.ts and memberships.ts call this first.
 */
export function refusePartnerMembership(target: { partnerId: string | null }) {
  if (target.partnerId) throw refusePartner('partner_managed')
}

/**
 * Someone in a client workspace through a partner gives nobody admin there, by invitation or role change, until the
 * client has an owner of its own (S2, LIN-453): an admin they add could otherwise be a second account of their own and
 * keep the workspace after they leave the partner team, while nobody outside the team sees its member list (security
 * review of #1100, M-2). The client's staff join as members.
 */
export async function refuseAdminFromPartner(tx: Tx, workspaceId: string, actorId: string, role: string) {
  if (role !== 'admin') return
  const [mine] = await tx
    .select({ partnerId: member.partnerId })
    .from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.userId, actorId)))
  if (mine?.partnerId) throw Reject.t('server.api.partner.noAdminFromPartner', undefined, 'partner_admin_grant')
}

/** Premium or Ultra in a white-label client: its partner's owner decides, never the client's own people (LIN-440). */
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const PARTNER_DECIDES_LEVELS = "the partner's owner picks Premium or Ultra for this workspace"

/** Whether the person is the owner of the partner `partnerId`. */
export async function isPartnerOwner(tx: Pick<Tx, 'select'>, partnerId: string, userId: string) {
  const [row] = await tx
    .select({ role: partner_members.role })
    .from(partner_members)
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.user_id, userId)))
  return row?.role === 'owner'
}
