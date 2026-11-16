// What Linedesk needs from a calendar account: its calendars, when they are busy, and events it
// writes. Google and Microsoft adapters implement it with plain fetch; vendor code stays in them.
// Tokens are not the adapter's business: it asks `accessToken()` for one per request and, after a
// 401, once more with `forceRefresh` before it gives up. A provider connected with a user name and
// password instead (CalDAV) gets its login (`CalendarLogin`) and signs in with it on every request.
import type { Interval } from './slots.ts'

/**
 * Providers connected by OAuth: Google and Microsoft with the install's sign-in apps; Calendly and Cal.com with their
 * own OAuth apps when the install has one (Server admin › Providers), else with a key (PASSWORD_CALENDAR_PROVIDERS).
 */
export type OAuthCalendarProviderName = 'google' | 'microsoft' | 'calendly' | 'calcom'
/**
 * Providers an account connects to with a user name and app-specific password (CalDAV) or an API key or personal token
 * (Cal.com, Calendly): no app to register on the install.
 */
export const PASSWORD_CALENDAR_PROVIDERS = ['caldav', 'calcom', 'calendly'] as const
export type PasswordCalendarProviderName = (typeof PASSWORD_CALENDAR_PROVIDERS)[number]
export type CalendarProviderName = OAuthCalendarProviderName | PasswordCalendarProviderName

export const isPasswordProvider = (name: CalendarProviderName): name is PasswordCalendarProviderName =>
  (PASSWORD_CALENDAR_PROVIDERS as readonly string[]).includes(name)

export const CALENDAR_PROVIDER_LABEL: Record<CalendarProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  caldav: 'CalDAV',
  calcom: 'Cal.com',
  calendly: 'Calendly',
}

/** Where a token provider's API is: always its own (Cal.com is supported in Cal.com's cloud only, not self-hosted). */
export const DEFAULT_SERVER_URL: Partial<Record<PasswordCalendarProviderName, string>> = {
  calcom: 'https://api.cal.com/',
  calendly: 'https://api.calendly.com/',
}

/**
 * How a password provider signs in: the server's address, the account's user name and its (app-specific) password.
 * For Cal.com and Calendly `password` is the API key or personal access token and `username` is not used.
 */
export type CalendarLogin = { serverUrl: string; username: string; password: string }

export type ProviderCalendar = {
  /** The provider's calendar id. */
  id: string
  name: string
  /** The account's main calendar. */
  primary: boolean
  /** Events can be written into it. */
  canWrite: boolean
  /**
   * A scheduling tool's event type (Cal.com, Calendly): its length in minutes. The tool then decides the appointment
   * itself (type, length, availability, buffers, notice); Linedesk's appointment types and hours do not apply.
   */
  durationMin?: number
  /** The team it belongs to (a Cal.com team's event type), to list it under that team; unset for the account's own. */
  group?: string
}

export type CalendarEventInput = {
  title: string
  description: string
  start: string
  end: string
  location?: string
  /** Who the appointment is for: a scheduling tool books it in their name (a calendar only shows the title). */
  attendee?: { name?: string; email?: string | null; phone?: string | null }
}

export type CalendarEvent = { id: string; title: string; start: string; end: string; cancelled: boolean }

export interface CalendarProvider {
  readonly name: CalendarProviderName
  listCalendars(): Promise<ProviderCalendar[]>
  /** Busy intervals of these calendars inside `window`, in one request where the provider allows it. */
  busy(calendarIds: readonly string[], window: Interval): Promise<Interval[]>
  createEvent(calendarId: string, event: CalendarEventInput): Promise<{ id: string }>
  /** A scheduling tool may give a moved booking a new id (Cal.com, Calendly): the caller keeps that one from then on. */
  // biome-ignore lint/suspicious/noConfusingVoidType: calendars change the event in place and return nothing
  updateEvent(calendarId: string, eventId: string, event: Partial<CalendarEventInput>): Promise<void | { id: string }>
  /** Deleting an event that is gone already is not an error. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>
  /** null when the event does not exist (any more). */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>
  /**
   * Scheduling tools that decide availability themselves (Cal.com, Calendly): the start times inside `window` they would
   * accept a booking at. Linedesk then offers only those (within its own hours and rules); `busy` returns nothing.
   */
  slots?(calendarId: string, window: Interval): Promise<string[]>
  /** The account's address, for a provider connected with a key (shown as the account's name). */
  accountEmail?(): Promise<string>
}

/** Gives the adapter an access token; `forceRefresh` after the provider refused the last one. */
export type AccessTokenSource = (forceRefresh?: boolean) => Promise<string>

/**
 * - `auth`: the account's grant is gone or lacks a scope; someone has to connect it again.
 * - `not_found`: the calendar or event does not exist (for this account).
 * - `rate_limited`, `unavailable`: try later; `unavailable` covers timeouts and 5xx.
 * - `invalid`: the provider refused the request itself.
 */
export type CalendarErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid'

/** A provider failure. The message names the step and the provider's reason, never a token. */
export class CalendarError extends Error {
  readonly provider: CalendarProviderName
  readonly kind: CalendarErrorKind
  readonly status: number | undefined
  /**
   * The provider's error code when it says the app itself is refused, not one account: `invalid_client` and
   * `unauthorized_client` from the token endpoint (wrong or expired client secret), `api_disabled` (Google: the
   * Calendar API is not enabled in the app's project). The API records these as a provider failure (LIN-111).
   */
  readonly code: string | undefined

  constructor(provider: CalendarProviderName, kind: CalendarErrorKind, message: string, status?: number, code?: string) {
    super(`${CALENDAR_PROVIDER_LABEL[provider]}: ${message}`)
    this.provider = provider
    this.kind = kind
    this.status = status
    this.code = code
  }
}

/**
 * The kind of a failed response. 403 is ambiguous (rate limits, missing scopes, read-only calendars),
 * so each adapter classifies it from the provider's reason; without one it is `invalid`.
 */
export function errorKindOf(status: number): CalendarErrorKind {
  if (status === 401) return 'auth'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

// biome-ignore lint/suspicious/noExplicitAny: provider JSON is read field by field
export type Json = Record<string, any>

export type HttpOptions = {
  provider: CalendarProviderName
  accessToken: AccessTokenSource
  fetch: typeof fetch
  timeoutMs: number
  /** The provider's reason from an error body. */
  reasonOf: (body: Json) => string | undefined
  /** A 403's kind, and optionally a clearer message, from the provider's body and the request method. */
  forbidden: (body: Json, method: string) => { kind: CalendarErrorKind; message?: string; code?: string }
}

export type HttpRequest = { method?: string; url: string; body?: unknown; headers?: Record<string, string> }

/**
 * One authorized JSON request with a timeout; a 401 refreshes the token once and repeats the request.
 * `what` names the step in errors ("list calendars"). URLs and tokens never go into a message.
 */
export function createHttp({ provider, accessToken, fetch: doFetch, timeoutMs, reasonOf, forbidden }: HttpOptions) {
  async function send(what: string, req: HttpRequest, token: string): Promise<Response> {
    try {
      return await doFetch(req.url, {
        method: req.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...req.headers,
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new CalendarError(provider, 'unavailable', `${what} ${timedOut ? `took longer than ${timeoutMs} ms` : 'could not reach the provider'}`)
    }
  }

  return async function request(what: string, req: HttpRequest): Promise<Json | null> {
    let res = await send(what, req, await accessToken())
    if (res.status === 401) res = await send(what, req, await accessToken(true))
    if (res.status === 204) return null
    const body = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) {
      const classified: { kind: CalendarErrorKind; message?: string; code?: string } =
        res.status === 403 ? forbidden(body, req.method ?? 'GET') : { kind: errorKindOf(res.status) }
      const reason = classified.message ?? reasonOf(body) ?? res.statusText
      throw new CalendarError(provider, classified.kind, `${what} failed${reason ? `: ${reason}` : ''}`, res.status, classified.code)
    }
    return body
  }
}

/** Merged, sorted busy intervals inside `window`. */
export function mergeBusy(intervals: readonly Interval[], window: Interval): Interval[] {
  const lo = Date.parse(window.start)
  const hi = Date.parse(window.end)
  const spans = intervals
    .map(i => ({ start: Math.max(Date.parse(i.start), lo), end: Math.min(Date.parse(i.end), hi) }))
    .filter(s => !Number.isNaN(s.start) && !Number.isNaN(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const s of spans) {
    const last = merged.at(-1)
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  return merged.map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }))
}

/** OAuth tokens as a provider returns them, normalized. `refreshToken` is null when the provider kept the old one. */
export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: string; scope: string | null }

export type OAuthClient = { clientId: string; clientSecret: string }

/** The OAuth side of a provider: consent URL, code exchange, refresh, revoke, and whose account it is. */
export interface CalendarOAuth {
  readonly name: OAuthCalendarProviderName
  readonly scopes: readonly string[]
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string
  exchangeCode(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokens>
  refresh(refreshToken: string): Promise<OAuthTokens>
  /** Withdraws the grant at the provider. Returns false when the provider has no way to (Microsoft). */
  revoke(token: string): Promise<boolean>
  accountEmail(accessToken: string): Promise<string>
}

/** POSTs a form to a token endpoint and normalizes the answer. */
export async function tokenRequest(
  provider: CalendarProviderName,
  what: string,
  url: string,
  form: Record<string, string>,
  doFetch: typeof fetch,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<OAuthTokens> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new CalendarError(provider, 'unavailable', `${what} could not reach the provider`)
  }
  const body = (await res.json().catch(() => ({}))) as Json
  if (!res.ok || typeof body.access_token !== 'string') {
    // invalid_grant: the refresh token was revoked or expired; the account has to be connected again.
    const kind = body.error === 'invalid_grant' ? 'auth' : res.ok ? 'invalid' : errorKindOf(res.status)
    const reason = typeof body.error_description === 'string' ? body.error_description.split('\n')[0] : body.error
    const code = typeof body.error === 'string' ? body.error : undefined
    throw new CalendarError(provider, kind, `${what} failed${reason ? `: ${reason}` : ''}`, res.status, code)
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
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Services known to hand each account a server of its own under their domain (iCloud: p42-caldav.icloud.com). */
const PER_ACCOUNT_HOSTS = ['icloud.com']

const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/**
 * Whether a password provider may send its login to `target`, given the server the member entered: the same scheme
 * and host (port included), or both under a service known to move accounts to a host of their own (iCloud). Nothing
 * else: two names under one public suffix (a.synology.me, b.synology.me) belong to different people.
 */
export function sameSite(server: URL, target: URL): boolean {
  if (server.protocol !== target.protocol) return false
  if (server.host === target.host) return true
  const [a, b] = [server.hostname.toLowerCase(), target.hostname.toLowerCase()]
  return PER_ACCOUNT_HOSTS.some(domain => underDomain(a, domain) && underDomain(b, domain))
}
