import { afterEach, describe, expect, it, vi } from 'vitest'
import { signedInJustNow } from './passkey-ask.ts'
import {
  lastSignInProvider,
  passkeyRequestClosed,
  providerName,
  readLastUsedMethod,
  rememberSignInMethod,
  signInStart,
  startRedirectSignIn,
  takeRedirectSignIn,
} from './sign-in-methods.ts'

afterEach(() => vi.unstubAllGlobals())

describe('last used sign-in method', () => {
  it('remembers the method on this device', () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
    })
    expect(readLastUsedMethod()).toBeNull()
    rememberSignInMethod('google')
    expect(readLastUsedMethod()).toBe('google')
  })

  it('remembers the name of the provider for the passkey page; a sign-in without one forgets it', () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
      removeItem: (k: string) => memory.delete(k),
    })
    expect(lastSignInProvider()).toBeNull()
    rememberSignInMethod('microsoft', 'Microsoft')
    expect(lastSignInProvider()).toBe('Microsoft')
    rememberSignInMethod('email')
    expect(lastSignInProvider()).toBeNull()
  })

  it("an SSO that kept the default label is remembered as a provider without a name ('')", () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => memory.set(k, v),
      removeItem: (k: string) => memory.delete(k),
    })
    expect(providerName({ label: 'Single sign-on', unnamed: true })).toBe('')
    expect(providerName({ label: 'Okta' })).toBe('Okta')
    rememberSignInMethod('oidc', providerName({ label: 'Single sign-on', unnamed: true }))
    expect(lastSignInProvider()).toBe('')
    rememberSignInMethod('password')
    expect(lastSignInProvider()).toBeNull()
  })

  it('shows no badge and does not fail when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
    expect(() => rememberSignInMethod('email')).not.toThrow()
    expect(readLastUsedMethod()).toBeNull()
    expect(lastSignInProvider()).toBeNull()
  })
})

describe('how the sign-in page starts', () => {
  const on = { passkeyOn: true, supported: true, reauth: false, lastUsed: null }

  it('puts the passkey first, the email code behind "Use an email code instead"', () => {
    expect(signInStart(on)).toEqual({ passkeyFirst: true, emailOpen: false })
    expect(signInStart({ ...on, lastUsed: 'passkey' })).toEqual({ passkeyFirst: true, emailOpen: false })
  })

  it('opens the email form at once on a device that last signed in with email or a password', () => {
    expect(signInStart({ ...on, lastUsed: 'email' })).toEqual({ passkeyFirst: true, emailOpen: true })
    expect(signInStart({ ...on, lastUsed: 'password' })).toEqual({ passkeyFirst: true, emailOpen: true })
    expect(signInStart({ ...on, lastUsed: 'google' })).toEqual({ passkeyFirst: true, emailOpen: false })
  })

  it('shows the email form directly where passkeys cannot be used, and when signing in again', () => {
    expect(signInStart({ ...on, supported: false })).toEqual({ passkeyFirst: false, emailOpen: true })
    expect(signInStart({ ...on, passkeyOn: false })).toEqual({ passkeyFirst: false, emailOpen: true })
    expect(signInStart({ ...on, reauth: true })).toEqual({ passkeyFirst: false, emailOpen: true })
  })
})

describe('a failed passkey request', () => {
  it('is quiet only when closed, timed out, without a passkey here (NotAllowedError) or cancelled by the page', () => {
    expect(passkeyRequestClosed({ code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' })).toBe(true)
    expect(passkeyRequestClosed({ code: 'ERROR_CEREMONY_ABORTED' })).toBe(true)
  })

  it('shows everything else: a wrong site address, an authenticator or unknown error, the server', () => {
    for (const code of [
      'ERROR_INVALID_RP_ID',
      'ERROR_INVALID_DOMAIN',
      'ERROR_AUTHENTICATOR_GENERAL_ERROR',
      ['AUTH', 'CANCELLED'].join('_'),
      'TOO_MANY_REQUESTS',
    ])
      expect(passkeyRequestClosed({ code })).toBe(false)
    expect(passkeyRequestClosed(null)).toBe(false)
    expect(passkeyRequestClosed({ status: 500 })).toBe(false)
  })
})

describe('a provider sign-in that leaves the page', () => {
  function stubStorage() {
    const local = new Map<string, string>()
    const session = new Map<string, string>()
    const storage = (m: Map<string, string>) => ({
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
    })
    vi.stubGlobal('localStorage', storage(local))
    vi.stubGlobal('sessionStorage', storage(session))
  }

  it('counts as a sign-in only when it comes back with a session', () => {
    stubStorage()
    startRedirectSignIn('google')
    expect(readLastUsedMethod()).toBeNull()
    expect(signedInJustNow()).toBe(false)
    takeRedirectSignIn(true)
    expect(readLastUsedMethod()).toBe('google')
    expect(signedInJustNow()).toBe(true)
    expect(lastSignInProvider()).toBeNull()
  })

  it('keeps the name of the provider across the redirect; a bare method id from an older tab still counts', () => {
    stubStorage()
    startRedirectSignIn('github', 'GitHub')
    takeRedirectSignIn(true)
    expect(readLastUsedMethod()).toBe('github')
    expect(lastSignInProvider()).toBe('GitHub')
    sessionStorage.setItem('linedesk.signInRedirect', 'google')
    takeRedirectSignIn(true)
    expect(readLastUsedMethod()).toBe('google')
    expect(lastSignInProvider()).toBeNull()
  })

  it('comes back without a session (refused, cancelled): nothing is remembered, also not later', () => {
    stubStorage()
    startRedirectSignIn('github')
    takeRedirectSignIn(false)
    takeRedirectSignIn(true)
    expect(readLastUsedMethod()).toBeNull()
    expect(signedInJustNow()).toBe(false)
  })
})
