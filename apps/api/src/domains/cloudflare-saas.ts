// Cloudflare for SaaS (S5): a partner's address is a custom hostname in the install's zone
// (`/zones/:zone/custom_hostnames`, API v4). Created only after partner-domain.ts proved the claim with our own TXT, so
// the DV certificate is validated over HTTP (Cloudflare's validation passes once the partner's CNAME routes to us).
//
// The token is a zone-scoped API token (SSL and Certificates edit); it is sent only to api.cloudflare.com and never
// logged: errors carry Cloudflare's own message and code, cut short.
import { type CustomHostname, type DomainProvider, DomainProviderError } from './provider.ts'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 10_000
/** Cloudflare's error codes: a hostname that exists already in the zone, and one that does not exist. */
const DUPLICATE = 1406
const NOT_FOUND = 1436

type CfError = { code?: number; message?: string }
type CfHostname = {
  id?: string
  hostname?: string
  status?: string
  ssl?: { status?: string; validation_errors?: { message?: string }[] }
  ownership_verification?: { type?: string; name?: string; value?: string }
  verification_errors?: string[]
}
type CfAnswer<T> = { success?: boolean; errors?: CfError[]; result?: T }

const short = (text: unknown, max = 200) => String(text ?? '').slice(0, max)

/** Cloudflare's answer about one hostname, as partner-domain.ts reads it. */
export function hostnameOf(answer: CfHostname): CustomHostname {
  // i18n-ignore: a log line for operators, never shown in the app
  if (!answer.id || !answer.hostname) throw new DomainProviderError('Cloudflare answered without a custom hostname')
  const ownership = answer.ownership_verification
  return {
    id: short(answer.id, 64),
    hostname: short(answer.hostname, 253),
    status: short(answer.status ?? 'pending', 40),
    sslStatus: short(answer.ssl?.status ?? 'initializing', 40),
    ownership:
      ownership?.type === 'txt' && ownership.name && ownership.value
        ? { name: short(ownership.name, 253), value: short(ownership.value, 255) }
        : null,
    errors: [
      ...(answer.verification_errors ?? []).map(e => short(e)),
      ...(answer.ssl?.validation_errors ?? []).map(e => short(e.message)),
    ].slice(0, 5),
  }
}

export function cloudflareSaas(
  config: { token: string; zoneId: string; cnameTarget: string; customOrigin: string | null },
  doFetch: typeof fetch = fetch,
): DomainProvider {
  const zone = `${CLOUDFLARE_API}/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`

  /** One request; a 404 or Cloudflare's "not found" comes back as `null`, any other refusal throws. */
  async function call<T>(method: string, url: string, body?: unknown): Promise<{ result: T | null; codes: number[] }> {
    const response = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await response.json().catch(() => null)) as CfAnswer<T> | null
    const codes = (json?.errors ?? []).map(e => Number(e.code)).filter(Number.isFinite)
    if (response.ok && json?.success !== false) return { result: json?.result ?? null, codes }
    if (response.status === 404 || codes.includes(NOT_FOUND)) return { result: null, codes }
    if (codes.includes(DUPLICATE)) return { result: null, codes }
    const first = json?.errors?.[0]
    // i18n-ignore: a log line for operators, never shown in the app
    throw new DomainProviderError(
      `Cloudflare refused (${response.status}${first?.code ? `, ${first.code}` : ''}): ${short(first?.message ?? 'no reason given')}`,
      response.status,
    )
  }

  async function find(hostname: string): Promise<CustomHostname | null> {
    const { result } = await call<CfHostname[]>('GET', `${zone}?hostname=${encodeURIComponent(hostname)}`)
    const match = (result ?? []).find(h => h.hostname === hostname)
    return match ? hostnameOf(match) : null
  }

  return {
    name: 'cloudflare_saas',
    cnameTarget: config.cnameTarget,
    create: async hostname => {
      const { result, codes } = await call<CfHostname>('POST', zone, {
        hostname,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
        ...(config.customOrigin ? { custom_origin_server: config.customOrigin } : {}),
      })
      if (result) return hostnameOf(result)
      // Made already (a check that created it and did not get to store the id): take that one.
      if (codes.includes(DUPLICATE)) {
        const found = await find(hostname)
        if (found) return found
      }
      // i18n-ignore: a log line for operators, never shown in the app
      throw new DomainProviderError('Cloudflare did not create the custom hostname')
    },
    get: async id => {
      const { result } = await call<CfHostname>('GET', `${zone}/${encodeURIComponent(id)}`)
      return result ? hostnameOf(result) : null
    },
    remove: async id => {
      await call('DELETE', `${zone}/${encodeURIComponent(id)}`)
    },
  }
}
