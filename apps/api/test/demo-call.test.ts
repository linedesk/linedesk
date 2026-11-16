// Public demo calls (demo-call.ts): POST /v1/demo/call for the website's gateway, every refusal, the token it signs,
// and the cleanup of demo calls (demo-rooms.ts). Own database (vitest.config.ts): demo tokens and live demo calls are
// counted across the install.
import { createHmac } from 'node:crypto'
import { DEMO_CALL_MAX_SECONDS, DEMO_LANGUAGES } from '@linedesk/actions'
import {
  assistants,
  calendar_connections,
  call_events,
  calls,
  commands,
  organization,
  phone_numbers,
  transcript_segments,
  webhook_endpoints,
} from '@linedesk/db'
import { and, eq, inArray, like } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { costEstimate, noteAgentSeen } from '../src/admin-overview.ts'
import { db } from '../src/db.ts'
import {
  DEMO_ACTOR,
  DEMO_BUDGET_SECONDS,
  DEMO_CALL_TOKEN,
  DEMO_SUMMARY_USD,
  demoCall,
  type DemoCallRequest,
  isGatewaySecret,
  parseDemoAssistants,
  resetDemoWarnings,
  resetWrongSecrets,
  WRONG_SECRET_LIMIT,
} from '../src/demo-call.ts'
import { clearOldDemoCalls, demoTranscriptDays, stripOldDemoIpHashes } from '../src/demo-rooms.ts'
import { appRequest, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

const SECRET = 'gateway-secret-gateway-secret-0123456789'
const LIVEKIT = {
  LIVEKIT_URL: 'ws://livekit.internal:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret',
  LIVEKIT_PUBLIC_URL: 'wss://livekit.example.test',
}
/** A realtime model in env: enough for the voice agent to answer, and a rate for the daily budget. */
const REALTIME = { OPENAI_REALTIME_API_KEY: 'sk-test-realtime' }
const saved = { ...process.env }

let ws: Workspace
let env: Record<string, string | undefined>
beforeAll(async () => {
  Object.assign(process.env, REALTIME)
  ws = await createWorkspace('Ridgeline Auto Care')
  // As the demo-workspace script leaves a demo assistant: not recording, nobody to put through.
  await db.update(assistants).set({ record_calls: false, transfers: [] }).where(eq(assistants.id, ws.assistant.id))
  // No phone number and no calendar either (the test workspace comes with both); its webhook stays switched off.
  await db.delete(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
  await db.delete(calendar_connections).where(eq(calendar_connections.workspace_id, ws.id))
  env = {
    ...LIVEKIT,
    DEMO_CALLS: 'on',
    DEMO_GATEWAY_SECRET: SECRET,
    DEMO_ASSISTANTS: `auto=${ws.assistant.id}`,
    DEMO_DAILY_USD: '25',
    DEMO_WORKSPACE_ID: ws.id,
  }
})
beforeEach(async () => {
  noteAgentSeen()
  resetDemoWarnings()
  resetWrongSecrets()
  await db.delete(commands).where(eq(commands.action, DEMO_CALL_TOKEN))
  await db.delete(calls).where(like(calls.room, 'demo-%'))
  await db.update(organization).set({ spendingCapCents: null }).where(eq(organization.id, ws.id))
})
afterAll(() => {
  process.env = saved
})

const hash = () => crypto.randomUUID().replaceAll('-', '')
const request = (
  body: unknown,
  { authorization = `Bearer ${SECRET}`, contentType = 'application/json' } = {},
): DemoCallRequest => ({
  authorization,
  contentType,
  body: async () => body,
})
const ask = (body: unknown, overrides: Record<string, string | undefined> = {}, nowMs = Date.now()) =>
  demoCall(db, request(body), { ...env, ...overrides }, nowMs)

function verifiedClaims(token: string) {
  const [head, claims, signature] = token.split('.')
  const expected = createHmac('sha256', LIVEKIT.LIVEKIT_API_SECRET).update(`${head}.${claims}`).digest('base64url')
  expect(signature).toBe(expected)
  return JSON.parse(Buffer.from(claims!, 'base64url').toString())
}

/** A demo token issued `agoMs` ago, as the command log keeps it. */
async function pastToken(ipHash: string, agoMs: number, room = `demo-${hash().slice(0, 16)}`) {
  await db.insert(commands).values({
    id: `cmd_${hash()}`,
    workspace_id: ws.id,
    actor_id: DEMO_ACTOR,
    action: DEMO_CALL_TOKEN,
    input: { industry: 'auto', ipHash },
    result: { ok: true, rows: {}, data: { room } },
    created_at: new Date(Date.now() - agoMs).toISOString(),
  })
}

async function liveDemoCall(room = `demo-${hash().slice(0, 16)}`) {
  const id = `call_${hash().slice(0, 20)}`
  await db.insert(calls).values({
    id,
    workspace_id: ws.id,
    from_number: randomNumber(),
    to_number: randomNumber(),
    room,
    source: 'test',
    status: 'live',
  })
  return id
}

describe('the happy path', () => {
  test('a token for one new demo room, mic only, dispatching the agent with the demo flag; logged without the token', async () => {
    const ipHash = hash()
    const answer = await ask({ industry: 'auto', ipHash, country: 'US' })
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    const { url, token, room, maxSeconds, business, assistant } = answer.body
    expect({ url, maxSeconds, business, assistant }).toEqual({
      url: 'wss://livekit.example.test',
      maxSeconds: DEMO_CALL_MAX_SECONDS,
      business: 'Ridgeline Auto Care',
      assistant: 'Maya',
    })
    expect(room).toMatch(/^demo-[0-9a-f]{16}$/)
    const claims = verifiedClaims(token)
    expect(claims.exp - claims.nbf).toBe(70) // 60 s, nbf 10 s back for clock skew
    expect(claims.sub).toMatch(/^visitor-/)
    expect(claims.video).toEqual({
      roomJoin: true,
      room,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
    })
    expect(claims.roomConfig.agents).toEqual([
      {
        agentName: 'linedesk',
        metadata: JSON.stringify({
          source: 'test',
          workspaceId: ws.id,
          assistantId: ws.assistant.id,
          simulateTransfer: true,
          demo: true,
        }),
      },
    ])
    const logged = await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      workspace_id: ws.id,
      actor_id: DEMO_ACTOR,
      input: { industry: 'auto', ipHash, country: 'US' },
      result: { ok: true, rows: {}, data: { room, assistantId: ws.assistant.id } },
    })
    expect(JSON.stringify(logged)).not.toContain(token)
  })

  test('over HTTP: JSON with the Bearer secret, no CORS headers, no sign-in needed', async () => {
    Object.assign(process.env, env)
    try {
      const res = await appRequest('/v1/demo/call', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
          origin: 'https://example.com',
        },
        body: JSON.stringify({ industry: 'auto', ipHash: hash() }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect((await res.json()).ok).toBe(true)
      const wrong = await appRequest('/v1/demo/call', {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: '{}',
      })
      expect(wrong.status).toBe(401)
      const again = await appRequest('/v1/demo/call', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ industry: 'auto', ipHash: hash() }),
      })
      expect(again.status).toBe(200)
    } finally {
      for (const key of Object.keys(env)) delete process.env[key]
    }
    // Off again: the route is not there.
    const off = await appRequest('/v1/demo/call', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ industry: 'auto', ipHash: hash() }),
    })
    expect(off.status).toBe(404)
  })
})

describe('the language the visitor picked', () => {
  const agentMetadata = (token: string) => JSON.parse(verifiedClaims(token).roomConfig.agents[0].metadata)
  const loggedInputs = async () =>
    (await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))).map(row => row.input)

  test('missing or "en": the agent is dispatched exactly as before, with no language of its own', async () => {
    const before = {
      source: 'test',
      workspaceId: ws.id,
      assistantId: ws.assistant.id,
      simulateTransfer: true,
      demo: true,
    }
    for (const body of [
      { industry: 'auto', ipHash: hash() },
      { industry: 'auto', ipHash: hash(), language: 'en' },
    ]) {
      const answer = await ask(body)
      expect(answer.status).toBe(200)
      if (answer.status !== 200) return
      // The same JSON, key for key, as a demo call without the field.
      expect(verifiedClaims(answer.body.token).roomConfig.agents[0].metadata).toBe(JSON.stringify(before))
    }
    expect((await loggedInputs()).map(input => (input as { language?: string }).language)).toEqual(['en', 'en'])
  })

  test.each(DEMO_LANGUAGES.filter(code => code !== 'en'))(
    '%s: the call speaks only that language (mainLanguage); logged with the token',
    async code => {
      const ipHash = hash()
      const answer = await ask({ industry: 'auto', ipHash, country: 'DE', language: code })
      expect(answer.status).toBe(200)
      if (answer.status !== 200) return
      expect(agentMetadata(answer.body.token)).toEqual({
        source: 'test',
        workspaceId: ws.id,
        assistantId: ws.assistant.id,
        simulateTransfer: true,
        demo: true,
        mainLanguage: code,
      })
      // The answer has the same shape as an English one.
      expect(Object.keys(answer.body).sort()).toEqual(
        ['assistant', 'business', 'maxSeconds', 'ok', 'room', 'token', 'url'].sort(),
      )
      expect(await loggedInputs()).toEqual([{ industry: 'auto', ipHash, country: 'DE', language: code }])
    },
  )

  test('anything else is 400 language, before the industry, the limits or a token', async () => {
    for (const language of ['xx', 'DE', 'de-DE', 'ko', '', null, 7, ['de'], { code: 'de' }])
      expect(await ask({ industry: 'auto', ipHash: hash(), language })).toEqual({
        status: 400,
        body: { ok: false, error: 'language' },
      })
    // Before the rest of the body and the industry are looked at.
    expect(await ask({ industry: 'vet', language: 'xx' })).toEqual({
      status: 400,
      body: { ok: false, error: 'language' },
    })
    // Still behind the secret: no answer about the body without it.
    expect(
      (await demoCall(db, request({ industry: 'auto', ipHash: hash(), language: 'xx' }, { authorization: '' }), env))
        .status,
    ).toBe(401)
    expect(await loggedInputs()).toEqual([])
  })

  test("a demo assistant whose voice can't speak the language: 503 off with an ALERT line; English still works", async () => {
    const stages = {
      STT_PROVIDER: 'deepgram',
      DEEPGRAM_API_KEY: 'placeholder',
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'placeholder',
      TTS_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'placeholder',
      // An English-only ElevenLabs model.
      TTS_MODEL: 'eleven_flash_v2',
    }
    const kept = Object.fromEntries(Object.keys(stages).map(k => [k, process.env[k]]))
    Object.assign(process.env, stages)
    const [own] = await db
      .select({ pipeline: assistants.voice_pipeline })
      .from(assistants)
      .where(eq(assistants.id, ws.assistant.id))
    await db.update(assistants).set({ voice_pipeline: 'three_stage' }).where(eq(assistants.id, ws.assistant.id))
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ask({ industry: 'auto', ipHash: hash(), language: 'de' })).toEqual({
        status: 503,
        body: { ok: false, error: 'off', retryAfterSec: null },
      })
      expect(alert.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringMatching(
          /^ALERT demo calls: the voice of the demo assistant .* \(auto, eleven_flash_v2\) can't speak German/,
        ),
      ])
      expect((await ask({ industry: 'auto', ipHash: hash() })).status).toBe(200)
      // With a model that speaks it (the default, Flash v2.5), German works.
      process.env.TTS_MODEL = 'eleven_flash_v2_5'
      expect((await ask({ industry: 'auto', ipHash: hash(), language: 'de' })).status).toBe(200)
    } finally {
      alert.mockRestore()
      await db
        .update(assistants)
        .set({ voice_pipeline: own?.pipeline ?? null })
        .where(eq(assistants.id, ws.assistant.id))
      for (const [k, v] of Object.entries(kept)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('off, not authorized, bad requests', () => {
  test('404 unless DEMO_CALLS=on with a secret of at least 32 characters', async () => {
    expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_CALLS: undefined })).status).toBe(404)
    expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_CALLS: 'true' })).status).toBe(404)
    expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_GATEWAY_SECRET: 'short' })).status).toBe(404)
    expect(await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))).toEqual([])
  })

  test('401 without the gateway secret; the comparison is exact', async () => {
    for (const authorization of ['', `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`, 'Bearer '])
      expect((await demoCall(db, request({ industry: 'auto', ipHash: hash() }, { authorization }), env)).status).toBe(
        401,
      )
    expect(isGatewaySecret(`bearer ${SECRET}`, SECRET)).toBe(true)
  })

  test('415 for anything but JSON; 400 for a body that is not the gateway contract', async () => {
    expect(
      (await demoCall(db, request({ industry: 'auto', ipHash: hash() }, { contentType: 'text/plain' }), env)).status,
    ).toBe(415)
    for (const body of [
      null,
      'x',
      {},
      { industry: 'auto' },
      { industry: 'auto', ipHash: 'short' },
      { industry: 'auto', ipHash: hash(), country: 'usa' },
    ])
      expect(await ask(body)).toEqual({ status: 400, body: { ok: false, error: 'input' } })
  })

  test('400 industry for an industry DEMO_ASSISTANTS does not name', async () => {
    expect(await ask({ industry: 'vet', ipHash: hash() })).toEqual({
      status: 400,
      body: { ok: false, error: 'industry' },
    })
  })

  test('503 off, with an ALERT line, when the install is not set up for it', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const off = { status: 503, body: { ok: false, error: 'off', retryAfterSec: null } }
      expect(await ask({ industry: 'auto', ipHash: hash() }, { LIVEKIT_URL: undefined })).toEqual(off)
      expect(await ask({ industry: 'auto', ipHash: hash() }, { DEMO_DAILY_USD: undefined })).toEqual(off)
      expect(await ask({ industry: 'auto', ipHash: hash() }, { DEMO_WORKSPACE_ID: undefined })).toEqual(off)
      expect(await ask({ industry: 'auto', ipHash: hash() }, { DEMO_ASSISTANTS: '' })).toEqual(off)
      expect(await ask({ industry: 'auto', ipHash: hash() }, { DEMO_ASSISTANTS: 'auto=as_gone' })).toEqual(off)
      expect(alert.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringMatching(/^ALERT demo calls: .*LiveKit is not configured/),
        expect.stringMatching(/^ALERT demo calls: .*DEMO_DAILY_USD is not set/),
        expect.stringMatching(/^ALERT demo calls: .*DEMO_WORKSPACE_ID is not set/),
        expect.stringMatching(/^ALERT demo calls: .*DEMO_ASSISTANTS names no assistant/),
        expect.stringMatching(/^ALERT demo calls: DEMO_ASSISTANTS names as_gone for auto, which is no assistant/),
      ])
    } finally {
      alert.mockRestore()
    }
  })

  test('parseDemoAssistants keeps only industry=id entries', () => {
    expect([...parseDemoAssistants(' home-services=as_1, auto = as_2 ,bad,Upper=as_3,x=y=z,law=')]).toEqual([
      ['home-services', 'as_1'],
      ['auto', 'as_2'],
    ])
  })
})

describe('limits', () => {
  test('per visitor: 3 an hour, with when to try again; another visitor is not affected', async () => {
    const ipHash = hash()
    const roomy = { DEMO_MAX_CONCURRENT: '10' }
    for (let i = 0; i < 3; i++) expect((await ask({ industry: 'auto', ipHash }, roomy)).status).toBe(200)
    const fourth = await ask({ industry: 'auto', ipHash }, roomy)
    expect(fourth).toMatchObject({ status: 429, body: { ok: false, error: 'rate' } })
    if (fourth.status === 429) expect(fourth.body.retryAfterSec).toBeGreaterThan(3500)
    expect((await ask({ industry: 'auto', ipHash: hash() }, roomy)).status).toBe(200)
  })

  test('per visitor: 6 a day', async () => {
    const ipHash = hash()
    for (let i = 0; i < 6; i++) await pastToken(ipHash, (2 + i) * 3_600_000)
    const answer = await ask({ industry: 'auto', ipHash })
    expect(answer).toMatchObject({ status: 429, body: { error: 'rate' } })
    // Until the oldest of the day (7 hours ago) is a day old.
    if (answer.status === 429) expect(Math.round(answer.body.retryAfterSec / 3600)).toBe(17)
    // Older than a day: not counted.
    const other = hash()
    for (let i = 0; i < 6; i++) await pastToken(other, 25 * 3_600_000)
    expect((await ask({ industry: 'auto', ipHash: other })).status).toBe(200)
  })

  test('calls at once: live demo calls and tokens of the last minute not joined yet; 503 busy at DEMO_MAX_CONCURRENT', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await liveDemoCall()
      const first = await ask({ industry: 'auto', ipHash: hash() })
      expect(first.status).toBe(200)
      // The agent opened the first token's call: it counts once, as a live call.
      if (first.status === 200) await liveDemoCall(first.body.room)
      expect((await ask({ industry: 'auto', ipHash: hash() })).status).toBe(200)
      expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual({
        status: 503,
        body: { ok: false, error: 'busy', retryAfterSec: 30 },
      })
      expect(alert.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringMatching(/^ALERT demo calls: all 3 demo lines are busy/),
      ])
      // A token over a minute old that never joined no longer holds a line; a higher limit lets one more in.
      expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_MAX_CONCURRENT: '4' })).status).toBe(200)
      await db.delete(calls).where(like(calls.room, 'demo-%'))
      await db.delete(commands).where(eq(commands.action, DEMO_CALL_TOKEN))
      await pastToken(hash(), 61_000)
      await pastToken(hash(), 61_000)
      await pastToken(hash(), 61_000)
      expect((await ask({ industry: 'auto', ipHash: hash() })).status).toBe(200)
    } finally {
      alert.mockRestore()
    }
  })

  test('the daily budget: every token since UTC midnight at the worst case (the sweep backstop plus a summary)', async () => {
    const worst = (await costEstimate(db))({ all: DEMO_BUDGET_SECONDS, phone: 0 }) + DEMO_SUMMARY_USD
    expect(DEMO_BUDGET_SECONDS).toBe(210)
    expect(worst).toBeGreaterThan(DEMO_SUMMARY_USD)
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    const budget = String(worst * 2.5)
    try {
      expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_DAILY_USD: budget })).status).toBe(200)
      expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_DAILY_USD: budget })).status).toBe(200)
      const third = await ask({ industry: 'auto', ipHash: hash() }, { DEMO_DAILY_USD: budget })
      expect(third).toMatchObject({ status: 503, body: { ok: false, error: 'budget' } })
      if (third.status === 503) expect(third.body.retryAfterSec).toBeLessThanOrEqual(86_400)
      expect(String(alert.mock.calls[0]?.[0])).toMatch(
        /^ALERT demo calls: the daily budget of \$[\d.]+ \(DEMO_DAILY_USD\) is reached/,
      )
      // DEMO_DAILY_USD=0: nothing today.
      expect((await ask({ industry: 'auto', ipHash: hash() }, { DEMO_DAILY_USD: '0' })).status).toBe(503)
    } finally {
      alert.mockRestore()
    }
  })

  test('the daily count: DEMO_DAILY_CALLS tokens since UTC midnight, whatever the rates (300 by default)', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    const roomy = { DEMO_MAX_CONCURRENT: '10' }
    try {
      const sinceMidnight = Math.min(1000, Date.now() % 86_400_000)
      await pastToken(hash(), sinceMidnight)
      await pastToken(hash(), sinceMidnight)
      expect((await ask({ industry: 'auto', ipHash: hash() }, { ...roomy, DEMO_DAILY_CALLS: '3' })).status).toBe(200)
      const over = await ask({ industry: 'auto', ipHash: hash() }, { ...roomy, DEMO_DAILY_CALLS: '3' })
      expect(over).toMatchObject({ status: 503, body: { ok: false, error: 'budget' } })
      expect(String(alert.mock.calls[0]?.[0])).toMatch(
        /^ALERT demo calls: the 3 demo calls of today \(DEMO_DAILY_CALLS\)/,
      )
      // Nonsense falls back to the default.
      expect((await ask({ industry: 'auto', ipHash: hash() }, { ...roomy, DEMO_DAILY_CALLS: '-1' })).status).toBe(200)
    } finally {
      alert.mockRestore()
    }
  })

  test('a demo call estimated at $0 is refused: the budget would never stop anything', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const free = async () => () => 0
      expect(await demoCall(db, request({ industry: 'auto', ipHash: hash() }), env, Date.now(), free)).toEqual({
        status: 503,
        body: { ok: false, error: 'off', retryAfterSec: null },
      })
      expect(String(alert.mock.calls[0]?.[0])).toMatch(/^ALERT demo calls: a demo call is estimated at \$0/)
      expect(await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))).toEqual([])
    } finally {
      alert.mockRestore()
    }
  })

  test("the demo workspace's monthly spending cap", async () => {
    await db.update(organization).set({ spendingCapCents: 0 }).where(eq(organization.id, ws.id))
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ask({ industry: 'auto', ipHash: hash() })).toMatchObject({ status: 503, body: { error: 'budget' } })
      expect(String(alert.mock.calls[0]?.[0])).toMatch(/^ALERT demo calls: the demo workspace .* monthly spending cap/)
    } finally {
      alert.mockRestore()
    }
  })

  test('the voice agent: away is busy for a minute, nothing to answer with is off', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      noteAgentSeen(Date.now() - 10 * 60_000)
      expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual({
        status: 503,
        body: { ok: false, error: 'busy', retryAfterSec: 60 },
      })
      noteAgentSeen()
      delete process.env.OPENAI_REALTIME_API_KEY
      try {
        expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual({
          status: 503,
          body: { ok: false, error: 'off', retryAfterSec: null },
        })
      } finally {
        Object.assign(process.env, REALTIME)
      }
      expect(alert.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringMatching(/^ALERT demo calls: the voice agent hasn't checked in lately/),
        expect.stringMatching(/^ALERT demo calls: the voice agent has nothing to answer with/),
      ])
      // Refused tokens are not logged, so they count against no limit.
      expect(await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))).toEqual([])
    } finally {
      alert.mockRestore()
    }
  })

  test('ten requests at once never get past the limit of calls at once', async () => {
    const answers = await Promise.all(Array.from({ length: 10 }, () => ask({ industry: 'auto', ipHash: hash() })))
    expect(answers.filter(a => a.status === 200)).toHaveLength(3)
    expect(answers.filter(a => a.status === 503)).toHaveLength(7)
  })
})

describe('wrong secrets', () => {
  test('an address over the limit of wrong secrets gets 429; the right secret and other addresses are not held back', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrong = (clientBucket: string) =>
      demoCall(
        db,
        { ...request({ industry: 'auto', ipHash: hash() }, { authorization: 'Bearer nope' }), clientBucket },
        env,
      )
    try {
      for (let i = 0; i < WRONG_SECRET_LIMIT; i++) expect((await wrong('203.0.113.7')).status).toBe(401)
      expect(await wrong('203.0.113.7')).toEqual({
        status: 429,
        body: { ok: false, error: 'unauthorized', retryAfterSec: 600 },
      })
      expect(String(alert.mock.calls[0]?.[0])).toMatch(
        /^ALERT demo calls: more than 20 wrong gateway secrets from 203\.0\.113\.7/,
      )
      expect((await wrong('198.51.100.1')).status).toBe(401)
      const right = await demoCall(
        db,
        { ...request({ industry: 'auto', ipHash: hash() }), clientBucket: '203.0.113.7' },
        env,
      )
      expect(right.status).toBe(200)
      // Ten minutes later the address starts over.
      const later = Date.now() + 11 * 60_000
      expect(
        (
          await demoCall(
            db,
            {
              ...request({ industry: 'auto', ipHash: hash() }, { authorization: 'Bearer nope' }),
              clientBucket: '203.0.113.7',
            },
            env,
            later,
          )
        ).status,
      ).toBe(401)
    } finally {
      alert.mockRestore()
    }
  })
})

describe('the demo workspace stays as the setup script left it', () => {
  const off = { status: 503, body: { ok: false, error: 'off', retryAfterSec: null } }

  test('an assistant outside DEMO_WORKSPACE_ID is refused', async () => {
    const other = await createWorkspace('A real customer')
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        await ask({ industry: 'auto', ipHash: hash() }, { DEMO_ASSISTANTS: `auto=${other.assistant.id}` }),
      ).toEqual(off)
      expect(String(alert.mock.calls[0]?.[0])).toMatch(/^ALERT demo calls: .* which is not in DEMO_WORKSPACE_ID/)
      // The other way round: the right assistant, but DEMO_WORKSPACE_ID names another workspace.
      expect(await ask({ industry: 'auto', ipHash: hash() }, { DEMO_WORKSPACE_ID: other.id })).toEqual(off)
    } finally {
      alert.mockRestore()
    }
  })

  test('a demo assistant that records its calls or puts callers through is refused', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    const set = (values: Partial<typeof assistants.$inferInsert>) =>
      db.update(assistants).set(values).where(eq(assistants.id, ws.assistant.id))
    try {
      await set({ record_calls: true })
      expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual(off)
      expect(String(alert.mock.calls.at(-1)?.[0])).toMatch(/records its calls/)
      resetDemoWarnings()
      await set({
        record_calls: false,
        transfers: [
          {
            id: 'p',
            name: 'Owner',
            number: '+15035550100',
            condition: 'Asked',
            hours_only: false,
            ring_seconds: 25,
            if_no_answer: 'message',
            enabled: true,
          },
        ],
      })
      expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual(off)
      expect(String(alert.mock.calls.at(-1)?.[0])).toMatch(/puts callers through/)
      await set({ transfers: [], transfer_number: '+15035550100' })
      expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual(off)
      await set({ transfer_number: null })
      expect((await ask({ industry: 'auto', ipHash: hash() })).status).toBe(200)
    } finally {
      await set({ record_calls: false, transfers: [], transfer_number: null })
      alert.mockRestore()
    }
  })

  test('a phone number, a calendar connection or an active webhook in the demo workspace refuses every demo call', async () => {
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = () => hash().slice(0, 20)
    const cases = [
      {
        what: 'a phone number',
        add: () =>
          db
            .insert(phone_numbers)
            .values({ id: `pn_${id()}`, workspace_id: ws.id, e164: randomNumber(), provider: 'dev' }),
        remove: () => db.delete(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id)),
      },
      {
        what: 'a calendar connection',
        add: () =>
          db.insert(calendar_connections).values({
            id: `cc_${id()}`,
            workspace_id: ws.id,
            provider: 'google',
            account_email: 'demo@example.com',
            connected_by: ws.owner.userId,
          }),
        remove: () => db.delete(calendar_connections).where(eq(calendar_connections.workspace_id, ws.id)),
      },
      {
        // The test workspace's webhook is switched off, so it gets nothing and does not count; switched on, it does.
        what: 'a webhook',
        add: () =>
          db.update(webhook_endpoints).set({ status: 'active' }).where(eq(webhook_endpoints.workspace_id, ws.id)),
        remove: () =>
          db.update(webhook_endpoints).set({ status: 'disabled' }).where(eq(webhook_endpoints.workspace_id, ws.id)),
      },
    ]
    try {
      for (const c of cases) {
        resetDemoWarnings()
        await c.add()
        try {
          expect(await ask({ industry: 'auto', ipHash: hash() })).toEqual(off)
          expect(String(alert.mock.calls.at(-1)?.[0])).toMatch(
            new RegExp(`demo workspace .* has ${c.what}, so demo calls are refused`),
          )
        } finally {
          await c.remove()
        }
      }
      expect((await ask({ industry: 'auto', ipHash: hash() })).status).toBe(200)
      expect(await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))).toHaveLength(1)
    } finally {
      alert.mockRestore()
    }
  })
})

describe('cleanup of demo calls', () => {
  test("a token's visitor hash is removed from the command log after 24 hours; the rest of the row stays", async () => {
    const now = new Date()
    const oldHash = hash()
    const newHash = hash()
    await pastToken(oldHash, 25 * 3_600_000)
    await pastToken(newHash, 23 * 3_600_000)
    expect(await stripOldDemoIpHashes(db, now)).toBe(1)
    const rows = await db.select().from(commands).where(eq(commands.action, DEMO_CALL_TOKEN))
    const inputs = rows.map(r => r.input as Record<string, unknown>)
    expect(inputs).toContainEqual({ industry: 'auto' })
    expect(inputs).toContainEqual({ industry: 'auto', ipHash: newHash })
    expect(JSON.stringify(rows)).not.toContain(oldHash)
    // Run again: nothing left.
    expect(await stripOldDemoIpHashes(db, now)).toBe(0)
  })

  test('DEMO_TRANSCRIPT_DAYS: 7 by default, 0 allowed, nonsense ignored', () => {
    expect(demoTranscriptDays({})).toBe(7)
    expect(demoTranscriptDays({ DEMO_TRANSCRIPT_DAYS: '0' })).toBe(0)
    expect(demoTranscriptDays({ DEMO_TRANSCRIPT_DAYS: '-1' })).toBe(7)
    expect(demoTranscriptDays({ DEMO_TRANSCRIPT_DAYS: 'week' })).toBe(7)
  })

  test('old demo calls lose transcript and summary but keep their length; newer ones, live ones and test calls stay', async () => {
    const now = new Date()
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
    const insert = async (room: string, endedDaysAgo: number | null) => {
      const id = `call_${hash().slice(0, 20)}`
      await db.insert(calls).values({
        id,
        workspace_id: ws.id,
        from_number: randomNumber(),
        to_number: randomNumber(),
        room,
        source: 'test',
        status: endedDaysAgo === null ? 'live' : 'completed',
        started_at: daysAgo(endedDaysAgo ?? 0),
        ended_at: endedDaysAgo === null ? null : daysAgo(endedDaysAgo),
        duration_sec: 95,
        title: 'Brake noise',
        summary: 'Caller said their brakes squeal.',
        action_items: [{ text: 'Call back' }],
      })
      await db.insert(transcript_segments).values({
        id: `seg_${hash().slice(0, 20)}`,
        workspace_id: ws.id,
        call_id: id,
        speaker: 'caller',
        text: 'My brakes squeal.',
        at_ms: 1000,
      })
      await db
        .insert(call_events)
        .values({ id: `ce_${hash().slice(0, 20)}`, workspace_id: ws.id, call_id: id, kind: 'listened' })
      return id
    }
    const old = await insert(`demo-${hash().slice(0, 16)}`, 8)
    const recent = await insert(`demo-${hash().slice(0, 16)}`, 2)
    const live = await insert(`demo-${hash().slice(0, 16)}`, null)
    const testCall = await insert(`test-${hash().slice(0, 16)}`, 30)

    expect(await clearOldDemoCalls(db, 7, now)).toEqual([old])
    const rows = await db
      .select()
      .from(calls)
      .where(inArray(calls.id, [old, recent, live, testCall]))
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId[old]).toMatchObject({ title: null, summary: null, action_items: [], duration_sec: 95 })
    expect(byId[old]!.deleted_at).not.toBeNull()
    for (const kept of [recent, live, testCall])
      expect(byId[kept]).toMatchObject({ title: 'Brake noise', deleted_at: null })
    const lines = await db
      .select()
      .from(transcript_segments)
      .where(inArray(transcript_segments.call_id, [old, recent, live, testCall]))
    expect(lines.map(l => l.call_id).sort()).toEqual([recent, live, testCall].sort())
    expect(await db.select().from(call_events).where(eq(call_events.call_id, old))).toEqual([])
    // Run again: nothing left to clear. With 0 days every finished demo call goes.
    expect(await clearOldDemoCalls(db, 7, now)).toEqual([])
    expect(await clearOldDemoCalls(db, 0, now)).toEqual([recent])
    expect(
      (
        await db
          .select()
          .from(calls)
          .where(and(eq(calls.id, live)))
      )[0]!.title,
    ).toBe('Brake noise')
  })
})
