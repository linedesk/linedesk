// A person's profile picture (packages/actions/src/user-avatar.ts): set and removed through the registry by the
// person themselves, stored in user_avatars as a checked PNG (the install logo's check, branding.ts decodeLogo),
// served at avatarPath(), whose ?v= changes with every new picture so it is cached for good. Triggers copy the
// version into workspace_members (migration 0087), so every member of the person's workspaces gets the new address
// with the next sync; the handlers return the actor's own rows so their tab shows it at once.
import { avatarPath, type UserAvatarData } from '@linedesk/actions'
import { type Db, member, profile_changes, type Tx, user_avatars, workspace_members } from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { isAPIError } from 'better-auth/api'
import { decodeLogo } from './branding.ts'
import { db } from './db.ts'
import type { Actor } from './context.ts'
import { type Handler, Reject } from './handler-context.ts'

/** The person's picture version, null without one. */
export async function avatarVersionOf(db: Db | Tx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ version: user_avatars.version })
    .from(user_avatars)
    .where(eq(user_avatars.user_id, userId))
  return row?.version ?? null
}

/**
 * The picture's bytes for someone who may see it, else null (also without a picture): the person themselves,
 * anyone who shares a workspace with them, and instance admins (Server admin › Users). "No picture" and "not for you"
 * look the same, so the address tells nobody else whether an account exists.
 */
export async function readAvatarFor(
  db: Db,
  userId: string,
  viewer: Pick<Actor, 'actorId' | 'permissions'>,
): Promise<Buffer | null> {
  const [row] = await db.select({ png: user_avatars.png }).from(user_avatars).where(eq(user_avatars.user_id, userId))
  if (!row) return null
  if (viewer.actorId === userId || viewer.permissions.includes('instance:admin')) return Buffer.from(row.png, 'base64')
  const theirs = alias(member, 'theirs')
  const [shared] = await db
    .select({ one: sql`1` })
    .from(member)
    .innerJoin(theirs, and(eq(theirs.organizationId, member.organizationId), eq(theirs.userId, userId)))
    .where(eq(member.userId, viewer.actorId))
    .limit(1)
  return shared ? Buffer.from(row.png, 'base64') : null
}

/** The actor's own member row in the tab's workspace, as the triggers left it: the store shows the change at once. */
async function ownMemberRows(tx: Tx, actor: Actor) {
  if (!actor.workspaceId) return {}
  const rows = await tx
    .select()
    .from(workspace_members)
    .where(and(eq(workspace_members.workspace_id, actor.workspaceId), eq(workspace_members.user_id, actor.actorId)))
  return { workspace_members: rows }
}

/** Only for a person's own session: never the voice agent or an API call without a person. */
function ownAccount(actor: Actor) {
  if (actor.role === 'agent' || actor.actorId === 'agent') throw new Reject('only a person can change their picture')
}

/** Stores a checked PNG as `userId`'s picture; answers with its new address. Throws a Reject for a bad image. */
export async function storeAvatar(tx: Tx, userId: string, avatar: string, now: string): Promise<string> {
  const png = decodeLogo(avatar, 'The picture').toString('base64')
  let version = crypto.randomUUID().slice(0, 8)
  // A new address every time, also when the same short id came up again.
  if (version === (await avatarVersionOf(tx, userId))) version = crypto.randomUUID().slice(0, 8)
  const set = { png, version, updated_at: now }
  await tx.insert(user_avatars).values({ user_id: userId, ...set }).onConflictDoUpdate({ target: user_avatars.user_id, set })
  return avatarPath(userId, version)
}

export const dropAvatar = (tx: Tx, userId: string) => tx.delete(user_avatars).where(eq(user_avatars.user_id, userId))

/** The person changed their own profile: it no longer says an owner or admin changed it last. */
export const clearProfileChange = (db: Db | Tx, userId: string) =>
  db.delete(profile_changes).where(eq(profile_changes.user_id, userId))

/**
 * After Better Auth's /update-user (Account settings › Profile › Name, the person's own session; refused while
 * impersonating): the profile was changed by its owner last. Runs in auth.ts's after-hook.
 */
export async function clearProfileChangeAfterOwnUpdate(ctx: {
  path: string
  context: { returned?: unknown; session?: unknown }
}) {
  if (ctx.path !== '/update-user' || isAPIError(ctx.context.returned)) return
  const userId = (ctx.context.session as { user?: { id?: string } } | null)?.user?.id
  if (userId) await clearProfileChange(db, userId)
}

export const userAvatarHandlers: Record<string, Handler> = {
  'account.setAvatar': async ({ tx, actor, now }, input: { avatar: string }) => {
    ownAccount(actor)
    const avatarUrl = await storeAvatar(tx, actor.actorId, input.avatar, now)
    await clearProfileChange(tx, actor.actorId)
    return { rows: await ownMemberRows(tx, actor), data: { avatarUrl } satisfies UserAvatarData }
  },

  'account.removeAvatar': async ({ tx, actor }) => {
    ownAccount(actor)
    await dropAvatar(tx, actor.actorId)
    await clearProfileChange(tx, actor.actorId)
    return { rows: await ownMemberRows(tx, actor), data: { avatarUrl: null } satisfies UserAvatarData }
  },
}
