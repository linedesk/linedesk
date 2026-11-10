// Who is calling: a signed-in member (session cookie) or the voice agent (bearer token).
import { timingSafeEqual } from 'node:crypto'
import { rolePermissions, type Permission, type Role } from '@callfront/actions'
import { member, organization, user } from '@callfront/db'
import { asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { impersonationEndsAt } from './impersonation-guard.ts'
import { isInstanceAdmin } from './instance-admin.ts'

export interface Actor {
  actorId: string
  role: Role
  /** null for the agent before it knows which workspace a call belongs to, and for an instance admin without a workspace. */
  workspaceId: string | null
  permissions: readonly Permission[]
  /** The workspace is disabled by an instance admin: members keep their read permissions only. */
  workspaceDisabled?: true
  /** An instance admin (`by`) signed in as this user (docs/architecture.md §12). */
  impersonation?: Impersonation
}

export type Impersonation = { by: string; sessionId: string; expiresAt: Date }

/**
 * The impersonation a session stands for, or null when it must not be used any more: past its
 * hour, or the admin who started it is gone, disabled or no longer an instance admin.
 */
async function checkImpersonation(s: { id: string; createdAt: Date; expiresAt: Date; impersonatedBy: string }): Promise<Impersonation | null> {
  const endsAt = impersonationEndsAt(s.createdAt)
  if (endsAt.getTime() <= Date.now()) return null
  const [admin] = await db.select().from(user).where(eq(user.id, s.impersonatedBy))
  if (!admin || admin.disabledAt || !isInstanceAdmin(admin)) return null
  return { by: admin.id, sessionId: s.id, expiresAt: new Date(Math.min(s.expiresAt.getTime(), endsAt.getTime())) }
}

const readOnly = (permissions: readonly Permission[]) => permissions.filter(p => p.endsWith(':read'))

/** Constant-time: the agent token also reads the provider keys. */
function sameToken(given: string, expected: string) {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)]
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function resolveActor(headers: Headers): Promise<Actor | null> {
  const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
  if (bearer) {
    if (!process.env.AGENT_API_TOKEN || !sameToken(bearer, process.env.AGENT_API_TOKEN)) return null
    return { actorId: 'agent', role: 'agent', workspaceId: headers.get('x-workspace-id'), permissions: rolePermissions.agent }
  }
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  const [account] = await db.select().from(user).where(eq(user.id, session.user.id))
  if (!account || account.disabledAt) return null
  const { impersonatedBy } = session.session
  const impersonation = impersonatedBy ? await checkImpersonation({ ...session.session, impersonatedBy }) : undefined
  if (impersonation === null) return null
  // While impersonating: the user's own permissions, never instance:admin, plus ending the impersonation.
  const extraPermissions: Permission[] = impersonation
    ? ['impersonation:stop']
    : isInstanceAdmin(account)
      ? ['instance:admin']
      : []
  const extra = impersonation ? { impersonation } : {}
  // The active workspace, or the member's first one right after sign-in.
  const active = session.session.activeOrganizationId
  const memberships = await db.select().from(member).where(eq(member.userId, session.user.id)).orderBy(asc(member.createdAt))
  const m = memberships.find(x => x.organizationId === active) ?? memberships[0]
  // An instance admin can use the admin area before they belong to a workspace, and an impersonation can be ended; everyone else needs one.
  if (!m) return extraPermissions.length ? { actorId: account.id, role: 'member', workspaceId: null, permissions: extraPermissions, ...extra } : null
  const workspaceId = m.organizationId
  const role = (m.role in rolePermissions ? m.role : 'member') as Role
  const [workspace] = await db.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspaceId))
  if (workspace?.disabledAt) {
    const permissions = [...readOnly(rolePermissions[role]), ...extraPermissions]
    return { actorId: account.id, role, workspaceId, permissions, workspaceDisabled: true, ...extra }
  }
  return { actorId: account.id, role, workspaceId, permissions: [...rolePermissions[role], ...extraPermissions], ...extra }
}
