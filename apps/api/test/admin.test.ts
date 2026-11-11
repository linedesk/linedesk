// The admin area: who gets in, what never leaves (secrets), and the rules of its actions.
// Instance admins and provider keys are global to the database, so every test that creates
// them lives in this one file (files run in parallel, tests in a file do not).
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actions, REDACTED, recordingKey } from '@linedesk/actions'
import { auth_events, calls, commands, instance_settings, invitation, member as memberTable, organization, passkey, provider_settings, session, user } from '@linedesk/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { adminSignInEmail, alertOnAdminSignIn, plainSnippet } from '../src/admin-alerts.ts'
import { adminHandlers } from '../src/admin-handlers.ts'
import { adminSecondFactorGap, adminSecondFactorRequired, markPasskeySession, secondFactorOffWarning } from '../src/admin-second-factor.ts'
import { mayReceiveEnrolmentCode } from '../src/admin-step-up.ts'
import type { Actor } from '../src/context.ts'
import { runAction } from '../src/run-action.ts'
import { signInMethod } from '../src/audit.ts'
import { emailSender } from '../src/email.ts'
import { db } from '../src/db.ts'
import { mapOidcProfile } from '../src/account-linking.ts'
import { APIError } from 'better-auth/api'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { mayRunWhileImpersonating } from '../src/impersonation-guard.ts'
import { createAdminWithPassword, grantFirstUser, instanceAdminHooks, refuseUnverifiedAdminAddress } from '../src/instance-admin.ts'
import { issuePasskeyEnrolment } from '../src/passkey-enrolment.ts'
import { mayCreateUser } from '../src/signup-gate.ts'
import { telephonyProvider } from '../src/provider-settings.ts'
import { deleteExpiredRecordings } from '../src/recording-retention.ts'
import { recordingStoreCache } from '../src/recording-store.ts'
import { costEstimate } from '../src/admin-overview.ts'
import { setJobQueue, SPENDING_CAP_ALERT } from '../src/jobs.ts'
import { sendSpendingAlert } from '../src/spending-cap.ts'
import { TEST_CALLS_OVER_CAP } from '../src/test-call.ts'
import { fakeS3 } from './fake-s3.ts'
import {
  act,
  addMember,
  appRequest,
  agent,
  anonymous,
  type Caller,
  createWorkspace,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
  FROM,
  getCall,
} from './helpers.ts'

const SECRET = 'KEY-made-up-0123456789-abcd'
const adminRoutes = [
  '/v1/admin/workspaces',
  '/v1/admin/users',
  '/v1/admin/usage',
  '/v1/admin/providers',
  '/v1/admin/system',
  '/v1/admin/overview',
  '/v1/admin/health',
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
    { origin: 'http://localhost:5173', [FROM]: randomIp() },
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
  home = await createWorkspace('Linedesk Operations')
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

  test('the registry has the twenty admin actions', () => {
    expect(adminActions.map(def => def.name).sort()).toEqual([
      'instanceAdmin.grant',
      'instanceAdmin.revoke',
      'invitation.resend',
      'invitation.revoke',
      'membership.add',
      'membership.remove',
      'membership.setRole',
      'provider.clearKeys',
      'provider.setActive',
      'provider.setKeys',
      'provider.test',
      'user.disable',
      'user.enable',
      'user.impersonate',
      'user.invite',
      'user.resetPasskeys',
      'voiceCloning.get',
      'voiceCloning.set',
      'workspace.disable',
      'workspace.enable',
      'workspace.setSpendingCap',
    ])
  })

  // user.impersonate only runs through its own route: see describe('impersonation').
  test.each(adminActions.map(def => def.name).filter(name => name !== 'user.impersonate'))(
    '%s: 403 for a workspace owner, a member and the agent, and nothing changes',
    async name => {
      const input = {
        provider: 'openai',
        category: 'llm',
        values: { api_key: SECRET },
        userId: operator.userId,
        workspaceId: home.id,
        role: 'owner',
        memberId: 'any',
        invitationId: 'any',
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

  test('with sign-up closed, an instance admin still creates a workspace; anyone else is refused', async () => {
    const loner = await signUp()
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    try {
      expect((await request(loner, 'POST', '/v1/workspaces', { name: 'Not Allowed Yet' })).body).toMatchObject({ code: 'workspace_creation_closed' })
      await setAdmin(loner, true)
      const created = await request(loner, 'POST', '/v1/workspaces', { name: 'Operator Workspace' })
      expect(created).toMatchObject({ status: 200, body: { ok: true, workspace: { name: 'Operator Workspace' } } })
    } finally {
      process.env.AUTH_SIGNUP_ENABLED = 'true'
      await setAdmin(loner, false)
    }
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
    expect((await config()).body).toEqual({ stt: null, llm: null, tts: null, tts_providers: [], recording: null })

    process.env.OPENAI_API_KEY = 'env-openai-key-0123456789'
    process.env.LLM_MODEL = 'model-from-env'
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'env', last4: null, value: null })
    expect(await fieldOf('openai', 'model')).toMatchObject({ source: 'env', value: 'model-from-env' })
    expect(JSON.stringify(await providers())).not.toContain('env-openai-key')
    expect((await config()).body).toEqual({
      stt: null,
      llm: { provider: 'openai', api_key: 'env-openai-key-0123456789', model: 'model-from-env', summary_model: null },
      tts: null,
      tts_providers: [],
      recording: null,
    })

    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'app', last4: 'abcd' })
    expect((await config()).body.llm).toEqual({
      provider: 'openai',
      api_key: SECRET,
      model: 'model-from-env',
      summary_model: null,
    })

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
      recording: { provider: null, chosen: false },
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
      summary_model: null,
    })

    const picked = await act(operator, 'provider.setActive', { category: 'llm', provider: 'openai' })
    expect(picked.body.data.active.llm).toEqual({ provider: 'openai', chosen: true })
    expect((await config()).llm).toEqual({ provider: 'openai', api_key: SECRET, model: null, summary_model: null })

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

  test("a workspace's own carrier is refused while the install's carrier keys cannot be read: the same-account check cannot run", async () => {
    const sid = `AC${'c3'.repeat(16)}`
    await act(operator, 'provider.setKeys', { provider: 'twilio', values: { account_sid: sid, auth_token: SECRET } })
    process.env.SECRETS_KEY = randomBytes(32).toString('base64')
    const res = await act({ headers: { ...other.owner.headers, 'x-workspace-id': other.id } }, 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: `AC${'d4'.repeat(16)}`, auth_token: 'workspace-token-0123456789' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Your carrier account cannot be checked against this Linedesk right now. Ask whoever runs your Linedesk.')
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
      summary_model: null,
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
      'file',
      's3',
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

describe('recording storage', () => {
  const S3_SECRET = 's3-secret-made-up-0123456789'
  const s3Keys = {
    endpoint: 'https://s3.test',
    region: 'auto',
    bucket: 'calls',
    access_key_id: 'AKIA-made-up-key-id',
    secret_access_key: S3_SECRET,
    prefix: 'linedesk',
  }
  const envBefore = { ...process.env }
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'linedesk-recording-admin-'))
  })
  afterEach(async () => {
    process.env = { ...envBefore }
    vi.unstubAllGlobals()
    await clearAll()
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  const agentConfig = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
  const recordingOn = async (who: Caller = home.owner) =>
    (await act(who, 'workspace.getSettings', {})).body.data.recordingOn
  /** A finished call of `home` with a recording in `store` (null: recorded before stores were per call). */
  async function recordedCall(store: 'file' | 's3' | null) {
    const id = `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    const key = recordingKey(home.id, id)
    await db.insert(calls).values({
      id,
      workspace_id: home.id,
      from_number: '+15035550100',
      to_number: home.number,
      status: 'completed',
      recording_key: key,
      recording_store: store,
    })
    if (store !== 's3') {
      await mkdir(join(dir, home.id), { recursive: true })
      await writeFile(join(dir, key), `audio of ${id}`)
    }
    return { id, key }
  }
  const play = (callId: string) => appRequest(`/v1/calls/${callId}/recording`, { headers: home.owner.headers })

  test('off until a store is picked or RECORDING_STORE names one; the local disk needs no keys', async () => {
    expect((await providers()).active.recording).toEqual({ provider: null, chosen: false })
    expect((await agentConfig()).recording).toBeNull()
    expect(await recordingOn()).toBe(false)

    process.env.RECORDING_STORE = 'file'
    expect((await providers()).active.recording).toEqual({ provider: 'file', chosen: false })
    expect((await agentConfig()).recording).toEqual({ provider: 'file' })
    expect(await recordingOn()).toBe(true)

    delete process.env.RECORDING_STORE
    expect((await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })).status).toBe(200)
    expect((await agentConfig()).recording).toEqual({ provider: 'file' })
    expect(await recordingOn()).toBe(true)
    expect((await act(operator, 'provider.setActive', { category: 'recording', provider: 'openai' })).status).toBe(422)
  })

  test('S3 settings: the stored value wins over S3_*, the env is the fallback; a picked S3 that is not set up records nothing', async () => {
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    expect((await agentConfig()).recording).toBeNull()

    Object.assign(process.env, {
      S3_ENDPOINT: 'https://env.s3.test',
      S3_BUCKET: 'env-bucket',
      S3_ACCESS_KEY_ID: 'env-key-id',
      S3_SECRET_ACCESS_KEY: 'env-secret-0123456789',
    })
    expect((await agentConfig()).recording).toEqual({
      provider: 's3',
      endpoint: 'https://env.s3.test',
      region: null,
      bucket: 'env-bucket',
      access_key_id: 'env-key-id',
      prefix: null,
      force_path_style: null,
    })
    expect(await fieldOf('s3', 'secret_access_key')).toMatchObject({ source: 'env', value: null, last4: null })

    expect((await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })).status).toBe(200)
    const { secret_access_key: _secret, ...withoutSecret } = s3Keys
    expect((await agentConfig()).recording).toEqual({ provider: 's3', ...withoutSecret, force_path_style: null })
    expect(await fieldOf('s3', 'bucket')).toMatchObject({ source: 'app', value: 'calls' })
    expect(await fieldOf('s3', 'secret_access_key')).toMatchObject({ source: 'app', value: null, last4: '6789' })
  })

  test('the S3 secret stays with the API: not to the agent, members or the command log', async () => {
    const key = crypto.randomUUID()
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys }, key)
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    for (const who of [operator, other.owner, member]) {
      const res = await request(who, 'GET', AGENT_ROUTE)
      expect(res.status).toBe(403)
      expect(JSON.stringify(res.body)).not.toContain(S3_SECRET)
    }
    expect(JSON.stringify(await providers())).not.toContain(S3_SECRET)
    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(JSON.stringify(command?.input)).not.toContain(S3_SECRET)
    expect(JSON.stringify(await db.select().from(provider_settings))).not.toContain(S3_SECRET)
    expect((await agentConfig()).recording).toMatchObject({ provider: 's3', bucket: s3Keys.bucket })
    expect(JSON.stringify(await agentConfig())).not.toContain(S3_SECRET)
  })

  test('setKeys checks the switch, the endpoint and the prefix without echoing them', async () => {
    const wrong = [{ force_path_style: 'yes' }, { endpoint: `ftp://${S3_SECRET}` }, { prefix: `../${S3_SECRET}` }]
    for (const values of wrong) {
      const res = await act(operator, 'provider.setKeys', { provider: 's3', values })
      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body)).not.toContain(S3_SECRET)
    }
    expect(
      (await act(operator, 'provider.setKeys', { provider: 's3', values: { force_path_style: 'false' } })).status,
    ).toBe(200)
  })

  test('test connection: puts, reads back and deletes an object; a refusal names the step, never a key', async () => {
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    const s3 = fakeS3()
    vi.stubGlobal('fetch', s3.fetch)
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data).toEqual({
      ok: true,
      message: 'Connected',
    })
    expect(s3.log.map(([method]) => method)).toEqual(['PUT', 'GET', 'DELETE'])
    expect(s3.log[0]![1]).toMatch(/^https:\/\/s3\.test\/calls\/linedesk\/\.linedesk-probe-/)
    expect(s3.objects.size).toBe(0)

    vi.stubGlobal('fetch', fakeS3({ status: 403, code: 'SignatureDoesNotMatch' }).fetch)
    const refused = (await act(operator, 'provider.test', { provider: 's3' })).body.data
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe('Keys rejected (HTTP 403)')
    expect(refused.message).not.toContain(s3Keys.access_key_id)

    vi.stubGlobal('fetch', fakeS3({ status: 404, code: 'NoSuchBucket' }).fetch)
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data.message).toBe('Bucket not found')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed', { cause: { message: `bad ${S3_SECRET}` } }))),
    )
    const unreachable = (await act(operator, 'provider.test', { provider: 's3' })).body.data
    expect(unreachable).toEqual({ ok: false, message: 'Could not reach the storage: bad [redacted]' })

    await act(operator, 'provider.clearKeys', { provider: 's3' })
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data.message).toBe(
      'Not set: Endpoint URL, Bucket, Access key ID, Secret access key',
    )

    process.env.RECORDINGS_DIR = join(dir, 'probe')
    const file = (await act(operator, 'provider.test', { provider: 'file' })).body.data
    expect(file).toEqual({ ok: true, message: 'Connected' })
  })

  test('after switching to S3, older recordings still play from the local disk; new ones from the bucket', async () => {
    process.env.RECORDINGS_DIR = dir
    const fileCall = await recordedCall('file')
    const legacyCall = await recordedCall(null) // RECORDING_STORE is unset: the local disk
    await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })
    expect((await play(fileCall.id)).status).toBe(200)

    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    expect((await agentConfig()).recording.provider).toBe('s3')
    for (const old of [fileCall, legacyCall]) {
      const res = await play(old.id)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`audio of ${old.id}`)
    }
    const s3Call = await recordedCall('s3')
    const res = await play(s3Call.id)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(`https://s3.test/calls/linedesk/${s3Call.key}`)
    expect(location.search).not.toContain(S3_SECRET)

    // Switching back leaves the S3 recording playable from the bucket.
    await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })
    expect((await play(s3Call.id)).status).toBe(302)
  })

  test('the agent says which store it recorded into; an agent that does not leaves it to RECORDING_STORE', async () => {
    const call = await recordedCall(null)
    await db.update(calls).set({ recording_key: null }).where(eq(calls.id, call.id))
    const set = await act(agent(home.id), 'call.setRecording', { callId: call.id, store: 's3' })
    expect(set.body.rows.calls[0]).toMatchObject({ recording_key: call.key, recording_store: 's3' })
    await act(agent(home.id), 'call.setRecording', { callId: call.id })
    expect((await db.select().from(calls).where(eq(calls.id, call.id)))[0]?.recording_store).toBeNull()
    expect((await act(agent(home.id), 'call.setRecording', { callId: call.id, store: 'ftp' })).status).toBe(422)
  })

  test('retention deletes each recording from the store it is in', async () => {
    process.env.RECORDINGS_DIR = dir
    const fileCall = await recordedCall('file')
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    const s3 = fakeS3()
    vi.stubGlobal('fetch', s3.fetch)
    const s3Call = await recordedCall('s3')
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
    await db
      .update(calls)
      .set({ started_at: old, ended_at: old })
      .where(inArray(calls.id, [fileCall.id, s3Call.id]))
    // Only ours: recordings of test files running alongside fail here and keep their key.
    const real = recordingStoreCache(db)
    const ours = new Set([fileCall.key, s3Call.key])
    const deleted: [string | null, string][] = []
    const storeFor = async (name: 'file' | 's3' | null) => {
      const store = await real(name)
      return {
        ...store,
        delete: async (key: string) => {
          if (!ours.has(key)) throw new Error('a recording of another test file')
          deleted.push([name, key])
          await store.delete(key)
        },
      }
    }
    for (let i = 0; i < 5 && deleted.length < 2; i++) await deleteExpiredRecordings(db, storeFor)
    expect(deleted.sort()).toEqual([
      ['file', fileCall.key],
      ['s3', s3Call.key],
    ])
    expect(s3.log).toContainEqual(['DELETE', `https://s3.test/calls/linedesk/${s3Call.key}`])
    expect(await readdir(join(dir, home.id))).not.toContain(fileCall.key.split('/')[1])
    const rows = await db
      .select()
      .from(calls)
      .where(inArray(calls.id, [fileCall.id, s3Call.id]))
    expect(rows.map(r => [r.recording_key, r.recording_store])).toEqual([
      [null, null],
      [null, null],
    ])
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
      'invitations',
      'last_sign_in_at',
      'name',
      // Name, device type and date only: never a credential id or key.
      'passkeys',
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
    // Reading, and answering invitations to other workspaces.
    expect(me.permissions.every((p: string) => p.endsWith(':read') || p === 'invitation:respond')).toBe(true)
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

describe('overview', () => {
  test('counts calls, minutes and people, and estimates cost per provider in use', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(before.costs.map((c: { category: string }) => c.category)).toEqual(['telephony', 'stt', 'llm', 'tts'])
    const [call] = await db
      .insert(calls)
      .values({
        id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        workspace_id: home.id,
        from_number: '+15035550100',
        to_number: home.number,
        status: 'completed',
        duration_sec: 600,
      })
      .returning()
    const after = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(after.calls.today).toBe(before.calls.today + 1)
    expect(after.calls.last7d).toBe(before.calls.last7d + 1)
    expect(after.minutes.last7d).toBeCloseTo(before.minutes.last7d + 10, 1)
    expect(after.workspaces.total).toBeGreaterThanOrEqual(2)
    expect(after.users.total).toBeGreaterThanOrEqual(3)
    for (const cost of after.costs) {
      if (cost.provider) expect(cost.cost7d).toBeGreaterThanOrEqual(0)
      else expect(cost).toMatchObject({ provider: null, cost7d: 0, costMonth: 0 })
    }
    await db.delete(calls).where(eq(calls.id, call!.id))
  })

  test('sample calls are not usage: not in calls, minutes or the workspace list', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/overview')).body
    const listed = async () =>
      ((await request(operator, 'GET', '/v1/admin/workspaces')).body.workspaces as { id: string; calls_30d: number }[]).find(
        w => w.id === home.id,
      )!.calls_30d
    const listedBefore = await listed()
    const [sample] = await db
      .insert(calls)
      .values({
        id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        workspace_id: home.id,
        from_number: '+15035550100',
        to_number: home.number,
        status: 'completed',
        source: 'sample',
        duration_sec: 600,
      })
      .returning()
    const after = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(after.calls).toEqual(before.calls)
    expect(after.minutes).toEqual(before.minutes)
    expect(await listed()).toBe(listedBefore)
    await db.delete(calls).where(eq(calls.id, sample!.id))
  })

  test('health names each part; the agent shows up once it has asked for its settings', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/health')).body
    expect(Object.keys(before).sort()).toEqual(['agent', 'api', 'email', 'livekit', 'sip'])
    expect(before.api.ok).toBe(true)
    await request(agent(), 'GET', AGENT_ROUTE)
    expect((await request(operator, 'GET', '/v1/admin/health')).body.agent).toMatchObject({ ok: true })
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
    const ws = await createWorkspace('Env Admin Workspace', false)
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
    const email = `operator-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    process.env.INSTANCE_ADMIN_EMAILS = email.toUpperCase()
    const signUpAs = (address: string) =>
      request(
        anonymous,
        'POST',
        '/api/auth/sign-up/email',
        { name: 'Not The Operator', email: address, password: 'test-password-1234' },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    const refused = await signUpAs(email)
    expect(refused.status).toBe(403)
    expect(refused.body.message).toMatch(/reserved for an administrator/)
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([])
    expect((await signUpAs(`someone-${crypto.randomUUID().slice(0, 8)}@linedesk.test`)).status).toBe(200)
    // A verified address (email link, sign-in provider) may be created.
    await expect(refuseUnverifiedAdminAddress(db, { email, emailVerified: true })).resolves.toBeUndefined()
  })

  test('the first user of an install becomes instance admin only when INSTANCE_ADMIN_EMAILS lists their proven address (security L2)', async () => {
    class Rollback extends Error {}
    const firstOf = async (created: { id: string; email: string; emailVerified: boolean }) => {
      let admin = false
      await db
        .transaction(async tx => {
          // An empty user table for this transaction only: the temporary table hides the real one.
          await tx.execute(sql`create temp table "user" (like public."user" including defaults) on commit drop`)
          await tx.insert(user).values({ id: created.id, name: created.id, email: created.email })
          await grantFirstUser(tx, created)
          await tx.insert(user).values({ id: 'second', name: 'second', email: 'second@linedesk.test' })
          await grantFirstUser(tx, { id: 'second', email: 'second@linedesk.test', emailVerified: true })
          const rows = await tx.select({ id: user.id, instanceAdmin: user.instanceAdmin }).from(user)
          admin = rows.find(r => r.id === created.id)!.instanceAdmin
          expect(rows.find(r => r.id === 'second')!.instanceAdmin).toBe(false)
          throw new Rollback()
        })
        .catch(e => {
          if (!(e instanceof Rollback)) throw e
        })
      return admin
    }
    // Nobody listed: whoever reaches a fresh install first gets no admin.
    expect(await firstOf({ id: 'first', email: 'first@linedesk.test', emailVerified: true })).toBe(false)
    process.env.INSTANCE_ADMIN_EMAILS = 'operator@linedesk.test'
    expect(await firstOf({ id: 'first', email: 'someone@linedesk.test', emailVerified: true })).toBe(false)
    expect(await firstOf({ id: 'first', email: 'operator@linedesk.test', emailVerified: false })).toBe(false)
    expect(await firstOf({ id: 'first', email: 'Operator@linedesk.test', emailVerified: true })).toBe(true)
  })

  test('closed sign-up on an empty install: only the listed address may create the first account (security L2)', async () => {
    class RollbackOnly extends Error {}
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`create temp table "user" (like public."user" including defaults) on commit drop`)
        expect(await mayCreateUser(tx, 'stranger@linedesk.test', true)).toBe(false)
        process.env.INSTANCE_ADMIN_EMAILS = 'operator@linedesk.test'
        expect(await mayCreateUser(tx, 'operator@linedesk.test', true)).toBe(true)
        expect(await mayCreateUser(tx, 'operator@linedesk.test', false)).toBe(false)
        throw new RollbackOnly()
      }).catch(e => {
        if (!(e instanceof RollbackOnly)) throw e
      })
    } finally {
      process.env.AUTH_SIGNUP_ENABLED = 'true'
    }
  })

  test('disabling or revoking an admin ends the impersonations they started at once (security L5)', async () => {
    const second = await signUp()
    await setAdmin(second, true)
    const impersonated = await signUp()
    const [started] = await db.select().from(session).where(eq(session.userId, impersonated.userId))
    await db.update(session).set({ impersonatedBy: second.userId }).where(eq(session.id, started!.id))
    expect((await act(operator, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.id, started!.id))).toEqual([])
    // And disabling (as admin again, a fresh impersonation).
    await setAdmin(second, true)
    const again = await signIn(impersonated)
    expect(again.status).toBe(200)
    await db.update(session).set({ impersonatedBy: second.userId }).where(eq(session.userId, impersonated.userId))
    expect((await act(operator, 'user.disable', { userId: second.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.userId, impersonated.userId))).toEqual([])
    await act(operator, 'user.enable', { userId: second.userId })
    await setAdmin(second, false)
  })

  test('the OIDC provider is held to the proven-email rule like Google (security L1)', () => {
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: true })).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: 'true' })).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@x.test' })).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: false })).toEqual({ email: null, emailVerified: false })
    // Opted in with OIDC_TRUST_EMAIL_DOMAINS (review B2): only those exact domains.
    const env = { OIDC_TRUST_EMAIL_DOMAINS: ' Corp.test, other.test ' }
    expect(mapOidcProfile({ email: 'a@corp.test' }, env)).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'A@CORP.TEST' }, env)).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@sub.corp.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@corp.test.evil.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@x.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@corp.test' }, {})).toEqual({ email: null, emailVerified: false })
    // A provider that says the address is not verified is believed, also on a listed domain.
    expect(mapOidcProfile({ email: 'a@corp.test', email_verified: false }, env)).toEqual({ email: null, emailVerified: false })
  })

  const passwordTry = (email: string, ip: string, returned?: unknown) =>
    ({ path: '/sign-in/email', body: { email, password: 'x' }, headers: new Headers({ [CLIENT_IP_HEADER]: ip }), context: { returned } }) as never
  const wrongPassword = new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD' })

  test('ten wrong passwords from one network (an IPv6 /64) pause password sign-in for that address there only (security L4, review B1/B3)', async () => {
    const email = `net-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    const net = `2001:db8:${Math.floor(Math.random() * 65536).toString(16)}:7`
    for (let i = 1; i <= 10; i++) {
      await limitSignIns(passwordTry(email, `${net}::${i}`))
      await countSignInFailures(passwordTry(email, `${net}::${i}`, wrongPassword))
    }
    await expect(limitSignIns(passwordTry(email, `${net}::99`))).rejects.toMatchObject({ statusCode: 429 })
    // The owner from their own network still gets in, and a success does not count.
    await expect(limitSignIns(passwordTry(email, '198.51.100.30'))).resolves.toBeUndefined()
    await countSignInFailures(passwordTry(email, '198.51.100.30', { token: 'ok' }))
    await expect(limitSignIns(passwordTry(email, '198.51.100.30'))).resolves.toBeUndefined()
  })

  test('a hundred wrong passwords for an address from many networks pause it everywhere (security L4, review B3)', async () => {
    const person = await signUp()
    const email = await emailOf(person)
    const tryPassword = (password: string) =>
      request(anonymous, 'POST', '/api/auth/sign-in/email', { email, password }, { origin: 'http://localhost:5173', [FROM]: randomIp() })
    for (let i = 0; i < 10; i++) expect((await tryPassword(`wrong-${i}-password`)).status).toBe(401)
    // Ten from as many networks do not pause it ...
    expect((await tryPassword('test-password-1234')).status).toBe(200)
    // ... a hundred do (the rest counted directly, a hundred sign-ins over HTTP are slow).
    for (let i = 10; i < 100; i++) await countSignInFailures(passwordTry(email, randomIp(), wrongPassword))
    expect((await tryPassword('test-password-1234')).status).toBe(429)
  })

  test('user:create --admin without email delivery: a one-time password signs the new admin in (review B4)', async () => {
    const email = `First-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    const created = await createAdminWithPassword({ email, name: 'First Admin' })
    expect(created.enrolmentCode).toBeTruthy()
    const [row] = await db.select().from(user).where(eq(user.id, created.userId))
    expect(row).toMatchObject({ email: email.toLowerCase(), emailVerified: true, instanceAdmin: true })
    const signIn = (password: string) =>
      request(anonymous, 'POST', '/api/auth/sign-in/email', { email: email.toLowerCase(), password }, { origin: 'http://localhost:5173', [FROM]: randomIp() })
    expect((await signIn(created.password)).status).toBe(200)
    expect((await signIn('not-the-password-1')).status).toBe(401)
    await expect(createAdminWithPassword({ email, name: 'Again' })).rejects.toThrow('already has an account')
  })
})

describe('user.resetPasskeys: the recovery path that needs none of their passkeys', () => {
  afterEach(() => vi.restoreAllMocks())
  const passkeyRow = (userId: string) => ({
    id: `pk_${crypto.randomUUID().slice(0, 12)}`,
    userId,
    publicKey: 'cHVibGlj',
    credentialID: `cred-${crypto.randomUUID()}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
  })

  test('removes every passkey of a member and every session (a passkey session too), emails them, is audited; no code for a non-admin', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const someone = await addMember(other.id, 'member')
    await db.insert(passkey).values([passkeyRow(someone.userId), passkeyRow(someone.userId)])
    // Their session as if started by a passkey someone else added: it must not outlive the reset.
    await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, someone.userId))
    expect((await request(someone, 'GET', '/v1/me')).status).toBe(200)
    const res = await act(operator, 'user.resetPasskeys', { userId: someone.userId })
    expect(await db.select().from(session).where(eq(session.userId, someone.userId))).toEqual([])
    expect((await request(someone, 'GET', '/v1/me')).status).toBe(401)
    expect(res).toMatchObject({ status: 200, body: { data: { removed: 2 } } })
    expect(res.body.data.enrolmentCode).toBeUndefined()
    expect(await db.select().from(passkey).where(eq(passkey.userId, someone.userId))).toEqual([])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: await emailOf(someone), subject: 'The passkeys of your Linedesk account were removed' }))
    const audit = (await request(operator, 'GET', '/v1/admin/audit?kind=admin')).body.entries as { what: string }[]
    expect(audit.some(e => e.what === 'user.resetPasskeys')).toBe(true)
  })

  test('for an instance admin it returns a new enrolment code and always emails them, also without passkeys; not for workspace owners', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const second = await signUp()
    await setAdmin(second, true)
    await db.insert(passkey).values(passkeyRow(second.userId))
    const res = await act(operator, 'user.resetPasskeys', { userId: second.userId })
    expect(res.body.data).toMatchObject({ removed: 1, enrolmentCode: expect.any(String) })
    const code: string = res.body.data.enrolmentCode
    expect(JSON.stringify(await db.select().from(commands).where(eq(commands.action, 'user.resetPasskeys')))).not.toContain(code)
    send.mockClear()
    expect((await act(operator, 'user.resetPasskeys', { userId: second.userId })).body.data).toMatchObject({ removed: 0, enrolmentCode: expect.any(String) })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: await emailOf(second), subject: 'A passkey enrolment code was issued for your Linedesk account' }))
    await setAdmin(second, false)
    expect((await act(other.owner, 'user.resetPasskeys', { userId: member.userId })).status).toBe(403)
  })

  test('an admin cannot reset their own passkeys (b): recovery is another admin or the server', async () => {
    const self = await signUp()
    await setAdmin(self, true)
    await db.insert(passkey).values(passkeyRow(self.userId))
    expect(await act(self, 'user.resetPasskeys', { userId: self.userId })).toMatchObject({ status: 403, body: { code: 'forbidden' } })
    expect((await db.select().from(passkey).where(eq(passkey.userId, self.userId))).length).toBe(1)
    // The operator on the server (the CLI's actor) still can.
    const cli: Actor = { actorId: 'cli', role: 'member', workspaceId: null, permissions: ['instance:admin'], passkeyConfirmed: true }
    expect((await runAction('user.resetPasskeys', { userId: self.userId }, cli)).status).toBe(200)
    await setAdmin(self, false)
  })

  test('the users list shows their passkeys with dates, for the grant dialog', async () => {
    const someone = await signUp()
    await db.insert(passkey).values({ ...passkeyRow(someone.userId), name: 'Work laptop', createdAt: new Date() })
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    expect(users.find((u: { id: string }) => u.id === someone.userId).passkeys).toEqual([
      { name: 'Work laptop', device_type: 'multiDevice', created_at: expect.any(String) },
    ])
  })

  test('granting instance admin to someone without a passkey returns their enrolment code', async () => {
    const someone = await signUp()
    const res = await act(operator, 'instanceAdmin.grant', { userId: someone.userId })
    expect(res.body.data).toMatchObject({ instance_admin: true, enrolmentCode: expect.any(String) })
    await setAdmin(someone, false)
  })
})

describe('user.invite', () => {
  const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
  const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]
  afterEach(() => {
    process.env.AUTH_SIGNUP_ENABLED = 'true'
    process.env.EMAIL_TO_LOG = 'true'
    vi.restoreAllMocks()
  })
  const spySend = (impl: () => Promise<void> = async () => {}) => vi.spyOn(emailSender, 'send').mockImplementation(impl)

  test('creates the account, unverified, and emails how to sign in, without a code or link; works while sign-up is closed', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const send = spySend()
    const email = address('invitee')
    const res = await act(operator, 'user.invite', { email: email.toUpperCase(), name: 'Tim', admin: true })
    expect(res).toMatchObject({ status: 200, body: { data: { email: email.toLowerCase(), delivery: 'log' } } })
    expect(await accountOf(email.toLowerCase())).toMatchObject({
      name: 'Tim',
      emailVerified: false,
      instanceAdmin: true,
    })
    // One email to them; the other admins hear of the new admin separately (admin-alerts.ts).
    const toThem = send.mock.calls.map(([m]) => m).filter(m => m.to === email.toLowerCase() && !/^New instance admin/.test(m.subject))
    expect(toThem).toHaveLength(1)
    const mail = toThem[0]!
    expect(mail).toMatchObject({ to: email.toLowerCase(), subject: 'Your Linedesk account is ready' })
    expect(send.mock.calls.some(([m]) => /^New instance admin/.test(m.subject))).toBe(true)
    expect(mail.text).toContain('Enter this email address')
    expect(mail.text).not.toMatch(/\d{6}|token=/)
  })

  test('a new instance admin comes with a one-time passkey enrolment code for the inviting admin, not in the log', async () => {
    spySend()
    const email = address('new-admin')
    const res = await act(operator, 'user.invite', { email, name: 'Ann', admin: true })
    const code: string = res.body.data.enrolmentCode
    expect(code).toEqual(expect.any(String))
    expect((await accountOf(email))!.passkeyEnrolmentHash).toEqual(expect.any(String))
    const [logged] = await db.select().from(commands).where(and(eq(commands.action, 'user.invite'), sql`${commands.input}->>'email' = ${email}`))
    expect(JSON.stringify(logged)).not.toContain(code)
    // A plain user gets none.
    expect((await act(operator, 'user.invite', { email: address('plain'), name: 'Bo' })).body.data.enrolmentCode).toBeUndefined()
  })

  test('an address that already has an account is refused', async () => {
    spySend()
    const email = address('twice')
    expect((await act(operator, 'user.invite', { email, name: 'Once' })).status).toBe(200)
    expect(await act(operator, 'user.invite', { email: email.toUpperCase(), name: 'Twice' })).toMatchObject({
      status: 409,
      body: { error: `${email} already has an account` },
    })
  })

  test('an invite does not use up the sign-in code limit of that address', async () => {
    const send = spySend()
    const email = address('limit')
    for (let i = 0; i < 6; i++)
      await request(
        anonymous,
        'POST',
        '/api/auth/email-otp/send-verification-otp',
        { email, type: 'sign-in' },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    send.mockClear()
    expect((await act(operator, 'user.invite', { email, name: 'After Many Codes' })).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('without email it is refused and nothing is created', async () => {
    delete process.env.EMAIL_TO_LOG
    const email = address('noemail')
    const res = await act(operator, 'user.invite', { email, name: 'No Email' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Email is not set up/)
    expect(await accountOf(email)).toBeUndefined()
  })

  test('when the email cannot be sent the account is removed again and the command is logged as rejected', async () => {
    spySend(async () => {
      throw new Error('SMTP said no')
    })
    const email = address('bounce')
    const key = crypto.randomUUID()
    const res = await act(operator, 'user.invite', { email, name: 'Bounce' }, key)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(
      /the welcome email could not be sent \(SMTP said no\); the account for .* was removed again/,
    )
    expect(await accountOf(email)).toBeUndefined()
    expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({ rejected: true })
  })

  test('a workspace owner who is not an instance admin cannot invite', async () => {
    expect(await act(other.owner, 'user.invite', { email: address('x'), name: 'X' })).toMatchObject({
      status: 403,
      body: { error: 'missing permission instance:admin' },
    })
  })
})

describe('impersonation', () => {
  const SESSION = 'better-auth.session_token'
  const ADMIN_SESSION = 'better-auth.admin_session'
  const DONT_REMEMBER = 'better-auth.dont_remember'
  let target: User // a member of `other`, signed in with a password
  afterEach(() => {
    process.env.INSTANCE_ADMIN_EMAILS = ''
  })
  beforeAll(async () => {
    target = await addMember(other.id, 'member')
  })

  const cookiesOf = (caller: Caller) =>
    new Map(
      (caller.headers.cookie ?? '')
        .split('; ')
        .filter(Boolean)
        .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    )
  const callerWith = (caller: Caller, jar: Map<string, string>): Caller => ({
    headers: { ...caller.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  /** The caller as the browser would be after the response: its Set-Cookie headers applied. */
  function afterResponse(caller: Caller, res: Response): Caller {
    const jar = cookiesOf(caller)
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const name = pair.slice(0, pair.indexOf('='))
      if (/max-age=0\b/i.test(line) || pair.endsWith('=')) jar.delete(name)
      else jar.set(name, pair.slice(pair.indexOf('=') + 1))
    }
    return callerWith(caller, jar)
  }
  const withCookie = (caller: Caller, name: string, value: string | null): Caller => {
    const jar = cookiesOf(caller)
    if (value === null) jar.delete(name)
    else jar.set(name, value)
    return callerWith(caller, jar)
  }
  const post = (who: Caller, path: string, body: unknown = {}) =>
    appRequest(path, {
      method: 'POST',
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  async function start(who: Caller, userId: string) {
    const res = await post(who, '/v1/impersonation/start', { userId })
    return { status: res.status, body: await res.json(), as: afterResponse(who, res) }
  }
  async function stop(who: Caller) {
    const res = await post(who, '/v1/impersonation/stop')
    return { status: res.status, body: await res.json(), as: afterResponse(who, res) }
  }
  const sessionsOf = (userId: string) => db.select().from(session).where(eq(session.userId, userId))
  const impersonations = async () => (await sessionsOf(target.userId)).filter(s => s.impersonatedBy)
  const getSession = async (who: Caller) =>
    (await request(who, 'GET', '/api/auth/get-session')).body as {
      user: { id: string }
      session: { impersonatedBy?: string }
    } | null

  test('a workspace owner or member who is no instance admin cannot start it, and no session is made', async () => {
    for (const who of [other.owner, member]) {
      expect(await start(who, target.userId)).toMatchObject({
        status: 403,
        body: { error: 'missing permission instance:admin' },
      })
    }
    expect(await impersonations()).toEqual([])
  })

  test('the generic action route refuses both actions: they only run through their own routes', async () => {
    expect((await act(operator, 'user.impersonate', { userId: target.userId })).status).toBe(400)
    expect((await act(operator, 'impersonation.stop', {})).status).toBe(400)
    expect(await impersonations()).toEqual([])
  })

  test('refused for yourself, another instance admin (also by INSTANCE_ADMIN_EMAILS), a disabled and an unknown user', async () => {
    // Another instance admin is a rule about who asks (403); the others are about the user (409).
    const reason = async (userId: string, status = 409) => {
      const res = await start(operator, userId)
      expect(res.status).toBe(status)
      expect(res.as.headers.cookie).toBe(operator.headers.cookie) // no cookie changed
      return res.body.error as string
    }
    expect(await reason(operator.userId)).toMatch(/yourself/)
    const admin = await signUp()
    await setAdmin(admin, true)
    expect(await reason(admin.userId, 403)).toMatch(/another instance admin/)
    await setAdmin(admin, false)
    const envAdmin = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, envAdmin.userId))
    process.env.INSTANCE_ADMIN_EMAILS = await emailOf(envAdmin)
    expect(await reason(envAdmin.userId, 403)).toMatch(/another instance admin/)
    const disabled = await signUp()
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    expect(await reason(disabled.userId)).toMatch(/disabled/)
    expect(await reason('no-such-user')).toMatch(/not found/)
    expect(await db.select().from(session).where(eq(session.impersonatedBy, operator.userId))).toEqual([])
  })

  test('starts a Better Auth session for the user: impersonated_by, one hour, their first workspace; the cookie is accepted', async () => {
    const before = Date.now()
    const { status, body, as } = await start(operator, target.userId)
    expect(status).toBe(200)
    const [started] = await impersonations()
    expect(started).toMatchObject({
      id: body.data.sessionId,
      impersonatedBy: operator.userId,
      activeOrganizationId: other.id,
    })
    const lifetime = started!.expiresAt.getTime() - before
    expect(lifetime).toBeGreaterThan(59 * 60_000)
    expect(lifetime).toBeLessThanOrEqual(60 * 60_000 + 5_000)
    // An admin signing in as the user is not the user's last sign-in.
    expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.lastSignInAt?.getTime() ?? 0).toBeLessThan(before)
    expect(await getSession(as)).toMatchObject({
      user: { id: target.userId },
      session: { impersonatedBy: operator.userId },
    })
    expect(cookiesOf(as).get(ADMIN_SESSION)).toBeTruthy()
    await stop(as)
  })

  test("while impersonating: the user's permissions, never instance:admin, no admin routes, no starting another", async () => {
    const { as } = await start(operator, target.userId)
    const me = (await request(as, 'GET', '/v1/me')).body
    expect(me).toMatchObject({ actorId: target.userId, role: 'member', workspace: { id: other.id } })
    expect(me.permissions).toEqual(expect.arrayContaining(['call:read', 'call:write', 'impersonation:stop']))
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.impersonation).toMatchObject({ by: { id: operator.userId, email: await emailOf(operator) } })
    expect(Date.parse(me.impersonation.expiresAt)).toBeGreaterThan(Date.now() + 59 * 60_000)
    for (const path of adminRoutes) expect((await request(as, 'GET', path)).status, path).toBe(403)
    expect((await start(as, member.userId)).status).toBe(403)
    const memberSessions = await db.select().from(session).where(eq(session.userId, member.userId))
    expect(memberSessions.every(s => !s.impersonatedBy)).toBe(true)
    expect((await request(operator, 'GET', '/v1/me')).body.impersonation).toBeNull()
    await stop(as)
  })

  test('what an impersonated session may run is pinned: a new read-only action or allowed write needs a look here', () => {
    const allowed = [...actions.values()].filter(mayRunWhileImpersonating).map(def => def.name).sort()
    expect(allowed).toEqual([
      'apiKey.list',
      'assistant.version',
      'assistant.versions',
      'calendar.findSlots',
      'calendar.listCalendars',
      'call.clearReminder',
      'call.findForTest',
      'call.getEvaluation',
      'call.listEvaluations',
      'call.markDone',
      'call.markNotDone',
      'call.markRead',
      'call.markUnread',
      'call.remind',
      'carrier.get',
      'carrier.transferTrunk',
      'impersonation.stop',
      'insights.get',
      'invitation.listMine',
      'knowledge.search',
      'member.list',
      'notifications.get',
      'provider.test',
      'team.list',
      'voice.catalog',
      'voice.options',
      'voiceCloning.get',
      'webhook.deliveries',
      'workspace.getSettings',
    ])
  })

  test('as an owner, only reads and inbox triage run; every other write is refused centrally (security M3)', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    try {
      const { as } = await start(operator, target.userId)
      const refused: [string, unknown][] = [
        ['team.invite', { email: 'admin-backdoor@linedesk.test', role: 'owner' }],
        ['team.removeMember', { memberId: 'any' }],
        ['team.resendInvite', { invitationId: 'any' }],
        ['webhook.create', { url: 'https://collector.example.com/hook', events: ['call.completed'] }],
        ['webhook.update', { endpointId: other.webhookEndpoint.id, url: 'https://collector.example.com/hook' }],
        ['apiKey.create', { name: 'Backdoor', role: 'admin' }],
        ['carrier.set', {}],
        ['phoneNumber.release', { phoneNumberId: 'any' }],
        ['assistant.update', { id: other.assistant.id, patch: { name: 'Taken over' } }],
        ['contact.delete', { contactId: other.contact.id }],
        ['webhook.test', { endpointId: other.webhookEndpoint.id }],
        // Support, not taking customer data out: no bulk export of the calls.
        ['call.export', { from: '2026-01-01', to: '2026-01-31' }],
      ]
      for (const [name, input] of refused) {
        expect(await act(as, name, input), name).toMatchObject({ status: 403, body: { error: 'Not possible while signed in as another user.' } })
      }
      expect(await db.select().from(invitation).where(eq(invitation.email, 'admin-backdoor@linedesk.test'))).toEqual([])
      // Reading and triaging the inbox work.
      expect((await act(as, 'team.list', {})).status).toBe(200)
      expect((await act(as, 'call.markRead', { callId: other.call.id })).status).toBe(200)
      expect((await act(as, 'call.markDone', { callId: other.call.id })).status).toBe(200)
      await stop(as)
    } finally {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
    }
  })

  test('no role changes while impersonating, even as an owner', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    try {
      const { as } = await start(operator, target.userId)
      const [someone] = await db.select().from(memberTable)
        .where(and(eq(memberTable.organizationId, other.id), sql`${memberTable.userId} <> ${target.userId}`))
      const res = await act(as, 'team.setRole', { memberId: someone!.id, role: 'owner' })
      expect(res.status).not.toBe(200)
      expect(JSON.stringify(res.body)).toContain('Not possible while signed in as another user.')
      expect((await db.select().from(memberTable).where(eq(memberTable.id, someone!.id)))[0]!.role).toBe(someone!.role)
      await stop(as)
    } finally {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
    }
  })

  test("nothing that changes the account's credentials or security works while impersonating", async () => {
    const { as } = await start(operator, target.userId)
    const authCall = (path: string, body?: unknown) =>
      request(as, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body)
    const refused = [
      await authCall('/change-password', { currentPassword: 'test-password-1234', newPassword: 'another-password-5678' }),
      await authCall('/change-email', { newEmail: 'taken-over@linedesk.test' }),
      await authCall('/delete-user', {}),
      await authCall('/revoke-other-sessions', {}),
      await authCall('/revoke-sessions', {}),
      await authCall('/list-sessions'),
      await authCall('/list-accounts'),
      await authCall('/unlink-account', { providerId: 'credential' }),
      // No testing guesses at their password, no changing their profile.
      await authCall('/verify-password', { password: 'test-password-1234' }),
      await authCall('/update-user', { name: 'Taken over' }),
      // Passkeys: no adding, renaming, removing or listing them as the user.
      await authCall('/passkey/generate-register-options'),
      await authCall('/passkey/verify-registration', { response: {} }),
      await authCall('/passkey/update-passkey', { id: 'any', name: 'Taken over' }),
      await authCall('/passkey/delete-passkey', { id: 'any' }),
      await authCall('/passkey/list-user-passkeys'),
    ]
    for (const res of refused) {
      expect(res).toMatchObject({ status: 403, body: { message: 'Not possible while signed in as another user.' } })
    }
    expect(
      (await request(as, 'POST', '/v1/account/password', { newPassword: 'another-password-5678' })).status,
    ).toBe(403)
    // No workspace made as the user either: it would outlast the hour.
    expect(await request(as, 'POST', '/v1/workspaces', { name: 'Made while impersonating' })).toMatchObject({
      status: 403,
      body: { error: 'Not possible while signed in as another user.' },
    })
    // No joining a workspace as the user: not through Better Auth's endpoint, not through the registry.
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, target.userId))
    const [invite] = await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID()}`, organizationId: home.id, email: await emailOf(target), role: 'admin', status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000), inviterId: operator.userId,
    }).returning()
    expect(await authCall('/organization/accept-invitation', { invitationId: invite!.id })).toMatchObject({
      status: 403,
      body: { message: 'Not possible while signed in as another user.' },
    })
    // Refused centrally now (run-action), before the handler's own refusal.
    expect(await act(as, 'invitation.accept', { invitationId: invite!.id })).toMatchObject({
      status: 403,
      body: { error: 'Not possible while signed in as another user.' },
    })
    expect(await act(as, 'invitation.decline', { invitationId: invite!.id })).toMatchObject({ status: 403 })
    expect((await db.select().from(invitation).where(eq(invitation.id, invite!.id)))[0]?.status).toBe('pending')
    expect((await db.select().from(memberTable).where(eq(memberTable.userId, target.userId))).map(m => m.organizationId)).toEqual([other.id])
    await db.delete(invitation).where(eq(invitation.id, invite!.id))
    // Still the same account, email and password.
    expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.email).toBe(await emailOf(target))
    expect((await signIn(target)).status).toBe(200)
    await stop(as)
  })

  test('normal actions run as the user and the command log names the admin; it cannot outlast its hour', async () => {
    const { as } = await start(operator, target.userId)
    const key = crypto.randomUUID()
    expect((await act(as, 'call.markRead', { callId: other.call.id }, key)).status).toBe(200)
    // A tab names the user's workspace: works. The admin's own workspace is not the user's: refused.
    const inTab = (workspaceId: string) => request(as, 'POST', '/v1/actions/call.markUnread', { callId: other.call.id }, { 'x-workspace-id': workspaceId })
    expect((await inTab(other.id)).status).toBe(200)
    expect(await inTab(home.id)).toMatchObject({ status: 403, body: { code: 'workspace_access_lost' } })
    expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({
      actor_id: target.userId,
      impersonated_by: operator.userId,
      workspace_id: other.id,
    })
    // Without the "not remembered" cookie Better Auth would extend a used session to 7 days: it keeps its expiry.
    const [started] = await impersonations()
    expect((await getSession(withCookie(as, DONT_REMEMBER, null)))?.user.id).toBe(target.userId)
    expect((await impersonations())[0]!.expiresAt).toEqual(started!.expiresAt)
    // An hour after it started, the session is refused whatever its expiry says.
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 61 * 60_000), expiresAt: new Date(Date.now() + 7 * 864e5) })
      .where(eq(session.id, started!.id))
    expect((await request(as, 'GET', '/v1/me')).status).toBe(401)
    await db.delete(session).where(eq(session.id, started!.id))
  })

  test('stop: deletes the impersonation session and signs the admin back in to their own session; both commands are logged', async () => {
    const { as, body } = await start(operator, target.userId)
    const back = await stop(as)
    expect(back).toMatchObject({ status: 200, body: { ok: true, resumed: true } })
    expect(await db.select().from(session).where(eq(session.id, body.data.sessionId))).toEqual([])
    expect(cookiesOf(back.as).has(ADMIN_SESSION)).toBe(false)
    expect(cookiesOf(back.as).get(SESSION)).toBe(cookiesOf(operator).get(SESSION))
    const me = (await request(back.as, 'GET', '/v1/me')).body
    expect(me).toMatchObject({ actorId: operator.userId, impersonation: null })
    expect(me.permissions).toContain('instance:admin')
    const log = await db
      .select()
      .from(commands)
      .where(sql`${commands.action} in ('user.impersonate', 'impersonation.stop') and ${commands.rejected} = false`)
    const started = log.find(
      c => c.action === 'user.impersonate' && (c.result as { data: { sessionId: string } }).data.sessionId === body.data.sessionId,
    )
    expect(started).toMatchObject({ actor_id: operator.userId, impersonated_by: null, input: { userId: target.userId } })
    expect(log.filter(c => c.action === 'impersonation.stop').at(-1)).toMatchObject({
      actor_id: target.userId,
      impersonated_by: operator.userId,
    })
    // No session token ever lands in the command log.
    for (const row of log) expect(JSON.stringify(row)).not.toMatch(/token/i)
  })

  test('stop with a tampered, foreign or missing admin cookie only signs out; the admin session is left alone', async () => {
    const foreign = (await sessionsOf(other.owner.userId))[0]!
    const cases: ((as: Caller) => Caller)[] = [
      as => withCookie(as, ADMIN_SESSION, `${cookiesOf(as).get(ADMIN_SESSION)!.slice(0, -9)}AAAAAA%3D`),
      as => withCookie(as, ADMIN_SESSION, encodeURIComponent(`${foreign.token}:.forged`)),
      as => withCookie(as, ADMIN_SESSION, null),
    ]
    for (const tamper of cases) {
      const { as, body } = await start(operator, target.userId)
      const back = await stop(tamper(as))
      expect(back).toMatchObject({ status: 200, body: { resumed: false } })
      expect(cookiesOf(back.as).has(SESSION)).toBe(false)
      expect(await getSession(back.as)).toBeNull()
      expect(await db.select().from(session).where(eq(session.id, body.data.sessionId))).toEqual([])
    }
    expect((await request(operator, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
  })

  test('stop is refused for a session that is no impersonation', async () => {
    expect((await stop(operator)).status).toBe(403)
    expect((await stop(target)).status).toBe(403)
  })

  test('the audit log has the start, what was done as the user, and the stop, each naming the admin', async () => {
    const { as } = await start(operator, target.userId)
    expect((await act(as, 'call.markRead', { callId: other.call.id })).status).toBe(200)
    await stop(as)
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=impersonation&limit=10')).body
    const mine = entries.filter((e: { at: string }) => Date.now() - Date.parse(e.at) < 60_000)
    const what = mine.map((e: { what: string }) => e.what)
    expect(what).toEqual(expect.arrayContaining(['user.impersonate', 'call.markRead', 'impersonation.stop']))
    const asUser = mine.find((e: { what: string }) => e.what === 'call.markRead')
    expect(asUser).toMatchObject({
      kind: 'impersonation',
      actor: { id: target.userId },
      impersonatedBy: { id: operator.userId },
    })
    // Everyday actions without impersonation are not audit entries.
    await act(target, 'call.markRead', { callId: other.call.id })
    const all = (await request(operator, 'GET', '/v1/admin/audit?limit=200')).body.entries
    expect(
      all.filter((e: { what: string; impersonatedBy: unknown }) => e.what === 'call.markRead' && !e.impersonatedBy),
    ).toEqual([])
  })
})

describe('memberships across workspaces', () => {
  const membersOf = async (wsId: string) => (await request(operator, 'GET', `/v1/admin/workspaces/${wsId}/members`)).body
  const memberRow = async (wsId: string, who: User) =>
    (await db.select().from(memberTable).where(eq(memberTable.userId, who.userId))).find(m => m.organizationId === wsId)
  const userRow = async (who: User) =>
    (await request(operator, 'GET', '/v1/admin/users')).body.users.find((u: { id: string }) => u.id === who.userId)

  test('an instance admin adds an existing user to any workspace, changes the role and removes them; all logged', async () => {
    const outsider = await signUp()
    const added = await act(operator, 'membership.add', { userId: outsider.userId, workspaceId: other.id, role: 'admin' })
    expect(added).toMatchObject({ status: 200, body: { ok: true } })
    expect(await memberRow(other.id, outsider)).toMatchObject({ role: 'admin' })
    expect((await membersOf(other.id)).members.map((m: { email: string; role: string }) => m.role)).toContain('admin')
    expect((await userRow(outsider)).workspaces).toEqual([
      { id: other.id, name: 'Brightwater Plumbing & Heating', role: 'admin', member_id: added.body.data.memberId },
    ])
    // The workspace's own owner sees the new member at once.
    expect((await act(other.owner, 'team.list', {})).body.data.members.some((m: { userId: string }) => m.userId === outsider.userId)).toBe(true)
    expect(await act(operator, 'membership.add', { userId: outsider.userId, workspaceId: other.id, role: 'member' })).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/already a member/) },
    })
    const memberId = added.body.data.memberId
    expect((await act(operator, 'membership.setRole', { memberId, role: 'member' })).status).toBe(200)
    expect(await memberRow(other.id, outsider)).toMatchObject({ role: 'member' })
    expect((await act(operator, 'membership.remove', { memberId })).status).toBe(200)
    expect(await memberRow(other.id, outsider)).toBeUndefined()
    const log = await db.select().from(commands).where(eq(commands.actor_id, operator.userId))
    expect(log.filter(c => c.action.startsWith('membership.')).map(c => c.action)).toEqual(
      expect.arrayContaining(['membership.add', 'membership.setRole', 'membership.remove']),
    )
  })

  test('the last owner of a workspace can be neither demoted nor removed; with a second owner both work', async () => {
    const ws = await createWorkspace('Last Owner Test')
    const ownerId = (await memberRow(ws.id, ws.owner))!.id
    const lastOwner = { status: 409, body: { error: 'the workspace needs an owner: this is the last one' } }
    expect(await act(operator, 'membership.setRole', { memberId: ownerId, role: 'admin' })).toMatchObject(lastOwner)
    expect(await act(operator, 'membership.remove', { memberId: ownerId })).toMatchObject(lastOwner)
    expect(await memberRow(ws.id, ws.owner)).toMatchObject({ role: 'owner' })
    const second = await signUp()
    expect((await act(operator, 'membership.add', { userId: second.userId, workspaceId: ws.id, role: 'owner' })).status).toBe(200)
    expect((await act(operator, 'membership.setRole', { memberId: ownerId, role: 'member' })).status).toBe(200)
    expect((await act(operator, 'membership.remove', { memberId: ownerId })).status).toBe(200)
  })

  test('one membership per user and workspace: the database refuses a second row', async () => {
    const row = await memberRow(other.id, member)
    await expect(
      db.insert(memberTable).values({ id: `dup_${crypto.randomUUID()}`, organizationId: other.id, userId: member.userId, role: 'admin', createdAt: new Date() }),
    ).rejects.toThrow()
    expect((await db.select().from(memberTable).where(eq(memberTable.userId, member.userId))).filter(m => m.organizationId === other.id)).toEqual([row])
  })

  test('unknown users, workspaces, members and invitations are refused', async () => {
    expect((await act(operator, 'membership.add', { userId: 'nope', workspaceId: other.id, role: 'member' })).body.error).toBe('user not found')
    expect((await act(operator, 'membership.add', { userId: member.userId, workspaceId: 'nope', role: 'member' })).body.error).toBe('workspace not found')
    expect((await act(operator, 'membership.remove', { memberId: 'nope' })).body.error).toBe('member not found')
    expect((await act(operator, 'invitation.revoke', { invitationId: 'nope' })).body.error).toBe('invitation not found')
  })

  test('pending invitations show on the workspace and the user; the admin revokes and resends them; adding answers them', async () => {
    const sent: string[] = []
    const texts: string[] = []
    const send = vi.spyOn(emailSender, 'send').mockImplementation(async e => {
      sent.push(e.to)
      texts.push(e.text)
    })
    const kind = emailSender.kind
    Object.assign(emailSender, { kind: 'log' })
    try {
      const invitee = await signUp()
      const email = (await emailOf(invitee)).toUpperCase()
      const invited = await act(other.owner, 'team.invite', { email: email.toLowerCase(), role: 'member' })
      const invitationId = invited.body.data.invitationId
      expect((await membersOf(other.id)).invitations).toEqual([
        expect.objectContaining({ id: invitationId, email: email.toLowerCase(), role: 'member', expired: false }),
      ])
      expect((await userRow(invitee)).invitations).toEqual([
        expect.objectContaining({ id: invitationId, workspace_id: other.id, role: 'member' }),
      ])
      await db.update(user).set({ name: 'Mike Brennan' }).where(eq(user.id, other.owner.userId))
      await db.update(user).set({ name: 'Ops Admin' }).where(eq(user.id, operator.userId))
      expect((await act(operator, 'invitation.resend', { invitationId })).status).toBe(200)
      expect(sent.filter(to => to === email.toLowerCase())).toHaveLength(2)
      // The resent email names who invited them, not the instance admin who resent it.
      expect(texts.at(-1)).toMatch(/^Mike Brennan invited you/m)
      expect(texts.at(-1)).not.toMatch(/Ops Admin/)
      await db.update(user).set({ name: 'Test User' }).where(inArray(user.id, [other.owner.userId, operator.userId]))
      expect((await act(operator, 'invitation.revoke', { invitationId })).status).toBe(200)
      expect((await membersOf(other.id)).invitations).toEqual([])
      // An invitation that is still open is answered by adding the user directly.
      const again = (await act(other.owner, 'team.invite', { email: email.toLowerCase(), role: 'admin' })).body.data.invitationId
      expect((await act(operator, 'membership.add', { userId: invitee.userId, workspaceId: other.id, role: 'member' })).status).toBe(200)
      expect((await db.select().from(invitation).where(eq(invitation.id, again)))[0]?.status).toBe('canceled')
    } finally {
      send.mockRestore()
      Object.assign(emailSender, { kind })
    }
  })

  test('an accepted invitation can no longer be revoked or resent', async () => {
    const invitee = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, invitee.userId))
    const [invite] = await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID()}`, organizationId: home.id, email: await emailOf(invitee), role: 'member', status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000), inviterId: operator.userId,
    }).returning()
    const accepted = await request(invitee, 'POST', '/api/auth/organization/accept-invitation', { invitationId: invite!.id }, { [FROM]: randomIp() })
    expect(accepted.status).toBe(200)
    for (const name of ['invitation.revoke', 'invitation.resend'])
      expect(await act(operator, name, { invitationId: invite!.id })).toMatchObject({ status: 409, body: { error: 'invitation not found' } })
    expect((await db.select().from(invitation).where(eq(invitation.id, invite!.id)))[0]?.status).toBe('accepted')
    // Adding the same person again is refused with a clear reason.
    expect(await act(operator, 'membership.add', { userId: invitee.userId, workspaceId: home.id, role: 'admin' })).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/already a member of Linedesk Operations/) },
    })
  })

  test('a workspace owner who is no instance admin cannot read another workspace\'s members', async () => {
    expect((await request(other.owner, 'GET', `/v1/admin/workspaces/${home.id}/members`)).status).toBe(403)
  })
})

describe('second factor for instance admins (ADMIN_SECOND_FACTOR on)', () => {
  const PASSKEY_PATH = '/passkey/verify-authentication'
  const HOUR = 3_600_000
  let admin: User
  const sessionOfAdmin = (values: { passkeyVerifiedAt?: Date | null; impersonatedBy?: string | null; createdAt?: Date }) =>
    db.update(session).set(values).where(eq(session.userId, admin.userId))
  const confirmEmail = (emailVerified: boolean) => db.update(user).set({ emailVerified }).where(eq(user.id, admin.userId))
  const addPasskey = () =>
    db.insert(passkey).values({
      id: `pk_${crypto.randomUUID().slice(0, 12)}`,
      userId: admin.userId,
      publicKey: 'cHVibGlj',
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
  /** The browser's cookie from a sign-in response, as a caller of its own. */
  const callerFrom = (res: Response): User => ({
    userId: admin.userId,
    headers: { cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), origin: 'http://localhost:5173' },
  })

  beforeAll(async () => {
    admin = await signUp()
    await setAdmin(admin, true)
    // A confirmed address: an unconfirmed one cannot add passkeys at all.
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  })
  beforeEach(async () => {
    // A confirmed admin whose sign-in was 13 hours ago, unless a test says otherwise.
    await confirmEmail(true)
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 13 * HOUR) })
  })
  afterEach(async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    vi.restoreAllMocks()
    await db.delete(passkey).where(eq(passkey.userId, admin.userId))
    await sessionOfAdmin({ passkeyVerifiedAt: null, impersonatedBy: null })
  })

  test('a sign-in older than 12 hours: no instance:admin, admin routes and actions refused, /v1/me says confirm', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.adminSecondFactor).toBe('confirm')
    for (const path of adminRoutes) {
      expect(await request(admin, 'GET', path), path).toMatchObject({
        status: 403,
        body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'confirm' },
      })
    }
    // user.impersonate runs only through its own route (POST /v1/actions refuses it before any permission check).
    for (const def of adminActions.filter(d => d.name !== 'user.impersonate')) {
      expect(await act(admin, def.name, {}), def.name).toMatchObject({ status: 403, body: { code: 'SECOND_FACTOR_REQUIRED' } })
    }
    expect(await request(admin, 'POST', '/v1/impersonation/start', { userId: member.userId })).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED' },
    })
    expect((await request(other.owner, 'GET', '/v1/me')).body.adminSecondFactor).toBeNull()
  })

  test('(e) another sign-in opens the admin area for 1 hour, a passkey sign-in for 12; a future time never', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const status = async () => (await request(admin, 'GET', '/v1/admin/users')).status
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 50 * 60_000) })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).toContain('instance:admin')
    expect(me.adminSecondFactor).toBeNull()
    expect(await status()).toBe(200)
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 61 * 60_000) })
    expect(await request(admin, 'GET', '/v1/admin/users')).toMatchObject({ status: 403, body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'confirm' } })
    // A passkey sign-in (marked when the session is made, so both times are the same).
    const elevenAgo = new Date(Date.now() - 11 * HOUR)
    await sessionOfAdmin({ createdAt: elevenAgo, passkeyVerifiedAt: elevenAgo })
    expect(await status()).toBe(200)
    const thirteenAgo = new Date(Date.now() - 13 * HOUR)
    await sessionOfAdmin({ createdAt: thirteenAgo, passkeyVerifiedAt: thirteenAgo })
    expect(await status()).toBe(403)
    await sessionOfAdmin({ createdAt: new Date(Date.now() + HOUR), passkeyVerifiedAt: null })
    expect(await status()).toBe(403)
  })

  test('signing in again with a password opens the admin area', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(403)
    const res = await appRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', [FROM]: randomIp() },
      body: JSON.stringify({ email: await emailOf(admin), password: 'test-password-1234' }),
    })
    expect(res.status).toBe(200)
    expect((await request(callerFrom(res), 'GET', '/v1/admin/users')).status).toBe(200)
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(403) // the old session stays as it was
  })

  test('signing in again with an email code opens the admin area', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const email = await emailOf(admin)
    const headers = { origin: 'http://localhost:5173', [FROM]: randomIp() }
    expect((await request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, headers)).status).toBe(200)
    await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.to === email)).toBe(true))
    const otp = send.mock.calls.map(([m]) => m).findLast(m => m.to === email)!.subject.slice(0, 6)
    const res = await appRequest('/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, otp }),
    })
    expect(res.status).toBe(200)
    expect((await request(callerFrom(res), 'GET', '/v1/admin/users')).status).toBe(200)
  })

  test('the rule does not ask how the session was started (passkey, code, password, Google, Microsoft, GitHub)', () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const now = Date.now()
    const recent = { createdAt: new Date(now - 30 * 60_000), passkeyVerifiedAt: null }
    expect(adminSecondFactorGap({ emailVerified: true }, recent, now)).toBeNull()
    expect(adminSecondFactorGap({ emailVerified: true }, { ...recent, createdAt: new Date(now - HOUR) }, now)).toBe('confirm')
    expect(adminSecondFactorGap({ emailVerified: false }, recent, now)).toBe('email')
    expect(adminSecondFactorGap({ emailVerified: true }, { ...recent, impersonatedBy: 'someone' }, now)).toBe('confirm')
  })

  test('an unconfirmed email address keeps the admin area closed, even right after signing in', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await confirmEmail(false)
    await sessionOfAdmin({ createdAt: new Date() })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.adminSecondFactor).toBe('email')
    expect(await request(admin, 'GET', '/v1/admin/users')).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'email' },
    })
  })

  test('a recent sign-in that opens the admin area still cannot add or remove passkeys without a passkey sign-in (H1)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    await sessionOfAdmin({ createdAt: new Date() })
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(200)
    const authCall = (path: string, body?: unknown) =>
      request(admin, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body, { origin: 'http://localhost:5173', [FROM]: randomIp() })
    const [own] = await db.select().from(passkey).where(eq(passkey.userId, admin.userId))
    expect((await authCall('/passkey/generate-register-options')).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await authCall('/passkey/delete-passkey', { id: own!.id })).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await db.select().from(passkey).where(eq(passkey.userId, admin.userId))).length).toBe(1)
  })

  test("an admin's first passkey needs the enrolment code from the granting admin; later ones a passkey session (H1)", async () => {
    await sessionOfAdmin({ createdAt: new Date() })
    const authCall = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
      request(admin, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body, { origin: 'http://localhost:5173', [FROM]: randomIp(), ...extra })
    const verify = (code?: string) =>
      authCall('/passkey/verify-registration', { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }, code ? { 'x-passkey-enrolment': code } : {})
    // No code: a fresh session with the first factor alone cannot even start.
    await db.update(user).set({ passkeyEnrolmentHash: null, passkeyEnrolmentExpiresAt: null }).where(eq(user.id, admin.userId))
    expect(await authCall('/passkey/generate-register-options')).toMatchObject({ status: 403, body: { code: 'PASSKEY_ENROLMENT_REQUIRED' } })
    // A code issued for them (by grant, invite, reset or the CLI; reset itself is tested with user.resetPasskeys).
    const { enrolmentCode: code } = await issuePasskeyEnrolment(db, admin.userId)
    expect((await authCall('/passkey/generate-register-options')).status).toBe(200)
    // Where the passkey is stored, the code itself is needed; the right one gets past the guard to the plugin.
    expect((await verify()).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    expect((await verify('not-the-code')).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    const right = await verify(code)
    expect(right.body?.code).not.toBe('PASSKEY_ENROLMENT_REQUIRED')
    expect(right.status).not.toBe(200) // no real authenticator response
    // Expired: refused again.
    await db.update(user).set({ passkeyEnrolmentExpiresAt: new Date(Date.now() - 1000) }).where(eq(user.id, admin.userId))
    expect((await verify(code)).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    // With a passkey: an attacker with the mailbox or password cannot add theirs or remove the real one.
    await addPasskey()
    const [own] = await db.select().from(passkey).where(eq(passkey.userId, admin.userId))
    expect((await authCall('/passkey/generate-register-options')).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await authCall('/passkey/delete-passkey', { id: own!.id })).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await db.select().from(passkey).where(eq(passkey.userId, admin.userId))).length).toBe(1)
    await sessionOfAdmin({ passkeyVerifiedAt: new Date() })
    expect((await authCall('/passkey/generate-register-options')).status).toBe(200)
  })

  test('only a passkey sign-in marks a session, never an impersonation', () => {
    const plain = { userId: 'u', impersonatedBy: null }
    expect(markPasskeySession(plain, { path: PASSKEY_PATH })?.data.passkeyVerifiedAt).toBeInstanceOf(Date)
    for (const path of ['/sign-in/email', '/sign-in/email-otp', '/callback/github', '/passkey/verify-registration'])
      expect(markPasskeySession(plain, { path }), path).toBeUndefined()
    expect(markPasskeySession({ ...plain, impersonatedBy: 'admin' }, { path: PASSKEY_PATH })).toBeUndefined()
    expect(markPasskeySession(plain, undefined)).toBeUndefined()
  })

  test('a client can neither mark its own session nor move its sign-in time', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const rows = () => db.select().from(session).where(eq(session.userId, admin.userId)).orderBy(session.id)
    const before = await rows()
    await request(admin, 'POST', '/api/auth/update-session', {
      passkeyVerifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    const after = await rows()
    expect(after.map(row => row.passkeyVerifiedAt)).toEqual(before.map(() => null))
    expect(after.map(row => row.createdAt.getTime())).toEqual(before.map(row => row.createdAt.getTime()))
    expect((await request(admin, 'GET', '/v1/me')).body.adminSecondFactor).toBe('confirm')
  })

  test('an impersonation session never counts, even a fresh one whose row says passkey', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await sessionOfAdmin({ passkeyVerifiedAt: new Date(), impersonatedBy: operator.userId, createdAt: new Date() })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  describe('(a) taking over admin needs a passkey sign-in on top of a recent sign-in', () => {
    let target: User // a plain user
    let otherAdmin: User
    beforeAll(async () => {
      target = await signUp()
      otherAdmin = await signUp()
      await setAdmin(otherAdmin, true)
    })
    afterAll(() => setAdmin(otherAdmin, false))
    const stepUpRefused = { status: 403, body: { code: 'PASSKEY_STEP_UP_REQUIRED' } }

    test('a non-passkey session opens Admin but cannot grant, reset, impersonate, invite an admin or act on another admin', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await sessionOfAdmin({ createdAt: new Date() })
      expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(200)
      const refusals = [
        await act(admin, 'instanceAdmin.grant', { userId: target.userId }),
        await act(admin, 'user.resetPasskeys', { userId: target.userId }),
        await act(admin, 'user.invite', { email: `${crypto.randomUUID().slice(0, 8)}@linedesk.test`, name: 'New Admin', admin: true }),
        await act(admin, 'user.disable', { userId: otherAdmin.userId }),
        await act(admin, 'instanceAdmin.revoke', { userId: otherAdmin.userId }),
        await request(admin, 'POST', '/v1/impersonation/start', { userId: target.userId }),
      ]
      // No passkey yet: what is missing is the first passkey (enrolment code path).
      for (const res of refusals) expect(res).toMatchObject({ ...stepUpRefused, body: { ...stepUpRefused.body, stepUp: 'enrol' } })
      expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.instanceAdmin).toBe(false)
      expect((await db.select().from(user).where(eq(user.id, otherAdmin.userId)))[0]!.disabledAt).toBeNull()
      // With a passkey on the account, the dialog asks to confirm with it.
      await addPasskey()
      expect(await act(admin, 'instanceAdmin.grant', { userId: target.userId })).toMatchObject({ ...stepUpRefused, body: { stepUp: 'confirm' } })
    })

    test('F2: an admin\'s workspace membership counts as acting on them: setRole and remove by memberId need the passkey', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await sessionOfAdmin({ createdAt: new Date() })
      const adminMember = `m_${crypto.randomUUID().slice(0, 12)}`
      const plainMember = `m_${crypto.randomUUID().slice(0, 12)}`
      await db.insert(memberTable).values([
        { id: adminMember, organizationId: other.id, userId: otherAdmin.userId, role: 'admin', createdAt: new Date() },
        { id: plainMember, organizationId: other.id, userId: target.userId, role: 'admin', createdAt: new Date() },
      ])
      expect(await act(admin, 'membership.setRole', { memberId: adminMember, role: 'member' })).toMatchObject(stepUpRefused)
      expect(await act(admin, 'membership.remove', { memberId: adminMember })).toMatchObject(stepUpRefused)
      expect(await act(admin, 'membership.add', { userId: otherAdmin.userId, workspaceId: home.id, role: 'member' })).toMatchObject(stepUpRefused)
      // A member who is no instance admin: no passkey needed.
      expect((await act(admin, 'membership.setRole', { memberId: plainMember, role: 'member' })).status).toBe(200)
      expect((await act(admin, 'membership.remove', { memberId: plainMember })).status).toBe(200)
      await db.delete(memberTable).where(eq(memberTable.id, adminMember))
    })

    test('actions on users who are not admins, and the rest of Admin, need no passkey', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await sessionOfAdmin({ createdAt: new Date() })
      expect((await act(admin, 'user.disable', { userId: target.userId })).status).toBe(200)
      expect((await act(admin, 'user.enable', { userId: target.userId })).status).toBe(200)
    })

    test('in a passkey session they run, and (c) only then is an enrolment code handed out', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await addPasskey()
      const now = new Date()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      const granted = await act(admin, 'instanceAdmin.grant', { userId: target.userId })
      expect(granted).toMatchObject({ status: 200, body: { data: { enrolmentCode: expect.any(String) } } })
      await setAdmin(target, false)
    })

    test('(c) the handlers themselves never give an enrolment code to a session without a passkey sign-in', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const plain: Actor = { actorId: admin.userId, role: 'member', workspaceId: null, permissions: ['instance:admin'], sessionId: 's' }
      for (const [name, input] of [
        ['instanceAdmin.grant', { userId: target.userId }],
        ['user.resetPasskeys', { userId: target.userId }],
        ['user.invite', { email: 'never@linedesk.test', name: 'Never', admin: true }],
      ] as const) {
        await expect(adminHandlers[name]!({ tx: db, actor: plain, now: new Date().toISOString() }, input), name).rejects.toThrow(/passkey/)
      }
      expect(mayReceiveEnrolmentCode({ ...plain, passkeyConfirmed: true })).toBe(true)
      process.env.ADMIN_SECOND_FACTOR = 'off'
      expect(mayReceiveEnrolmentCode(plain)).toBe(true)
    })

    test('a passkey sign-in older than 12 hours no longer counts for them', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await addPasskey()
      // Admin itself is closed by then too; even a fresh session with an old passkey mark is not confirmed.
      await sessionOfAdmin({ createdAt: new Date(), passkeyVerifiedAt: new Date(Date.now() - 13 * HOUR) })
      expect(await act(admin, 'instanceAdmin.grant', { userId: target.userId })).toMatchObject(stepUpRefused)
    })
  })

  describe('(d) every instance admin is emailed', () => {
    let operatorEmail = ''
    beforeAll(async () => {
      operatorEmail = await emailOf(operator)
    })
    const mails = () => vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const sentTo = (send: ReturnType<typeof mails>, subject: RegExp) =>
      send.mock.calls.map(([m]) => m).filter(m => subject.test(m.subject)).map(m => m.to)

    test('when an admin signs in with a password, every admin hears of it', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      expect((await signIn(admin)).status).toBe(200)
      const adminAddresses = [await emailOf(admin), await emailOf(operator)]
      await vi.waitFor(() => expect(sentTo(send, /^Admin sign-in/)).toEqual(expect.arrayContaining(adminAddresses)))
      const mail = send.mock.calls.map(([m]) => m).find(m => /^Admin sign-in/.test(m.subject))!
      expect(mail.text).toMatch(/signed in with a password/)
    })

    test('a passkey sign-in from a known device sends nothing; from a new one it does; a member\'s sign-in never', async () => {
      const send = mails()
      const device = { ipAddress: '203.0.113.7', userAgent: `Browser ${crypto.randomUUID()}` }
      const passkeySignIn = { path: '/passkey/verify-authentication' }
      const record = () =>
        db.insert(auth_events).values({ id: `ae_${crypto.randomUUID().slice(0, 12)}`, user_id: admin.userId, event: 'sign_in', method: 'passkey', ip_address: device.ipAddress, user_agent: device.userAgent })
      await record() // this sign-in, as the audit log records it first
      await alertOnAdminSignIn({ userId: admin.userId, ...device }, passkeySignIn)
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator)) // first time from here
      send.mockClear()
      await record()
      await alertOnAdminSignIn({ userId: admin.userId, ...device }, passkeySignIn)
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      await alertOnAdminSignIn({ userId: member.userId, ...device }, { path: '/sign-in/email' })
      await alertOnAdminSignIn({ userId: admin.userId, impersonatedBy: operator.userId, ...device }, { path: '/sign-in/email' })
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
    })

    test('F1: an admin session from an endpoint the alert does not know is still reported, as another method', async () => {
      const send = mails()
      await alertOnAdminSignIn({ userId: admin.userId, ipAddress: '198.51.100.4', userAgent: 'x' }, { path: '/some/new-endpoint' })
      await alertOnAdminSignIn({ userId: admin.userId }, undefined)
      const alerts = send.mock.calls.map(([m]) => m).filter(m => /^Admin sign-in/.test(m.subject) && m.to === operatorEmail)
      expect(alerts).toHaveLength(2)
      expect(alerts[0]!.text).toMatch(/a sign-in method Linedesk does not recognise/)
    })

    test('F4: the alert carries no links and no long browser strings', () => {
      const ua = `Mozilla/5.0 (evil) visit https://phish.example/reset?x=1 or www.phish.example now ${'A'.repeat(300)}`
      const { text } = adminSignInEmail('ann@linedesk.test', 'password', true, { userId: 'u', ipAddress: '203.0.113.9', userAgent: ua })
      expect(text).not.toMatch(/https?:|www\./)
      expect(text).toContain('[link]')
      const browserLine = text.split('\n').find(line => line.startsWith('Browser: '))!
      expect(browserLine.length).toBeLessThanOrEqual('Browser: '.length + 120)
      expect(plainSnippet(null)).toBe('unknown')
    })

    test('when admin is granted and when passkeys are reset', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const someone = await signUp()
      const now = new Date()
      await addPasskey()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      expect((await act(admin, 'instanceAdmin.grant', { userId: someone.userId })).status).toBe(200)
      expect(sentTo(send, /^New instance admin/)).toEqual(expect.arrayContaining([await emailOf(admin), await emailOf(operator)]))
      expect((await act(admin, 'user.resetPasskeys', { userId: someone.userId })).status).toBe(200)
      const reset = send.mock.calls.map(([m]) => m).filter(m => /^Passkeys reset/.test(m.subject))
      expect(reset.map(m => m.to)).toEqual(expect.arrayContaining([await emailOf(operator)]))
      expect(reset[0]!.text).toContain(await emailOf(admin)) // who did it
      await setAdmin(someone, false)
    })
  })

  test('ADMIN_SECOND_FACTOR=off turns the rule off, the email check and the passkey step-up included, with a loud warning', async () => {
    expect(adminSecondFactorRequired({})).toBe(true)
    expect(adminSecondFactorRequired({ ADMIN_SECOND_FACTOR: 'OFF' })).toBe(false)
    expect(secondFactorOffWarning({})).toBeNull()
    expect(secondFactorOffWarning({ ADMIN_SECOND_FACTOR: 'off' })).toMatch(/WARNING: ADMIN_SECOND_FACTOR=off/)
    process.env.ADMIN_SECOND_FACTOR = 'off'
    await confirmEmail(false)
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(200)
    const someone = await signUp()
    expect((await act(admin, 'instanceAdmin.grant', { userId: someone.userId })).status).toBe(200)
    await setAdmin(someone, false)
  })
})

describe('audit log', () => {
  type Entry = {
    id: string
    at: string
    kind: string
    what: string
    method: string | null
    actor: { id: string | null; email: string | null }
    workspace: { id: string; name: string | null } | null
    input: unknown
    refused: boolean
  }
  const audit = async (query = '') =>
    (await request(operator, 'GET', `/v1/admin/audit${query}`)).body as { entries: Entry[]; next: string | null }

  test('only instance admins read it', async () => {
    expect((await request(other.owner, 'GET', '/v1/admin/audit')).status).toBe(403)
    expect((await request(operator, 'GET', '/v1/admin/audit?kind=everything')).status).toBe(400)
  })

  test('a sign-in is recorded with its method and found by the person', async () => {
    const person = await signUp()
    const email = await emailOf(person)
    expect((await signIn(person)).status).toBe(200)
    const { entries } = await audit(`?kind=sign_in&who=${encodeURIComponent(email.toUpperCase())}`)
    expect(entries.map(e => [e.what, e.method])).toEqual([
      ['sign_in', 'password'],
      ['sign_up', 'password'],
    ])
    expect(entries[0]!.actor).toMatchObject({ id: person.userId, email })
  })

  test('admin actions, refused ones too, and provider keys without their values', async () => {
    const victim = await signUp()
    await act(operator, 'user.disable', { userId: victim.userId })
    await act(operator, 'user.enable', { userId: victim.userId })
    // Speech to text, not telephony: other test files place calls at the same time.
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    await act(operator, 'user.disable', { userId: operator.userId }) // refused: not yourself
    const { entries } = await audit('?limit=50')
    const recent = entries.filter(e => e.actor.id === operator.userId)
    expect(recent.find(e => e.what === 'user.disable' && !e.refused)).toMatchObject({
      kind: 'admin',
      input: { userId: victim.userId },
    })
    const keys = recent.find(e => e.what === 'provider.setKeys')!
    expect(keys.kind).toBe('keys')
    expect(JSON.stringify(keys)).not.toContain(SECRET)
    await clearAll()
    expect((await audit('?kind=keys')).entries.every(e => e.kind === 'keys')).toBe(true)
    expect(
      recent.find(e => e.what === 'user.disable' && (e.input as { userId: string }).userId === operator.userId),
    ).toMatchObject({ refused: true })
  })

  test('an admin adding themselves to a workspace is listed under that workspace, with whom it was about', async () => {
    const operatorEmail = await emailOf(operator)
    const added = await act(operator, 'membership.add', { userId: operator.userId, workspaceId: other.id, role: 'owner' })
    expect(added.status).toBe(200)
    const removed = await act(operator, 'membership.remove', { memberId: added.body.data.memberId })
    expect(removed.status).toBe(200)
    const { entries } = await audit(`?kind=admin&workspace=${other.id}`)
    // Newest first; other tests in this file change memberships of `other` too.
    const mine = entries.filter(e => e.actor.id === operator.userId && e.what.startsWith('membership.')).slice(0, 2)
    expect(mine.map(e => e.what)).toEqual(['membership.remove', 'membership.add'])
    for (const e of mine) expect(e).toMatchObject({ kind: 'admin', workspace: { id: other.id }, subject: { email: operatorEmail } })
    expect(mine[1]!.input).toMatchObject({ role: 'owner' })
  })

  test('removing a member, leaving, API keys and webhooks are recorded, the member named', async () => {
    const ws = await createWorkspace('Audit Trail Plumbing')
    const leaver = await addMember(ws.id, 'member')
    const removed = await addMember(ws.id, 'admin')
    const removedEmail = await emailOf(removed)
    const [row] = await db.select().from(memberTable).where(eq(memberTable.userId, removed.userId))
    expect((await act(ws.owner, 'team.setRole', { memberId: row!.id, role: 'member' })).status).toBe(200)
    expect((await act(ws.owner, 'team.removeMember', { memberId: row!.id })).status).toBe(200)
    expect((await act(leaver, 'team.leave', {})).status).toBe(200)
    const key = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'member' })
    expect(key.status).toBe(200)
    expect((await act(ws.owner, 'webhook.delete', { endpointId: ws.webhookEndpoint.id })).status).toBe(200)
    const { entries } = await audit(`?workspace=${ws.id}&limit=50`)
    const byWhat = (what: string) => entries.find(e => e.what === what)
    expect(byWhat('team.setRole')).toMatchObject({ kind: 'team', subject: { email: removedEmail }, input: { role: 'member' } })
    expect(byWhat('team.removeMember')).toMatchObject({ kind: 'team', subject: { email: removedEmail } })
    expect(byWhat('team.leave')).toMatchObject({ kind: 'team', actor: { id: leaver.userId } })
    expect(byWhat('apiKey.create')).toMatchObject({ kind: 'integrations', input: { name: 'Zapier' } })
    expect(byWhat('webhook.delete')).toMatchObject({ kind: 'integrations' })
    // The key itself is never in the log.
    expect(JSON.stringify(byWhat('apiKey.create'))).not.toContain(key.body.data.key)
    const integrations = (await audit(`?kind=integrations&workspace=${ws.id}`)).entries
    expect(integrations.map(e => e.what).sort()).toEqual(['apiKey.create', 'webhook.delete'])
  })

  test('team changes carry their workspace and can be filtered by it', async () => {
    const joined = await addMember(other.id, 'member')
    const [row] = await db.select().from(memberTable).where(eq(memberTable.userId, joined.userId))
    expect((await act(other.owner, 'team.setRole', { memberId: row!.id, role: 'admin' })).status).toBe(200)
    const { entries } = await audit(`?kind=team&workspace=${other.id}`)
    expect(entries[0]).toMatchObject({
      what: 'team.setRole',
      kind: 'team',
      workspace: { id: other.id, name: 'Brightwater Plumbing & Heating' },
    })
    expect(
      (await audit(`?kind=team&workspace=${home.id}`)).entries.some(
        e => e.what === 'team.setRole' && e.workspace?.id === other.id,
      ),
    ).toBe(false)
  })

  test('pages go back in time without gaps or repeats', async () => {
    const first = await audit('?limit=3')
    expect(first.entries).toHaveLength(3)
    expect(first.next).toBeTruthy()
    const second = await audit(`?limit=3&before=${encodeURIComponent(first.next!)}`)
    const ids = [...first.entries, ...second.entries].map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const both = (await audit('?limit=6')).entries.map(e => e.id)
    expect(ids).toEqual(both.slice(0, ids.length))
    expect((await request(operator, 'GET', '/v1/admin/audit?before=nonsense')).status).toBe(400)
  })

  test('a deleted user’s entries stay, without their email, address or browser', async () => {
    const leaving = await signUp()
    expect((await signIn(leaving)).status).toBe(200)
    const before = await db.select().from(auth_events).where(eq(auth_events.user_id, leaving.userId))
    expect(before.map(e => e.event)).toEqual(expect.arrayContaining(['sign_up', 'sign_in']))
    expect(before.some(e => e.email !== null)).toBe(true)
    await db.delete(user).where(eq(user.id, leaving.userId))
    const after = await db.select().from(auth_events).where(eq(auth_events.user_id, leaving.userId))
    expect(after.map(e => e.id).sort()).toEqual(before.map(e => e.id).sort())
    for (const e of after) expect(e).toMatchObject({ email: 'deleted', ip_address: null, user_agent: null })
    // Everyone else's entries are untouched.
    const kept = await db.select().from(auth_events).where(eq(auth_events.user_id, operator.userId))
    expect(kept.every(e => e.email !== 'deleted')).toBe(true)
  })

  test('impossible dates and cursors are refused with 400, never reach the database', async () => {
    for (const query of [
      'from=2026-02-30',
      'to=2026-13-01',
      'from=2026-1-5',
      'to=yesterday',
      'before=2026-02-30T10:00:00.000Z|ae_1',
      'before=2026-11-11T25:61:00.000Z|ae_1',
      `before=${encodeURIComponent("2026-11-11T10:00:00.000Z|x' or 1=1")}`,
    ]) {
      expect((await request(operator, 'GET', `/v1/admin/audit?${query}`)).status, query).toBe(400)
    }
    expect((await request(operator, 'GET', '/v1/admin/audit?from=2024-02-29&to=2026-11-11')).status).toBe(200)
  })

  test('the sign-in method comes from the endpoint that made the session; impersonation is not a sign-in', () => {
    expect(signInMethod({ path: '/sign-in/email' })).toBe('password')
    expect(signInMethod({ path: '/sign-in/email-otp' })).toBe('email_code')
    expect(signInMethod({ path: '/passkey/verify-authentication' })).toBe('passkey')
    expect(signInMethod({ path: '/callback/:id', params: { id: 'github' } })).toBe('github')
    expect(signInMethod({ path: '/oauth2/callback/:providerId', params: { providerId: 'oidc' } })).toBe('oidc')
    expect(signInMethod(undefined)).toBeNull()
  })
})

describe('monthly spending cap', () => {
  const capOf = async (workspaceId: string) => (await db.select().from(organization).where(eq(organization.id, workspaceId)))[0]?.spendingCapCents
  /** A finished phone call of `minutes` this month (or `daysAgo` back), straight into the table. */
  const pastCall = (workspaceId: string, minutes: number, daysAgo = 0) =>
    db.insert(calls).values({
      id: `call_cap_${randomBytes(6).toString('hex')}`, workspace_id: workspaceId, from_number: '+15035550142', to_number: '+15035550100',
      source: 'phone', status: 'completed', duration_sec: Math.round(minutes * 60),
      started_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    })
  /** Starts and finishes a short phone call through the agent: call.finish queues the alerts. */
  const finishedCall = async (ws: Workspace) => {
    const { body } = await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })
    expect(body.data.overCap).toBe(false)
    await act(agent(ws.id), 'call.finish', { callId: body.data.callId })
  }
  let alerts: { name: string; data: { workspaceId: string; month: string; level: number } }[] = []
  beforeEach(() => {
    alerts = []
    setJobQueue({ send: async (name: string, data: never) => void alerts.push({ name, data }) } as never)
    // A speech provider with a price per minute, so calls cost something in the estimate.
    vi.stubEnv('DEEPGRAM_API_KEY', 'test-deepgram-key')
  })
  afterEach(() => {
    setJobQueue(null)
    vi.unstubAllEnvs()
  })

  test('off by default; only instance admins set it; 80 % and 100 % alerts once a month; at the cap calls get a line and a callback', async () => {
    const ws = await createWorkspace('Capped Plumbing')
    // Over 10 000 minutes, so the estimate's rounding to cents does not matter.
    const perMinute = (await costEstimate(db))({ all: 600_000, phone: 600_000 }) / 10_000
    expect(perMinute).toBeGreaterThan(0)
    // $1 cap: about 1 / perMinute minutes.
    const capMinutes = 1 / perMinute
    expect(await capOf(ws.id)).toBeNull()
    await pastCall(ws.id, capMinutes * 2)
    await finishedCall(ws) // no cap: answered, nothing queued
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT)).toEqual([])
    await db.delete(calls).where(eq(calls.workspace_id, ws.id))

    for (const who of [ws.owner, agent(ws.id)]) {
      expect((await act(who, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1 })).status).toBe(403)
    }
    expect((await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: -1 })).status).toBe(422)
    const set = await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1 })
    expect(set.body.data).toMatchObject({ spending_cap_usd: 1, spent_usd: 0, reached: false })
    expect(await capOf(ws.id)).toBe(100)

    // Last month's calls do not count; 85 % this month sends the 80 % email, once.
    await pastCall(ws.id, capMinutes * 3, 40)
    await pastCall(ws.id, capMinutes * 0.85)
    await finishedCall(ws)
    await finishedCall(ws)
    const month = new Date().toISOString().slice(0, 7)
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data)).toEqual([{ workspaceId: ws.id, month, level: 80 }])

    // Past the cap (a call that finished, so call.finish sends the 100 % email): the next phone call is not answered
    // by the assistant, and the 100 % email is not sent twice.
    const last = (await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })).body.data.callId
    await db.update(calls).set({ started_at: new Date(Date.now() - capMinutes * 0.2 * 60_000).toISOString() }).where(eq(calls.id, last))
    await act(agent(ws.id), 'call.finish', { callId: last })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80, 100])
    const capped = await act(agent(), 'call.start', { from: '+15035550178', to: ws.number })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80, 100])
    expect(capped.body.data).toMatchObject({ overCap: true, blocked: true, busy: false, booking: null })
    expect(await getCall(capped.body.data.callId)).toMatchObject({
      status: 'completed', outcome: 'hangup', title: 'Missed call', unread: true, action_items: [{ text: 'Call back' }],
      summary: expect.stringContaining('monthly spending cap'),
    })
    expect(alerts.filter(a => a.name === 'call.push').map(a => a.data)).toContainEqual({ callId: capped.body.data.callId, kind: 'finished' })
    // Test calls are off too.
    vi.stubEnv('LIVEKIT_URL', 'ws://livekit.test:7880')
    vi.stubEnv('LIVEKIT_API_KEY', 'k')
    vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret-test-secret-test-secret')
    expect(await act(ws.owner, 'assistant.startTestCall', {})).toMatchObject({ status: 409, body: { error: TEST_CALLS_OVER_CAP } })

    // The admin list shows the cap and the estimate.
    const listed = (await request(operator, 'GET', '/v1/admin/workspaces')).body.workspaces.find((w: { id: string }) => w.id === ws.id)
    expect(listed).toMatchObject({ spending_cap_usd: 1 })
    expect(listed.cost_this_month).toBeGreaterThanOrEqual(1)

    // A higher cap answers calls again, and its alerts start over; no cap at all answers too.
    alerts = []
    expect((await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1.2 })).body.data).toMatchObject({ reached: false })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80])
    expect((await act(agent(), 'call.start', { from: '+15035550179', to: ws.number })).body.data.overCap).toBe(false)
    await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: null })
    expect(await capOf(ws.id)).toBeNull()
  })

  test('the alert email goes to the owners and the instance admins, once per address, and says what happens', async () => {
    const ws = await createWorkspace('Alerted Plumbing')
    const coOwner = await addMember(ws.id, 'admin')
    await db.update(memberTable).set({ role: 'owner' }).where(and(eq(memberTable.organizationId, ws.id), eq(memberTable.userId, coOwner.userId)))
    await addMember(ws.id, 'member')
    await db.update(organization).set({ spendingCapCents: 0 }).where(eq(organization.id, ws.id))
    const sent: { to: string; subject: string; text: string }[] = []
    const sender = { kind: 'smtp' as const, send: async (email: (typeof sent)[number]) => void sent.push(email), check: async () => ({ ok: true, message: '' }) }
    const month = new Date().toISOString().slice(0, 7)
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month, level: 100 })).toMatchObject({ failed: 0 })
    const to = sent.map(e => e.to)
    expect(to).toEqual(expect.arrayContaining([await emailOf(ws.owner), await emailOf(coOwner), await emailOf(operator)].map(a => a.toLowerCase())))
    expect(new Set(to).size).toBe(to.length)
    expect(sent[0]).toMatchObject({ subject: 'Alerted Plumbing reached its monthly spending cap', text: expect.stringContaining('call them back') })
    // Another month, or no cap any more: nothing is sent.
    sent.length = 0
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month: '2001-01', level: 80 })).toEqual({ sent: 0, failed: 0 })
    await db.update(organization).set({ spendingCapCents: null }).where(eq(organization.id, ws.id))
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month, level: 100 })).toEqual({ sent: 0, failed: 0 })
    expect(sent).toEqual([])
  })
})
