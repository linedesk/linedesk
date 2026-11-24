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
    expect(await testProvider('elevenlabs', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: true,
      status: 'ok',
    })
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
      'POST /v1/text-to-speech/': [
        401,
        { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } },
      ],
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

describe('speech to text: AssemblyAI', () => {
  test('the streaming key is checked like the after-call one: a free list of transcripts', async () => {
    const fake = provider({ 'GET /v2/transcript': [200, { transcripts: [] }] })
    expect(await testProvider('assemblyai_stt', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok: true })
    expect(fake.calls).toEqual(['GET https://api.assemblyai.com/v2/transcript?limit=1'])
    expect(fake.requests[0]!.init.headers).toMatchObject({ authorization: KEY })
  })

  test('a rejected key', async () => {
    const fake = provider({ 'GET /v2/transcript': [401, { error: 'Invalid API key' }] })
    expect(await testProvider('assemblyai_stt', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'auth',
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

  test('OpenRouter: a default model it does not serve is named', async () => {
    const fake = provider({
      'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }],
      'POST /chat/completions': [400, { error: { message: 'google/gemini-3.5-flash-lite is not a valid model ID' } }],
    })
    const result = await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)
    expect(result).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: expect.stringMatching(/gemini-3\.5-flash-lite/),
    })
  })

  test('OpenRouter: works, with the credit left; the default live and summary model are each asked, once when they are the same', async () => {
    const fake = provider({ 'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }] })
    expect(await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)).toEqual({
      ok: true,
      status: 'ok',
      message: 'Connected, credit 19.00 USD',
    })
    const models = fake.requests
      .filter(r => r.url.endsWith('/chat/completions'))
      .map(r => JSON.parse(String(r.init.body)).model)
    // The defaults use Gemini 3.5 Flash-Lite for both.
    expect(models).toEqual(['google/gemini-3.5-flash-lite'])
    // Routed as the calls are: only providers that don't train, and zero data retention (on by default).
    const bodies = fake.requests
      .filter(r => r.url.endsWith('/chat/completions'))
      .map(r => JSON.parse(String(r.init.body)))
    expect(bodies[0].provider).toEqual({ data_collection: 'deny', zdr: true })
  })

  test('OpenRouter: a model with no endpoint under the privacy routing fails by name, with the fix', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = {
      error: {
        message:
          'No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy',
        code: 404,
      },
    }
    const fake = provider({
      'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }],
      'POST /chat/completions': [404, refusal],
    })
    const result = await testProvider('openrouter', config({ api_key: KEY }), fake.doFetch)
    expect(result).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: expect.stringContaining(
        'OpenRouter has no endpoint for the model google/gemini-3.5-flash-lite with zero data retention',
      ),
    })
    expect(error).toHaveBeenCalledWith(result.message)
    // Turned off by the instance admin: only providers that train are excluded, and the text says so.
    const off = provider({
      'GET /api/v1/credits': [200, { data: { total_credits: 20, total_usage: 1 } }],
      'POST /chat/completions': [404, refusal],
    })
    const without = await testProvider(
      'openrouter',
      config({ api_key: KEY, zero_data_retention: 'false' }),
      off.doFetch,
    )
    expect(without.message).toContain('the model google/gemini-3.5-flash-lite that does not train on the data')
    const body = JSON.parse(String(off.requests.find(r => r.url.endsWith('/chat/completions'))!.init.body))
    expect(body.provider).toEqual({ data_collection: 'deny' })
    error.mockRestore()
  })

  test('OpenAI: insufficient_quota (HTTP 429) is a used-up quota, not a rate limit', async () => {
    const fake = provider({
      'POST /chat/completions': [
        429,
        { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } },
      ],
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
    expect(result).toMatchObject({
      ok: false,
      reason: 'auth',
      message: expect.stringMatching(/^OpenAI rejected the key \(HTTP 401\)/),
    })
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

  test('Deepgram: an empty balance', async () => {
    const projects = [200, { projects: [{ project_id: 'p1' }] }] as Route
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
    expect(await testProvider('deepgram', config({ api_key: KEY }), fake.doFetch)).toMatchObject({
      ok: true,
      status: 'ok',
    })
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
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(`refused for ${KEY}`), { code: 'ECONNREFUSED' }),
    })
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
  ['calcom', 'https://api.cal.com/v2/auth/oauth2/token', {}],
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
  ['google', { error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401],
  ['github', { error: 'incorrect_client_credentials' }, 200],
  ['github', { error: 'Not Found' }, 404],
  ['calcom', { error: 'invalid_client', error_description: 'client_not_found' }, 401],
  ['calendly', { error: 'invalid_client' }, 401],
] as const)('%s: a wrong client is reported, without the secret', async (name, body, status) => {
  const result = await testProvider(name, config(app), answer(status, body))
  expect(result).toMatchObject({
    ok: false,
    reason: 'auth',
    message: expect.stringMatching(/rejected the client ID or secret$/),
  })
  expect(result.message).not.toContain(app.client_secret)
})

// Answers recorded from HubSpot (2026-11-16, LIN-370): its token endpoint checks the code before the client, so a
// made-up code passed any keys. The check asks for an app token, which HubSpot refuses for a wrong client.
const hubspotAnswer = (status: string, error: string) => ({
  status,
  message: 'missing or invalid',
  correlationId: '01a1e664-1cd8-7939-9bb2-6f3f4551cb02',
  error,
  error_description: 'missing or invalid',
})

test('hubspot: asks for an app token with the client ID and secret, never a made-up code', async () => {
  const fake = provider({ 'POST /': [400, hubspotAnswer('BAD_GRANT_TYPE', 'invalid_request')] })
  await testProvider('hubspot', config(app), fake.doFetch)
  expect(fake.requests[0]!.url).toBe('https://api.hubapi.com/oauth/v3/token')
  const body = new URLSearchParams(String(fake.requests[0]!.init.body))
  expect(Object.fromEntries(body)).toEqual({ grant_type: 'client_credentials', ...app })
})

test.each([
  ['an unknown client ID', 'BAD_CLIENT_ID'],
  ['a wrong client secret', 'BAD_CLIENT_SECRET'],
])('hubspot: %s fails the check', async (_, status) => {
  const result = await testProvider(
    'hubspot',
    config(app),
    answer(400, hubspotAnswer(status, status === 'BAD_CLIENT_ID' ? 'invalid_request' : 'invalid_client')),
  )
  expect(result).toEqual({
    ok: false,
    status: 'error',
    reason: 'auth',
    message: 'HubSpot rejected the client ID or secret',
  })
})

test.each([
  ['a token', 200, { access_token: 'app-token', expires_in: 1800 }],
  ['a refused grant', 400, hubspotAnswer('BAD_GRANT_TYPE', 'invalid_request')],
] as const)('hubspot: a right client passes (%s)', async (_, status, body) => {
  expect(await testProvider('hubspot', config(app), answer(status, body))).toMatchObject({ ok: true, status: 'ok' })
})

test('hubspot: a rate limit or outage is not a pass', async () => {
  expect(await testProvider('hubspot', config(app), answer(429, { status: 'RATE_LIMIT' }))).toMatchObject({ ok: false })
  expect(await testProvider('hubspot', config(app), answer(502, {}))).toMatchObject({ ok: false, reason: 'network' })
})

// Answers recorded from Microsoft (2026-11-16): a made-up code is refused as malformed (AADSTS9002313) before the
// client is checked, so the check asks for an app token for Microsoft Graph.
const aadsts = (error: string, code: number) => ({ error, error_description: `AADSTS${code}: …`, error_codes: [code] })

test.each([
  ['microsoft', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', {}],
  [
    'microsoft',
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    { tenant_id: 'contoso.onmicrosoft.com' },
  ],
] as const)('microsoft: asks for an app token at the tenant', async (name, url, extra) => {
  const fake = provider({ 'POST /': [200, { access_token: 'app-token' }] })
  expect(await testProvider(name, config({ ...app, ...extra }), fake.doFetch)).toMatchObject({ ok: true })
  expect(fake.requests[0]!.url).toBe(url)
  const body = new URLSearchParams(String(fake.requests[0]!.init.body))
  expect(body.get('grant_type')).toBe('client_credentials')
  expect(body.get('scope')).toBe('https://graph.microsoft.com/.default')
  expect(body.get('code')).toBeNull()
})

test.each([
  ['a wrong secret', 401, aadsts('invalid_client', 7000215)],
  ['an unknown client', 400, aadsts('unauthorized_client', 700016)],
] as const)('microsoft: %s fails the check', async (_, status, body) => {
  expect(await testProvider('microsoft', config(app), answer(status, body))).toMatchObject({
    ok: false,
    reason: 'auth',
    message: 'Microsoft rejected the client ID or secret',
  })
})

// Recorded 2026-11-17: through common, organizations and a named tenant Microsoft answers a made-up client ID and
// secret with AADSTS53003 (invalid_grant), exactly as it answers the real app. Only consumers names the unknown app.
const madeUpThroughCommon = {
  error: 'invalid_grant',
  error_description:
    'AADSTS53003: Access has been blocked by Conditional Access policies. The access policy does not allow token issuance. Trace ID: 00000000-0000-0000-0000-000000000000 Correlation ID: 00000000-0000-0000-0000-000000000000 Timestamp: 2026-11-17 10:00:00Z',
  error_codes: [53003],
  timestamp: '2026-11-17 10:00:00Z',
  trace_id: '00000000-0000-0000-0000-000000000000',
  correlation_id: '00000000-0000-0000-0000-000000000000',
  suberror: 'message_only',
}
const madeUpThroughConsumers = {
  error: 'unauthorized_client',
  error_description:
    "AADSTS700016: Application with identifier 'client-id-123' was not found in the directory 'Microsoft Accounts'. Trace ID: 00000000-0000-0000-0000-000000000000",
  error_codes: [700016],
}

test.each([
  ['common', {}],
  ['organizations', { tenant_id: 'organizations' }],
  ['a named tenant', { tenant_id: 'contoso.onmicrosoft.com' }],
] as const)(
  'microsoft: AADSTS53003 through %s cannot tell good keys from bad ones: a pass with a note',
  async (_, extra) => {
    const result = await testProvider('microsoft', config({ ...app, ...extra }), answer(400, madeUpThroughCommon))
    expect(result).toEqual({
      ok: true,
      status: 'ok',
      message:
        'Not checked: Microsoft does not let the keys be tested from here. They are confirmed at the first sign-in or calendar connection.',
    })
  },
)

test('microsoft: an unknown client through consumers (AADSTS700016) still fails the check', async () => {
  const values = { ...app, tenant_id: 'consumers' }
  expect(await testProvider('microsoft', config(values), answer(400, madeUpThroughConsumers))).toMatchObject({
    ok: false,
    reason: 'auth',
    message: 'Microsoft rejected the client ID or secret',
  })
})

test('microsoft: a tenant Microsoft does not know fails the check', async () => {
  const values = { ...app, tenant_id: 'no-such-tenant.onmicrosoft.com' }
  expect(await testProvider('microsoft', config(values), answer(400, aadsts('invalid_request', 90002)))).toMatchObject({
    ok: false,
    reason: 'config',
    message: expect.stringMatching(/no-such-tenant\.onmicrosoft\.com/),
  })
})

test.each([
  ['hubspot', { error: 'invalid_request' }],
  ['microsoft', { error: 'invalid_request' }],
] as const)("%s: a 400 not in the provider's shape is not a pass", async (name, body) => {
  expect(await testProvider(name, config(app), answer(400, body))).toMatchObject({ ok: false, reason: 'unknown' })
})

test('microsoft: a right client that may not get an app token passes', async () => {
  expect(await testProvider('microsoft', config(app), answer(400, aadsts('invalid_scope', 1002012)))).toMatchObject({
    ok: true,
  })
})

test('calendly: the made-up code comes with a PKCE verifier, so Calendly checks the client', async () => {
  const fake = provider({ 'POST /': [400, { error: 'invalid_grant' }] })
  expect(await testProvider('calendly', config(app), fake.doFetch)).toMatchObject({ ok: true })
  expect(fake.requests[0]!.url).toBe('https://auth.calendly.com/oauth/token')
  expect(new URLSearchParams(String(fake.requests[0]!.init.body)).get('code_verifier')).toMatch(/^.{43,128}$/)
})

test('microsoft: an expired client secret is named', async () => {
  const result = await testProvider(
    'microsoft',
    config(app),
    answer(401, {
      error: 'invalid_client',
      error_description: 'AADSTS7000222: The provided client secret keys are expired.',
    }),
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

test('google_places: a free IDs-only Place Details request with the key in a header', async () => {
  const fake = provider({ 'GET /v1/places': [200, { id: 'x' }] })
  expect(await testProvider('google_places', config({ api_key: KEY }), fake.doFetch)).toMatchObject({ ok: true })
  const request = fake.requests[0]!
  expect(request.url).toMatch(/^https:\/\/places\.googleapis\.com\/v1\/places\/[A-Za-z0-9_-]+$/)
  const headers = new Headers(request.init.headers)
  expect(headers.get('x-goog-api-key')).toBe(KEY)
  expect(headers.get('x-goog-fieldmask')).toBe('id')
  expect(await testProvider('google_places', config({ api_key: KEY }), answer(403))).toMatchObject({ ok: false })
})

describe('billing: Stripe', () => {
  /** A made-up Stripe key, put together at run time so the secret scan never sees a key-shaped string in the repo. */
  const fakeStripeKey = (kind: 'sk' | 'rk', mode: 'test' | 'live', body: string) => [kind, mode, body].join('_')
  const TEST_KEY = fakeStripeKey('rk', 'test', '51MadeUpKey0123456789')
  const LIVE_KEY = fakeStripeKey('sk', 'live', '51MadeUpKey0123456789')
  const keys = (secret_key: string) => config({ secret_key, webhook_secret: 'whsec_MadeUp0123' })
  const account = { id: 'acct_1Made', object: 'account', country: 'US', default_currency: 'usd' }

  const missing = [404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }] as const
  const noWrite = [403, { error: { type: 'invalid_request_error', message: 'restricted key lacks write' } }] as const

  test('reads the account once: mode, country and currency, never the key; probes the catalog writes', async () => {
    const fake = provider({
      'GET api.stripe.com/v1/account': [200, account],
      'POST /v1/products/': [...missing],
      'POST /v1/prices/': [...missing],
      'POST /v1/billing_portal/configurations/': [...missing],
    })
    const result = await testProvider('stripe', keys(TEST_KEY), fake.doFetch, {})
    expect(result).toEqual({
      ok: true,
      status: 'ok',
      message: 'Connected, test mode (US, USD), account acct_1Made: nothing is charged',
    })
    // Empty updates of ids no object has: a 404 with the permission, a 403 without. No Checkout is made: the terms are
    // accepted at sign-up, so Checkout needs no Terms of Service URL. Nothing else is written.
    expect(fake.calls).toEqual([
      'GET https://api.stripe.com/v1/account',
      'POST https://api.stripe.com/v1/products/linedesk_permission_probe',
      'POST https://api.stripe.com/v1/prices/price_linedesk_permission_probe',
      'POST https://api.stripe.com/v1/billing_portal/configurations/bpc_linedesk_permission_check',
    ])
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  test('a key that may not write Products or Prices is a warning naming them (review of #1040, M-1)', async () => {
    const fake = provider({
      'GET api.stripe.com/v1/account': [200, account],
      'POST /v1/products/': [...noWrite],
      'POST /v1/prices/': [...missing],
    })
    expect(await testProvider('stripe', keys(TEST_KEY), fake.doFetch, {})).toMatchObject({
      ok: true,
      status: 'warning',
      reason: 'permission',
      message: expect.stringMatching(/account acct_1Made, but the key cannot write Products\. .*"Write" on Products/),
    })
    const neither = provider({
      'GET api.stripe.com/v1/account': [200, account],
      'POST /v1/products/': [...noWrite],
      'POST /v1/prices/': [...noWrite],
    })
    expect((await testProvider('stripe', keys(TEST_KEY), neither.doFetch, {})).message).toMatch(
      /cannot write Products and Prices\./,
    )
  })

  test('with the install’s Stripe Tax on, a tax setup that is not active or has no registration is a warning (LIN-459)', async () => {
    const routes = (settings: unknown, registrations: unknown[]) =>
      provider({
        'GET api.stripe.com/v1/account': [200, account],
        'POST /v1/products/': [...missing],
        'POST /v1/prices/': [...missing],
        'POST /v1/billing_portal/configurations/': [...missing],
        'GET api.stripe.com/v1/tax/settings': [200, settings],
        'GET api.stripe.com/v1/tax/registrations': [200, { object: 'list', has_more: false, data: registrations }],
      })
    const pending = { status: 'pending', status_details: { pending: { missing_fields: ['head_office'] } } }
    const active = { status: 'active', status_details: { active: {} } }
    const noHeadOffice = routes(pending, [])
    expect(
      await testProvider('stripe', keys(TEST_KEY), noHeadOffice.doFetch, {}, { automaticTax: true }),
    ).toMatchObject({
      ok: true,
      status: 'warning',
      reason: 'config',
      message: expect.stringMatching(/Stripe Tax is not set up on the account \(missing: head_office\)/),
    })
    // Read only: the tax settings and registrations are fetched, nothing is written to them.
    expect(noHeadOffice.calls.filter(c => c.includes('/v1/tax/'))).toEqual([
      'GET https://api.stripe.com/v1/tax/settings',
      'GET https://api.stripe.com/v1/tax/registrations?status=active&limit=100',
    ])
    const unregistered = routes(active, [])
    expect(
      (await testProvider('stripe', keys(TEST_KEY), unregistered.doFetch, {}, { automaticTax: true })).message,
    ).toMatch(/Stripe Tax has no active tax registration/)
    const ready = routes(active, [{ id: 'taxreg_1', object: 'tax.registration', country: 'DE' }])
    expect(await testProvider('stripe', keys(TEST_KEY), ready.doFetch, {}, { automaticTax: true })).toMatchObject({
      status: 'ok',
    })
    // Stripe Tax off on the install: the account's tax setup is not asked about.
    const off = routes(pending, [])
    expect(await testProvider('stripe', keys(TEST_KEY), off.doFetch, {})).toMatchObject({ status: 'ok' })
    expect(off.calls.some(c => c.includes('/v1/tax/'))).toBe(false)
  })

  test('a key that may not write the customer portal is a warning (billing tour G1)', async () => {
    const fake = provider({
      'GET api.stripe.com/v1/account': [200, account],
      'POST /v1/products/': [...missing],
      'POST /v1/prices/': [...missing],
      'POST /v1/billing_portal/configurations/': [...noWrite],
    })
    expect(await testProvider('stripe', keys(TEST_KEY), fake.doFetch, {})).toMatchObject({
      ok: true,
      status: 'warning',
      reason: 'permission',
      message: expect.stringMatching(/cannot write the customer portal configuration/),
    })
  })

  test('a live key says real cards are charged', async () => {
    const fake = provider({ 'GET api.stripe.com/v1/account': [200, account] })
    const result = await testProvider('stripe', keys(LIVE_KEY), fake.doFetch, { BILLING_LIVE_KEYS: '1' })
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/live mode .*real cards are charged$/) })
  })

  test('a live key is refused without asking Stripe unless the server allows it, and always in dev mode', async () => {
    const fake = provider({ 'GET api.stripe.com/v1/account': [200, account] })
    for (const env of [{}, { BILLING_LIVE_KEYS: 'yes' }, { BILLING_LIVE_KEYS: '1', LINEDESK_MODE: 'dev' }]) {
      const result = await testProvider('stripe', keys(LIVE_KEY), fake.doFetch, env)
      expect(result, JSON.stringify(env)).toMatchObject({
        ok: false,
        reason: 'config',
        message: expect.stringMatching(/Live Stripe keys are refused on this install/),
      })
    }
    expect(fake.calls).toEqual([])
    // A test key is fine everywhere.
    expect((await testProvider('stripe', keys(TEST_KEY), fake.doFetch, { LINEDESK_MODE: 'dev' })).ok).toBe(true)
  })

  test.each([
    [401, 'auth', /rejected the secret key/],
    [403, 'permission', /may not read the account/],
    [500, 'network', /Stripe answered HTTP 500/],
  ])('HTTP %i is %s, with Stripe’s own text left out', async (status, reason, message) => {
    const fake = provider({
      'GET api.stripe.com/v1/account': [status, { error: { message: `Invalid API Key provided: ${TEST_KEY}` } }],
    })
    const result = await testProvider('stripe', keys(TEST_KEY), fake.doFetch, {})
    expect(result).toMatchObject({ ok: false, status: 'error', reason, message: expect.stringMatching(message) })
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  test('not a secret key: refused before any request', async () => {
    const fake = provider({})
    const result = await testProvider('stripe', keys('pk_test_abc'), fake.doFetch, {})
    expect(result).toMatchObject({ ok: false, reason: 'config' })
    expect(fake.calls).toEqual([])
  })
})

describe('apps: Slack', () => {
  const ID = '1234567890.1234567890'
  const SECRET = '0123456789abcdef0123456789abcdef'

  test('a client ID or secret in the wrong form is refused before any request', async () => {
    const fake = provider({})
    expect(
      await testProvider('slack', config({ client_id: 'abc', client_secret: SECRET }), fake.doFetch),
    ).toMatchObject({
      ok: false,
      reason: 'auth',
    })
    expect(await testProvider('slack', config({ client_id: ID, client_secret: 'short' }), fake.doFetch)).toMatchObject({
      ok: false,
      reason: 'auth',
    })
    expect(fake.calls).toEqual([])
  })

  test.each([
    ['invalid_client_id', /does not know this client ID/],
    ['bad_client_secret', /rejected the client secret/],
  ])('Slack refusing the app (%s) is an error', async (code, message) => {
    const fake = provider({ 'POST oauth.v2.exchange': [200, { ok: false, error: code }] })
    const result = await testProvider('slack', config({ client_id: ID, client_secret: SECRET }), fake.doFetch)
    expect(result).toMatchObject({ ok: false, status: 'error', reason: 'auth' })
    expect(result.message).toMatch(message)
  })

  test('a known client ID passes with a warning: Slack checks the secret only when a business connects', async () => {
    const fake = provider({ 'POST oauth.v2.exchange': [200, { ok: false, error: 'token_rotation_not_enabled' }] })
    const result = await testProvider('slack', config({ client_id: ID, client_secret: SECRET }), fake.doFetch)
    expect(result).toMatchObject({ status: 'warning' })
    expect(result.message).toMatch(/only when a business connects/)
    expect(fake.calls).toEqual(['POST https://slack.com/api/oauth.v2.exchange'])
  })
})

describe('apps: Jobber', () => {
  const keys = config({ client_id: 'jobber-client', client_secret: 'jobber-secret' })
  const text = (status: number, body: string) => () =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } })

  test('a client ID or secret Jobber does not know fails (its answer to any client it does not know)', async () => {
    const fake = provider({
      'POST /api/oauth/token': text(401, 'The provided client id and secret do not match an existing application'),
    })
    const result = await testProvider('jobber', keys, fake.doFetch)
    expect(result).toMatchObject({ ok: false, status: 'error', reason: 'auth' })
    expect(result.message).toBe('Jobber rejected the client ID or secret')
    expect(fake.calls).toEqual(['POST https://api.getjobber.com/api/oauth/token'])
    const sent = new URLSearchParams(String(fake.requests[0]!.init.body))
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('client_id')).toBe('jobber-client')
  })

  test('a known client passes: Jobber refused only the made-up refresh token', async () => {
    const fake = provider({ 'POST /api/oauth/token': text(401, 'The provided refresh token is not valid.') })
    expect(await testProvider('jobber', keys, fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
  })

  test('an answer that proves nothing is a warning, Jobber down is an error', async () => {
    const odd = provider({ 'POST /api/oauth/token': text(403, '<html>blocked</html>') })
    expect(await testProvider('jobber', keys, odd.doFetch)).toMatchObject({ ok: true, status: 'warning' })
    const down = provider({ 'POST /api/oauth/token': text(503, 'unavailable') })
    expect(await testProvider('jobber', keys, down.doFetch)).toMatchObject({ ok: false, reason: 'network' })
  })
})

describe('apps: Zoho CRM', () => {
  const keys = config({ client_id: '1000.ZOHOCLIENT', client_secret: 'zoho-secret' })

  test.each([['invalid_client'], ['invalid_client_secret']])(
    'Zoho refusing the client (%s, with HTTP 200) fails',
    async code => {
      const fake = provider({ 'POST /oauth/v2/token': [200, { error: code }] })
      const result = await testProvider('zoho', keys, fake.doFetch)
      expect(result).toMatchObject({ ok: false, status: 'error', reason: 'auth' })
      expect(result.message).toBe('Zoho CRM rejected the client ID or secret')
      expect(fake.calls).toEqual(['POST https://accounts.zoho.com/oauth/v2/token'])
      const sent = new URLSearchParams(String(fake.requests[0]!.init.body))
      expect(sent.get('grant_type')).toBe('refresh_token')
      expect(sent.get('client_id')).toBe('1000.ZOHOCLIENT')
    },
  )

  test('a known client passes: Zoho refused only the made-up refresh token', async () => {
    const fake = provider({ 'POST /oauth/v2/token': [200, { error: 'invalid_code' }] })
    expect(await testProvider('zoho', keys, fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
  })

  test('an answer that proves nothing is a warning, Zoho down is an error', async () => {
    const odd = provider({ 'POST /oauth/v2/token': [400, { error: 'invalid_request' }] })
    expect(await testProvider('zoho', keys, odd.doFetch)).toMatchObject({ ok: true, status: 'warning' })
    const down = provider({ 'POST /oauth/v2/token': [503, {}] })
    expect(await testProvider('zoho', keys, down.doFetch)).toMatchObject({ ok: false, reason: 'network' })
  })
})

describe('email: Resend over its HTTPS API', () => {
  const values = { api_key: KEY, from: 'Desk <desk@example.com>' }

  test('checks the key with GET /domains, sends nothing and never touches SMTP', async () => {
    const fake = provider({
      'GET api.resend.com/domains': [200, { data: [{ name: 'example.com', status: 'verified' }] }],
    })
    expect(await testProvider('resend', config(values), fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
    expect(fake.calls).toEqual(['GET https://api.resend.com/domains'])
    expect((fake.requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })

  test('a sending-only key cannot list domains: it works, From is not checked', async () => {
    const fake = provider({ 'GET api.resend.com/domains': [401, { name: 'restricted_api_key' }] })
    expect(await testProvider('resend', config(values), fake.doFetch)).toMatchObject({ ok: true, status: 'ok' })
  })

  test('a refused key, an unverified From domain and no answer each say what to fix', async () => {
    const refused = provider({ 'GET api.resend.com/domains': [403, { name: 'invalid_api_key' }] })
    const keyResult = await testProvider('resend', config(values), refused.doFetch)
    expect(keyResult).toMatchObject({ ok: false, reason: 'auth' })
    expect(keyResult.message).toMatch(/Resend refused the API key \(HTTP 403\)/)
    expect(keyResult.message).not.toContain(KEY)

    const pending = provider({
      'GET api.resend.com/domains': [200, { data: [{ name: 'example.com', status: 'pending' }] }],
    })
    expect(await testProvider('resend', config(values), pending.doFetch)).toMatchObject({
      ok: false,
      reason: 'config',
      message: expect.stringMatching(/example\.com is not verified in Resend yet \(pending\)/),
    })
    const other = provider({
      'GET api.resend.com/domains': [200, { data: [{ name: 'other.com', status: 'verified' }] }],
    })
    expect(await testProvider('resend', config(values), other.doFetch)).toMatchObject({ ok: false, reason: 'config' })

    const blocked = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
    }) as unknown as typeof fetch
    expect(await testProvider('resend', config(values), blocked)).toMatchObject({
      ok: false,
      reason: 'network',
      message: expect.stringMatching(/no answer from api\.resend\.com \(ETIMEDOUT\).*port 443/),
    })
  })
})
