// Workspaces are created, renamed and removed only through Linedesk (QA T6): Better Auth's own
// organization endpoints for these are off, so nobody can leave a workspace's numbers, contacts and
// assistants orphaned or rename it outside the command log.
import {
  assistants,
  commands,
  member,
  organization,
  phone_numbers,
  session,
  setup_events,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, asServerAdmin, createWorkspace, FROM, randomIp, request, signUp } from './helpers.ts'

const ORIGIN = { origin: 'http://localhost:5173' }

test("an owner cannot delete, rename or create a workspace through Better Auth's endpoints", async () => {
  const ws = await createWorkspace('Orphan Guard Plumbing')
  const call = (path: string, body: object) =>
    request(ws.owner, 'POST', `/api/auth/organization/${path}`, body, { ...ORIGIN, [FROM]: randomIp() })

  expect((await call('delete', { organizationId: ws.id })).status).toBe(404)
  expect((await call('update', { organizationId: ws.id, data: { name: 'Renamed Elsewhere' } })).status).toBe(404)
  expect(
    (await call('create', { name: 'Bare Workspace', slug: `bare-${crypto.randomUUID().slice(0, 8)}` })).status,
  ).toBe(404)

  const [row] = await db.select().from(organization).where(eq(organization.id, ws.id))
  expect(row?.name).toBe('Orphan Guard Plumbing')
  expect(await db.select().from(assistants).where(eq(assistants.workspace_id, ws.id))).not.toEqual([])
  expect(await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))).not.toEqual([])
  expect(await db.select().from(organization).where(eq(organization.name, 'Bare Workspace'))).toEqual([])
})

test('POST /v1/workspaces still creates a workspace with its assistant (Better Auth is called from inside the API)', async () => {
  const ws = await createWorkspace('Still Works Plumbing')
  expect(await db.select().from(assistants).where(eq(assistants.workspace_id, ws.id))).toHaveLength(1)
})

test('POST /v1/workspaces goes through workspace.create: one logged command, the caller its owner, their active workspace, one signup', async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  const made = await asServerAdmin(admin, () =>
    request(admin, 'POST', '/v1/workspaces', {
      name: 'Brightwater Plumbing & Heating',
      timeZone: 'America/Los_Angeles',
    }),
  )
  expect(made).toMatchObject({ status: 200, body: { ok: true, workspace: { name: 'Brightwater Plumbing & Heating' } } })
  const id: string = made.body.workspace.id
  const logged = await db
    .select()
    .from(commands)
    .where(and(eq(commands.actor_id, admin.userId), eq(commands.action, 'workspace.create')))
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatchObject({ rejected: false, setup_key_id: null })
  expect(logged[0]!.result).toMatchObject({ data: { workspace: { id }, subject: { workspaceId: id } } })
  expect(await db.select().from(member).where(eq(member.organizationId, id))).toMatchObject([
    { userId: admin.userId, role: 'owner' },
  ])
  const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, id))
  expect(settings?.timezone).toBe('America/Los_Angeles')
  expect(await db.select().from(assistants).where(eq(assistants.workspace_id, id))).toHaveLength(1)
  expect(
    await db
      .select()
      .from(setup_events)
      .where(and(eq(setup_events.workspace_id, id), eq(setup_events.event, 'signup'))),
  ).toHaveLength(1)
  // The new workspace is the session's active one: the app opens it without another request.
  const sessions = await db.select().from(session).where(eq(session.userId, admin.userId))
  expect(sessions.map(s => s.activeOrganizationId)).toContain(id)
})

test('POST /v1/workspaces: a time zone that is not one falls back to the default, as before', async () => {
  const admin = await signUp()
  const made = await asServerAdmin(admin, () =>
    request(admin, 'POST', '/v1/workspaces', { name: 'Riverside Dental', timeZone: 42 }),
  )
  expect(made.status).toBe(200)
  const [settings] = await db
    .select()
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, made.body.workspace.id))
  expect(settings?.timezone).toBeTruthy()
})

test('workspace.create without an owner is still for server admins only, and leaves no workspace when refused', async () => {
  const ws = await createWorkspace('Owner Only Plumbing')
  const refused = await act(ws.owner, 'workspace.create', { name: 'Not Mine To Make' })
  expect(refused.status).toBe(403)
  expect(await db.select().from(organization).where(eq(organization.name, 'Not Mine To Make'))).toEqual([])
  // The app's endpoint answers as before.
  expect(await request(ws.owner, 'POST', '/v1/workspaces', { name: 'Not Mine To Make' })).toMatchObject({
    status: 403,
    body: { ok: false, code: 'workspace_creation_closed' },
  })
})
