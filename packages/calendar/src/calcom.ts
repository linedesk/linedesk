// Cal.com adapter (API v2 at api.cal.com; Cal.com's cloud only, not self-hosted): the "calendars" are the account's event types.
// Cal.com decides availability itself (its own connected calendars, working hours, buffers), so `slots` returns the
// start times it offers and `busy` nothing; a booking is a Cal.com booking in the caller's name, its id the booking
// uid. A reschedule gives the booking a new uid. Auth: an OAuth token (the install's Cal.com OAuth app, which Cal.com
// approves once) or an API key (cal_…), both sent as a bearer token. The API's guarded fetch.
// https://cal.com/docs/api-reference/v2
import {
  type AccessTokenSource,
  type CalendarErrorKind,
  CalendarError,
  type CalendarLogin,
  type CalendarOAuth,
  type CalendarProvider,
  createHttp,
  type Json,
  type OAuthClient,
  tokenRequest,
} from './provider.ts'
import type { Interval } from './slots.ts'

/**
 * `login` (an API key in `password`) or `accessToken` (OAuth). `fetch` is the API's guarded fetch; `timeZone` the
 * business's.
 */
export type CalComOptions = ({ login: CalendarLogin } | { accessToken: AccessTokenSource }) & {
  timeZone?: string
  fetch: typeof fetch
  timeoutMs?: number
}

const CALCOM_API = 'https://api.cal.com/'
const CALCOM_AUTHORIZE = 'https://app.cal.com/auth/oauth2/authorize'
const CALCOM_TOKEN = 'https://api.cal.com/v2/auth/oauth2/token'
/** The account's address, its event types and bookings; slots and booking, moving and cancelling need no scope. */
export const CALCOM_SCOPES = ['PROFILE_READ', 'EVENT_TYPE_READ', 'BOOKING_READ', 'BOOKING_WRITE'] as const

/** Cal.com's OAuth: consent at app.cal.com, tokens at api.cal.com. The client must be approved by Cal.com first. */
export function createCalComOAuth({ clientId, clientSecret }: OAuthClient, { fetch: doFetch = fetch, timeoutMs = 8000 } = {}): CalendarOAuth {
  return {
    name: 'calcom',
    scopes: CALCOM_SCOPES,
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(CALCOM_AUTHORIZE)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: CALCOM_SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      tokenRequest('calcom', 'connect', CALCOM_TOKEN, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }, doFetch, timeoutMs),
    refresh: refreshToken =>
      tokenRequest('calcom', 'refresh access', CALCOM_TOKEN, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }, doFetch, timeoutMs),
    // Cal.com documents no way to revoke a token: the member removes the app in Cal.com (Settings › Apps).
    revoke: async () => false,
    async accountEmail(accessToken) {
      const res = await doFetch(`${CALCOM_API}v2/me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json().catch(() => ({}))) as Json
      const email = body?.data?.email
      if (!res.ok || typeof email !== 'string') throw new CalendarError('calcom', res.status === 401 ? 'auth' : 'invalid', `reading the account failed (${res.status})`, res.status)
      return email
    },
  }
}

// Each endpoint has its own version; without the header Cal.com answers with an older one.
const V_BOOKINGS = '2026-02-25'
const V_SLOTS = '2024-09-04'
const V_EVENT_TYPES = '2026-06-12'

/** A provider's words, short and without markup: they may reach the member and the voice agent. */
export const cleanReason = (text: unknown) =>
  typeof text === 'string'
    ? text
        .replace(/[^\p{L}\p{N} .,:;'()/_-]/gu, '')
        .trim()
        .slice(0, 160) || undefined
    : undefined

const reasonOf = (body: Json) => cleanReason(body.error?.message ?? body.message)

function forbidden(body: Json): { kind: CalendarErrorKind; message?: string } {
  return {
    kind: 'invalid',
    message: `Cal.com refused it${cleanReason(body.error?.message) ? `: ${cleanReason(body.error?.message)}` : ''}`,
  }
}

const E164 = /^\+[1-9]\d{6,14}$/

export function createCalComCalendar(options: CalComOptions): CalendarProvider {
  const { timeZone = 'UTC', fetch: doFetch, timeoutMs = 8000 } = options
  // Always Cal.com's own API: a stored login's server is not used (Cal.com's cloud only).
  const base = new URL('v2/', CALCOM_API)
  const request = createHttp({
    provider: 'calcom',
    accessToken: 'login' in options ? async () => options.login.password : options.accessToken,
    fetch: doFetch,
    timeoutMs,
    reasonOf,
    forbidden,
  })
  const api = (path: string, query?: Record<string, string>) => {
    const url = new URL(path, base)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    return url.toString()
  }

  let me: Promise<{ email: string; username: string | null }> | null = null
  const profile = () => {
    me ??= request('read the account', { url: api('me') }).then(body => ({
      email: String(body?.data?.email ?? ''),
      username: body?.data?.username ?? null,
    }))
    me.catch(() => {
      me = null
    })
    return me
  }

  const booking = (body: Json | null): Json => (Array.isArray(body?.data) ? body.data[0] : body?.data) ?? {}

  async function getBooking(eventId: string) {
    try {
      const body = await request('read the booking', {
        url: api(`bookings/${encodeURIComponent(eventId)}`),
        headers: { 'cal-api-version': V_BOOKINGS },
      })
      const b = booking(body)
      if (!b.uid) return null
      return {
        id: String(b.uid),
        title: String(b.title ?? ''),
        start: new Date(b.start).toISOString(),
        end: new Date(b.end).toISOString(),
        cancelled: b.status === 'cancelled' || b.status === 'rejected',
      }
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'not_found') return null
      throw e
    }
  }

  /** The uid of a live booking of this event type at `start` under `name`, made by a request that seemed to fail. */
  async function madeAnyway(eventTypeId: number, start: string, name: string): Promise<string | null> {
    const at = Date.parse(start)
    const body = await request('look for the booking', {
      url: api('bookings', {
        eventTypeId: String(eventTypeId),
        afterStart: new Date(at - 60_000).toISOString(),
        beforeEnd: new Date(at + 86_400_000).toISOString(),
      }),
      headers: { 'cal-api-version': V_BOOKINGS },
    })
    const found = (Array.isArray(body?.data) ? body.data : []) as Json[]
    const b = found.find(
      b =>
        Date.parse(b.start) === at &&
        b.status !== 'cancelled' &&
        b.status !== 'rejected' &&
        (b.attendees as Json[] | undefined)?.some(a => a?.name === name),
    )
    return typeof b?.uid === 'string' && b.uid ? b.uid : null
  }

  return {
    name: 'calcom',

    async accountEmail() {
      return (await profile()).email
    },

    async listCalendars() {
      const { username } = await profile()
      const body = await request('list event types', {
        url: api('event-types', username ? { username } : {}),
        headers: { 'cal-api-version': V_EVENT_TYPES },
      })
      const types = (Array.isArray(body?.data) ? body.data : []) as Json[]
      return types.map((t, i) => ({
        id: String(t.id),
        name: String(t.title ?? t.slug ?? t.id),
        primary: i === 0,
        canWrite: true,
        durationMin: Number(t.lengthInMinutes) > 0 ? Number(t.lengthInMinutes) : 30,
      }))
    },

    // Cal.com's own availability is in `slots`; nothing extra to subtract here.
    async busy() {
      return []
    },

    async slots(calendarId: string, window: Interval) {
      const body = await request('check availability', {
        url: api('slots', { eventTypeId: calendarId, start: window.start, end: window.end, format: 'range' }),
        headers: { 'cal-api-version': V_SLOTS },
      })
      const days = (body?.data && typeof body.data === 'object' ? Object.values(body.data) : []) as unknown[]
      return days
        .flatMap(day => (Array.isArray(day) ? day : []))
        .map(slot => (typeof slot === 'string' ? slot : (slot as Json)?.start))
        .filter((t): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
        .map(t => new Date(t).toISOString())
    },

    async createEvent(calendarId, event) {
      const eventTypeId = Number(calendarId)
      if (!Number.isInteger(eventTypeId))
        throw new CalendarError('calcom', 'not_found', 'book failed: that is no Cal.com event type')
      const { email } = await profile()
      const phone = event.attendee?.phone && E164.test(event.attendee.phone) ? event.attendee.phone : undefined
      const book = (attendeeEmail: string, notes: string) =>
        request('book', {
          method: 'POST',
          url: api('bookings'),
          headers: { 'cal-api-version': V_BOOKINGS },
          body: {
            start: new Date(event.start).toISOString(),
            eventTypeId,
            attendee: {
              name: event.attendee?.name || event.title,
              email: attendeeEmail,
              timeZone,
              ...(phone && { phoneNumber: phone }),
            },
            bookingFieldsResponses: { notes: notes.slice(0, 1000) },
            metadata: { source: 'linedesk' },
          },
        })
      const callerEmail = event.attendee?.email
      const attendeeName = event.attendee?.name || event.title
      let body: Json | null
      try {
        // Without the caller's address the business's own gets Cal.com's confirmation.
        body = await book(callerEmail || email, event.description)
      } catch (e) {
        // Cal.com sometimes answers a booking after the timeout and books it all the same: that booking is the
        // caller's, not one left behind that nobody knows of.
        if (e instanceof CalendarError && e.kind === 'unavailable') {
          const made = await madeAnyway(eventTypeId, event.start, attendeeName).catch(() => null)
          if (made) return { id: made }
          throw e
        }
        // Cal.com refuses an address whose domain takes no mail (one misheard on the phone): the slot is still
        // booked, under the business's address, with the caller's in the notes for the team to check.
        if (!(callerEmail && e instanceof CalendarError && e.kind === 'invalid' && /e-?mail/i.test(e.message))) throw e
        body = await book(email, `${event.description}\nEmail given by the caller: ${callerEmail}`.trim())
      }
      const uid = booking(body).uid
      if (typeof uid !== 'string' || !uid)
        throw new CalendarError('calcom', 'invalid', 'book failed: Cal.com returned no booking')
      return { id: uid }
    },

    async updateEvent(_calendarId, eventId, changes) {
      // Only the time can change; Cal.com makes it a new booking (the old one is marked rescheduled).
      if (!changes.start) return
      const body = await request('move the booking', {
        method: 'POST',
        url: api(`bookings/${encodeURIComponent(eventId)}/reschedule`),
        headers: { 'cal-api-version': V_BOOKINGS },
        body: { start: new Date(changes.start).toISOString(), reschedulingReason: 'Moved by phone' },
      })
      const uid = booking(body).uid
      return typeof uid === 'string' && uid ? { id: uid } : undefined
    },

    async deleteEvent(_calendarId, eventId) {
      try {
        await request('cancel the booking', {
          method: 'POST',
          url: api(`bookings/${encodeURIComponent(eventId)}/cancel`),
          headers: { 'cal-api-version': V_BOOKINGS },
          body: { cancellationReason: 'Cancelled by phone' },
        })
      } catch (e) {
        if (e instanceof CalendarError && e.kind === 'not_found') return
        // Cancelling a booking that is cancelled (or gone) already is fine; anything else is not.
        if (!(e instanceof CalendarError && e.kind === 'invalid')) throw e
        const now = await getBooking(eventId)
        if (now && !now.cancelled) throw e
      }
    },

    getEvent: (_calendarId, eventId) => getBooking(eventId),
  }
}
