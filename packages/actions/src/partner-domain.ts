// A white-label partner's own address (docs/white-label.md, slice S5, PR 5.4): its clients sign in at
// `app.theiragency.com`, served through Cloudflare for SaaS. The partner adds two DNS records (our TXT proves the claim,
// the CNAME routes the name to us); only once our TXT resolves is the name created at Cloudflare, and it goes live once
// Cloudflare says active for the name and its certificate and our own probe answers through it.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** The states the partner sees (a removed address is gone from the page). */
export const PARTNER_DOMAIN_STATES = ['pending', 'verifying', 'active', 'failed', 'stopped'] as const
export type PartnerDomainState = (typeof PARTNER_DOMAIN_STATES)[number]

/** Why an address is not working, as the check found it. */
export type PartnerDomainFailure = 'cname_missing' | 'txt_missing' | 'cert_failed' | 'moved' | 'probe_failed'

/** One DNS record the partner adds at its DNS host. `found`: our check (TXT) or Cloudflare (the others) saw it. */
export type DomainRecord = { type: string; name: string; value: string; found: boolean }

/** `partnerDomain.get`: the partner's address, its records and steps, and whether the owner can change it. */
export type PartnerDomainData = {
  /** The install has a domain provider (Cloudflare for SaaS, or the fake in development); else the section is hidden. */
  available: boolean
  /** What is still missing before an address can be added: an approved brand, a paid first invoice. Null: nothing. */
  locked: { brandApproved: boolean; paid: boolean } | null
  domain: {
    hostname: string
    /** `https://<hostname>`. */
    origin: string
    status: PartnerDomainState
    records: DomainRecord[]
    failure: PartnerDomainFailure | null
    lastCheckedAt: string | null
    activeAt: string | null
    failedAt: string | null
  } | null
  /** The last address a server admin (or the 30-day cleanup) removed, while no new one is added. */
  removed: { hostname: string; reason: string; byAdmin: boolean; at: string } | null
  canEdit: boolean
}

/** Why a domain action was refused, as the rejection's `code`: the web app shows `team.partner.domain.error.<code>`. */
export const PARTNER_DOMAIN_CODES = [
  'domain_unavailable',
  'domain_locked',
  'domain_exists',
  'no_domain',
  'domain_invalid',
  'domain_apex',
  'domain_ours',
  'domain_taken',
  'name_protected',
  'provider_failed',
  'too_many_checks',
] as const
export type PartnerDomainCode = (typeof PARTNER_DOMAIN_CODES)[number]

/** Longest host name DNS allows. */
export const MAX_HOSTNAME = 253
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4ISH = /^[0-9.]+$/

/**
 * A typed address as the host name we store, or null when it is not one: lower-case, no port, no trailing dot,
 * international names as punycode (`xn--`), at least three labels (a subdomain), letters, digits and hyphens only,
 * never an IP address, never `..`, at most 253 characters. `https://app.example.com/` is accepted as its host name.
 * Whether the name is an apex under a longer public suffix (`app.co.uk`) or ours is checked on the server.
 */
export function parsePartnerHostname(typed: string): string | null {
  let text = typed.trim().toLowerCase()
  const scheme = /^https?:\/\//.exec(text)
  if (scheme) {
    text = text.slice(scheme[0].length)
    if (text.endsWith('/')) text = text.slice(0, -1)
  }
  if (text.endsWith('.')) text = text.slice(0, -1)
  if (!text || text.length > MAX_HOSTNAME * 2) return null
  // Nothing but a name: no port, path, user, query, IPv6 brackets or escapes.
  if (/[\s/\\:@?#[\]%*]/.test(text) || text.includes('..') || text.startsWith('.')) return null
  if (IPV4ISH.test(text)) return null
  let host: string
  try {
    // The WHATWG URL parser turns an international name into punycode (IDNA), in the browser and in Node alike.
    host = new URL(`https://${text}/`).hostname
  } catch {
    return null
  }
  if (!host || host.length > MAX_HOSTNAME || host.includes('..') || IPV4ISH.test(host)) return null
  const labels = host.split('.')
  if (labels.length < 3 || !labels.every(l => LABEL.test(l))) return null
  // The top-level label is never all digits (that would be an IP address in disguise).
  if (/^\d+$/.test(labels.at(-1)!)) return null
  return host
}

/** The TXT record that proves a claim: `_linedesk.<hostname>` = `linedesk-verify=<token>`. */
export const challengeName = (hostname: string) => `_linedesk.${hostname}`
export const challengeValue = (token: string) => `linedesk-verify=${token}`

const partnerId = z.string().min(1).max(64)
const hostname = z.string().trim().min(3).max(300)

export const partnerDomainGet = defineAction({
  name: 'partnerDomain.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The partner's own address for its clients (e.g. app.yourcompany.com): its state, the DNS records to add and whether they were found. Anyone on the partner's team.",
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerDomainAdd = defineAction({
  name: 'partnerDomain.add',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Give the partner's clients an address of the partner's own, a subdomain like app.yourcompany.com. Returns the two DNS records to add; it goes live by itself once they are in. Needs an approved brand and a paid first invoice. The partner's owner only.",
  input: z.object({ partnerId, hostname }),
  permission: 'partner',
})

export const partnerDomainCheck = defineAction({
  name: 'partnerDomain.check',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Check the partner's address now (also restarts checks that stopped). The partner's owner only; a few per 10 minutes.",
  input: z.object({ partnerId }),
  permission: 'partner',
})

export const partnerDomainRemove = defineAction({
  name: 'partnerDomain.remove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove the partner's own address, with the address typed to confirm. Its clients' sign-ins there end and emails link to the standard address again. The partner's owner only.",
  input: z.object({ partnerId, hostname }),
  permission: 'partner',
})

export const partnerDomainAdminRemove = defineAction({
  name: 'partnerDomain.adminRemove',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove a partner's own address at once (Server admin › Partners), with a reason the partner's owner is emailed.",
  input: z.object({ partnerId, reason: z.string().trim().min(3).max(300) }),
  permission: 'instance:admin',
})
