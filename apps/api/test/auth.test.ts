// Sign-in hardening that only shows on the running app: limits on auth requests and on workspaces.
import { describe, expect, test } from 'vitest'
import { auth, WORKSPACE_LIMIT } from '../src/auth.ts'
import { randomIp, request, signUp, FROM, appRequest } from './helpers.ts'

// Several password hashes or workspaces in one test: slow when the files run in parallel.
const SLOW = 30_000

const ORIGIN = 'http://localhost:5173'

function signIn(ip: string) {
  return appRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: ip },
    body: JSON.stringify({ email: 'nobody@callfront.test', password: 'wrong-password-1234' }),
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
    expect(auth.options.account?.accountLinking).toEqual({ enabled: true, trustedProviders: [] })
  })
})

describe('POST /v1/workspaces', () => {
  test('a member can create up to the limit, then is refused', async () => {
    const user = await signUp()
    for (let i = 1; i <= WORKSPACE_LIMIT; i++) {
      expect((await request(user, 'POST', '/v1/workspaces', { name: `Business ${i}` })).status).toBe(200)
    }
    const refused = await request(user, 'POST', '/v1/workspaces', { name: 'One too many' })
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ ok: false, error: `You can create up to ${WORKSPACE_LIMIT} workspaces.` })
  }, SLOW)

  test('refuses a name that is not text or is too long', async () => {
    const user = await signUp()
    expect((await request(user, 'POST', '/v1/workspaces', { name: 'x'.repeat(81) })).status).toBe(422)
    expect((await request(user, 'POST', '/v1/workspaces', { name: 42 })).status).toBe(422)
  })
})
