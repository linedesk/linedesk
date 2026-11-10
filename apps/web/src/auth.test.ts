import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthMethods } from './auth.ts'

const methods = { password: true, emailCode: false, sso: [] }
const ok = () => new Response(JSON.stringify(methods), { status: 200 })
const down = () => Promise.reject(new TypeError('fetch failed'))

afterEach(() => vi.unstubAllGlobals())

describe('fetchAuthMethods', () => {
  it('keeps trying until the API answers', async () => {
    const fetch = vi.fn().mockImplementationOnce(down).mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetch)
    expect(await fetchAuthMethods({ retryMs: [0] })).toEqual(methods)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after the given number of attempts', async () => {
    const fetch = vi.fn().mockImplementation(down)
    vi.stubGlobal('fetch', fetch)
    await expect(fetchAuthMethods({ retryMs: [0], attempts: 3 })).rejects.toThrow(/Could not reach the server/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
