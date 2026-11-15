// WORKSPACE_LIMIT set (here 2): the app's New workspace and the setup agent's workspace_create stop at it and say so.
// The limit is read when the API starts, so this file sets it before anything is imported.
import { user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.WORKSPACE_LIMIT = '2'
})

const { auth, WORKSPACE_LIMIT } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')
const { act, appRequest, asServerAdmin, FROM, randomIp, request, signUp } = await import('./helpers.ts')
const { member, session } = await import('@linedesk/db')

afterAll(() => {
  delete process.env.WORKSPACE_LIMIT
})

test("the env limit is read at start (Better Auth keeps it too; workspace.create applies it to an admin's own workspaces)", () => {
  expect(WORKSPACE_LIMIT).toBe(2)
  expect(auth.options.plugins.find(p => p.id === 'organization')?.options?.organizationLimit).toBe(2)
})

test('New workspace in the app: two, then "You can create up to 2 workspaces."', async () => {
  const member = await signUp()
  const refused = await asServerAdmin(member, async () => {
    for (const name of ['Business 1', 'Business 2'])
      expect((await request(member, 'POST', '/v1/workspaces', { name })).status).toBe(200)
    return request(member, 'POST', '/v1/workspaces', { name: 'One too many' })
  })
  expect(refused.status).toBe(403)
  expect(refused.body).toEqual({ ok: false, error: 'You can create up to 2 workspaces.' })
}, 30_000)

test('the setup agent at the limit hears the same, never "internal error" (review L1 of #711)', async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  const made = await act(admin, 'agentSetup.createKey', {})
  expect(made.status).toBe(200)
  const key = (made.body.data as { key: string }).key
  const create = async (name: string) => {
    const res = await appRequest(`/mcp/setup/${key}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [FROM]: randomIp(),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name: 'workspace_create', arguments: { name } },
      }),
    })
    const text = await res.text()
    const json = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find(l => l.startsWith('data: '))
          ?.slice(6) ?? 'null')
    return JSON.parse(json).result as { isError?: boolean; content: { text: string }[] }
  }
  expect((await create('Location 1')).isError).toBeFalsy()
  expect((await create('Location 2')).isError).toBeFalsy()
  const refused = await create('Location 3')
  expect(refused.isError).toBe(true)
  expect(refused.content[0]!.text).toBe('You can create up to 2 workspaces.')
}, 30_000)

test('two New workspace requests at once cannot both pass the limit', async () => {
  const member1 = await signUp()
  const results = await asServerAdmin(member1, async () => {
    expect((await request(member1, 'POST', '/v1/workspaces', { name: 'First Location' })).status).toBe(200)
    return Promise.all(
      ['Second Location', 'Third Location', 'Fourth Location'].map(name =>
        request(member1, 'POST', '/v1/workspaces', { name }),
      ),
    )
  })
  expect(results.filter(r => r.status === 200)).toHaveLength(1)
  for (const refused of results.filter(r => r.status !== 200))
    expect(refused).toEqual({ status: 403, body: { ok: false, error: 'You can create up to 2 workspaces.' } })
  expect(await db.select().from(member).where(eq(member.userId, member1.userId))).toHaveLength(2)
}, 30_000)

test("workspace.create: the limit counts the admin's own workspaces only; one made for an owner is not theirs", async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  await asServerAdmin(admin, async () => {
    for (const name of ['Own One', 'Own Two']) expect((await act(admin, 'workspace.create', { name })).status).toBe(200)
    const refused = await act(admin, 'workspace.create', { name: 'Own Three' })
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: 'You can create up to 2 workspaces.' } })
    // For a business with its own owner: as before, not the admin's workspace and not counted against them.
    const owner = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, owner.userId))
    const [account] = await db.select().from(user).where(eq(user.id, owner.userId))
    const forOwner = await act(admin, 'workspace.create', {
      name: 'Riverside Dental',
      owner: { email: account!.email },
    })
    expect(forOwner.status).toBe(200)
  })
}, 30_000)

test("workspace.create with the admin's own address as owner is their own workspace: counted, owner at once, active", async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  const [account] = await db.select().from(user).where(eq(user.id, admin.userId))
  await asServerAdmin(admin, async () => {
    const made = await act(admin, 'workspace.create', { name: 'Own Plumbing', owner: { email: account!.email } })
    expect(made).toMatchObject({ status: 200, body: { data: { owner: { userId: admin.userId, joined: 'added' } } } })
    // No invitation, no email: a member row like New workspace in the app, and the session's active workspace.
    const id = made.body.data.workspace.id as string
    expect(await db.select().from(member).where(eq(member.organizationId, id))).toMatchObject([
      { userId: admin.userId, role: 'owner' },
    ])
    expect(
      (await db.select().from(session).where(eq(session.userId, admin.userId))).map(s => s.activeOrganizationId),
    ).toContain(id)
    expect((await act(admin, 'workspace.create', { name: 'Own Heating' })).status).toBe(200)
    // At the limit, the own address (in any case) does not get round it.
    const refused = await act(admin, 'workspace.create', {
      name: 'Own Three',
      owner: { email: account!.email.toUpperCase() },
    })
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: 'You can create up to 2 workspaces.' } })
  })
  expect(await db.select().from(member).where(eq(member.userId, admin.userId))).toHaveLength(2)
}, 30_000)
