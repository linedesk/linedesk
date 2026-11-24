// The CalDAV adapter against an in-memory CalDAV server (iCloud-like: the principal and calendars live on a
// per-account host): the same contract as the Google and Microsoft adapters, plus discovery, recurring events,
// time zones and where the login may go. No request leaves the process.
import { describe, expect, test } from 'vitest'
import { createCalDavCalendar, MAX_EVENT_BYTES, MAX_MULTISTATUS_BYTES } from './caldav.ts'
import { findAll, MAX_XML_CHARS, MAX_XML_ELEMENTS, parseXml } from './dav-xml.ts'
import { busyOf, eventIcs, eventOf, OccurrenceBudgetExceeded } from './ical.ts'
import { CalendarError } from './provider.ts'

const SERVER = 'https://caldav.icloud.com/'
const HOME = 'https://p42-caldav.icloud.com/123/calendars/'
const USER = 'mike@brightwater.example'
const PASSWORD = 'abcd-efgh-ijkl-mnop'
const login = { serverUrl: SERVER, username: USER, password: PASSWORD }

const event = (uid: string, start: string, end: string, extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${uid}`,
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

/** Every Monday and Wednesday at 9:00 in Portland, but not on 2030-01-09; as stored, and as a server expands it for 2030-01-07. */
const WEEKLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:standup',
  'DTSTART;TZID=America/Los_Angeles:20291203T090000',
  'DTEND;TZID=America/Los_Angeles:20291203T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
  'EXDATE;TZID=America/Los_Angeles:20300109T090000',
  'SUMMARY:Standup',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'DTSTART:20000101T000000Z',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')
const WEEKLY_EXPANDED = event('standup', '20300107T170000Z', '20300107T173000Z', ['RECURRENCE-ID:20300107T170000Z'])

type Stored = { ics: string; etag: string; expanded?: string }
type Calendar = { name: string; write: boolean; comps: string[]; events: Map<string, Stored> }
type Seen = {
  method: string
  url: string
  auth: string | null
  depth: string | null
  ifMatch: string | null
  body: string
}
type Fault = (seen: Seen) => number | 'network' | 'timeout' | undefined

function fakeCalDav({
  expands = true,
  principalAtRoot = true,
  fault,
  homeHref = HOME,
}: {
  expands?: boolean
  principalAtRoot?: boolean
  fault?: Fault
  homeHref?: string
} = {}) {
  let etag = 1
  const stored = (ics: string, expanded?: string): Stored => ({ ics, etag: `"e${etag++}"`, expanded })
  const calendars = new Map<string, Calendar>([
    [
      `${HOME}main/`,
      {
        name: 'Mike Brennan',
        write: true,
        comps: ['VEVENT'],
        events: new Map([
          ['job.ics', stored(event('job', '20300107T170000Z', '20300107T180000Z'))],
          ['overlap.ics', stored(event('overlap', '20300107T173000Z', '20300107T190000Z'))],
          ['lunch.ics', stored(event('lunch', '20300107T200000Z', '20300107T210000Z', ['TRANSP:TRANSPARENT']))],
          ['dropped.ics', stored(event('dropped', '20300107T220000Z', '20300107T230000Z', ['STATUS:CANCELLED']))],
        ]),
      },
    ],
    [
      `${HOME}office/`,
      {
        name: 'Office',
        write: true,
        comps: ['VEVENT', 'VTODO'],
        events: new Map([
          // 14:00 in Portland is 22:00 UTC.
          [
            'estimate.ics',
            stored(
              event('estimate', '20300107T140000', '20300107T150000')
                .replace(/DTSTART:/, 'DTSTART;TZID=America/Los_Angeles:')
                .replace(/DTEND:/, 'DTEND;TZID=America/Los_Angeles:'),
            ),
          ],
        ]),
      },
    ],
    [`${HOME}holidays/`, { name: 'Holidays', write: false, comps: ['VEVENT'], events: new Map() }],
    [`${HOME}reminders/`, { name: 'Reminders', write: true, comps: ['VTODO'], events: new Map() }],
    [
      `${HOME}team/`,
      {
        name: 'Team',
        write: true,
        comps: ['VEVENT'],
        events: new Map([['standup.ics', stored(WEEKLY, WEEKLY_EXPANDED)]]),
      },
    ],
  ])
  const seen: Seen[] = []
  const xml = (body: string, status = 207) =>
    new Response(
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`,
      { status, headers: { 'content-type': 'application/xml' } },
    )
  const ok = (href: string, props: string) =>
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:getctag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const req: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      auth: headers.get('authorization'),
      depth: headers.get('depth'),
      ifMatch: headers.get('if-match'),
      body: String(init?.body ?? ''),
    }
    seen.push(req)
    const f = fault?.(req)
    if (f === 'network') throw new TypeError('fetch failed')
    if (f === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (f) return new Response('fault', { status: f })
    if (req.auth !== `Basic ${btoa(`${USER}:${PASSWORD}`)}`) return new Response('Unauthorized', { status: 401 })
    const url = new URL(req.url)
    const path = url.toString()
    if (req.method === 'PROPFIND' && (path === SERVER ? principalAtRoot : path === `${SERVER}.well-known/caldav`)) {
      return xml(
        ok(
          '/',
          '<D:current-user-principal><D:href>https://p42-caldav.icloud.com:443/123/principal/</D:href></D:current-user-principal>',
        ),
      )
    }
    if (req.method === 'PROPFIND' && path === SERVER)
      return xml(
        '<D:response><D:href>/</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>',
      )
    if (req.method === 'PROPFIND' && path === 'https://p42-caldav.icloud.com/123/principal/') {
      return xml(
        ok(
          '/123/principal/',
          `<C:calendar-home-set><D:href>${homeHref.replace('https://p42-caldav.icloud.com', '')}</D:href></C:calendar-home-set>`,
        ),
      )
    }
    if (req.method === 'PROPFIND' && path === HOME && req.depth === '1') {
      const rows = [...calendars].map(([href, c]) =>
        ok(
          new URL(href).pathname,
          [
            '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
            `<D:displayname>${c.name.replace('&', '&amp;')}</D:displayname>`,
            `<C:supported-calendar-component-set>${c.comps.map(n => `<C:comp name="${n}"/>`).join('')}</C:supported-calendar-component-set>`,
            `<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>${c.write ? '<D:privilege><D:write/></D:privilege>' : ''}</D:current-user-privilege-set>`,
          ].join(''),
        ),
      )
      return xml(ok('/123/calendars/', '<D:resourcetype><D:collection/></D:resourcetype>') + rows.join(''))
    }
    const calendarPath = path.replace(/[^/]+\.ics$/, '')
    const calendar = calendars.get(calendarPath)
    if (!calendar) return new Response('Not Found', { status: 404 })
    if (req.method === 'REPORT') {
      expect(req.body).toContain('<c:time-range start="')
      const rows = [...calendar.events].map(([name, e]) =>
        ok(
          `${new URL(calendarPath).pathname}${name}`,
          `<D:getetag>${e.etag}</D:getetag><C:calendar-data><![CDATA[${expands && e.expanded ? e.expanded : e.ics}]]></C:calendar-data>`,
        ),
      )
      return xml(rows.join(''))
    }
    const name = path.slice(calendarPath.length)
    const existing = calendar.events.get(name)
    if (req.method === 'PUT') {
      if (!calendar.write) return new Response('Forbidden', { status: 403 })
      if (headers.get('if-none-match') === '*' && existing) return new Response(null, { status: 412 })
      if (req.ifMatch && req.ifMatch !== existing?.etag) return new Response(null, { status: 412 })
      calendar.events.set(name, stored(req.body))
      return new Response(null, { status: existing ? 204 : 201 })
    }
    if (!existing) return new Response('Not Found', { status: 404 })
    if (req.method === 'GET')
      return new Response(existing.ics, { headers: { etag: existing.etag, 'content-type': 'text/calendar' } })
    if (req.method === 'DELETE') {
      calendar.events.delete(name)
      return new Response(null, { status: 204 })
    }
    return new Response('unexpected', { status: 400 })
  }
  return { fetch, seen, calendars }
}

const make = (options?: Parameters<typeof fakeCalDav>[0], password = PASSWORD) => {
  const server = fakeCalDav(options)
  return { ...server, provider: createCalDavCalendar({ login: { ...login, password }, fetch: server.fetch }) }
}
const window = { start: '2030-01-07T00:00:00.000Z', end: '2030-01-08T00:00:00.000Z' }
const MAIN = `${HOME}main/`
const OFFICE = `${HOME}office/`

describe('caldav calendar contract', () => {
  test('lists the event calendars: name, primary, writable; a reminders list is left out', async () => {
    const { provider } = make()
    expect(await provider.listCalendars()).toEqual([
      { id: MAIN, name: 'Mike Brennan', primary: true, canWrite: true },
      { id: OFFICE, name: 'Office', primary: false, canWrite: true },
      { id: `${HOME}holidays/`, name: 'Holidays', primary: false, canWrite: false },
      { id: `${HOME}team/`, name: 'Team', primary: false, canWrite: true },
    ])
  })

  test('busy: overlapping events merged, free and cancelled ones left out, time zones, several calendars at once', async () => {
    const { provider } = make()
    expect(await provider.busy([MAIN], window)).toEqual([
      { start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T19:00:00.000Z' },
    ])
    expect(await provider.busy([MAIN, OFFICE], window)).toEqual([
      { start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T19:00:00.000Z' },
      { start: '2030-01-07T22:00:00.000Z', end: '2030-01-07T23:00:00.000Z' },
    ])
    expect(await provider.busy([], window)).toEqual([])
    const clipped = await provider.busy([MAIN], { start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T18:30:00.000Z' })
    expect(clipped).toEqual([{ start: '2030-01-07T17:30:00.000Z', end: '2030-01-07T18:30:00.000Z' }])
  })

  test('busy for a calendar that does not exist is a not_found error', async () => {
    const { provider } = make()
    await expect(provider.busy([`${HOME}nope/`], window)).rejects.toMatchObject({ kind: 'not_found' })
  })

  test('create, read, update and delete an event; deleting twice is fine', async () => {
    const { provider, seen } = make()
    const { id } = await provider.createEvent(OFFICE, {
      title: 'Repair visit · Sam Patel',
      description: 'Water heater; leaking, again\nCall first',
      start: '2030-01-08T18:00:00.000Z',
      end: '2030-01-08T19:00:00.000Z',
      location: '12 Oak St, Portland',
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', url: `${OFFICE}${id}.ics` })
    expect(await provider.getEvent(OFFICE, id)).toEqual({
      id,
      title: 'Repair visit · Sam Patel',
      start: '2030-01-08T18:00:00.000Z',
      end: '2030-01-08T19:00:00.000Z',
      cancelled: false,
    })
    expect(
      await provider.busy([OFFICE], { start: '2030-01-08T00:00:00.000Z', end: '2030-01-09T00:00:00.000Z' }),
    ).toEqual([{ start: '2030-01-08T18:00:00.000Z', end: '2030-01-08T19:00:00.000Z' }])
    await provider.updateEvent(OFFICE, id, { start: '2030-01-08T20:00:00.000Z', end: '2030-01-08T21:00:00.000Z' })
    // The change goes only over the version just read, and keeps everything else.
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', ifMatch: expect.stringMatching(/^"e\d+"$/) })
    expect(eventOf(seen.at(-1)!.body)).toMatchObject({
      uid: id,
      title: 'Repair visit · Sam Patel',
      description: 'Water heater; leaking, again\nCall first',
      location: '12 Oak St, Portland',
      sequence: 1,
    })
    expect(await provider.getEvent(OFFICE, id)).toMatchObject({
      start: '2030-01-08T20:00:00.000Z',
      end: '2030-01-08T21:00:00.000Z',
    })
    await provider.deleteEvent(OFFICE, id)
    expect(await provider.getEvent(OFFICE, id)).toBeNull()
    await expect(provider.deleteEvent(OFFICE, id)).resolves.toBeUndefined()
    await expect(provider.updateEvent(OFFICE, id, { title: 'x' })).rejects.toMatchObject({ kind: 'not_found' })
  })

  test('a refused password is an auth error that names no password', async () => {
    const { provider } = make({}, 'my-apple-id-password')
    const error = await provider.listCalendars().catch(e => e)
    expect(error).toBeInstanceOf(CalendarError)
    expect(error).toMatchObject({ kind: 'auth', status: 401, provider: 'caldav' })
    expect(String(error.message)).not.toContain('my-apple-id-password')
  })

  test("errors carry our words and the status only, never the server's text", async () => {
    const leaky: typeof fetch = async () =>
      new Response('<secret>body</secret>', {
        status: 401,
        statusText: 'Nope <script>',
        headers: { 'www-authenticate': 'Basic realm="x"' },
      })
    const error = await createCalDavCalendar({ login, fetch: leaky })
      .listCalendars()
      .catch(e => e)
    expect(error.message).toBe('CalDAV: find the account failed: the server did not accept the user name and password')
    const odd: typeof fetch = async () =>
      new Response('<secret>body</secret>', { status: 418, statusText: 'Nope <script>' })
    expect(
      (
        await createCalDavCalendar({ login, fetch: odd })
          .busy([MAIN], window)
          .catch(e => e)
      ).message,
    ).toBe('CalDAV: check availability failed: the server answered 418')
  })

  test('a read-only calendar refuses events: invalid, and says so', async () => {
    const { provider } = make()
    const error = await provider
      .createEvent(`${HOME}holidays/`, {
        title: 't',
        description: '',
        start: '2030-01-08T18:00:00.000Z',
        end: '2030-01-08T19:00:00.000Z',
      })
      .catch(e => e)
    expect(error).toMatchObject({ kind: 'invalid', status: 403 })
    expect(error.message).toContain('read-only')
  })

  test('server errors map to kinds: 429 rate limited, 5xx, network and timeouts unavailable, 400 invalid', async () => {
    const cases = [
      [429, 'rate_limited'],
      [503, 'unavailable'],
      ['network', 'unavailable'],
      ['timeout', 'unavailable'],
      [400, 'invalid'],
    ] as const
    for (const [fault, kind] of cases) {
      const { provider } = make({ fault: () => fault })
      await expect(provider.listCalendars(), String(fault)).rejects.toMatchObject({ kind })
    }
    const { provider } = make({ fault: () => 'timeout' })
    await expect(provider.busy([OFFICE], window)).rejects.toThrow(/longer than/)
  })
})

describe('caldav specifics', () => {
  test('discovery: principal and calendar home are read once, then calendars are addressed directly', async () => {
    const { provider, seen } = make()
    await provider.listCalendars()
    await provider.listCalendars()
    expect(seen.map(s => `${s.method} ${s.url} ${s.depth}`)).toEqual([
      `PROPFIND ${SERVER} 0`,
      'PROPFIND https://p42-caldav.icloud.com/123/principal/ 0',
      `PROPFIND ${HOME} 1`,
      `PROPFIND ${HOME} 1`,
    ])
    seen.length = 0
    await provider.busy([MAIN], window)
    expect(seen.map(s => `${s.method} ${s.url} ${s.depth}`)).toEqual([`REPORT ${MAIN} 1`])
  })

  test('a server without the principal at its address is asked at /.well-known/caldav', async () => {
    const { provider } = make({ principalAtRoot: false })
    expect(await provider.listCalendars()).toHaveLength(4)
  })

  test('the login never goes to another site, whatever the server answers', async () => {
    const { provider, seen } = make({ homeHref: 'https://evil.example/steal/' })
    await expect(provider.listCalendars()).rejects.toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('not the server you entered'),
    })
    expect(seen.some(s => s.url.includes('evil'))).toBe(false)
    await expect(provider.busy(['https://evil.example/cal/'], window)).rejects.toMatchObject({ kind: 'invalid' })
    expect(seen.some(s => s.url.includes('evil'))).toBe(false)
  })

  test('a recurring event: the same busy times whether the server expands it or not', async () => {
    const monday = { start: '2030-01-07T00:00:00.000Z', end: '2030-01-10T00:00:00.000Z' }
    const expanded = await make({ expands: true }).provider.busy([`${HOME}team/`], window)
    expect(expanded).toEqual([{ start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T17:30:00.000Z' }])
    // Expanded here: Monday at 9:00 Pacific (17:00 UTC), and Wednesday's is excluded.
    expect(await make({ expands: false }).provider.busy([`${HOME}team/`], monday)).toEqual(expanded)
  })

  test('the request asks the server to expand recurrences in the window', async () => {
    const { provider, seen } = make()
    await provider.busy([MAIN], window)
    expect(seen[0]!.body).toContain('<c:expand start="20300107T000000Z" end="20300108T000000Z"/>')
  })
})

describe('iCalendar', () => {
  const day = (date: string) => ({ start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.000Z` })

  test('a written event reads back as written, with escaped text and folded long lines', () => {
    const description = `Reason: ${'a long, long story; '.repeat(8)}\nPhone: +1 503 555 0199`
    const ics = eventIcs({
      uid: 'u1',
      title: 'Repair · Ana Núñez',
      description,
      start: '2030-01-08T18:00:00Z',
      end: '2030-01-08T19:00:00Z',
    })
    expect(ics.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true)
    expect(eventOf(ics)).toMatchObject({
      uid: 'u1',
      title: 'Repair · Ana Núñez',
      description,
      start: '2030-01-08T18:00:00.000Z',
      end: '2030-01-08T19:00:00.000Z',
      cancelled: false,
    })
  })

  test('DURATION instead of DTEND; an all-day event takes its day', () => {
    expect(
      busyOf(event('d', '20300107T170000Z', '', ['DURATION:PT1H30M']).replace('DTEND:\r\n', ''), day('2030-01-07')),
    ).toEqual([{ start: '2030-01-07T17:00:00.000Z', end: '2030-01-07T18:30:00.000Z' }])
    const allDay = [
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART;VALUE=DATE:20300107',
      'DTEND;VALUE=DATE:20300108',
      'END:VEVENT',
    ].join('\r\n')
    expect(busyOf(allDay, day('2030-01-07'), 'America/Los_Angeles')).toEqual([
      { start: '2030-01-07T08:00:00.000Z', end: '2030-01-08T08:00:00.000Z' },
    ])
  })

  test('recurrences: COUNT, UNTIL, INTERVAL, a moved instance, and a rule read as every day when not understood', () => {
    const daily = (rule: string, extra: string[] = []) =>
      [
        'BEGIN:VEVENT',
        'UID:r',
        'DTSTART:20300101T100000Z',
        'DTEND:20300101T110000Z',
        `RRULE:${rule}`,
        'END:VEVENT',
        ...extra,
      ].join('\r\n')
    const week = { start: '2030-01-01T00:00:00.000Z', end: '2030-01-08T00:00:00.000Z' }
    const starts = (text: string) => busyOf(text, week).map(b => b.start.slice(5, 10))
    expect(starts(daily('FREQ=DAILY;COUNT=3'))).toEqual(['01-01', '01-02', '01-03'])
    expect(starts(daily('FREQ=DAILY;UNTIL=20300102T235959Z'))).toEqual(['01-01', '01-02'])
    expect(starts(daily('FREQ=DAILY;INTERVAL=3'))).toEqual(['01-01', '01-04', '01-07'])
    const moved = [
      'BEGIN:VEVENT',
      'UID:r',
      'RECURRENCE-ID:20300102T100000Z',
      'DTSTART:20300102T150000Z',
      'DTEND:20300102T160000Z',
      'END:VEVENT',
    ]
    expect(busyOf(daily('FREQ=DAILY;COUNT=2', moved), week).map(b => b.start)).toEqual([
      '2030-01-01T10:00:00.000Z',
      '2030-01-02T15:00:00.000Z',
    ])
    expect(starts(daily('FREQ=MONTHLY;BYDAY=1WE'))).toEqual([
      '01-01',
      '01-02',
      '01-03',
      '01-04',
      '01-05',
      '01-06',
      '01-07',
    ])
  })

  test('an event that has repeated daily for years still shows in the window', () => {
    const old = [
      'BEGIN:VEVENT',
      'UID:o',
      'DTSTART:20100101T100000Z',
      'DTEND:20100101T110000Z',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
    ].join('\r\n')
    expect(busyOf(old, day('2030-01-07'))).toEqual([
      { start: '2030-01-07T10:00:00.000Z', end: '2030-01-07T11:00:00.000Z' },
    ])
  })
})

/**
 * Time limits of the tests below: on CI (GitHub's standard runners for the public repository are about half as fast
 * as a developer machine) three times the room. Each limit still catches the bug it is for: a parser or expansion
 * that grows with the square of the input takes minutes there, not seconds.
 */
// No Node types in this package (it also runs in the browser): the environment through globalThis.
const onCi = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI)
const slow = (ms: number) => (onCi ? ms * 3 : ms)

describe('a hostile or broken server cannot hold up the API', () => {
  const day = (date: string) => ({ start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.000Z` })
  const answer =
    (body: string, status = 207): typeof fetch =>
    async () =>
      new Response(body, { status, headers: { 'content-type': 'application/xml' } })

  test('attribute-heavy and deeply nested XML is read in linear time or refused', () => {
    const attrs = `<a ${'x="'.repeat(200_000)}>`
    let t = performance.now()
    expect(() => parseXml(`<d:multistatus xmlns:d="DAV:">${attrs}</a></d:multistatus>`)).not.toThrow()
    expect(performance.now() - t).toBeLessThan(slow(500))
    const many = `<d:multistatus xmlns:d="DAV:">${'<d:response x="1" y=\'2\' z = "3"><d:href>/a</d:href></d:response>'.repeat(20_000)}</d:multistatus>`
    t = performance.now()
    expect(findAll(parseXml(many), 'response')).toHaveLength(20_000)
    expect(performance.now() - t).toBeLessThan(slow(2000))
    expect(() => parseXml('<a>'.repeat(100))).toThrow(/too deeply/)
    expect(() => parseXml(`<a>${'x'.repeat(MAX_XML_CHARS)}</a>`)).toThrow(/too large/)
  })

  test('an answer with more elements than the cap is refused before the tree grows', () => {
    const t = performance.now()
    expect(() => parseXml(`<m>${'<a/>'.repeat(MAX_XML_ELEMENTS + 1)}</m>`)).toThrow(/too many elements/)
    expect(performance.now() - t).toBeLessThan(slow(500))
  })

  test('an answer over the cap is refused, not read to the end', async () => {
    const huge = `<d:multistatus xmlns:d="DAV:">${' '.repeat(MAX_MULTISTATUS_BYTES)}</d:multistatus>`
    const provider = createCalDavCalendar({ login, fetch: answer(huge) })
    await expect(provider.busy([MAIN], window)).rejects.toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('larger than'),
    })
    const bigEvent = createCalDavCalendar({ login, fetch: answer('x'.repeat(MAX_EVENT_BYTES + 1), 200) })
    await expect(bigEvent.getEvent(MAIN, 'e')).rejects.toMatchObject({ kind: 'invalid' })
  })

  test('many repeating events with COUNT or unknown zones stop at the budget, quickly, as unavailable', async () => {
    const series = (i: number) =>
      [
        'BEGIN:VEVENT',
        `UID:s${i}`,
        'DTSTART;TZID=Not/AZone:20100101T090000',
        'DTEND;TZID=Not/AZone:20100101T100000',
        'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=999999',
        'END:VEVENT',
      ].join('\r\n')
    const ics = `BEGIN:VCALENDAR\r\n${Array.from({ length: 2000 }, (_, i) => series(i)).join('\r\n')}\r\nEND:VCALENDAR`
    const body = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/a.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[${ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
    const t = performance.now()
    const error = await createCalDavCalendar({ login, fetch: answer(body) })
      .busy([MAIN], { start: '2030-01-01T00:00:00Z', end: '2030-03-01T00:00:00Z' })
      .catch(e => e)
    expect(error).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('repeating events') })
    expect(performance.now() - t).toBeLessThan(slow(3000))
    // A budget of its own per check: the next check starts afresh.
    const budget = { left: 5 }
    expect(() => busyOf(series(1), window, 'UTC', budget)).toThrow(OccurrenceBudgetExceeded)
  })

  test('EXDATE: values far from the window are not converted, and more than the cap fail the check quickly', () => {
    const lines = (n: number, year = 2010) =>
      Array.from(
        { length: n },
        (_, i) => `EXDATE;TZID=America/New_York:${year}${String((i % 12) + 1).padStart(2, '0')}01T090000`,
      )
    const event = (exdates: string[]) =>
      [
        'BEGIN:VEVENT',
        'UID:x',
        'DTSTART:20300107T100000Z',
        'DTEND:20300107T110000Z',
        'RRULE:FREQ=DAILY',
        ...exdates,
        'END:VEVENT',
      ].join('\r\n')
    let t = performance.now()
    expect(busyOf(event(lines(900)), day('2030-01-07'))).toHaveLength(1)
    expect(performance.now() - t).toBeLessThan(slow(500))
    t = performance.now()
    expect(() => busyOf(event(lines(300_000)), day('2030-01-07'))).toThrow(OccurrenceBudgetExceeded)
    expect(performance.now() - t).toBeLessThan(slow(2000))
    // An excluded date in the window still takes the occurrence out.
    expect(busyOf(event(['EXDATE:20300107T100000Z']), day('2030-01-07'))).toEqual([])
  })

  test('many events with broken dates or unknown zones each cost budget; past the cap of events the check fails', () => {
    const broken = (i: number) =>
      [
        'BEGIN:VEVENT',
        `UID:b${i}`,
        `DTSTART;TZID=Nowhere/Zone${i}:20300107T100000`,
        'DTEND:garbage',
        `RECURRENCE-ID;TZID=Nowhere/Zone${i}:20300107T100000`,
        'END:VEVENT',
      ].join('\r\n')
    let t = performance.now()
    expect(busyOf(Array.from({ length: 3000 }, (_, i) => broken(i)).join('\r\n'), day('2030-01-07'))).toEqual([])
    expect(performance.now() - t).toBeLessThan(slow(1500))
    t = performance.now()
    expect(() => busyOf(Array.from({ length: 6000 }, (_, i) => broken(i)).join('\r\n'), day('2030-01-07'))).toThrow(
      OccurrenceBudgetExceeded,
    )
    expect(performance.now() - t).toBeLessThan(slow(1500))
  })

  test('monthly on the 31st since 1700: skipped by arithmetic, the right months, within the budget', () => {
    const series = (i: number) =>
      [
        'BEGIN:VEVENT',
        `UID:m${i}`,
        'DTSTART:17000131T100000Z',
        'DTEND:17000131T110000Z',
        'RRULE:FREQ=MONTHLY',
        'END:VEVENT',
      ].join('\r\n')
    const budget = { left: 20_000 }
    const busy = busyOf(
      Array.from({ length: 6 }, (_, i) => series(i)).join('\r\n'),
      { start: '2030-01-01T00:00:00Z', end: '2030-05-01T00:00:00Z' },
      'UTC',
      budget,
    )
    // January, March: the 31st; February and April have none.
    expect([...new Set(busy.map(b => b.start.slice(0, 10)))]).toEqual(['2030-01-31', '2030-03-31'])
    expect(budget.left).toBeGreaterThan(19_800)
    const yearly = [
      'BEGIN:VEVENT',
      'UID:y',
      'DTSTART:17000101T100000Z',
      'DTEND:17000101T110000Z',
      'RRULE:FREQ=YEARLY;INTERVAL=4',
      'END:VEVENT',
    ].join('\r\n')
    // 1700 + 4n: 2028, 2032 (no 2030).
    expect(
      busyOf(yearly, { start: '2028-01-01T00:00:00Z', end: '2033-01-02T00:00:00Z' }).map(b => b.start.slice(0, 10)),
    ).toEqual(['2028-01-01', '2032-01-01'])
  })

  test('a daily series with COUNT that began years ago still shows when it reaches the window', () => {
    const old = [
      'BEGIN:VEVENT',
      'UID:o',
      'DTSTART:20100101T100000Z',
      'DTEND:20100101T110000Z',
      'RRULE:FREQ=DAILY;COUNT=7313',
      'END:VEVENT',
    ].join('\r\n')
    // 2010-01-01 + 7312 days = 2030-01-08: the 7313th and last. 2030-01-09 has none.
    expect(busyOf(old, { start: '2030-01-08T00:00:00Z', end: '2030-01-10T00:00:00Z' }).map(b => b.start)).toEqual([
      '2030-01-08T10:00:00.000Z',
    ])
    const weekly = [
      'BEGIN:VEVENT',
      'UID:w',
      'DTSTART:20100104T100000Z',
      'DTEND:20100104T110000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2086',
      'END:VEVENT',
    ].join('\r\n')
    // Mondays and Wednesdays from 2010-01-04: 2029-12-24 is the 2085th, 2029-12-26 the 2086th and last.
    expect(
      busyOf(weekly, { start: '2029-12-24T00:00:00Z', end: '2030-01-03T00:00:00Z' }).map(b => b.start.slice(0, 10)),
    ).toEqual(['2029-12-24', '2029-12-26'])
    const byDay = [
      'BEGIN:VEVENT',
      'UID:d',
      'DTSTART:20100101T100000Z',
      'DTEND:20100101T110000Z',
      'RRULE:FREQ=DAILY;BYDAY=FR;INTERVAL=1;COUNT=1046',
      'END:VEVENT',
    ].join('\r\n')
    // Fridays from 2010-01-01 (a Friday): 2030-01-04 is the 1045th, 2030-01-11 the 1046th and last.
    expect(
      busyOf(byDay, { start: '2030-01-04T00:00:00Z', end: '2030-01-19T00:00:00Z' }).map(b => b.start.slice(0, 10)),
    ).toEqual(['2030-01-04', '2030-01-11'])
  })

  test('events with dates that do not exist, or absurd rules, are left out instead of failing the check', () => {
    const bad = (start: string, end: string, rule?: string) =>
      [
        'BEGIN:VEVENT',
        'UID:b',
        `DTSTART:${start}`,
        `DTEND:${end}`,
        ...(rule ? [`RRULE:${rule}`] : []),
        'END:VEVENT',
      ].join('\r\n')
    expect(busyOf(bad('20301301T100000Z', '20301301T110000Z'), window)).toEqual([])
    // An unreadable DTEND: the event takes no time (as a timed event without one).
    expect(busyOf(bad('20300107T100000Z', 'garbage'), window)).toEqual([])
    expect(busyOf(bad('20300107T100000Z', '20300107T110000Z', 'FREQ=DAILY;INTERVAL=99999999999999'), window)).toEqual([
      { start: '2030-01-07T10:00:00.000Z', end: '2030-01-07T11:00:00.000Z' },
    ])
    expect(busyOf(bad('20300107T100000Z', '20300107T110000Z', 'FREQ=DAILY;COUNT=-3;UNTIL=nope'), window)).toHaveLength(
      1,
    )
    expect(busyOf(bad('99991231T100000Z', '99991231T110000Z', 'FREQ=YEARLY'), window)).toEqual([])
  })

  test("a bare CR in a caller's words cannot start an iCalendar line of its own", () => {
    const ics = eventIcs({
      uid: 'u',
      title: 'Repair\rATTENDEE:mailto:victim@example.com',
      description: 'a\r\nb\rc\nd\u0007e',
      location: 'x\rORGANIZER:mailto:x@example.com',
      start: '2030-01-08T18:00:00Z',
      end: '2030-01-08T19:00:00Z',
    })
    const lines = ics.replace(/\r\n /g, '').split('\r\n')
    expect(lines.some(l => l.startsWith('ATTENDEE') || l.startsWith('ORGANIZER'))).toBe(false)
    expect([...ics.replace(/\r\n/g, '')].some(c => c === '\r' || c === '\u0007')).toBe(false)
    expect(eventOf(ics)).toMatchObject({
      title: 'Repair\nATTENDEE:mailto:victim@example.com',
      description: 'a\nb\nc\nde',
    })
  })
})
