// Who is calling: a signed-in member (session cookie) or the voice agent (bearer token).
import { timingSafeEqual } from 'node:crypto'
import { rolePermissions, type Permission, type Role } from '@callfront/actions'
import { member, organization, user } from '@callfront/db'
import { asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'

export interface Actor {
  actorId: string
  role: Role
  /** null for the agent before it knows which workspace a call belongs to, and for an instance admin without a workspace. */
  workspaceId: string | null
  permissions: readonly Permission[]
  /** The workspace is disabled by an instance admin: members keep their read permissions only. */
  workspaceDisabled?: true
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
  const adminPermission: Permission[] = isInstanceAdmin(account) ? ['instance:admin'] : []
  // The active workspace, or the member's first one right after sign-in.
  const active = session.session.activeOrganizationId
  const memberships = await db.select().from(member).where(eq(member.userId, session.user.id)).orderBy(asc(member.createdAt))
  const m = memberships.find(x => x.organizationId === active) ?? memberships[0]
  // An instance admin can use the admin area before they belong to a workspace; everyone else needs one.
  if (!m) return adminPermission.length ? { actorId: account.id, role: 'member', workspaceId: null, permissions: adminPermission } : null
  const workspaceId = m.organizationId
  const role = (m.role in rolePermissions ? m.role : 'member') as Role
  const [workspace] = await db.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspaceId))
  if (workspace?.disabledAt) {
    const permissions = [...readOnly(rolePermissions[role]), ...adminPermission]
    return { actorId: account.id, role, workspaceId, permissions, workspaceDisabled: true }
  }
  return { actorId: account.id, role, workspaceId, permissions: [...rolePermissions[role], ...adminPermission] }
}
