// No open sign-up (decision of 2026-11-15; signup-gate.ts): accounts come only from the first-run setup, a workspace
// invitation (made and joined in one step) or a server admin. Accounts made by an instance admin (user.invite) are
// tested in admin.test.ts, which is the only file that creates instance admins.
import { auth_events, invitation, member, organization, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { readAuthConfig, signUpSettingRemovedWarning } from '../src/auth-methods.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { maySendSignInCode, NO_ACCOUNT, refuseClosedSignUp } from '../src/signup-gate.ts'
import { joinOrUndo } from '../src/instance-admin.ts'
import { WORKSPACE_CREATION_CLOSED } from '../src/app.ts'
import {
  anonymous,
  appRequest,
  asServerAdmin,
  createWorkspace,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
  FROM,
} from './helpers.ts'

const ORIGIN = { origin: 'http://localhost:5173' }
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const passwordSignUp = (email: string) =>
  request(
    anonymous,
    'POST',
    '/api/auth/sign-up/email',
    { name: 'New Person', email, password: 'test-password-1234' },
    { ...ORIGIN, [FROM]: randomIp() },
  )
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]
/** An account without a workspace (one an admin kept), member of no workspace. */
const keptAccount = () => signUp()

let ws: Workspace
let operator: User // owner of `ws`, a plain user here

beforeAll(async () => {
  ws = await createWorkspace('Signup Workspace')
  operator = ws.owner
})

/** Asks for a sign-in code and returns it, as the email carries it; null when no email went out. */
async function codeFor(email: string): Promise<string | null> {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  try {
    const asked = await request(
      anonymous,
      'POST',
      '/api/auth/email-otp/send-verification-otp',
      { email, type: 'sign-in' },
      { ...ORIGIN, [FROM]: randomIp() },
    )
    expect(asked.status).toBe(200)
    // Sent without waiting (no account enumeration by timing): give it a moment.
    await new Promise(r => setTimeout(r, 50))
    const mail = send.mock.calls.map(([m]) => m).findLast(m => m.to === email)
    return mail ? mail.subject.slice(0, 6) : null
  } finally {
    send.mockRestore()
  }
}
const codeSignIn = (email: string, otp: string) =>
  appRequest('/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, otp }),
  })

describe('no open sign-up', () => {
  test('the sign-in screen offers no sign-up; AUTH_SIGNUP_ENABLED is ignored and only warned about', () => {
    expect(readAuthConfig({}).methods).not.toHaveProperty('signUp')
    expect(readAuthConfig({ AUTH_SIGNUP_ENABLED: 'true' }).methods).not.toHaveProperty('signUp')
    expect(signUpSettingRemovedWarning({})).toBeNull()
    expect(signUpSettingRemovedWarning({ AUTH_SIGNUP_ENABLED: 'true' })).toMatch(/no longer read/)
  })

  test('password: an unknown address gets no account, AUTH_SIGNUP_ENABLED=true or not; existing users still sign in', async () => {
    for (const value of [undefined, 'false', 'true']) {
      if (value === undefined) delete process.env.AUTH_SIGNUP_ENABLED
      else process.env.AUTH_SIGNUP_ENABLED = value
      const email = address('stranger')
      expect(await passwordSignUp(email)).toMatchObject({
        status: 400,
        body: { code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' },
      })
      expect(await accountOf(email)).toBeUndefined()
    }
    // The endpoint is off before it looks the address up: a known address gets the very same answer, so it cannot
    // tell which addresses have an account (security review of #734, finding 2).
    const [known] = await db.select().from(user).where(eq(user.id, operator.userId))
    const unknown = await passwordSignUp(address('unknown'))
    const existing = await passwordSignUp(known!.email)
    expect(existing).toEqual(unknown)
    const [owner] = await db.select().from(user).where(eq(user.id, operator.userId))
    const signIn = await request(
      anonymous,
      'POST',
      '/api/auth/sign-in/email',
      { email: owner!.email, password: 'test-password-1234' },
      { ...ORIGIN, [FROM]: randomIp() },
    )
    expect(signIn.status).toBe(200)
  })

  test('email code: no code goes to an unknown address, and a guessed code creates nothing', async () => {
    const email = address('nobody')
    expect(await maySendSignInCode(db, email)).toBe(false)
    expect(await codeFor(email)).toBeNull()
    expect((await codeSignIn(email, '123456')).ok).toBe(false)
    expect(await accountOf(email)).toBeUndefined()
    const [owner] = await db.select().from(user).where(eq(user.id, operator.userId))
    expect(await maySendSignInCode(db, owner!.email.toUpperCase())).toBe(true)
  })

  test('Google, Microsoft, GitHub, OIDC: a first provider sign-in passes the same gate and is refused without an invitation', async () => {
    // A provider proves the address (emailVerified) and creates the user through the user.create hook.
    await expect(refuseClosedSignUp(db, { email: address('google'), emailVerified: true })).rejects.toMatchObject({
      body: { code: 'SIGNUP_CLOSED', message: NO_ACCOUNT },
    })
  })

  test('a passkey never makes an account: it is added after signing in, to an existing one', async () => {
    // Adding a passkey needs a session; without one there is nothing to register it to.
    const res = await request(anonymous, 'GET', '/api/auth/passkey/generate-register-options')
    expect([401, 403, 404]).toContain(res.status)
  })

  test('an invitation opens the gate for a proven address only (a code or a provider), never for a password', async () => {
    const email = address('invited')
    const pending = {
      id: `inv_${crypto.randomUUID().slice(0, 8)}`,
      organizationId: ws.id,
      email: email.toUpperCase(),
      role: 'member',
      status: 'pending',
      inviterId: operator.userId,
    }
    await db.insert(invitation).values({ ...pending, expiresAt: new Date(Date.now() - 60_000) })
    await expect(refuseClosedSignUp(db, { email, emailVerified: true })).rejects.toThrow() // expired
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() + 3_600_000), status: 'canceled' })
      .where(eq(invitation.id, pending.id))
    await expect(refuseClosedSignUp(db, { email, emailVerified: true })).rejects.toThrow() // cancelled
    await db.update(invitation).set({ status: 'pending' }).where(eq(invitation.id, pending.id))
    await expect(refuseClosedSignUp(db, { email, emailVerified: true })).resolves.toBeUndefined()
    // A password sign-up does not prove the address, so it cannot use the invitation.
    await expect(refuseClosedSignUp(db, { email, emailVerified: false })).rejects.toThrow()
    expect((await passwordSignUp(email)).status).toBe(400)
  })

  test('an invited address signs in with a code: the account is made and joins the workspace in the same step', async () => {
    const shop = await createWorkspace('Invited Join Co')
    const email = address('joiner')
    await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID().slice(0, 8)}`,
      organizationId: shop.id,
      email,
      role: 'admin',
      status: 'pending',
      inviterId: shop.owner.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const otp = await codeFor(email)
    expect(otp).toMatch(/^\d{6}$/)
    const res = await codeSignIn(email, otp!)
    expect(res.status).toBe(200)
    const account = await accountOf(email)
    expect(account).toMatchObject({ emailVerified: true })
    const [joined] = await db
      .select()
      .from(member)
      .where(and(eq(member.userId, account!.id), eq(member.organizationId, shop.id)))
    expect(joined).toMatchObject({ role: 'admin' })
    expect((await db.select().from(invitation).where(eq(invitation.email, email)))[0]?.status).toBe('accepted')
    // In the audit log, saved with the join (#734 re-check, R4).
    const events = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, account!.id), eq(auth_events.event, 'invitation_accepted')))
    expect(events).toEqual([expect.objectContaining({ workspace_id: shop.id, method: 'invitation', email })])
  })

  test('an invitation to a disabled workspace opens nothing: no code, no account (security review of #734, finding 6)', async () => {
    const shop = await createWorkspace('Disabled Invite Co')
    const email = address('disabled-ws')
    await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID().slice(0, 8)}`,
      organizationId: shop.id,
      email,
      role: 'member',
      status: 'pending',
      inviterId: shop.owner.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, shop.id))
    expect(await maySendSignInCode(db, email)).toBe(false)
    expect(await codeFor(email)).toBeNull()
    await expect(refuseClosedSignUp(db, { email, emailVerified: true })).rejects.toThrow()
    expect(await accountOf(email)).toBeUndefined()
  })

  test('a new account that ends up in no workspace is deleted again, never a server admin (finding 6)', async () => {
    const email = address('no-workspace')
    const id = crypto.randomUUID().replaceAll('-', '')
    // As Better Auth leaves it when the invitation went away between the gate and the join.
    await db.insert(user).values({ id, name: 'Late', email, emailVerified: true })
    await expect(joinOrUndo({ id, email })).rejects.toMatchObject({ body: { code: 'SIGNUP_CLOSED' } })
    expect(await accountOf(email)).toBeUndefined()
    // The audit log keeps that the account was made and removed again (#734 re-check, R4).
    expect(await db.select().from(auth_events).where(eq(auth_events.user_id, id))).toEqual([
      expect.objectContaining({ event: 'sign_up_undone', email }),
    ])

    // A server admin runs the server without a workspace: kept.
    const adminEmail = address('admin-no-ws')
    const adminId = crypto.randomUUID().replaceAll('-', '')
    await db
      .insert(user)
      .values({ id: adminId, name: 'Admin', email: adminEmail, emailVerified: true, instanceAdmin: true })
    await joinOrUndo({ id: adminId, email: adminEmail })
    expect(await accountOf(adminEmail)).toBeDefined()
    await db.delete(user).where(eq(user.id, adminId))

    // With its invitation it joins and stays.
    const shop = await createWorkspace('Join Or Undo Co')
    const invited = address('joins')
    const kept = crypto.randomUUID().replaceAll('-', '')
    await db.insert(user).values({ id: kept, name: 'Joins', email: invited, emailVerified: true })
    await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID().slice(0, 8)}`,
      organizationId: shop.id,
      email: invited,
      role: 'member',
      status: 'pending',
      inviterId: shop.owner.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    await joinOrUndo({ id: kept, email: invited })
    expect(await db.select().from(member).where(eq(member.userId, kept))).toHaveLength(1)
  })

  test('only server admins create workspaces, AUTH_SIGNUP_ENABLED or not: not owners, kept accounts or the removed', async () => {
    const name = `Side Business ${crypto.randomUUID().slice(0, 8)}`
    const fresh = await keptAccount()
    for (const open of ['false', 'true']) {
      process.env.AUTH_SIGNUP_ENABLED = open
      // An owner of a workspace, a fresh account (an invitee who clicked "Not now", a removed member).
      for (const who of [operator, fresh]) {
        expect(await request(who, 'POST', '/v1/workspaces', { name })).toMatchObject({
          status: 403,
          body: { ok: false, code: 'workspace_creation_closed', error: WORKSPACE_CREATION_CLOSED },
        })
      }
    }
    expect(await db.select().from(organization).where(eq(organization.name, name))).toEqual([])
    expect((await request(anonymous, 'POST', '/v1/workspaces', { name: 'Nobody' })).status).toBe(401)
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    expect((await asServerAdmin(operator, () => request(operator, 'POST', '/v1/workspaces', { name }))).status).toBe(
      200,
    )
    process.env.AUTH_SIGNUP_ENABLED = 'true'
  })
})
