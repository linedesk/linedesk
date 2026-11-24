// Where a white-label partner's own address is served from (S5, partner-domain.ts): one small interface, an adapter for
// Cloudflare for SaaS (cloudflare-saas.ts, set up in Server admin › Providers › Partner addresses), a fake for
// development and tests (fake.ts, PARTNER_DOMAINS=fake), and none (Partner › Domain is hidden). Which one is in use:
// partner-domain.ts domainProvider.
//
// The provider only ever creates, reads and deletes the custom hostnames partner-domain.ts names. Our own proof of the
// claim (the `_linedesk` TXT, doh.ts) and the probe through the address are partner-domain.ts's, never the provider's.
import type { ProviderName } from '@linedesk/actions'

/** A custom hostname as the provider said it, reduced to what partner-domain.ts acts on. */
export type CustomHostname = {
  id: string
  hostname: string
  /** The hostname's status as the provider said it (Cloudflare: `pending`, `active`, `moved`, `blocked`…). */
  status: string
  /** The certificate's status (Cloudflare: `pending_validation`, `active`, `validation_timed_out`…). */
  sslStatus: string
  /** The provider's own ownership TXT, when the name is held in another Cloudflare account. */
  ownership: { name: string; value: string } | null
  /** The provider's error texts (verification and certificate), short; for logs and the admin, never the partner. */
  errors: string[]
}

/** What partner-domain.ts reads from a custom hostname. */
export type HostnameState = 'active' | 'pending' | 'moved' | 'blocked' | 'cert_failed'

const BLOCKED = new Set(['blocked', 'pending_blocked', 'test_blocked', 'test_failed', 'deleted', 'pending_deletion'])
const CERT_FAILED = new Set([
  'initializing_timed_out',
  'validation_timed_out',
  'issuance_timed_out',
  'deployment_timed_out',
  'expired',
  'deleted',
  'inactive',
])

/** `active` only when the name and its certificate are both active; `moved` when the name no longer points to us. */
export function hostnameState(h: Pick<CustomHostname, 'status' | 'sslStatus'>): HostnameState {
  if (h.status === 'moved') return 'moved'
  if (BLOCKED.has(h.status)) return 'blocked'
  if (CERT_FAILED.has(h.sslStatus)) return 'cert_failed'
  if (h.status === 'active' && h.sslStatus === 'active') return 'active'
  return 'pending'
}

/** The fake's stand-ins for the network checks (development and tests): our TXT and the probe. */
export type Simulated = { txtFound(hostname: string): boolean; probePasses(hostname: string): boolean }

export interface DomainProvider {
  name: Extract<ProviderName, 'cloudflare_saas'> | 'fake'
  /** Where partners point their address (CNAME). */
  cnameTarget: string
  /** Creates the custom hostname, or returns the one that exists already for this name (a retry after a crash). */
  create(hostname: string): Promise<CustomHostname>
  get(id: string): Promise<CustomHostname | null>
  /** Deletes the custom hostname; one that is gone already counts as done. */
  remove(id: string): Promise<void>
  simulated?: Simulated
}

/** A provider's answer that is not what partner-domain.ts asked for: its message, never the token. */
export class DomainProviderError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}
