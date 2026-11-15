// Where recording storage (the s3 provider's endpoint) may be. The API sends signed requests there (provider.test,
// deleting and checking recordings), so the endpoint is a URL a user gives, like a webhook's. Link-local and cloud
// metadata addresses are refused for everyone, the app and an AI agent's setup link alike: no S3 lives there. A storage
// server on this host or a private network (a MinIO on the Docker network) is the admin's choice, also through the
// setup link. Names are checked after they are resolved, and again on the address each connection really uses
// (checkedLookup, no DNS rebinding).
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { checkedLookup, isLinkLocalAddress, type Resolve, resolveAll } from './ip-address.ts'

export const LINK_LOCAL_ENDPOINT =
  'the storage endpoint is a link-local or cloud metadata address; use the address of the storage service'

export type EndpointProblem = { kind: 'link_local'; message: string }

/**
 * Why the endpoint may not be used, or null. A name is resolved and every address checked. A name that does not
 * resolve passes (the storage may be down; the connection checks again).
 */
export async function s3EndpointProblem(
  endpoint: string,
  resolve: Resolve = resolveAll,
): Promise<EndpointProblem | null> {
  let host: string
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null // s3StoreFromValues says it is not a URL
  }
  const addresses = isIP(host)
    ? [host]
    : await new Promise<string[] | null>(done =>
        resolve(host, (err, list: LookupAddress[]) => done(err ? null : list.map(a => a.address))),
      )
  if (addresses?.some(isLinkLocalAddress)) return { kind: 'link_local', message: LINK_LOCAL_ENDPOINT }
  return null
}

const agent = new Agent({ connect: { lookup: checkedLookup(isLinkLocalAddress, LINK_LOCAL_ENDPOINT) as never } })
/** Node's own fetch, as at start: a test that put another one in place (vi.stubGlobal) gets that one as it is. */
const platformFetch = globalThis.fetch

/**
 * The fetch the S3 store sends with: never to a link-local or metadata address. An address written as such is checked
 * here; a name on the address the connection uses (undici with checkedLookup). `doFetch` (a fake in tests) is used as
 * given, after the check of a written address.
 */
export function s3Fetch(doFetch?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const host = new URL(request.url).hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && isLinkLocalAddress(host))
      throw new TypeError('fetch failed', { cause: { code: 'EPRIVATEADDRESS', message: LINK_LOCAL_ENDPOINT } })
    const given = doFetch ?? globalThis.fetch
    if (given !== platformFetch) return given(request)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    return (await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: body === undefined ? undefined : new Uint8Array(body),
      redirect: request.redirect,
      signal: request.signal,
      dispatcher: agent,
    })) as unknown as Response
  }
}
