// Resend over its HTTPS API (api.resend.com, port 443) instead of SMTP: many hosts (DigitalOcean, most clouds) block
// outgoing SMTP ports, never 443. email.ts sends with it when the install's connection is Resend's (email-services.ts);
// the provider test (provider-test.ts) checks the key with it. Resend's own error text is only matched against a few
// fixed phrases, never passed on: it can quote addresses. The key never appears in a message.
import { createHash } from 'node:crypto'
import type { ProviderFailureReason } from '@linedesk/actions'
import { type MessageKey, msg, SOURCE } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'

export const RESEND_API = 'https://api.resend.com'
const HOST = 'api.resend.com'

/** One email as Resend's POST /emails takes it. */
export type ResendEmail = {
  from: string
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  headers?: Record<string, string>
  /**
   * What makes a second try the same email: the job's id when a job sends it (email.ts withEmailJob). With it the
   * request carries an Idempotency-Key, so a retry after a timeout that Resend had accepted does not send it twice.
   */
  retryScope?: string
}

/**
 * The Idempotency-Key of an email (https://resend.com/docs/dashboard/emails/idempotency-keys): Resend keeps it 24 hours
 * and answers a repeat with the same body by the first answer, without sending again. It covers the body too: a retry
 * whose text changed (rendered again) gets its own key instead of a 409 for a reused key with another body (L-3).
 */
export const idempotencyKeyOf = (retryScope: string, body: string) =>
  `linedesk-${createHash('sha256').update(retryScope).update('\n').update(body).digest('hex')}`

type Params = Record<string, string | number>
const english = (key: MessageKey, params?: Params) => getT(SOURCE).t(key, params)

/**
 * A failed call to Resend, with what it means for the mail service (null: about this one email, not the service).
 * The message is the English of `key` and `params`, which the provider test hands on for the reader's language.
 */
export class ResendError extends Error {
  readonly reason: ProviderFailureReason | null
  readonly key: MessageKey
  readonly params: Params

  constructor(reason: ProviderFailureReason | null, key: MessageKey, params: Params) {
    super(english(key, params))
    this.name = 'ResendError'
    this.reason = reason
    this.key = key
    this.params = params
  }
}

/** Resend's error answer: `{ statusCode, name, message }`. */
async function errorBody(res: Response): Promise<{ name: string; message: string }> {
  const body = (await res.json().catch(() => null)) as { name?: unknown; message?: unknown } | null
  return {
    name: typeof body?.name === 'string' ? body.name : '',
    message: typeof body?.message === 'string' ? body.message : '',
  }
}

/** Key errors (https://resend.com/docs/api-reference/errors): the key is missing, wrong, revoked or suspended. */
const KEY_REFUSED = new Set(['missing_api_key', 'invalid_api_key', 'suspended_api_key'])

/**
 * The two 403s about the install's sending setup rather than one email: the From domain is not verified ("The
 * example.com domain is not verified"), or the account may only send test emails to its owner ("You can only send
 * testing emails to your own email address"). Any other 403 is about this email (security review of #1325, L-1).
 */
const SENDER_REFUSED = /\bdomain is not verified\b|\btesting emails\b/i

/**
 * What a refused answer of Resend means, in fixed words that name the fix. A reason only when the mail service itself
 * is affected (key, sending setup, quota, Resend down): a reason marks the install's email as failing and alerts the
 * admins, so one bad email (a recipient Resend refuses, a 422 validation error) never gets one (L-1).
 */
export async function resendProblem(res: Response): Promise<ResendError> {
  const status = res.status
  const { name, message } = await errorBody(res)
  const fail = (reason: ProviderFailureReason | null, key: MessageKey) => new ResendError(reason, key, { status })
  const keyRefused = () => fail('auth', msg('server.api.email.resend.keyRefused'))
  // 401 restricted_api_key: a sending-only key asked for more. 403 restricted_api_key: "API key is not active".
  if (name === 'restricted_api_key')
    return status === 401 ? fail('permission', msg('server.api.email.resend.keyRestricted')) : keyRefused()
  if (name === 'invalid_permission') return fail('permission', msg('server.api.email.resend.keyRestricted'))
  if (status === 401 || KEY_REFUSED.has(name)) return keyRefused()
  // 400 validation_error "API key is invalid": a key error, not one about this email.
  if (status === 400 && name === 'validation_error' && /\bapi key\b/i.test(message)) return keyRefused()
  if (status === 403 && SENDER_REFUSED.test(message))
    return fail('config', msg('server.api.email.resend.senderRefused'))
  // 422 only by Resend's error name, never its free text: validation_error (a bad recipient) is about this email.
  if (status === 422 && name === 'invalid_from_address')
    return fail('config', msg('server.api.email.resend.senderRefused'))
  if (status === 429)
    return /quota/i.test(`${name} ${message}`)
      ? fail('quota', msg('server.api.email.resend.quota'))
      : fail('network', msg('server.api.email.resend.rateLimited'))
  if (status >= 500) return fail('network', msg('server.api.email.resend.failed'))
  // Anything else is about this email (an address Resend does not take, an idempotency conflict), not the service.
  return fail(null, msg('server.api.email.resend.notAccepted'))
}

/** An error code that may appear in a message: a fixed code like ECONNREFUSED, never free text (L-2). */
const ERROR_CODE = /^[A-Z0-9_]{1,40}$/

/** A request that never got an answer (timeout, blocked port, DNS), in words that name the fix. */
function unreachable(e: unknown, ms: number): ResendError {
  const name = e instanceof Error ? e.name : ''
  if (name === 'TimeoutError' || name === 'AbortError')
    return new ResendError('network', msg('server.api.email.resend.timeout'), { seconds: ms / 1000 })
  const cause = (e as { cause?: { code?: unknown } }).cause
  const code = typeof cause?.code === 'string' && ERROR_CODE.test(cause.code) ? cause.code : 'error'
  return new ResendError('network', msg('server.api.email.resend.unreachable'), { error: code })
}

async function call(
  key: string,
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
  ms: number,
  doFetch: typeof fetch,
) {
  try {
    return await doFetch(`${RESEND_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(ms),
    })
  } catch (e) {
    throw unreachable(e, ms)
  }
}

/** Sends one email (POST /emails). Throws a ResendError when Resend does not take it. */
export async function resendSend(key: string, email: ResendEmail, ms: number, doFetch: typeof fetch = fetch) {
  const body = JSON.stringify({
    from: email.from,
    to: [email.to],
    subject: email.subject,
    text: email.text,
    ...(email.html ? { html: email.html } : {}),
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    ...(email.headers && Object.keys(email.headers).length ? { headers: email.headers } : {}),
  })
  const headers = email.retryScope ? { 'idempotency-key': idempotencyKeyOf(email.retryScope, body) } : undefined
  const res = await call(key, '/emails', { method: 'POST', body, headers }, ms, doFetch)
  if (!res.ok) throw await resendProblem(res)
  await res.body?.cancel().catch(() => {})
}

/** A domain of the account as GET /domains lists it. */
export type ResendDomainEntry = { name?: unknown; status?: unknown }

/**
 * Whether the key works, without sending anything (GET /domains). A key with sending access only may not list the
 * domains (401 restricted_api_key): that still proves the key, and `domains` is null. Throws a ResendError otherwise.
 */
export async function resendKeyCheck(
  key: string,
  ms: number,
  doFetch: typeof fetch = fetch,
): Promise<{ domains: ResendDomainEntry[] | null }> {
  const res = await call(key, '/domains', { method: 'GET' }, ms, doFetch)
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    return { domains: Array.isArray(body?.data) ? (body.data as ResendDomainEntry[]) : [] }
  }
  const problem = await resendProblem(res)
  if (problem.reason === 'permission') return { domains: null }
  throw problem
}

/** The admin overview's line for a working Resend connection. */
export const resendSendsText = () => english(msg('server.api.email.resend.sends'), { host: HOST })
