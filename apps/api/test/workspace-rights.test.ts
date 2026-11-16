// Workspace rights (docs/architecture.md, "Workspace rights"): every action of the registry, run by an owner, an
// admin, a member, someone of another workspace and someone without a workspace. Table-driven over the registry, so
// a new action is covered the day it is added. Input "x" is never valid: an allowed caller gets 422 (past the
// permission check), a refused one 403 before its input is read. Then the one-owner rules: hand over, never demote or
// remove the owner, the owner cannot leave, and the database keeps one owner per workspace.
import { actions, rightOf, roleMeets, WORKSPACE_ROLES } from '@linedesk/actions'
import { member as memberTable, user as users } from '@linedesk/db'
import { db } from '../src/db.ts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { act, addMember, createWorkspace, request, signUp, type User, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
let admin: User
let member: User
let homeless: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Harbor Dental')
  admin = await addMember(ws.id, 'admin')
  member = await addMember(ws.id, 'member')
  homeless = await signUp()
})

const workspaceActions = [...actions.values()]
  .map(a => ({ name: a.name, permission: a.permission, right: rightOf(a.permission) }))
  .filter(a => a.right === 'member' || a.right === 'admin' || a.right === 'owner')

const callerOf = (role: (typeof WORKSPACE_ROLES)[number]) => (role === 'owner' ? ws.owner : role === 'admin' ? admin : member)

const cases = workspaceActions.flatMap(a => WORKSPACE_ROLES.map(role => ({ ...a, role, allowed: roleMeets(role, a.right) })))

describe('every workspace action, by role', () => {
  test('the registry has workspace actions for every role', () => {
    for (const right of ['member', 'admin', 'owner']) expect(workspaceActions.some(a => a.right === right)).toBe(true)
  })

  test.each(cases)('$role → $name ($permission): allowed=$allowed', async ({ name, permission, role, allowed }) => {
    const res = await act(callerOf(role), name, 'x')
    if (allowed) expect(res.status).toBe(422)
    else expect(res).toMatchObject({ status: 403, body: { ok: false, error: `missing permission ${permission}` } })
  })

  test.each(workspaceActions)('someone of another workspace cannot run $name in this one', async ({ name }) => {
    const res = await request(other.owner, 'POST', `/v1/actions/${name}`, 'x', { 'x-workspace-id': ws.id })
    expect(res.status).toBe(403)
  })

  test.each(workspaceActions)('someone without a workspace cannot run $name', async ({ name }) => {
    const res = await act(homeless, name, 'x')
    expect([401, 403]).toContain(res.status)
    expect(res.status).not.toBe(422)
  })
})

const roleIn = async (workspaceId: string, userId: string) =>
  (
    await db
      .select({ role: memberTable.role })
      .from(memberTable)
      .where(and(eq(memberTable.organizationId, workspaceId), eq(memberTable.userId, userId)))
  )[0]?.role
const memberIdOf = async (workspaceId: string, userId: string) =>
  (
    await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(and(eq(memberTable.organizationId, workspaceId), eq(memberTable.userId, userId)))
  )[0]!.id

describe('exactly one owner', () => {
  test('team.setRole cannot make an owner, nor change the owner', async () => {
    const target = await addMember(ws.id, 'member')
    expect((await act(ws.owner, 'team.setRole', { memberId: await memberIdOf(ws.id, target.userId), role: 'owner' })).status).toBe(422)
    const ownerMember = await memberIdOf(ws.id, ws.owner.userId)
    expect((await act(admin, 'team.setRole', { memberId: ownerMember, role: 'member' })).status).toBe(403)
    expect(await roleIn(ws.id, ws.owner.userId)).toBe('owner')
  })

  test('nobody removes the owner, and the owner cannot leave', async () => {
    const ownerMember = await memberIdOf(ws.id, ws.owner.userId)
    expect((await act(admin, 'team.removeMember', { memberId: ownerMember })).status).toBe(403)
    const leave = await act(ws.owner, 'team.leave', {})
    expect(leave.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(leave.body)).toContain('make someone else the owner first')
    expect(await roleIn(ws.id, ws.owner.userId)).toBe('owner')
  })

  test('only the owner hands over, and only to a confirmed member of the workspace', async () => {
    const shop = await createWorkspace('Rose City Roofing')
    const shopAdmin = await addMember(shop.id, 'admin')
    const next = await addMember(shop.id, 'member')
    const nextId = await memberIdOf(shop.id, next.userId)
    // An admin cannot, and API keys never carry it (api-keys.ts).
    expect(await act(shopAdmin, 'team.transferOwnership', { memberId: nextId })).toMatchObject({
      status: 403,
      body: { error: 'missing permission workspace:own' },
    })
    // Not to someone of another workspace.
    expect(
      (await act(shop.owner, 'team.transferOwnership', { memberId: await memberIdOf(other.id, other.owner.userId) })).status,
    ).toBeGreaterThanOrEqual(400)
    // Not to an unconfirmed address.
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, next.userId))
    expect((await act(shop.owner, 'team.transferOwnership', { memberId: nextId })).status).toBeGreaterThanOrEqual(400)
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, next.userId))

    expect((await act(shop.owner, 'team.transferOwnership', { memberId: nextId })).status).toBe(200)
    expect(await roleIn(shop.id, next.userId)).toBe('owner')
    expect(await roleIn(shop.id, shop.owner.userId)).toBe('admin')
    // The former owner is an admin now: no longer able to delete or hand over.
    expect((await act(shop.owner, 'workspace.deletePreview', {})).status).toBe(403)
    expect((await act(next, 'workspace.deletePreview', {})).status).toBe(200)
  })

  test('the database refuses a second owner', async () => {
    const extra = await addMember(ws.id, 'member')
    await expect(
      db
        .update(memberTable)
        .set({ role: 'owner' })
        .where(and(eq(memberTable.organizationId, ws.id), eq(memberTable.userId, extra.userId))),
    ).rejects.toThrow()
  })
})

describe('the workspace country (LIN-258)', () => {
  test('admins and the owner set it in workspace.updateSettings; members read it, never change it', async () => {
    const refused = await act(member, 'workspace.updateSettings', { country: 'GB' })
    expect(refused).toMatchObject({ status: 403, body: { ok: false, error: 'missing permission settings:write' } })
    for (const who of [admin, ws.owner]) {
      const set = await act(who, 'workspace.updateSettings', { country: 'gb' })
      expect(set.status).toBe(200)
    }
    const read = await act(member, 'workspace.getSettings', {})
    expect(read.body).toMatchObject({ ok: true, data: { country: 'GB', resolvedCountry: 'GB', resolvedLanguage: 'en' } })
    const reset = await act(admin, 'workspace.updateSettings', { country: null })
    expect(reset.status).toBe(200)
  })
})
