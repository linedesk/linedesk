// Editing a teammate (packages/actions/src/team.ts, Workspace settings › Team › Edit): owners and admins change a
// member's name and picture (both belong to the account, so they change in every workspace the person is in) and the
// member's own notification settings in this workspace. Never anything that signs in: email, password, passkeys,
// sign-in methods, sessions and API keys are Better Auth's and stay with the person (no handler here touches them).
//
// Rules, checked here on every call (the registry has already checked team:write):
// - the target is a member of the caller's workspace (a member id of another workspace is "not found");
// - only an owner edits an owner (read from the locked member rows, as team.setRole does);
// - name and picture belong to the account, so they change only when the caller manages the team in every workspace
//   the member is in (owner or admin there, owner wherever the member is an owner, the workspace not disabled);
//   otherwise only the member changes them. Their notifications in this workspace stay editable;
// - a teammate's push summary (what a call was about, on a lock screen) can only be turned off (the action's input);
// - only a person's own session: no change while an instance admin is signed in as someone (run-action refuses that
//   centrally too; reading is allowed, as every read is), not the voice agent, not an AI agent with a setup key.
// Every change is a command, so the audit log has who, whom (`data.subject`), which fields (the input; a picture
// is redacted) and the value before (`data.previous`: the old name, the old picture's version). profile_changes keeps
// what the profile was before others first changed it (old picture included), so it can be put back. The member's own
// pages say "Last changed by <name>" (profile_changes, member_notification_settings.updated_by).
import type { MemberEditData, TeamMember } from '@linedesk/actions'
import { avatarUrlOf, cleanPersonName } from '@linedesk/actions'
import {
  type Db,
  member,
  organization,
  type ProfileBefore,
  profile_changes,
  type Tx,
  user,
  user_avatars,
  workspace_members,
} from '@linedesk/db'
import { and, eq, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { memberSubject } from './audit.ts'
import type { Actor } from './context.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { loadSettingsOf, type OwnInput, settingsChanges, writeSettings } from './notification-settings.ts'
import { dropAvatar, storeAvatar } from './user-avatar.ts'

export const ONLY_OWNER_EDITS_OWNER = "only an owner can change an owner's profile or settings"
export const PROFILE_ELSEWHERE =
  'they are also in a workspace whose team you do not manage, so only they can change their name and picture'
/** Who changed a profile last, when it was someone from another workspace than the one asking. */
export const OTHER_WORKSPACE_ADMIN = 'an admin of another workspace'

type Target = typeof member.$inferSelect

/**
 * The member `memberId` of the caller's workspace, if the caller may edit them; locked for the rest of the
 * transaction (`lock`, every change), so a role change made meanwhile cannot slip past the owner rule.
 */
async function editableMember(tx: Tx, actor: Actor, memberId: string, lock: boolean): Promise<Target> {
  // Reading is what an impersonation is for (seeing Linedesk as the user does); changing is refused (run-action too).
  if (actor.impersonation && lock) throw new Forbidden(NOT_WHILE_IMPERSONATING)
  if (actor.role === 'agent' || actor.setupKeyId || actor.apiKeyId || !actor.sessionId)
    throw new Forbidden('only a signed-in owner or admin can change a teammate')
  if (!actor.workspaceId) throw new Reject('no workspace')
  const where = and(eq(member.id, memberId), eq(member.organizationId, actor.workspaceId))
  const [target] = lock
    ? await tx.select().from(member).where(where).for('update')
    : await tx.select().from(member).where(where)
  if (!target) throw new Reject('member not found')
  if (target.role === 'owner' && target.userId !== actor.actorId) {
    const meWhere = and(eq(member.organizationId, actor.workspaceId), eq(member.userId, actor.actorId))
    const [me] = lock
      ? await tx.select().from(member).where(meWhere).for('update')
      : await tx.select().from(member).where(meWhere)
    if (me?.role !== 'owner') throw new Forbidden(ONLY_OWNER_EDITS_OWNER)
  }
  return target
}

/**
 * Whether the caller may change the target's name and picture: the caller manages the team in every workspace the
 * target is in (owner or admin; owner where the target is an owner; the workspace not disabled). Locked with the
 * changes (`lock`), so a role change elsewhere meanwhile cannot slip past.
 */
async function profileEditable(tx: Tx, actor: Actor, target: Target, lock: boolean): Promise<boolean> {
  if (target.userId === actor.actorId) return true
  const theirs = alias(member, 'theirs')
  const query = tx
    .select({ role: theirs.role, mine: member.role, disabledAt: organization.disabledAt })
    .from(theirs)
    .innerJoin(organization, eq(organization.id, theirs.organizationId))
    .leftJoin(member, and(eq(member.organizationId, theirs.organizationId), eq(member.userId, actor.actorId)))
    .where(eq(theirs.userId, target.userId))
  const rows = lock ? await query.for('update', { of: [theirs] }) : await query
  return rows.every(r => !r.disabledAt && (r.mine === 'owner' || (r.mine === 'admin' && r.role !== 'owner')))
}

async function requireProfileEditable(tx: Tx, actor: Actor, target: Target) {
  if (!(await profileEditable(tx, actor, target, true))) throw new Forbidden(PROFILE_ELSEWHERE)
}

/**
 * Notes that someone other than the person changed their profile; their Account › Profile says so. `previous`: what
 * this change replaced; the first value before others changed it is kept, so the person's own can be put back.
 */
async function noteProfileChange(tx: Tx, actor: Actor, target: Target, now: string, previous: ProfileBefore) {
  if (target.userId === actor.actorId) {
    await tx.delete(profile_changes).where(eq(profile_changes.user_id, target.userId))
    return
  }
  const set = { changed_by: actor.actorId, workspace_id: target.organizationId, changed_at: now }
  await tx
    .insert(profile_changes)
    .values({ user_id: target.userId, ...set, previous })
    .onConflictDoUpdate({
      target: profile_changes.user_id,
      // jsonb ||: the right side wins, so values already kept stay.
      set: { ...set, previous: sql`excluded.previous || ${profile_changes.previous}` },
    })
}

/**
 * The last change to `userId`'s profile by someone else; null when there is none. The changer's name only when the
 * change came from `workspaceId` (the workspace asking); else "an admin of another workspace".
 */
export async function profileChangedBy(
  tx: Db | Tx,
  userId: string,
  workspaceId: string | null,
): Promise<MemberEditData['profileChangedBy']> {
  const [row] = await tx
    .select({ at: profile_changes.changed_at, from: profile_changes.workspace_id, name: user.name })
    .from(profile_changes)
    .leftJoin(user, eq(user.id, profile_changes.changed_by))
    .where(eq(profile_changes.user_id, userId))
  if (!row) return null
  const name = row.from === workspaceId ? row.name?.trim() || 'A teammate' : OTHER_WORKSPACE_ADMIN
  return { name, at: new Date(row.at).toISOString() }
}

/** The person's picture now, for `previous`: null without one. */
async function currentAvatar(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ version: user_avatars.version, png: user_avatars.png })
    .from(user_avatars)
    .where(eq(user_avatars.user_id, userId))
  return row ?? null
}

/** The target's synced member row in this workspace, as the triggers left it: the caller's store shows the change at once. */
const memberRows = async (tx: Tx, target: Target) => ({
  workspace_members: await tx.select().from(workspace_members).where(eq(workspace_members.id, target.id)),
})

/** What the audit log keeps: whom the change was about. */
const result = async (tx: Tx, target: Target) => ({
  subject: await memberSubject(tx, target.userId, target.organizationId),
})

async function editData(tx: Tx, actor: Actor, target: Target): Promise<MemberEditData> {
  const [row] = await tx
    .select({ name: user.name, email: user.email, avatarVersion: user_avatars.version })
    .from(user)
    .leftJoin(user_avatars, eq(user_avatars.user_id, user.id))
    .where(eq(user.id, target.userId))
  const teamMember: TeamMember = {
    memberId: target.id,
    userId: target.userId,
    name: row?.name ?? '',
    email: row?.email ?? '',
    role: target.role as TeamMember['role'],
    joinedAt: target.createdAt.toISOString(),
    avatarUrl: avatarUrlOf(target.userId, row?.avatarVersion),
  }
  const [elsewhere] = await tx
    .select({ one: sql`1` })
    .from(member)
    .where(and(eq(member.userId, target.userId), ne(member.organizationId, target.organizationId)))
    .limit(1)
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(workspace_members)
    .where(and(eq(workspace_members.workspace_id, target.organizationId), eq(workspace_members.disabled, false)))
  const notifications = await loadSettingsOf(
    tx,
    { workspaceId: target.organizationId, userId: target.userId, role: target.role },
    false,
  )
  return {
    member: teamMember,
    profileEditable: await profileEditable(tx, actor, target, false),
    inOtherWorkspaces: !!elsewhere,
    // Their push devices are counted, never named: which browsers get pushes is theirs to know.
    notifications: {
      ...notifications,
      push: { ...notifications.push, publicKey: null, devices: notifications.push.devices.map((_, i) => String(i)) },
    },
    canAssign: count > 1,
    profileChangedBy:
      target.userId === actor.actorId ? null : await profileChangedBy(tx, target.userId, target.organizationId),
  }
}

export const teamMemberEditHandlers: Record<string, Handler> = {
  'team.getMember': async ({ tx, actor }, input: { memberId: string }) => {
    const target = await editableMember(tx, actor, input.memberId, false)
    return { rows: {}, data: await editData(tx, actor, target) }
  },

  'team.updateMemberProfile': async ({ tx, actor, now }, input: { memberId: string; name: string }) => {
    const target = await editableMember(tx, actor, input.memberId, true)
    await requireProfileEditable(tx, actor, target)
    const [before] = await tx.select({ name: user.name }).from(user).where(eq(user.id, target.userId))
    const previous = { name: before?.name ?? '' }
    // Better Auth's own column; the triggers carry it into workspace_members of every workspace the person is in.
    await tx
      .update(user)
      .set({ name: input.name, updatedAt: new Date(now) })
      .where(eq(user.id, target.userId))
    await noteProfileChange(tx, actor, target, now, previous)
    return { rows: await memberRows(tx, target), data: { ...(await result(tx, target)), previous } }
  },

  'team.setMemberAvatar': async ({ tx, actor, now }, input: { memberId: string; avatar: string }) => {
    const target = await editableMember(tx, actor, input.memberId, true)
    await requireProfileEditable(tx, actor, target)
    const before = await currentAvatar(tx, target.userId)
    const avatarUrl = await storeAvatar(tx, target.userId, input.avatar, now)
    await noteProfileChange(tx, actor, target, now, { avatar: before })
    const previous = { avatarVersion: before?.version ?? null }
    return { rows: await memberRows(tx, target), data: { avatarUrl, ...(await result(tx, target)), previous } }
  },

  'team.removeMemberAvatar': async ({ tx, actor, now }, input: { memberId: string }) => {
    const target = await editableMember(tx, actor, input.memberId, true)
    await requireProfileEditable(tx, actor, target)
    const before = await currentAvatar(tx, target.userId)
    await dropAvatar(tx, target.userId)
    await noteProfileChange(tx, actor, target, now, { avatar: before })
    const previous = { avatarVersion: before?.version ?? null }
    return { rows: await memberRows(tx, target), data: { avatarUrl: null, ...(await result(tx, target)), previous } }
  },

  'team.updateMemberNotifications': async (
    { tx, actor, now },
    { memberId, ...input }: OwnInput & { memberId: string },
  ) => {
    const target = await editableMember(tx, actor, memberId, true)
    const of = { workspaceId: target.organizationId, userId: target.userId }
    await writeSettings(tx, of, settingsChanges(input), actor.actorId, now)
    return { rows: {}, data: await result(tx, target) }
  },
}

/** A name as Better Auth is about to store it (sign-up, Account › Profile, a sign-in provider), cleaned like ours. */
const cleanNameIn = (data: { name?: unknown }) =>
  typeof data.name === 'string' && data.name !== cleanPersonName(data.name)
    ? { data: { ...data, name: cleanPersonName(data.name) } }
    : undefined

/** Better Auth database hooks (merged in auth.ts): every name a person gives themselves is cleaned too. */
export const personNameHooks = {
  user: { create: { before: cleanNameIn }, update: { before: cleanNameIn } },
}
