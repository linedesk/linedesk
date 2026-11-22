// Gmail adapter (Gmail API v1, read only) and the OAuth of the install's Gmail app. Plain fetch.
// https://developers.google.com/gmail/api/reference/rest
// The app is not the sign-in and calendar app: gmail.readonly is a restricted scope (Google verification and a yearly
// security assessment for a public app), so it lives in a Google Cloud project of its own (Server admin › Providers ›
// Gmail mailboxes) and the sign-in and calendar consent screen never asks for it (LIN-637).
import {
  type AccessTokenSource,
  addressOf,
  createHttp,
  htmlToText,
  type Json,
  MailError,
  type MailErrorKind,
  type MailMessage,
  type MailOAuth,
  type MailProvider,
  type OAuthClient,
  tokenRequest,
} from './provider.ts'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOKE = 'https://oauth2.googleapis.com/revoke'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

/** The account's address and read-only mail. Never send, modify or Drive. */
export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'] as const

const RATE_LIMITED = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
])
const NO_GRANT = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError'])
/** The app's Google Cloud project has the Gmail API off: no account can fix that by connecting again. */
const API_DISABLED = new Set(['accessNotConfigured', 'SERVICE_DISABLED'])

export function gmailForbidden(body: Json): { kind: MailErrorKind; message?: string; code?: string } {
  const reasons = [...((body.error?.errors ?? []) as Json[]), ...((body.error?.details ?? []) as Json[])].map(e =>
    String(e.reason ?? ''),
  )
  if (reasons.some(r => API_DISABLED.has(r)))
    return {
      kind: 'invalid',
      code: 'api_disabled',
      message: 'the Gmail API is not enabled in the Google Cloud project of the app',
    }
  if (reasons.some(r => RATE_LIMITED.has(r))) return { kind: 'rate_limited' }
  if (reasons.some(r => NO_GRANT.has(r))) return { kind: 'auth' }
  return { kind: 'invalid' }
}

const reasonOf = (body: Json) => body.error?.message as string | undefined

/** The charset a MIME part's Content-Type names (`text/plain; charset="iso-8859-1"`), or '' when it names none. */
export function partCharset(part: Json | undefined): string {
  const type = header(part, 'content-type')
  return /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] ?? ''
}

/**
 * A part's base64url body data as text. Gmail gives the bytes in the part's own charset (often ISO-8859-1 or
 * Windows-1252 in German mail), so read them in it: as UTF-8 every "ä" would become "\uFFFD". UTF-8 when it names none
 * or one Node does not know.
 */
function decode(part: Json): string {
  const base64 = String(part.body.data).replaceAll('-', '+').replaceAll('_', '/')
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  try {
    return new TextDecoder(partCharset(part) || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

/** The first part of this MIME type, depth first (attachments skipped: they have a filename). */
function findPart(part: Json | undefined, mimeType: string): Json | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return part
  for (const child of (part.parts ?? []) as Json[]) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return undefined
}

export function gmailBodyText(payload: Json | undefined): string {
  const plain = findPart(payload, 'text/plain')
  if (plain) return decode(plain).trim()
  const html = findPart(payload, 'text/html')
  return html ? htmlToText(decode(html)) : ''
}

const header = (payload: Json | undefined, name: string): string => {
  const found = ((payload?.headers ?? []) as Json[]).find(h => String(h.name).toLowerCase() === name.toLowerCase())
  return typeof found?.value === 'string' ? found.value : ''
}

export type GmailOptions = {
  accessToken: AccessTokenSource
  fetch?: typeof fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export function createGmail({
  accessToken,
  fetch: doFetch = fetch,
  timeoutMs = 8000,
  sleep,
}: GmailOptions): MailProvider {
  const get = createHttp({
    provider: 'google',
    accessToken,
    fetch: doFetch,
    timeoutMs,
    sleep,
    // 25 reads a second: 7,500 of Gmail's 15,000 units a minute per user (a message read costs 5).
    minIntervalMs: 40,
    reasonOf,
    forbidden: gmailForbidden,
  })
  return {
    name: 'google',

    async listMessages({ after, pageToken, max = 100 } = {}) {
      // Spam and trash are left out by default; drafts and chats are not mail anyone received.
      const q = ['-in:drafts', '-in:chats', ...(after ? [`after:${Math.floor(Date.parse(after) / 1000)}`] : [])].join(
        ' ',
      )
      const params = new URLSearchParams({ q, maxResults: String(Math.min(Math.max(max, 1), 500)) })
      if (pageToken) params.set('pageToken', pageToken)
      const body = await get('list messages', `${API}/messages?${params}`)
      return {
        messages: ((body.messages ?? []) as Json[]).map(m => ({
          id: String(m.id),
          threadId: String(m.threadId ?? m.id),
        })),
        nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : null,
      }
    },

    async getMessage(id) {
      let body: Json
      try {
        body = await get('read a message', `${API}/messages/${encodeURIComponent(id)}?format=full`)
      } catch (e) {
        if (e instanceof MailError && e.kind === 'not_found') return null
        throw e
      }
      const payload = body.payload as Json | undefined
      const message: MailMessage = {
        id: String(body.id),
        threadId: String(body.threadId ?? body.id),
        from: addressOf(header(payload, 'From')),
        to: header(payload, 'To')
          .split(',')
          .map(addressOf)
          .filter(a => a.includes('@')),
        subject: header(payload, 'Subject'),
        sentAt: new Date(Number(body.internalDate) || Date.parse(header(payload, 'Date')) || 0).toISOString(),
        fromMailbox: ((body.labelIds ?? []) as string[]).includes('SENT'),
        text: gmailBodyText(payload),
      }
      return message
    },
  }
}

const READ_SCOPE = /\/auth\/gmail\.readonly(\s|$)/

export function createGmailOAuth(
  { clientId, clientSecret }: OAuthClient,
  { fetch: doFetch = fetch, timeoutMs = 8000 } = {},
): MailOAuth {
  return {
    name: 'google',
    scopes: GMAIL_SCOPES,

    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(AUTHORIZE)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        // A refresh token every time: without prompt=consent Google gives one only on the first grant.
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },

    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      tokenRequest(
        'google',
        'connect',
        TOKEN,
        {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        },
        doFetch,
        timeoutMs,
      ),

    refresh: refreshToken =>
      tokenRequest(
        'google',
        'refresh access',
        TOKEN,
        { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' },
        doFetch,
        timeoutMs,
      ),

    async revoke(token) {
      const res = await doFetch(REVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 400 invalid_token: revoked already.
      if (!res.ok && res.status !== 400) throw new Error(`Gmail: revoking access failed (${res.status})`)
      return true
    },

    async accountEmail(accessToken) {
      const res = await doFetch(USERINFO, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await res.json().catch(() => ({}))) as Json
      if (!res.ok || typeof body.email !== 'string')
        throw new Error(`Gmail: reading the account's email failed (${res.status})`)
      return body.email
    },

    grantsMailRead: scope => scope === null || READ_SCOPE.test(scope),
  }
}
