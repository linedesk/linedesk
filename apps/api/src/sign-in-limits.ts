// Limits on sign-in by email code and by password, on top of Better Auth's own limit per IP.
// Email codes are counted per address and IP, and only failures: someone else asking for codes or
// guessing them from their own address cannot lock a person out of their account. Wrong passwords
// count per address and IP, plus a much higher cap per address across every IP, so guesses spread
// over many IPs are limited too while one other network cannot pause someone's sign-in with a few
// tries; both locks lift by themselves once the window has passed. "IP" is the limit bucket of
// `addressBucket`: an IPv4 address or an IPv6 /64, so rotating through one's own /64 opens no new one.
import { APIError, type createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { addressBucket, CLIENT_IP_HEADER } from './client-ip.ts'
import { createFailureLimiter, createRateLimiter } from './rate-limit.ts'

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/** 5 codes in 10 minutes (a code's lifetime) per address and IP. */
const allowCode = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })
/** 10 wrong codes in an hour per address and IP, across codes (a new code starts its own 3 tries). */
export const codeFailures = createFailureLimiter({ max: 10, windowMs: 60 * 60_000 })
/** 10 wrong passwords in 15 minutes per address and IP. */
export const passwordFailures = createFailureLimiter({ max: 10, windowMs: 15 * 60_000 })
/** 100 wrong passwords in an hour per address, from any IP: guesses spread over many networks. */
export const passwordFailuresAnywhere = createFailureLimiter({ max: 100, windowMs: 60 * 60_000 })

const emailOf = (ctx: Ctx) => (typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '')
const ipOf = (ctx: Ctx) => ctx.headers?.get(CLIENT_IP_HEADER) ?? ctx.request?.headers.get(CLIENT_IP_HEADER) ?? null
const addressAndIp = (ctx: Ctx) => `${emailOf(ctx)}|${addressBucket(ipOf(ctx))}`

/** Where a code is checked: signing in with one, and confirming one's own address with one. Wrong ones count together. */
const isCodeCheck = (path: string) => path === '/sign-in/email-otp' || path === '/email-otp/verify-email'

/**
 * A code that confirms the signed-in member's own address (`email-verification`, the in-app
 * "Confirm your email" prompt after a password sign-up): only for that session's address, and only
 * while it is unconfirmed. Nobody else can have such a code sent, or use one.
 */
async function refuseForeignConfirmation(ctx: Ctx) {
  const current = await getSessionFromCtx(ctx).catch(() => null)
  if (!current || current.user.email.toLowerCase() !== emailOf(ctx) || current.user.emailVerified)
    throw new APIError('FORBIDDEN', { code: 'NOT_YOUR_ADDRESS', message: 'Sign in with this address to confirm it.' })
}

/**
 * Before Better Auth's endpoints: a refused request creates no code and leaves the current one (and
 * its tries) as it is. Sign-in codes, and confirmation codes for the session's own address.
 */
export async function limitSignIns(ctx: Ctx) {
  if (isCodeCheck(ctx.path) && codeFailures.blocked(addressAndIp(ctx)))
    throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many wrong codes. Try again later.' })
  if (ctx.path === '/email-otp/verify-email') await refuseForeignConfirmation(ctx)
  if (ctx.path === '/email-otp/send-verification-otp') {
    if (ctx.body?.type === 'email-verification') await refuseForeignConfirmation(ctx)
    else if (ctx.body?.type !== 'sign-in')
      throw new APIError('BAD_REQUEST', { message: 'Only sign-in and confirmation codes are offered.' })
    if (!allowCode(addressAndIp(ctx)))
      throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes for this email. Try again in a few minutes.' })
  }
  if (
    ctx.path === '/sign-in/email' &&
    (passwordFailures.blocked(addressAndIp(ctx)) || passwordFailuresAnywhere.blocked(emailOf(ctx)))
  )
    throw new APIError('TOO_MANY_REQUESTS', {
      message: 'Too many wrong passwords for this email. Try again in a few minutes.',
    })
}

/** After Better Auth's endpoints: a refused code or password counts (a 429 does not). */
export async function countSignInFailures(ctx: Ctx) {
  const returned = ctx.context.returned
  if (!isAPIError(returned) || returned.statusCode === 429) return
  if (isCodeCheck(ctx.path)) codeFailures.fail(addressAndIp(ctx))
  if (ctx.path === '/sign-in/email') {
    passwordFailures.fail(addressAndIp(ctx))
    passwordFailuresAnywhere.fail(emailOf(ctx))
  }
}
