// Closed sign-up (AUTH_SIGNUP_ENABLED=false). Accounts made by an instance admin (user.invite) are
// tested in admin.test.ts, which is the only file that creates instance admins.
import { invitation, user } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { readAuthConfig } from '../src/auth-methods.ts'
import { db } from '../src/db.ts'
import { maySendSignInLink, refuseClosedSignUp } from '../src/signup-gate.ts'
import { anonymous, createWorkspace, randomIp, request, type User, type Workspace } from './helpers.ts'

const ORIGIN = { origin: 'http://localhost:5173' }
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@callfront.test`
const passwordSignUp = (email: string) =>
  request(
    anonymous,
    'POST',
    '/api/auth/sign-up/email',
    { name: 'New Person', email, password: 'test-password-1234' },
    { ...ORIGIN, 'x-forwarded-for': randomIp() },
  )
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

let ws: Workspace
let operator: User // owner of `ws`, a plain user here

beforeAll(async () => {
  ws = await createWorkspace('Signup Workspace')
  operator = ws.owner
})

afterEach(() => {
  delete process.env.AUTH_SIGNUP_ENABLED
})

describe('closed sign-up', () => {
  test('the sign-in screen is told when sign-up is closed', () => {
    expect(readAuthConfig({}).methods.signUp).toBe(true)
    expect(readAuthConfig({ AUTH_SIGNUP_ENABLED: 'false' }).methods.signUp).toBe(false)
  })

  test('a password sign-up is refused; existing users still sign in', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const email = address('stranger')
    const refused = await passwordSignUp(email)
    expect(refused).toMatchObject({ status: 403, body: { message: 'Sign-up is closed on this server.' } })
    expect(await accountOf(email)).toBeUndefined()

    const [owner] = await db.select().from(user).where(eq(user.id, operator.userId))
    const signIn = await request(
      anonymous,
      'POST',
      '/api/auth/sign-in/email',
      { email: owner!.email, password: 'test-password-1234' },
      { ...ORIGIN, 'x-forwarded-for': randomIp() },
    )
    expect(signIn.status).toBe(200)

    delete process.env.AUTH_SIGNUP_ENABLED
    expect((await passwordSignUp(email)).status).toBe(200)
  })

  test('every way of creating a user passes the same gate; a workspace invitation opens it for that address', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const email = address('invited')
    // Password, first email-link and first SSO sign-in all create the user through this hook.
    await expect(refuseClosedSignUp(db, { email })).rejects.toThrow('Sign-up is closed on this server.')
    const pending = {
      id: `inv_${crypto.randomUUID().slice(0, 8)}`,
      organizationId: ws.id,
      email: email.toUpperCase(),
      role: 'member',
      status: 'pending',
      inviterId: operator.userId,
    }
    await db.insert(invitation).values({ ...pending, expiresAt: new Date(Date.now() - 60_000) })
    await expect(refuseClosedSignUp(db, { email })).rejects.toThrow() // expired
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(invitation.id, pending.id))
    await expect(refuseClosedSignUp(db, { email })).resolves.toBeUndefined()
    expect((await passwordSignUp(email)).status).toBe(200)
  })

  test('no sign-in email goes to an address without an account while sign-up is closed', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const [owner] = await db.select().from(user).where(eq(user.id, operator.userId))
    expect(await maySendSignInLink(db, address('nobody'))).toBe(false)
    expect(await maySendSignInLink(db, owner!.email.toUpperCase())).toBe(true)
    delete process.env.AUTH_SIGNUP_ENABLED
    expect(await maySendSignInLink(db, address('nobody'))).toBe(true)
  })
})
