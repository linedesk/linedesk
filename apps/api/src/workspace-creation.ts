// Who creates workspaces (Janik, 2026-11-15; docs/architecture.md, "Workspace rights"): only server admins. They create
// a workspace for a business and pick its owner (Server admin › Workspaces › New workspace, workspace.create in
// workspace-creation-handlers.ts), or their own through the app or the setup MCP. Everyone else joins by invitation
// (there is no open sign-up). Self-serve creation for Linedesk Cloud comes with billing (postponed; no setting until then).
// Read where a workspace is made: POST /v1/workspaces (the app) and the setup MCP's workspace_create. This file stays
// free of handler imports, so app.ts and the setup MCP can load it without handlers.ts.
import { adminPasskeyRefusal } from './admin-second-factor.ts'
import type { Actor } from './context.ts'

/**
 * Whether this caller may create a workspace: one that holds instance:admin in this session, which context.ts grants
 * an instance admin only after the admin sign-in check (admin-second-factor.ts), never while impersonating and never to
 * an API key; and a setup key's admin (agent-setup.ts). Not the account's admin flag alone: a session that has not
 * passed the check cannot create workspaces either (#728 security review, finding 4). The passkey check must still
 * hold: a setup key carries its maker's only while `passkey_confirmed_until` lies ahead (#734 security review, finding 8).
 */
export const mayCreateWorkspace = (
  actor: Pick<Actor, 'permissions' | 'passkeyConfirmed' | 'adminSecondFactor'>,
): boolean => actor.permissions.includes('instance:admin') && !adminPasskeyRefusal(actor, 'instance:admin')

export const WORKSPACE_CREATION_CLOSED =
  'New workspaces are created by a server admin on this server. Ask yours to add you to a workspace.'

/** A server admin whose session lacks the admin sign-in check (context.ts `adminSecondFactor`). */
export const ADMIN_CHECK_FIRST =
  'Confirm it is you first: open Server admin and finish the sign-in check there, then create the workspace.'
