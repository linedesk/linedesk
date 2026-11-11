// Email sign-in by code: a 6-digit code by email, 10 minutes, 3 tries, limits per IP and per address,
// and closed sign-up. Codes are read from a spy on the email sender.
import { invitation, user, verification } from '@linedesk/db'
import { eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { anonymous, createWorkspace, randomIp, request, type Workspace, FROM } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Email Code Workspace')
})
afterEach(() => {
  delete process.env.AUTH_SIGNUP_ENABLED
  vi.restoreAllMocks()
})

/** Spies on outgoing email; `codeFor` waits for the latest code sent to an address. */
function mailbox() {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  const sentTo = (email: string) => send.mock.calls.map(([m]) => m).filter(m => m.to === email)
  const codeFor = async (email: string) => {
    await vi.waitFor(() => expect(sentTo(email).length).toBeGreaterThan(0))
    return sentTo(email).at(-1)!.subject.slice(0, 6)
  }
  return { send, sentTo, codeFor }
}
const requestCode = (email: string, ip = randomIp()) =>
  request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, { origin: ORIGIN, [FROM]: ip })
const signIn = (email: string, otp: string) =>
  request(anonymous, 'POST', '/api/auth/sign-in/email-otp', { email, otp }, { origin: ORIGIN, [FROM]: randomIp() })
const ownerEmail = async () => (await db.select().from(user).where(eq(user.id, ws.owner.userId)))[0]!.email

describe('signing in with a code', () => {
  test('the email carries the 6-digit code in subject and body and no link; the code signs in and verifies the address', async () => {
    const { sentTo, codeFor } = mailbox()
    const email = await ownerEmail()
    expect((await requestCode(email)).status).toBe(200)
    const code = await codeFor(email)
    expect(code).toMatch(/^\d{6}$/)
    const mail = sentTo(email).at(-1)!
    expect(mail.subject).toBe(`${code} is your Linedesk sign-in code`)
    expect(mail.text).toContain(code)
    expect(mail.text).not.toMatch(/https?:\/\//)
    expect(await accountOf(email)).toMatchObject({ emailVerified: false })

    expect(await signIn(email, code === '000000' ? '111111' : '000000')).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    const ok = await signIn(email, code)
    expect(ok.status).toBe(200)
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
    // Once used, the code is gone.
    expect((await signIn(email, code)).status).toBe(400)
  })

  test('after three wrong tries the code is spent, even the right one fails', async () => {
    const { codeFor } = mailbox()
    const email = await ownerEmail()
    await requestCode(email)
    const code = await codeFor(email)
    const wrong = code === '123456' ? '654321' : '123456'
    for (let i = 0; i < 3; i++) expect((await signIn(email, wrong)).status).toBe(400)
    expect(await signIn(email, code)).toMatchObject({ status: 403, body: { code: 'TOO_MANY_ATTEMPTS' } })
  })

  test('an expired code is refused', async () => {
    const { codeFor } = mailbox()
    const email = await ownerEmail()
    await requestCode(email)
    const code = await codeFor(email)
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(like(verification.identifier, `%${email}%`))
    expect(await signIn(email, code)).toMatchObject({ status: 400, body: { code: 'OTP_EXPIRED' } })
  })

  test('the code is stored hashed, never as typed', async () => {
    const { codeFor } = mailbox()
    const email = await ownerEmail()
    await requestCode(email)
    const code = await codeFor(email)
    const rows = await db.select().from(verification).where(like(verification.identifier, `%${email}%`))
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  test('requests are limited per connection address; a spoofed X-Forwarded-For does not open a new bucket', async () => {
    mailbox()
    const ip = randomIp()
    const statuses = []
    for (let i = 0; i < 4; i++) {
      const res = await request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email: address('ip'), type: 'sign-in' }, {
        origin: ORIGIN,
        [FROM]: ip,
        'x-forwarded-for': `198.51.100.${i}`,
        'x-linedesk-client-ip': `198.51.100.${i}`,
      })
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
  })

  test('past the per-address limit no new code is made: the last one still works', async () => {
    const { sentTo, codeFor } = mailbox()
    const email = address('five-codes')
    for (let i = 0; i < 5; i++) expect((await requestCode(email)).status).toBe(200)
    const last = await codeFor(email)
    await vi.waitFor(() => expect(sentTo(email)).toHaveLength(5))
    expect((await requestCode(email)).status).toBe(429)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sentTo(email)).toHaveLength(5)
    expect((await signIn(email, last)).status).toBe(200)
  })

  test('new codes do not give endless tries: 10 tries per address and hour across codes', async () => {
    const { sentTo, codeFor } = mailbox()
    const email = address('guesser')
    let tries = 0
    for (let round = 0; round < 4 && tries < 10; round++) {
      await requestCode(email)
      await vi.waitFor(() => expect(sentTo(email)).toHaveLength(round + 1))
      const code = await codeFor(email)
      const wrong = code === '123456' ? '654321' : '123456'
      for (let i = 0; i < 3 && tries < 10; i++, tries++) expect((await signIn(email, wrong)).status).toBe(400)
    }
    expect(tries).toBe(10)
    expect((await signIn(email, await codeFor(email))).status).toBe(429)
  })

})

describe('what is not offered', () => {
  const unused = [
    '/email-otp/request-password-reset', '/forget-password/email-otp', '/email-otp/reset-password', '/email-otp/verify-email',
    '/email-otp/check-verification-otp', '/email-otp/request-email-change', '/email-otp/change-email',
  ]
  test.each(unused)('POST /api/auth%s is not there', async path => {
    const res = await request(anonymous, 'POST', `/api/auth${path}`, { email: 'a@linedesk.test', otp: '123456', password: 'new-password-123', type: 'forget-password' }, { origin: ORIGIN, [FROM]: randomIp() })
    expect(res.status).toBe(404)
  })

  test('only sign-in codes are sent', async () => {
    const { send } = mailbox()
    for (const type of ['email-verification', 'forget-password', 'change-email']) {
      const res = await request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email: await ownerEmail(), type }, { origin: ORIGIN, [FROM]: randomIp() })
      expect(res.status, type).toBe(400)
    }
    expect(send).not.toHaveBeenCalled()
  })
})

describe('codes and sign-up', () => {
  test('with sign-up open, a code creates the account, verified', async () => {
    const { codeFor } = mailbox()
    const email = address('new')
    await requestCode(email)
    expect((await signIn(email, await codeFor(email))).status).toBe(200)
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
  })

  test('with sign-up closed, an unknown address gets the same answer and no code', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const { send } = mailbox()
    const email = address('stranger')
    const res = await requestCode(email)
    expect(res).toEqual({ status: 200, body: { success: true } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(send).not.toHaveBeenCalled()
    expect((await signIn(email, '123456')).status).toBe(400)
    expect(await accountOf(email)).toBeUndefined()
  })

  test('a disabled account gets the same answer and no code, with sign-up open or closed', async () => {
    const email = address('disabled')
    const { send, codeFor } = mailbox()
    expect((await signIn(email, await codeFor((await requestCode(email), email)))).status).toBe(200)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.email, email))
    send.mockClear()
    for (const open of ['true', 'false']) {
      process.env.AUTH_SIGNUP_ENABLED = open
      expect(await requestCode(email)).toEqual({ status: 200, body: { success: true } })
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(send).not.toHaveBeenCalled()
  })

  test('with sign-up closed, an invited address gets a code and joins, verified', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const { codeFor } = mailbox()
    const email = address('invited')
    await db.insert(invitation).values({
      id: `inv_${crypto.randomUUID().slice(0, 8)}`, organizationId: ws.id, email, role: 'member', status: 'pending',
      inviterId: ws.owner.userId, expiresAt: new Date(Date.now() + 3_600_000),
    })
    await requestCode(email)
    expect((await signIn(email, await codeFor(email))).status).toBe(200)
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
  })
})
