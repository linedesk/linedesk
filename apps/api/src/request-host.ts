// Which address a request came in on (white-label S5, docs/white-label.md "Own address"): the install's own (main), a
// white-label partner's own address that is live (partner), or neither (unknown, refused with 421 by app.ts).
//
// Only the Host header counts, never X-Forwarded-Host: the origin is reachable only through Cloudflare and Caddy, which
// pass the visitor's Host on unchanged. Requests on the internal entry (the voice agent through `proxy:3100`, marked
// `X-Linedesk-Entry: internal` by Caddy, which replaces whatever a client sent) skip the check.
//
// Ships dark: an install that never had a partner address (self-host, dev, every install before S5's partner page)
// answers every host as before. The first `partner_domains` row turns the check on for good: a database trigger
// (migration 0148) records it in instance_settings (`HOST_CHECK_KEY`), and nothing clears that, so deleting rows
// (a partner deleted, its rows cascading) never switches the check off again (security review of #1172, L-2).
import { isIP } from 'node:net'
import type { ActionDef } from '@linedesk/actions'
import { timingSafeEqual } from 'node:crypto'
import { instance_settings, partner_domains, partners, type PartnerDomainStatus } from '@linedesk/db'
import { eq, ne } from 'drizzle-orm'
import { db } from './db.ts'
import { hasSecretsKey, signWithSecretsKey } from './secrets.ts'

export type RequestHost =
  | { kind: 'main' }
  | { kind: 'partner'; partnerId: string; domainId: string; hostname: string; origin: string }
  | { kind: 'unknown' }

/** A partner address as the map keeps it: every row that is not removed, whatever its partner's state. */
type HostEntry = {
  domainId: string
  partnerId: string
  hostname: string
  status: PartnerDomainStatus
  /** Only an `approved` partner's address resolves: never a pending or suspended one (security review of #1172, L-3). */
  partnerApproved: boolean
}

/**
 * The instance setting a trigger on `partner_domains` writes with the first row (migration 0148): from then on hosts
 * are checked. Never deleted by the app.
 */
export const HOST_CHECK_KEY = 'partnerDomains.hostCheck'

type HostMap = {
  byHost: ReadonlyMap<string, HostEntry>
  /** Whether this install ever had a partner address (HOST_CHECK_KEY, or any row): only then are hosts checked. */
  inUse: boolean
  loadedAt: number
}

/** How old the map may get before a request on a non-main host waits for a fresh one (the plan's "within 30 s"). */
export const HOSTS_MAX_AGE_MS = 30_000
/** After a failed load, how long before the next request tries again (the old map is kept meanwhile). */
const RETRY_AFTER_FAILURE_MS = 5_000

let hosts: HostMap | null = null
let loading: Promise<void> | null = null
let failedAt = 0

/**
 * A Host header as the map compares it: lower-case, without the port and one trailing dot. Null for anything that is
 * not a host name or an IP address (the check then answers unknown).
 */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (!raw) return null
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[')) {
    // An IPv6 literal, `[::1]:3000`.
    const end = host.indexOf(']')
    if (end < 0) return null
    const rest = host.slice(end + 1)
    if (rest && !/^:\d{1,5}$/.test(rest)) return null
    host = host.slice(0, end + 1)
    return isIP(host.slice(1, -1)) === 6 ? host : null
  }
  const colon = host.indexOf(':')
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(host.slice(colon + 1))) return null
    host = host.slice(0, colon)
  }
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host || host.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return null
  return host
}

/** The host name of an origin from the environment (port and trailing dot dropped), or null when it is not one. */
function hostOfOrigin(origin: string | undefined): string | null {
  if (!origin?.trim()) return null
  try {
    return normaliseHost(new URL(origin.trim()).host)
  } catch {
    return null
  }
}

/**
 * The install's own host names: the web app's (WEB_ORIGIN), the public address (PUBLIC_URL), Better Auth's
 * (BETTER_AUTH_URL) and the local development origins (LINEDESK_DEV_ORIGINS). Read once; the environment does not
 * change while the API runs.
 */
const MAIN_HOSTS: ReadonlySet<string> = new Set(
  [
    process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    process.env.PUBLIC_URL,
    process.env.BETTER_AUTH_URL,
    ...(process.env.LINEDESK_DEV_ORIGINS ?? '').split(','),
  ]
    .map(hostOfOrigin)
    .filter((host): host is string => Boolean(host)),
)

/** Whether a (normalised) host is one of the install's own. */
export const isMainHost = (host: string | null) => host !== null && MAIN_HOSTS.has(host)

/** Reads every partner address that is not removed, and whether the host check is on (HOST_CHECK_KEY, or any row). */
async function loadHosts(): Promise<HostMap> {
  const [rows, [any], [latched]] = await Promise.all([
    db
      .select({
        domainId: partner_domains.id,
        partnerId: partner_domains.partner_id,
        hostname: partner_domains.hostname,
        status: partner_domains.status,
        partnerStatus: partners.status,
      })
      .from(partner_domains)
      .innerJoin(partners, eq(partners.id, partner_domains.partner_id))
      .where(ne(partner_domains.status, 'removed')),
    db.select({ id: partner_domains.id }).from(partner_domains).limit(1),
    db.select({ key: instance_settings.key }).from(instance_settings).where(eq(instance_settings.key, HOST_CHECK_KEY)),
  ])
  const byHost = new Map<string, HostEntry>()
  for (const row of rows)
    byHost.set(row.hostname, {
      domainId: row.domainId,
      partnerId: row.partnerId,
      hostname: row.hostname,
      status: row.status,
      partnerApproved: row.partnerStatus === 'approved',
    })
  return { byHost, inUse: Boolean(any || latched), loadedAt: Date.now() }
}

/**
 * Loads the map again now (one load at a time). Called every 30 s (watchHosts) and, from S5's partner page, right after
 * a change in this process. A failed load keeps the map there was and is logged.
 */
export function reloadHosts(): Promise<void> {
  loading ??= loadHosts()
    .then(map => {
      hosts = map
      failedAt = 0
    })
    .catch(error => {
      failedAt = Date.now()
      console.error('could not load the partner addresses:', error)
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/** Waits for a map no older than HOSTS_MAX_AGE_MS (not again within 5 s of a failed load). */
export async function freshHosts(): Promise<void> {
  const stale = !hosts || Date.now() - hosts.loadedAt >= HOSTS_MAX_AGE_MS
  if (stale && Date.now() - failedAt >= RETRY_AFTER_FAILURE_MS) await reloadHosts()
}

/** Whether a map was ever loaded: without one, a host that is not the install's own cannot be told apart. */
export const hostsLoaded = () => hosts !== null

/** Keeps the map fresh in the background (server.ts), so requests rarely wait for it. */
export function watchHosts() {
  void reloadHosts()
  setInterval(() => void reloadHosts(), HOSTS_MAX_AGE_MS).unref()
}

/**
 * Which address a Host header is (synchronous: the map as it is now; app.ts calls freshHosts first). A partner's
 * address counts only while it is `active` and its partner `approved`; an IP address never does.
 */
export function resolveHost(rawHost: string | null | undefined): RequestHost {
  const host = normaliseHost(rawHost)
  if (isMainHost(host)) return { kind: 'main' }
  const entry = host ? hosts?.byHost.get(host) : undefined
  if (host && entry && entry.status === 'active' && entry.partnerApproved && !isIP(host))
    return {
      kind: 'partner',
      partnerId: entry.partnerId,
      domainId: entry.domainId,
      hostname: host,
      origin: `https://${host}`,
    }
  // Never had a partner address: every host is the install's, as before S5.
  if (hosts && !hosts.inUse) return { kind: 'main' }
  return { kind: 'unknown' }
}

/** The header Caddy sets on every request it passes on (context.ts ENTRY_HEADER). */
const ENTRY_HEADER = 'x-linedesk-entry'

/** The address of a request, resolved now: the internal entry is always the install's own. */
export function resolveRequestHost(header: (name: string) => string | undefined): RequestHost {
  if (header(ENTRY_HEADER) === 'internal') return { kind: 'main' }
  return resolveHost(header('host'))
}

/**
 * The answer app.ts's host middleware gave for a request, kept for the rest of it (its Hono context, and the Request
 * handed to Better Auth): every later check of the same request reads the same answer, even when the map changes in
 * between (an address removed or a partner suspended mid-request; security review of #1172, L-1).
 */
const resolvedHosts = new WeakMap<object, RequestHost>()
export const rememberRequestHost = (request: object, host: RequestHost) => void resolvedHosts.set(request, host)

/**
 * The address the host middleware resolved for this request (its Hono context or a Request it handed on). Never
 * resolved again: a request it did not see (none should reach here) counts as unknown, refused everywhere.
 */
export const requestHostOf = (request: object): RequestHost => resolvedHosts.get(request) ?? { kind: 'unknown' }

/** The checker's fresh random challenge (`?nonce=`): 16 to 128 URL-safe characters. */
const NONCE = /^[A-Za-z0-9_-]{16,128}$/
export const validProbeNonce = (nonce: string | undefined): nonce is string => !!nonce && NONCE.test(nonce)

/** HMAC of the domain id and the checker's nonce with SECRETS_KEY; null without the key. */
const probeProof = (domainId: string, nonce: string) =>
  hasSecretsKey() ? signWithSecretsKey('host-probe', `${domainId}\n${nonce}`) : null

/**
 * The partner address a not-removed row answers the probe for (`GET /v1/health/host?nonce=…`), whatever its status:
 * S5's check proves with it that the address reaches this server before it goes live. Challenge and response: the
 * checker sends a fresh nonce each time and the answer signs the id with it, so an answer saved once and served from
 * another server never passes (security review of #1172, M-1). Null for any other host.
 */
export function probedDomain(
  rawHost: string | null | undefined,
  nonce: string,
): { domainId: string; proof: string | null } | null {
  const host = normaliseHost(rawHost)
  if (!host || isMainHost(host) || isIP(host)) return null
  const entry = hosts?.byHost.get(host)
  if (!entry) return null
  return { domainId: entry.domainId, proof: probeProof(entry.domainId, nonce) }
}

/**
 * The checker's side (S5's address check): whether a probe answer proves the address reached this install for this
 * domain and this nonce. Constant time; no SECRETS_KEY, a missing or malformed proof, or another id is a failed check.
 */
export function hostProbePassed(
  domainId: string,
  nonce: string,
  answer: { domainId?: unknown; proof?: unknown },
): boolean {
  if (!validProbeNonce(nonce) || answer.domainId !== domainId || typeof answer.proof !== 'string') return false
  const expected = probeProof(domainId, nonce)
  if (!expected) return false
  const [a, b] = [Buffer.from(answer.proof), Buffer.from(expected)]
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The origins whose pages may use the session cookie on a request to this address (Better Auth, csrf.ts, the sign-in
 * link): the install's own, plus the request's own partner address when it is live. Never another partner's.
 */
export function trustedOriginsFor(mainOrigins: readonly string[], host: RequestHost): string[] {
  return host.kind === 'partner' ? [...mainOrigins, host.origin] : [...mainOrigins]
}

/**
 * Paths that answer only on the install's own address; on a partner's address they are 404 (app.ts): Server admin, the
 * voice agent's routes, impersonation, MCP and OAuth with their documents, the API description, self-serve sign-up,
 * New workspace, the first admin's setup, and the webhooks and demo calls other services send to the install.
 */
const MAIN_ONLY_PREFIXES = [
  '/v1/admin/',
  '/v1/agent/',
  '/v1/signup/',
  '/mcp/',
  '/oauth/',
  '/.well-known/',
  '/v1/billing/stripe/',
  '/v1/apps/webhook/',
  '/v1/demo/',
  '/v1/webhooks/',
]
const MAIN_ONLY_PATHS = new Set([
  '/v1/admin',
  '/v1/agent',
  '/v1/signup',
  '/mcp',
  '/oauth',
  '/v1/workspaces',
  '/v1/workspace/agent-setup',
  '/v1/impersonation/start',
  '/v1/openapi.json',
  '/v1/setup',
])

/** Whether a path answers only on the install's own address. */
export function mainHostOnlyPath(path: string): boolean {
  // Hono matches `/v1/admin/` and `//v1/admin` like `/v1/admin`: compare the same way.
  const clean = path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
  return MAIN_ONLY_PATHS.has(clean) || MAIN_ONLY_PREFIXES.some(prefix => clean.startsWith(prefix))
}

/**
 * Actions that run only on the install's own address: New workspace, self-serve sign-up, OAuth consent, AI agent setup
 * links, and Stripe Checkout and portal starts. Besides these, every action of Server admin (`instance:admin`) and of
 * the partner area (`partner`, the partner's names, a billing action for the partner bill).
 */
const MAIN_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'workspace.create',
  'account.signUp',
  'oauth.describe',
  'oauth.approve',
  'agentSetup.createKey',
  'agentSetup.createWorkspaceKey',
  'billing.startCheckout',
  'billing.confirmCheckout',
  'billing.startTopUp',
  'billing.openPortal',
])
const MAIN_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(['instance:admin', 'partner', 'account:signUp'])

/** Whether an action (with this input) runs only on the install's own address. */
export function mainHostOnlyAction(def: Pick<ActionDef, 'name' | 'permission'>, rawInput: unknown): boolean {
  if (MAIN_ONLY_ACTIONS.has(def.name) || MAIN_ONLY_PERMISSIONS.has(def.permission)) return true
  if (/^partner[A-Z.]/.test(def.name)) return true
  // A billing action that names the partner bill (Partner › Billing).
  const partnerId = (rawInput as { partnerId?: unknown } | null | undefined)?.partnerId
  return def.name.startsWith('billing.') && partnerId !== undefined
}

/** Permissions a session never holds on a partner's address (Server admin, the partner area, self-serve sign-up). */
export const withoutMainOnlyPermissions = <P extends string>(permissions: readonly P[]): P[] =>
  permissions.filter(p => !MAIN_ONLY_PERMISSIONS.has(p))

export const MAIN_HOST_ONLY = 'main_host_only'

/** For tests: forget the map, so the next request loads it again. */
export function forgetHosts() {
  hosts = null
  failedAt = 0
}
