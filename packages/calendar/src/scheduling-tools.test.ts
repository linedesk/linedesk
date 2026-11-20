// The Cal.com and Calendly adapters against in-memory servers shaped like their documented APIs (Cal.com API v2,
// Calendly API v2 with the Scheduling API). Both are scheduling tools: they offer start times (`slots`) instead of
// busy times, and book in the caller's name. No request leaves the process.
import { describe, expect, test } from 'vitest'
import { createCalComCalendar, createCalComOAuth } from './calcom.ts'
import { createCalendlyCalendar, createCalendlyOAuth } from './calendly.ts'
import { CalendarError, type CalendarProvider, type Json } from './provider.ts'

type Seen = { method: string; url: URL; auth: string | null; version: string | null; body: Json }
/** `slow`: the server does the request, but the answer comes after the timeout. */
type Fault = (seen: Seen) => number | 'network' | 'timeout' | 'slow' | undefined
const KEY = 'cal_live_0123456789abcdef'
const TOKEN = 'calendly-pat-0123456789'
const json = (body: unknown, status = 200) => Response.json(body, { status })

function recorder(route: (s: Seen) => Response, secret: string, fault?: Fault) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const s: Seen = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      auth: headers.get('authorization'),
      version: headers.get('cal-api-version'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    seen.push(s)
    const f = fault?.(s)
    if (f === 'network') throw new TypeError('fetch failed')
    if (f === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (f && f !== 'slow') return json({ message: `fault <b>${f}</b>`, error: { message: `fault <b>${f}</b>` } }, f)
    if (s.auth !== `Bearer ${secret}`)
      return json(
        {
          status: 'error',
          error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
          title: 'Unauthenticated',
          message: 'The access token is invalid',
        },
        401,
      )
    const res = route(s)
    if (f === 'slow') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return res
  }
  return { fetch, seen }
}

// --- Cal.com ------------------------------------------------------------------------------------------------------

function fakeCalCom(fault?: Fault) {
  const bookings = new Map<
    string,
    {
      uid: string
      title: string
      start: string
      end: string
      status: string
      eventTypeId: number
      attendee: Json
      notes?: string
    }
  >()
  let next = 1
  const types = [
    { id: 101, title: 'Repair visit', slug: 'repair', lengthInMinutes: 60, hidden: false },
    { id: 102, title: 'Estimate', slug: 'estimate', lengthInMinutes: 30, hidden: true },
  ]
  const offered = ['2030-01-07T17:00:00.000Z', '2030-01-07T18:00:00.000Z', '2030-01-08T17:00:00.000Z']
  const server = recorder(
    s => {
      const path = s.url.pathname
      if (s.method === 'GET' && path === '/v2/me')
        return json({
          status: 'success',
          data: { id: 7, email: 'Mike@Brightwater.example', username: 'mike-brennan', timeZone: 'America/Los_Angeles' },
        })
      if (s.method === 'GET' && path === '/v2/event-types') {
        expect(s.version).toBe('2026-06-12')
        expect(s.url.searchParams.get('username')).toBe('mike-brennan')
        return json({ status: 'success', data: types })
      }
      if (s.method === 'GET' && path === '/v2/teams') return json({ status: 'success', data: [{ id: 55, name: 'Brightwater Crew', slug: 'crew' }] })
      if (s.method === 'GET' && path === '/v2/teams/55/event-types') {
        expect(s.version).toBe('2024-06-14')
        return json({ status: 'success', data: [{ id: 201, title: 'Emergency call-out', slug: 'emergency', lengthInMinutes: 90, schedulingType: 'roundRobin' }] })
      }
      if (s.method === 'GET' && path === '/v2/slots') {
        expect(s.version).toBe('2024-09-04')
        if (!types.some(t => String(t.id) === s.url.searchParams.get('eventTypeId')))
          return json({ status: 'error', error: { message: 'Event type not found' } }, 404)
        const [lo, hi] = [Date.parse(s.url.searchParams.get('start')!), Date.parse(s.url.searchParams.get('end')!)]
        const taken = new Set([...bookings.values()].filter(b => b.status === 'accepted').map(b => b.start))
        const data: Record<string, { start: string; end: string }[]> = {}
        for (const t of offered.filter(t => Date.parse(t) >= lo && Date.parse(t) < hi && !taken.has(t))) {
          const day = t.slice(0, 10)
          data[day] = [
            ...(data[day] ?? []),
            { start: t.replace('.000Z', '.000-00:00'), end: new Date(Date.parse(t) + 3600_000).toISOString() },
          ]
        }
        return json({ status: 'success', data })
      }
      if (s.method === 'POST' && path === '/v2/bookings') {
        expect(s.version).toBe('2026-02-25')
        const type = types.find(t => t.id === s.body.eventTypeId)
        if (!type) return json({ status: 'error', error: { message: 'Event type not found' } }, 404)
        if (String(s.body.attendee?.email).endsWith('@nomail.example'))
          return json({ status: 'error', error: { message: 'This email address cannot receive mail. Please use a valid email.' } }, 400)
        if (!offered.includes(s.body.start))
          return json(
            { status: 'error', error: { message: 'User either already has booking at this time or is not available' } },
            400,
          )
        const uid = `bk-${next++}`
        const booking = {
          uid,
          title: `${type.title} between Mike and ${s.body.attendee.name}`,
          start: s.body.start,
          end: new Date(Date.parse(s.body.start) + type.lengthInMinutes * 60_000).toISOString(),
          status: 'accepted',
          eventTypeId: type.id,
          attendee: s.body.attendee,
          notes: s.body.bookingFieldsResponses?.notes,
        }
        bookings.set(uid, booking)
        return json({ status: 'success', data: { id: next, ...booking } }, 201)
      }
      if (s.method === 'GET' && path === '/v2/bookings') {
        expect(s.version).toBe('2026-02-25')
        const [type, lo, hi] = ['eventTypeId', 'afterStart', 'beforeEnd'].map(k => s.url.searchParams.get(k))
        const data = [...bookings.values()]
          .filter(b => String(b.eventTypeId) === type && Date.parse(b.start) >= Date.parse(lo!) && Date.parse(b.end) <= Date.parse(hi!))
          .map(({ attendee, ...b }) => ({ ...b, attendees: [attendee] }))
        return json({ status: 'success', data })
      }
      const m = path.match(/^\/v2\/bookings\/([^/]+)(?:\/(reschedule|cancel))?$/)
      const b = m && bookings.get(decodeURIComponent(m[1]!))
      if (!m || !b) return json({ status: 'error', error: { message: 'Booking not found' } }, 404)
      expect(s.version).toBe('2026-02-25')
      if (s.method === 'GET' && !m[2]) return json({ status: 'success', data: b })
      if (s.method === 'POST' && m[2] === 'cancel') {
        if (b.status === 'cancelled')
          return json({ status: 'error', error: { message: 'This booking has already been cancelled.' } }, 400)
        b.status = 'cancelled'
        return json({ status: 'success', data: b })
      }
      if (s.method === 'POST' && m[2] === 'reschedule') {
        const uid = `bk-${next++}`
        const moved = {
          ...b,
          uid,
          start: s.body.start,
          end: new Date(Date.parse(s.body.start) + 3600_000).toISOString(),
          status: 'accepted',
        }
        b.status = 'cancelled'
        bookings.set(uid, moved)
        return json({ status: 'success', data: { ...moved, rescheduledFromUid: b.uid } }, 201)
      }
      return json({ status: 'error' }, 400)
    },
    KEY,
    fault,
  )
  return { ...server, bookings }
}

// --- Calendly -----------------------------------------------------------------------------------------------------

const API = 'https://api.calendly.com'
function fakeCalendly(
  fault?: Fault,
  { requiredSelect = false, location = { kind: 'physical', location: '12 Oak St, Portland' } as Json } = {},
) {
  const events = new Map<
    string,
    {
      uri: string
      name: string
      start_time: string
      end_time: string
      status: string
      location: Json | null
      invitee: Json
    }
  >()
  let next = 1
  const typeUri = `${API}/event_types/ET-REPAIR`
  const types = [
    {
      uri: typeUri,
      name: 'Repair visit',
      duration: 60,
      active: true,
      pooling_type: null,
      locations: location ? [location] : null,
      custom_questions: [
        { name: 'What do you need help with?', type: 'text', position: 0, enabled: true, required: true },
        { name: 'Best number to reach you', type: 'phone_number', position: 1, enabled: true, required: false },
        ...(requiredSelect
          ? [{ name: 'Which service?', type: 'single_select', position: 2, enabled: true, required: true }]
          : []),
      ],
    },
    {
      uri: `${API}/event_types/ET-OFF`,
      name: 'Old type',
      duration: 30,
      active: false,
      locations: [],
      custom_questions: [],
    },
  ]
  const offered = ['2030-01-07T17:00:00.000000Z', '2030-01-07T18:00:00.000000Z', '2030-01-09T17:00:00.000000Z']
  const server = recorder(
    s => {
      const url = s.url.toString().split('?')[0]!
      if (s.method === 'GET' && url === `${API}/users/me`)
        return json({
          resource: { uri: `${API}/users/U1`, email: 'mike@brightwater.example', timezone: 'America/Los_Angeles' },
        })
      if (s.method === 'GET' && url === `${API}/event_types`) {
        expect(s.url.searchParams.get('user')).toBe(`${API}/users/U1`)
        return json({
          collection: types.filter(t => s.url.searchParams.get('active') !== 'true' || t.active),
          pagination: {},
        })
      }
      const type = types.find(t => t.uri === url)
      if (s.method === 'GET' && type) return json({ resource: type })
      if (s.method === 'GET' && url === `${API}/event_type_available_times`) {
        if (!types.some(t => t.uri === s.url.searchParams.get('event_type')))
          return json(
            { title: 'Resource Not Found', message: 'The server could not find the requested resource.' },
            404,
          )
        const [lo, hi] = [
          Date.parse(s.url.searchParams.get('start_time')!),
          Date.parse(s.url.searchParams.get('end_time')!),
        ]
        if (lo < Date.now() || hi - lo > 7 * 86_400_000)
          return json({ title: 'Invalid Argument', message: 'The supplied parameters are invalid.' }, 400)
        const taken = new Set(
          [...events.values()].filter(e => e.status === 'active').map(e => Date.parse(e.start_time)),
        )
        return json({
          collection: offered
            .filter(t => Date.parse(t) >= lo && Date.parse(t) < hi && !taken.has(Date.parse(t)))
            .map(t => ({
              status: 'available',
              invitees_remaining: 1,
              start_time: t,
              scheduling_url: 'https://calendly.com/x',
            })),
        })
      }
      if (s.method === 'POST' && url === `${API}/invitees`) {
        const t = types.find(x => x.uri === s.body.event_type)
        if (!t)
          return json(
            { title: 'Resource Not Found', message: 'The server could not find the requested resource.' },
            404,
          )
        if (!s.body.invitee?.email || !s.body.invitee?.timezone)
          return json({ title: 'Invalid Argument', message: 'email is required' }, 400)
        if (!offered.some(o => Date.parse(o) === Date.parse(s.body.start_time)))
          return json({ title: 'Invalid Argument', message: 'The selected time is no longer available.' }, 400)
        const missing = t.custom_questions.find(
          q => q.required && !s.body.questions_and_answers?.some((a: Json) => a.question === q.name),
        )
        if (missing) return json({ title: 'Invalid Argument', message: `Missing answer: ${missing.name}` }, 400)
        const uuid = `EV${next++}`
        const ev = {
          uri: `${API}/scheduled_events/${uuid}`,
          name: t.name,
          start_time: s.body.start_time,
          end_time: new Date(Date.parse(s.body.start_time) + t.duration * 60_000).toISOString(),
          status: 'active',
          location: s.body.location ? { type: s.body.location.kind, location: s.body.location.location } : null,
          invitee: { ...s.body.invitee, questions_and_answers: s.body.questions_and_answers, status: 'active' },
        }
        events.set(ev.uri, ev)
        return json(
          {
            resource: {
              uri: `${ev.uri}/invitees/IN${next}`,
              event: ev.uri,
              status: 'active',
              cancel_url: 'x',
              reschedule_url: 'y',
            },
          },
          201,
        )
      }
      const m = url.match(/^(https:\/\/api\.calendly\.com\/scheduled_events\/[^/]+)(?:\/(invitees|cancellation))?$/)
      const ev = m && events.get(m[1]!)
      if (!m || !ev)
        return json({ title: 'Resource Not Found', message: 'The server could not find the requested resource.' }, 404)
      if (s.method === 'GET' && !m[2]) return json({ resource: ev })
      if (s.method === 'GET' && m[2] === 'invitees') return json({ collection: [ev.invitee] })
      if (s.method === 'POST' && m[2] === 'cancellation') {
        if (ev.status === 'canceled')
          return json({ title: 'Permission Denied', message: 'Event is already canceled' }, 403)
        ev.status = 'canceled'
        ev.invitee.status = 'canceled'
        return json({ resource: { canceled_by: 'Mike', reason: s.body?.reason } }, 201)
      }
      return json({ title: 'Invalid' }, 400)
    },
    TOKEN,
    fault,
  )
  return { ...server, events, typeUri }
}

// --- The shared contract ------------------------------------------------------------------------------------------

type Make = (fault?: Fault, secret?: string) => { provider: CalendarProvider; seen: Seen[] }
const window = { start: '2030-01-07T00:00:00.000Z', end: '2030-01-10T00:00:00.000Z' }

function describeTool(name: 'calcom' | 'calendly', make: Make, ids: { type: string; unknown: string }) {
  describe(`${name} scheduling tool contract`, () => {
    test('the account and its event types; busy is left to slots', async () => {
      const { provider } = make()
      expect(await provider.accountEmail!()).toMatch(/^mike@brightwater\.example$/i)
      const list = await provider.listCalendars()
      expect(list[0]).toMatchObject({ id: ids.type, name: 'Repair visit', primary: true, canWrite: true, durationMin: 60 })
      expect(await provider.busy([ids.type], window)).toEqual([])
    })

    test('slots: the start times the tool offers in the window, as UTC instants', async () => {
      const { provider } = make()
      const slots = await provider.slots!(ids.type, window)
      expect(slots).toContain('2030-01-07T17:00:00.000Z')
      expect(slots).toContain('2030-01-07T18:00:00.000Z')
      expect(slots.every(s => s.endsWith('.000Z'))).toBe(true)
      expect(
        await provider.slots!(ids.type, { start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T18:30:00.000Z' }),
      ).toEqual(['2030-01-07T18:00:00.000Z'])
    })

    test("book in the caller's name, read, move (a new id), cancel; cancelling twice is fine", async () => {
      const { provider } = make()
      const { id } = await provider.createEvent(ids.type, {
        title: 'Repair visit · Sam Patel',
        description: 'Water heater leaking\nPhone: +15035550177',
        start: '2030-01-07T17:00:00.000Z',
        end: '2030-01-07T18:00:00.000Z',
        location: '12 Oak St, Portland',
        attendee: { name: 'Sam Patel', email: 'sam@brightwater.example', phone: '+15035550177' },
      })
      expect(await provider.getEvent(ids.type, id)).toMatchObject({
        id,
        start: '2030-01-07T17:00:00.000Z',
        end: '2030-01-07T18:00:00.000Z',
        cancelled: false,
      })
      // The booked time is no longer offered.
      expect(await provider.slots!(ids.type, window)).not.toContain('2030-01-07T17:00:00.000Z')
      const moved = await provider.updateEvent(ids.type, id, {
        start: '2030-01-07T18:00:00.000Z',
        end: '2030-01-07T19:00:00.000Z',
      })
      expect(moved?.id).toBeTruthy()
      expect(moved!.id).not.toBe(id)
      expect(await provider.getEvent(ids.type, moved!.id)).toMatchObject({
        start: '2030-01-07T18:00:00.000Z',
        cancelled: false,
      })
      expect((await provider.getEvent(ids.type, id))?.cancelled).toBe(true)
      await provider.deleteEvent(ids.type, moved!.id)
      expect((await provider.getEvent(ids.type, moved!.id))?.cancelled).toBe(true)
      await expect(provider.deleteEvent(ids.type, moved!.id)).resolves.toBeUndefined()
    })

    test('a time the tool does not offer is refused as invalid, with its reason cleaned of markup', async () => {
      const { provider } = make()
      const error = await provider
        .createEvent(ids.type, {
          title: 'x',
          description: '',
          start: '2030-01-07T17:15:00.000Z',
          end: '2030-01-07T18:15:00.000Z',
          attendee: { name: 'Sam' },
        })
        .catch(e => e)
      expect(error).toBeInstanceOf(CalendarError)
      expect(error).toMatchObject({ kind: 'invalid', provider: name })
    })

    test('a refused key is an auth error that names no key; an unknown event type is not_found', async () => {
      const { provider } = make(undefined, 'wrong')
      const error = await provider.listCalendars().catch(e => e)
      expect(error).toMatchObject({ kind: 'auth', status: 401 })
      expect(error.message).not.toContain(KEY)
      expect(error.message).not.toContain(TOKEN)
      await expect(make().provider.slots!(ids.unknown, window)).rejects.toMatchObject({ kind: 'not_found' })
    })

    test('errors map to kinds and never carry markup: 429, 5xx, network, timeout', async () => {
      for (const [fault, kind] of [
        [429, 'rate_limited'],
        [503, 'unavailable'],
        ['network', 'unavailable'],
        ['timeout', 'unavailable'],
        [400, 'invalid'],
      ] as const) {
        const error = await make(() => fault)
          .provider.listCalendars()
          .catch(e => e)
        expect(error, String(fault)).toMatchObject({ kind })
        expect(error.message).not.toMatch(/[<>]/)
      }
    })
  })
}

describeTool(
  'calcom',
  (fault, secret = KEY) => {
    const { fetch, seen } = fakeCalCom(fault)
    return {
      provider: createCalComCalendar({
        login: { serverUrl: 'https://api.cal.com/', username: '', password: secret },
        timeZone: 'America/Los_Angeles',
        fetch,
      }),
      seen,
    }
  },
  { type: '101', unknown: '999' },
)

describeTool(
  'calendly',
  (fault, secret = TOKEN) => {
    const { fetch, seen } = fakeCalendly(fault)
    return {
      provider: createCalendlyCalendar({
        login: { serverUrl: 'https://api.calendly.com/', username: '', password: secret },
        timeZone: 'America/Los_Angeles',
        fetch,
      }),
      seen,
    }
  },
  { type: `${API}/event_types/ET-REPAIR`, unknown: `${API}/event_types/NOPE` },
)

describe('cal.com specifics', () => {
  const make = () => {
    const server = fakeCalCom()
    return {
      ...server,
      provider: createCalComCalendar({
        login: { serverUrl: 'https://api.cal.com/', username: '', password: KEY },
        timeZone: 'America/Los_Angeles',
        fetch: server.fetch,
      }),
    }
  }

  test("the booking carries the caller's name, number, time zone and the reason as notes; without an address the account's", async () => {
    const { provider, bookings } = make()
    await provider.createEvent('101', {
      title: 'Repair visit · Sam Patel',
      description: 'Leak under the sink',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam Patel', phone: '+15035550177' },
    })
    const [b] = [...bookings.values()]
    expect(b!.attendee).toEqual({
      name: 'Sam Patel',
      email: 'Mike@Brightwater.example',
      timeZone: 'America/Los_Angeles',
      phoneNumber: '+15035550177',
    })
    expect(b!.notes).toBe('Leak under the sink')
  })

  test('a booking Cal.com answers after the timeout but makes anyway is the one returned, not left behind', async () => {
    const server = fakeCalCom(s => (s.method === 'POST' && s.url.pathname === '/v2/bookings' ? 'slow' : undefined))
    const provider = createCalComCalendar({
      login: { serverUrl: 'https://api.cal.com/', username: '', password: KEY },
      timeZone: 'America/Los_Angeles',
      fetch: server.fetch,
    })
    const event = { title: 'Repair visit · Sam Patel', description: 'Leak', start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T18:00:00.000Z', attendee: { name: 'Sam Patel' } }
    expect(await provider.createEvent('101', event)).toEqual({ id: 'bk-1' })
    expect(server.bookings.size).toBe(1)
    // Timed out with nothing made: the failure stands.
    const down = fakeCalCom(s => (s.method === 'POST' && s.url.pathname === '/v2/bookings' ? 'timeout' : undefined))
    const failing = createCalComCalendar({
      login: { serverUrl: 'https://api.cal.com/', username: '', password: KEY },
      timeZone: 'America/Los_Angeles',
      fetch: down.fetch,
    })
    await expect(failing.createEvent('101', event)).rejects.toThrow(/longer than/)
  })

  test("an address Cal.com refuses (no mail server) books under the account's, with the caller's in the notes", async () => {
    const { provider, bookings } = make()
    await provider.createEvent('101', {
      title: 'Repair visit · Sam Patel',
      description: 'Leak under the sink',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam Patel', email: 'sam@nomail.example' },
    })
    const [b] = [...bookings.values()]
    expect(b!.attendee.email).toBe('Mike@Brightwater.example')
    expect(b!.notes).toBe('Leak under the sink\nEmail given by the caller: sam@nomail.example')
  })

  test('a number that is not E.164 is left out; the event type list is asked for the account by its user name', async () => {
    const { provider, bookings, seen } = make()
    await provider.listCalendars()
    expect(seen.map(s => `${s.method} ${s.url.pathname}`)).toEqual(['GET /v2/me', 'GET /v2/event-types', 'GET /v2/teams', 'GET /v2/teams/55/event-types'])
    await provider.createEvent('101', {
      title: 'x',
      description: '',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam', phone: 'anonymous' },
    })
    expect([...bookings.values()][0]!.attendee.phoneNumber).toBeUndefined()
  })

  test("the event types of the account's teams follow its own, each under its team; without teams, its own only", async () => {
    const { fetch } = fakeCalCom()
    const login = { serverUrl: 'https://api.cal.com/', username: '', password: KEY }
    const list = await createCalComCalendar({ login, fetch }).listCalendars()
    expect(list.map(c => [c.id, c.group, c.primary])).toEqual([
      ['101', undefined, true],
      ['102', undefined, false],
      ['201', 'Brightwater Crew', false],
    ])
    expect(list[2]).toMatchObject({ name: 'Emergency call-out', canWrite: true, durationMin: 90 })
    // No team access (an API key without teams, a grant from before the team scopes): the account's own types.
    const noTeams: typeof fetch = (input, init) =>
      String(input).includes('/v2/teams') ? Promise.resolve(json({ status: 'error', error: { message: 'Forbidden' } }, 403)) : fetch(input, init)
    expect((await createCalComCalendar({ login, fetch: noTeams }).listCalendars()).map(c => c.id)).toEqual(['101', '102'])
  })

  test("cloud only: always Cal.com's own API, also when a stored login names another server", async () => {
    const server = fakeCalCom()
    const seen: string[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push(String(input))
      return server.fetch(String(input), init)
    }
    await createCalComCalendar({
      login: { serverUrl: 'https://cal.brightwater.example/api', username: '', password: KEY },
      fetch,
    }).listCalendars()
    expect(seen.every(url => url.startsWith('https://api.cal.com/v2/'))).toBe(true)
  })
})

describe('calendly specifics', () => {
  const make = (options?: Parameters<typeof fakeCalendly>[1]) => {
    const server = fakeCalendly(undefined, options)
    return {
      ...server,
      provider: createCalendlyCalendar({
        login: { serverUrl: 'https://api.calendly.com/', username: '', password: TOKEN },
        timeZone: 'America/Los_Angeles',
        fetch: server.fetch,
      }),
    }
  }

  test('only active event types are listed', async () => {
    expect((await make().provider.listCalendars()).map(c => c.name)).toEqual(['Repair visit'])
  })

  test("the invitee: name, address (the account's when the caller gave none), time zone, the reason and number as answers, the event type's location", async () => {
    const { provider, events, typeUri } = make()
    const { id } = await provider.createEvent(typeUri, {
      title: 'Repair visit · Sam Patel',
      description: 'Leak under the sink',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam Patel', phone: '+15035550177' },
    })
    const ev = events.get(id)!
    expect(ev.invitee).toMatchObject({
      name: 'Sam Patel',
      email: 'mike@brightwater.example',
      timezone: 'America/Los_Angeles',
    })
    expect(ev.invitee.questions_and_answers).toEqual([
      { question: 'What do you need help with?', answer: 'Leak under the sink', position: 0 },
      { question: 'Best number to reach you', answer: '+15035550177', position: 1 },
    ])
    expect(ev.location).toEqual({ type: 'physical', location: '12 Oak St, Portland' })
  })

  test('a move keeps the invitee, their answers and the location', async () => {
    const { provider, events, typeUri } = make()
    const { id } = await provider.createEvent(typeUri, {
      title: 'x',
      description: 'Leak',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam Patel', email: 'sam@brightwater.example' },
    })
    const moved = await provider.updateEvent(typeUri, id, { start: '2030-01-09T17:00:00.000Z' })
    expect(events.get(moved!.id)!.invitee).toMatchObject({
      name: 'Sam Patel',
      email: 'sam@brightwater.example',
      questions_and_answers: [{ question: 'What do you need help with?', answer: 'Leak', position: 0 }],
    })
    expect(events.get(moved!.id)!.location).toEqual({ type: 'physical', location: '12 Oak St, Portland' })
    expect(events.get(id)!.status).toBe('canceled')
  })

  test('a move to a time Calendly refuses leaves the old booking as it was', async () => {
    const { provider, events, typeUri } = make()
    const { id } = await provider.createEvent(typeUri, {
      title: 'x',
      description: 'Leak',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      attendee: { name: 'Sam' },
    })
    await expect(provider.updateEvent(typeUri, id, { start: '2030-01-09T03:00:00.000Z' })).rejects.toMatchObject({
      kind: 'invalid',
    })
    expect(events.get(id)!.status).toBe('active')
  })

  test('a required question the assistant cannot answer stops the booking with a reason the owner can act on', async () => {
    const { provider, typeUri, seen } = make({ requiredSelect: true })
    const error = await provider
      .createEvent(typeUri, {
        title: 'x',
        description: 'Leak',
        start: '2030-01-07T17:00:00.000Z',
        end: '2030-01-07T18:00:00.000Z',
        attendee: { name: 'Sam' },
      })
      .catch(e => e)
    expect(error).toMatchObject({ kind: 'invalid', message: expect.stringContaining('Which service') })
    expect(seen.some(s => s.method === 'POST')).toBe(false)
  })

  test('an event type that calls the invitee needs the number; one where the invitee names the place gets the address', async () => {
    const calls = make({ location: { kind: 'outbound_call' } })
    await expect(
      calls.provider.createEvent(calls.typeUri, {
        title: 'x',
        description: 'Leak',
        start: '2030-01-07T17:00:00.000Z',
        end: '2030-01-07T18:00:00.000Z',
        attendee: { name: 'Sam' },
      }),
    ).rejects.toMatchObject({ kind: 'invalid', message: expect.stringContaining('number') })
    const ask = make({ location: { kind: 'ask_invitee' } })
    const { id } = await ask.provider.createEvent(ask.typeUri, {
      title: 'x',
      description: 'Leak',
      start: '2030-01-07T17:00:00.000Z',
      end: '2030-01-07T18:00:00.000Z',
      location: '12 Oak St',
      attendee: { name: 'Sam' },
    })
    expect(ask.events.get(id)!.location).toEqual({ type: 'ask_invitee', location: '12 Oak St' })
  })

  test('available times are asked in pieces of at most a week, never in the past', async () => {
    const { provider, typeUri, seen } = make()
    await provider.slots!(typeUri, {
      start: '2000-01-01T00:00:00.000Z',
      end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    })
    const asked = seen.filter(s => s.url.pathname === '/event_type_available_times')
    expect(asked).toHaveLength(3)
    for (const s of asked) {
      const [lo, hi] = [
        Date.parse(s.url.searchParams.get('start_time')!),
        Date.parse(s.url.searchParams.get('end_time')!),
      ]
      expect(lo).toBeGreaterThan(Date.now())
      expect(hi - lo).toBeLessThanOrEqual(7 * 86_400_000)
    }
  })

  test('URIs that are not on Calendly are never asked for (the token stays on api.calendly.com)', async () => {
    const { provider, seen } = make()
    expect(await provider.getEvent('x', 'https://evil.example/scheduled_events/1')).toBeNull()
    await expect(provider.deleteEvent('x', 'https://evil.example/scheduled_events/1')).resolves.toBeUndefined()
    await expect(provider.slots!('https://evil.example/event_types/1', window)).rejects.toMatchObject({
      kind: 'not_found',
    })
    expect(seen).toHaveLength(0)
  })
})

describe('OAuth of the scheduling tools', () => {
  const client = { clientId: 'cid', clientSecret: 'csecret' }
  type Sent = { url: string; headers: Headers; form: Record<string, string> }
  const recorder = (answer: unknown, status = 200) => {
    const sent: Sent[] = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) })
      return Response.json(answer, { status })
    }
    return { fetch, sent }
  }
  const tokens = { access_token: 'at', refresh_token: 'rt2', expires_in: 7200, token_type: 'Bearer' }

  test('Calendly: consent with PKCE (no scope: the app has its scopes), client as HTTP Basic, rotating refresh tokens, revoke', async () => {
    const url = new URL(createCalendlyOAuth(client).authorizeUrl({ redirectUri: 'https://app.test/v1/calendar/callback/calendly', state: 'st', codeChallenge: 'ch' }))
    expect(url.origin + url.pathname).toBe('https://auth.calendly.com/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'cid', response_type: 'code', redirect_uri: 'https://app.test/v1/calendar/callback/calendly', state: 'st', code_challenge_method: 'S256', code_challenge: 'ch' })
    const { fetch, sent } = recorder(tokens)
    const oauth = createCalendlyOAuth(client, { fetch })
    expect(await oauth.exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb', codeVerifier: 'v' })).toMatchObject({ accessToken: 'at', refreshToken: 'rt2' })
    expect(sent[0]).toMatchObject({ url: 'https://auth.calendly.com/oauth/token', form: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.test/cb', client_id: 'cid', code_verifier: 'v' } })
    expect(sent[0]!.headers.get('authorization')).toBe(`Basic ${btoa('cid:csecret')}`)
    expect(sent[0]!.form.client_secret).toBeUndefined()
    expect(await oauth.refresh('rt1')).toMatchObject({ refreshToken: 'rt2' })
    expect(sent[1]!.form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt1' })
    expect(await oauth.revoke('rt2')).toBe(true)
    expect(sent[2]).toMatchObject({ url: 'https://auth.calendly.com/oauth/revoke', form: { token: 'rt2' } })
  })

  test("Cal.com: consent at app.cal.com with the scopes, tokens at api.cal.com; no revoke; the account's address", async () => {
    const url = new URL(createCalComOAuth(client).authorizeUrl({ redirectUri: 'https://app.test/v1/calendar/callback/calcom', state: 'st', codeChallenge: 'ch' }))
    expect(url.origin + url.pathname).toBe('https://app.cal.com/auth/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe(
      'PROFILE_READ EVENT_TYPE_READ BOOKING_READ BOOKING_WRITE',
    )
    // No PKCE: Cal.com refuses code_verifier for a client without it ("property code_verifier should not exist").
    expect(url.searchParams.has('code_challenge')).toBe(false)
    const { fetch, sent } = recorder(tokens)
    const oauth = createCalComOAuth(client, { fetch })
    await oauth.exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb', codeVerifier: 'v' })
    expect(sent[0]).toMatchObject({ url: 'https://api.cal.com/v2/auth/oauth2/token', form: { grant_type: 'authorization_code', client_id: 'cid', client_secret: 'csecret' } })
    expect(sent[0]!.form).not.toHaveProperty('code_verifier')
    expect(await oauth.revoke('rt')).toBe(false)
    const me = recorder({ status: 'success', data: { email: 'mike@brightwater.example' } })
    expect(await createCalComOAuth(client, { fetch: me.fetch }).accountEmail('at')).toBe('mike@brightwater.example')
    expect(me.sent[0]!.url).toBe('https://api.cal.com/v2/me')
  })

  test('an adapter made with an OAuth token reads the account through the tool’s own API with that token', async () => {
    const seen: string[] = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      seen.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
      return Response.json({ resource: { uri: 'https://api.calendly.com/users/U1', email: 'mike@brightwater.example' } })
    }
    expect(await createCalendlyCalendar({ accessToken: async () => 'oauth-token', fetch }).accountEmail!()).toBe('mike@brightwater.example')
    expect(seen).toEqual(['https://api.calendly.com/users/me Bearer oauth-token'])
  })
})
