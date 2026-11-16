// OAuth 2.1 sign-in for the MCP server (LIN-126, docs/api.md, MCP authorization spec 2025-06-18 / 2025-11-25): an MCP
// client (Claude, ChatGPT, Claude Code, Cursor, VS Code, …) connects with the server address alone.
//
// - /mcp answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`; the protected-resource metadata names this
//   server as the authorization server; its metadata lists the endpoints below.
// - Clients register themselves (Dynamic Client Registration, RFC 7591, POST /oauth/register, rate-limited per address)
//   or are known by a metadata document URL (client_id = an https URL, fetched with fetchClientMetadata: https only, no
//   private addresses, small and quick).
// - GET /oauth/authorize checks the request and sends the person to the consent page in the app (#connect-agent);
//   Allow runs oauth.approve, which stores a single-use code (10 minutes, hashed, bound to client, redirect URI, PKCE
//   challenge, person and resource) and sends the browser back to the client.
// - POST /oauth/token turns the code and its PKCE verifier into the access token: a personal API key (personal-keys.ts)
//   of that person for that client, so scope, revocation, listing and the command log are the personal key's. It never
//   carries Server admin. Keys do not expire, so no refresh tokens. A code used twice revokes the key it gave.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import {
  OAUTH_CONSENT_HASH,
  type OAuthApproveData,
  type OAuthDescribeData,
  type OAuthProblem,
  type OAuthRedirectKind,
  type OAuthRequest,
} from '@linedesk/actions'
import { oauth_clients, oauth_codes, personal_keys, user } from '@linedesk/db'
import { and, eq, isNull, lt, notExists } from 'drizzle-orm'
import type { Env, Hono } from 'hono'
import { cors } from 'hono/cors'
import { WEB_ORIGIN } from './auth.ts'
import { addressBucket, clientIpOf } from './client-ip.ts'
import { db } from './db.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { personalKeyStepUpNeeded, personalKeyStepUpRefusal } from './owner-step-up.ts'
import { insertPersonalKey, lockAndCountKeys, noticeNewKey, refuseNonPerson } from './personal-keys.ts'

/** How long an authorization code works. */
export const CODE_TTL_MS = 10 * 60_000
/** Client registrations one address may make an hour. */
export const REGISTRATIONS_PER_HOUR = 20
/** Registrations from all addresses together in an hour. */
export const REGISTRATIONS_ALL_PER_HOUR = 500
/** A registered client that never got a key is deleted after this. */
const UNUSED_CLIENT_DAYS = 30
/** A client's own name is cut to this on the consent page and as the key's name (personal_keys.name allows 60). */
const NAME_MAX = 60
const REDIRECT_URIS_MAX = 10
const URI_MAX = 2000

/** This install's address as clients see it: the issuer, and the MCP server `<origin>/mcp` (the resource). */
export const issuer = () => new URL(process.env.PUBLIC_URL || WEB_ORIGIN).origin
export const mcpResource = () => `${issuer()}/mcp`
export const resourceMetadataUrl = () => `${issuer()}/.well-known/oauth-protected-resource/mcp`

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const base64url = (bytes: Buffer) => bytes.toString('base64url')

// ---------------------------------------------------------------------------------------------------------------------
// Metadata

export const protectedResourceMetadata = () => ({
  resource: mcpResource(),
  authorization_servers: [issuer()],
  bearer_methods_supported: ['header'],
  resource_name: 'Linedesk',
})

export const authorizationServerMetadata = () => ({
  issuer: issuer(),
  authorization_endpoint: `${issuer()}/oauth/authorize`,
  token_endpoint: `${issuer()}/oauth/token`,
  registration_endpoint: `${issuer()}/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: [],
})

// ---------------------------------------------------------------------------------------------------------------------
// Redirect URIs

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/**
 * App schemes known to open an MCP client. Any other app scheme must be a reverse domain name (`com.example.app:`), so
 * operating system handlers such as `search-ms:`, `ms-settings:` or `javascript:` are never a redirect target.
 */
const KNOWN_APP_SCHEMES = new Set([
  'cursor:',
  'vscode:',
  'vscode-insiders:',
  'vscodium:',
  'claude:',
  'windsurf:',
  'zed:',
  'raycast:',
  'goose:',
])
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/

/** How a redirect URI reaches the client, or null when it may not be one (RFC 8252, OAuth 2.1 §2.3.1). */
export function redirectKind(uri: string): OAuthRedirectKind | null {
  if (uri.length > URI_MAX) return null
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.hash || uri.includes('#')) return null
  if (url.username || url.password) return null
  if (url.protocol === 'https:') return url.hostname ? 'web' : null
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? 'loopback' : null
  if (KNOWN_APP_SCHEMES.has(url.protocol) || REVERSE_DOMAIN_SCHEME.test(url.protocol)) return 'app'
  return null
}

/** Where the answer goes, for the consent page: the site's host, the port on this computer, or the app's scheme. */
function redirectWhere(uri: string, kind: OAuthRedirectKind): string {
  const url = new URL(uri)
  if (kind === 'web') return url.host
  if (kind === 'loopback') return url.port ? `${url.hostname}:${url.port}` : url.hostname
  return url.protocol.slice(0, -1)
}

/** Exact match, except a loopback redirect, which may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  if (redirectKind(requested) !== 'loopback') return false
  const want = new URL(requested)
  return registered.some(r => {
    if (redirectKind(r) !== 'loopback') return false
    const have = new URL(r)
    return (
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search &&
      have.protocol === want.protocol
    )
  })
}

/** The redirect URI with the answer's parameters added to its query. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

/** A client's own name, as one line of at most NAME_MAX characters; `fallback` when it has none. */
export function cleanName(name: unknown, fallback: string): string {
  const text =
    typeof name === 'string'
      ? name
          // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is taken out
          .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : ''
  return (text || fallback).slice(0, NAME_MAX)
}

// ---------------------------------------------------------------------------------------------------------------------
// Clients: registered (oauth_clients) or known by a metadata document URL

export type OAuthClient = {
  clientId: string
  name: string
  redirectUris: string[]
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  secretHash: string | null
  /** Known by its metadata document: the host of its URL (a site that vouches for the client). */
  documentHost: string | null
}

/** Whether a client_id is a metadata document URL: https with a path (draft-ietf-oauth-client-id-metadata-document). */
export function isMetadataDocumentId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false
  try {
    const url = new URL(clientId)
    return url.pathname !== '/' && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

// Two lists: Node matches an IPv4 address against IPv4-mapped IPv6 rules (::ffff:0:0/96) of the same list.
const BLOCKED = new BlockList()
const BLOCKED_V6 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['2002::', 16],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6')

/** Whether an address is on the public internet: never this machine, a private network, link-local or multicast. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !BLOCKED.check(address, 'ipv4')
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return !BLOCKED.check(mapped[1]!, 'ipv4')
    return !BLOCKED_V6.check(address, 'ipv6')
  }
  return false
}

/** Resolves like dns.lookup, but fails when any address of the name is not public (no DNS rebinding: the connection uses it). */
function publicLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '')
    if (!addresses.length || !addresses.every(a => isPublicAddress(a.address)))
      return callback(new Error(`${hostname} is not a public address`), '')
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

const METADATA_MAX_BYTES = 64 * 1024
const METADATA_TIMEOUT_MS = 5_000

/**
 * GETs a client's metadata document: https on port 443 only, a public address only (checked on the address the
 * connection uses), no redirects, at most 64 KB in 5 seconds. Null when any of it fails.
 */
export function fetchMetadataDocument(url: string): Promise<unknown> {
  return new Promise(resolve => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return resolve(null)
    }
    if (target.protocol !== 'https:' || (target.port && target.port !== '443')) return resolve(null)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !isPublicAddress(host)) return resolve(null)
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))
      return resolve(null)
    let done = false
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const req = httpsRequest(
      target,
      {
        method: 'GET',
        lookup: publicLookup as never,
        headers: { accept: 'application/json', 'user-agent': 'linedesk-oauth' },
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume()
          req.destroy()
          return finish(null)
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > METADATA_MAX_BYTES) {
            req.destroy()
            return finish(null)
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            finish(null)
          }
        })
        res.on('error', () => finish(null))
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish(null)
    }, METADATA_TIMEOUT_MS)
    req.on('error', () => finish(null))
    req.end()
  })
}

/** How metadata documents are fetched; tests replace `fetch`. */
export const clientMetadata = { fetch: fetchMetadataDocument }

const DOCUMENT_CACHE_MS = 10 * 60_000
/** A document that could not be fetched or was not valid is asked again only after this. */
const DOCUMENT_FAILURE_CACHE_MS = 60_000
const DOCUMENT_CACHE_MAX = 500
const documents = new Map<string, { at: number; client: OAuthClient | null | 'unreachable' }>()
/** Metadata document fetches one requester (an address or a person) may cause in FETCH_WINDOW_MS. */
export const FETCHES_PER_WINDOW = 30
const FETCH_WINDOW_MS = 10 * 60_000
const fetchesBy = new Map<string, { since: number; count: number }>()

/** Whether this requester may make the server fetch another metadata document now. */
function mayFetch(requester: string, now = Date.now()): boolean {
  const seen = fetchesBy.get(requester)
  if (!seen || now - seen.since > FETCH_WINDOW_MS) {
    if (fetchesBy.size > 10_000) fetchesBy.clear()
    fetchesBy.set(requester, { since: now, count: 1 })
    return true
  }
  seen.count++
  return seen.count <= FETCHES_PER_WINDOW
}

/** A client from its metadata document, checked (RFC 7591 fields; client_id must be the document's own URL). */
export function clientFromDocument(clientId: string, doc: unknown): OAuthClient | null {
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, unknown>
  if (d.client_id !== clientId) return null
  const uris = d.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > REDIRECT_URIS_MAX) return null
  if (!uris.every(u => typeof u === 'string' && redirectKind(u))) return null
  // A document is public: no secret, so only public clients (PKCE).
  const method = d.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') return null
  const host = new URL(clientId).host
  return {
    clientId,
    name: cleanName(d.client_name, host),
    redirectUris: uris as string[],
    authMethod: 'none',
    secretHash: null,
    documentHost: host,
  }
}

async function documentClient(clientId: string, requester: string): Promise<OAuthClient | null | 'unreachable'> {
  const cached = documents.get(clientId)
  if (cached) {
    const age = Date.now() - cached.at
    if (age < (cached.client && cached.client !== 'unreachable' ? DOCUMENT_CACHE_MS : DOCUMENT_FAILURE_CACHE_MS))
      return cached.client
  }
  if (!mayFetch(requester)) return 'unreachable'
  const doc = await clientMetadata.fetch(clientId)
  const client = doc === null ? 'unreachable' : clientFromDocument(clientId, doc)
  if (documents.size >= DOCUMENT_CACHE_MAX) documents.delete(documents.keys().next().value!)
  documents.set(clientId, { at: Date.now(), client })
  return client
}

/** Forgets fetched metadata documents and the fetches counted per requester (tests). */
export const forgetClientDocuments = () => {
  documents.clear()
  fetchesBy.clear()
}

/**
 * The client a client_id names; 'unreachable' when its metadata document cannot be fetched (or `requester`, an
 * address bucket or a person, made too many fetches lately).
 */
export async function findClient(clientId: string, requester: string): Promise<OAuthClient | null | 'unreachable'> {
  if (isMetadataDocumentId(clientId)) return documentClient(clientId, requester)
  if (clientId.length > 100) return null
  const [row] = await db.select().from(oauth_clients).where(eq(oauth_clients.client_id, clientId))
  if (!row) return null
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: row.redirect_uris,
    authMethod: row.auth_method as OAuthClient['authMethod'],
    secretHash: row.secret_hash,
    documentHost: null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The authorization request

export type CheckedRequest =
  | { ok: true; client: OAuthClient; redirectUri: string; kind: OAuthRedirectKind }
  /**
   * `redirect`: the error may go back to the client (its client and redirect URI are known good), but only after the
   * person clicks on the consent page: a self-registered client must not turn /oauth/authorize into an open redirect.
   */
  | { ok: false; problem: OAuthProblem; redirect?: string }

const OAUTH_ERROR: Partial<Record<OAuthProblem, string>> = {
  response_type: 'unsupported_response_type',
  pkce: 'invalid_request',
  resource: 'invalid_target',
}

/** Checks an authorization request: client, redirect URI, response type, PKCE S256 and the resource. */
export async function checkRequest(req: OAuthRequest, requester: string): Promise<CheckedRequest> {
  const client = await findClient(req.client_id, requester)
  if (client === 'unreachable') return { ok: false, problem: 'metadata_unreachable' }
  if (!client) return { ok: false, problem: 'client' }
  const kind = redirectKind(req.redirect_uri)
  if (!kind || !redirectMatches(client.redirectUris, req.redirect_uri)) return { ok: false, problem: 'redirect' }
  const fail = (problem: OAuthProblem): CheckedRequest => ({
    ok: false,
    problem,
    redirect: withParams(req.redirect_uri, { error: OAUTH_ERROR[problem], state: req.state, iss: issuer() }),
  })
  if (req.response_type !== 'code') return fail('response_type')
  if (req.code_challenge_method !== 'S256' || !req.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(req.code_challenge))
    return fail('pkce')
  if (req.resource !== undefined && req.resource.replace(/\/+$/, '') !== mcpResource()) return fail('resource')
  return { ok: true, client, redirectUri: req.redirect_uri, kind }
}

/** The consent page with the request in its hash. */
export function consentUrl(query: URLSearchParams): string {
  return `${new URL(WEB_ORIGIN).origin}/${OAUTH_CONSENT_HASH}?${query.toString()}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Actions: the consent page

export const oauthHandlers: Record<string, Handler> = {
  'oauth.describe': async ({ tx, actor }, input: OAuthRequest) => {
    const userId = refuseNonPerson(actor)
    const checked = await checkRequest(input, `user:${userId}`)
    if (!checked.ok) {
      const refused: OAuthDescribeData = { ok: false, problem: checked.problem, errorTo: checked.redirect ?? null }
      return { rows: {}, data: refused }
    }
    const [account] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId))
    const data: OAuthDescribeData = {
      ok: true,
      clientName: checked.client.name,
      clientHost: checked.client.documentHost,
      redirect: { kind: checked.kind, where: redirectWhere(checked.redirectUri, checked.kind) },
      email: account?.email ?? '',
      denyTo: withParams(checked.redirectUri, { error: 'access_denied', state: input.state, iss: issuer() }),
    }
    return { rows: {}, data }
  },

  'oauth.approve': async ({ tx, actor }, input: OAuthRequest) => {
    const userId = refuseNonPerson(actor)
    // The same confirmation as making a personal key in the app (run-action answers it first, for the web app's code).
    const stepUp = await personalKeyStepUpNeeded(tx, actor)
    if (stepUp) throw new Forbidden(personalKeyStepUpRefusal(stepUp).error)
    const checked = await checkRequest(input, `user:${userId}`)
    if (!checked.ok)
      throw new Reject(`this connection request cannot be approved (${checked.problem})`, checked.problem)
    // The key is made when the code is used; the count is checked now too, so the person hears of it here.
    await lockAndCountKeys(tx, userId)
    const code = base64url(randomBytes(32))
    const now = Date.now()
    // Codes are kept a day for reuse detection, then go.
    await tx.delete(oauth_codes).where(lt(oauth_codes.expires_at, new Date(now - 24 * 3_600_000).toISOString()))
    await tx.insert(oauth_codes).values({
      code_hash: sha256(code),
      client_id: checked.client.clientId,
      client_name: checked.client.name,
      user_id: userId,
      redirect_uri: checked.redirectUri,
      code_challenge: input.code_challenge!,
      resource: input.resource ?? null,
      expires_at: new Date(now + CODE_TTL_MS).toISOString(),
    })
    const data: OAuthApproveData = {
      redirectTo: withParams(checked.redirectUri, { code, state: input.state, iss: issuer() }),
    }
    return { rows: {}, data }
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Token endpoint

type TokenError = { error: string; error_description?: string }
const tokenError = (status: 400 | 401, error: string, description?: string, headers: Record<string, string> = {}) =>
  Response.json({ error, ...(description ? { error_description: description } : {}) } satisfies TokenError, {
    status,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...headers },
  })

/** The form (application/x-www-form-urlencoded, as RFC 6749 asks) or a JSON body, as strings. */
async function readParams(request: Request): Promise<Record<string, string> | null> {
  const type = request.headers.get('content-type') ?? ''
  const text = await request.text().catch(() => null)
  if (text === null) return null
  if (type.includes('application/json')) {
    try {
      const body = JSON.parse(text) as unknown
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null
      return Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    } catch {
      return null
    }
  }
  return Object.fromEntries(new URLSearchParams(text))
}

/** client_id and client_secret from HTTP Basic (RFC 6749 2.3.1: each form-encoded), or null. */
function basicCredentials(header: string | null): { id: string; secret: string } | null {
  if (!header?.startsWith('Basic ')) return null
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const at = decoded.indexOf(':')
    if (at < 0) return null
    const unform = (s: string) => decodeURIComponent(s.replaceAll('+', ' '))
    return { id: unform(decoded.slice(0, at)), secret: unform(decoded.slice(at + 1)) }
  } catch {
    return null
  }
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** PKCE S256 (RFC 7636 4.6): BASE64URL(SHA256(verifier)) is the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return sameHash(computed, challenge)
}

export async function serveToken(request: Request, ip: string | null): Promise<Response> {
  const params = await readParams(request)
  if (!params) return tokenError(400, 'invalid_request', 'send the parameters as a form')
  if (params.grant_type !== 'authorization_code')
    return tokenError(400, 'unsupported_grant_type', 'only authorization_code is supported')
  const basic = basicCredentials(request.headers.get('authorization'))
  const clientId = basic?.id ?? params.client_id
  const secret = basic?.secret ?? params.client_secret
  if (basic && params.client_id && params.client_id !== basic.id)
    return tokenError(400, 'invalid_request', 'client_id differs from the one in the Authorization header')
  const { code, code_verifier: verifier, redirect_uri: redirectUri } = params
  if (!clientId || !code || !verifier || !redirectUri)
    return tokenError(400, 'invalid_request', 'client_id, code, code_verifier and redirect_uri are required')

  const client = await findClient(clientId, addressBucket(ip))
  if (!client || client === 'unreachable')
    return tokenError(401, 'invalid_client', 'unknown client', { 'www-authenticate': 'Basic realm="linedesk"' })
  if (client.secretHash && !(secret && sameHash(sha256(secret), client.secretHash)))
    return tokenError(401, 'invalid_client', 'wrong client secret', { 'www-authenticate': 'Basic realm="linedesk"' })

  const codeHash = sha256(code)
  const now = new Date()
  const resource = params.resource?.replace(/\/+$/, '')
  type Outcome = { error: [string, string] } | { made: { prefix: string; key: string; userId: string; name: string } }
  let outcome: Outcome
  try {
    // One transaction: the code is taken under its row lock and the key made with it, so a second use that waits on
    // the lock finds the key of the first and revokes it (RFC 6749 4.1.2).
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [taken] = await tx
        .update(oauth_codes)
        .set({ used_at: now.toISOString() })
        .where(and(eq(oauth_codes.code_hash, codeHash), isNull(oauth_codes.used_at)))
        .returning()
      if (!taken) {
        const [used] = await tx.select().from(oauth_codes).where(eq(oauth_codes.code_hash, codeHash)).for('update')
        if (used?.personal_key_id)
          await tx
            .update(personal_keys)
            .set({ revoked_at: now.toISOString() })
            .where(and(eq(personal_keys.id, used.personal_key_id), isNull(personal_keys.revoked_at)))
        return { error: ['invalid_grant', 'unknown or used code'] }
      }
      // Any failure below leaves the code used: a wrong verifier cannot be tried again.
      if (Date.parse(taken.expires_at) <= now.getTime()) return { error: ['invalid_grant', 'the code expired'] }
      if (taken.client_id !== client.clientId) return { error: ['invalid_grant', 'the code is for another client'] }
      if (taken.redirect_uri !== redirectUri) return { error: ['invalid_grant', 'redirect_uri differs'] }
      if (!pkceMatches(verifier, taken.code_challenge)) return { error: ['invalid_grant', 'wrong code_verifier'] }
      // The resource, when sent, is this server's /mcp and the one the code was given for (RFC 8707).
      if (
        resource !== undefined &&
        (resource !== mcpResource() || (taken.resource !== null && taken.resource.replace(/\/+$/, '') !== resource))
      )
        return { error: ['invalid_target', 'the resource is this server’s /mcp, as in the authorization request'] }
      await lockAndCountKeys(tx, taken.user_id)
      const { row, key } = await insertPersonalKey(tx, taken.user_id, taken.client_name, {
        oauthClientId: client.clientId,
      })
      await tx.update(oauth_codes).set({ personal_key_id: row.id }).where(eq(oauth_codes.code_hash, codeHash))
      return { made: { prefix: row.prefix, key, userId: taken.user_id, name: taken.client_name } }
    })
  } catch (e) {
    if (e instanceof Reject) return tokenError(400, 'invalid_grant', e.message)
    throw e
  }
  if ('error' in outcome) return tokenError(400, outcome.error[0], outcome.error[1])
  const { made } = outcome
  void noticeNewKey(made.userId, made.name, made.prefix).catch(e =>
    console.error(`could not send the personal key email: ${e instanceof Error ? e.message : e}`),
  )
  return Response.json(
    { access_token: made.key, token_type: 'Bearer' },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Dynamic Client Registration

const registrations = new Map<string, { since: number; count: number }>()
let allRegistrations = { since: 0, count: 0 }

/** Whether this address may register another client this hour, and the install has not had too many from all. */
export function mayRegister(ip: string | null, now = Date.now()): boolean {
  if (now - allRegistrations.since > 3_600_000) allRegistrations = { since: now, count: 0 }
  if (++allRegistrations.count > REGISTRATIONS_ALL_PER_HOUR) return false
  const bucket = addressBucket(ip)
  const seen = registrations.get(bucket)
  if (!seen || now - seen.since > 3_600_000) {
    if (registrations.size > 10_000) registrations.clear()
    registrations.set(bucket, { since: now, count: 1 })
    return true
  }
  seen.count++
  return seen.count <= REGISTRATIONS_PER_HOUR
}

/** Forgets the registrations counted per address (tests). */
export const forgetRegistrations = () => {
  registrations.clear()
  allRegistrations = { since: 0, count: 0 }
}

/**
 * Deletes registered clients older than UNUSED_CLIENT_DAYS that never got a key (and have no code waiting): DCR is
 * open to anyone, so its table must not only grow. Runs on each registration.
 */
export async function deleteUnusedClients(now = Date.now()) {
  const before = new Date(now - UNUSED_CLIENT_DAYS * 86_400_000).toISOString()
  await db
    .delete(oauth_clients)
    .where(
      and(
        lt(oauth_clients.created_at, before),
        notExists(
          db
            .select({ id: personal_keys.id })
            .from(personal_keys)
            .where(eq(personal_keys.oauth_client_id, oauth_clients.client_id)),
        ),
        notExists(
          db
            .select({ c: oauth_codes.code_hash })
            .from(oauth_codes)
            .where(eq(oauth_codes.client_id, oauth_clients.client_id)),
        ),
      ),
    )
}

const registrationError = (error: string, description: string) =>
  Response.json({ error, error_description: description }, { status: 400, headers: { 'cache-control': 'no-store' } })

export async function serveRegister(request: Request, ip: string | null): Promise<Response> {
  if (!mayRegister(ip))
    return Response.json(
      { error: 'too_many_requests', error_description: `at most ${REGISTRATIONS_PER_HOUR} registrations an hour` },
      { status: 429, headers: { 'retry-after': '3600' } },
    )
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return registrationError('invalid_client_metadata', 'send the client metadata as a JSON object')
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > REDIRECT_URIS_MAX)
    return registrationError('invalid_redirect_uri', `redirect_uris: 1 to ${REDIRECT_URIS_MAX} URIs`)
  for (const uri of uris)
    if (typeof uri !== 'string' || !redirectKind(uri))
      return registrationError(
        'invalid_redirect_uri',
        'each redirect URI is https, http on 127.0.0.1, localhost or [::1], or an app scheme, without a fragment',
      )
  // RFC 7591 2: client_secret_basic when not named.
  const method = body.token_endpoint_auth_method ?? 'client_secret_basic'
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic')
    return registrationError(
      'invalid_client_metadata',
      'token_endpoint_auth_method: none, client_secret_post or client_secret_basic',
    )
  const grants = body.grant_types
  if (grants !== undefined && !(Array.isArray(grants) && grants.includes('authorization_code')))
    return registrationError('invalid_client_metadata', 'grant_types must include authorization_code')
  const responses = body.response_types
  if (responses !== undefined && !(Array.isArray(responses) && responses.includes('code')))
    return registrationError('invalid_client_metadata', 'response_types must include code')

  const clientId = `ldc_${base64url(randomBytes(18))}`
  const secret = method === 'none' ? null : `ldcs_${base64url(randomBytes(32))}`
  const name = cleanName(body.client_name, new URL(uris[0] as string).host || 'MCP client')
  const issuedAt = Math.floor(Date.now() / 1000)
  await deleteUnusedClients().catch(e =>
    console.error(`could not delete unused OAuth clients: ${e instanceof Error ? e.message : e}`),
  )
  await db.insert(oauth_clients).values({
    client_id: clientId,
    name,
    redirect_uris: uris as string[],
    auth_method: method,
    secret_hash: secret ? sha256(secret) : null,
  })
  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes

/** The 401 challenge of /mcp: where a client finds how to sign in (RFC 9728 5.1). */
export const mcpChallenge = (error?: 'invalid_token') =>
  `Bearer resource_metadata="${resourceMetadataUrl()}"${error ? `, error="${error}"` : ''}`

/** Browser-based clients read these without cookies: any origin, no credentials. */
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'],
  maxAge: 86_400,
})

/** CORS on /mcp: the MCP headers, and the challenge readable. */
export const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'authorization',
    'content-type',
    'accept',
    'mcp-protocol-version',
    'mcp-session-id',
    'last-event-id',
    'x-workspace-id',
  ],
  exposeHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version', 'retry-after'],
  maxAge: 86_400,
})

export function registerOAuthRoutes<E extends Env>(app: Hono<E>) {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    })
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/mcp',
    '/mcp/.well-known/openid-configuration',
    '/oauth/token',
    '/oauth/register',
  ])
    app.use(path, openCors)
  app.get('/.well-known/oauth-protected-resource', () => json(protectedResourceMetadata()))
  app.get('/.well-known/oauth-protected-resource/mcp', () => json(protectedResourceMetadata()))
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/mcp',
    '/mcp/.well-known/openid-configuration',
  ])
    app.get(path, () => json(authorizationServerMetadata()))

  // OpenAI's domain check for the apps directory: the value from OPENAI_APPS_CHALLENGE, 404 when not set.
  app.get('/.well-known/openai-apps-challenge', c => {
    const challenge = process.env.OPENAI_APPS_CHALLENGE?.trim()
    if (!challenge) return c.text('not found', 404)
    return c.text(challenge)
  })

  // Always to the consent page, also for a request with an error: it shows the error, and an error the client may
  // hear goes back to it only when the person clicks (never a redirect to a client's address before that).
  app.get('/oauth/authorize', c => c.redirect(consentUrl(new URL(c.req.url).searchParams), 302))
  app.post('/oauth/token', c => serveToken(c.req.raw, clientIpOf(c)))
  app.post('/oauth/register', c => serveRegister(c.req.raw, clientIpOf(c)))
}
