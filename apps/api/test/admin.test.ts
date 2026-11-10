// The admin area: who gets in, what never leaves (secrets), and the rules of its actions.
// Instance admins and provider keys are global to the database, so every test that creates
// them lives in this one file (files run in parallel, tests in a file do not).
import { randomBytes } from 'node:crypto'
import { actions, REDACTED } from '@callfront/actions'
import { calls, commands, instance_settings, organization, provider_settings, session, user } from '@callfront/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { grantFirstUser, instanceAdminHooks, refuseUnverifiedAdminAddress } from '../src/instance-admin.ts'
import { telephonyProvider } from '../src/provider-settings.ts'
import {
  act,
  addMember,
  agent,
  anonymous,
  type Caller,
  createWorkspace,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

const SECRET = 'KEY-made-up-0123456789-abcd'
const adminRoutes = [
  '/v1/admin/workspaces',
  '/v1/admin/users',
  '/v1/admin/usage',
  '/v1/admin/providers',
  '/v1/admin/system',
] as const
const AGENT_ROUTE = '/v1/agent/provider-config'
const adminActions = [...actions.values()].filter(def => def.permission === 'instance:admin')

let home: Workspace // the operator's own workspace
let other: Workspace // a customer: its owner is no instance admin
let operator: User
let member: User // a member of `other`

const setAdmin = (who: User, instanceAdmin: boolean) =>
  db.update(user).set({ instanceAdmin }).where(eq(user.id, who.userId))
const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email
const signIn = async (who: User) =>
  request(
    anonymous,
    'POST',
    '/api/auth/sign-in/email',
    { email: await emailOf(who), password: 'test-password-1234' },
    { origin: 'http://localhost:5173', 'x-forwarded-for': randomIp() },
  )
const providers = async (who: Caller = operator) => (await request(who, 'GET', '/v1/admin/providers')).body
const fieldOf = async (provider: string, field: string) =>
  (await providers()).providers
    .find((p: { provider: string }) => p.provider === provider)
    .fields.find((f: { field: string }) => f.field === field)
const clearAll = async () => {
  await db.delete(provider_settings)
  await db.delete(instance_settings)
}

beforeAll(async () => {
  home = await createWorkspace('Callfront Operations')
  other = await createWorkspace('Brightwater Plumbing & Heating')
  operator = home.owner
  await setAdmin(operator, true)
  member = await addMember(other.id, 'member')
})

describe('access', () => {
  test('instance admin is not a workspace role: /v1/me shows it for the operator only', async () => {
    expect((await request(operator, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
    const owner = (await request(other.owner, 'GET', '/v1/me')).body
    expect(owner.role).toBe('owner')
    expect(owner.permissions).not.toContain('instance:admin')
    expect((await request(agent(home.id), 'GET', '/v1/me')).body.permissions).not.toContain('instance:admin')
  })

  test.each(adminRoutes)('GET %s: operator only', async path => {
    expect((await request(operator, 'GET', path)).status).toBe(200)
    expect(await request(other.owner, 'GET', path)).toMatchObject({
      status: 403,
      body: { ok: false, error: 'missing permission instance:admin' },
    })
    expect((await request(member, 'GET', path)).status).toBe(403)
    expect((await request(agent(other.id), 'GET', path)).status).toBe(403)
    expect((await request(agent(), 'GET', path)).status).toBe(403)
    expect((await request(anonymous, 'GET', path)).status).toBe(401)
  })

  test('the registry has the ten admin actions', () => {
    expect(adminActions.map(def => def.name).sort()).toEqual([
      'instanceAdmin.grant',
      'instanceAdmin.revoke',
      'provider.clearKeys',
      'provider.setActive',
      'provider.setKeys',
      'provider.test',
      'user.disable',
      'user.enable',
      'workspace.disable',
      'workspace.enable',
    ])
  })

  test.each(adminActions.map(def => def.name))(
    '%s: 403 for a workspace owner, a member and the agent, and nothing changes',
    async name => {
      const input = {
        provider: 'openai',
        category: 'llm',
        values: { api_key: SECRET },
        userId: operator.userId,
        workspaceId: home.id,
      }
      for (const who of [other.owner, member, agent(home.id), agent()]) {
        expect(await act(who, name, input), name).toMatchObject({
          status: 403,
          body: { ok: false, error: 'missing permission instance:admin' },
        })
      }
      expect((await request(anonymous, 'POST', `/v1/actions/${name}`, input)).status).toBe(401)
      expect(await db.select().from(provider_settings)).toEqual([])
      const [account] = await db.select().from(user).where(eq(user.id, operator.userId))
      expect(account).toMatchObject({ instanceAdmin: true, disabledAt: null })
      expect((await db.select().from(organization).where(eq(organization.id, home.id)))[0]?.disabledAt).toBeNull()
    },
  )

  test('an instance admin without a workspace reaches the admin area and nothing else', async () => {
    const loner = await signUp()
    expect((await request(loner, 'GET', '/v1/me')).status).toBe(401)
    await setAdmin(loner, true)
    expect((await request(loner, 'GET', '/v1/me')).body).toMatchObject({
      permissions: ['instance:admin'],
      workspace: null,
    })
    expect((await request(loner, 'GET', '/v1/admin/users')).status).toBe(200)
    expect((await act(loner, 'call.markDone', { callId: other.call.id })).status).toBe(403)
    expect((await request(loner, 'GET', '/v1/shape/calls?offset=-1')).status).toBe(404)
    await setAdmin(loner, false)
    expect((await request(loner, 'GET', '/v1/admin/users')).status).toBe(401)
  })
})

describe('provider keys', () => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level as 'log'))
  const logged = () => JSON.stringify(logs.flatMap(spy => spy.mock.calls))
  const envBefore = { ...process.env }
  afterEach(async () => {
    process.env = { ...envBefore }
    vi.unstubAllGlobals()
    await clearAll()
  })
  afterAll(() => logs.forEach(spy => spy.mockRestore()))

  test('a stored secret never comes back: not in a response, the command log, the table or a log line', async () => {
    const key = crypto.randomUUID()
    const set = await act(
      operator,
      'provider.setKeys',
      { provider: 'telnyx', values: { api_key: SECRET, public_key: 'cHVibGljLWtleQ==' } },
      key,
    )
    expect(set.status).toBe(200)
    expect(set.body.data.provider.fields).toMatchObject([
      {
        field: 'api_key',
        secret: true,
        source: 'app',
        last4: 'abcd',
        value: null,
        updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        updated_by: { id: operator.userId, name: 'Test User' },
      },
      { field: 'public_key', secret: false, source: 'app', last4: null, value: 'cHVibGljLWtleQ==' },
    ])
    const replay = await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_key: SECRET } }, key)
    const invalid = await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_secret: SECRET } })
    expect(invalid.status).toBe(422)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: `bad key ${SECRET}` }] }), { status: 500 })),
    )
    const tested = await act(operator, 'provider.test', { provider: 'telnyx' })
    expect(tested.body.data).toEqual({ ok: false, message: 'Telnyx answered HTTP 500' })

    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(command?.input).toEqual({ provider: 'telnyx', values: { api_key: REDACTED, public_key: REDACTED } })
    const stored = await db.select().from(provider_settings)
    expect(stored).toHaveLength(2)
    const everything = JSON.stringify([
      set.body,
      replay.body,
      invalid.body,
      tested.body,
      await providers(),
      (await request(operator, 'GET', '/v1/me')).body,
      await db.select().from(commands).where(eq(commands.actor_id, operator.userId)),
      stored,
    ])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(SECRET.slice(0, 12))
    expect(logged()).not.toContain(SECRET)
  })

  test('a short secret shows no last characters', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: 'short-key' } })
    expect(await fieldOf('deepgram', 'api_key')).toMatchObject({ source: 'app', last4: null })
  })

  test('the stored value wins, the environment is the fallback, and the agent gets the value in effect', async () => {
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: null, last4: null, updated_at: null })
    const config = () => request(agent(), 'GET', AGENT_ROUTE)
    // Nothing set up: the agent can start and gets nothing to work with yet.
    expect((await config()).body).toEqual({ stt: null, llm: null, tts: null })

    process.env.OPENAI_API_KEY = 'env-openai-key-0123456789'
    process.env.LLM_MODEL = 'model-from-env'
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'env', last4: null, value: null })
    expect(await fieldOf('openai', 'model')).toMatchObject({ source: 'env', value: 'model-from-env' })
    expect(JSON.stringify(await providers())).not.toContain('env-openai-key')
    expect((await config()).body).toEqual({
      stt: null,
      llm: { provider: 'openai', api_key: 'env-openai-key-0123456789', model: 'model-from-env' },
      tts: null,
    })

    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'app', last4: 'abcd' })
    expect((await config()).body.llm).toEqual({ provider: 'openai', api_key: SECRET, model: 'model-from-env' })

    expect((await act(operator, 'provider.clearKeys', { provider: 'openai' })).status).toBe(200)
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'env' })
    expect((await config()).body.llm.api_key).toBe('env-openai-key-0123456789')
  })

  test('per category one provider is active: the first that is set up, or the one the admin picks', async () => {
    const active = async () => (await providers()).active
    const config = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
    expect(await active()).toEqual({
      telephony: { provider: null, chosen: false },
      stt: { provider: null, chosen: false },
      llm: { provider: null, chosen: false },
      tts: { provider: null, chosen: false },
    })

    // Only OpenAI is set up: it is used although OpenRouter comes first in the registry.
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await active()).llm).toEqual({ provider: 'openai', chosen: false })
    // Both set up: the first one, OpenRouter, with its model.
    await act(operator, 'provider.setKeys', {
      provider: 'openrouter',
      values: { api_key: 'or-made-up-0123456789', model: 'vendor/model-1' },
    })
    expect((await active()).llm).toEqual({ provider: 'openrouter', chosen: false })
    expect((await config()).llm).toEqual({
      provider: 'openrouter',
      api_key: 'or-made-up-0123456789',
      model: 'vendor/model-1',
    })

    const picked = await act(operator, 'provider.setActive', { category: 'llm', provider: 'openai' })
    expect(picked.body.data.active.llm).toEqual({ provider: 'openai', chosen: true })
    expect((await config()).llm).toEqual({ provider: 'openai', api_key: SECRET, model: null })

    // A picked provider that is not set up gives the agent nothing, instead of silently using another one.
    await act(operator, 'provider.setActive', { category: 'tts', provider: 'elevenlabs' })
    await act(operator, 'provider.setKeys', {
      provider: 'cartesia',
      values: { api_key: 'cartesia-made-up-0123456789' },
    })
    expect((await active()).tts).toEqual({ provider: 'elevenlabs', chosen: true })
    expect((await config()).tts).toBeNull()

    expect((await act(operator, 'provider.setActive', { category: 'tts', provider: null })).status).toBe(200)
    expect((await config()).tts).toEqual({
      provider: 'cartesia',
      api_key: 'cartesia-made-up-0123456789',
      model: null,
      voice_id: null,
    })
    expect((await act(operator, 'provider.setActive', { category: 'tts', provider: 'deepgram' })).status).toBe(422)
  })

  test('the clear values go to the agent token only', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    for (const who of [operator, other.owner]) {
      const res = await request(who, 'GET', AGENT_ROUTE)
      expect(res).toMatchObject({ status: 403, body: { ok: false, error: 'missing permission agent' } })
      expect(JSON.stringify(res.body)).not.toContain(SECRET)
    }
    expect((await request(anonymous, 'GET', AGENT_ROUTE)).status).toBe(401)
    expect((await request(agent(undefined, 'wrong-token'), 'GET', AGENT_ROUTE)).status).toBe(401)
    expect((await request(agent(other.id), 'GET', AGENT_ROUTE)).body.llm).toMatchObject({
      provider: 'openai',
      api_key: SECRET,
    })
  })

  test('without SECRETS_KEY saving is refused with the reason, and nothing is stored', async () => {
    delete process.env.SECRETS_KEY
    const res = await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^SECRETS_KEY is not set, so keys cannot be stored/)
    expect(await db.select().from(provider_settings)).toEqual([])
    expect((await providers()).can_store).toBe(false)
    // The rejected command is logged too, redacted like an accepted one.
    const logged = await db.select().from(commands).where(eq(commands.actor_id, operator.userId))
    const rejected = logged.filter(c => c.rejected && c.action === 'provider.setKeys')
    expect(rejected.at(-1)?.input).toEqual({ provider: 'openai', values: { api_key: REDACTED } })
    expect(JSON.stringify(logged)).not.toContain(SECRET)
  })

  test('with another SECRETS_KEY the stored keys are reported as unreadable, not used and not leaked', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    process.env.SECRETS_KEY = randomBytes(32).toString('base64')
    const tested = await act(operator, 'provider.test', { provider: 'openai' })
    expect(tested.status).toBe(409)
    expect(tested.body.error).toMatch(/openai.api_key cannot be decrypted/)
    expect(await request(agent(), 'GET', AGENT_ROUTE)).toMatchObject({ status: 409, body: { ok: false } })
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'app', last4: 'abcd' })
  })

  test('test connection: ok, a rejected key, and keys that are not set; it is not logged as a command', async () => {
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(commands)
      .where(eq(commands.actor_id, operator.userId))
    expect((await act(operator, 'provider.test', { provider: 'cartesia' })).body.data).toEqual({
      ok: false,
      message: 'Not set: API key',
    })
    await act(operator, 'provider.setKeys', { provider: 'cartesia', values: { api_key: SECRET } })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await act(operator, 'provider.test', { provider: 'cartesia' })).body.data).toEqual({
      ok: true,
      message: 'Connected',
    })
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('x-api-key')).toBe(
      SECRET,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: `Invalid key ${SECRET}` }), { status: 401 })),
    )
    const rejected = await act(operator, 'provider.test', { provider: 'cartesia' })
    expect(rejected.body.data).toEqual({ ok: false, message: 'Cartesia rejected the key (HTTP 401)' })
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(commands)
      .where(eq(commands.actor_id, operator.userId))
    expect(after[0]!.n - before[0]!.n).toBe(1) // only setKeys
  })

  test('telephony: the provider picked in the admin area, else TELEPHONY_PROVIDER, else dev; keys from the app first', async () => {
    // Nothing set up: no carrier.
    expect((await telephonyProvider(db, {})).name).toBe('dev')
    // TELEPHONY_PROVIDER decides when set; dev means no carrier even with keys.
    expect((await telephonyProvider(db, { TELEPHONY_PROVIDER: 'dev', TELNYX_API_KEY: 'env-key' })).name).toBe('dev')
    await expect(telephonyProvider(db, { TELEPHONY_PROVIDER: 'twilio', TELNYX_API_KEY: 'env-key' })).rejects.toThrow(
      'TWILIO_ACCOUNT_SID',
    )
    await expect(telephonyProvider(db, { TELEPHONY_PROVIDER: 'telnyx' })).rejects.toThrow('TELNYX_API_KEY is not set')

    // Without TELEPHONY_PROVIDER the first carrier that is set up is used: Telnyx before Twilio.
    expect(
      (await telephonyProvider(db, { TWILIO_ACCOUNT_SID: 'ACmadeup', TWILIO_AUTH_TOKEN: 'made-up-token' })).name,
    ).toBe('twilio')
    await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_key: SECRET } })
    expect(
      (await telephonyProvider(db, { TWILIO_ACCOUNT_SID: 'ACmadeup', TWILIO_AUTH_TOKEN: 'made-up-token' })).name,
    ).toBe('telnyx')
    expect((await providers()).active.telephony).toEqual({ provider: 'telnyx', chosen: false })
    process.env.TELEPHONY_PROVIDER = 'dev'
    expect((await providers()).active.telephony).toEqual({ provider: null, chosen: false })
    // A pick in the admin area wins over the variable.
    await act(operator, 'provider.setActive', { category: 'telephony', provider: 'telnyx' })
    expect((await telephonyProvider(db, { TELEPHONY_PROVIDER: 'dev' })).name).toBe('telnyx')
  })

  test('without a pick, STT_PROVIDER, LLM_PROVIDER and TTS_PROVIDER name the provider, as for the agent', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openrouter', values: { api_key: 'or-made-up-0123456789' } })
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await providers()).active.llm).toEqual({ provider: 'openrouter', chosen: false })
    process.env.LLM_PROVIDER = 'openai'
    process.env.LLM_MODEL = 'gpt-made-up'
    expect((await providers()).active.llm).toEqual({ provider: 'openai', chosen: false })
    expect((await request(agent(), 'GET', AGENT_ROUTE)).body.llm).toEqual({
      provider: 'openai',
      api_key: SECRET,
      model: 'gpt-made-up',
    })
    // A named provider without keys gives the agent nothing rather than another provider.
    process.env.TTS_PROVIDER = 'cartesia'
    await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { api_key: 'el-made-up-0123456789' } })
    expect((await request(agent(), 'GET', AGENT_ROUTE)).body.tts).toBeNull()
    // A value from another category is ignored.
    process.env.STT_PROVIDER = 'openai'
    expect((await providers()).active.stt).toEqual({ provider: null, chosen: false })
  })

  test('LiveKit is not a provider: no keys in the app, only a status from the environment', async () => {
    expect(
      (await act(operator, 'provider.setKeys', { provider: 'livekit', values: { api_secret: SECRET } })).status,
    ).toBe(422)
    expect((await providers()).providers.map((p: { provider: string }) => p.provider)).toEqual([
      'telnyx',
      'twilio',
      'deepgram',
      'openrouter',
      'openai',
      'elevenlabs',
      'cartesia',
    ])
    process.env.LIVEKIT_URL = 'ws://livekit.env.test:7880'
    process.env.LIVEKIT_API_KEY = 'APImadeup'
    process.env.LIVEKIT_API_SECRET = 'made-up-livekit-secret-0123456789'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.includes('SIP') ? { items: [{}] } : { rooms: [] }), { status: 200 }),
      ),
    )
    const system = await request(operator, 'GET', '/v1/admin/system')
    expect(system.body).toEqual({
      livekit: {
        url: 'ws://livekit.env.test:7880',
        server: { ok: true, message: 'Reachable, 0 rooms open' },
        sip: { ok: true, message: '1 inbound trunk configured' },
      },
    })
    expect(JSON.stringify(system.body)).not.toContain('made-up-livekit-secret')
  })
})

describe('users', () => {
  test('the list shows workspaces, roles and sign-in, and nothing to sign in with', async () => {
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    const row = users.find((u: { id: string }) => u.id === other.owner.userId)
    expect(row).toMatchObject({
      name: 'Test User',
      instance_admin: false,
      disabled_at: null,
      workspaces: [{ id: other.id, name: 'Brightwater Plumbing & Heating', role: 'owner' }],
    })
    expect(Date.now() - Date.parse(row.last_sign_in_at)).toBeLessThan(120_000)
    expect(Date.now() - Date.parse(row.created_at)).toBeLessThan(120_000)
    for (const at of [row.created_at, row.last_sign_in_at]) expect(new Date(at).toISOString()).toBe(at)
    expect(users.find((u: { id: string }) => u.id === operator.userId)).toMatchObject({
      instance_admin: true,
      instance_admin_by_env: false,
    })
    expect(Object.keys(row).sort()).toEqual([
      'created_at',
      'disabled_at',
      'email',
      'id',
      'instance_admin',
      'instance_admin_by_env',
      'last_sign_in_at',
      'name',
      'workspaces',
    ])
  })

  test('a disabled user is signed out and cannot sign in until enabled again', async () => {
    const ws = await createWorkspace('Disabled User Workspace')
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(200)
    expect((await act(operator, 'user.disable', { userId: ws.owner.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toEqual([])
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(401)
    const refused = await signIn(ws.owner)
    expect(refused).toMatchObject({ status: 403, body: { message: 'This account is disabled.' } })
    expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toEqual([])
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    expect(users.find((u: { id: string }) => u.id === ws.owner.userId).disabled_at).toEqual(expect.any(String))

    expect((await act(operator, 'user.enable', { userId: ws.owner.userId })).status).toBe(200)
    expect((await signIn(ws.owner)).status).toBe(200)
  })

  test('every sign-in method is blocked for a disabled user: the session hook refuses it', async () => {
    // Password, email link and provider sign-ins all create a session through this hook.
    const ws = await createWorkspace('Hook Workspace')
    await act(operator, 'user.disable', { userId: ws.owner.userId })
    await expect(instanceAdminHooks.session.create.before({ userId: ws.owner.userId })).rejects.toThrow(
      'This account is disabled.',
    )
    await act(operator, 'user.enable', { userId: ws.owner.userId })
    await expect(instanceAdminHooks.session.create.before({ userId: ws.owner.userId })).resolves.toBeUndefined()
  })

  test('nobody disables themselves, and unknown users are rejected', async () => {
    expect(await act(operator, 'user.disable', { userId: operator.userId })).toMatchObject({
      status: 409,
      body: { error: 'you cannot disable your own account' },
    })
    expect(await act(operator, 'user.disable', { userId: 'user_missing' })).toMatchObject({
      status: 409,
      body: { error: 'user not found' },
    })
    expect((await request(operator, 'GET', '/v1/me')).status).toBe(200)
  })
})

describe('workspaces', () => {
  test('the list counts members, numbers, calls and minutes across workspaces', async () => {
    await db.update(calls).set({ status: 'completed', duration_sec: 150 }).where(eq(calls.id, other.call.id))
    const { workspaces } = (await request(operator, 'GET', '/v1/admin/workspaces')).body
    const row = workspaces.find((w: { id: string }) => w.id === other.id)
    expect(row).toMatchObject({
      name: 'Brightwater Plumbing & Heating',
      disabled_at: null,
      members: 2,
      phone_numbers: [other.number],
      calls_30d: 1,
      minutes_this_month: 2.5,
    })
    expect(row.last_call_at).toBe(new Date(other.call.started_at).toISOString())
    expect(new Date(row.created_at).toISOString()).toBe(row.created_at)
    expect(workspaces.some((w: { id: string }) => w.id === home.id)).toBe(true)

    const { usage, months } = (await request(operator, 'GET', '/v1/admin/usage')).body
    expect(months).toBe(6)
    expect(usage.find((u: { workspace_id: string }) => u.workspace_id === other.id)).toEqual({
      workspace_id: other.id,
      workspace_name: 'Brightwater Plumbing & Heating',
      month: new Date().toISOString().slice(0, 7),
      calls: 1,
      minutes: 2.5,
    })
  })

  test('in a disabled workspace members keep reading but cannot write or change settings', async () => {
    const ws = await createWorkspace('Read Only Workspace')
    const before = (await request(ws.owner, 'GET', '/v1/me')).body
    expect(before.workspace.disabled).toBe(false)
    expect(before.permissions).toContain('settings:write')

    await act(operator, 'workspace.disable', { workspaceId: ws.id })
    const me = (await request(ws.owner, 'GET', '/v1/me')).body
    expect(me.workspace).toMatchObject({ id: ws.id, disabled: true })
    expect(me.permissions.every((p: string) => p.endsWith(':read'))).toBe(true)
    expect(await act(ws.owner, 'call.markDone', { callId: ws.call.id })).toMatchObject({ status: 403 })
    expect(
      await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'still here' }),
    ).toMatchObject({ status: 403 })
    expect(await act(ws.owner, 'phoneNumber.setup', { areaCode: '503' })).toMatchObject({ status: 403 })
    // Reads stay: a read action still runs (here it finds no such appointment type, which is not a 403).
    expect(await act(ws.owner, 'calendar.findSlots', { appointmentTypeId: 'at_missing' })).toMatchObject({
      status: 409,
    })

    await act(operator, 'workspace.enable', { workspaceId: ws.id })
    expect((await act(ws.owner, 'call.markDone', { callId: ws.call.id })).status).toBe(200)
  })

  test('calls to a number of a disabled workspace are not answered', async () => {
    const ws = await createWorkspace('Disabled Workspace')
    const start = () => act(agent(), 'call.start', { from: '+15035550100', to: ws.number })
    const callCount = async () => (await db.select().from(calls).where(eq(calls.workspace_id, ws.id))).length
    expect((await act(operator, 'workspace.disable', { workspaceId: ws.id })).status).toBe(200)
    expect(await start()).toMatchObject({
      status: 409,
      body: { ok: false, error: `the workspace of ${ws.number} is disabled` },
    })
    expect(await callCount()).toBe(1) // the fixture call, nothing new
    const { workspaces } = (await request(operator, 'GET', '/v1/admin/workspaces')).body
    expect(workspaces.find((w: { id: string }) => w.id === ws.id).disabled_at).toEqual(expect.any(String))
    // Other workspaces are not affected.
    expect((await act(agent(), 'call.start', { from: '+15035550100', to: other.number })).status).toBe(200)

    expect((await act(operator, 'workspace.enable', { workspaceId: ws.id })).status).toBe(200)
    expect((await start()).status).toBe(200)
    expect(await callCount()).toBe(2)
    expect(await act(operator, 'workspace.disable', { workspaceId: 'org_missing' })).toMatchObject({
      status: 409,
      body: { error: 'workspace not found' },
    })
  })
})

describe('instance admins', () => {
  afterEach(() => {
    process.env.INSTANCE_ADMIN_EMAILS = ''
  })

  test('the last instance admin cannot be revoked or disabled', async () => {
    const second = other.owner
    expect(await act(operator, 'instanceAdmin.revoke', { userId: operator.userId })).toMatchObject({
      status: 409,
      body: { error: 'the last instance admin cannot be revoked' },
    })
    expect((await act(operator, 'instanceAdmin.grant', { userId: second.userId })).status).toBe(200)
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(200)

    // With two, either can go. Then the one who is left stays.
    expect((await act(second, 'instanceAdmin.revoke', { userId: operator.userId })).status).toBe(200)
    expect((await request(operator, 'GET', '/v1/admin/users')).status).toBe(403)
    expect(await act(second, 'instanceAdmin.revoke', { userId: second.userId })).toMatchObject({
      status: 409,
      body: { error: 'the last instance admin cannot be revoked' },
    })
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(200)

    // A disabled admin does not count as one who remains.
    expect((await act(second, 'instanceAdmin.grant', { userId: operator.userId })).status).toBe(200)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, operator.userId))
    expect((await act(second, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(409)
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, operator.userId))

    expect((await act(operator, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(200)
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  test('INSTANCE_ADMIN_EMAILS applies to an existing account once its address is verified; the app cannot revoke it', async () => {
    // A password account from before the variable was set: its address is not verified.
    const ws = await createWorkspace('Env Admin Workspace')
    process.env.INSTANCE_ADMIN_EMAILS = ` someone@else.test, ${(await emailOf(ws.owner)).toUpperCase()} `
    // Anyone can sign up with any address, so an unverified one grants nothing.
    expect((await request(ws.owner, 'GET', '/v1/admin/users')).status).toBe(403)
    const unverified = (await request(operator, 'GET', '/v1/admin/users')).body.users.find(
      (u: { id: string }) => u.id === ws.owner.userId,
    )
    expect(unverified).toMatchObject({ instance_admin: false, instance_admin_by_env: false })

    await db.update(user).set({ emailVerified: true }).where(eq(user.id, ws.owner.userId))
    const list = await request(ws.owner, 'GET', '/v1/admin/users')
    expect(list.status).toBe(200)
    expect(list.body.users.find((u: { id: string }) => u.id === ws.owner.userId)).toMatchObject({
      instance_admin: true,
      instance_admin_by_env: true,
    })
    expect((await request(ws.owner, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
    const revoke = await act(operator, 'instanceAdmin.revoke', { userId: ws.owner.userId })
    expect(revoke.status).toBe(409)
    expect(revoke.body.error).toMatch(/through INSTANCE_ADMIN_EMAILS/)

    process.env.INSTANCE_ADMIN_EMAILS = ''
    expect((await request(ws.owner, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  test('nobody can sign up by password for a listed address, so nobody can take it over later', async () => {
    const email = `operator-${crypto.randomUUID().slice(0, 8)}@callfront.test`
    process.env.INSTANCE_ADMIN_EMAILS = email.toUpperCase()
    const signUpAs = (address: string) =>
      request(
        anonymous,
        'POST',
        '/api/auth/sign-up/email',
        { name: 'Not The Operator', email: address, password: 'test-password-1234' },
        { origin: 'http://localhost:5173', 'x-forwarded-for': randomIp() },
      )
    const refused = await signUpAs(email)
    expect(refused.status).toBe(403)
    expect(refused.body.message).toMatch(/reserved for an administrator/)
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([])
    expect((await signUpAs(`someone-${crypto.randomUUID().slice(0, 8)}@callfront.test`)).status).toBe(200)
    // A verified address (email link, sign-in provider) may be created.
    await expect(refuseUnverifiedAdminAddress(db, { email, emailVerified: true })).resolves.toBeUndefined()
  })

  test('the first user of an install becomes instance admin, later ones do not', async () => {
    class Rollback extends Error {}
    await db
      .transaction(async tx => {
        // An empty user table for this transaction only: the temporary table hides the real one.
        await tx.execute(sql`create temp table "user" (like public."user" including defaults) on commit drop`)
        const add = async (id: string) => {
          await tx.insert(user).values({ id, name: id, email: `${id}@callfront.test` })
          await grantFirstUser(tx, id)
        }
        await add('first')
        await add('second')
        const rows = await tx
          .select({ id: user.id, instanceAdmin: user.instanceAdmin })
          .from(user)
          .orderBy(user.createdAt)
        expect(rows).toEqual([
          { id: 'first', instanceAdmin: true },
          { id: 'second', instanceAdmin: false },
        ])
        throw new Rollback()
      })
      .catch(e => {
        if (!(e instanceof Rollback)) throw e
      })
  })
})
