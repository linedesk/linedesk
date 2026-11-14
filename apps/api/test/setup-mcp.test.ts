// Setup MCP at /mcp/setup (LIN-125): an instance admin's setup key, the short list of setup tools, and every way a
// key stops working. In INSTANCE_WIDE_FILES: it makes instance admins and stores provider keys.
import { agent_setup_keys, phone_numbers, provider_settings, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { SETUP_ACTIONS } from '../src/setup-mcp.ts'
import { act, appRequest, createWorkspace, FROM, randomIp, signUp, type User, type Workspace } from './helpers.ts'

let id = 0
let ws: Workspace
/** An instance admin without a workspace yet: a fresh install's first admin. */
let fresh: User

const setAdmin = (who: User, on: boolean) => db.update(user).set({ instanceAdmin: on }).where(eq(user.id, who.userId))

async function makeKey(who: User) {
  const res = await act(who, 'agentSetup.createKey', {})
  expect(res.status).toBe(200)
  return res.body.data as { key: string; url: string; keyId: string; expiresAt: string }
}

/** One JSON-RPC request, the key in the path (as Claude and ChatGPT connect) or as Bearer. */
async function mcp(
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
  { bearer = false, path = '/mcp/setup', from = randomIp() }: { bearer?: boolean; path?: string; from?: string } = {},
) {
  const res = await appRequest(key && !bearer ? `${path}/${key}` : path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [FROM]: from,
      ...(key && bearer ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return { status: res.status, body: JSON.parse(json) as any }
}
const call = (key: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(key, 'tools/call', { name, arguments: args })
const data = (res: { body: { result: { structuredContent: Record<string, unknown> } } }) =>
  res.body.result.structuredContent

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  await setAdmin(ws.owner, true)
  fresh = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, fresh.userId))
})

describe('setup keys', () => {
  test('only an instance admin makes one; the key is in the result once, never in the command log', async () => {
    // A workspace owner who is not an instance admin.
    const owner = (await createWorkspace('Other Business')).owner
    expect((await act(owner, 'agentSetup.createKey', {})).status).toBe(403)
    const made = await makeKey(ws.owner)
    expect(made.key).toMatch(/^lds_[A-Za-z0-9_-]{43}$/)
    expect(made.url).toMatch(new RegExp(`/mcp/setup/${made.key}$`))
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, made.keyId))
    expect(row!.key_hash).not.toContain(made.key)
    expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000)
  })

  test('a new key ends the earlier ones; End agent access ends all of them', async () => {
    const first = await makeKey(ws.owner)
    const second = await makeKey(ws.owner)
    expect((await mcp(first.key, 'tools/list')).status).toBe(401)
    expect((await mcp(second.key, 'tools/list')).status).toBe(200)
    expect((await act(ws.owner, 'agentSetup.revoke', {})).status).toBe(200)
    expect((await mcp(second.key, 'tools/list')).status).toBe(401)
  })

  test('GET /v1/admin/agent-setup says where agents connect and which key works, never the key', async () => {
    const made = await makeKey(ws.owner)
    const res = await appRequest('/v1/admin/agent-setup', { headers: ws.owner.headers })
    const body = await res.json()
    expect(body.mcpUrl).toMatch(/\/mcp\/setup$/)
    expect(body.reachableFromCloud).toBe(false)
    expect(body.key.prefix).toBe(made.key.slice(0, 12))
    expect(JSON.stringify(body)).not.toContain(made.key)
    expect(body.progress.steps.map((s: { id: string }) => s.id)).toContain('telephony')
  })
})

describe('access', () => {
  test('the key works in the path and as Bearer; nothing else gets in', async () => {
    const { key } = await makeKey(ws.owner)
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    expect((await mcp(key, 'tools/list', {}, { bearer: true })).status).toBe(200)
    expect((await mcp(null, 'tools/list')).status).toBe(401)
    expect((await mcp('lds_unknown', 'tools/list')).status).toBe(401)
    // A workspace API key is not a setup key, and a setup key opens nothing on the workspace MCP.
    const apiKey = (await act(ws.owner, 'apiKey.create', { name: 'Claude', role: 'admin' })).body.data.key
    expect((await mcp(apiKey, 'tools/list', {}, { bearer: true })).status).toBe(401)
    expect((await mcp(key, 'tools/list', {}, { bearer: true, path: '/mcp' })).status).toBe(401)
  })

  test('an expired key, or one whose creator is no longer an instance admin, stops working', async () => {
    const admin = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
    const made = await makeKey(admin)
    expect((await mcp(made.key, 'tools/list')).status).toBe(200)
    await setAdmin(admin, false)
    expect((await mcp(made.key, 'tools/list')).status).toBe(401)
    await setAdmin(admin, true)
    await db
      .update(agent_setup_keys)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, made.keyId))
    expect((await mcp(made.key, 'tools/list')).status).toBe(401)
  })

  test('too many refused keys from one address: 429, but a working key from there still gets in', async () => {
    const from = randomIp()
    for (let i = 0; i < 10; i++) expect((await mcp(`lds_wrong${i}`, 'tools/list', {}, { from })).status).toBe(401)
    expect((await mcp('lds_wrong-last', 'tools/list', {}, { from })).status).toBe(429)
    const { key } = await makeKey(ws.owner)
    expect((await mcp(key, 'tools/list', {}, { from })).status).toBe(200)
  })
})

describe('tools', () => {
  test('setup tools only: no users, admins, keys, impersonation or deleting', async () => {
    const { key } = await makeKey(ws.owner)
    const names: string[] = (await mcp(key, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)
    for (const name of ['setup_status', 'providers_list', 'workspace_create', 'forwarding_guide'])
      expect(names).toContain(name)
    for (const action of SETUP_ACTIONS) expect(names).toContain(action.replaceAll('.', '_'))
    for (const name of [
      'user_invite',
      'instanceAdmin_grant',
      'user_impersonate',
      'workspace_delete',
      'apiKey_create',
      'agentSetup_createKey',
      'membership_add',
      'call_delete',
    ])
      expect(names).not.toContain(name)
    expect((await call(key, 'apiKey_create', { name: 'x' })).body.error.message).toMatch(/not found/)
  })

  test('a fresh install: setup_status points at the providers, then the business; workspace_create makes it once', async () => {
    const { key } = await makeKey(fresh)
    const before = data(await call(key, 'setup_status')) as {
      next_step: string
      steps: { id: string; state: string; alias?: string; how?: string[] }[]
      app_links: Record<string, string>
      install: { public: boolean; place?: string; note?: string }
    }
    // The provider steps carry the group ids of Admin › Providers; the old names stay as aliases.
    expect(before.steps.map(s => s.id).slice(0, 5)).toEqual([
      'answering',
      'telephony',
      'email',
      'call-audio',
      'workspace',
    ])
    expect(before.steps.find(s => s.id === 'answering')?.alias).toBe('ai')
    expect(before.steps.find(s => s.id === 'call-audio')?.alias).toBe('livekit')
    // The same words as the app.
    expect(before.steps.slice(0, 4).map(s => s.state)).toEqual(['todo', 'todo', 'todo', 'todo'])
    expect((before.steps[0] as { detail?: string }).detail).toMatch(/^Not set up/)
    // The tests run on localhost: the agent hears that phone calls need a server, and how to move there.
    expect(before.install).toMatchObject({ public: false, place: 'this_computer' })
    expect(before.install.note).toContain('scripts/install.sh')
    // Only the next step carries its instructions.
    expect(before.steps.filter(s => s.how).map(s => s.id)).toEqual([before.next_step])
    expect(before.app_links.providers).toMatch(/#admin\/providers$/)
    // One link per group.
    expect(before.app_links.providers_email).toMatch(/#admin\/providers\/email$/)
    expect(before.app_links.providers_call_audio).toMatch(/#admin\/providers\/call-audio$/)
    expect(before.app_links.providers_sign_in).toMatch(/#admin\/providers\/sign-in$/)

    const made = data(await call(key, 'workspace_create', { name: 'Riverside Dental', timeZone: 'America/Chicago' }))
    expect(made).toMatchObject({ ok: true, workspace: { name: 'Riverside Dental' } })
    const again = await call(key, 'workspace_create', { name: 'Second' })
    expect(again.body.result.isError).toBe(true)
    const after = data(await call(key, 'setup_status')) as { steps: { id: string; state: string }[] }
    expect(after.steps.find(s => s.id === 'workspace')?.state).toBe('done')
    expect(after.steps.map(s => s.id)).toEqual(expect.arrayContaining(['business', 'pickup', 'notify', 'phone']))
  })

  test('workspace and provider tools run through the registry as the admin, in their own workspace', async () => {
    const { key } = await makeKey(ws.owner)
    expect(data(await call(key, 'workspace_updateSettings', { pickupMode: 'no_answer' }))).toMatchObject({ ok: true })
    const stored = await call(key, 'provider_setKeys', {
      provider: 'deepgram',
      values: { api_key: 'dg-test-key-1234' },
    })
    expect(data(stored)).toMatchObject({ ok: true })
    const [row] = await db.select().from(provider_settings).where(eq(provider_settings.provider, 'deepgram'))
    expect(row!.value_encrypted).not.toContain('dg-test-key-1234')
    expect(row!.updated_by).toBe(ws.owner.userId)
    const listed = data(await call(key, 'providers_list', { category: 'stt' })) as {
      providers: { provider: string; fields: { field: string; set: boolean }[] }[]
    }
    expect(listed.providers.find(p => p.provider === 'deepgram')?.fields).toContainEqual(
      expect.objectContaining({ field: 'api_key', set: true }),
    )
    expect(JSON.stringify(listed)).not.toContain('dg-test-key-1234')
    await db.delete(provider_settings).where(eq(provider_settings.provider, 'deepgram'))
  })

  test('email, sign-in and recording storage stay in the app', async () => {
    const { key } = await makeKey(ws.owner)
    for (const [name, args] of [
      ['provider_setKeys', { provider: 'resend', values: { api_key: 're_test_1234' } }],
      ['provider_setKeys', { provider: 's3', values: { bucket: 'elsewhere' } }],
      ['provider_clearKeys', { provider: 'smtp' }],
      ['provider_setActive', { category: 'recording', provider: 's3' }],
    ] as const) {
      const res = await call(key, name, args)
      expect(res.body.result.isError).toBe(true)
      expect(res.body.result.content[0].text).toMatch(/do this in the app/)
    }
    expect(await db.select().from(provider_settings).where(eq(provider_settings.provider, 'resend'))).toEqual([])
  })

  test('forwarding_guide gives the codes for a number in a forwarding mode', async () => {
    const { key } = await makeKey(ws.owner)
    await db.update(phone_numbers).set({ mode: 'forward_conditional' }).where(eq(phone_numbers.workspace_id, ws.id))
    const guide = data(await call(key, 'forwarding_guide', { carrier: 'Verizon' })) as {
      forward_to: string
      guides: { id: string; instructions: { on: { code: string }[] } }[]
    }
    expect(guide.forward_to).toBe(ws.number)
    expect(guide.guides[0]!.instructions.on[0]!.code).toContain(ws.number.slice(2))
  })
})
