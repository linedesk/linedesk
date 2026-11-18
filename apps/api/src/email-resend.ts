// Resend over its HTTPS API (api.resend.com, port 443) instead of SMTP: many hosts (DigitalOcean, most clouds) block
// outgoing SMTP ports, never 443. email.ts sends with it when the install's connection is Resend's (email-services.ts);
// the provider test (provider-test.ts) checks the key with it. Resend's own error text is only searched for its
// error names, never passed on: it can quote addresses. The key never appears in a message.
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
}

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

/** What a refused answer of Resend means, in fixed words that name the fix. */
export async function resendProblem(res: Response): Promise<ResendError> {
  const status = res.status
  const { name, message } = await errorBody(res)
  const fail = (reason: ProviderFailureReason | null, key: MessageKey) => new ResendError(reason, key, { status })
  if (name === 'restricted_api_key') return fail('permission', msg('server.api.email.resend.keyRestricted'))
  if (status === 401 || name === 'missing_api_key' || name === 'invalid_api_key')
    return fail('auth', msg('server.api.email.resend.keyRefused'))
  // 403 without a key problem: the From domain is not verified, or the account may only send test emails.
  if (status === 403) return fail('config', msg('server.api.email.resend.senderRefused'))
  if (status === 422 && (name === 'invalid_from_address' || /\bfrom\b|domain|sender/i.test(message)))
    return fail('config', msg('server.api.email.resend.senderRefused'))
  if (status === 429)
    return /quota/i.test(`${name} ${message}`)
      ? fail('quota', msg('server.api.email.resend.quota'))
      : fail('network', msg('server.api.email.resend.rateLimited'))
  if (status >= 500) return fail('network', msg('server.api.email.resend.failed'))
  // Anything else is about this email (an address Resend does not take), not the service.
  return fail(null, msg('server.api.email.resend.notAccepted'))
}

/** A request that never got an answer (timeout, blocked port, DNS), in words that name the fix. */
function unreachable(e: unknown, ms: number): ResendError {
  const name = e instanceof Error ? e.name : ''
  if (name === 'TimeoutError' || name === 'AbortError')
    return new ResendError('network', msg('server.api.email.resend.timeout'), { seconds: ms / 1000 })
  const cause = (e as { cause?: { code?: unknown } }).cause
  const code = typeof cause?.code === 'string' ? cause.code : name || 'error'
  return new ResendError('network', msg('server.api.email.resend.unreachable'), { error: code })
}

async function call(key: string, path: string, init: RequestInit, ms: number, doFetch: typeof fetch) {
  try {
    return await doFetch(`${RESEND_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(ms),
    })
  } catch (e) {
    throw unreachable(e, ms)
  }
}

/** Sends one email (POST /emails). Throws a ResendError when Resend does not take it. */
export async function resendSend(key: string, email: ResendEmail, ms: number, doFetch: typeof fetch = fetch) {
  const res = await call(
    key,
    '/emails',
    {
      method: 'POST',
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.html ? { html: email.html } : {}),
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        ...(email.headers && Object.keys(email.headers).length ? { headers: email.headers } : {}),
      }),
    },
    ms,
    doFetch,
  )
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
