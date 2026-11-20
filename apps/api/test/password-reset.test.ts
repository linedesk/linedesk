// "Forgot password?": a code by email, then the code with a new password (password-reset.ts). The
// same answer for every address, the code limits of a sign-in code, every session ended, an unproven
// address cleaned up as by a code sign-in, passkeys untouched and still needing a passkey sign-in.
import {
  account,
  agent_setup_keys,
  api_keys,
  auth_events,
  passkey,
  session,
  sign_in_counters,
  user,
  verification,
} from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq, like, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { PASSKEY_CONFIRMATION_REQUIRED } from '../src/passkeys.ts'
import { afterPasswordReset, endSessionsAfterReset } from '../src/password-reset.ts'
import { codeFailuresAnywhere, codeFailuresDaily, countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { anonymous, appRequest, type Caller, FROM, randomIp, request, signUp, type User } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const OLD_PASSWORD = 'test-password-1234' // helpers.ts signUp
const NEW_PASSWORD = 'a-brand-new-password-42'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

afterEach(() => {
  vi.restoreAllMocks()
})

/** A bare account row for the limits per account: its address. */
const makeAccount = async (prefix: string) => {
  const email = address(prefix)
  await db.insert(user).values({ id: crypto.randomUUID(), name: 'Test User', email })
  return email
}
/**
 * Moves an account's sign-in counters `hours` back in time, as if those hours had passed, and forgets the caps in
 * memory, as a restart does: what still holds is the database's. Through a range no row is in, so a row never lands on
 * the hour of another one while the update runs (the key is checked row by row).
 */
const hoursAgo = async (email: string, hours: number) => {
  const mine = eq(sign_in_counters.user_id, (await accountOf(email))!.id)
  const shift = (by: ReturnType<typeof sql>) =>
    db
      .update(sign_in_counters)
      .set({ hour: sql`${sign_in_counters.hour} + ${by}` })
      .where(mine)
  await shift(sql`interval '1000 years'`)
  await shift(sql`- interval '1000 years' - make_interval(hours => ${hours})`)
  codeFailuresAnywhere.clear()
  codeFailuresDaily.clear()
}

/** Spies on outgoing email; `codeFor` waits for the latest reset code sent to an address. */
function mailbox() {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  const sentTo = (email: string) => send.mock.calls.map(([m]) => m).filter(m => m.to === email)
  const codeFor = async (email: string) => {
    await vi.waitFor(() => expect(sentTo(email).some(m => m.subject.includes('password reset code'))).toBe(true))
    return sentTo(email)
      .filter(m => m.subject.includes('password reset code'))
      .at(-1)!
      .subject.slice(0, 6)
  }
  return { send, sentTo, codeFor }
}

const requestReset = (email: string, ip = randomIp()) =>
  request(anonymous, 'POST', '/api/auth/email-otp/request-password-reset', { email }, { origin: ORIGIN, [FROM]: ip })
const reset = (email: string, otp: string, password = NEW_PASSWORD) =>
  request(
    anonymous,
    'POST',
    '/api/auth/email-otp/reset-password',
    { email, otp, password },
    { origin: ORIGIN, [FROM]: randomIp() },
  )
const isSignedIn = async (who: Caller) => Boolean((await request(who, 'GET', '/api/auth/get-session')).body)
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000')
/** The one answer for every refused code at the reset step. */
const REFUSED = { status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } }
const expireCodesOf = (email: string) =>
  db
    .update(verification)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(like(verification.identifier, `%${email}%`))

async function signIn(email: string, password: string) {
  const res = await appRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, password }),
  })
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { status: res.status, caller: { headers: { cookie, origin: ORIGIN } } }
}

/** A member with a password and a confirmed address. */
async function member(email = address('member')): Promise<User & { email: string }> {
  const who = await signUp(email)
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, who.userId))
  return { ...who, email }
}

async function addPasskeyRow(userId: string) {
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
  return id
}

describe('resetting a password with an emailed code', () => {
  test('the code resets the password, ends every session, emails the account and is in the audit log', async () => {
    const { sentTo, codeFor } = mailbox()
    const who = await member()
    const other = await signIn(who.email, OLD_PASSWORD)
    expect(await isSignedIn(who)).toBe(true)
    expect(await isSignedIn(other.caller)).toBe(true)

    expect(await requestReset(who.email)).toEqual({ status: 200, body: { success: true } })
    const code = await codeFor(who.email)
    expect(code).toMatch(/^\d{6}$/)
    const mail = sentTo(who.email).at(-1)!
    expect(mail.subject).toBe(`${code} is your Linedesk password reset code`)
    expect(mail.text).not.toMatch(/https?:\/\//)

    expect(await reset(who.email, code)).toEqual({ status: 200, body: { success: true } })
    // Every session of the account is gone, the one in this browser too.
    expect(await isSignedIn(who)).toBe(false)
    expect(await isSignedIn(other.caller)).toBe(false)
    expect((await signIn(who.email, OLD_PASSWORD)).status).toBe(401)
    const fresh = await signIn(who.email, NEW_PASSWORD)
    expect(fresh.status).toBe(200)
    expect(await isSignedIn(fresh.caller)).toBe(true)
    // Used once: the same code does not work again.
    expect(await reset(who.email, code, 'yet-another-password-7')).toMatchObject({ status: 400 })

    await vi.waitFor(() =>
      expect(sentTo(who.email).map(m => m.subject)).toContain('The password of your Linedesk account was changed'),
    )
    const events = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, who.userId), eq(auth_events.event, 'password_changed')))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ method: 'email_code', email: who.email })
  })

  test('a password that breaks the sign-up rules is refused before the code is checked: no try is spent (review I3)', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    await requestReset(who.email)
    const code = await codeFor(who.email)
    // With a wrong code too: the password answers first, so the code's 3 tries stay.
    for (let i = 0; i < 3; i++)
      expect(await reset(who.email, wrongCode(code), 'short')).toMatchObject({
        status: 400,
        body: { code: 'PASSWORD_TOO_SHORT' },
      })
    expect(await reset(who.email, code, 'x'.repeat(200))).toMatchObject({
      status: 400,
      body: { code: 'PASSWORD_TOO_LONG' },
    })
    expect((await reset(who.email, code)).status).toBe(200)
  })

  test("the account's agent setup keys end with the reset (review L2)", async () => {
    const { codeFor } = mailbox()
    const who = await member()
    const id = `ask_${crypto.randomUUID().slice(0, 12)}`
    await db.insert(agent_setup_keys).values({
      id,
      prefix: 'lds_x',
      key_hash: `h-${id}`,
      created_by: who.userId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    await requestReset(who.email)
    expect((await reset(who.email, await codeFor(who.email))).status).toBe(200)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, id))
    expect(row?.revoked_at).not.toBeNull()
  })

  test('after a reset every session of the account goes once more, also one made meanwhile (review L1)', async () => {
    const who = await member()
    const other = await signIn(who.email, OLD_PASSWORD)
    expect(await isSignedIn(other.caller)).toBe(true)
    const ctx = (returned: unknown) =>
      ({ path: '/email-otp/reset-password', body: { email: who.email.toUpperCase() }, context: { returned } }) as never
    // A refused reset leaves sessions alone; a successful one ends them.
    await endSessionsAfterReset(ctx(new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })))
    expect(await isSignedIn(other.caller)).toBe(true)
    await endSessionsAfterReset(ctx({ success: true }))
    expect(await isSignedIn(other.caller)).toBe(false)
    expect(await db.select().from(session).where(eq(session.userId, who.userId))).toHaveLength(0)
  })

  test('when the cleanup fails, the change is still in the audit log and the error goes on (review L3)', async () => {
    const who = await member()
    // The first write of the cleanup (ending setup links, in a transaction of its own under the person's lock).
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new Error('database gone')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      afterPasswordReset({ user: { id: who.userId, email: who.email, emailVerified: true } }),
    ).rejects.toThrow('database gone')
    const events = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, who.userId), eq(auth_events.event, 'password_changed')))
    expect(events).toHaveLength(1)
  })

  test('an account without a password gets one (email code or provider accounts)', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    await db.delete(account).where(and(eq(account.userId, who.userId), eq(account.providerId, 'credential')))
    await requestReset(who.email)
    expect((await reset(who.email, await codeFor(who.email))).status).toBe(200)
    expect((await signIn(who.email, NEW_PASSWORD)).status).toBe(200)
  })
})

describe('what a reset tells and refuses', () => {
  test('an unknown address gets the same answer, no email, and a reset is refused like a wrong code', async () => {
    const { send, codeFor } = mailbox()
    const stranger = address('stranger')
    expect(await requestReset(stranger)).toEqual({ status: 200, body: { success: true } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(send).not.toHaveBeenCalled()
    const unknown = await reset(stranger, '123456')

    const who = await member()
    await requestReset(who.email)
    const known = await reset(who.email, wrongCode(await codeFor(who.email)))
    expect(unknown).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
    expect(known).toEqual(unknown)
    expect(await accountOf(stranger)).toBeUndefined()
  })

  test('wrong, spent and expired codes are refused with one answer and the password stays', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    await requestReset(who.email)
    const code = await codeFor(who.email)
    for (let i = 0; i < 3; i++) expect((await reset(who.email, wrongCode(code))).status).toBe(400)
    // Out of tries: even the right code is refused, with the answer of a wrong one.
    expect(await reset(who.email, code)).toEqual(REFUSED)

    await requestReset(who.email)
    const second = await codeFor(who.email)
    await expireCodesOf(who.email)
    expect(await reset(who.email, second)).toEqual(REFUSED)
    expect((await signIn(who.email, OLD_PASSWORD)).status).toBe(200)
  })

  test('known and unknown addresses get identical answers after expiry and after repeated wrong tries (review M1)', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    const stranger = address('stranger')
    const answers = async (email: string, known: boolean) => {
      await requestReset(email)
      const code = known ? await codeFor(email) : '123456'
      const tries = []
      for (let i = 0; i < 4; i++) tries.push(await reset(email, wrongCode(code)))
      await requestReset(email)
      await expireCodesOf(email)
      const expired = await reset(email, '123456')
      return { tries, expired }
    }
    const known = await answers(who.email, true)
    const unknown = await answers(stranger, false)
    expect(known).toEqual(unknown)
    expect(known.expired).toEqual(REFUSED)
    for (const answer of known.tries) expect(answer).toEqual(REFUSED)
  })

  test('the code is stored hashed', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    await requestReset(who.email)
    const code = await codeFor(who.email)
    const rows = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, `%${who.email}%`))
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  test('a disabled account gets no code and cannot reset', async () => {
    const { send } = mailbox()
    const who = await member()
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, who.userId))
    expect(await requestReset(who.email)).toEqual({ status: 200, body: { success: true } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(send).not.toHaveBeenCalled()
    const [row] = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, `%${who.email}%`))
    expect(row).toBeDefined()
    expect(await reset(who.email, '123456')).toMatchObject({ status: 400, body: { code: 'INVALID_OTP' } })
  })

  test('the older duplicate endpoint stays off, and send-verification-otp sends no reset codes', async () => {
    const { send } = mailbox()
    const who = await member()
    const old = await request(
      anonymous,
      'POST',
      '/api/auth/forget-password/email-otp',
      { email: who.email },
      { origin: ORIGIN, [FROM]: randomIp() },
    )
    expect(old.status).toBe(404)
    const viaSend = await request(
      anonymous,
      'POST',
      '/api/auth/email-otp/send-verification-otp',
      { email: who.email, type: 'forget-password' },
      { origin: ORIGIN, [FROM]: randomIp() },
    )
    expect(viaSend.status).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('limits', () => {
  test('requests are limited per connection address (Better Auth, 3 a minute)', async () => {
    mailbox()
    const ip = randomIp()
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await requestReset(address('ip'), ip)).status)
    expect(statuses).toEqual([200, 200, 200, 429])
  })

  test('reset codes share the sign-in code limits per address and IP: the cooldown between codes, 10 wrong codes', async () => {
    const at = (email: string, ip: string, path: string, returned?: unknown) =>
      ({
        path,
        body: { email, otp: '000000', type: 'sign-in' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: { returned },
      }) as never
    const email = address('limits')
    const ip = '203.0.113.31'
    // A sign-in code, then a reset code at once: it waits the cooldown (LIN-661) the two share.
    await limitSignIns(at(email, ip, '/email-otp/send-verification-otp'))
    await expect(limitSignIns(at(email, ip, '/email-otp/request-password-reset'))).rejects.toMatchObject({
      statusCode: 429,
    })
    await expect(limitSignIns(at(email, '198.51.100.31', '/email-otp/request-password-reset'))).resolves.toBeUndefined()

    const guessed = address('guesser')
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    for (let i = 0; i < 5; i++) await countSignInFailures(at(guessed, ip, '/email-otp/reset-password', wrong))
    for (let i = 0; i < 5; i++) await countSignInFailures(at(guessed, ip, '/sign-in/email-otp', wrong))
    await expect(limitSignIns(at(guessed, ip, '/email-otp/reset-password'))).rejects.toMatchObject({ statusCode: 429 })
    await expect(limitSignIns(at(guessed, ip, '/sign-in/email-otp'))).rejects.toMatchObject({ statusCode: 429 })
    // The owner, from their own address, still gets in.
    await expect(limitSignIns(at(guessed, '198.51.100.32', '/email-otp/reset-password'))).resolves.toBeUndefined()
  })

  test('wrong codes are capped per account across every IP too: 30 an hour, 150 a day, in the database (LIN-396)', async () => {
    const at = (email: string, ip: string, path: string, returned?: unknown) =>
      ({
        path,
        body: { email, otp: '000000' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: { returned },
      }) as never
    const email = await makeAccount('spread')
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    const ipOf = (i: number) => `198.18.${Math.floor(i / 250)}.${i % 250}`
    for (let i = 0; i < 29; i++) await countSignInFailures(at(email, ipOf(i), '/email-otp/reset-password', wrong))
    await expect(limitSignIns(at(email, '192.0.2.77', '/sign-in/email-otp'))).resolves.toBeUndefined()
    await countSignInFailures(at(email, ipOf(29), '/sign-in/email-otp', wrong))
    for (const path of ['/email-otp/reset-password', '/sign-in/email-otp'])
      await expect(limitSignIns(at(email, '192.0.2.77', path))).rejects.toMatchObject({ statusCode: 429 })
    // Another account is not touched.
    await expect(
      limitSignIns(at(await makeAccount('other'), '192.0.2.77', '/sign-in/email-otp')),
    ).resolves.toBeUndefined()
    // The next clock hour: the hourly cap lifts.
    await hoursAgo(email, 1)
    await expect(limitSignIns(at(email, '192.0.2.77', '/sign-in/email-otp'))).resolves.toBeUndefined()

    // The day: 150 wrong codes, even when each hour stays below 30.
    const daily = await makeAccount('daily')
    for (let i = 0; i < 149; i++) {
      if (i % 25 === 0) await hoursAgo(daily, 1) // a new hour
      await countSignInFailures(at(daily, ipOf(i), '/sign-in/email-otp', wrong))
    }
    await hoursAgo(daily, 1)
    await expect(limitSignIns(at(daily, '192.0.2.78', '/sign-in/email-otp'))).resolves.toBeUndefined()
    await countSignInFailures(at(daily, ipOf(149), '/sign-in/email-otp', wrong))
    await expect(limitSignIns(at(daily, '192.0.2.78', '/sign-in/email-otp'))).rejects.toMatchObject({ statusCode: 429 })
    // A day later every hour has fallen out of the window, and the next count drops the old rows.
    await hoursAgo(daily, 25)
    await expect(limitSignIns(at(daily, '192.0.2.78', '/sign-in/email-otp'))).resolves.toBeUndefined()
    await countSignInFailures(at(daily, ipOf(150), '/sign-in/email-otp', wrong))
    const rows = await db
      .select()
      .from(sign_in_counters)
      .where(eq(sign_in_counters.user_id, (await accountOf(daily))!.id))
    expect(rows.map(r => r.count)).toEqual([1])
  })

  test('an address without an account gets the same answer: 30 wrong codes an hour from any IP (LIN-396)', async () => {
    const at = (email: string, ip: string, returned?: unknown) =>
      ({
        path: '/sign-in/email-otp',
        body: { email, otp: '000000' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: { returned },
      }) as never
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    for (const email of [await makeAccount('known'), address('unknown')]) {
      for (let i = 0; i < 30; i++) await countSignInFailures(at(email, `198.18.9.${i}`, wrong))
      await expect(limitSignIns(at(email, '192.0.2.79'))).rejects.toMatchObject({ statusCode: 429 })
    }
  })

  test('an address without an account leaves no counter rows (LIN-396)', async () => {
    const at = (email: string, path: string, returned?: unknown) =>
      ({
        path,
        body: { email, otp: '000000', type: 'sign-in' },
        headers: new Headers({ [CLIENT_IP_HEADER]: randomIp() }),
        context: { returned },
      }) as never
    const nobody = address('nobody')
    await limitSignIns(at(nobody, '/email-otp/send-verification-otp'))
    await countSignInFailures(at(nobody, '/sign-in/email-otp', new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })))
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sign_in_counters} c join ${user} u on u.id = c.user_id where u.email = ${nobody}`,
    )
    expect(rows[0]!.n).toBe(0)
  })

  test('one network alone can not reach the caps across IPs: 10 codes and 20 wrong codes from it (LIN-396)', async () => {
    const at = (email: string, ip: string, path: string, returned?: unknown) =>
      ({
        path,
        body: { email, otp: '000000', type: 'sign-in' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: { returned },
      }) as never
    const email = await makeAccount('one-net')
    const ip = '203.0.113.41'
    let refused = 0
    for (let i = 0; i < 40; i++)
      await limitSignIns(at(email, ip, '/email-otp/send-verification-otp')).catch(() => refused++)
    expect(refused).toBe(39) // the cooldown between codes from one network (LIN-661)
    // The owner, from their own network, still gets a code.
    await expect(limitSignIns(at(email, '198.51.100.41', '/email-otp/send-verification-otp'))).resolves.toBeUndefined()

    const guessed = await makeAccount('one-net-guess')
    const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
    let guesses = 0
    for (let i = 0; i < 40; i++) {
      const allowed = await limitSignIns(at(guessed, ip, '/sign-in/email-otp')).then(
        () => true,
        () => false,
      )
      if (!allowed) continue
      guesses++
      await countSignInFailures(at(guessed, ip, '/sign-in/email-otp', wrong))
    }
    expect(guesses).toBe(10)
    await expect(limitSignIns(at(guessed, '198.51.100.42', '/sign-in/email-otp'))).resolves.toBeUndefined()
  })

  test('code requests are capped per address across every IP: 40 an hour (LIN-396)', async () => {
    const at = (email: string, ip: string) =>
      ({
        path: '/email-otp/send-verification-otp',
        body: { email, type: 'sign-in' },
        headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
        context: {},
      }) as never
    for (const email of [await makeAccount('flooded'), address('flooded-no-account')]) {
      for (let i = 0; i < 40; i++) await limitSignIns(at(email, randomIp()))
      await expect(limitSignIns(at(email, randomIp()))).rejects.toMatchObject({ statusCode: 429 })
    }
    // The account's cap holds in the database: it outlives the memory of this process.
    const kept = await makeAccount('flooded-kept')
    for (let i = 0; i < 40; i++) await limitSignIns(at(kept, randomIp()))
    // Summed: at the turn of a clock hour the 40 land in two rows.
    const rows = await db
      .select()
      .from(sign_in_counters)
      .where(and(eq(sign_in_counters.user_id, (await accountOf(kept))!.id), eq(sign_in_counters.kind, 'code_request')))
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(40)
  })
})

describe('accounts the reset must not open further', () => {
  test('an address nobody had proven: whatever got in before goes, only the new password stays (account linking)', async () => {
    const { codeFor } = mailbox()
    // Someone signed up with another person's address and a password, added a passkey and an API key.
    const email = address('squatted')
    const squatter = await signUp(email)
    const key = await addPasskeyRow(squatter.userId)
    const keyId = `ak_${crypto.randomUUID().slice(0, 12)}`
    await db.insert(api_keys).values({
      id: keyId,
      workspace_id: 'ws_none',
      name: 'squatter',
      prefix: 'ld_x',
      key_hash: `h-${keyId}`,
      created_by: squatter.userId,
    })
    expect(await accountOf(email)).toMatchObject({ emailVerified: false })

    // The owner of the mailbox resets the password.
    await requestReset(email)
    expect((await reset(email, await codeFor(email))).status).toBe(200)
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
    expect(await isSignedIn(squatter)).toBe(false)
    expect((await signIn(email, OLD_PASSWORD)).status).toBe(401)
    expect((await signIn(email, NEW_PASSWORD)).status).toBe(200)
    expect(await db.select().from(passkey).where(eq(passkey.id, key))).toHaveLength(0)
    const [revoked] = await db.select().from(api_keys).where(eq(api_keys.id, keyId))
    expect(revoked?.revoked_at).not.toBeNull()
  })

  test('an account with a passkey: passkeys stay, and the new sign-in still cannot change them (H1)', async () => {
    const { codeFor } = mailbox()
    const who = await member()
    const key = await addPasskeyRow(who.userId)
    await requestReset(who.email)
    expect((await reset(who.email, await codeFor(who.email))).status).toBe(200)
    expect(await db.select().from(passkey).where(eq(passkey.id, key))).toHaveLength(1)

    const fresh = await signIn(who.email, NEW_PASSWORD)
    expect(fresh.status).toBe(200)
    const headers = { origin: ORIGIN, [FROM]: randomIp() }
    expect(await request(fresh.caller, 'POST', '/api/auth/passkey/delete-passkey', { id: key }, headers)).toMatchObject(
      {
        status: 403,
        body: { code: PASSKEY_CONFIRMATION_REQUIRED },
      },
    )
    expect(
      await request(fresh.caller, 'GET', '/api/auth/passkey/generate-register-options', undefined, headers),
    ).toMatchObject({
      status: 403,
      body: { code: PASSKEY_CONFIRMATION_REQUIRED },
    })
    expect(await db.select().from(passkey).where(eq(passkey.id, key))).toHaveLength(1)
  })
})
