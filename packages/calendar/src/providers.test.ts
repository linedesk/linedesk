// Calendar adapters against mocked HTTP: no request leaves the process. The same contract runs
// against an in-memory Google and an in-memory Microsoft Graph.
import { describe, expect, test } from 'vitest'
import { createGoogleCalendar, createGoogleOAuth, GOOGLE_CALENDAR_SCOPES } from './google.ts'
import { createMicrosoftCalendar, createMicrosoftOAuth } from './microsoft.ts'
import { type AccessTokenSource, CalendarError, type CalendarProvider, mergeBusy, pkcePair } from './provider.ts'
import { calendarOAuthFromEnv, configuredCalendarProviders } from './providers.ts'

type Stored = { id: string; title: string; start: string; end: string; free?: boolean; cancelled?: boolean; description?: string }
type Account = { calendars: { id: string; name: string; primary?: boolean; write?: boolean }[]; events: Record<string, Stored[]> }
type Seen = { method: string; url: URL; auth: string | null; body: unknown }
/** Makes a request fail: return a status (or 'network', 'timeout') for the request, undefined to answer normally. */
type Fault = (seen: Seen) => number | 'network' | 'timeout' | { status: number; body: unknown } | undefined

const TOKEN = 'secret-access-token'
const FRESH = 'fresh-access-token'

const account = (): Account => ({
  calendars: [
    { id: 'main@example.com', name: 'Mike Brennan', primary: true, write: true },
    { id: 'office', name: 'Office', write: true },
    { id: 'holidays', name: 'Holidays', write: false },
  ],
  events: {
    'main@example.com': [
      { id: 'e1', title: 'Job', start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T18:00:00.000Z' },
      { id: 'e2', title: 'Overlap', start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T19:00:00.000Z' },
      { id: 'e3', title: 'Lunch (free)', start: '2030-01-07T20:00:00.000Z', end: '2030-01-07T21:00:00.000Z', free: true },
    ],
    office: [{ id: 'o1', title: 'Estimate', start: '2030-01-07T22:00:00.000Z', end: '2030-01-07T23:00:00.000Z' }],
    holidays: [],
  },
})

const json = (body: unknown, status = 200) => Response.json(body, { status })
const overlaps = (e: Stored, from: string, to: string) => Date.parse(e.start) < Date.parse(to) && Date.parse(e.end) > Date.parse(from)

/** Shared plumbing of both fakes: request log, token check, faults. */
function fakeServer(route: (seen: Seen, state: Account) => Response, fault?: Fault, valid = [TOKEN, FRESH]) {
  const state = account()
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const req: Seen = { method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body }
    seen.push(req)
    const f = fault?.(req)
    if (f === 'network') throw new TypeError('fetch failed')
    if (f === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (typeof f === 'object') return json(f.body, f.status)
    if (f) return json({ error: { message: `fault ${f}` } }, f)
    if (!valid.some(t => req.auth === `Bearer ${t}`)) return json({ error: { message: 'Invalid Credentials' } }, 401)
    return route(req, state)
  }
  return { fetch, seen, state }
}

function fakeGoogle(fault?: Fault, valid?: string[]) {
  let next = 100
  return fakeServer(({ method, url, body }, state) => {
    const path = decodeURIComponent(url.pathname)
    if (method === 'GET' && path === '/calendar/v3/users/me/calendarList') {
      return json({ items: state.calendars.map(c => ({ id: c.id, summary: c.name, primary: c.primary, accessRole: c.write ? 'owner' : 'reader' })) })
    }
    if (method === 'POST' && path === '/calendar/v3/freeBusy') {
      const { timeMin, timeMax, items } = body as { timeMin: string; timeMax: string; items: { id: string }[] }
      const calendars = Object.fromEntries(items.map(({ id }) => [id, state.events[id]
        ? { busy: state.events[id]!.filter(e => !e.free && !e.cancelled && overlaps(e, timeMin, timeMax)).map(e => ({ start: e.start, end: e.end })) }
        : { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }]))
      return json({ kind: 'calendar#freeBusy', calendars })
    }
    const m = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
    const events = m && state.events[m[1]!]
    if (!m || !events) return json({ error: { message: 'Not Found' } }, 404)
    const event = m[2] ? events.find(e => e.id === m[2]) : undefined
    const out = (e: Stored) => ({ id: e.id, summary: e.title, start: { dateTime: e.start }, end: { dateTime: e.end }, status: e.cancelled ? 'cancelled' : 'confirmed' })
    const b = body as { summary?: string; description?: string; start?: { dateTime: string }; end?: { dateTime: string } }
    if (method === 'POST' && !m[2]) {
      const created = { id: `g${next++}`, title: b.summary!, description: b.description, start: new Date(b.start!.dateTime).toISOString(), end: new Date(b.end!.dateTime).toISOString() }
      events.push(created)
      return json(out(created))
    }
    if (!event) return json({ error: { message: 'Not Found' } }, method === 'DELETE' ? 410 : 404)
    if (method === 'GET') return json(out(event))
    if (method === 'PATCH') {
      Object.assign(event, b.summary && { title: b.summary }, b.start && { start: new Date(b.start.dateTime).toISOString() }, b.end && { end: new Date(b.end.dateTime).toISOString() })
      return json(out(event))
    }
    if (method === 'DELETE') {
      events.splice(events.indexOf(event), 1)
      return new Response(null, { status: 204 })
    }
    return json({ error: { message: 'unexpected' } }, 400)
  }, fault, valid)
}

function fakeGraph(fault?: Fault, valid?: string[]) {
  let next = 100
  const noZ = (iso: string) => `${iso.replace(/\.\d+Z$|Z$/, '')}.0000000`
  return fakeServer(({ method, url, body }, state) => {
    const path = decodeURIComponent(url.pathname)
    const out = (e: Stored) => ({ id: e.id, subject: e.title, start: { dateTime: noZ(e.start), timeZone: 'UTC' }, end: { dateTime: noZ(e.end), timeZone: 'UTC' }, showAs: e.free ? 'free' : 'busy', isCancelled: !!e.cancelled })
    if (method === 'GET' && path === '/v1.0/me/calendars') {
      return json({ value: state.calendars.map(c => ({ id: c.id, name: c.name, isDefaultCalendar: !!c.primary, canEdit: !!c.write })) })
    }
    const view = path.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/)
    if (method === 'GET' && view) {
      const events = state.events[view[1]!]
      if (!events) return json({ error: { message: 'The specified object was not found in the store.' } }, 404)
      const from = url.searchParams.get('startDateTime')!
      const to = url.searchParams.get('endDateTime')!
      // Two pages, to exercise @odata.nextLink.
      const hits = events.filter(e => overlaps(e, from, to)).map(out)
      if (url.searchParams.get('page') === '2') return json({ value: hits.slice(1) })
      const nextLink = new URL(url)
      nextLink.searchParams.set('page', '2')
      return json({ value: hits.slice(0, 1), ...(hits.length > 1 && { '@odata.nextLink': nextLink.toString() }) })
    }
    const create = path.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/events$/)
    const b = body as { subject?: string; start?: { dateTime: string }; end?: { dateTime: string } }
    const iso = (t: { dateTime: string }) => new Date(`${t.dateTime}Z`).toISOString()
    if (method === 'POST' && create) {
      const events = state.events[create[1]!]
      if (!events) return json({ error: { message: 'not found' } }, 404)
      const created = { id: `m${next++}`, title: b.subject!, start: iso(b.start!), end: iso(b.end!) }
      events.push(created)
      return json(out(created), 201)
    }
    const one = path.match(/^\/v1\.0\/me\/events\/([^/]+)$/)
    const all = Object.values(state.events)
    const owner = one && all.find(list => list.some(e => e.id === one[1]))
    const event = owner?.find(e => e.id === one![1])
    if (!event || !owner) return json({ error: { message: 'The specified object was not found in the store.' } }, 404)
    if (method === 'GET') return json(out(event))
    if (method === 'PATCH') {
      Object.assign(event, b.subject && { title: b.subject }, b.start && { start: iso(b.start) }, b.end && { end: iso(b.end) })
      return json(out(event))
    }
    if (method === 'DELETE') {
      owner.splice(owner.indexOf(event), 1)
      return new Response(null, { status: 204 })
    }
    return json({ error: { message: 'unexpected' } }, 400)
  }, fault, valid)
}

/** Hands out TOKEN, and FRESH once asked to refresh; counts the refreshes. */
function tokens(): AccessTokenSource & { refreshed: number } {
  const source = Object.assign(async (force?: boolean) => {
    if (force) source.refreshed++
    return source.refreshed ? FRESH : TOKEN
  }, { refreshed: 0 })
  return source
}

type Make = (fault?: Fault, valid?: string[]) => { provider: CalendarProvider; seen: Seen[]; source: ReturnType<typeof tokens> }
/** The provider's own 403 bodies: throttled, a token without the calendar scope, a write to a read-only calendar. */
type Forbidden = { rateLimited: unknown; noScope: unknown; readOnly: unknown }
const window = { start: '2030-01-07T00:00:00.000Z', end: '2030-01-08T00:00:00.000Z' }

function describeContract(name: string, make: Make, forbidden: Forbidden) {
  describe(`${name} calendar contract`, () => {
    test('lists calendars: name, primary, writable', async () => {
      const { provider } = make()
      expect(await provider.listCalendars()).toEqual([
        { id: 'main@example.com', name: 'Mike Brennan', primary: true, canWrite: true },
        { id: 'office', name: 'Office', primary: false, canWrite: true },
        { id: 'holidays', name: 'Holidays', primary: false, canWrite: false },
      ])
    })

    test('busy: overlapping events merged, free ones left out, several calendars at once', async () => {
      const { provider } = make()
      expect(await provider.busy(['main@example.com'], window)).toEqual([{ start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T19:00:00.000Z' }])
      expect(await provider.busy(['main@example.com', 'office'], window)).toEqual([
        { start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T19:00:00.000Z' },
        { start: '2030-01-07T22:00:00.000Z', end: '2030-01-07T23:00:00.000Z' },
      ])
      expect(await provider.busy([], window)).toEqual([])
      const clipped = await provider.busy(['main@example.com'], { start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T18:30:00.000Z' })
      expect(clipped).toEqual([{ start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T18:30:00.000Z' }])
    })

    test('busy for a calendar that does not exist is a not_found error', async () => {
      const { provider } = make()
      await expect(provider.busy(['nope'], window)).rejects.toMatchObject({ kind: 'not_found' })
    })

    test('create, read, update and delete an event; deleting twice is fine', async () => {
      const { provider } = make()
      const { id } = await provider.createEvent('office', { title: 'Repair visit · Sam Patel', description: 'Water heater', start: '2030-01-08T18:00:00.000Z', end: '2030-01-08T19:00:00.000Z' })
      expect(id).toBeTruthy()
      expect(await provider.getEvent('office', id)).toEqual({ id, title: 'Repair visit · Sam Patel', start: '2030-01-08T18:00:00.000Z', end: '2030-01-08T19:00:00.000Z', cancelled: false })
      expect(await provider.busy(['office'], { start: '2030-01-08T00:00:00.000Z', end: '2030-01-09T00:00:00.000Z' })).toEqual([{ start: '2030-01-08T18:00:00.000Z', end: '2030-01-08T19:00:00.000Z' }])
      await provider.updateEvent('office', id, { start: '2030-01-08T20:00:00.000Z', end: '2030-01-08T21:00:00.000Z' })
      expect(await provider.getEvent('office', id)).toMatchObject({ start: '2030-01-08T20:00:00.000Z', end: '2030-01-08T21:00:00.000Z' })
      await provider.deleteEvent('office', id)
      expect(await provider.getEvent('office', id)).toBeNull()
      await expect(provider.deleteEvent('office', id)).resolves.toBeUndefined()
    })

    test('a refused token is refreshed once and the request repeated', async () => {
      const { provider, source, seen } = make(undefined, [FRESH])
      expect(await provider.listCalendars()).toHaveLength(3)
      expect(source.refreshed).toBe(1)
      expect(seen.map(s => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH}`])
    })

    test('a token refused after the refresh is an auth error that names no token', async () => {
      const { provider, source } = make(undefined, ['other'])
      const error = await provider.listCalendars().catch(e => e)
      expect(error).toBeInstanceOf(CalendarError)
      expect(error).toMatchObject({ kind: 'auth', status: 401, provider: name })
      expect(source.refreshed).toBe(1)
      expect(String(error.message)).not.toContain(TOKEN)
      expect(String(error.message)).not.toContain(FRESH)
    })

    test('a 403 is classified by its reason: throttled is rate_limited, a missing scope auth, a read-only calendar invalid', async () => {
      const event = { title: 't', description: '', start: '2030-01-08T18:00:00.000Z', end: '2030-01-08T19:00:00.000Z' }
      const throttled = make(() => ({ status: 403, body: forbidden.rateLimited })).provider
      await expect(throttled.busy(['office'], window)).rejects.toMatchObject({ kind: 'rate_limited', status: 403 })
      const unscoped = make(() => ({ status: 403, body: forbidden.noScope })).provider
      await expect(unscoped.listCalendars()).rejects.toMatchObject({ kind: 'auth', status: 403 })
      const readOnly = make(s => (s.method === 'POST' && !s.url.pathname.endsWith('freeBusy') ? { status: 403, body: forbidden.readOnly } : undefined)).provider
      const error = await readOnly.createEvent('holidays', event).catch(e => e)
      expect(error).toMatchObject({ kind: 'invalid', status: 403 })
      expect(error.message).toContain('read-only')
    })

    test('provider errors map to kinds: 403 without a known reason invalid, 429 rate limited, 5xx, network and timeouts unavailable', async () => {
      const cases = [[403, 'invalid'], [429, 'rate_limited'], [503, 'unavailable'], ['network', 'unavailable'], ['timeout', 'unavailable'], [400, 'invalid']] as const
      for (const [fault, kind] of cases) {
        const { provider } = make(() => fault)
        await expect(provider.listCalendars(), String(fault)).rejects.toMatchObject({ kind })
      }
      const { provider } = make(() => 'timeout')
      await expect(provider.busy(['office'], window)).rejects.toThrow(/longer than/)
    })
  })
}

describeContract('google', (fault, valid) => {
  const { fetch, seen } = fakeGoogle(fault, valid)
  const source = tokens()
  return { provider: createGoogleCalendar({ accessToken: source, fetch }), seen, source }
}, {
  rateLimited: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } },
  noScope: { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }], errors: [{ reason: 'insufficientPermissions' }] } },
  readOnly: { error: { code: 403, message: 'You need to have writer access to this calendar.', errors: [{ domain: 'calendar', reason: 'requiredAccessLevel' }] } },
})

describeContract('microsoft', (fault, valid) => {
  const { fetch, seen } = fakeGraph(fault, valid)
  const source = tokens()
  return { provider: createMicrosoftCalendar({ accessToken: source, fetch }), seen, source }
}, {
  rateLimited: { error: { code: 'ErrorQuotaExceeded', message: 'The mailbox has exceeded its quota.' } },
  noScope: { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } },
  readOnly: { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } },
})

describe('google specifics', () => {
  test('one freeBusy request for several calendars', async () => {
    const { fetch, seen } = fakeGoogle()
    await createGoogleCalendar({ accessToken: tokens(), fetch }).busy(['main@example.com', 'office'], window)
    expect(seen.map(s => `${s.method} ${s.url.pathname}`)).toEqual(['POST /calendar/v3/freeBusy'])
    expect(seen[0]!.body).toEqual({ timeMin: window.start, timeMax: window.end, items: [{ id: 'main@example.com' }, { id: 'office' }] })
  })
})

describe('microsoft specifics', () => {
  test('calendarView is read in UTC and follows the next page', async () => {
    const { fetch, seen } = fakeGraph()
    await createMicrosoftCalendar({ accessToken: tokens(), fetch }).busy(['main@example.com'], window)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.url.searchParams.get('page')).toBe('2')
  })
})

describe('OAuth', () => {
  const client = { clientId: 'client-id', clientSecret: 'client-secret' }
  const form = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init?.body)))

  test('Google consent URL: offline access, PKCE, state, calendar scopes only', () => {
    const url = new URL(createGoogleOAuth(client).authorizeUrl({ redirectUri: 'https://app.test/v1/calendar/callback/google', state: 'st', codeChallenge: 'ch' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-id', redirect_uri: 'https://app.test/v1/calendar/callback/google', response_type: 'code', access_type: 'offline',
      state: 'st', code_challenge: 'ch', code_challenge_method: 'S256', scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    })
    expect(url.searchParams.get('scope')).not.toMatch(/gmail|drive|auth\/calendar(\s|$)/)
  })

  test('Microsoft consent URL: tenant, offline_access, Calendars.ReadWrite, PKCE', () => {
    const url = new URL(createMicrosoftOAuth({ ...client, tenantId: 'common' }).authorizeUrl({ redirectUri: 'https://app.test/cb', state: 'st', codeChallenge: 'ch' }))
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('scope')).toBe('openid email offline_access User.Read Calendars.ReadWrite')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('code exchange sends the verifier and returns tokens with an expiry', async () => {
    let sent: Record<string, string> = {}
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      sent = form(init)
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'x y' })
    }
    const tokensOut = await createGoogleOAuth(client, { fetch }).exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb', codeVerifier: 'v' })
    expect(sent).toMatchObject({ code: 'c', code_verifier: 'v', grant_type: 'authorization_code', client_secret: 'client-secret' })
    expect(tokensOut).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope: 'x y' })
    expect(Date.parse(tokensOut.expiresAt) - Date.now()).toBeGreaterThan(3500_000)
  })

  test('a revoked refresh token (invalid_grant) is an auth error', async () => {
    const fetch: typeof globalThis.fetch = async () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
    await expect(createGoogleOAuth(client, { fetch }).refresh('rt')).rejects.toMatchObject({ kind: 'auth', message: 'Google: refresh access failed: Token has been expired or revoked.' })
    await expect(createMicrosoftOAuth(client, { fetch }).refresh('rt')).rejects.toMatchObject({ kind: 'auth' })
  })

  test('Google revokes at its endpoint; Microsoft has none and says so', async () => {
    const urls: string[] = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      urls.push(`${url} ${form(init).token}`)
      return new Response(null, { status: 200 })
    }
    expect(await createGoogleOAuth(client, { fetch }).revoke('rt')).toBe(true)
    expect(urls).toEqual(['https://oauth2.googleapis.com/revoke rt'])
    expect(await createMicrosoftOAuth(client, { fetch }).revoke('rt')).toBe(false)
  })

  test('the providers on offer follow the sign-in apps in env', () => {
    expect(configuredCalendarProviders({})).toEqual([])
    expect(configuredCalendarProviders({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', MICROSOFT_CLIENT_ID: 'c' })).toEqual(['google'])
    const ms = calendarOAuthFromEnv('microsoft', { MICROSOFT_CLIENT_ID: 'c', MICROSOFT_CLIENT_SECRET: 'd', MICROSOFT_TENANT_ID: 'contoso.onmicrosoft.com' })
    expect(ms?.authorizeUrl({ redirectUri: 'r', state: 's', codeChallenge: 'c' })).toContain('/contoso.onmicrosoft.com/oauth2/')
  })

  test('PKCE: a 43-character verifier and its S256 challenge', async () => {
    const { verifier, challenge } = await pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    expect(challenge).toBe(btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''))
  })
})

test('mergeBusy sorts, merges touching intervals and drops empty ones', () => {
  const w = { start: '2030-01-01T00:00:00Z', end: '2030-01-02T00:00:00Z' }
  expect(mergeBusy([
    { start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z' },
    { start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' },
    { start: '2030-01-01T12:00:00Z', end: '2030-01-01T12:00:00Z' },
    { start: '2029-12-31T23:00:00Z', end: '2030-01-01T01:00:00Z' },
  ], w)).toEqual([
    { start: '2030-01-01T00:00:00.000Z', end: '2030-01-01T01:00:00.000Z' },
    { start: '2030-01-01T09:00:00.000Z', end: '2030-01-01T11:00:00.000Z' },
  ])
})
