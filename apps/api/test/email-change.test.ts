// Changing the sign-in address (email-change.ts): unless the session is a recent passkey sign-in, a code
// to the current (confirmed) address first; then a code to the new address moves the account. Recent
// sign-in, passkey sign-in once the account has a passkey, never while impersonating; a taken address
// gets no code and nobody can tell from the answers; afterwards the other sessions end, the old address
// is told and the audit log has both addresses.
import { account, auth_events, passkey, session, user, verification } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq, like } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RECENT_SIGN_IN_MS } from '../src/account.ts'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { sameAnswerForEmailChange } from '../src/email-change.ts'
import { countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { appRequest, type Caller, FROM, randomIp, request, signUp, type User } from './helpers.ts'

// An after-hook that runs later than the email change's follow-up can be made to fail on the change (finding 4).
const failLater = vi.hoisted(() => ({ on: false }))
vi.mock('../src/audit.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/audit.ts')>()
  return {
    ...original,
    recordAuthEndpoint: async (...args: Parameters<typeof original.recordAuthEndpoint>) => {
      if (failLater.on && args[0].path === '/email-otp/change-email') throw new Error('a later after-hook failed')
      return original.recordAuthEndpoint(...args)
    },
  }
})

const ORIGIN = 'http://localhost:5173'
const PASSWORD = 'test-password-1234'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`

afterEach(() => {
  delete process.env.INSTANCE_ADMIN_EMAILS
  failLater.on = false
  vi.restoreAllMocks()
})

/** Spies on outgoing email; `codeFor` waits for the latest code sent to an address. */
function mailbox() {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  const sentTo = (email: string) => send.mock.calls.map(([m]) => m).filter(m => m.to === email)
  const codeFor = async (email: string, count = 1) => {
    await vi.waitFor(() => expect(sentTo(email).length).toBeGreaterThanOrEqual(count))
    return sentTo(email).at(-1)!.subject.slice(0, 6)
  }
  return { send, sentTo, codeFor }
}
type Mailbox = ReturnType<typeof mailbox>

const ask = (who: Caller, newEmail: string, otp?: string, ip = randomIp()) =>
  request(who, 'POST', '/api/auth/email-otp/request-email-change', otp ? { newEmail, otp } : { newEmail }, {
    [FROM]: ip,
  })
const change = (who: Caller, newEmail: string, otp: string, ip = randomIp()) =>
  request(who, 'POST', '/api/auth/email-otp/change-email', { newEmail, otp }, { [FROM]: ip })
const emailOf = async (userId: string) => (await db.select().from(user).where(eq(user.id, userId)))[0]!
const sessionsOf = (userId: string) => db.select().from(session).where(eq(session.userId, userId))
const wrong = (code: string) => (code === '000000' ? '111111' : '000000')

/** Asks for a code to `newEmail`, first proving the current address when the server asks for it. */
async function askCode(who: Caller & { email: string }, newEmail: string, box: Mailbox) {
  const first = await ask(who, newEmail)
  if (!first.body?.confirmCurrentEmail) return first
  const before = box.sentTo(who.email).length
  return ask(who, newEmail, await box.codeFor(who.email, before))
}

async function signInWithPassword(email: string) {
  const res = await appRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { headers: { cookie, origin: ORIGIN } }
}

/** An account; confirmed (as after a code or provider sign-in) unless said otherwise. */
async function member(confirmed = true): Promise<User & { email: string }> {
  const email = address('member')
  const who = await signUp(email)
  if (confirmed) await db.update(user).set({ emailVerified: true }).where(eq(user.id, who.userId))
  return { ...who, email }
}

async function addPasskey(userId: string) {
  const id = `pk_${crypto.randomUUID().slice(0, 12)}`
  await db.insert(passkey).values({
    id,
    userId,
    name: 'Laptop',
    publicKey: 'cHVibGlj',
    credentialID: `cred-${id}`,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: 'internal',
    createdAt: new Date(),
  })
}

describe('changing the email address', () => {
  test('a code to the current address, then one to the new address; the account moves, the old address is told, other sessions end', async () => {
    const box = mailbox()
    const { sentTo, codeFor } = box
    const me = await member()
    const elsewhere = await signInWithPassword(me.email)
    expect(await sessionsOf(me.userId)).toHaveLength(2)
    const accountsBefore = await db.select().from(account).where(eq(account.userId, me.userId))
    const next = address('new')

    // First the current address: a code to it, nothing to the new one yet.
    expect(await ask(me, next)).toMatchObject({ status: 200, body: { success: true, confirmCurrentEmail: true } })
    const proof = await codeFor(me.email)
    expect(sentTo(me.email).at(-1)!.subject).toBe(`${proof} is your Linedesk code to confirm it's you`)
    expect(sentTo(next)).toHaveLength(0)

    // With it, the code goes to the new address.
    expect(await ask(me, next, proof)).toMatchObject({ status: 200, body: { success: true } })
    const code = await codeFor(next)
    expect(code).toMatch(/^\d{6}$/)
    const mail = sentTo(next).at(-1)!
    expect(mail.subject).toBe(`${code} is your Linedesk code to change your email`)
    expect(mail.text).not.toMatch(/https?:\/\//)
    // Nothing changes until the code is typed.
    expect((await emailOf(me.userId)).email).toBe(me.email)

    expect(await change(me, next, code)).toMatchObject({ status: 200, body: { success: true } })
    expect(await emailOf(me.userId)).toMatchObject({ email: next, emailVerified: true })

    // This session stays and now has the new address; the one elsewhere is gone.
    const mine = await request(me, 'GET', '/api/auth/get-session')
    expect(mine.body?.user.email).toBe(next)
    expect((await request(elsewhere, 'GET', '/api/auth/get-session')).body).toBeNull()
    expect(await sessionsOf(me.userId)).toHaveLength(1)

    // The old address is told, naming the new one, and to tell the administrator if it was not them.
    await vi.waitFor(() => expect(sentTo(me.email)).toHaveLength(2))
    const notice = sentTo(me.email)[1]!
    expect(notice.subject).toBe('The email of your Linedesk account was changed')
    expect(notice.text).toContain('tell your administrator')
    expect(notice.text).toContain(next.split('@')[0])

    // The audit log keeps both addresses (finding 6).
    const [event] = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, me.userId), eq(auth_events.event, 'email_changed')))
    expect(event).toMatchObject({ event: 'email_changed', email: me.email, method: next })

    // Sign-in methods stay: the password signs in with the new address, not the old one.
    expect(await db.select().from(account).where(eq(account.userId, me.userId))).toEqual(accountsBefore)
    await signInWithPassword(next)
    const old = await appRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ email: me.email, password: PASSWORD }),
    })
    expect(old.status).toBe(401)
    // The code is used up.
    expect((await change(me, next, code)).status).toBe(400)
  })

  test('a stolen password alone does not do: without the current address, no code goes to the new one and no change works (finding 2)', async () => {
    const { sentTo, codeFor } = mailbox()
    const me = await member()
    const next = address('thief')
    await ask(me, next)
    const proof = await codeFor(me.email)
    // A wrong code for the current address: refused, nothing sent to the new address.
    expect(await ask(me, next, wrong(proof))).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    expect(sentTo(next)).toHaveLength(0)
    // Guessing the new address's code without the proof is refused like a wrong code.
    expect(await change(me, next, '123456')).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    // Three tries per code: after them the right one is refused too.
    await ask(me, next, wrong(proof))
    await ask(me, next, wrong(proof))
    expect(await ask(me, next, proof)).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    expect(sentTo(next)).toHaveLength(0)
    expect((await emailOf(me.userId)).email).toBe(me.email)
  })

  test('the proof holds for the session: a new code to the new address needs no second proof', async () => {
    const box = mailbox()
    const me = await member()
    const next = address('again')
    await askCode(me, next, box)
    await box.codeFor(next)
    expect(await ask(me, next)).toMatchObject({ status: 200, body: { success: true } })
    expect(box.sentTo(me.email)).toHaveLength(1)
    await vi.waitFor(() => expect(box.sentTo(next)).toHaveLength(2))
  })

  test('a passkey sign-in of the last 12 hours, or an address never confirmed: no code to the current address', async () => {
    const { sentTo, codeFor } = mailbox()
    const withPasskey = await member()
    await addPasskey(withPasskey.userId)
    await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, withPasskey.userId))
    const next = address('passkey-first')
    expect(await ask(withPasskey, next)).toMatchObject({ status: 200, body: { success: true } })
    expect((await ask(withPasskey, next)).body?.confirmCurrentEmail).toBeUndefined()
    expect(sentTo(withPasskey.email)).toHaveLength(0)
    expect((await change(withPasskey, next, await codeFor(next))).status).toBe(200)

    const unconfirmed = await member(false)
    const other = address('unconfirmed')
    expect(await ask(unconfirmed, other)).toMatchObject({ status: 200, body: { success: true } })
    expect(sentTo(unconfirmed.email)).toHaveLength(0)
    expect((await change(unconfirmed, other, await codeFor(other))).status).toBe(200)
    expect(await emailOf(unconfirmed.userId)).toMatchObject({ email: other, emailVerified: true })
  })

  test('a wrong, expired or spent code gets one answer (finding 1)', async () => {
    const box = mailbox()
    const me = await member()
    const next = address('wrong')
    await askCode(me, next, box)
    const code = await box.codeFor(next)
    const refused = { status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } }
    expect(await change(me, next, wrong(code))).toEqual(refused)
    expect((await emailOf(me.userId)).email).toBe(me.email)
    // Out of tries (Better Auth: 403 TOO_MANY_ATTEMPTS): the same answer.
    await change(me, next, wrong(code))
    await change(me, next, wrong(code))
    expect(await change(me, next, code)).toEqual(refused)
    // Expired (Better Auth: OTP_EXPIRED, or gone once any request cleaned expired codes up): the same answer.
    await ask(me, next)
    const fresh = await box.codeFor(next, 2)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verification.identifier, `change-email-otp-%${next}`))
    expect(await change(me, next, fresh)).toEqual(refused)
    expect((await emailOf(me.userId)).email).toBe(me.email)
  })

  test('an expired code for a free address and any code for a taken one answer the same (finding 1)', async () => {
    const box = mailbox()
    const me = await member()
    const free = address('free')
    await askCode(me, free, box)
    const code = await box.codeFor(free)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verification.identifier, `change-email-otp-%${free}`))
    const expired = await change(me, free, code)
    const taken = await change(me, (await member()).email, code)
    process.env.INSTANCE_ADMIN_EMAILS = address('operator')
    const reserved = await change(me, process.env.INSTANCE_ADMIN_EMAILS, code)
    expect(expired).toEqual({ status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } })
    expect(taken).toEqual(expired)
    expect(reserved).toEqual(expired)
  })

  test('an address with an account: the same answer as a free one, no code, only that mailbox is told', async () => {
    const box = mailbox()
    const me = await member()
    const other = await member()
    const free = address('free')
    const forFree = await askCode(me, free, box)
    const forTaken = await ask(me, other.email.toUpperCase())
    expect(forTaken).toEqual(forFree)
    expect(forTaken).toEqual({ status: 200, body: { success: true } })
    await vi.waitFor(() => expect(box.sentTo(other.email)).toHaveLength(1))
    const notice = box.sentTo(other.email)[0]!
    expect(notice.subject).toBe("This address can't be used for another Linedesk account")
    expect(notice.subject).not.toMatch(/\d{6}/)
    const stored = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, `%${other.email}%`))
    expect(stored).toHaveLength(0)
    for (const otp of ['000000', '123456'])
      expect(await change(me, other.email, otp)).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    expect((await emailOf(me.userId)).email).toBe(me.email)
    expect((await emailOf(other.userId)).email).toBe(other.email)
  })

  test('an address kept for an administrator: the request runs as for any address, its code is removed and the notice sent (finding 3)', async () => {
    const box = mailbox()
    const me = await member()
    const reserved = address('operator')
    process.env.INSTANCE_ADMIN_EMAILS = reserved
    expect(await askCode(me, reserved, box)).toEqual({ status: 200, body: { success: true } })
    await vi.waitFor(() => expect(box.sentTo(reserved)).toHaveLength(1))
    expect(box.sentTo(reserved)[0]!.subject).toBe("This address can't be used for another Linedesk account")
    const stored = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, `change-email-otp-%${reserved}`))
    expect(stored).toHaveLength(0)
  })

  test('an address taken after its code was sent: the code no longer works (finding 5)', async () => {
    const box = mailbox()
    const me = await member()
    const next = address('late')
    await askCode(me, next, box)
    const code = await box.codeFor(next)
    const other = await member()
    await db.update(user).set({ email: next }).where(eq(user.id, other.userId))
    expect(await change(me, next, code)).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    expect((await emailOf(me.userId)).email).toBe(me.email)
  })

  test('the answers after Better Auth: expired and spent codes as wrong ones, a race for the address plainly', () => {
    const at = (returned: unknown) => ({ path: '/email-otp/change-email', context: { returned } }) as never
    for (const code of ['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])
      expect(() => sameAnswerForEmailChange(at(new APIError('BAD_REQUEST', { code })))).toThrow(
        expect.objectContaining({ statusCode: 400, body: expect.objectContaining({ code: 'INVALID_OTP' }) }),
      )
    expect(() =>
      sameAnswerForEmailChange(at(new APIError('BAD_REQUEST', { message: 'Email already in use' }))),
    ).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: 'EMAIL_UNUSABLE' }) }))
    expect(() => sameAnswerForEmailChange(at({ success: true }))).not.toThrow()
  })

  test('once the address changed, the other sessions end and the old address is told even if a later step fails (finding 4)', async () => {
    const box = mailbox()
    const me = await member()
    await signInWithPassword(me.email)
    const next = address('robust')
    await askCode(me, next, box)
    const code = await box.codeFor(next)
    failLater.on = true
    expect((await change(me, next, code)).status).toBe(500)
    failLater.on = false
    expect((await emailOf(me.userId)).email).toBe(next)
    expect(await sessionsOf(me.userId)).toHaveLength(1)
    await vi.waitFor(() =>
      expect(box.sentTo(me.email).map(m => m.subject)).toContain('The email of your Linedesk account was changed'),
    )
    const events = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, me.userId), eq(auth_events.event, 'email_changed')))
    expect(events).toHaveLength(1)
  })

  test('codes per account are limited, whatever the addresses', async () => {
    const box = mailbox()
    const me = await member()
    const statuses = [(await askCode(me, address('spray'), box)).status]
    for (let i = 0; i < 5; i++) statuses.push((await ask(me, address('spray'))).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  test('wrong codes and code requests share the code limits of the new address (per address and IP)', async () => {
    // Over HTTP Better Auth's own limit (3 a minute per IP) answers first; the hooks are called directly here.
    const at = (path: string, newEmail: string, ip: string, returned?: unknown) =>
      ({
        path,
        body: { newEmail, otp: '000000' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: { returned },
      }) as never
    const target = address('target')
    const ip = randomIp()
    const refused = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    for (let i = 0; i < 10; i++) {
      await limitSignIns(at('/email-otp/change-email', target, ip))
      await countSignInFailures(at('/email-otp/change-email', target, ip, refused))
    }
    await expect(limitSignIns(at('/email-otp/change-email', target, ip))).rejects.toMatchObject({ statusCode: 429 })
    // The same count as a code sign-in to that address from there.
    const codeSignIn = {
      path: '/sign-in/email-otp',
      body: { email: target, otp: '000000' },
      headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
      context: {},
    } as never
    await expect(limitSignIns(codeSignIn)).rejects.toMatchObject({ statusCode: 429 })

    const asked = address('asked')
    for (let i = 0; i < 5; i++) await limitSignIns(at('/email-otp/request-email-change', asked, ip))
    await expect(limitSignIns(at('/email-otp/request-email-change', asked, ip))).rejects.toMatchObject({
      statusCode: 429,
    })
    const sendCode = {
      path: '/email-otp/send-verification-otp',
      body: { email: asked, type: 'sign-in' },
      headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
      context: {},
    } as never
    await expect(limitSignIns(sendCode)).rejects.toMatchObject({ statusCode: 429 })
  })

  test('needs a recent sign-in', async () => {
    const { send } = mailbox()
    const me = await member()
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - RECENT_SIGN_IN_MS - 1000) })
      .where(eq(session.userId, me.userId))
    expect(await ask(me, address('stale'))).toMatchObject({ status: 403, body: { code: 'SESSION_NOT_FRESH' } })
    expect(send).not.toHaveBeenCalled()
  })

  test('the code is accepted up to its own lifetime after a recent sign-in, not later', async () => {
    const box = mailbox()
    const me = await member()
    const next = address('slow')
    await askCode(me, next, box)
    const code = await box.codeFor(next)
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - RECENT_SIGN_IN_MS - 11 * 60_000) })
      .where(eq(session.userId, me.userId))
    expect(await change(me, next, code)).toMatchObject({ status: 403, body: { code: 'SESSION_NOT_FRESH' } })
    expect((await emailOf(me.userId)).email).toBe(me.email)
  })

  test('with a passkey, only after a passkey sign-in', async () => {
    const { send, codeFor } = mailbox()
    const me = await member()
    await addPasskey(me.userId)
    const next = address('passkey')
    expect(await ask(me, next)).toMatchObject({ status: 403, body: { code: 'PASSKEY_CONFIRMATION_REQUIRED' } })
    expect(await change(me, next, '000000')).toMatchObject({
      status: 403,
      body: { code: 'PASSKEY_CONFIRMATION_REQUIRED' },
    })
    expect(send).not.toHaveBeenCalled()
    await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, me.userId))
    expect(await ask(me, next)).toMatchObject({ status: 200, body: { success: true } })
    expect((await change(me, next, await codeFor(next))).status).toBe(200)
    expect((await emailOf(me.userId)).email).toBe(next)
  })

  test('refused while an admin is signed in as the user', async () => {
    const { send } = mailbox()
    const me = await member()
    const admin = await member()
    await db.update(session).set({ impersonatedBy: admin.userId }).where(eq(session.userId, me.userId))
    const next = address('impersonated')
    expect(await ask(me, next)).toMatchObject({ status: 403, body: { code: 'NOT_WHILE_IMPERSONATING' } })
    expect(await ask(me, next, '000000')).toMatchObject({ status: 403, body: { code: 'NOT_WHILE_IMPERSONATING' } })
    expect(await change(me, next, '000000')).toMatchObject({ status: 403, body: { code: 'NOT_WHILE_IMPERSONATING' } })
    expect(send).not.toHaveBeenCalled()
    expect((await emailOf(me.userId)).email).toBe(me.email)
  })

  test('signed out: nothing', async () => {
    const { send } = mailbox()
    expect((await ask({ headers: { origin: ORIGIN } }, address('anon'))).status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })
})
