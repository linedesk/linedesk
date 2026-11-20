// What Linedesk needs from a business's support mailbox: read access, nothing else (LIN-615). A mailbox connects by
// OAuth with read-only scopes; the adapters (Gmail API, Microsoft Graph) list and read messages with plain fetch.
// Tokens are not the adapter's business: it asks `accessToken()` for one per request and, after a 401, once more
// with `forceRefresh` before it gives up. No adapter sends, changes or deletes mail.

export type MailProviderName = 'google' | 'microsoft'
export const MAIL_PROVIDERS: readonly MailProviderName[] = ['google', 'microsoft']

/** Product names, as the member knows the mailbox. */
export const MAIL_PROVIDER_LABEL: Record<MailProviderName, string> = {
  google: 'Gmail',
  microsoft: 'Microsoft 365',
}

/** Gives the adapter an access token; `forceRefresh` after the provider refused the last one. */
export type AccessTokenSource = (forceRefresh?: boolean) => Promise<string>

/** A message in a listing: enough to read it later. */
export type MailMessageRef = { id: string; threadId: string }

export type MailPage = { messages: MailMessageRef[]; nextPageToken: string | null }

/** One message, its body as plain text. Untrusted text: whoever reads it fences it as data. */
export type MailMessage = {
  id: string
  /** Messages of one conversation share it (Gmail thread, Graph conversation). */
  threadId: string
  from: string
  to: string[]
  subject: string
  /** ISO 8601 in UTC. */
  sentAt: string
  /** The mailbox's own account sent it (a support answer), not a customer. */
  fromMailbox: boolean
  text: string
}

export type ListOptions = {
  /** Only messages received or sent after this instant (ISO 8601). */
  after?: string
  /** From the previous page's `nextPageToken`. */
  pageToken?: string
  /** Per page; the provider may return fewer. Default 100. */
  max?: number
}

export interface MailProvider {
  readonly name: MailProviderName
  /** Newest first, inbox and sent mail, without spam and trash. */
  listMessages(options?: ListOptions): Promise<MailPage>
  /** null when the message does not exist (any more). */
  getMessage(id: string): Promise<MailMessage | null>
}

/**
 * - `auth`: the account's grant is gone or lacks the scope; someone has to connect it again.
 * - `not_found`: the message does not exist (for this account).
 * - `rate_limited`, `unavailable`: try later; `unavailable` covers timeouts and 5xx.
 * - `invalid`: the provider refused the request itself.
 */
export type MailErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid'

/** A provider failure. The message names the step and the provider's reason, never a token or a message's content. */
export class MailError extends Error {
  readonly provider: MailProviderName
  readonly kind: MailErrorKind
  readonly status: number | undefined
  /**
   * The provider's code when the app itself is refused, not one account: `invalid_client` and `unauthorized_client`
   * from the token endpoint, `api_disabled` (Google: the Gmail API is not enabled in the app's project).
   */
  readonly code: string | undefined

  constructor(provider: MailProviderName, kind: MailErrorKind, message: string, status?: number, code?: string) {
    super(`${MAIL_PROVIDER_LABEL[provider]}: ${message}`)
    this.provider = provider
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export function errorKindOf(status: number): MailErrorKind {
  if (status === 401) return 'auth'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

// biome-ignore lint/suspicious/noExplicitAny: provider JSON is read field by field
export type Json = Record<string, any>

export type HttpOptions = {
  provider: MailProviderName
  accessToken: AccessTokenSource
  fetch: typeof fetch
  timeoutMs: number
  reasonOf: (body: Json) => string | undefined
  /** A 403's kind (and optionally a clearer message and code) from the provider's body. */
  forbidden: (body: Json) => { kind: MailErrorKind; message?: string; code?: string }
}

/**
 * One authorized GET for JSON with a timeout; a 401 refreshes the token once and repeats the request.
 * `what` names the step in errors ("list messages"). URLs and tokens never go into a message.
 */
export function createHttp({ provider, accessToken, fetch: doFetch, timeoutMs, reasonOf, forbidden }: HttpOptions) {
  async function send(what: string, url: string, headers: Record<string, string>, token: string) {
    try {
      return await doFetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new MailError(
        provider,
        'unavailable',
        `${what} ${timedOut ? `took longer than ${timeoutMs} ms` : 'could not reach the provider'}`,
      )
    }
  }
  return async function get(what: string, url: string, headers: Record<string, string> = {}): Promise<Json> {
    let res = await send(what, url, headers, await accessToken())
    if (res.status === 401) res = await send(what, url, headers, await accessToken(true))
    const body = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) {
      const classified = res.status === 403 ? forbidden(body) : { kind: errorKindOf(res.status) }
      const reason = ('message' in classified ? classified.message : undefined) ?? reasonOf(body) ?? res.statusText
      const code = 'code' in classified ? classified.code : undefined
      throw new MailError(provider, classified.kind, `${what} failed${reason ? `: ${reason}` : ''}`, res.status, code)
    }
    return body
  }
}

/** OAuth tokens as a provider returns them, normalized. `refreshToken` is null when the provider kept the old one. */
export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: string; scope: string | null }

export type OAuthClient = { clientId: string; clientSecret: string }

/** The OAuth side of a mailbox provider: consent URL, code exchange, refresh, revoke, and whose account it is. */
export interface MailOAuth {
  readonly name: MailProviderName
  readonly scopes: readonly string[]
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string
  exchangeCode(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokens>
  refresh(refreshToken: string): Promise<OAuthTokens>
  /** Withdraws the grant at the provider. Returns false when the provider has no way to (Microsoft). */
  revoke(token: string): Promise<boolean>
  accountEmail(accessToken: string): Promise<string>
  /** Whether the granted scopes allow reading mail (Google lets the member untick a scope). Null scope: trusted. */
  grantsMailRead(scope: string | null): boolean
}

/** POSTs a form to a token endpoint and normalizes the answer. */
export async function tokenRequest(
  provider: MailProviderName,
  what: string,
  url: string,
  form: Record<string, string>,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<OAuthTokens> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new MailError(provider, 'unavailable', `${what} could not reach the provider`)
  }
  const body = (await res.json().catch(() => ({}))) as Json
  if (!res.ok || typeof body.access_token !== 'string') {
    // invalid_grant: the refresh token was revoked or expired; the mailbox has to be connected again.
    const kind = body.error === 'invalid_grant' ? 'auth' : res.ok ? 'invalid' : errorKindOf(res.status)
    const reason = typeof body.error_description === 'string' ? body.error_description.split('\n')[0] : body.error
    const code = typeof body.error === 'string' ? body.error : undefined
    throw new MailError(provider, kind, `${what} failed${reason ? `: ${reason}` : ''}`, res.status, code)
  }
  const expiresIn = Number(body.expires_in) || 3600
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: typeof body.scope === 'string' ? body.scope : null,
  }
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** The bare address of a header value ("Mike Brennan <mike@example.com>" → mike@example.com), lower case. */
export function addressOf(value: string): string {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(value)
  const bare = angled?.[1] ?? /[^\s<>,;"]+@[^\s<>,;"]+/.exec(value)?.[0] ?? value.trim()
  return bare.toLowerCase()
}

/** Plain text of an HTML body: no tags, scripts or styles; entities that matter decoded; blank runs collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
