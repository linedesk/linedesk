import { expect, test, vi } from 'vitest'
import { ActionError, createApiClient } from './api-client.ts'

const client = (response: () => Response) => {
  const fakeFetch = vi.fn<typeof fetch>(async () => response())
  return { api: createApiClient({ baseUrl: 'http://api.test', token: 'agent-token', fetch: fakeFetch }), fakeFetch }
}

test('providerSettings reads the agent endpoint with the agent token', async () => {
  const body = { stt: null, llm: { provider: 'openrouter', api_key: 'sk-or-secret', model: null }, tts: null }
  const { api, fakeFetch } = client(() => Response.json(body))
  expect(await api.providerSettings()).toEqual(body)
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(String(url)).toBe('http://api.test/v1/agent/provider-config')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer agent-token')
})

test('providerSettings errors carry the status and the API error text, never the body', async () => {
  const forbidden = (await client(() =>
    Response.json({ ok: false, error: 'missing permission agent' }, { status: 403 }),
  )
    .api.providerSettings()
    .catch((e: Error) => e)) as Error
  expect(forbidden).toBeInstanceOf(ActionError)
  expect(forbidden.message).toBe('provider-config failed (403): missing permission agent')

  const conflict = (await client(() =>
    Response.json({ ok: false, error: 'stored keys cannot be decrypted: check SECRETS_KEY' }, { status: 409 }),
  )
    .api.providerSettings()
    .catch((e: Error) => e)) as Error
  expect(conflict.message).toBe('provider-config failed (409): stored keys cannot be decrypted: check SECRETS_KEY')

  const notJson = (await client(
    () => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
  )
    .api.providerSettings()
    .catch((e: Error) => e)) as Error
  expect(notJson.message).toBe('provider-config failed (502): Bad Gateway')

  // A 200 whose body is not JSON comes back as null; the config check rejects it without echoing anything.
  expect(await client(() => new Response('not json')).api.providerSettings()).toBeNull()
})

test('run drops U+FFFD from speech text and keeps every other letter, so the API never refuses a call write', async () => {
  const { api, fakeFetch } = client(() => Response.json({ ok: true, rows: [] }))
  const R = String.fromCharCode(0xfffd)
  const def = { name: 'call.note' } as never
  await api.run(def, { text: `Gespr${R}ch über 日本語`, list: [`a${R}`] } as never)
  const [, init] = fakeFetch.mock.calls[0]!
  expect(JSON.parse(String(init!.body))).toEqual({ text: 'Gesprch über 日本語', list: ['a'] })
})
