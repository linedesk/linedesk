// Workspace API keys: created once and stored hashed, usable as Bearer only in their workspace,
// with their role's permissions, revocable, rate limited, never managing keys themselves.
import { api_keys, calls, commands, member as memberTable, organization, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { API_KEY_REQUESTS_PER_MINUTE, apiKeyWithinLimit, hashApiKey, INVALID_API_KEYS_PER_IP } from '../src/api-keys.ts'
import { db } from '../src/db.ts'
import { SHAPE_NOT_FOR_API_KEYS } from '../src/app.ts'
import { API_KEY_PUBLIC_ONLY } from '../src/run-action.ts'
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

  test('an admin key runs only the public API: no settings, keys or team, even with settings:write', async () => {
    const { key } = await createKey(ws.owner, 'admin')
    expect((await request(bearer(key), 'GET', '/v1/me')).body.permissions).not.toContain('team:write')
    const publicOnly = { status: 403, body: { ok: false, error: API_KEY_PUBLIC_ONLY, code: 'forbidden' } }
    expect(await act(bearer(key), 'apiKey.create', { name: 'more' })).toMatchObject(publicOnly)
    expect(await act(bearer(key), 'apiKey.list', {})).toMatchObject(publicOnly)
    expect((await act(bearer(key), 'team.invite', { email: 'x@example.com', role: 'member' })).status).toBe(403)
    // What a leaked key could otherwise do: point urgent calls at another phone, copy every call out, read settings.
    expect(await act(bearer(key), 'assistant.update', { assistantId: ws.assistant.id, transfers: [] })).toMatchObject(publicOnly)
    expect(await act(bearer(key), 'webhook.create', { url: 'https://example.com/hook', events: ['call.finished'] })).toMatchObject(publicOnly)
    expect(await act(bearer(key), 'carrier.get', {})).toMatchObject(publicOnly)
    expect(await act(bearer(key), 'phoneNumber.release', { phoneNumberId: 'pn_x' })).toMatchObject(publicOnly)
    expect(await db.select().from(commands).where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'assistant.update')))).toEqual([])
    // The public API works as before.
    expect((await act(bearer(key), 'call.markDone', { callId: ws.call.id })).status).toBe(200)
    expect((await act(bearer(key), 'contact.update', { contactId: ws.contact.id, note: 'Gate code 4411' })).status).toBe(200)
  })

  test('no key reads the synced tables: settings, numbers, calendars and webhook URLs stay in the app', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      for (const role of ['member', 'admin'] as const) {
        const { key } = await createKey(ws.owner, role)
        for (const table of ['assistants', 'phone_numbers', 'calendar_connections', 'webhook_endpoints', 'calls']) {
          expect(await request(bearer(key), 'GET', `/v1/shape/${table}?offset=-1`)).toMatchObject({
            status: 403,
            body: { ok: false, error: SHAPE_NOT_FOR_API_KEYS, code: 'forbidden' },
          })
        }
      }
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('electric.test'))).toEqual([])
    } finally {
      fetchSpy.mockRestore()
    }
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
  test(`from the ${INVALID_API_KEYS_PER_IP}th refused key on an address gets 429; a key that worked lately still works from it, others are not affected`, async () => {
    const { key } = await createKey(ws.owner)
    const { key: unused } = await createKey(ws.owner)
    const from = (ip: string, k: string) => request(bearer(k), 'GET', '/v1/me', undefined, { [FROM]: ip })
    const ip = randomIp()
    expect((await from(randomIp(), key)).status).toBe(200)
    for (let i = 1; i < INVALID_API_KEYS_PER_IP; i++) expect((await from(ip, `ld_wrong-${i}`)).status).toBe(401)
    // The last refused key that is looked up already answers 429, so the client knows to stop.
    expect((await from(ip, 'ld_wrong-last')).status).toBe(429)
    // One host behind a shared address cannot lock out a working integration: a key that worked lately is still looked up.
    expect((await from(ip, key)).status).toBe(200)
    // Any other key from the address is refused without a database query: random keys cost nothing.
    const select = vi.spyOn(db, 'select')
    try {
      expect((await from(ip, `ld_${'A'.repeat(43)}`)).status).toBe(429)
      expect((await from(ip, 'ld_wrong-again')).status).toBe(429)
      expect((await from(ip, unused)).status).toBe(429)
      expect(select).not.toHaveBeenCalled()
    } finally {
      select.mockRestore()
    }
    // A key revoked since it worked is looked up and refused.
    const revokedId = (await db.select({ id: api_keys.id }).from(api_keys).where(eq(api_keys.key_hash, hashApiKey(key))))[0]!.id
    await db.update(api_keys).set({ revoked_at: new Date().toISOString() }).where(eq(api_keys.id, revokedId))
    expect((await from(ip, key)).status).toBe(429)
    expect((await from(randomIp(), unused)).status).toBe(200)
  })
})
