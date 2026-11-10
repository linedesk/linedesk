import { expect, test, vi } from 'vitest'
import type { ProviderConfig } from './provider-settings.ts'
import { testProvider } from './provider-test.ts'

const KEY = 'KEY-made-up-0123456789'
const config = (values: Record<string, string>): ProviderConfig =>
  Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { value, source: 'app' as const }]))
const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const requestOf = (fetchMock: ReturnType<typeof answer>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers) }
}

test.each([
  ['telnyx', 'https://api.telnyx.com/v2/balance', 'authorization', `Bearer ${KEY}`],
  ['openai', 'https://api.openai.com/v1/models', 'authorization', `Bearer ${KEY}`],
  ['openrouter', 'https://openrouter.ai/api/v1/key', 'authorization', `Bearer ${KEY}`],
  ['deepgram', 'https://api.deepgram.com/v1/projects', 'authorization', `Token ${KEY}`],
  ['elevenlabs', 'https://api.elevenlabs.io/v1/user', 'xi-api-key', KEY],
  ['cartesia', 'https://api.cartesia.ai/voices?limit=1', 'x-api-key', KEY],
] as const)('%s: one authenticated request with a timeout', async (provider, url, header, value) => {
  const fetchMock = answer(200)
  expect(await testProvider(provider, config({ api_key: KEY }), fetchMock)).toEqual({ ok: true, message: 'Connected' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const request = requestOf(fetchMock)
  expect(request.url).toBe(url)
  expect(request.headers.get(header)).toBe(value)
  expect(request.init.signal).toBeInstanceOf(AbortSignal)
})

test('twilio: basic auth with the account SID and the auth token; an unknown SID is named', async () => {
  const fetchMock = answer(200)
  const twilio = config({ account_sid: 'ACmadeup0123456789', auth_token: KEY })
  expect((await testProvider('twilio', twilio, fetchMock)).ok).toBe(true)
  const request = requestOf(fetchMock)
  expect(request.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACmadeup0123456789.json')
  expect(request.headers.get('authorization')).toBe(
    `Basic ${Buffer.from(`ACmadeup0123456789:${KEY}`).toString('base64')}`,
  )
  expect(await testProvider('twilio', twilio, answer(404))).toEqual({
    ok: false,
    message: 'Twilio does not know this account SID (HTTP 404)',
  })
})

test('a missing field is reported without a request; optional fields are not needed', async () => {
  const fetchMock = answer(200)
  expect(await testProvider('twilio', config({ account_sid: 'ACmadeup0123456789' }), fetchMock)).toEqual({
    ok: false,
    message: 'Not set: Auth token',
  })
  expect(await testProvider('openai', {}, fetchMock)).toEqual({ ok: false, message: 'Not set: API key' })
  expect(fetchMock).not.toHaveBeenCalled()
  expect((await testProvider('openrouter', config({ api_key: KEY }), fetchMock)).ok).toBe(true)
  expect((await testProvider('telnyx', config({ api_key: KEY }), fetchMock)).ok).toBe(true)
})

test('a rejected key: the provider text, which can echo the key, is not passed on', async () => {
  const fetchMock = answer(401, {
    error: { message: `Incorrect API key provided: ${KEY.slice(0, 8)}***${KEY.slice(-4)}` },
  })
  const result = await testProvider('openai', config({ api_key: KEY }), fetchMock)
  expect(result).toEqual({ ok: false, message: 'OpenAI rejected the key (HTTP 401)' })
})

test('other failures say only the status: provider text can quote what was sent', async () => {
  const echo = { errors: [{ detail: `boom for ${KEY.slice(0, 10)}` }] }
  expect(await testProvider('telnyx', config({ api_key: KEY }), answer(500, echo))).toEqual({
    ok: false,
    message: 'Telnyx answered HTTP 500',
  })
  expect(await testProvider('telnyx', config({ api_key: KEY }), answer(429, echo))).toEqual({
    ok: false,
    message: 'Telnyx is rate limiting (HTTP 429), try again in a minute',
  })

  const thrown = vi.fn(async () => {
    throw new Error(`connect failed with ${KEY}`)
  })
  expect((await testProvider('telnyx', config({ api_key: KEY }), thrown)).message).toBe(
    'Could not reach Telnyx: connect failed with [redacted]',
  )
})

test('an unreachable server is named by its cause', async () => {
  const refused = vi.fn(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }) })
  })
  expect((await testProvider('deepgram', config({ api_key: KEY }), refused)).message).toBe(
    'Could not reach Deepgram: ECONNREFUSED',
  )
})

test('a provider that does not answer in time', async () => {
  const timeout = vi.fn(async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  expect(await testProvider('deepgram', config({ api_key: KEY }), timeout)).toEqual({
    ok: false,
    message: 'Deepgram did not answer within 8 seconds',
  })
})
