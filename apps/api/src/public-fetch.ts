// GET requests to URLs that users give (website import), with the webhook guard: only public
// addresses, checked on the address the connection really uses (publicLookup, no DNS rebinding), web
// ports only, redirects followed by hand and checked again, and a cap on time and size. Never link-local or cloud
// metadata addresses, also where private addresses are allowed (lanLookup).
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { isLinkLocalAddress, isPrivateAddress } from './ip-address.ts'
import { decodePage } from './page-text.ts'
import { LINK_LOCAL, lanLookup, publicLookup } from './webhooks.ts'

type Env = Record<string, string | undefined>

/** WEBHOOK_ALLOW_PRIVATE_URLS=true: development and closed networks may also read private addresses, never link-local ones. */
const allowPrivate = (env: Env) => env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true'
export const PRIVATE_URL = 'that address is private; only public websites can be read'
const WEB_PORTS = ['', '80', '443']
const TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3

const publicAgent = new Agent({ connect: { lookup: publicLookup() as never, timeout: TIMEOUT_MS } })
const lanAgent = new Agent({ connect: { lookup: lanLookup() as never, timeout: TIMEOUT_MS } })

/** A user-given URL refused before any request: not http(s), another port, a private address written as such. */
export class UrlRefused extends Error {}

/** Why this URL may not be read, or null. Names are checked when they are resolved (publicLookup). */
export function webUrlProblem(url: URL, env: Env = process.env): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use a website address (http or https).'
  if (url.username || url.password) return 'Leave the user name and password out of the address.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isLinkLocalAddress(host)) return LINK_LOCAL
  if (allowPrivate(env)) return null
  if (!WEB_PORTS.includes(url.port)) return 'Use the website address without a port.'
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return PRIVATE_URL
  return isIP(host) && isPrivateAddress(host) ? PRIVATE_URL : null
}

/** "brightwater-plumbing.example" → https://brightwater-plumbing.example/; throws UrlRefused for anything that is not a website. */
export function websiteUrl(typed: string, env: Env = process.env): URL {
  const text = typed.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new UrlRefused('That is not a website address.')
  }
  const problem = webUrlProblem(url, env)
  if (problem) throw new UrlRefused(problem)
  url.hash = ''
  return url
}

export type FetchedPage = { url: string; status: number; contentType: string; body: string; truncated: boolean }

/** The body's bytes, at most `maxBytes`; the rest is not downloaded. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= maxBytes) {
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), truncated }
}

/**
 * GETs a public web page. Redirects are followed by hand (at most 3), each target checked like the
 * first. Throws UrlRefused for a refused address, other errors for "could not be read".
 */
export async function fetchPublic(
  start: URL,
  { maxBytes, userAgent }: { maxBytes: number; userAgent: string },
  env: Env = process.env,
): Promise<FetchedPage> {
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = webUrlProblem(url, env)
    if (problem) throw new UrlRefused(problem)
    let res: Awaited<ReturnType<typeof undiciFetch>>
    try {
      res = await undiciFetch(url, {
        redirect: 'manual',
        dispatcher: allowPrivate(env) ? lanAgent : publicAgent,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      })
    } catch (e) {
      const code = e instanceof Error ? (e.cause as { code?: string } | undefined)?.code : undefined
      if (code === 'EPRIVATEADDRESS') throw new UrlRefused(allowPrivate(env) ? LINK_LOCAL : PRIVATE_URL)
      throw new Error(`could not connect to ${url.host}`)
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {})
      url = new URL(location, url)
      continue
    }
    const { bytes, truncated } = await readCapped(res.body as ReadableStream<Uint8Array> | null, maxBytes)
    const contentType = res.headers.get('content-type') ?? ''
    return {
      url: url.toString(),
      status: res.status,
      contentType,
      body: decodePage(bytes, contentType, truncated),
      truncated,
    }
  }
  throw new Error('too many redirects')
}
