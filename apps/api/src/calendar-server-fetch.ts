// Requests to a calendar server a member named (CalDAV): the address guard of webhooks and website import. Only
// https on 443 or 8443 (anything else only where private addresses are allowed: development), only public addresses,
// checked on the address the connection really uses (no DNS rebinding), never link-local or cloud metadata addresses,
// and only the member's own server's site: every request and every redirect (followed by hand) is checked against it,
// so no href or Location a server answers with can carry the login elsewhere. Time and size are capped.
import { isIP } from 'node:net'
import { sameSite } from '@linedesk/calendar'
import { Agent, fetch as undiciFetch } from 'undici'
import { checkedLookup, isLinkLocalAddress, isPrivateAddress, type Resolve, resolveAll } from './ip-address.ts'

type Env = Record<string, string | undefined>

/** WEBHOOK_ALLOW_PRIVATE_URLS=true: development and closed networks may also reach private addresses (a CalDAV server on the LAN). */
const allowPrivate = (env: Env) => env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true'
const PRIVATE = 'that address is private; only calendar servers on the internet can be connected'
const LINK_LOCAL = 'that address is a link-local or cloud metadata address'
/** The ports of a public CalDAV server: https (443, the default) and 8443. */
const PORTS = ['', '443', '8443']
const TIMEOUT_MS = 8_000
/** A calendar's events for a few weeks fit easily; a server that sends more is refused. */
export const MAX_BODY_BYTES = 5_000_000
const MAX_REDIRECTS = 3
/**
 * undici's own fetch sends no browser-like User-Agent, and Cloudflare (in front of api.cal.com) answers such a request
 * with a 403 challenge page; a named client goes through. The caller's own User-Agent wins.
 */
const USER_AGENT = 'Linedesk-Calendar/1'

const publicAgent = new Agent({
  connect: { lookup: checkedLookup(isPrivateAddress, PRIVATE) as never, timeout: TIMEOUT_MS },
})
const lanAgent = new Agent({
  connect: { lookup: checkedLookup(isLinkLocalAddress, LINK_LOCAL) as never, timeout: TIMEOUT_MS },
})

/** Why a calendar server's address is refused before any request, or null. Names are checked again on connect. */
export function calendarServerProblem(url: URL, env: Env = process.env): string | null {
  const lan = allowPrivate(env)
  if (url.protocol !== 'https:' && !(lan && url.protocol === 'http:')) return "Use the server's https address."
  if (url.username || url.password) return 'Put the user name and password in their own fields, not in the address.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isLinkLocalAddress(host)) return LINK_LOCAL
  if (lan) return null
  if (!PORTS.includes(url.port)) return 'Use the server address on port 443 (or 8443).'
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return PRIVATE
  return isIP(host) && isPrivateAddress(host) ? PRIVATE : null
}

/**
 * The address a member typed as a URL ("caldav.example.com" → https://caldav.example.com/), or the reason it is
 * refused: not a URL, not https on 443/8443, private, or a name that does not resolve (to public addresses only).
 */
export async function calendarServerUrl(
  typed: string,
  env: Env = process.env,
  resolve: Resolve = resolveAll,
): Promise<URL | string> {
  const text = typed.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return 'That is not a server address.'
  }
  url.hash = ''
  const problem = calendarServerProblem(url, env)
  if (problem) return problem
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return url
  const addresses = await new Promise<{ address: string }[] | null>(done =>
    resolve(host, (err, list) => done(err ? null : list)),
  )
  // In development a name only the API's containers know (radicale) may not resolve here; the connection checks it again.
  if (!addresses?.length) return allowPrivate(env) ? url : `${host} could not be found.`
  const refused = allowPrivate(env) ? isLinkLocalAddress : isPrivateAddress
  return addresses.some(a => refused(a.address)) ? `${host}: ${allowPrivate(env) ? LINK_LOCAL : PRIVATE}.` : url
}

/** The body, at most MAX_BODY_BYTES; more is refused without reading it all. */
async function cappedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`the server answered with more than ${maxBytes / 1_000_000} MB`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

type Send = (url: URL, init: RequestInit & { dispatcher: Agent; redirect: 'manual' }) => Promise<Response>
const undiciSend: Send = (url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>

/**
 * A fetch for the member's calendar server `server`: every request and redirect is checked as above, and anything on
 * another site than `server` is refused before it is sent. Redirects keep method and body (CalDAV's PROPFIND and
 * REPORT). The whole request, body included, takes at most 8 s (or the caller's signal, when sooner).
 */
export function calendarServerFetch(
  server: URL,
  {
    env = process.env,
    send = undiciSend,
    maxBytes = MAX_BODY_BYTES,
  }: { env?: Env; send?: Send; maxBytes?: number } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = new URL(String(input))
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!sameSite(server, url))
        throw new Error(`refused to send the request to ${url.host}, which is not the server you entered`)
      const problem = calendarServerProblem(url, env)
      if (problem) throw new Error(problem)
      const headers = new Headers(init?.headers)
      if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
      const res = await send(url, {
        ...init,
        headers,
        signal,
        redirect: 'manual',
        dispatcher: allowPrivate(env) ? lanAgent : publicAgent,
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        url = new URL(location, url)
        continue
      }
      const body = await cappedBody(res.body, maxBytes)
      return new Response(res.status === 204 || res.status === 304 ? null : body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    }
    throw new Error('too many redirects')
  }) as typeof fetch
}
