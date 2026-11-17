// How partner actions say no (partners.ts), apart from it so team.ts and memberships.ts can refuse a partner's
// membership without importing the partner handlers.
import type { PartnerCode } from '@linedesk/actions'
import { member, type Tx } from '@linedesk/db'
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
    'billing is on: client workspaces need the partner bill, which comes with the partner sign-up (LIN-453)',
  partner_managed:
    "this membership comes from the workspace's partner: the partner changes it on its team (docs/white-label.md)",
  partner_suspended: 'this partner is suspended',
  partner_pending: 'client workspaces can be made once a server admin approved the partner',
  client_limit:
    'this partner has as many client workspaces as this server allows; ask a server admin to raise the limit',
}
export const refusePartner = (code: PartnerCode) => new Reject(REFUSALS[code], code)

/** What a caller who may not do it hears (403). */
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const NOT_ON_PARTNER_TEAM = 'you are not on the team of this partner'
// i18n-ignore: API error bodies for logs and API clients; the web app words a 403 itself
export const PARTNER_OWNER_ONLY = "only the partner's owner can do this"
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
