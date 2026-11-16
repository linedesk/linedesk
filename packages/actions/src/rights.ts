// Workspace rights (Janik, 2026-11-15; docs/architecture.md, "Workspace rights"): who in a workspace may run an
// action, derived from its permission. Owner: everything an admin can, plus deleting the workspace and handing it
// over (workspace:own; exactly one owner). Admin: every workspace setting and the team except the owner. Member: daily
// work (inbox, calls, contacts, reminders, their own profile and notifications), no workspace settings.
import { type Permission, type Role, rolePermissions } from './define.ts'

/**
 * Who may run an action: the lowest workspace role whose permissions include it, or what else grants it: `agent`
 * (the voice agent's token), `server-admin` (instance:admin, a property of the user), `impersonation` (a session an
 * instance admin started as someone else), `account` (every signed-in person, also without a workspace), `system` (the
 * API's own billing jobs, never a person).
 */
export type Right = 'member' | 'admin' | 'owner' | 'agent' | 'server-admin' | 'impersonation' | 'account' | 'system'

const workspaceRoles = ['member', 'admin', 'owner'] as const satisfies readonly Role[]

export function rightOf(permission: Permission): Right {
  if (permission === 'agent') return 'agent'
  if (permission === 'instance:admin') return 'server-admin'
  // Ending setup links. Of signed-in sessions only instance admins hold it (context.ts), so the rights table files it
  // under server admin. Setup keys hold it too, install and workspace keys alike (agent-setup.ts), for one action
  // only: the agent ending the very link it uses (agentSetup.endOwnAccess). A workspace owner
  // or an admin ends their own link with agentSetup.revokeWorkspace (settings:write) instead.
  if (permission === 'setupLink:end') return 'server-admin'
  // An instance admin's own authenticator app (authenticator.ts): also only instance admins (context.ts).
  if (permission === 'secondFactor:own') return 'server-admin'
  if (permission === 'impersonation:stop') return 'impersonation'
  // Answering invitations needs no workspace (context.ts gives it to the workspace-less too, through invitee checks).
  if (permission === 'invitation:respond') return 'account'
  // The Stripe webhook's processor and the billing jobs: nobody signed in holds it (docs/billing.md §8).
  if (permission === 'billing:system') return 'system'
  const role = workspaceRoles.find(r => rolePermissions[r].includes(permission))
  if (!role) throw new Error(`no role has ${permission}`)
  return role
}

/** Whether `role` may run something that needs `right` (owner ⊃ admin ⊃ member). */
export function roleMeets(role: (typeof workspaceRoles)[number], right: Right): boolean {
  const rank = workspaceRoles.indexOf(role)
  const needed = workspaceRoles.indexOf(right as (typeof workspaceRoles)[number])
  return needed !== -1 && rank >= needed
}

export const WORKSPACE_ROLES = workspaceRoles
