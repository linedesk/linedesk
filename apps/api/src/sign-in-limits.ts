// Limits on sign-in by email code and by password, on top of Better Auth's own limit per IP.
// Email codes are counted per address and IP, and only failures: someone else asking for codes or
// guessing them from their own address cannot lock a person out of their account. Wrong passwords
// count per address and IP, plus a much higher cap per address across every IP, so guesses spread
// over many IPs are limited too while one other network cannot pause someone's sign-in with a few
// tries; both locks lift by themselves once the window has passed. Codes get such caps per account
// across every IP as well, sized so one network alone can not reach them: code emails (40 in a clock
// hour; one network asks for at most 10), wrong codes (30 in a clock hour and 150 in a day; one
// network guesses at most 10 an hour and 20 a day). So a 6-digit code can not be guessed from many
// networks over weeks (150 a day: an even chance takes about 12 years) and an inbox can not be
// flooded with code emails. Those caps per account are kept in the database (sign_in_counters), so
// a restart, a second API process or a flood of other addresses does not reset them (LIN-396,
// LIN-410); only addresses of existing accounts are counted there, so its rows stay bounded. "IP" is
// the limit bucket of `addressBucket`: an IPv4 address or an IPv6 /64, so rotating through one's own
// /64 opens no new one.
//
// Anyone with enough networks can fill those caps across IPs for an address and so keep its owner out of code sign-in
// and password reset. A browser that signed in to that account before (known-browser.ts) is not held by them (LIN-442):
// it gets caps of its own of the same size instead, across IPs (in memory), and its code checks stop as well once the
// account's known browsers had 150 wrong codes in a day (in the database, `known_browser_failure`, so a restart or a
// flood of cookies does not lift it, and only requests with a valid cookie for the account add to it). So stolen
// cookies add at most as many guesses a day as the account's cap allows: at most 300 a day for an account (an even
// chance of guessing a code then takes about 6 years). The limits per address and IP still apply to it, and what it
// does still counts towards the address's and the account's caps (so it never lifts them for anyone else). Only a valid
// cookie for the account that has the address counts; any other request is answered exactly as before, so nothing
// tells whether an account exists.
import { CODE_COOLDOWN_RESET_MS, codeCooldownLeftMs } from '@linedesk/actions'
import { sign_in_counters, user } from '@linedesk/db'
import { APIError, type createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { addressBucket, CLIENT_IP_HEADER } from './client-ip.ts'
import { db } from './db.ts'
import { knownBrowserValues, verifyKnownBrowser } from './known-browser.ts'
import { createCooldown, createFailureLimiter, createRateLimiter } from './rate-limit.ts'
import { signupPageLinkPath } from './signup-gate.ts'

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/**
 * Per address and IP, the wait before the next code grows with each one (CODE_COOLDOWN_STEPS_S: 30 s, 2, 5, then 10 min;
 * LIN-661), so a person who did not get the email can always ask again, a little later each time. The caps below stay
 * as the outer bound; the cooldown keeps a person well under them.
 */
export const codeCooldown = createCooldown({ leftMs: codeCooldownLeftMs, keepMs: CODE_COOLDOWN_RESET_MS })
/** 5 codes in 10 minutes (a code's lifetime) and 10 in an hour per address and IP. */
const allowCode = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })
const allowCodeHourly = createRateLimiter({ max: 10, windowMs: 60 * 60_000 })
/**
 * 40 codes in an hour per address, from any IP: no flood of code emails from many networks. In memory for an address
 * without an account (the sign-up page's codes); an account's own cap is CODES_PER_HOUR in the database.
 */
const allowCodeAnywhere = createRateLimiter({ max: 40, windowMs: 60 * 60_000 })
/** 10 wrong codes in an hour and 20 in a day per address and IP, across codes (a new code starts its own 3 tries). */
export const codeFailures = createFailureLimiter({ max: 10, windowMs: 60 * 60_000 })
export const codeFailuresIpDaily = createFailureLimiter({ max: 20, windowMs: 24 * 60 * 60_000 })
/**
 * Per account, from any IP, in the database: 40 code emails in a clock hour, 30 wrong codes in a clock hour and 150 in
 * the last 24 (at least 4, 3 and 8 networks): guesses spread over many networks, as for passwords. While a cap holds,
 * that account signs in another way (password, passkey, a provider). A clock hour, not a sliding one: at most twice
 * the hourly cap around the turn of an hour, which the daily cap still bounds.
 *
 * The same caps in memory for every address, with or without an account: an address answers the same either way, so
 * the answer does not tell whether an account exists (LIN-264). The database ones hold on after a restart, in a second
 * API process and when a flood of other addresses pushed a key out of memory.
 */
export const codeFailuresAnywhere = createFailureLimiter({ max: 30, windowMs: 60 * 60_000 })
export const codeFailuresDaily = createFailureLimiter({ max: 150, windowMs: 24 * 60 * 60_000 })
export const CODES_PER_HOUR = 40
export const WRONG_CODES_PER_HOUR = 30
export const WRONG_CODES_PER_DAY = 150
/**
 * A known browser's own caps across IPs, in place of the address's and the account's (LIN-442): the same sizes, per
 * cookie (account and issue time). In memory: a cookie only comes from a sign-in, so nobody can make new ones to
 * rotate through.
 */
export const knownBrowserCodes = createRateLimiter({ max: 40, windowMs: 60 * 60_000 })
export const knownBrowserFailures = createFailureLimiter({ max: 30, windowMs: 60 * 60_000 })
export const knownBrowserFailuresDaily = createFailureLimiter({ max: 150, windowMs: 24 * 60 * 60_000 })
/**
 * Wrong codes from known browsers of an account in the last 24 hours at which every known browser's code checks for it
 * stop too (in the database, `known_browser_failure`).
 */
export const KNOWN_BROWSER_WRONG_CODES_PER_DAY = WRONG_CODES_PER_DAY
/** 10 wrong passwords in 15 minutes per address and IP. */
export const passwordFailures = createFailureLimiter({ max: 10, windowMs: 15 * 60_000 })
/** 100 wrong passwords in an hour per address, from any IP: guesses spread over many networks. */
export const passwordFailuresAnywhere = createFailureLimiter({ max: 100, windowMs: 60 * 60_000 })

/** The address a code is for: `newEmail` when an account moves to a new address (email-change.ts). */
const emailOf = (ctx: Ctx) => {
  const email = ctx.body?.email ?? ctx.body?.newEmail
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}
const ipOf = (ctx: Ctx) => ctx.headers?.get(CLIENT_IP_HEADER) ?? ctx.request?.headers.get(CLIENT_IP_HEADER) ?? null
/** A short key of fixed size, so memory per key stays small however long the address is. */
const keyOf = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 22)
/** The limiters' keys: per address, and per address and IP. */
export const addressKey = (email: string) => keyOf(email)
export const addressAndIpKey = (email: string, ip: string | null) => keyOf(`${email}|${addressBucket(ip)}`)
const address = (ctx: Ctx) => addressKey(emailOf(ctx))
const addressAndIp = (ctx: Ctx) => addressAndIpKey(emailOf(ctx), ipOf(ctx))
/** Only what can be an address is counted, so junk keys can not fill the limiters (Better Auth refuses the rest). */
const countable = (ctx: Ctx) => /^[^@\s]{1,64}@[^@\s]{1,253}$/.test(emailOf(ctx))

/**
 * The key of this browser's own caps when it carries a valid known-browser cookie for the account that has the
 * request's address; null otherwise (no cookie, a forged or expired one, one for another account or address). Only a
 * valid cookie leads to a database read, so a request without one takes as long as before (LIN-264).
 */
function knownBrowserOf(ctx: Ctx): Promise<string | null> {
  if (!countable(ctx)) return Promise.resolve(null)
  const headers = ctx.headers ?? ctx.request?.headers
  if (!headers) return Promise.resolve(null)
  // Once per request: the hooks before and after Better Auth's endpoint get the same headers.
  const cached = knownBrowserLookups.get(headers)
  if (cached?.email === emailOf(ctx)) return cached.key
  const key = lookUpKnownBrowser(headers.get('cookie'), emailOf(ctx))
  knownBrowserLookups.set(headers, { email: emailOf(ctx), key })
  return key
}
const knownBrowserLookups = new WeakMap<Headers, { email: string; key: Promise<string | null> }>()

/** Only the first value with a valid signature is looked up: one database read at most, however many a request sends. */
async function lookUpKnownBrowser(cookieHeader: string | null, email: string): Promise<string | null> {
  const known = knownBrowserValues(cookieHeader)
    .map(value => verifyKnownBrowser(value))
    .find(Boolean)
  if (!known) return null
  const [mine] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, known.userId), eq(user.email, email)))
    .limit(1)
  return mine ? keyOf(`known-browser|${known.userId}|${known.issuedAt}`) : null
}

/**
 * The database floor under a known browser's code checks: refused once the account's known browsers had
 * KNOWN_BROWSER_WRONG_CODES_PER_DAY wrong codes in the last 24 hours. The browser's own caps are in memory, so a
 * restart or a flood of other cookies (an attacker can sign in to their own account many times) resets them; this one
 * holds across those. Only wrong codes sent with a valid cookie for this account count here, so nobody without one can
 * fill it, however many networks they guess from in parallel. Not for code requests: none is needed there, a known
 * browser's codes go to the owner's own mailbox.
 */
async function knownBrowserFloorReached(email: string) {
  return (await accountCounts(email, 'known_browser_failure')).day >= KNOWN_BROWSER_WRONG_CODES_PER_DAY
}

const HOUR_MS = 60 * 60_000

type CounterKind = (typeof sign_in_counters.kind.enumValues)[number]

/**
 * The account's count of `kind` in this clock hour and in the last 24 (0 and 0 for an address without an account).
 * One query whether the account exists or not, so the answer takes as long either way (LIN-264).
 */
async function accountCounts(email: string, kind: CounterKind) {
  const result = await db.execute<{ hour: number; day: number }>(sql`
    select coalesce(sum(c.count) filter (where c.hour >= date_trunc('hour', now())), 0)::int as hour,
           coalesce(sum(c.count), 0)::int as day
    from ${user} u
    join ${sign_in_counters} c on c.user_id = u.id and c.kind = ${kind} and c.hour > now() - interval '24 hours'
    where u.email = ${email}`)
  return result.rows[0] ?? { hour: 0, day: 0 }
}

/**
 * Counts one `kind` for the account with this address (nothing for an address without one) and says how many it has
 * now in this clock hour: one statement, so parallel requests can not all slip under a cap. Drops that account's rows
 * older than a day on the way.
 */
async function countForAccount(email: string, kind: CounterKind): Promise<number> {
  // Not waiting for the write to reach the disk: a commit that wrote (an account) then takes as long as one that did
  // not (no account), so the time of the answer does not tell (LIN-264). A crash may lose a few counts.
  const result = await db.transaction(async tx => {
    await tx.execute(sql`set local synchronous_commit = off`)
    return tx.execute<{ count: number }>(sql`
    with account as (select id from ${user} where email = ${email}),
    expired as (
      delete from ${sign_in_counters}
      where user_id in (select id from account) and hour < now() - interval '25 hours'
    )
    insert into ${sign_in_counters} (user_id, kind, hour, count)
    select id, ${kind}, date_trunc('hour', now()), 1 from account
    on conflict (user_id, kind, hour) do update set count = ${sign_in_counters}.count + 1
    returning count`)
  })
  return result.rows[0]?.count ?? 0
}

/** Whether the account with this address had too many wrong codes, from any IP. */
async function tooManyWrongCodes(email: string) {
  const { hour, day } = await accountCounts(email, 'code_failure')
  return hour >= WRONG_CODES_PER_HOUR || day >= WRONG_CODES_PER_DAY
}

/**
 * Where a code is checked: signing in, confirming one's own address, setting a new password, moving the
 * account to a new address. Wrong ones count together.
 */
const isCodeCheck = (path: string) =>
  path === '/sign-in/email-otp' ||
  path === '/email-otp/verify-email' ||
  path === '/email-otp/reset-password' ||
  path === '/email-otp/change-email'

/** Where a code is sent: sign-in, confirmation, password reset and email change codes. They share one limit. */
const isCodeRequest = (path: string) =>
  path === '/email-otp/send-verification-otp' ||
  path === '/email-otp/request-password-reset' ||
  path === '/email-otp/request-email-change'

/**
 * A code that confirms the signed-in member's own address (`email-verification`, the in-app
 * "Confirm your email" prompt after a password sign-up): only for that session's address, and only
 * while it is unconfirmed. Nobody else can have such a code sent, or use one.
 *
 * This is the only guard on `/email-otp/verify-email` now: Better Auth drops no unproven access there, and the
 * hooks that did were removed with the email links (#750). Keep it in `limitSignIns` (and its test in
 * email-confirmation.test.ts) when refactoring.
 */
async function refuseForeignConfirmation(ctx: Ctx) {
  const current = await getSessionFromCtx(ctx).catch(() => null)
  if (!current || current.user.email.toLowerCase() !== emailOf(ctx) || current.user.emailVerified)
    throw new APIError('FORBIDDEN', { code: 'NOT_YOUR_ADDRESS', message: 'Sign in with this address to confirm it.' })
}

/**
 * Before Better Auth's endpoints: a refused request creates no code and leaves the current one (and
 * its tries) as it is. Sign-in codes, confirmation codes for the session's own address, and password
 * reset codes (password-reset.ts).
 */
export async function limitSignIns(ctx: Ctx) {
  const known = isCodeCheck(ctx.path) || isCodeRequest(ctx.path) ? await knownBrowserOf(ctx) : null
  if (
    isCodeCheck(ctx.path) &&
    (codeFailures.blocked(addressAndIp(ctx)) ||
      codeFailuresIpDaily.blocked(addressAndIp(ctx)) ||
      (known
        ? knownBrowserFailures.blocked(known) ||
          knownBrowserFailuresDaily.blocked(known) ||
          (await knownBrowserFloorReached(emailOf(ctx)))
        : codeFailuresAnywhere.blocked(address(ctx)) ||
          codeFailuresDaily.blocked(address(ctx)) ||
          (countable(ctx) && (await tooManyWrongCodes(emailOf(ctx))))))
  )
    throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many wrong codes. Try again later.' })
  if (ctx.path === '/email-otp/verify-email') await refuseForeignConfirmation(ctx)
  if (ctx.path === '/email-otp/send-verification-otp') {
    if (ctx.body?.type === 'email-verification') await refuseForeignConfirmation(ctx)
    else if (ctx.body?.type !== 'sign-in')
      throw new APIError('BAD_REQUEST', { message: 'Only sign-in and confirmation codes are offered.' })
  }
  if (isCodeRequest(ctx.path)) {
    const now = Date.now()
    // `retryAfter` (seconds) in the body and Retry-After: the page says when a new code can be asked for (LIN-661).
    const tooMany = (freeAt: number) => {
      const retryAfter = Math.max(1, Math.ceil((freeAt - now) / 1000))
      return new APIError(
        'TOO_MANY_REQUESTS',
        { code: 'CODE_COOLDOWN', message: 'Too many codes for this email. Try again in a few minutes.', retryAfter },
        { 'Retry-After': String(retryAfter) },
      )
    }
    // The caps across IPs are per sliding hour in memory and per clock hour in the database (an account only): the
    // later of the two for every address, so the wait said does not tell whether an account exists.
    const anywhereFreeAt = () =>
      Math.max(
        known ? knownBrowserCodes.freeAt(known, now) : allowCodeAnywhere.freeAt(address(ctx), now),
        Math.ceil((now + 1) / HOUR_MS) * HOUR_MS,
      )
    // The sign-up page's own send keeps its own cooldown, in the database (self-serve.ts admitSignupCode).
    const cooldownLeft = signupPageLinkPath() === null ? codeCooldown.left(addressAndIp(ctx), now) : 0
    if (cooldownLeft > 0) throw tooMany(now + cooldownLeft)
    if (allowCode.full(addressAndIp(ctx), now) || allowCodeHourly.full(addressAndIp(ctx), now))
      throw tooMany(Math.max(allowCode.freeAt(addressAndIp(ctx), now), allowCodeHourly.freeAt(addressAndIp(ctx), now)))
    if (known ? knownBrowserCodes.full(known, now) : allowCodeAnywhere.full(address(ctx), now))
      throw tooMany(anywhereFreeAt())
    if (countable(ctx)) {
      // Checked and counted in one step before anything waits, so parallel requests can not all slip under a cap. The
      // account's count too: one refused there counts, which keeps the account at its cap until the hour turns. A known
      // browser's code counts there as well, but only its own cap refuses it.
      codeCooldown.hit(addressAndIp(ctx), now)
      allowCode(addressAndIp(ctx), now)
      allowCodeHourly(addressAndIp(ctx), now)
      allowCodeAnywhere(address(ctx), now)
      if (known) knownBrowserCodes(known, now)
      if ((await countForAccount(emailOf(ctx), 'code_request')) > CODES_PER_HOUR && !known)
        throw tooMany(anywhereFreeAt())
    }
  }
  if (
    ctx.path === '/sign-in/email' &&
    (passwordFailures.blocked(addressAndIp(ctx)) || passwordFailuresAnywhere.blocked(address(ctx)))
  )
    throw new APIError('TOO_MANY_REQUESTS', {
      message: 'Too many wrong passwords for this email. Try again in a few minutes.',
    })
}

/**
 * A refused code, counted per address and IP and per account (also where one is refused before Better Auth checks it),
 * and for a known browser against its own caps too.
 */
export async function countWrongCode(ctx: Ctx) {
  if (!countable(ctx)) return
  codeFailures.fail(addressAndIp(ctx))
  codeFailuresIpDaily.fail(addressAndIp(ctx))
  codeFailuresAnywhere.fail(address(ctx))
  codeFailuresDaily.fail(address(ctx))
  const known = await knownBrowserOf(ctx)
  if (known) {
    knownBrowserFailures.fail(known)
    knownBrowserFailuresDaily.fail(known)
    await countForAccount(emailOf(ctx), 'known_browser_failure')
  }
  await countForAccount(emailOf(ctx), 'code_failure')
}

/** After Better Auth's endpoints: a refused code or password counts (a 429 does not). */
export async function countSignInFailures(ctx: Ctx) {
  const returned = ctx.context.returned
  if (!isAPIError(returned) || returned.statusCode === 429) return
  if (isCodeCheck(ctx.path)) await countWrongCode(ctx)
  if (ctx.path === '/sign-in/email') {
    passwordFailures.fail(addressAndIp(ctx))
    passwordFailuresAnywhere.fail(address(ctx))
  }
}
