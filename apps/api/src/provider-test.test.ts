import { describe, expect, test, vi } from 'vitest'
import type { ProviderConfig } from './provider-settings.ts'
import { fromDomain, s3Problem, silentWav, testProvider } from './provider-test.ts'
import { S3RequestError } from './recording-store.ts'

const KEY = 'KEY-made-up-0123456789'
const config = (values: Record<string, string>): ProviderConfig =>
  Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { value, source: 'app' as const }]))
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
const answer = (status: number, body: unknown = {}) => vi.fn(async () => json(status, body))

type Route = [status: number, body?: unknown] | (() => Response)
/**
 * A fake provider: the first route whose "METHOD url-part" matches answers; anything else is 200 with `{}`.
 * `calls` lists what was asked, as "METHOD url".
 */
function provider(routes: Record<string, Route>) {
  const calls: string[] = []
  const requests: { url: string; init: RequestInit }[] = []
  const doFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    calls.push(`${method} ${url}`)
    requests.push({ url, init })
    for (const [pattern, route] of Object.entries(routes)) {
      const [m, part] = pattern.split(' ') as [string, string]
      if (m === method && url.includes(part)) return typeof route === 'function' ? route() : json(route[0], route[1])
    }
    return json(200, {})
  })
  return { doFetch: doFetch as unknown as typeof fetch, calls, requests }
}

describe('voice: ElevenLabs', () => {
  test('a used-up quota is an error, though the key itself is valid (the silent test call)', async () => {
    const fake = provider({
      'GET /v1/user/subscription': [200, { character_count: 10_000, character_limit: 10_000, status: 'active' }],
    })
    const result = await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, status: 'error', reason: 'quota' })
    expect(result.message).toMatch(/ElevenLabs quota used up \(10,000 of 10,000 credits\).*Upgrade the plan/)
  })

  test('a plan that may go over its quota (usage-based billing) is not failing', async () => {
    const fake = provider({
      'GET /v1/user/subscription': [
        200,
        {
          character_count: 10_000,
          character_limit: 10_000,
          can_extend_character_limit: true,
          allowed_to_extend_character_limit: true,
        },
      ],
    })
    expect(await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
  })

  test('little quota left: works, with a warning', async () => {
    const fake = provider({ 'GET /v1/user/subscription': [200, { character_count: 9_800, character_limit: 10_000 }] })
    expect(await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: true,
      status: 'warning',
      reason: 'quota',
      message: expect.stringMatching(/200 credits left/),
    })
  })

  test('a key that may not read the quota: one character of speech decides', async () => {
    const fake = provider({
      'GET /v1/user/subscription': [401, { detail: { status: 'missing_permissions', message: 'user_read' } }],
      'POST /v1/text-to-speech/': [401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } }],
    })
    const result = await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, reason: 'quota' })
    expect(fake.calls.some(c => c.startsWith('POST https://api.elevenlabs.io/v1/text-to-speech/'))).toBe(true)
  })

  test('a speech test that gives no audio is a failure', async () => {
    const fake = provider({
      'GET /v1/user/subscription': [403, { detail: { status: 'missing_permissions' } }],
      'POST /v1/text-to-speech/': () => new Response(new Uint8Array(0), { status: 200 }),
    })
    expect(await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok: false })
  })

  test('a default voice the account does not have is named', async () => {
    const fake = provider({
      'GET /v1/user/subscription': [200, { character_count: 1, character_limit: 10_000 }],
      'GET /v1/voices/': [404, { detail: { status: 'voice_not_found' } }],
    })
    const result = await testProvider('elevenlabs', config({ api_key: KEY, voice_id: 'gone-voice' }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, reason: 'not_found', message: expect.stringMatching(/gone-voice/) })
  })

  test('a rejected key', async () => {
    const fake = provider({ 'GET /v1/user/subscription': [401, { detail: { status: 'invalid_api_key' } }] })
    expect(await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'auth',
    })
  })

  test('speech to text reads the same quota', async () => {
    const fake = provider({ 'GET /v1/user/subscription': [200, { character_count: 5, character_limit: 5 }] })
    expect(await testProvider('elevenlabs_stt', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'quota',
    })
  })
})

describe('voice: Cartesia', () => {
  test('out of credit shows on one character of speech (402)', async () => {
    const fake = provider({ 'POST /tts/bytes': [402, { error: 'payment required' }] })
    expect(await testProvider('cartesia', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'quota',
    })
    expect(fake.requests[0]!.url).toMatch(/^https:\/\/api\.cartesia\.ai\/voices\//)
  })
})

describe('language models', () => {
  test('OpenRouter: credits used up', async () => {
    const fake = provider({
      'GET /api/v1/key': [200, { data: { limit_remaining: null } }],
      'GET /api/v1/credits': [200, { data: { total_credits: 10, total_usage: 10.02 } }],
    })
    expect(await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'quota',
      message: expect.stringMatching(/credits are used up/),
    })
  })

  test("OpenRouter: the key's own limit reached", async () => {
    const fake = provider({ 'GET /api/v1/key': [200, { data: { limit_remaining: 0 } }] })
    expect(await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ reason: 'quota' })
  })

  test('OpenRouter: a model that does not exist is named', async () => {
    const fake = provider({
      'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }],
      'POST /chat/completions': [400, { error: { message: 'made/up is not a valid model ID' } }],
    })
    const result = await testProvider('openrouter', config({ api_key: KEY, model: 'made/up' }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, reason: 'not_found', message: expect.stringMatching(/made\/up/) })
  })

  test('OpenRouter: works, with the credit left; the live and the summary model are each asked', async () => {
    const fake = provider({ 'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }] })
    expect(await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)).toEqual({
      ok: true,
      status: 'ok',
      message: 'Connected, credit 19.00 USD',
    })
    const models = fake.requests
      .filter(r => r.url.endsWith('/chat/completions'))
      .map(r => JSON.parse(String(r.init.body)).model)
    expect(models).toEqual(['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'])
  })

  test('OpenAI: insufficient_quota (HTTP 429) is a used-up quota, not a rate limit', async () => {
    const fake = provider({
      'POST /chat/completions': [429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }],
    })
    expect(await testProvider('openai', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'quota',
    })
    expect(JSON.parse(String(fake.requests[0]!.init.body))).toMatchObject({ max_completion_tokens: 16 })
  })

  test('a plain rate limit is not a quota', async () => {
    const fake = provider({ 'POST /chat/completions': [429, { error: { code: 'rate_limit_exceeded' } }] })
    expect(await testProvider('groq', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      reason: 'network',
      message: expect.stringMatching(/rate limiting/),
    })
  })

  test('a rejected key: the provider text, which can echo the key, is not passed on', async () => {
    const fake = provider({
      'POST /chat/completions': [401, { error: { message: `Incorrect API key provided: ${KEY}` } }],
    })
    const result = await testProvider('openai', config({ api_key: KEY }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, reason: 'auth', message: expect.stringMatching(/^OpenAI rejected the key \(HTTP 401\)/) })
    expect(result.message).not.toContain(KEY)
  })

  test('OpenAI Realtime: the realtime model must exist', async () => {
    const fake = provider({ 'GET /v1/models/gpt-realtime': [404, { error: { code: 'model_not_found' } }] })
    expect(await testProvider('openai_realtime', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })
})

describe('speech to text', () => {
  test('OpenAI transcription: a fraction of a second of audio checks key, model and quota', async () => {
    const fake = provider({ 'POST /v1/audio/transcriptions': [429, { error: { code: 'insufficient_quota' } }] })
    expect(await testProvider('openai_stt', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ reason: 'quota' })
    expect(fake.requests[0]!.init.body).toBeInstanceOf(FormData)
    expect(silentWav().byteLength).toBe(44 + 3200 * 2)
  })

  test('Deepgram: an unknown model and an empty balance', async () => {
    const projects = [200, { projects: [{ project_id: 'p1' }] }] as Route
    const models = [200, { stt: [{ canonical_name: 'nova-3', name: 'nova-3' }] }] as Route
    const unknown = provider({ 'GET /v1/projects': projects, 'GET /v1/models': models })
    expect(await testProvider('deepgram', config({ api_key: KEY, model: 'nova-9' }), unknown.doFetch)).toMatchObject({
      reason: 'not_found',
    })
    const empty = provider({
      'GET /v1/projects/p1/balances': [200, { balances: [{ amount: 0 }] }],
      'GET /v1/projects': projects,
    })
    expect(await testProvider('deepgram', config({ api_key: KEY }), empty.doFetch)).toMatchObject({
      ok: true,
      status: 'warning',
      reason: 'quota',
    })
    expect(empty.requests[0]!.init.headers).toMatchObject({ authorization: `Token ${KEY}` })
  })

  test('Deepgram: a key that may not read balances still passes', async () => {
    const fake = provider({
      'GET /v1/projects/p1/balances': [403, {}],
      'GET /v1/projects': [200, { projects: [{ project_id: 'p1' }] }],
    })
    expect(await testProvider('deepgram', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
  })
})

describe('telephony', () => {
  test.each([
    ['0.00', false, 'error'],
    ['2.50', true, 'warning'],
    ['120.00', true, 'ok'],
  ] as const)('Telnyx balance %s', async (credit, ok, status) => {
    const fake = provider({ 'GET /v2/balance': [200, { data: { available_credit: credit, currency: 'USD' } }] })
    expect(await testProvider('telnyx', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok, status })
    expect(fake.requests[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` })
    expect(fake.requests[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('Twilio: basic auth; a suspended account, a trial account and an unknown SID', async () => {
    const twilio = config({ account_sid: 'ACmadeup0123456789', auth_token: KEY })
    const suspended = provider({ 'GET /Accounts/ACmadeup0123456789.json': [200, { status: 'suspended' }] })
    expect(await testProvider('twilio', twilio, suspended.doFetch)).toMatchObject({ ok: false, reason: 'quota' })
    expect(suspended.requests[0]!.init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(`ACmadeup0123456789:${KEY}`).toString('base64')}`,
    })
    const trial = provider({
      'GET /Accounts/ACmadeup0123456789.json': [200, { status: 'active', type: 'Trial' }],
      'GET /Balance.json': [200, { balance: '14.50', currency: 'usd' }],
    })
    expect(await testProvider('twilio', twilio, trial.doFetch)).toMatchObject({ ok: true, status: 'warning' })
    expect(await testProvider('twilio', twilio, answer(404))).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

test('a missing field is reported without a request; optional fields are not needed', async () => {
  const fetchMock = answer(200)
  expect(await testProvider('twilio', config({ account_sid: 'ACmadeup0123456789' }), fetchMock)).toMatchObject({
    ok: false,
    reason: 'config',
    message: 'Not set: Auth token',
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test('a server that cannot be reached is named by its cause, without the key', async () => {
  const thrown = vi.fn(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`refused for ${KEY}`), { code: 'ECONNREFUSED' }) })
  })
  const result = await testProvider('telnyx', config({ api_key: KEY }), thrown)
  expect(result).toMatchObject({ ok: false, reason: 'network' })
  expect(result.message).toMatch(/Could not reach Telnyx/)
  expect(result.message).not.toContain(KEY)
})

test('a provider that does not answer in time', async () => {
  const timeout = vi.fn(async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  expect(await testProvider('deepgram', config({ api_key: KEY }), timeout)).toMatchObject({
    ok: false,
    reason: 'timeout',
    message: 'Deepgram did not answer within 8 seconds',
  })
})

test('S3 failures name what to fix', () => {
  expect(s3Problem(new S3RequestError('write', 403, 'AccessDenied'))).toMatchObject({ reason: 'permission' })
  expect(s3Problem(new S3RequestError('write', 404, 'NoSuchBucket'))).toMatchObject({ reason: 'not_found' })
  expect(s3Problem(new S3RequestError('write', 403, 'SignatureDoesNotMatch'))).toMatchObject({ reason: 'auth' })
  expect(s3Problem(new S3RequestError('write', 503, null))).toMatchObject({ reason: 'network' })
})

test('the domain of a From line', () => {
  expect(fromDomain('Desk <desk@Example.com>')).toBe('example.com')
  expect(fromDomain('desk@example.com')).toBe('example.com')
  expect(fromDomain(undefined)).toBeNull()
})

const app = { client_id: 'client-id-123', client_secret: 'client-secret-made-up-123456' }

test.each([
  ['google', 'https://oauth2.googleapis.com/token', {}],
  ['github', 'https://github.com/login/oauth/access_token', {}],
  ['microsoft', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', {}],
  ['microsoft', 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token', { tenant_id: 'contoso.onmicrosoft.com' }],
] as const)('%s: a made-up code the provider rejects means the app is right', async (name, url, extra) => {
  const fake = provider({ 'POST /': [400, { error: name === 'github' ? 'bad_verification_code' : 'invalid_grant' }] })
  expect(await testProvider(name, config({ ...app, ...extra }), fake.doFetch)).toEqual({
    ok: true,
    status: 'ok',
    message: 'Connected',
  })
  expect(fake.requests[0]!.url).toBe(url)
  expect(String(fake.requests[0]!.init.body)).toContain('client_id=client-id-123')
})

test.each([
  ['google', { error: 'invalid_client' }, 401],
  ['github', { error: 'incorrect_client_credentials' }, 200],
] as const)('%s: a wrong client is reported, without the secret', async (name, body, status) => {
  const result = await testProvider(name, config(app), answer(status, body))
  expect(result).toMatchObject({ ok: false, reason: 'auth', message: expect.stringMatching(/rejected the client ID or secret/) })
  expect(result.message).not.toContain(app.client_secret)
})

test('microsoft: an expired client secret is named', async () => {
  const result = await testProvider(
    'microsoft',
    config(app),
    answer(401, { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' }),
  )
  expect(result).toMatchObject({ ok: false, reason: 'auth', message: expect.stringMatching(/expired/) })
})

test('oidc: the token endpoint comes from the discovery document', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ token_endpoint: 'https://id.example.com/token' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
  const values = { ...app, discovery_url: 'https://id.example.com/.well-known/openid-configuration' }
  expect(await testProvider('oidc', config(values), fetchMock)).toMatchObject({ ok: true })
  expect(fetchMock.mock.calls[1]![0]).toBe('https://id.example.com/token')
})

test('oidc: a discovery URL that answers no JSON gets a fixed message, not the body', async () => {
  const values = { ...app, discovery_url: 'https://intranet.example.com/' }
  const html = vi.fn(async () => new Response('<html>internal admin panel secret-banner</html>', { status: 200 }))
  const result = await testProvider('oidc', config(values), html)
  expect(result.ok).toBe(false)
  expect(result.message).not.toContain('secret-banner')
  expect(result.message).toMatch(/did not answer with JSON/)
})
