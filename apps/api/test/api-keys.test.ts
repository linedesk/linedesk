// Workspace API keys: created once and stored hashed, usable as Bearer only in their workspace,
// with their role's permissions, revocable, rate limited, never managing keys themselves.
import { api_keys, calls, commands, member as memberTable, organization, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { API_KEY_REQUESTS_PER_MINUTE, apiKeyWithinLimit, hashApiKey, INVALID_API_KEYS_PER_IP } from '../src/api-keys.ts'
import { db } from '../src/db.ts'
import { act, addMember, type Caller, createWorkspace, FROM, randomIp, request, type User, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
let member: User

const bearer = (key: string): Caller => ({ headers: { authorization: `Bearer ${key}` } })

async function createKey(owner: Caller, role: 'member' | 'admin' = 'member', name = 'Zapier') {
  const res = await act(owner, 'apiKey.create', { name, role })
  expect(res.status).toBe(200)
  return res.body.data as { apiKeyId: string; key: string; prefix: string }
}

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
})

describe('creating and listing', () => {
  test('the key is shown once: stored as a hash, the command log keeps no copy, the list shows only its start', async () => {
    const { apiKeyId, key, prefix } = await createKey(ws.owner)
    expect(key).toMatch(/^ld_[A-Za-z0-9_-]{43}$/)
    expect(prefix).toBe(key.slice(0, 11))
    const [row] = await db.select().from(api_keys).where(eq(api_keys.id, apiKeyId))
    expect(row).toMatchObject({ workspace_id: ws.id, key_hash: hashApiKey(key), role: 'member', created_by: ws.owner.userId })
    const logged = await db.select().from(commands).where(eq(commands.action, 'apiKey.create'))
    expect(JSON.stringify(logged)).not.toContain(key)
    const listed = await act(ws.owner, 'apiKey.list', {})
    expect(JSON.stringify(listed.body)).not.toContain(key)
    expect(JSON.stringify(listed.body)).not.toContain(row!.key_hash)
    expect(listed.body.data.keys).toContainEqual(expect.objectContaining({ id: apiKeyId, name: 'Zapier', prefix }))
  })

  test('only owners and admins manage keys, and only their own workspace’s', async () => {
    expect((await act(member, 'apiKey.create', { name: 'x' })).status).toBe(403)
    expect((await act(member, 'apiKey.list', {})).status).toBe(403)
    const { apiKeyId } = await createKey(ws.owner)
    expect(await act(other.owner, 'apiKey.revoke', { apiKeyId })).toMatchObject({ status: 409, body: { error: 'API key not found' } })
    expect((await act(other.owner, 'apiKey.list', {})).body.data.keys.map((k: { id: string }) => k.id)).not.toContain(apiKeyId)
  })
})

describe('using a key', () => {
  test('a key acts in its workspace with its role, and reaches nothing of another', async () => {
    const { key } = await createKey(ws.owner)
    const me = await request(bearer(key), 'GET', '/v1/me')
    expect(me.body).toMatchObject({ role: 'member', workspace: { id: ws.id } })
    expect(me.body.permissions).not.toContain('settings:write')
    expect((await act(bearer(key), 'call.markDone', { callId: ws.call.id })).status).toBe(200)
    expect(await act(bearer(key), 'call.markDone', { callId: other.call.id })).toMatchObject({ status: 409 })
    expect((await db.select().from(calls).where(eq(calls.id, other.call.id)))[0]!.inbox_state).toBe('open')
    // A key cannot pick another workspace with the workspace header; its own still works.
    expect(await request(bearer(key), 'POST', '/v1/actions/call.markDone', { callId: other.call.id }, { 'x-workspace-id': other.id })).toMatchObject({
      status: 403,
      body: { code: 'workspace_access_lost', error: 'This API key belongs to another workspace.' },
    })
    expect((await request(bearer(key), 'POST', '/v1/actions/call.markNotDone', { callId: ws.call.id }, { 'x-workspace-id': ws.id })).status).toBe(200)
    expect((await act(bearer(key), 'assistant.update', { assistantId: ws.assistant.id, greeting: 'hi' })).status).toBe(403)
  })

  test('an admin key has settings but never manages keys or the team', async () => {
    const { key } = await createKey(ws.owner, 'admin')
    expect((await request(bearer(key), 'GET', '/v1/me')).body.permissions).not.toContain('team:write')
    expect(await act(bearer(key), 'apiKey.create', { name: 'more' })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/cannot manage API keys/) } })
    expect((await act(bearer(key), 'apiKey.list', {})).status).toBe(409)
    expect((await act(bearer(key), 'team.invite', { email: 'x@example.com', role: 'member' })).status).toBe(403)
  })

  test('unknown, revoked and disabled-workspace keys are refused', async () => {
    expect((await request(bearer('ld_not-a-real-key'), 'GET', '/v1/me')).status).toBe(401)
    const { apiKeyId, key } = await createKey(ws.owner)
    expect((await act(ws.owner, 'apiKey.revoke', { apiKeyId })).status).toBe(200)
    expect((await request(bearer(key), 'GET', '/v1/me')).status).toBe(401)
    expect((await act(ws.owner, 'apiKey.revoke', { apiKeyId })).status).toBe(409)

    const disabled = await createWorkspace('Disabled Business')
    const { key: theirs } = await createKey(disabled.owner)
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, disabled.id))
    expect((await request(bearer(theirs), 'GET', '/v1/me')).status).toBe(401)
  })

  test(`at most ${API_KEY_REQUESTS_PER_MINUTE} requests a minute per key`, () => {
    const id = `key_limit_${crypto.randomUUID()}`
    for (let i = 0; i < API_KEY_REQUESTS_PER_MINUTE; i++) expect(apiKeyWithinLimit(id)).toBe(true)
    expect(apiKeyWithinLimit(id)).toBe(false)
    expect(apiKeyWithinLimit(`${id}-other`)).toBe(true)
  })
})

describe('a key is only as strong as the member who created it', () => {
  const memberIdOf = async (workspaceId: string, userId: string) =>
    (await db.select().from(memberTable).where(and(eq(memberTable.organizationId, workspaceId), eq(memberTable.userId, userId))))[0]!.id
  const works = async (key: string) => (await request(bearer(key), 'GET', '/v1/me')).status

  test('removed from the workspace: the keys they created stop working', async () => {
    const admin = await addMember(ws.id, 'admin')
    const { key } = await createKey(admin)
    expect(await works(key)).toBe(200)
    expect((await act(ws.owner, 'team.removeMember', { memberId: await memberIdOf(ws.id, admin.userId) })).status).toBe(200)
    expect(await works(key)).toBe(401)
  })

  test('demoted to member: their admin keys stop working, their member keys keep working', async () => {
    const admin = await addMember(ws.id, 'admin')
    const { key: adminKey } = await createKey(admin, 'admin')
    const { key: memberKey } = await createKey(admin, 'member')
    expect((await act(ws.owner, 'team.setRole', { memberId: await memberIdOf(ws.id, admin.userId), role: 'member' })).status).toBe(200)
    expect(await works(adminKey)).toBe(401)
    expect(await works(memberKey)).toBe(200)
  })

  test('disabled by an instance admin: their keys stop working, and work again once enabled', async () => {
    const admin = await addMember(ws.id, 'admin')
    const { key } = await createKey(admin)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, admin.userId))
    expect(await works(key)).toBe(401)
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, admin.userId))
    expect(await works(key)).toBe(200)
  })
})

describe('invalid keys per client address', () => {
  test(`from the ${INVALID_API_KEYS_PER_IP}th refused key on an address gets 429 and is not looked up, even with a valid key; others are not affected`, async () => {
    const { key } = await createKey(ws.owner)
    const from = (ip: string, k: string) => request(bearer(k), 'GET', '/v1/me', undefined, { [FROM]: ip })
    const ip = randomIp()
    for (let i = 1; i < INVALID_API_KEYS_PER_IP; i++) expect((await from(ip, `ld_wrong-${i}`)).status).toBe(401)
    // The last refused key that is looked up already answers 429, so the client knows to stop.
    expect((await from(ip, 'ld_wrong-last')).status).toBe(429)
    expect((await from(ip, key)).status).toBe(429)
    expect((await from(randomIp(), key)).status).toBe(200)
  })
})
