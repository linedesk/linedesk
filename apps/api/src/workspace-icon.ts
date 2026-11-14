// The workspace icon (packages/actions/src/workspace-icon.ts): set and removed through the registry, stored in
// workspace_icons as a checked PNG (the install logo's check, branding.ts decodeLogo), served to members of the
// workspace at iconPath(), whose ?v= changes with every new icon so it is cached for good. The workspace lists of
// /v1/me carry the address (iconUrlOf), so the menu needs no request of its own.
import type { WorkspaceIconData } from '@linedesk/actions'
import { type Db, member, type Tx, workspace_icons } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { decodeLogo } from './branding.ts'
import { type Handler, Reject } from './handler-context.ts'

export const iconPath = (workspaceId: string, version: string) =>
  `/v1/workspace-icons/${encodeURIComponent(workspaceId)}.png?v=${encodeURIComponent(version)}`

/** The icon's address from a row's version (null: no icon). */
export const iconUrlOf = (workspaceId: string, version: string | null | undefined) =>
  version ? iconPath(workspaceId, version) : null

/**
 * The icon's bytes for someone who is a member of that workspace, else null (also without an icon): another
 * workspace's icon is not shown to people outside it, and "no icon" and "not yours" look the same.
 */
export async function readIconFor(db: Db, workspaceId: string, userId: string): Promise<Buffer | null> {
  const [row] = await db
    .select({ png: workspace_icons.png })
    .from(workspace_icons)
    .innerJoin(member, and(eq(member.organizationId, workspace_icons.workspace_id), eq(member.userId, userId)))
    .where(eq(workspace_icons.workspace_id, workspaceId))
  return row ? Buffer.from(row.png, 'base64') : null
}

async function iconVersion(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ version: workspace_icons.version })
    .from(workspace_icons)
    .where(eq(workspace_icons.workspace_id, workspaceId))
  return row?.version ?? null
}

export const workspaceIconHandlers: Record<string, Handler> = {
  'workspace.setIcon': async ({ tx, actor, now }, input: { icon: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const png = decodeLogo(input.icon, 'The icon').toString('base64')
    let version = crypto.randomUUID().slice(0, 8)
    // A new address every time, also when the same short id came up again.
    if (version === (await iconVersion(tx, actor.workspaceId))) version = crypto.randomUUID().slice(0, 8)
    const set = { png, version, updated_at: now, updated_by: actor.actorId }
    await tx
      .insert(workspace_icons)
      .values({ workspace_id: actor.workspaceId, ...set })
      .onConflictDoUpdate({ target: workspace_icons.workspace_id, set })
    return { rows: {}, data: { iconUrl: iconPath(actor.workspaceId, version) } satisfies WorkspaceIconData }
  },

  'workspace.removeIcon': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    await tx.delete(workspace_icons).where(eq(workspace_icons.workspace_id, actor.workspaceId))
    return { rows: {}, data: { iconUrl: null } satisfies WorkspaceIconData }
  },
}
