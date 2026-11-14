// CalDAV adapter (RFC 4791): iCloud, Fastmail, Nextcloud, Radicale and any other CalDAV server. Plain fetch with HTTP
// Basic over https. Calendars are found from the server address (current-user-principal, calendar-home-set); busy
// times are read from the events themselves (iCloud has no free-busy query), recurring ones expanded by the server
// where it can, else here (ical.ts). An event Linedesk writes is <uid>.ics in the calendar; its id is the uid.
// The login goes only to the site the member entered (`sameSite`), whatever hrefs the server answers with.
// https://www.rfc-editor.org/rfc/rfc4791
import {
  busyOf,
  eventIcs,
  eventOf,
  icalUtc,
  MAX_OCCURRENCES_PER_CHECK,
  type OccurrenceBudget,
  OccurrenceBudgetExceeded,
} from './ical.ts'
import { type XmlNode, childrenNamed, find, findAll, parseXml, textOf } from './dav-xml.ts'
import {
  type CalendarErrorKind,
  CalendarError,
  type CalendarLogin,
  type CalendarProvider,
  mergeBusy,
  type ProviderCalendar,
  sameSite,
} from './provider.ts'
import type { Interval } from './slots.ts'

/**
 * `timeZone`: the business's, for all-day and floating events (default UTC). `fetch` is required: the server is one a
 * member named, so its requests must go through the API's address guard (calendar-server-fetch.ts), never plain fetch.
 */
export type CalDavOptions = { login: CalendarLogin; timeZone?: string; fetch: typeof fetch; timeoutMs?: number }

/** The most the adapter reads of an answer: a multistatus (a calendar's events over the search window) and one event. */
export const MAX_MULTISTATUS_BYTES = 2_000_000
export const MAX_EVENT_BYTES = 256_000

/** The body as text, at most `maxBytes`; a larger one is refused without being read to the end. */
async function cappedText(what: string, res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new CalendarError(
        'caldav',
        'invalid',
        `${what} failed: the server's answer is larger than ${Math.round(maxBytes / 1000)} kB`,
      )
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(out)
}

type Method = 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE'
type DavRequest = {
  method: Method
  url: URL
  depth?: '0' | '1'
  body?: string
  contentType?: string
  headers?: Record<string, string>
}

const XML = 'application/xml; charset=utf-8'
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'

const propfind = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`

/** A response's properties that came back with 200 (a server lists the unknown ones with 404). */
function okProps(response: XmlNode): XmlNode | undefined {
  const ok = childrenNamed(response, 'propstat').find(ps => /\s200\s/.test(` ${textOf(find(ps, 'status'))} `))
  return find(ok, 'prop')
}

function classify(status: number, method: Method): { kind: CalendarErrorKind; message?: string } {
  if (status === 401) return { kind: 'auth', message: 'the server did not accept the user name and password' }
  if (status === 403 && (method === 'PUT' || method === 'DELETE'))
    return { kind: 'invalid', message: 'the calendar is read-only for this account' }
  if (status === 404 || status === 410) return { kind: 'not_found' }
  if (status === 412) return { kind: 'invalid', message: 'the event was changed in the calendar meanwhile' }
  if (status === 429) return { kind: 'rate_limited' }
  if (status >= 500) return { kind: 'unavailable' }
  return { kind: 'invalid' }
}

const basic = (login: CalendarLogin) =>
  `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${login.username}:${login.password}`)))}`

/** A collection URL ends in a slash; an id stored without one still names the same calendar. */
const asCollection = (url: URL) => (url.pathname.endsWith('/') ? url : new URL(`${url.pathname}/${url.search}`, url))

export function createCalDavCalendar({
  login,
  timeZone = 'UTC',
  fetch: doFetch,
  timeoutMs = 8000,
}: CalDavOptions): CalendarProvider {
  const server = new URL(login.serverUrl)

  /** One request to the server; a failed answer is a CalendarError that names the step, never the login. */
  async function request(what: string, req: DavRequest): Promise<Response> {
    if (!sameSite(server, req.url))
      throw new CalendarError(
        'caldav',
        'invalid',
        `${what} failed: the server pointed to ${req.url.host}, which is not the server you entered`,
      )
    let res: Response
    try {
      res = await doFetch(req.url, {
        method: req.method,
        headers: {
          authorization: basic(login),
          ...(req.depth && { depth: req.depth }),
          ...(req.body !== undefined && { 'content-type': req.contentType ?? XML }),
          ...req.headers,
        },
        body: req.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new CalendarError(
        'caldav',
        'unavailable',
        `${what} ${timedOut ? `took longer than ${timeoutMs} ms` : 'could not reach the server'}`,
      )
    }
    if (res.ok) return res
    await res.body?.cancel().catch(() => {})
    // Our own words and the status code only: never the server's status text, body or headers. A refused login's
    // message goes into calendar_connections.last_error, which every member's browser syncs.
    const { kind, message } = classify(res.status, req.method)
    throw new CalendarError(
      'caldav',
      kind,
      `${what} failed: ${message ?? `the server answered ${res.status}`}`,
      res.status,
    )
  }

  /** A multistatus answer: each response's absolute URL (resolved, then checked like any request) and properties. */
  async function multistatus(what: string, req: DavRequest): Promise<{ url: URL; props: XmlNode | undefined }[]> {
    const res = await request(what, req)
    const text = await cappedText(what, res, MAX_MULTISTATUS_BYTES)
    let root: XmlNode
    try {
      root = parseXml(text)
    } catch {
      throw new CalendarError('caldav', 'invalid', `${what} failed: the server's answer could not be read`)
    }
    return findAll(root, 'response').map(r => ({ url: new URL(textOf(find(r, 'href')), req.url), props: okProps(r) }))
  }

  /** The href inside a property (current-user-principal, calendar-home-set), resolved against the request. */
  async function hrefProp(what: string, url: URL, prop: string): Promise<URL | null> {
    const [first] = await multistatus(what, {
      method: 'PROPFIND',
      url,
      depth: '0',
      body: propfind(prop === 'current-user-principal' ? '<d:current-user-principal/>' : '<c:calendar-home-set/>'),
    })
    const href = textOf(find(find(first?.props, prop), 'href'))
    return href ? new URL(href, url) : null
  }

  let home: Promise<URL> | null = null
  /** The account's calendar home: from the address entered, else from /.well-known/caldav (RFC 6764). */
  function calendarHome(): Promise<URL> {
    home ??= (async () => {
      let principal = await hrefProp('find the account', server, 'current-user-principal').catch(e => {
        if (e instanceof CalendarError && (e.kind === 'not_found' || e.kind === 'invalid')) return null
        throw e
      })
      principal ??= await hrefProp('find the account', new URL('/.well-known/caldav', server), 'current-user-principal')
      if (!principal)
        throw new CalendarError(
          'caldav',
          'invalid',
          'find the account failed: the server named no account for this login',
        )
      const found = await hrefProp('find the calendars', principal, 'calendar-home-set')
      if (!found)
        throw new CalendarError('caldav', 'invalid', 'find the calendars failed: the account has no calendar home')
      return asCollection(found)
    })()
    home.catch(() => {
      home = null
    })
    return home
  }

  const calendarUrl = (calendarId: string) => asCollection(new URL(calendarId, server))
  const eventUrl = (calendarId: string, eventId: string) =>
    new URL(`${encodeURIComponent(eventId)}.ics`, calendarUrl(calendarId))

  async function readEvent(calendarId: string, eventId: string): Promise<{ ics: string; etag: string | null } | null> {
    try {
      const res = await request('read the event', {
        method: 'GET',
        url: eventUrl(calendarId, eventId),
        headers: { accept: 'text/calendar' },
      })
      return { ics: await cappedText('read the event', res, MAX_EVENT_BYTES), etag: res.headers.get('etag') }
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'not_found') return null
      throw e
    }
  }

  async function busyIn(calendarId: string, window: Interval, budget: OccurrenceBudget): Promise<Interval[]> {
    const range = `start="${icalUtc(window.start)}" end="${icalUtc(window.end)}"`
    const body =
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
    const responses = await multistatus('check availability', {
      method: 'REPORT',
      url: calendarUrl(calendarId),
      depth: '1',
      body,
    })
    return responses.flatMap(r => busyOf(textOf(find(r.props, 'calendar-data')), window, timeZone, budget))
  }

  return {
    name: 'caldav',

    async listCalendars() {
      const props =
        '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>'
      const homeUrl = await calendarHome()
      const responses = await multistatus('list calendars', {
        method: 'PROPFIND',
        url: homeUrl,
        depth: '1',
        body: propfind(props),
      })
      const calendars: ProviderCalendar[] = responses
        .filter(r => find(find(r.props, 'resourcetype'), 'calendar'))
        // Reminders lists (VTODO only) are calendars too; events cannot go there.
        .filter(r => {
          const set = find(r.props, 'supported-calendar-component-set')
          return (
            !set?.children.length ||
            set.children.some(c => c.name === 'comp' && c.attrs.name?.toUpperCase() === 'VEVENT')
          )
        })
        .map(r => {
          const privileges = find(r.props, 'current-user-privilege-set')
          const granted = new Set(findAll(privileges, 'privilege').flatMap(p => p.children.map(c => c.name)))
          return {
            id: asCollection(r.url).toString(),
            name:
              textOf(find(r.props, 'displayname')) ||
              decodeURIComponent(r.url.pathname.split('/').filter(Boolean).at(-1) ?? 'Calendar'),
            primary: false,
            // Without a privilege set the server does not say: the first write will.
            canWrite: !privileges || ['write', 'write-content', 'all', 'bind'].some(p => granted.has(p)),
          }
        })
      const main = calendars.find(c => c.canWrite) ?? calendars[0]
      if (main) main.primary = true
      return calendars
    },

    async busy(calendarIds, window) {
      if (!calendarIds.length) return []
      // One budget for the whole check: a calendar full of hostile repeating events fails it rather than the API.
      const budget: OccurrenceBudget = { left: MAX_OCCURRENCES_PER_CHECK }
      try {
        const each = await Promise.all(calendarIds.map(id => busyIn(id, window, budget)))
        return mergeBusy(each.flat(), window)
      } catch (e) {
        if (e instanceof OccurrenceBudgetExceeded)
          throw new CalendarError(
            'caldav',
            'unavailable',
            'check availability failed: the calendar has more repeating events than can be read',
          )
        throw e
      }
    },

    async createEvent(calendarId, event) {
      const uid = crypto.randomUUID()
      await request('add the event', {
        method: 'PUT',
        url: eventUrl(calendarId, uid),
        body: eventIcs({ uid, ...event }),
        contentType: 'text/calendar; charset=utf-8',
        // Never over an event that is there already.
        headers: { 'if-none-match': '*' },
      })
      return { id: uid }
    },

    async updateEvent(calendarId, eventId, changes) {
      const stored = await readEvent(calendarId, eventId)
      const event = stored && eventOf(stored.ics)
      if (!stored || !event)
        throw new CalendarError('caldav', 'not_found', 'change the event failed: it is not in the calendar any more')
      await request('change the event', {
        method: 'PUT',
        url: eventUrl(calendarId, eventId),
        body: eventIcs({ ...event, ...changes, uid: event.uid || eventId, sequence: event.sequence + 1 }),
        contentType: 'text/calendar; charset=utf-8',
        // Only over the version just read: a change made in the calendar meanwhile is not overwritten.
        headers: stored.etag ? { 'if-match': stored.etag } : {},
      })
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await request('delete the event', { method: 'DELETE', url: eventUrl(calendarId, eventId) })
      } catch (e) {
        if (!(e instanceof CalendarError && e.kind === 'not_found')) throw e
      }
    },

    async getEvent(calendarId, eventId) {
      const stored = await readEvent(calendarId, eventId)
      const event = stored && eventOf(stored.ics)
      return event
        ? { id: eventId, title: event.title, start: event.start, end: event.end, cancelled: event.cancelled }
        : null
    },
  }
}
