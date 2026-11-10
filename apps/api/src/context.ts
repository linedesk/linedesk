// Who is calling: a signed-in member (session cookie) or the voice agent (bearer token).
import { rolePermissions, type Permission, type Role } from '@callfront/actions'
import { member } from '@callfront/db'
import { asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db } from './db.ts'

export interface Actor {
  actorId: string
  role: Role
  /** null only for the agent before it knows which workspace a call belongs to. */
  workspaceId: string | null
  permissions: readonly Permission[]
}

export async function resolveActor(headers: Headers): Promise<Actor | null> {
  const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
  if (bearer) {
    if (!process.env.AGENT_API_TOKEN || bearer !== process.env.AGENT_API_TOKEN) return null
    return { actorId: 'agent', role: 'agent', workspaceId: headers.get('x-workspace-id'), permissions: rolePermissions.agent }
  }
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  // The active workspace, or the member's first one right after sign-in.
  const active = session.session.activeOrganizationId
  const memberships = await db.select().from(member).where(eq(member.userId, session.user.id)).orderBy(asc(member.createdAt))
  const m = memberships.find(x => x.organizationId === active) ?? memberships[0]
  if (!m) return null
  const workspaceId = m.organizationId
  const role = (m.role in rolePermissions ? m.role : 'member') as Role
  return { actorId: session.user.id, role, workspaceId, permissions: rolePermissions[role] }
}
