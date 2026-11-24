// Microsoft Graph calendar adapter (Outlook, Microsoft 365) and Microsoft identity platform OAuth. Plain fetch.
// https://learn.microsoft.com/graph/api/resources/calendar
import {
  type AccessTokenSource, CalendarError, type CalendarErrorKind, type CalendarEventInput, type CalendarOAuth, type CalendarProvider, type Json, type OAuthClient,
  createHttp, mergeBusy, tokenRequest,
} from './provider.ts'
import type { Interval } from './slots.ts'
import { zonedTimeToInstant } from './zoned-time.ts'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const login = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`

/** offline_access for a refresh token, User.Read for the account's address, Calendars.ReadWrite for the rest. */
export const MICROSOFT_CALENDAR_SCOPES = ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite'] as const

/** `timeZone`: the business's, for all-day events (default UTC). */
export type MicrosoftCalendarOptions = { accessToken: AccessTokenSource; timeZone?: string; fetch?: typeof fetch; timeoutMs?: number }

/** Graph returns times in this zone, without an offset. */
const UTC = { Prefer: 'outlook.timezone="UTC"' }
/** Events in these states leave the time free for a booking. */
const FREE = new Set(['free', 'workingElsewhere'])
/** Pages of calendarView to read at most per calendar (100 events each). */
const MAX_PAGES = 5

const reasonOf = (body: Json) => body.error?.message as string | undefined

/**
 * Graph answers 403 ErrorAccessDenied both for a token without the calendar scope and for writing
 * into a calendar the account may only read. Graph throttles with 429, but a quota 403 exists too.
 */
export function graphForbidden(body: Json, method: string): { kind: CalendarErrorKind; message?: string } {
  const code = String(body.error?.code ?? '')
  if (/quota|throttl|toomany/i.test(code)) return { kind: 'rate_limited' }
  if (method !== 'GET') return { kind: 'invalid', message: 'the calendar is read-only for this account' }
  if (/accessdenied|authorization|insufficient/i.test(code)) return { kind: 'auth' }
  return { kind: 'invalid' }
}
const utc = (when: Json | undefined) => new Date(`${String(when?.dateTime ?? '').replace(/Z?$/, '')}Z`).toISOString()
/**
 * An all-day event has no zone of its own: Graph gives it as midnight to midnight in the zone asked for (UTC here).
 * It blocks the business's day, as in the CalDAV adapter.
 */
const businessDay = (when: Json | undefined, timeZone: string) =>
  new Date(zonedTimeToInstant(String(when?.dateTime ?? '').slice(0, 10), '00:00', timeZone)).toISOString()

function eventBody(event: Partial<CalendarEventInput>) {
  return {
    ...(event.title !== undefined && { subject: event.title }),
    ...(event.description !== undefined && { body: { contentType: 'text', content: event.description } }),
    ...(event.location !== undefined && { location: { displayName: event.location } }),
    ...(event.start !== undefined && { start: { dateTime: event.start.replace(/Z$/, ''), timeZone: 'UTC' } }),
    ...(event.end !== undefined && { end: { dateTime: event.end.replace(/Z$/, ''), timeZone: 'UTC' } }),
  }
}

export function createMicrosoftCalendar({ accessToken, timeZone = 'UTC', fetch: doFetch = fetch, timeoutMs = 4000 }: MicrosoftCalendarOptions): CalendarProvider {
  const request = createHttp({ provider: 'microsoft', accessToken, fetch: doFetch, timeoutMs, reasonOf, forbidden: graphForbidden })
  const event = (eventId: string) => `${GRAPH}/me/events/${encodeURIComponent(eventId)}`

  /** One calendar's busy times: calendarView expands recurring events into their occurrences. */
  async function busyOf(calendarId: string, window: Interval): Promise<Interval[]> {
    const params = new URLSearchParams({ startDateTime: window.start, endDateTime: window.end, $select: 'start,end,showAs,isCancelled,isAllDay', $top: '100' })
    let url: string | undefined = `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params}`
    const busy: Interval[] = []
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await request('check availability', { url, headers: UTC })
      for (const e of (body?.value ?? []) as Json[]) {
        if (e.isCancelled || FREE.has(e.showAs)) continue
        busy.push(e.isAllDay ? { start: businessDay(e.start, timeZone), end: businessDay(e.end, timeZone) } : { start: utc(e.start), end: utc(e.end) })
      }
      url = body?.['@odata.nextLink']
    }
    return busy
  }

  return {
    name: 'microsoft',

    async listCalendars() {
      const body = await request('list calendars', { url: `${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100` })
      return ((body?.value ?? []) as Json[]).map(c => ({
        id: String(c.id),
        name: String(c.name ?? c.id),
        primary: c.isDefaultCalendar === true,
        canWrite: c.canEdit === true,
      }))
    },

    async busy(calendarIds, window) {
      const all = await Promise.all(calendarIds.map(id => busyOf(id, window)))
      return mergeBusy(all.flat(), window)
    },

    async createEvent(calendarId, input) {
      const body = await request('create event', { method: 'POST', url: `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`, body: eventBody(input) })
      return { id: String(body?.id) }
    },

    async updateEvent(_calendarId, eventId, input) {
      await request('update event', { method: 'PATCH', url: event(eventId), body: eventBody(input) })
    },

    async deleteEvent(_calendarId, eventId) {
      try {
        await request('delete event', { method: 'DELETE', url: event(eventId) })
      } catch (e) {
        if (!(e instanceof CalendarError && e.kind === 'not_found')) throw e
      }
    },

    async getEvent(_calendarId, eventId) {
      try {
        const body = await request('read event', { url: `${event(eventId)}?$select=id,subject,start,end,isCancelled`, headers: UTC })
        if (!body) return null
        return { id: String(body.id), title: String(body.subject ?? ''), start: utc(body.start), end: utc(body.end), cancelled: body.isCancelled === true }
      } catch (e) {
        if (e instanceof CalendarError && e.kind === 'not_found') return null
        throw e
      }
    },
  }
}

export type MicrosoftOAuthOptions = OAuthClient & { tenantId?: string }

export function createMicrosoftOAuth({ clientId, clientSecret, tenantId = 'common' }: MicrosoftOAuthOptions, { fetch: doFetch = fetch, timeoutMs = 8000 } = {}): CalendarOAuth {
  const base = login(tenantId)
  const scope = MICROSOFT_CALENDAR_SCOPES.join(' ')
  return {
    name: 'microsoft',
    scopes: MICROSOFT_CALENDAR_SCOPES,

    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(`${base}/authorize`)
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', response_mode: 'query', scope,
        prompt: 'select_account', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },

    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      tokenRequest('microsoft', 'connect', `${base}/token`, {
        code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier, scope,
      }, doFetch, timeoutMs),

    // Microsoft may hand out a new refresh token with every refresh; the caller keeps the newest.
    refresh: refreshToken =>
      tokenRequest('microsoft', 'refresh access', `${base}/token`, { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', scope }, doFetch, timeoutMs),

    // The identity platform has no endpoint to revoke one app's refresh token: deleting it is all
    // Linedesk can do. The account owner removes the app's access in their Microsoft account.
    revoke: async () => false,

    async accountEmail(accessToken) {
      const res = await doFetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json().catch(() => ({}))) as Json
      const email = body.mail ?? body.userPrincipalName
      if (!res.ok || typeof email !== 'string') throw new Error(`Microsoft: reading the account's email failed (${res.status})`)
      return email
    },
  }
}
