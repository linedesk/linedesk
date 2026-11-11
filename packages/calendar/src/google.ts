// Google Calendar adapter (Calendar API v3) and Google's OAuth. Plain fetch.
// https://developers.google.com/calendar/api/v3/reference
import {
  type AccessTokenSource, CalendarError, type CalendarErrorKind, type CalendarOAuth, type CalendarProvider, type Json, type OAuthClient, createHttp, mergeBusy, tokenRequest,
} from './provider.ts'

const API = 'https://www.googleapis.com/calendar/v3'
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOKE = 'https://oauth2.googleapis.com/revoke'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * Events in any calendar of the account, free/busy, and the list of calendars (read only).
 * Never Gmail or Drive. `calendar.events` alone allows neither freeBusy nor calendarList.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const

export type GoogleCalendarOptions = { accessToken: AccessTokenSource; fetch?: typeof fetch; timeoutMs?: number }

const reasonOf = (body: Json) => body.error?.message as string | undefined

/** Google's 403 reasons (error.errors[].reason, or error.details[].reason for newer APIs). */
const RATE_LIMITED = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED'])
const NO_GRANT = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError', 'accessNotConfigured'])

export function googleForbidden(body: Json): { kind: CalendarErrorKind; message?: string } {
  const reasons = [...((body.error?.errors ?? []) as Json[]), ...((body.error?.details ?? []) as Json[])].map(e => String(e.reason ?? ''))
  if (reasons.some(r => RATE_LIMITED.has(r))) return { kind: 'rate_limited' }
  if (reasons.some(r => NO_GRANT.has(r))) return { kind: 'auth' }
  if (reasons.includes('requiredAccessLevel')) return { kind: 'invalid', message: 'the calendar is read-only for this account' }
  return { kind: 'invalid' }
}
const cal = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}/events`

function eventBody(event: Partial<{ title: string; description: string; start: string; end: string; location?: string }>) {
  return {
    ...(event.title !== undefined && { summary: event.title }),
    ...(event.description !== undefined && { description: event.description }),
    ...(event.location !== undefined && { location: event.location }),
    ...(event.start !== undefined && { start: { dateTime: event.start } }),
    ...(event.end !== undefined && { end: { dateTime: event.end } }),
  }
}

/** All-day events have `date` instead of `dateTime`. */
const instantOf = (when: Json | undefined) => new Date(when?.dateTime ?? `${when?.date}T00:00:00Z`).toISOString()

export function createGoogleCalendar({ accessToken, fetch: doFetch = fetch, timeoutMs = 4000 }: GoogleCalendarOptions): CalendarProvider {
  const request = createHttp({ provider: 'google', accessToken, fetch: doFetch, timeoutMs, reasonOf, forbidden: googleForbidden })

  return {
    name: 'google',

    async listCalendars() {
      const body = await request('list calendars', { url: `${API}/users/me/calendarList?minAccessRole=reader&maxResults=250` })
      return ((body?.items ?? []) as Json[]).map(c => ({
        id: String(c.id),
        name: String(c.summaryOverride ?? c.summary ?? c.id),
        primary: c.primary === true,
        canWrite: c.accessRole === 'owner' || c.accessRole === 'writer',
      }))
    },

    async busy(calendarIds, window) {
      if (!calendarIds.length) return []
      const body = await request('check availability', {
        method: 'POST',
        url: `${API}/freeBusy`,
        body: { timeMin: window.start, timeMax: window.end, items: calendarIds.map(id => ({ id })) },
      })
      const calendars = (body?.calendars ?? {}) as Record<string, Json>
      const failed = Object.entries(calendars).find(([, c]) => (c.errors as Json[] | undefined)?.length)
      if (failed) {
        const reason = (failed[1].errors as Json[])[0]?.reason
        throw new CalendarError('google', reason === 'notFound' ? 'not_found' : 'unavailable', `check availability failed: ${reason ?? 'calendar error'}`)
      }
      return mergeBusy(Object.values(calendars).flatMap(c => (c.busy ?? []) as { start: string; end: string }[]), window)
    },

    async createEvent(calendarId, event) {
      const body = await request('create event', { method: 'POST', url: cal(calendarId), body: eventBody(event) })
      return { id: String(body?.id) }
    },

    async updateEvent(calendarId, eventId, event) {
      await request('update event', { method: 'PATCH', url: `${cal(calendarId)}/${encodeURIComponent(eventId)}`, body: eventBody(event) })
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await request('delete event', { method: 'DELETE', url: `${cal(calendarId)}/${encodeURIComponent(eventId)}` })
      } catch (e) {
        if (!(e instanceof CalendarError && e.kind === 'not_found')) throw e
      }
    },

    async getEvent(calendarId, eventId) {
      try {
        const body = await request('read event', { url: `${cal(calendarId)}/${encodeURIComponent(eventId)}` })
        if (!body) return null
        return { id: String(body.id), title: String(body.summary ?? ''), start: instantOf(body.start), end: instantOf(body.end), cancelled: body.status === 'cancelled' }
      } catch (e) {
        if (e instanceof CalendarError && e.kind === 'not_found') return null
        throw e
      }
    },
  }
}

export function createGoogleOAuth({ clientId, clientSecret }: OAuthClient, { fetch: doFetch = fetch, timeoutMs = 8000 } = {}): CalendarOAuth {
  return {
    name: 'google',
    scopes: GOOGLE_CALENDAR_SCOPES,

    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(AUTHORIZE)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_CALENDAR_SCOPES.join(' '),
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
      tokenRequest('google', 'connect', TOKEN, {
        code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier,
      }, doFetch, timeoutMs),

    refresh: refreshToken =>
      tokenRequest('google', 'refresh access', TOKEN, { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }, doFetch, timeoutMs),

    async revoke(token) {
      const res = await doFetch(REVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 400 invalid_token: revoked already.
      if (!res.ok && res.status !== 400) throw new Error(`Google: revoking access failed (${res.status})`)
      return true
    },

    async accountEmail(accessToken) {
      const res = await doFetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json().catch(() => ({}))) as Json
      if (!res.ok || typeof body.email !== 'string') throw new Error(`Google: reading the account's email failed (${res.status})`)
      return body.email
    },
  }
}
