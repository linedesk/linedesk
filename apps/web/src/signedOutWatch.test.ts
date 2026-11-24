import { expect, test } from 'vitest'
import { isOwnApi, onUnauthorized, watchUnauthorized } from './signedOutWatch.ts'

const origin = 'https://app.example.com'

test('only requests to the own API under /v1/ count', () => {
  expect(isOwnApi('/v1/admin/agent-setup', origin)).toBe(true)
  expect(isOwnApi(`${origin}/v1/shape/calls?offset=-1`, origin)).toBe(true)
  expect(isOwnApi(new URL('/v1/me', origin), origin)).toBe(true)
  expect(isOwnApi('/api/auth/sign-in/email', origin)).toBe(false)
  expect(isOwnApi('https://openrouter.ai/api/v1/keys', origin)).toBe(false)
  expect(isOwnApi('https://other.example.com/v1/me', origin)).toBe(false)
})

test('a 401 from the own API tells the listeners; other answers pass through unheard', async () => {
  const answers: Record<string, number> = { '/v1/actions/x': 401, '/v1/me': 200, '/api/auth/get-session': 401 }
  const target = {
    location: { origin },
    fetch: (async (input: RequestInfo | URL) =>
      new Response(null, { status: answers[String(input)] ?? 404 })) as typeof fetch,
  }
  watchUnauthorized(target)
  let heard = 0
  const stop = onUnauthorized(() => heard++)
  expect((await target.fetch('/v1/me')).status).toBe(200)
  expect((await target.fetch('/api/auth/get-session')).status).toBe(401)
  expect(heard).toBe(0)
  expect((await target.fetch('/v1/actions/x')).status).toBe(401)
  expect(heard).toBe(1)
  stop()
  await target.fetch('/v1/actions/x')
  expect(heard).toBe(1)
})
