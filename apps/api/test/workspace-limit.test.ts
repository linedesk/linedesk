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

afterAll(() => {
  delete process.env.WORKSPACE_LIMIT
})

test('the env limit is what Better Auth enforces', () => {
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
