// Where recording storage (the s3 provider's endpoint) may be. The API sends signed requests there (provider.test,
// deleting and checking recordings), so the endpoint is a URL a user gives, like a webhook's. Link-local and cloud
// metadata addresses are refused for everyone, the app included: no S3 lives there. An AI agent's setup key without
// the admin's passkey confirmation (agent-setup.ts) gets public addresses only: a leaked setup link must not probe or
// write to services on this server or its network (a MinIO on the Docker network then needs the admin's Allow, like
// email). Names are checked after they are resolved, and again on the address each connection really uses
// (checkedLookup, no DNS rebinding).
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import type { Actor } from './context.ts'
import { checkedLookup, isLinkLocalAddress, isPrivateAddress, type Resolve, resolveAll } from './ip-address.ts'

/** `public`: public addresses only. `not_link_local`: anything but link-local and metadata addresses. */
export type EndpointRule = 'public' | 'not_link_local'

export const LINK_LOCAL_ENDPOINT =
  'the storage endpoint is a link-local or cloud metadata address; use the address of the storage service'
export const PRIVATE_ENDPOINT =
  'the storage endpoint is on this server or a private network; a setup link may use one only after the admin allows it with their passkey'

/** The rule for this actor: an AI agent's setup key gets public addresses only, until the admin's passkey Allow. */
export const endpointRuleFor = (actor: Actor): EndpointRule =>
  actor.setupKeyId && !actor.passkeyConfirmed && adminSecondFactorRequired() ? 'public' : 'not_link_local'

const refusedBy = (rule: EndpointRule) => (ip: string) =>
  isLinkLocalAddress(ip) || (rule === 'public' && isPrivateAddress(ip))
const messageFor = (addresses: string[]) =>
  addresses.some(isLinkLocalAddress) ? LINK_LOCAL_ENDPOINT : PRIVATE_ENDPOINT

export type EndpointProblem = { kind: 'link_local' | 'private' | 'not_found'; message: string }

/**
 * Why the endpoint may not be used under `rule`, or null. A name is resolved and every address checked. A name that
 * does not resolve passes `not_link_local` (the storage may be down; the connection checks again) but not `public`.
 */
export async function s3EndpointProblem(
  endpoint: string,
  rule: EndpointRule,
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
  if (!addresses?.length)
    return rule === 'public' ? { kind: 'not_found', message: `the storage endpoint ${host} could not be found` } : null
  if (addresses.some(isLinkLocalAddress)) return { kind: 'link_local', message: LINK_LOCAL_ENDPOINT }
  if (rule === 'public' && addresses.some(isPrivateAddress)) return { kind: 'private', message: PRIVATE_ENDPOINT }
  return null
}

const agents: Record<EndpointRule, Agent> = {
  public: new Agent({ connect: { lookup: checkedLookup(refusedBy('public'), PRIVATE_ENDPOINT) as never } }),
  not_link_local: new Agent({
    connect: { lookup: checkedLookup(refusedBy('not_link_local'), LINK_LOCAL_ENDPOINT) as never },
  }),
}
/** Node's own fetch, as at start: a test that put another one in place (vi.stubGlobal) gets that one as it is. */
const platformFetch = globalThis.fetch

/**
 * The fetch the S3 store sends with: only to addresses `rule` allows. An address written as such is checked here; a
 * name on the address the connection uses (undici with checkedLookup). `doFetch` (a fake in tests) is used as given,
 * after the check of a written address.
 */
export function s3Fetch(rule: EndpointRule, doFetch?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const host = new URL(request.url).hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && refusedBy(rule)(host))
      throw new TypeError('fetch failed', { cause: { code: 'EPRIVATEADDRESS', message: messageFor([host]) } })
    const given = doFetch ?? globalThis.fetch
    if (given !== platformFetch) return given(request)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    return (await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: body === undefined ? undefined : new Uint8Array(body),
      redirect: request.redirect,
      signal: request.signal,
      dispatcher: agents[rule],
    })) as unknown as Response
  }
}
