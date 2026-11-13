// The instance setup checklist (GET /v1/admin/setup-checklist, setup-checklist.ts): who may read it, that reading
// never calls a provider (tests run through provider.test), what each state means, that tests are remembered per
// set of keys, and that no key ever leaves. Sets provider keys and
// instance admins, so it is one of the instance-wide files (vitest.config.ts).
import { commands, instance_settings, provider_settings, provider_tests, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { forgetTests } from '../src/setup-checklist.ts'
import { db } from '../src/db.ts'
import { act, addMember, agent, anonymous, createWorkspace, request, type User, type Workspace } from './helpers.ts'

const SECRET = 'KEY-made-up-checklist-0123456789'
const OTHER_SECRET = 'KEY-made-up-checklist-other-9876543210'
const ROUTE = '/v1/admin/setup-checklist'

let home: Workspace
let other: Workspace
let operator: User
let member: User

type Item = { id: string; state: string; provider: string | null; message: string | null; coveredBy: string | null }
const checklist = async (query = '') => {
  const res = await request(operator, 'GET', `${ROUTE}${query}`)
  expect(res.status).toBe(200)
  return res.body as { items: Item[]; ready: number; complete: boolean }
}
const item = (body: { items: Item[] }, id: string) => body.items.find(i => i.id === id)!
// A body every provider test reads as fine (Deepgram's looks for the key's project).
const answering = (status = 200) =>
  vi.fn(
    async (_url?: unknown, _init?: unknown) =>
      new Response(status === 200 ? JSON.stringify({ projects: [{ project_id: 'p1' }] }) : '{}', { status }),
  )
/** The provider tests ran against one provider's API only (one test, however many requests it makes). */
const oneProvider = (mock: ReturnType<typeof answering>) =>
  new Set(mock.mock.calls.map(c => new URL(String(c[0])).host)).size
const testProvider = async (provider: string) => {
  const res = await act(operator, 'provider.test', { provider })
  expect(res.status).toBe(200)
  return res.body.data as { ok: boolean; message: string }
}

beforeAll(async () => {
  home = await createWorkspace('Linedesk Operations')
  other = await createWorkspace('Brightwater Plumbing & Heating')
  operator = home.owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  member = await addMember(other.id, 'member')
}, 60_000)

beforeEach(async () => {
  await db.delete(provider_settings)
  await db.delete(instance_settings)
  await forgetTests(db)
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) process.env[name] = ''
})

describe('access', () => {
  test('instance admins only: workspace owners, members and the agent are refused', async () => {
    expect((await request(operator, 'GET', ROUTE)).status).toBe(200)
    expect(await request(other.owner, 'GET', ROUTE)).toMatchObject({
      status: 403,
      body: { ok: false, error: 'missing permission instance:admin' },
    })
    expect((await request(member, 'GET', ROUTE)).status).toBe(403)
    expect((await request(agent(other.id), 'GET', ROUTE)).status).toBe(403)
    expect((await request(agent(), 'GET', ROUTE)).status).toBe(403)
    expect((await request(anonymous, 'GET', ROUTE)).status).toBe(401)
  })

  test('reading is read-only: no provider is called, whatever the query; a refused caller cannot test', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    expect(item(await checklist('?test=all'), 'stt').state).toBe('set_up')
    expect((await request(other.owner, 'GET', ROUTE)).status).toBe(403)
    expect((await act(other.owner, 'provider.test', { provider: 'deepgram' })).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('states', () => {
  test('a fresh install: every part missing, in order, nothing tested', async () => {
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    const body = await checklist()
    expect(body.items.map(i => [i.id, i.state])).toEqual([
      ['email', 'missing'],
      ['telephony', 'missing'],
      ['stt', 'missing'],
      ['llm', 'missing'],
      ['tts', 'missing'],
      ['livekit', 'missing'],
    ])
    expect(body).toMatchObject({ ready: 0, complete: false })
    // No keys, no LiveKit in env: nothing to ask.
    expect(fetchMock).not.toHaveBeenCalled()
    // EMAIL_TO_LOG says so; TELEPHONY_PROVIDER=dev is a working development carrier, not a missing one.
    expect(item(body, 'email').message).toContain('EMAIL_TO_LOG')
    process.env.TELEPHONY_PROVIDER = 'dev'
    try {
      expect(item(await checklist(), 'telephony')).toMatchObject({ state: 'ok' })
      expect(item(await checklist(), 'telephony').message).toContain('TELEPHONY_PROVIDER=dev')
      // Carrier keys in env count as set up: the line says what to change to use them.
      process.env.TELNYX_API_KEY = 'KEY_test_env'
      process.env.TELNYX_PUBLIC_KEY = 'test-public-key'
      expect(item(await checklist(), 'telephony').message).toContain('Telnyx keys are set')
    } finally {
      process.env.TELEPHONY_PROVIDER = ''
      delete process.env.TELNYX_API_KEY
      delete process.env.TELNYX_PUBLIC_KEY
    }
  })

  test('keys set: "set_up" until tested; a test passes or fails for exactly these keys; no key in the answer', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    const plain = await checklist()
    expect(item(plain, 'stt')).toMatchObject({
      state: 'set_up',
      provider: 'deepgram',
      message: 'Keys set, not tested yet',
    })

    // Test (provider.test, the same action as Admin, Providers) records its result.
    vi.stubGlobal('fetch', answering(200))
    expect((await testProvider('deepgram')).ok).toBe(true)
    const fetchMock = answering(500)
    vi.stubGlobal('fetch', fetchMock)
    const tested = await checklist()
    expect(item(tested, 'stt')).toMatchObject({ state: 'ok', message: 'Connected' })
    // Remembered: reading asks no one.
    expect(fetchMock).not.toHaveBeenCalled()
    // Stored, so a restart or update keeps it; the row holds a fingerprint of the keys, never a key.
    const stored = await db.select().from(provider_tests)
    expect(stored).toMatchObject([{ provider: 'deepgram', ok: true }])
    expect(JSON.stringify(stored)).not.toContain(SECRET)

    // Past the cooldown (provider.test answers from memory for 10 s): asked again.
    await forgetTests(db)
    vi.stubGlobal('fetch', answering(401))
    expect((await testProvider('deepgram')).ok).toBe(false)
    const failing = await checklist()
    expect(item(failing, 'stt')).toMatchObject({
      state: 'failing',
      message: 'Deepgram rejected the key (HTTP 401). Enter a valid key under Admin › Providers › Deepgram.',
    })

    // New keys are untested again.
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: OTHER_SECRET } })
    expect(item(await checklist(), 'stt').state).toBe('set_up')

    const everything = JSON.stringify([plain, tested, failing, await checklist()])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(OTHER_SECRET)
    expect(everything).not.toContain(SECRET.slice(-4))
  })

  test('a provider whose error text quotes the key: the message never carries it', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openrouter', values: { api_key: SECRET } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect refused for ${SECRET}`)
      }),
    )
    const result = await testProvider('openrouter')
    const body = await checklist()
    expect(item(body, 'llm').state).toBe('failing')
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  test('a realtime model in use covers speech, model and voice: one test for all three, and the way back', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openai_realtime', values: { api_key: SECRET } })
    await act(operator, 'provider.setActive', { category: 'realtime', provider: 'openai_realtime' })
    const fetchMock = answering(200)
    vi.stubGlobal('fetch', fetchMock)
    await testProvider('openai_realtime')
    expect(oneProvider(fetchMock)).toBe(1)
    const body = await checklist()
    for (const id of ['stt', 'llm', 'tts'])
      expect(item(body, id), id).toMatchObject({
        state: 'ok',
        provider: 'openai_realtime',
        coveredBy: 'openai_realtime',
        // The OpenAI test lists models: it proves the key, so it says so.
        message: expect.stringMatching(/^Covered by OpenAI Realtime: Key accepted\. .*Disconnect.*OpenAI Realtime/),
      })
  })

  test('LiveKit: reachable with a trunk is ok; without a trunk only the phone is missing; down is failing', async () => {
    process.env.LIVEKIT_URL = 'ws://livekit.checklist.test:7880'
    process.env.LIVEKIT_API_KEY = 'APImadeup'
    process.env.LIVEKIT_API_SECRET = 'made-up-livekit-secret-0123456789'
    const livekit = (trunks: number) =>
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.includes('SIP') ? { items: Array(trunks).fill({}) } : { rooms: [] })),
      )
    vi.stubGlobal('fetch', livekit(1))
    expect(item(await checklist(), 'livekit')).toMatchObject({ state: 'ok' })
    vi.stubGlobal('fetch', livekit(0))
    expect(item(await checklist(), 'livekit')).toMatchObject({
      state: 'set_up',
      message: expect.stringContaining('setup-sip'),
    })
    vi.stubGlobal('fetch', answering(401))
    const down = await checklist()
    expect(item(down, 'livekit').state).toBe('failing')
    expect(JSON.stringify(down)).not.toContain('made-up-livekit-secret')
  })
})

describe('provider.test cooldown', () => {
  test('the same keys within 10 s: the last result, no second request; new keys are asked at once', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    // Deepgram's test reads the key's project first.
    vi.stubGlobal('fetch', answering(200))
    expect((await testProvider('deepgram')).ok).toBe(true)
    const refused = answering(401)
    vi.stubGlobal('fetch', refused)
    expect((await testProvider('deepgram')).ok).toBe(true)
    expect(refused).not.toHaveBeenCalled()
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: OTHER_SECRET } })
    expect((await testProvider('deepgram')).ok).toBe(false)
  })

  test('older than 10 s: asked again', async () => {
    const { recentTest, rememberTest, TEST_COOLDOWN_MS } = await import('../src/setup-checklist.ts')
    const config = { api_key: { value: SECRET, source: 'app' as const } }
    const at = new Date('2026-11-13T04:00:00Z')
    await rememberTest(db, 'deepgram', config, { ok: true, message: 'Connected' }, at)
    expect(await recentTest(db, 'deepgram', config, new Date(at.getTime() + TEST_COOLDOWN_MS - 1))).toEqual({
      ok: true,
      message: 'Connected',
    })
    expect(await recentTest(db, 'deepgram', config, new Date(at.getTime() + TEST_COOLDOWN_MS))).toBeNull()
  })
})

describe('provider.connectOneKey', () => {
  const NEW_KEY = 'sk-made-up-onekey-new-0123456789'
  const providers = async () => (await request(operator, 'GET', '/v1/admin/providers')).body
  const settings = async () => ({
    keys: (await db.select().from(provider_settings)).map(r => [r.provider, r.field, r.value_encrypted]).sort(),
    instance: (await db.select().from(instance_settings)).map(r => [r.key, r.value]).sort(),
  })

  test('a working key: tested first, stored once for the realtime model, picked; speech and model use it', async () => {
    const fetchMock = answering(200)
    vi.stubGlobal('fetch', fetchMock)
    const res = await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ ok: true, linked: ['openai_stt', 'openai'] })
    expect(oneProvider(fetchMock)).toBe(1)
    // Stored once: one key row, for the realtime model.
    expect((await db.select().from(provider_settings)).map(r => [r.provider, r.field])).toEqual([
      ['openai_realtime', 'api_key'],
    ])
    const body = await providers()
    expect(body.active).toMatchObject({
      realtime: { provider: 'openai_realtime', chosen: true },
      stt: { provider: 'openai_stt' },
      llm: { provider: 'openai' },
    })
    const keyOf = (name: string) =>
      body.providers
        .find((p: { provider: string }) => p.provider === name)
        .fields.find((f: { field: string }) => f.field === 'api_key')
    expect(keyOf('openai_stt')).toMatchObject({ source: 'app', key_from: 'openai_realtime', last4: NEW_KEY.slice(-4) })
    expect(keyOf('openai')).toMatchObject({ source: 'app', key_from: 'openai_realtime' })
    // The agent gets the key for all three.
    const { resolveProvider } = await import('../src/provider-settings.ts')
    expect((await resolveProvider(db, 'openai_stt')).api_key?.value).toBe(NEW_KEY)
    // Tested already: the checklist says so without asking again.
    const list = await checklist()
    expect(['stt', 'llm', 'tts'].map(id => item(list, id).state)).toEqual(['ok', 'ok', 'ok'])
    expect(oneProvider(fetchMock)).toBe(1)
    // The command log keeps the key redacted.
    expect(JSON.stringify(await db.select().from(commands))).not.toContain(NEW_KEY)

    // Disconnect on the realtime model ends all three: no copy keeps working.
    expect((await act(operator, 'provider.clearKeys', { provider: 'openai_realtime' })).status).toBe(200)
    expect((await resolveProvider(db, 'openai_stt')).api_key).toBeUndefined()
    expect((await resolveProvider(db, 'openai')).api_key).toBeUndefined()
    const after = await providers()
    expect(after.active).toMatchObject({ stt: { provider: null }, llm: { provider: null } })
    // The realtime pick stays (the dialog's Disconnect also clears it), but nothing answers with it any more.
    const { realtimeInUse } = await import('../src/provider-settings.ts')
    expect(await realtimeInUse(db)).toBe(false)
    expect((await settings()).instance.filter(([key]) => key!.startsWith('key_from.'))).toEqual([])
  })

  test('only where nothing is set up: a speech provider of its own stays', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    vi.stubGlobal('fetch', answering(200))
    const res = await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })
    expect(res.body.data.linked).toEqual(['openai'])
    expect((await providers()).active.stt.provider).toBe('deepgram')
  })

  test('a speech provider given its own key later keeps it when the realtime key goes', async () => {
    vi.stubGlobal('fetch', answering(200))
    await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })
    await act(operator, 'provider.setKeys', { provider: 'openai_stt', values: { api_key: OTHER_SECRET } })
    await act(operator, 'provider.clearKeys', { provider: 'openai_realtime' })
    const { resolveProvider } = await import('../src/provider-settings.ts')
    expect((await resolveProvider(db, 'openai_stt')).api_key?.value).toBe(OTHER_SECRET)
  })

  test('a failing key changes nothing: no key stored, nothing picked, and a key stored before stays', async () => {
    vi.stubGlobal('fetch', answering(401))
    const res = await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^OpenAI.*Nothing was changed/)
    expect(JSON.stringify(res.body)).not.toContain(NEW_KEY)
    expect(await settings()).toEqual({ keys: [], instance: [] })

    // An earlier realtime key (and its pick) is kept as it was: not overwritten, not cleared.
    await act(operator, 'provider.setKeys', { provider: 'openai_realtime', values: { api_key: SECRET } })
    await act(operator, 'provider.setActive', { category: 'realtime', provider: 'openai_realtime' })
    const before = await settings()
    expect((await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })).status).toBe(409)
    expect(await settings()).toEqual(before)
    const { resolveProvider } = await import('../src/provider-settings.ts')
    expect((await resolveProvider(db, 'openai_realtime')).api_key?.value).toBe(SECRET)

    // A provider that cannot be reached is a failure too.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect refused')
      }),
    )
    expect((await act(operator, 'provider.connectOneKey', { apiKey: NEW_KEY })).status).toBe(409)
    expect(await settings()).toEqual(before)
  })

  test('instance admins only: owners, members and the agent are refused before any request', async () => {
    const fetchMock = answering(200)
    vi.stubGlobal('fetch', fetchMock)
    for (const who of [other.owner, member, agent(other.id), agent()])
      expect(await act(who, 'provider.connectOneKey', { apiKey: NEW_KEY })).toMatchObject({
        status: 403,
        body: { error: 'missing permission instance:admin' },
      })
    expect((await request(anonymous, 'POST', '/v1/actions/provider.connectOneKey', { apiKey: NEW_KEY })).status).toBe(
      401,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await settings()).toEqual({ keys: [], instance: [] })
  })

  test('refused while impersonating, even with instance:admin on the actor', async () => {
    const fetchMock = answering(200)
    vi.stubGlobal('fetch', fetchMock)
    const { runAction } = await import('../src/run-action.ts')
    const { NOT_WHILE_IMPERSONATING } = await import('../src/impersonation-guard.ts')
    const res = await runAction(
      'provider.connectOneKey',
      { apiKey: NEW_KEY },
      {
        actorId: member.userId,
        role: 'member',
        workspaceId: other.id,
        permissions: ['instance:admin'],
        impersonation: { by: operator.userId, sessionId: 'made-up', expiresAt: new Date(Date.now() + 60_000) },
      },
    )
    expect(res).toMatchObject({ status: 403, body: { error: NOT_WHILE_IMPERSONATING } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await settings()).toEqual({ keys: [], instance: [] })
  })
})
