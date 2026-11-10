// POST /v1/account/password: a first password for a member who has none, only right after signing in.
import { account, session } from '@callfront/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { RECENT_SIGN_IN_MS, SIGN_IN_AGAIN, signedInRecently } from '../src/account.ts'
import { app } from '../src/app.ts'
import { db } from '../src/db.ts'
import { anonymous, type Caller, randomIp, request, signUp, type User } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const PATH = '/v1/account/password'
const NEW_PASSWORD = 'a-first-password-1234'

/** A signed-in member as an email link or SSO leaves them: no password, no workspace. */
async function memberWithoutPassword(): Promise<User> {
  const user = await signUp()
  await db.delete(account).where(and(eq(account.userId, user.userId), eq(account.providerId, 'credential')))
  return user
}

const isSignedIn = async (who: Caller) => Boolean((await request(who, 'GET', '/api/auth/get-session')).body)

async function signIn(email: string, password: string) {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ email, password }),
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return { status: res.status, caller: { headers: { cookie, origin: ORIGIN } } }
}

describe('signedInRecently', () => {
  test('is true inside the window and false from its end on', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(signedInRecently(new Date(now - RECENT_SIGN_IN_MS + 1), now)).toBe(true)
    expect(signedInRecently(new Date(now - RECENT_SIGN_IN_MS), now)).toBe(false)
  })
})

describe('POST /v1/account/password', () => {
  test('sets the password for a member without a workspace and signs their other sessions out', async () => {
    const user = await signUp()
    const { body } = await request(user, 'GET', '/api/auth/get-session')
    const other = await signIn(body.user.email, 'test-password-1234')
    expect(await isSignedIn(other.caller)).toBe(true)
    await db.delete(account).where(and(eq(account.userId, user.userId), eq(account.providerId, 'credential')))

    expect(await request(user, 'POST', PATH, { newPassword: NEW_PASSWORD })).toEqual({ status: 200, body: { ok: true } })

    expect(await isSignedIn(user)).toBe(true)
    expect(await isSignedIn(other.caller)).toBe(false)
    expect((await signIn(body.user.email, NEW_PASSWORD)).status).toBe(200)
  }, 30_000)

  test('needs a session', async () => {
    expect((await request({ headers: { ...anonymous.headers, origin: ORIGIN } }, 'POST', PATH, { newPassword: NEW_PASSWORD })).status).toBe(401)
  })

  test('refuses a request that does not come from the web app', async () => {
    const user = await memberWithoutPassword()
    const { cookie } = user.headers
    expect((await request({ headers: { cookie: cookie! } }, 'POST', PATH, { newPassword: NEW_PASSWORD })).status).toBe(403)
    expect((await request({ headers: { cookie: cookie!, origin: 'https://evil.example' } }, 'POST', PATH, { newPassword: NEW_PASSWORD })).status).toBe(403)
  })

  test('refuses a session that is not fresh from a sign-in', async () => {
    const user = await memberWithoutPassword()
    await db.update(session).set({ createdAt: new Date(Date.now() - RECENT_SIGN_IN_MS - 1000) }).where(eq(session.userId, user.userId))
    const res = await request(user, 'POST', PATH, { newPassword: NEW_PASSWORD })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(SIGN_IN_AGAIN)
    expect(await db.select().from(account).where(eq(account.userId, user.userId))).toEqual([])
  })

  test('refuses when the member already has a password', async () => {
    const user = await signUp()
    expect((await request(user, 'POST', PATH, { newPassword: NEW_PASSWORD })).status).toBe(400)
  })

  test('refuses a missing password and limits attempts per member', async () => {
    const user = await memberWithoutPassword()
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await request(user, 'POST', PATH, {})).status)
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429])
  })
})
