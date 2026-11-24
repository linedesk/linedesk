import { createHmac } from 'node:crypto'
import { APIError } from 'better-auth/api'
import { describe, expect, test, vi } from 'vitest'
import {
  KNOWN_BROWSER_DAYS,
  knownBrowserCookie,
  knownBrowserValues,
  rememberKnownBrowser,
  signKnownBrowser,
  verifyKnownBrowser,
} from './known-browser.ts'

const env = { BETTER_AUTH_SECRET: 'unit-test-secret-unit-test-secret' }
const NOW = Date.UTC(2026, 10, 17, 12)
const DAY = 24 * 60 * 60_000

test('a value signed for an account verifies to that account and its issue time', () => {
  const value = signKnownBrowser('u_123', NOW, env)!
  expect(verifyKnownBrowser(value, NOW, env)).toEqual({ userId: 'u_123', issuedAt: NOW })
  expect(verifyKnownBrowser(value, NOW + (KNOWN_BROWSER_DAYS - 1) * DAY, env)).toEqual({
    userId: 'u_123',
    issuedAt: NOW,
  })
})

test('an expired value, or one issued in the future, is refused', () => {
  const value = signKnownBrowser('u_123', NOW, env)!
  expect(verifyKnownBrowser(value, NOW + KNOWN_BROWSER_DAYS * DAY, env)).toBeNull()
  expect(verifyKnownBrowser(value, NOW - 60 * 60_000, env)).toBeNull()
})

test('nobody can make or change a value without the secret', () => {
  const value = signKnownBrowser('u_123', NOW, env)!
  const [, signature] = value.split('.')
  // Another account, or a later issue time, under the same signature.
  for (const claims of [
    { u: 'u_other', t: NOW },
    { u: 'u_123', t: NOW + DAY },
  ]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    expect(verifyKnownBrowser(`${payload}.${signature}`, NOW, env)).toBeNull()
  }
  // Signed with another secret.
  const foreign = signKnownBrowser('u_123', NOW, { BETTER_AUTH_SECRET: 'another-secret-another-secret-00' })
  expect(verifyKnownBrowser(foreign, NOW, env)).toBeNull()
  // A cut or extended signature, junk, and an over-long value.
  expect(verifyKnownBrowser(value.slice(0, -2), NOW, env)).toBeNull()
  expect(verifyKnownBrowser(`${value}AA`, NOW, env)).toBeNull()
  expect(verifyKnownBrowser(`${value}.x`, NOW, env)).toBeNull()
  for (const junk of ['', 'abc', '.', 'a.b', `${'a'.repeat(600)}.${signature}`])
    expect(verifyKnownBrowser(junk, NOW, env)).toBeNull()
})

test('a signed payload that is not the expected shape is refused', () => {
  // Only reachable with the key; checked anyway so a mistake in signing can not widen what counts.
  const key = createHmac('sha256', env.BETTER_AUTH_SECRET).update('linedesk known browser v1').digest()
  for (const claims of [{ u: '', t: NOW }, { u: 1, t: NOW }, { u: 'u_1', t: 'now' }, {}]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const mac = createHmac('sha256', key).update(`v1.${payload}`).digest('base64url')
    expect(verifyKnownBrowser(`${payload}.${mac}`, NOW, env)).toBeNull()
  }
})

test('without BETTER_AUTH_SECRET no value is made and none counts', () => {
  expect(signKnownBrowser('u_123', NOW, {})).toBeNull()
  expect(verifyKnownBrowser(signKnownBrowser('u_123', NOW, env), NOW, {})).toBeNull()
})

test('the cookie is httpOnly, Lax, 90 days, and __Host- on https', () => {
  expect(knownBrowserCookie(true)).toEqual({
    name: '__Host-known_browser',
    attributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 90 * 24 * 60 * 60 },
  })
  expect(knownBrowserCookie(false).name).toBe('known_browser')
})

test('the values are read from a Cookie header under either name, the first of each name only', () => {
  expect(knownBrowserValues('a=1; known_browser=x.y; __Host-known_browser=z.w; other_known_browser=q')).toEqual([
    'z.w',
    'x.y',
  ])
  const many = Array.from({ length: 100 }, (_, i) => `known_browser=v${i}`).join('; ')
  expect(knownBrowserValues(many)).toEqual(['v0'])
  expect(knownBrowserValues(null)).toEqual([])
  expect(knownBrowserValues('known_browser')).toEqual([])
})

describe('rememberKnownBrowser, after an endpoint', () => {
  const remember = (returned: unknown, newSession: unknown) => {
    const setCookie = vi.fn()
    const ctx = {
      context: { returned, newSession, createAuthCookie: () => ({ attributes: { secure: true } }) },
      setCookie,
    }
    rememberKnownBrowser(ctx as never)
    return setCookie
  }
  const signedIn = { user: { id: 'u_1' }, session: { impersonatedBy: null } }

  test('sets the cookie for a new session: a plain answer, and a provider callback’s redirect (302)', () => {
    for (const returned of [{ token: 't' }, new APIError('FOUND', undefined, { Location: '/' })]) {
      const setCookie = remember(returned, signedIn)
      expect(setCookie).toHaveBeenCalledOnce()
      const [name, value, attributes] = setCookie.mock.calls[0]!
      expect(name).toBe('__Host-known_browser')
      expect(verifyKnownBrowser(value)?.userId).toBe('u_1')
      expect(attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' })
    }
  })

  test('not for an error answer, without a new session, or for an admin signed in as the user', () => {
    expect(remember(new APIError('UNAUTHORIZED'), signedIn)).not.toHaveBeenCalled()
    expect(remember(new APIError('INTERNAL_SERVER_ERROR'), signedIn)).not.toHaveBeenCalled()
    expect(remember({ token: 't' }, null)).not.toHaveBeenCalled()
    expect(
      remember({ token: 't' }, { user: { id: 'u_1' }, session: { impersonatedBy: 'admin_1' } }),
    ).not.toHaveBeenCalled()
  })
})
