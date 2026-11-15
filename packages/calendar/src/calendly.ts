// Calendly adapter (API v2 with the Scheduling API): the "calendars" are the account's active event types, their ids
// the event type URIs. Calendly decides availability itself, so `slots` returns its available start times (asked in
// 7-day pieces, never in the past) and `busy` nothing. A booking is an invitee of a new scheduled event; its id is the
// scheduled event's URI. Calendly cannot move a booking: a reschedule books the new time first, then cancels the old
// one, and returns the new event's URI. Auth: an OAuth token (the install's Calendly OAuth app: PKCE, no review) or a
// personal access token, both as a bearer token. Plain fetch.
// https://developer.calendly.com/api-docs
import { cleanReason } from './calcom.ts'
import {
  type AccessTokenSource,
  type CalendarErrorKind,
  CalendarError,
  type CalendarEventInput,
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
 * `login` (a personal access token) or `accessToken` (OAuth). `fetch` is the API's guarded fetch; `timeZone` the
 * business's (the invitee's time zone Calendly writes to).
 */
export type CalendlyOptions = ({ login: CalendarLogin } | { accessToken: AccessTokenSource }) & {
  timeZone?: string
  fetch: typeof fetch
  timeoutMs?: number
}

const CALENDLY_API = 'https://api.calendly.com/'
const CALENDLY_AUTH = 'https://auth.calendly.com/oauth'
/**
 * The scopes the install's Calendly OAuth app needs (chosen when the app is made, not asked for at consent): the
 * account, its event types and available times, booking and cancelling.
 */
export const CALENDLY_SCOPES = ['users:read', 'event_types:read', 'scheduled_events:write'] as const

/**
 * Calendly's OAuth: authorization code with PKCE (S256, required), the app's client ID and secret as HTTP Basic at the
 * token endpoint. Access tokens last two hours; a refresh hands out a new refresh token, which the caller keeps.
 */
export function createCalendlyOAuth({ clientId, clientSecret }: OAuthClient, { fetch: doFetch = fetch, timeoutMs = 8000 } = {}): CalendarOAuth {
  const basic = { authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` }
  return {
    name: 'calendly',
    scopes: CALENDLY_SCOPES,
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(`${CALENDLY_AUTH}/authorize`)
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
      }).toString()
      return url.toString()
    },
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      tokenRequest('calendly', 'connect', `${CALENDLY_AUTH}/token`, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }, doFetch, timeoutMs, basic),
    refresh: refreshToken =>
      tokenRequest('calendly', 'refresh access', `${CALENDLY_AUTH}/token`, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, doFetch, timeoutMs, basic),
    async revoke(token) {
      const res = await doFetch(`${CALENDLY_AUTH}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...basic },
        body: new URLSearchParams({ token, client_id: clientId, client_secret: clientSecret }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return res.ok
    },
    async accountEmail(accessToken) {
      const res = await doFetch(`${CALENDLY_API}users/me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) })
      const body = (await res.json().catch(() => ({}))) as Json
      const email = body?.resource?.email
      if (!res.ok || typeof email !== 'string') throw new CalendarError('calendly', res.status === 401 ? 'auth' : 'invalid', `reading the account failed (${res.status})`, res.status)
      return email
    },
  }
}

const DAY_MS = 86_400_000
/** Calendly answers available times for at most a week per request. */
const CHUNK_MS = 7 * DAY_MS
const E164 = /^\+[1-9]\d{6,14}$/

const reasonOf = (body: Json) => cleanReason(body.message ?? body.title)
function forbidden(body: Json): { kind: CalendarErrorKind; message?: string } {
  return {
    kind: 'invalid',
    message: `Calendly refused it${cleanReason(body.message) ? `: ${cleanReason(body.message)}` : ''}`,
  }
}

type EventType = {
  uri: string
  name: string
  duration: number
  locations: Json[]
  questions: Json[]
  poolingType: string | null
}

/** Where the appointment is, in the form the event type's first location wants it. */
function locationFor(type: EventType, event: Pick<CalendarEventInput, 'location' | 'attendee'>): Json | undefined {
  // Calendly picks the location itself for round-robin event types.
  if (type.poolingType === 'round_robin') return undefined
  const first = type.locations[0]
  if (!first?.kind) return undefined
  const phone = event.attendee?.phone && E164.test(event.attendee.phone) ? event.attendee.phone : undefined
  switch (first.kind) {
    case 'physical':
    case 'custom':
      return { kind: first.kind, location: String(first.location ?? '') }
    case 'ask_invitee':
      return { kind: 'ask_invitee', location: event.location || phone || 'By phone' }
    case 'outbound_call':
      if (!phone)
        throw new CalendarError(
          'calendly',
          'invalid',
          "book failed: this Calendly event type calls the invitee, and the caller's number is not known",
        )
      return { kind: 'outbound_call', location: phone }
    default:
      return { kind: first.kind }
  }
}

/**
 * Answers for the event type's questions: the reason (with phone and address) goes into the first free-text question,
 * the caller's number into a phone question. A required question the assistant cannot answer stops the booking.
 */
function answersFor(type: EventType, event: Pick<CalendarEventInput, 'description' | 'attendee'>): Json[] {
  const enabled = type.questions.filter(q => q.enabled !== false)
  const text = enabled.find(q => q.type === 'text' || q.type === 'string')
  const phoneQuestion = enabled.find(q => q.type === 'phone_number')
  const answers: Json[] = []
  if (text)
    answers.push({
      question: String(text.name),
      answer: event.description.slice(0, 1000),
      position: Number(text.position ?? 0),
    })
  if (phoneQuestion && event.attendee?.phone)
    answers.push({
      question: String(phoneQuestion.name),
      answer: event.attendee.phone,
      position: Number(phoneQuestion.position ?? 0),
    })
  const missing = enabled.find(q => q.required && !answers.some(a => a.question === q.name))
  if (missing)
    throw new CalendarError(
      'calendly',
      'invalid',
      `book failed: the Calendly event type asks "${cleanReason(missing.name) ?? 'a question'}", which the assistant cannot answer. Make it optional in Calendly.`,
    )
  return answers
}

export function createCalendlyCalendar(options: CalendlyOptions): CalendarProvider {
  const { timeZone = 'UTC', fetch: doFetch, timeoutMs = 8000 } = options
  const server = 'login' in options ? options.login.serverUrl : CALENDLY_API
  const base = new URL(server.endsWith('/') ? server : `${server}/`)
  const request = createHttp({
    provider: 'calendly',
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
  /** A URI Calendly gave us, only on Calendly's API host (the guarded fetch checks it again). */
  const own = (uri: string, what: string) => {
    let url: URL
    try {
      url = new URL(uri)
    } catch {
      throw new CalendarError('calendly', 'not_found', `${what} failed: that is no Calendly address`)
    }
    if (url.origin !== base.origin)
      throw new CalendarError('calendly', 'not_found', `${what} failed: that is no Calendly address`)
    return url.toString()
  }

  let me: Promise<{ uri: string; email: string }> | null = null
  const user = () => {
    me ??= request('read the account', { url: api('users/me') }).then(body => ({
      uri: String(body?.resource?.uri ?? ''),
      email: String(body?.resource?.email ?? ''),
    }))
    me.catch(() => {
      me = null
    })
    return me
  }

  const types = new Map<string, Promise<EventType>>()
  function eventType(uri: string): Promise<EventType> {
    let found = types.get(uri)
    if (!found) {
      found = request('read the event type', { url: own(uri, 'read the event type') }).then(body => {
        const r = body?.resource ?? {}
        return {
          uri,
          name: String(r.name ?? ''),
          duration: Number(r.duration) || 30,
          locations: r.locations ?? [],
          questions: r.custom_questions ?? [],
          poolingType: r.pooling_type ?? null,
        }
      })
      found.catch(() => types.delete(uri))
      types.set(uri, found)
    }
    return found
  }

  async function getEvent(eventId: string) {
    try {
      const body = await request('read the booking', { url: own(eventId, 'read the booking') })
      const r = body?.resource
      if (!r) return null
      return {
        id: eventId,
        title: String(r.name ?? ''),
        start: new Date(r.start_time).toISOString(),
        end: new Date(r.end_time).toISOString(),
        cancelled: r.status === 'canceled',
      }
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'not_found') return null
      throw e
    }
  }

  async function book(
    calendarId: string,
    start: string,
    details: {
      name: string
      email: string
      event: Pick<CalendarEventInput, 'description' | 'location' | 'attendee'>
      answers?: Json[]
      location?: Json
    },
  ) {
    const type = await eventType(calendarId)
    const location = details.location ?? locationFor(type, details.event)
    const body = await request('book', {
      method: 'POST',
      url: api('invitees'),
      body: {
        event_type: type.uri,
        start_time: new Date(start).toISOString(),
        invitee: { name: details.name, email: details.email, timezone: timeZone },
        ...(location && { location }),
        questions_and_answers: details.answers ?? answersFor(type, details.event),
      },
    })
    const event = body?.resource?.event
    if (typeof event !== 'string' || !event)
      throw new CalendarError('calendly', 'invalid', 'book failed: Calendly returned no booking')
    return { id: event }
  }

  async function cancel(eventId: string, reason: string) {
    try {
      await request('cancel the booking', {
        method: 'POST',
        url: `${own(eventId, 'cancel the booking')}/cancellation`,
        body: { reason },
      })
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'not_found') return
      // Cancelling a booking that is cancelled (or gone) already is fine; anything else is not.
      if (!(e instanceof CalendarError && e.kind === 'invalid')) throw e
      const now = await getEvent(eventId)
      if (now && !now.cancelled) throw e
    }
  }

  return {
    name: 'calendly',

    async accountEmail() {
      return (await user()).email
    },

    async listCalendars() {
      const { uri } = await user()
      const body = await request('list event types', {
        url: api('event_types', { user: uri, active: 'true', count: '100' }),
      })
      const list = (Array.isArray(body?.collection) ? body.collection : []) as Json[]
      return list
        .filter(t => t.active !== false && typeof t.uri === 'string')
        .map((t, i) => ({
          id: String(t.uri),
          name: String(t.name ?? 'Event'),
          primary: i === 0,
          canWrite: true,
          durationMin: Number(t.duration) > 0 ? Number(t.duration) : 30,
        }))
    },

    async busy() {
      return []
    },

    async slots(calendarId: string, window: Interval) {
      const eventTypeUri = own(calendarId, 'check availability')
      // Calendly refuses ranges in the past: from a minute from now at the earliest.
      let from = Math.max(Date.parse(window.start), Date.now() + 60_000)
      const to = Date.parse(window.end)
      const starts: string[] = []
      while (from < to) {
        const until = Math.min(from + CHUNK_MS, to)
        const body = await request('check availability', {
          url: api('event_type_available_times', {
            event_type: eventTypeUri,
            start_time: new Date(from).toISOString(),
            end_time: new Date(until).toISOString(),
          }),
        })
        for (const t of (Array.isArray(body?.collection) ? body.collection : []) as Json[]) {
          if (t.status === 'available' && typeof t.start_time === 'string' && !Number.isNaN(Date.parse(t.start_time)))
            starts.push(new Date(t.start_time).toISOString())
        }
        from = until
      }
      return starts
    },

    async createEvent(calendarId, event) {
      const { email } = await user()
      return book(calendarId, event.start, {
        name: event.attendee?.name || event.title,
        // Calendly needs an address: without the caller's, the business's own gets the confirmation.
        email: event.attendee?.email || email,
        event,
      })
    },

    async updateEvent(calendarId, eventId, changes) {
      if (!changes.start) return
      // Calendly cannot move a booking: the same invitee is booked at the new time, then the old booking is cancelled.
      const body = await request('read the booking', { url: `${own(eventId, 'read the booking')}/invitees` })
      const invitee = ((Array.isArray(body?.collection) ? body.collection : []) as Json[]).find(
        i => i.status === 'active',
      )
      if (!invitee)
        throw new CalendarError('calendly', 'not_found', 'move the booking failed: it has no invitee any more')
      const old = await request('read the booking', { url: own(eventId, 'read the booking') })
      const location = old?.resource?.location?.type
        ? {
            kind: old.resource.location.type,
            ...(old.resource.location.location && { location: old.resource.location.location }),
          }
        : undefined
      const moved = await book(calendarId, changes.start, {
        name: String(invitee.name ?? ''),
        email: String(invitee.email ?? ''),
        event: { description: '', attendee: {} },
        answers: ((invitee.questions_and_answers ?? []) as Json[]).map(q => ({
          question: q.question,
          answer: q.answer,
          position: q.position,
        })),
        location,
      })
      await cancel(eventId, `Moved to ${new Date(changes.start).toISOString()} by phone`)
      return moved
    },

    async deleteEvent(_calendarId, eventId) {
      await cancel(eventId, 'Cancelled by phone')
    },

    getEvent: (_calendarId, eventId) => getEvent(eventId),
  }
}
