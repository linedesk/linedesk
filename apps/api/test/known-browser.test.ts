// A browser that signed in to an account before is not held by the code caps across IPs (LIN-442): anyone with enough
// networks can fill those for an address. It gets caps of its own instead, and the limits per address and IP still
// apply. Any other request is answered as before, with or without an account (LIN-264).
import { session, sign_in_counters, user } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { KNOWN_BROWSER_DAYS, signKnownBrowser, verifyKnownBrowser } from '../src/known-browser.ts'
import {
  codeFailuresAnywhere,
  codeFailuresDaily,
  countSignInFailures,
  KNOWN_BROWSER_WRONG_CODES_PER_DAY,
  limitSignIns,
} from '../src/sign-in-limits.ts'
import { appRequest, FROM, randomIp, request, signUp } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const wrong = new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })
const ipOf = (i: number) => `198.19.${Math.floor(i / 250)}.${i % 250}`

afterEach(() => {
  vi.restoreAllMocks()
})

/** A bare account row: its id and address. */
async function makeAccount(prefix: string) {
  const email = address(prefix)
  const id = crypto.randomUUID()
  await db.insert(user).values({ id, name: 'Test User', email })
  return { id, email }
}

/** A Better Auth hook context for the limits, as from a browser with these cookies. */
const at = (
  path: string,
  email: string,
  ip: string,
  { cookie, returned }: { cookie?: string | null; returned?: unknown } = {},
) =>
  ({
    path,
    body: { email, otp: '000000', type: 'sign-in' },
    headers: new Headers({ [CLIENT_IP_HEADER]: ip, ...(cookie ? { cookie } : {}) }),
    context: { returned },
  }) as never

const CHECK = '/sign-in/email-otp'
const REQUEST = '/email-otp/send-verification-otp'
const knownCookie = (userId: string, nowMs = Date.now()) => `known_browser=${signKnownBrowser(userId, nowMs)}`

/** Whether the limits let this request through; the refusal as status and message. */
const outcome = (ctx: never) =>
  limitSignIns(ctx).then(
    () => 'allowed',
    (e: APIError) => `${e.statusCode} ${e.message}`,
  )

/** 30 wrong codes for the address from 30 networks: the hourly cap across IPs (memory and database). */
async function fillWrongCodes(email: string) {
  for (let i = 0; i < 30; i++) await countSignInFailures(at(CHECK, email, ipOf(i), { returned: wrong }))
}

describe('a known browser and the caps across IPs', () => {
  test('passes the wrong-code cap across IPs that holds everyone else, also when only the database holds it', async () => {
    const { id, email } = await makeAccount('known')
    await fillWrongCodes(email)
    expect(await outcome(at(CHECK, email, '192.0.2.10'))).toBe('429 Too many wrong codes. Try again later.')
    expect(await outcome(at(CHECK, email, '192.0.2.10', { cookie: knownCookie(id) }))).toBe('allowed')
    // As after a restart: only the database's cap is left.
    codeFailuresAnywhere.clear()
    codeFailuresDaily.clear()
    expect(await outcome(at(CHECK, email, '192.0.2.10'))).toMatch(/^429/)
    expect(await outcome(at(CHECK, email, '192.0.2.10', { cookie: knownCookie(id) }))).toBe('allowed')
    // Password reset uses the same limits.
    expect(await outcome(at('/email-otp/reset-password', email, '192.0.2.10', { cookie: knownCookie(id) }))).toBe(
      'allowed',
    )
  })

  test('passes the code-request cap across IPs (40 an hour), memory and database', async () => {
    const { id, email } = await makeAccount('flooded')
    for (let i = 0; i < 40; i++) await limitSignIns(at(REQUEST, email, ipOf(i)))
    expect(await outcome(at(REQUEST, email, '192.0.2.11'))).toMatch(/^429/)
    expect(await outcome(at(REQUEST, email, '192.0.2.11', { cookie: knownCookie(id) }))).toBe('allowed')
    expect(
      await outcome(at('/email-otp/request-password-reset', email, '192.0.2.12', { cookie: knownCookie(id) })),
    ).toBe('allowed')
  })

  test('a cookie for another account, or for an address that is not the account’s, does not help', async () => {
    const victim = await makeAccount('victim')
    const other = await makeAccount('other')
    await fillWrongCodes(victim.email)
    expect(await outcome(at(CHECK, victim.email, '192.0.2.13', { cookie: knownCookie(other.id) }))).toMatch(/^429/)
    // An address without an account, with a valid cookie of some account: as without a cookie.
    const nobody = address('nobody')
    await fillWrongCodes(nobody)
    expect(await outcome(at(CHECK, nobody, '192.0.2.13', { cookie: knownCookie(other.id) }))).toMatch(/^429/)
  })

  test('a forged, foreign or expired cookie does not help', async () => {
    const { id, email } = await makeAccount('forged')
    await fillWrongCodes(email)
    const real = signKnownBrowser(id)!
    const [, signature] = real.split('.')
    const later = Buffer.from(JSON.stringify({ u: id, t: Date.now() + 1000 })).toString('base64url')
    const expired = signKnownBrowser(id, Date.now() - KNOWN_BROWSER_DAYS * 24 * 60 * 60_000 - 1000)!
    const foreign = signKnownBrowser(id, Date.now(), { BETTER_AUTH_SECRET: 'not-this-servers-secret-0000000' })!
    for (const value of [`${later}.${signature}`, expired, foreign, `${real}x`, 'junk'])
      expect(await outcome(at(CHECK, email, '192.0.2.14', { cookie: `known_browser=${value}` }))).toMatch(/^429/)
  })

  test('the limits per address and IP still apply to a known browser', async () => {
    const { id, email } = await makeAccount('per-ip')
    const cookie = knownCookie(id)
    const ip = '203.0.113.60'
    for (let i = 0; i < 10; i++) await countSignInFailures(at(CHECK, email, ip, { cookie, returned: wrong }))
    expect(await outcome(at(CHECK, email, ip, { cookie }))).toMatch(/^429/)
    expect(await outcome(at(CHECK, email, '203.0.113.61', { cookie }))).toBe('allowed')
    // Codes: 5 in 10 minutes from one network.
    const asker = await makeAccount('per-ip-codes')
    const askerCookie = knownCookie(asker.id)
    for (let i = 0; i < 5; i++) await limitSignIns(at(REQUEST, asker.email, ip, { cookie: askerCookie }))
    expect(await outcome(at(REQUEST, asker.email, ip, { cookie: askerCookie }))).toMatch(/^429/)
  })

  test('a known browser has caps of its own across IPs, so a stolen cookie guesses no faster (30 an hour)', async () => {
    const { id, email } = await makeAccount('stolen')
    const cookie = knownCookie(id)
    for (let i = 0; i < 30; i++) await countSignInFailures(at(CHECK, email, ipOf(i), { cookie, returned: wrong }))
    expect(await outcome(at(CHECK, email, '192.0.2.15', { cookie }))).toMatch(/^429/)
    // Its failures still count for the account, in the database too.
    expect(await outcome(at(CHECK, email, '192.0.2.15'))).toMatch(/^429/)
    const rows = await db
      .select()
      .from(sign_in_counters)
      .where(and(eq(sign_in_counters.user_id, id), eq(sign_in_counters.kind, 'code_failure')))
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(30)
    // The same browser after a new sign-in (a new cookie) is a new one; another browser of the owner gets in too.
    expect(await outcome(at(CHECK, email, '192.0.2.15', { cookie: knownCookie(id, Date.now() + 1) }))).toBe('allowed')
  })

  test('a known browser’s code checks stop at 150 known-browser wrong codes a day for the account, in the database', async () => {
    const { id, email } = await makeAccount('floor')
    const cookie = knownCookie(id)
    // Counts of earlier hours, as from many networks (the memory of this process knows none).
    const setCount = (kind: 'code_failure' | 'known_browser_failure', count: number) =>
      db
        .insert(sign_in_counters)
        .values({ user_id: id, kind, hour: sql`date_trunc('hour', now()) - interval '3 hours'`, count })
        .onConflictDoUpdate({
          target: [sign_in_counters.user_id, sign_in_counters.kind, sign_in_counters.hour],
          set: { count },
        })
    expect(KNOWN_BROWSER_WRONG_CODES_PER_DAY).toBe(150)
    // Wrong codes without a cookie, far beyond any cap (as parallel guesses from many networks can push them): they
    // stop everyone else, never the known browser.
    await setCount('code_failure', 1000)
    expect(await outcome(at(CHECK, email, '192.0.2.17'))).toMatch(/^429/)
    expect(await outcome(at(CHECK, email, '192.0.2.17', { cookie }))).toBe('allowed')
    // Wrong codes from known browsers of the account: 149 still let it in, 150 stop it, also for a password reset.
    await setCount('known_browser_failure', 149)
    expect(await outcome(at(CHECK, email, '192.0.2.17', { cookie }))).toBe('allowed')
    await setCount('known_browser_failure', 150)
    expect(await outcome(at(CHECK, email, '192.0.2.17', { cookie }))).toBe('429 Too many wrong codes. Try again later.')
    expect(await outcome(at('/email-otp/reset-password', email, '192.0.2.17', { cookie }))).toMatch(/^429/)
    // Another cookie of the same account (another browser, or a new sign-in) is stopped too: the floor is the account's.
    expect(await outcome(at(CHECK, email, '192.0.2.17', { cookie: knownCookie(id, Date.now() + 1) }))).toMatch(/^429/)
    // Asking for a code is not held by it.
    expect(await outcome(at(REQUEST, email, '192.0.2.17', { cookie }))).toBe('allowed')
  })

  test('only a wrong code sent with a valid cookie for the account counts as a known browser’s', async () => {
    const { id, email } = await makeAccount('floor-count')
    const other = await makeAccount('floor-count-other')
    const countOf = async (kind: 'code_failure' | 'known_browser_failure') =>
      (
        await db
          .select()
          .from(sign_in_counters)
          .where(and(eq(sign_in_counters.user_id, id), eq(sign_in_counters.kind, kind)))
      ).reduce((sum, row) => sum + row.count, 0)
    await countSignInFailures(at(CHECK, email, ipOf(0), { returned: wrong }))
    await countSignInFailures(at(CHECK, email, ipOf(1), { cookie: knownCookie(other.id), returned: wrong }))
    await countSignInFailures(at(CHECK, email, ipOf(2), { cookie: 'known_browser=junk', returned: wrong }))
    expect(await countOf('code_failure')).toBe(3)
    expect(await countOf('known_browser_failure')).toBe(0)
    await countSignInFailures(at(CHECK, email, ipOf(3), { cookie: knownCookie(id), returned: wrong }))
    expect(await countOf('code_failure')).toBe(4)
    expect(await countOf('known_browser_failure')).toBe(1)
  })

  test('only one cookie value is looked up, however many a request sends', async () => {
    const { id, email } = await makeAccount('many-cookies')
    await fillWrongCodes(email)
    // The first value of the name is not this account's: the others are not tried.
    const other = await makeAccount('many-cookies-other')
    const cookie = [knownCookie(other.id), knownCookie(id)].join('; ')
    expect(await outcome(at(CHECK, email, '192.0.2.18', { cookie }))).toMatch(/^429/)
    // An invalid first value is skipped for a valid one under the other name.
    const both = `known_browser=junk; __Host-${knownCookie(id)}`
    expect(await outcome(at(CHECK, email, '192.0.2.18', { cookie: both }))).toBe('allowed')
  })

  test('without a cookie, an address with and without an account get the same refusal', async () => {
    const known = await makeAccount('same-answer')
    const nobody = address('same-answer-nobody')
    const answers = []
    for (const email of [known.email, nobody]) {
      await fillWrongCodes(email)
      answers.push(await outcome(at(CHECK, email, '192.0.2.16')))
      for (let i = 0; i < 40; i++) await limitSignIns(at(REQUEST, email, ipOf(i)))
      answers.push(await outcome(at(REQUEST, email, '192.0.2.16')))
    }
    expect(answers[0]).toMatch(/^429/)
    expect(answers[1]).toMatch(/^429/)
    expect(answers.slice(2)).toEqual(answers.slice(0, 2))
  })
})

describe('the cookie at sign-in', () => {
  const cookieOf = (setCookies: string[]) =>
    setCookies
      .find(c => /^(__Host-)?known_browser=/.test(c))
      ?.split(';')[0]
      ?.split('=')[1] ?? null

  test('a sign-in sets it for that account; a refused one does not', async () => {
    const who = await signUp()
    const ok = await appRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ email: await emailOf(who.userId), password: 'test-password-1234' }),
    })
    expect(ok.status).toBe(200)
    const set = ok.headers.getSetCookie().find(c => /^(__Host-)?known_browser=/.test(c))!
    expect(set).toMatch(/HttpOnly/i)
    expect(set).toMatch(/SameSite=Lax/i)
    expect(set).toMatch(/Max-Age=7776000/)
    expect(verifyKnownBrowser(cookieOf(ok.headers.getSetCookie()))?.userId).toBe(who.userId)

    const refused = await appRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ email: await emailOf(who.userId), password: 'not-the-password' }),
    })
    expect(refused.status).toBe(401)
    expect(cookieOf(refused.headers.getSetCookie())).toBeNull()
  })

  test('a session refresh sets it, but never for an admin signed in as the user', async () => {
    const refresh = async (impersonatedBy: string | null) => {
      const who = await signUp()
      // Two days old: get-session renews it (and sets its cookie again).
      await db
        .update(session)
        .set({ impersonatedBy, expiresAt: new Date(Date.now() + 28 * 24 * 60 * 60_000) })
        .where(eq(session.userId, who.userId))
      const sessionOnly = (who.headers.cookie ?? '')
        .split('; ')
        .filter(c => !/^(__Host-)?known_browser=/.test(c))
        .join('; ')
      const res = await appRequest('/api/auth/get-session', {
        headers: { cookie: sessionOnly, origin: ORIGIN, [FROM]: randomIp() },
      })
      expect(res.status).toBe(200)
      const renewed = res.headers.getSetCookie().some(c => c.includes('session_token='))
      return { who, renewed, value: cookieOf(res.headers.getSetCookie()) }
    }
    const own = await refresh(null)
    expect(own.renewed).toBe(true)
    expect(verifyKnownBrowser(own.value)?.userId).toBe(own.who.userId)
    const admin = await signUp()
    const impersonated = await refresh(admin.userId)
    expect(impersonated.renewed).toBe(true)
    expect(impersonated.value).toBeNull()
  })

  test('the browser that signed in still gets a code while the account is at its cap; another does not', async () => {
    vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const who = await signUp()
    const email = await emailOf(who.userId)
    for (let i = 0; i < 40; i++) await limitSignIns(at(REQUEST, email, ipOf(i)))
    const ask = (headers: Record<string, string>) =>
      request(
        { headers },
        'POST',
        '/api/auth/email-otp/send-verification-otp',
        { email, type: 'sign-in' },
        { origin: ORIGIN, [FROM]: randomIp() },
      )
    expect((await ask({})).status).toBe(429)
    // Only the known-browser cookie of the signed-in browser, not its session.
    const known = (who.headers.cookie ?? '').split('; ').find(c => /^(__Host-)?known_browser=/.test(c))!
    expect(known).toBeDefined()
    expect((await ask({ cookie: known })).status).toBe(200)
  })
})

async function emailOf(userId: string) {
  return (await db.select({ email: user.email }).from(user).where(eq(user.id, userId)))[0]!.email
}
