import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
  captureOpenRouterReturn,
  challengeOf,
  clearOpenRouterReturn,
  exchangeCode,
  OPENROUTER_KEYS_URL,
  openRouterErrorText,
  peekOpenRouterReturn,
  startOpenRouterConnect,
} from './openrouterAuth.ts'

/** What the Providers page does: read the answer, then clear it. */
function takeOpenRouterReturn(storage: Storage) {
  const result = peekOpenRouterReturn(storage)
  clearOpenRouterReturn(storage)
  return result
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: i => [...data.keys()][i] ?? null,
    removeItem: key => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('OpenRouter connect (PKCE)', () => {
  test('the challenge is the base64url SHA-256 of the verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await challengeOf(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  test('starts at openrouter.ai/auth with an S256 challenge and comes back to the app', async () => {
    const storage = memoryStorage()
    const go = vi.fn()
    const url = new URL(await startOpenRouterConnect(storage, go, 'http://forms.localhost:5126'))
    expect(go).toHaveBeenCalledWith(url.toString())
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe('http://forms.localhost:5126/')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const pending = JSON.parse(storage.getItem('linedesk.openrouter.pending')!)
    expect(url.searchParams.get('code_challenge')).toBe(await challengeOf(pending.verifier))
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('the return is kept for the Providers page once, and the verifier is cleared', async () => {
    const storage = memoryStorage()
    const url = new URL(await startOpenRouterConnect(storage, () => {}, 'http://x.localhost'))
    const { verifier } = JSON.parse(storage.getItem('linedesk.openrouter.pending')!)
    const state = url.searchParams.get('state')
    expect(captureOpenRouterReturn(`?code=abc&state=${state}`, storage)).toBe('#admin/providers/answering')
    expect(storage.getItem('linedesk.openrouter.pending')).toBeNull()
    expect(takeOpenRouterReturn(storage)).toEqual({ code: 'abc', verifier })
    expect(takeOpenRouterReturn(storage)).toBeNull()
  })

  test('a foreign state or a cancel ends with a short message; nothing pending means nothing to do', async () => {
    const storage = memoryStorage()
    expect(captureOpenRouterReturn('?code=abc&state=x', storage)).toBeNull()
    await startOpenRouterConnect(storage, () => {}, 'http://x.localhost')
    captureOpenRouterReturn('?code=abc&state=forged', storage)
    expect(takeOpenRouterReturn(storage)).toEqual({ error: 'mismatch' })
    expect(openRouterErrorText('mismatch')).toContain("didn't match")
    const url = new URL(await startOpenRouterConnect(storage, () => {}, 'http://x.localhost'))
    captureOpenRouterReturn(`?state=${url.searchParams.get('state')}`, storage)
    expect(takeOpenRouterReturn(storage)).toEqual({ error: 'cancelled' })
    expect(openRouterErrorText('cancelled')).toContain('cancelled')
  })

  test('coming back without an answer (Back, a reload) drops the verifier', async () => {
    const storage = memoryStorage()
    await startOpenRouterConnect(storage, () => {}, 'http://x.localhost')
    expect(captureOpenRouterReturn('', storage)).toBeNull()
    expect(storage.getItem('linedesk.openrouter.pending')).toBeNull()
  })

  test('the code is exchanged with the verifier for a key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 200 }))
    expect(await exchangeCode('the-code', 'the-verifier', fetchMock)).toBe('sk-or-v1-abc')
    expect(fetchMock).toHaveBeenCalledWith(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'the-code', code_verifier: 'the-verifier', code_challenge_method: 'S256' }),
    })
  })

  test('a refused or expired code says so', async () => {
    const refused = vi.fn(async () => new Response('{"error":"invalid"}', { status: 403 }))
    await expect(exchangeCode('c', 'v', refused)).rejects.toThrow(/did not accept/)
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(exchangeCode('c', 'v', offline)).rejects.toThrow(/Couldn't reach OpenRouter/)
    const down = vi.fn(async () => new Response('', { status: 502 }))
    await expect(exchangeCode('c', 'v', down)).rejects.toThrow('OpenRouter answered 502. Try again.')
  })
})
