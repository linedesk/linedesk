// Where a white-label partner's sender domain is verified (S6, partner-sender.ts): one small interface, an adapter for
// Resend (the install sends with Resend and a full-access "domains" key is set in Server admin › Providers › Resend),
// a fake for development and tests (SENDER_DOMAINS=fake), and none (Partner › Email sender is hidden).
//
// The Resend adapter only ever creates, reads, verifies and deletes the domains partner-sender.ts names; the key is read
// from the environment at call time (instance-env.ts copies the stored value in) and never logged.
import type { SenderDnsRecord } from '@linedesk/db'
import { emailProviderInUse } from '../instance-env.ts'

/** The provider's word on a domain, reduced to what partner-sender.ts acts on. */
export type SenderDomainState = 'pending' | 'verified' | 'failed'

export type SenderDomain = {
  id: string
  /** As the provider said it (`not_started`, `pending`, `verified`, `partially_verified`, `failed`…). */
  status: string
  state: SenderDomainState
  records: SenderDnsRecord[]
}

export interface SenderDomainProvider {
  name: 'resend' | 'fake'
  create(domain: string): Promise<SenderDomain>
  get(id: string): Promise<SenderDomain | null>
  /** Asks the provider to look at the DNS records again; get() then tells the result (now or a little later). */
  verify(id: string): Promise<void>
  /** Deletes the domain at the provider; one that is gone already counts as done. */
  remove(id: string): Promise<void>
}

/** A provider's answer that is not what partner-sender.ts asked for: its message, without any key. */
export class SenderDomainError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

/**
 * `verified` only when Resend says so (never `partially_verified`: some records are still missing, and mail would be
 * refused or land in spam); `failed` for its failed states; anything else is still pending.
 */
export function stateOf(status: string): SenderDomainState {
  if (status === 'verified') return 'verified'
  if (status === 'failed' || status === 'temporary_failure' || status === 'partially_failed') return 'failed'
  return 'pending'
}

type ResendRecord = {
  record?: string
  name?: string
  type?: string
  ttl?: string
  status?: string
  value?: string
  priority?: number
}
type ResendDomain = { id?: string; name?: string; status?: string; records?: ResendRecord[] }

const RESEND = 'https://api.resend.com'
const TIMEOUT_MS = 15_000

/** Resend's records as the partner adds them: the name relative to the domain's zone, as Resend shows it. */
const recordsOf = (records: ResendRecord[] | undefined): SenderDnsRecord[] =>
  (records ?? [])
    .filter(r => r.type && r.name !== undefined && r.value)
    .map(r => ({
      type: String(r.type).slice(0, 10),
      name: String(r.name).slice(0, 253),
      value: String(r.value).slice(0, 2048),
      priority: typeof r.priority === 'number' ? r.priority : null,
      ttl: r.ttl ? String(r.ttl).slice(0, 20) : null,
      status: r.status ? String(r.status).slice(0, 30) : null,
    }))

const domainOf = (answer: ResendDomain): SenderDomain => {
  // i18n-ignore: a log line for operators, never shown in the app
  if (!answer.id) throw new SenderDomainError('Resend answered without a domain id')
  const status = String(answer.status ?? 'not_started')
  return { id: answer.id, status, state: stateOf(status), records: recordsOf(answer.records) }
}

export function resendSenderDomains(key: string, doFetch: typeof fetch = fetch): SenderDomainProvider {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const response = await doFetch(`${RESEND}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = await response.json().catch(() => null)
    if (response.ok || response.status === 404) return { status: response.status, json }
    const message = (json as { message?: unknown } | null)?.message
    // Resend's own words (they never hold the key), cut short. Logged only; the partner sees provider_failed.
    // i18n-ignore: a log line for operators, never shown in the app
    throw new SenderDomainError(
      `Resend refused (${response.status}): ${typeof message === 'string' ? message.slice(0, 200) : 'no reason given'}`,
      response.status,
    )
  }
  return {
    name: 'resend',
    // Open and click tracking stay off (the default): system emails only, nothing to track.
    create: async domain => {
      const answer = await call('POST', '/domains', { name: domain, region: 'us-east-1' })
      // i18n-ignore: a log line for operators, never shown in the app
      if (answer.status === 404) throw new SenderDomainError('Resend answered 404 to a new domain', 404)
      return domainOf(answer.json as ResendDomain)
    },
    get: async id => {
      const answer = await call('GET', `/domains/${encodeURIComponent(id)}`)
      return answer.status === 404 ? null : domainOf(answer.json as ResendDomain)
    },
    verify: async id => {
      await call('POST', `/domains/${encodeURIComponent(id)}/verify`)
    },
    remove: async id => {
      await call('DELETE', `/domains/${encodeURIComponent(id)}`)
    },
  }
}

/**
 * Development and tests: no provider, the records are made up, and a domain is verified at its first check, except
 * domains whose first label is `pending` (never verified) or `failing` (the provider says failed).
 */
export const fakeSenderDomains: SenderDomainProvider = {
  name: 'fake',
  create: async domain => ({
    id: `fake_${domain}`,
    status: 'not_started',
    state: 'pending',
    records: fakeRecords(domain, 'not_started'),
  }),
  get: async id => {
    if (!id.startsWith('fake_')) return null
    const domain = id.slice('fake_'.length)
    const first = domain.split('.')[0]
    const status = first === 'pending' ? 'pending' : first === 'failing' ? 'failed' : 'verified'
    return { id, status, state: stateOf(status), records: fakeRecords(domain, status) }
  },
  verify: async () => {},
  remove: async () => {},
}

function fakeRecords(domain: string, status: string): SenderDnsRecord[] {
  return [
    { type: 'TXT', name: 'resend._domainkey', value: `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNfake${domain.length}`, status },
    { type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, status },
    { type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all', status },
  ]
}

/**
 * The provider partner sender domains use now, or null (Partner › Email sender hidden): the fake when
 * SENDER_DOMAINS=fake, else Resend when the install sends with Resend and its domains key is set.
 */
export function senderDomainProvider(
  env: Record<string, string | undefined> = process.env,
): SenderDomainProvider | null {
  if (env.SENDER_DOMAINS === 'fake') return fakeSenderDomains
  const key = env.RESEND_DOMAINS_API_KEY?.trim()
  if (key && emailProviderInUse() === 'resend') return resendSenderDomains(key)
  return null
}
