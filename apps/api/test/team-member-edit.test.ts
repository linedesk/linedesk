// Editing a teammate (Workspace settings › Team › Edit): who may change whose name, picture and notification
// settings, what the audit log keeps, and what the member then sees on their own pages. Sets an instance admin, so
// it runs in a database of its own (INSTANCE_WIDE_FILES).
import { actions, cleanPersonName } from '@linedesk/actions'
import {
  commands,
  member,
  member_notification_settings,
  profile_changes,
  session,
  user_avatars,
  user,
  workspace_members,
} from '@linedesk/db'
import { and, desc, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { mayRunWhileImpersonating } from '../src/impersonation-guard.ts'
import { listAudit } from '../src/audit.ts'
import { auth } from '../src/auth.ts'
import { unsubscribeFromSetupEmails } from '../src/setup-unsubscribe.ts'
import { act, addMember, agent, createWorkspace, request, signUp, type User, type Workspace } from './helpers.ts'

const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='}`

const memberIdOf = async (workspaceId: string, u: User) =>
  (
    await db
      .select()
      .from(member)
      .where(and(eq(member.userId, u.userId), eq(member.organizationId, workspaceId)))
  )[0]!.id
const nameOf = async (u: User) => (await db.select().from(user).where(eq(user.id, u.userId)))[0]!.name
const lastCommand = async (action: string) =>
  (await db.select().from(commands).where(eq(commands.action, action)).orderBy(desc(commands.created_at)).limit(1))[0]

let ws: Workspace
let other: Workspace
let admin: User
let plain: User
let second: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Riverside Heating')
  admin = await addMember(ws.id, 'admin')
  plain = await addMember(ws.id, 'member')
  second = await addMember(ws.id, 'member')
})

describe('who may edit whom', () => {
  test('an admin changes a member: name, picture and notifications; the synced row comes back at once', async () => {
    const memberId = await memberIdOf(ws.id, plain)
    const named = await act(admin, 'team.updateMemberProfile', { memberId, name: 'Sam Rivera' })
    expect(named).toMatchObject({ status: 200, body: { ok: true } })
    expect(await nameOf(plain)).toBe('Sam Rivera')
    expect(named.body.rows.workspace_members).toEqual([expect.objectContaining({ id: memberId, name: 'Sam Rivera' })])

    const pictured = await act(admin, 'team.setMemberAvatar', { memberId, avatar: PNG })
    expect(pictured.status).toBe(200)
    expect(pictured.body.data.avatarUrl).toMatch(new RegExp(`^/v1/avatars/${plain.userId}\\.png\\?v=`))
    const [row] = await db.select().from(workspace_members).where(eq(workspace_members.id, memberId))
    expect(row!.avatar_version).toBeTruthy()
    expect((await act(admin, 'team.removeMemberAvatar', { memberId })).status).toBe(200)

    const notified = await act(admin, 'team.updateMemberNotifications', {
      memberId,
      email: false,
      assignedEmail: false,
    })
    expect(notified.status).toBe(200)
    const [settings] = await db
      .select()
      .from(member_notification_settings)
      .where(
        and(
          eq(member_notification_settings.workspace_id, ws.id),
          eq(member_notification_settings.user_id, plain.userId),
        ),
      )
    expect(settings).toMatchObject({ email: false, assigned_email: false, updated_by: admin.userId })

    const read = await act(admin, 'team.getMember', { memberId })
    expect(read.status).toBe(200)
    expect(read.body.data).toMatchObject({
      member: { memberId, name: 'Sam Rivera', avatarUrl: null, role: 'member' },
      notifications: { effective: { email: false }, assignedEmail: false, setupEmails: null },
      profileChangedBy: { name: 'Test User' },
    })
  })

  test('a member cannot read or edit another member', async () => {
    const memberId = await memberIdOf(ws.id, second)
    for (const [name, input] of [
      ['team.getMember', { memberId }],
      ['team.updateMemberProfile', { memberId, name: 'Hacked' }],
      ['team.setMemberAvatar', { memberId, avatar: PNG }],
      ['team.removeMemberAvatar', { memberId }],
      ['team.updateMemberNotifications', { memberId, email: false }],
    ] as const) {
      const res = await act(plain, name, input)
      expect(res, name).toMatchObject({
        status: 403,
        body: { code: 'forbidden', error: 'missing permission team:write' },
      })
    }
    expect(await nameOf(second)).toBe('Test User')
  })

  test('an admin cannot edit the owner; the owner edits everyone', async () => {
    const ownerId = await memberIdOf(ws.id, ws.owner)
    for (const [name, input] of [
      ['team.getMember', { memberId: ownerId }],
      ['team.updateMemberProfile', { memberId: ownerId, name: 'Not Mike' }],
      ['team.setMemberAvatar', { memberId: ownerId, avatar: PNG }],
      ['team.removeMemberAvatar', { memberId: ownerId }],
      ['team.updateMemberNotifications', { memberId: ownerId, email: false }],
    ] as const) {
      const res = await act(admin, name, input)
      expect(res, name).toMatchObject({
        status: 403,
        body: { code: 'forbidden', error: "only an owner can change an owner's profile or settings" },
      })
    }
    expect(await nameOf(ws.owner)).toBe('Test User')

    const adminId = await memberIdOf(ws.id, admin)
    expect((await act(ws.owner, 'team.updateMemberProfile', { memberId: adminId, name: 'Ana Admin' })).status).toBe(200)
    expect(await nameOf(admin)).toBe('Ana Admin')

    // The owner's own setup emails (only the owner gets those) are theirs: an admin cannot change them.
    expect((await act(admin, 'team.updateMemberNotifications', { memberId: ownerId, setupEmails: false })).status).toBe(403)
    expect((await act(admin, 'team.updateMemberNotifications', { memberId: ownerId, email: true })).status).toBe(403)
  })

  test('a member of another workspace is not found, also for its own owner acting in their workspace', async () => {
    const outsider = await addMember(other.id, 'member')
    const outsiderId = await memberIdOf(other.id, outsider)
    for (const [name, input] of [
      ['team.getMember', { memberId: outsiderId }],
      ['team.updateMemberProfile', { memberId: outsiderId, name: 'Taken Over' }],
      ['team.setMemberAvatar', { memberId: outsiderId, avatar: PNG }],
      ['team.updateMemberNotifications', { memberId: outsiderId, email: false }],
    ] as const) {
      const res = await act(ws.owner, name, input)
      expect(res, name).toMatchObject({ status: 409, body: { ok: false, error: 'member not found' } })
    }
    expect(await nameOf(outsider)).toBe('Test User')
    const [settings] = await db
      .select()
      .from(member_notification_settings)
      .where(eq(member_notification_settings.user_id, outsider.userId))
    expect(settings).toBeUndefined()
  })

  test('an admin changes the name and picture of a member who also runs the server (an instance admin)', async () => {
    const operator = await addMember(ws.id, 'member')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
    const memberId = await memberIdOf(ws.id, operator)
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: 'Renamed' })).status).toBe(200)
    expect(await nameOf(operator)).toBe('Renamed')
    expect((await act(admin, 'team.setMemberAvatar', { memberId, avatar: PNG })).status).toBe(200)
    expect((await act(admin, 'team.updateMemberNotifications', { memberId, email: false })).status).toBe(200)
    // Their instance admin flag is not something this touches.
    expect((await db.select().from(user).where(eq(user.id, operator.userId)))[0]!.instanceAdmin).toBe(true)
  })

  test('an instance admin signed in as an admin of the workspace is refused, like every other write', async () => {
    for (const name of [
      'team.updateMemberProfile',
      'team.setMemberAvatar',
      'team.removeMemberAvatar',
      'team.updateMemberNotifications',
    ]) {
      expect(mayRunWhileImpersonating(actions.get(name)!), name).toBe(false)
    }
    // Reading is allowed while impersonating (as every read is).
    expect(mayRunWhileImpersonating(actions.get('team.getMember')!)).toBe(true)

    const operator = await signUp()
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
    const impersonated = await addMember(ws.id, 'admin')
    await db.update(session).set({ impersonatedBy: operator.userId }).where(eq(session.userId, impersonated.userId))
    const memberId = await memberIdOf(ws.id, second)
    expect((await act(impersonated, 'team.getMember', { memberId })).status).toBe(200)
    const res = await act(impersonated, 'team.updateMemberProfile', { memberId, name: 'Impersonated' })
    expect(res).toMatchObject({
      status: 403,
      body: { code: 'forbidden', error: 'Not possible while signed in as another user.' },
    })
    expect(await nameOf(second)).toBe('Test User')
  })

  test('the voice agent cannot run them', async () => {
    const memberId = await memberIdOf(ws.id, second)
    const res = await act(agent(ws.id), 'team.updateMemberNotifications', { memberId, email: false })
    expect(res.status).toBe(403)
  })
})

describe('audit and transparency', () => {
  test('every change by someone else is in the audit log: who, whom and which fields, never the picture', async () => {
    const memberId = await memberIdOf(ws.id, second)
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: 'Jo Parker' })).status).toBe(200)
    expect((await act(admin, 'team.setMemberAvatar', { memberId, avatar: PNG })).status).toBe(200)
    expect((await act(admin, 'team.updateMemberNotifications', { memberId, email: false })).status).toBe(200)

    const pictureCommand = await lastCommand('team.setMemberAvatar')
    expect(pictureCommand!.input).toEqual({ memberId, avatar: '[redacted]' })

    const { entries } = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 50 })
    const email = (await db.select().from(user).where(eq(user.id, second.userId)))[0]!.email
    for (const what of ['team.updateMemberProfile', 'team.setMemberAvatar', 'team.updateMemberNotifications']) {
      const entry = entries.find(e => e.what === what && e.subject?.email === email)
      expect(entry, what).toMatchObject({ actor: { id: admin.userId }, subject: { email }, refused: false })
    }
    expect(entries.find(e => e.what === 'team.updateMemberProfile' && e.subject?.email === email)!.input).toEqual({
      memberId,
      name: 'Jo Parker',
    })
    // A refused attempt is in the log too.
    await act(admin, 'team.updateMemberProfile', { memberId: await memberIdOf(ws.id, ws.owner), name: 'X' })
    const refused = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 5 })
    expect(refused.entries.some(e => e.what === 'team.updateMemberProfile' && e.refused)).toBe(true)
  })

  test('the member sees who changed their profile and notifications last, until they change them themselves', async () => {
    const jo = await addMember(ws.id, 'member')
    const memberId = await memberIdOf(ws.id, jo)
    expect((await request(jo, 'GET', '/v1/me')).body.profileChangedBy).toBeNull()

    await act(ws.owner, 'team.updateMemberProfile', { memberId, name: 'Jo Lee' })
    await act(ws.owner, 'team.updateMemberNotifications', { memberId, email: false })
    const me = (await request(jo, 'GET', '/v1/me')).body
    expect(me.profileChangedBy).toMatchObject({ name: 'Test User', at: expect.any(String) })
    const own = await act(jo, 'notifications.get', {})
    expect(own.body.data).toMatchObject({ effective: { email: false }, changedBy: { name: 'Test User' } })

    // Their own changes clear it: notifications, the picture, and the name (Better Auth's own endpoint).
    expect((await act(jo, 'notifications.update', { email: true })).body.data.changedBy).toBeNull()
    await act(jo, 'account.setAvatar', { avatar: PNG })
    expect((await request(jo, 'GET', '/v1/me')).body.profileChangedBy).toBeNull()
    await act(ws.owner, 'team.updateMemberProfile', { memberId, name: 'Jo L.' })
    expect(await db.select().from(profile_changes).where(eq(profile_changes.user_id, jo.userId))).toHaveLength(1)
    const renamed = await request(jo, 'POST', '/api/auth/update-user', { name: 'Jo Lee' })
    expect(renamed.status).toBe(200)
    expect((await request(jo, 'GET', '/v1/me')).body.profileChangedBy).toBeNull()
  })
})

/** Adds an existing account to a workspace (as the invitation flow would). */
const join = (u: User, workspaceId: string, role: 'owner' | 'admin' | 'member') =>
  auth.api.addMember({ body: { userId: u.userId, organizationId: workspaceId, role } })

describe('security review of #670', () => {
  test('name and picture only when the caller manages the team in every workspace the member is in', async () => {
    const both = await addMember(ws.id, 'member')
    await join(both, other.id, 'member')
    const memberId = await memberIdOf(ws.id, both)

    // The admin of ws is not in `other`: read-only, notifications here still editable.
    expect((await act(admin, 'team.getMember', { memberId })).body.data).toMatchObject({
      profileEditable: false,
      inOtherWorkspaces: true,
    })
    const refused =
      'they are also in a workspace whose team you do not manage, so only they can change their name and picture'
    for (const [name, input] of [
      ['team.updateMemberProfile', { memberId, name: 'Elsewhere' }],
      ['team.setMemberAvatar', { memberId, avatar: PNG }],
      ['team.removeMemberAvatar', { memberId }],
    ] as const) {
      expect(await act(admin, name, input), name).toMatchObject({
        status: 403,
        body: { code: 'forbidden', error: refused },
      })
    }
    expect(await nameOf(both)).toBe('Test User')
    expect((await act(admin, 'team.updateMemberNotifications', { memberId, email: false })).status).toBe(200)

    // Admin in `other` too: allowed.
    await join(admin, other.id, 'admin')
    expect((await act(admin, 'team.getMember', { memberId })).body.data.profileEditable).toBe(true)
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: 'Both Places' })).status).toBe(200)

    // An owner of `other` is edited there only by an owner: an admin of both is refused again. One owner per
    // workspace: `other`'s owner hands it over to them for this (and gets it back below).
    await db
      .update(member)
      .set({ role: 'admin' })
      .where(and(eq(member.userId, other.owner.userId), eq(member.organizationId, other.id)))
    await db
      .update(member)
      .set({ role: 'owner' })
      .where(and(eq(member.userId, both.userId), eq(member.organizationId, other.id)))
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: 'Again' })).status).toBe(403)

    // The owner of `other` changed it from there: the member, signed in to ws, sees "an admin of another workspace".
    const memberInOther = await memberIdOf(other.id, both)
    await db.update(member).set({ role: 'member' }).where(eq(member.id, memberInOther))
    await db
      .update(member)
      .set({ role: 'owner' })
      .where(and(eq(member.userId, other.owner.userId), eq(member.organizationId, other.id)))
    await join(other.owner, ws.id, 'admin')
    expect(
      (await act(other.owner, 'team.updateMemberProfile', { memberId: memberInOther, name: 'From Other' })).status,
    ).toBe(200)
    expect((await request(both, 'GET', '/v1/me')).body.profileChangedBy).toMatchObject({
      name: 'an admin of another workspace',
    })
    expect((await act(admin, 'team.getMember', { memberId })).body.data.profileChangedBy).toMatchObject({
      name: 'an admin of another workspace',
    })
  })

  test('a change can be put back: the old name and picture are kept, in the log and in profile_changes', async () => {
    const jo = await addMember(ws.id, 'member')
    const memberId = await memberIdOf(ws.id, jo)
    await act(jo, 'account.setAvatar', { avatar: PNG })
    const [own] = await db.select().from(user_avatars).where(eq(user_avatars.user_id, jo.userId))

    const renamed = await act(admin, 'team.updateMemberProfile', { memberId, name: 'First' })
    expect(renamed.body.data.previous).toEqual({ name: 'Test User' })
    await act(admin, 'team.updateMemberProfile', { memberId, name: 'Second' })
    const pictured = await act(admin, 'team.setMemberAvatar', { memberId, avatar: PNG })
    expect(pictured.body.data.previous).toEqual({ avatarVersion: own!.version })
    expect((await lastCommand('team.setMemberAvatar'))!.result).toMatchObject({
      data: { previous: { avatarVersion: own!.version } },
    })
    expect((await lastCommand('team.updateMemberProfile'))!.result).toMatchObject({
      data: { previous: { name: 'First' } },
    })

    // profile_changes keeps what was there before others first changed it.
    const [kept] = await db.select().from(profile_changes).where(eq(profile_changes.user_id, jo.userId))
    expect(kept!.previous).toEqual({ name: 'Test User', avatar: { version: own!.version, png: own!.png } })
  })

  test("a teammate's push summary can only be turned off", async () => {
    const memberId = await memberIdOf(ws.id, second)
    expect((await act(admin, 'team.updateMemberNotifications', { memberId, pushSummary: true })).status).toBe(422)
    expect((await act(admin, 'team.updateMemberNotifications', { memberId, pushSummary: false })).status).toBe(200)
    // The member turns it on themselves.
    expect((await act(second, 'notifications.update', { pushSummary: true })).status).toBe(200)
  })

  test("unsubscribing from setup emails by link is the member's own change", async () => {
    // The owner changes an admin's notifications, then hands the workspace to them: the new owner unsubscribes.
    const shop = await createWorkspace('Unsubscribe Hand Over Co')
    const coOwner = await addMember(shop.id, 'admin')
    const coOwnerId = await memberIdOf(shop.id, coOwner)
    expect((await act(shop.owner, 'team.updateMemberNotifications', { memberId: coOwnerId, email: false })).status).toBe(200)
    expect((await act(shop.owner, 'team.transferOwnership', { memberId: coOwnerId })).status).toBe(200)
    expect((await act(coOwner, 'notifications.get', {})).body.data.changedBy).toMatchObject({ name: 'Test User' })
    expect(await unsubscribeFromSetupEmails(shop.id, coOwner.userId)).toBe(true)
    const [row] = await db
      .select()
      .from(member_notification_settings)
      .where(
        and(
          eq(member_notification_settings.workspace_id, shop.id),
          eq(member_notification_settings.user_id, coOwner.userId),
        ),
      )
    expect(row!.updated_by).toBe(coOwner.userId)
  })

  test('names lose invisible characters (bidi overrides, zero-width), from an admin and from the person', async () => {
    expect(cleanPersonName(' Jo\u202Ekra\u202CP\u200B ')).toBe('JokraP')
    const jo = await addMember(ws.id, 'member')
    const memberId = await memberIdOf(ws.id, jo)
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: 'Mike\u202E nnerB' })).status).toBe(200)
    expect(await nameOf(jo)).toBe('Mike nnerB')
    expect((await act(admin, 'team.updateMemberProfile', { memberId, name: '\u200B\u2066' })).status).toBe(422)
    expect((await request(jo, 'POST', '/api/auth/update-user', { name: 'Jo\u200D Lee\u2067' })).status).toBe(200)
    expect(await nameOf(jo)).toBe('Jo Lee')
  })
})
