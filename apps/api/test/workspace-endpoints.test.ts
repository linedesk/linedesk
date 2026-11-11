// Workspaces are created, renamed and removed only through Linedesk (QA T6): Better Auth's own
// organization endpoints for these are off, so nobody can leave a workspace's numbers, contacts and
// assistants orphaned or rename it outside the command log.
import { assistants, organization, phone_numbers } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { createWorkspace, FROM, randomIp, request } from './helpers.ts'

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
