// Sign-in hardening that only shows on the running app: limits on auth requests and on workspaces.
import { describe, expect, test } from 'vitest'
import { auth, parseWorkspaceLimit, WORKSPACE_LIMIT } from '../src/auth.ts'
import { asServerAdmin, randomIp, request, signUp, FROM, appRequest } from './helpers.ts'

// Several password hashes or workspaces in one test: slow when the files run in parallel.
const SLOW = 30_000

const ORIGIN = 'http://localhost:5173'

function signIn(ip: string) {
  return appRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: ip },
    body: JSON.stringify({ email: 'nobody@linedesk.test', password: 'wrong-password-1234' }),
  })
}

describe('auth rate limiting', () => {
  test('is on without NODE_ENV=production', () => {
    expect(process.env.NODE_ENV).not.toBe('production')
    expect(auth.options.rateLimit?.enabled).toBe(true)
  })

  test('refuses the fourth sign-in attempt from one address, not from another', async () => {
    const ip = randomIp()
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await signIn(ip)).status)
    expect(statuses).toEqual([401, 401, 401, 429])
    expect((await signIn(randomIp())).status).toBe(401)
  }, SLOW)
})

describe('account linking', () => {
  test('trusts no provider when none is configured', () => {
    expect(auth.options.account?.accountLinking).toEqual({ enabled: true, trustedProviders: [], requireLocalEmailVerified: false })
  })
})

describe('POST /v1/workspaces', () => {
  test('no workspace limit by default: a server admin makes a 6th and more (WORKSPACE_LIMIT unset)', async () => {
    expect(WORKSPACE_LIMIT).toBeNull()
    expect(auth.options.plugins.find(p => p.id === 'organization')?.options?.organizationLimit).toBeUndefined()
    const user = await signUp()
    await asServerAdmin(user, async () => {
      for (let i = 1; i <= 7; i++) {
        expect((await request(user, 'POST', '/v1/workspaces', { name: `Business ${i}` })).status).toBe(200)
      }
    })
  }, SLOW)

  test('refuses a name that is not text or is too long', async () => {
    const user = await signUp()
    await asServerAdmin(user, async () => {
      expect((await request(user, 'POST', '/v1/workspaces', { name: 'x'.repeat(81) })).status).toBe(422)
      expect((await request(user, 'POST', '/v1/workspaces', { name: 42 })).status).toBe(422)
    })
  })
})

describe('WORKSPACE_LIMIT', () => {
  test('unset or empty: no limit; a positive whole number: that limit; anything else stops the start', () => {
    expect(parseWorkspaceLimit(undefined)).toBeNull()
    expect(parseWorkspaceLimit('')).toBeNull()
    expect(parseWorkspaceLimit('  ')).toBeNull()
    expect(parseWorkspaceLimit('2')).toBe(2)
    expect(parseWorkspaceLimit(' 50 ')).toBe(50)
    for (const bad of ['0', '-1', '2.5', 'five', '1e3', 'Infinity', '10000000000'])
      expect(() => parseWorkspaceLimit(bad), bad).toThrow(/WORKSPACE_LIMIT must be a positive whole number/)
  })
})
