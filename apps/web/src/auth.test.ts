import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthMethods, isInstanceAdmin, lostSignInState, providerElsewhereMessage, providerSignInElsewhere, redirectErrorMessage } from './auth.ts'

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
    await expect(fetchAuthMethods({ retryMs: [0], attempts: 3 })).rejects.toThrow(/Can't reach the server/)
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

describe('providerSignInElsewhere', () => {
  it('names the address provider sign-ins must start from when this page is open at another one', () => {
    const at = providerSignInElsewhere({ signInOrigin: 'https://abc.ngrok.app' }, 'http://livemode.localhost:8490')
    expect(at).toMatchObject({ origin: 'https://abc.ngrok.app', host: 'abc.ngrok.app' })
    expect(at?.href.startsWith('https://abc.ngrok.app')).toBe(true)
    expect(providerElsewhereMessage('abc.ngrok.app')).toMatch(/^Sign-in with Google, Microsoft or GitHub has to start from abc\.ngrok\.app\./)
  })

  it('says nothing on the right address or when an older API does not tell', () => {
    expect(providerSignInElsewhere({ signInOrigin: 'https://abc.ngrok.app' }, 'https://abc.ngrok.app')).toBeNull()
    expect(providerSignInElsewhere({}, 'http://livemode.localhost:8490')).toBeNull()
  })

  it('counts only a lost sign-in state as the reason, not a cancelled sign-in', () => {
    expect(lostSignInState('state_mismatch')).toBe(true)
    expect(lostSignInState('access_denied')).toBe(false)
    expect(lostSignInState(undefined)).toBe(false)
  })
})

describe('isInstanceAdmin', () => {
  it('the permission, or an instance admin who still has to confirm (Server admin opens on that prompt)', () => {
    expect(isInstanceAdmin({ permissions: ['instance:admin'] })).toBe(true)
    expect(isInstanceAdmin({ permissions: [], adminSecondFactor: 'confirm' })).toBe(true)
    expect(isInstanceAdmin({ permissions: ['settings:write'], adminSecondFactor: null })).toBe(false)
  })
})
