// Email sign-in by code: a 6-digit code by email, 10 minutes, 3 tries, limits per IP and per address,
// and closed sign-up. Codes are read from a spy on the email sender.
import { invitation, user, verification } from '@linedesk/db'
import { eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { APIError } from 'better-auth/api'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { anonymous, createWorkspace, randomIp, request, type Workspace, FROM } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Email Code Workspace')
})
afterEach(() => {
  process.env.AUTH_SIGNUP_ENABLED = 'true'
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

  test('codes are limited per address and IP: asking from many places never locks the address out (security L3)', async () => {
    const { sentTo, codeFor } = mailbox()
    const email = address('many-places')
    for (let i = 0; i < 7; i++) expect((await requestCode(email)).status).toBe(200)
    await vi.waitFor(() => expect(sentTo(email)).toHaveLength(7))
    expect((await signIn(email, await codeFor(email))).status).toBe(200)
  })

  test('codes and wrong codes from one IPv6 /64 count in one bucket however the addresses rotate (review B1)', async () => {
    const at = (email: string, ip: string, path: string, returned?: unknown) =>
      ({ path, body: { email, otp: '000000', type: 'sign-in' }, headers: new Headers({ [CLIENT_IP_HEADER]: ip }), context: { returned } }) as never
    const email = address('rotating')
    const net = `2001:db8:${Math.floor(Math.random() * 65536).toString(16)}:9`
    const send = '/email-otp/send-verification-otp'
    for (let i = 1; i <= 5; i++) await limitSignIns(at(email, `${net}::${i}`, send))
    await expect(limitSignIns(at(email, `${net}::6`, send))).rejects.toMatchObject({ statusCode: 429 })
    await expect(limitSignIns(at(email, '198.51.100.40', send))).resolves.toBeUndefined()
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    for (let i = 1; i <= 10; i++) await countSignInFailures(at(email, `${net}:ffff::${i}`, '/sign-in/email-otp', wrong))
    await expect(limitSignIns(at(email, `${net}::1234`, '/sign-in/email-otp'))).rejects.toMatchObject({ statusCode: 429 })
  })

  test('wrong codes count per address and IP, and only failures (security L3)', async () => {
    const at = (email: string, ip: string, path = '/sign-in/email-otp', returned?: unknown) =>
      ({ path, body: { email, otp: '000000' }, headers: new Headers({ [CLIENT_IP_HEADER]: ip }), context: { returned } }) as never
    const email = address('guesser')
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    for (let i = 0; i < 10; i++) {
      await limitSignIns(at(email, '203.0.113.7'))
      await countSignInFailures(at(email, '203.0.113.7', '/sign-in/email-otp', wrong))
    }
    await expect(limitSignIns(at(email, '203.0.113.7'))).rejects.toMatchObject({ statusCode: 429 })
    // The owner, from their own address, still gets in.
    await expect(limitSignIns(at(email, '198.51.100.20'))).resolves.toBeUndefined()
    // A success or a refusal for too many requests does not count.
    const other = address('fine')
    for (let i = 0; i < 20; i++) {
      await countSignInFailures(at(other, '203.0.113.8', '/sign-in/email-otp', { token: 'ok' }))
      await countSignInFailures(at(other, '203.0.113.8', '/sign-in/email-otp', new APIError('TOO_MANY_REQUESTS')))
    }
    await expect(limitSignIns(at(other, '203.0.113.8'))).resolves.toBeUndefined()
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
