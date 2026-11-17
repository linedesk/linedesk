# White-label partners

Agencies and IT providers run Linedesk workspaces for their clients in the shared install (Janik, 2026-11-17, LIN-322: variant A, built before go-live). This page describes what is built; slices still to come are listed at the end.

## Model

- A **partner** is its own row (`partners`), not a workspace: name, status (`pending`, `approved`, `suspended`), and later its bill (`billing_account_id`, S2).
- Its **team** is `partner_members`: exactly one `owner` and any number of `admin`s. People join by an email invitation (`partner_invitations`, 7 days, only the sha256 of the link's token is stored). The first owner is invited by an instance admin when the partner is created.
- **Client workspaces** are normal workspaces with `organization.partner_id`. Every team member is a real `admin` member of every client workspace, marked with `member.partner_id`. So every existing tenancy check, read-sync shape and permission works unchanged for them.
- `syncPartnerMemberships` (`apps/api/src/partners.ts`) keeps those memberships equal to "every team member in every client workspace", none while the partner is suspended. It runs in the transaction of each change (join, removal, new client, suspend, approve). A membership that goes is removed like any removed member's (`forgetMember`: API keys revoked, setup links ended), and the workspace invitations that person sent there are canceled. A team member who is in a client workspace on their own keeps that membership untouched.
- Removing someone from the team does not undo what they set up in a client workspace (webhooks, call-email recipients, connected calendars): the partner owner checks that when they remove someone, as for any removed workspace admin.

## Permissions

- The `partner` permission is no role's. A **session** gets it when the person is on a partner team, or holds an open invitation to one (so a new account can open the link). Never while impersonated, never with an API key, a personal key, a setup link or the agent.
- Every partner action names its partner. The handler checks that the caller is on that partner's team; anyone else gets 403 (the same answer whether the partner exists or not). Owner-only: rename, invite, withdraw an invitation, remove a member. A suspended partner changes nothing.
- A membership that comes from a partner is changed only on the partner: `team.setRole`, `team.removeMember`, `team.transferOwnership`, `team.leave` and Server admin's `membership.setRole` / `membership.remove` refuse it (`partner_managed`). The database allows a partner membership only as `admin` (`member_partner_admin`).
- Server admin › Partners (`partner.adminList`, `partner.create`, `partner.approve`, `partner.suspend`, `instance:admin`) lists, creates, approves and suspends partners. Suspension removes the team from every client workspace at once; approval brings them back.
- Until a client workspace has an owner of its own (S2), nobody in it through a partner makes anyone admin there, by invitation or role change (`partner_admin_grant`): an admin added that way could be a second account of their own that keeps the workspace after they leave the team. The client's staff join as members.
- An account on a partner team is never deleted with a workspace or a removal (`membersOnlyHere`, `deleteAccountWithoutWorkspace`): the partner area is its place without a workspace.
- Every partner write is in the audit log under the kind "Partners".
- Known gap (security review of #1100, L-1): the `partner` permission also goes to a session whose address holds an open invitation, so such a person (no workspace yet) is an actor with `partner` and `account:own`. They reach no workspace data and no other partner (every partner action checks the team); only their own invitation and their own account settings.

## Screens

- **Partner area** (`#partner`): client workspaces (list, open, create) and the team (owner: invite, withdraw, remove). A partner member without any workspace lands there. The workspace menu has "Partner: <name>".
- **Invitation page** (`#partner-invite=<token>`): after sign-in (a new address gets its account with an email code; the invitation lets it in, `signup-gate.ts`, and keeps it, `joinOrUndo`), Join. An account made for an invitation that ends unused goes with the sign-up sweep.
- **Server admin › Partners**.

## Billing seam

Client workspaces go on the partner bill in S2 (LIN-453). Until then `workspace.createForClient` is refused with `client_needs_bill` where billing is on, so no client workspace runs unbilled on Linedesk Cloud. On an install without billing (self-host, dev, staging without Stripe) it works without a bill, up to a limit of client workspaces per partner (25 by default; Server admin › Partners, `partner.setClientLimit`). A pending partner sets up its team; client workspaces come once it is approved.

## Not built yet

- S2 (LIN-453): sign-up with `?plan=partner` making the partner with its bill, client workspaces as seats on the partner subscription, trial limit, owner invite for a client, `workspace.removePartner`, `partner.releaseClient`, the "Partner" badge on the client's Team page.
- S3 (LIN-454): client list with usage and health, per-client limits.
- S4 (LIN-455): the partner's brand in the app and in emails.
- S5 to S7: own domain, own sender domain, own provider keys.
