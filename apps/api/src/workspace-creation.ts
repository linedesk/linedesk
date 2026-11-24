// Who creates workspaces (docs/architecture.md, "Workspace rights"): only server admins. They create
// a workspace for a business and pick its owner (Server admin › Workspaces › New workspace, workspace.create in
// workspace-creation-handlers.ts), or their own through the app or the setup MCP. Everyone else joins by invitation
// (there is no open sign-up). Self-serve creation for Linedesk Cloud comes with billing (postponed; no setting until then).
// Read where a workspace is made: POST /v1/workspaces (the app) and the setup MCP's workspace_create. This file stays
// free of handler imports, so app.ts and the setup MCP can load it without handlers.ts.
import { commands, type Tx } from '@linedesk/db'
import { and, count, eq } from 'drizzle-orm'
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

/**
 * WORKSPACE_LIMIT is retired (Q2): only server admins create workspaces, so there is nobody for it to
 * stop until self-serve creation comes with billing. A server that still sets it hears so once at start (server.ts),
 * and nothing changes. The setup link's cap below stays.
 */
export function workspaceLimitRemovedWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (env.WORKSPACE_LIMIT === undefined) return null
  return 'WORKSPACE_LIMIT is no longer read: only server admins create workspaces, and there is no workspace limit until self-serve creation comes with billing. Remove it from the environment.'
}

/** The most workspaces one setup link creates (review of #711): a leaked link cannot fill the install. */
export const SETUP_LINK_WORKSPACE_CAP = 10
export const SETUP_LINK_CAP_TEXT = `This setup link can create up to ${SETUP_LINK_WORKSPACE_CAP} workspaces. Create a new setup link on the setup page to add more, or create them in the app.`

/**
 * How many workspaces this setup link has created: its workspace.create commands that went through (the command log,
 * run-action.ts, marks each with the link). A deleted workspace still counts, so deleting cannot free the link's cap.
 */
export async function workspacesMadeBy(tx: Pick<Tx, 'select'>, keyId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(commands)
    .where(and(eq(commands.setup_key_id, keyId), eq(commands.action, 'workspace.create'), eq(commands.rejected, false)))
  return row?.n ?? 0
}
