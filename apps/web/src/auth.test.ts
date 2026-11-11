import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthMethods, redirectErrorMessage } from './auth.ts'

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

describe('redirectErrorMessage', () => {
  it('explains an expired or mismatched sign-in and says to start again, never the code itself', () => {
    const message = redirectErrorMessage('state_mismatch', 'google')
    expect(message).toMatch(/took too long or was started in another browser\. Start again below/)
    expect(message).not.toMatch(/state|mismatch/)
    expect(redirectErrorMessage('state_not_found', null)).toMatch(/Start again below/)
  })

  it('names the provider that did not prove the address', () => {
    expect(redirectErrorMessage('account_not_linked', 'github')).toMatch(/^GitHub didn't confirm/)
  })

  it('shows unknown codes as a plain retry, without the code', () => {
    const message = redirectErrorMessage('some_new_code', null)
    expect(message).toMatch(/Try again/)
    expect(message).not.toMatch(/some|new|code/i)
    expect(redirectErrorMessage('constructor', null)).toMatch(/Try again/) // no prototype lookups
  })
})
