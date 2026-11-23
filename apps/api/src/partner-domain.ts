// A white-label partner's own address (docs/white-label.md, slice S5, PR 5.4; actions in
// packages/actions/src/partner-domain.ts). The partner's owner adds a subdomain of its own (`app.theiragency.com`);
// its clients sign in there once it is live (request-host.ts, host-sessions.ts).
//
// - Add: the name is checked (a subdomain, not an apex under a public suffix, not ours, no protected name in a label,
//   not held by anyone else) and stored `pending` with a fresh random challenge token. Nothing is created at the
//   provider yet.
// - Check (the job every 5 minutes for the first hour, then every 30 minutes up to 72 hours, then `stopped`; and "Check
//   now"): our TXT `_linedesk.<host>` = `linedesk-verify=<token>` must resolve at two DNS-over-HTTPS resolvers before
//   the custom hostname is created at Cloudflare (domain takeover: a CNAME left behind by a former partner never
//   passes, its token was another). Then `verifying` until Cloudflare says active for the name and its certificate
//   and our own probe (`/v1/health/host`, HMAC of the id and a fresh nonce) answers through the address: `active`.
// - Daily recheck of live addresses: Cloudflare `moved` fails at once, a failed probe or certificate twice in a row
//   (one hiccup is not enough). A failed address leaves the host map at once and its owner is emailed; 30 days failed
//   (or its partner suspended, or its bill ended, for 30 days) and it is removed at Cloudflare and here.
// - Remove (the owner, or a server admin with a reason): Cloudflare first (gone already counts as done), then here.
// Every change to a row reloads the host map after its commit (reloadHosts; security review of #1172, N-8).
import { randomBytes } from 'node:crypto'
import { domainToUnicode } from 'node:url'
import {
  challengeName,
  challengeValue,
  type DomainRecord,
  type PartnerDomainCode,
  type PartnerDomainData,
  type PartnerDomainFailure,
  type PartnerDomainState,
  parsePartnerHostname,
  protectedNameIn,
} from '@linedesk/actions'
import {
  billing_accounts,
  commands,
  partner_branding,
  partner_domains,
  partner_members,
  partners,
  type Tx,
  user,
} from '@linedesk/db'
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { getDomain } from 'tldts'
import { Agent, fetch as undiciFetch } from 'undici'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { db } from './db.ts'
import { cloudflareSaas } from './domains/cloudflare-saas.ts'
import { txtProven } from './domains/doh.ts'
import { fakeDomains } from './domains/fake.ts'
import { type CustomHostname, type DomainProvider, DomainProviderError, hostnameState } from './domains/provider.ts'
import { installAddress, sendNotice } from './email.ts'
import { withEmailBrand } from './email-brand.ts'
import { type PartnerDomainEmail, partnerDomainAddedAlert, partnerDomainEmail } from './emails/partner.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { queueDomainCheck } from './jobs.ts'
import { brandGate, partnerOnTeam, protectedNames } from './partner-brand.ts'
import { activeProvider } from './provider-settings.ts'
import { createRateLimiter } from './rate-limit.ts'
import { hostProbePassed, isMainHost, reloadHosts } from './request-host.ts'
import { publicLookup } from './webhooks.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A new address is checked this long, then `stopped` until "Check now". */
export const DOMAIN_CHECKS_FOR_MS = 72 * HOUR
/** A failed address (or one of a suspended partner or an ended bill) is removed after this long. */
export const DOMAIN_REMOVE_AFTER_MS = 30 * DAY
/** "Check now" asks DNS and Cloudflare each time: a few in a row are normal, more per partner are refused. */
export const DOMAIN_CHECKS_PER_10_MIN = 10
const allowCheck = createRateLimiter({ max: DOMAIN_CHECKS_PER_10_MIN, windowMs: 10 * MINUTE })
/** Who the job's own audit entries and removals are by. */
export const DOMAIN_SYSTEM_ACTOR = 'partner-domains:system'

// i18n-ignore: API error bodies for logs and API clients; the partner area shows team.partner.domain.error.<code>
const REFUSALS: Record<PartnerDomainCode, string> = {
  domain_unavailable: 'this server has no provider for partner addresses (Cloudflare for SaaS)',
  domain_locked: 'an own address needs an approved brand and a paid first invoice',
  domain_exists: 'this partner has an address already: remove it first',
  no_domain: 'this partner has no such address',
  domain_invalid: 'not an address, use a subdomain like app.yourcompany.com',
  domain_apex: 'use a subdomain, like app.yourcompany.com',
  domain_ours: 'this address belongs to the service',
  domain_taken: 'this address is already in use',
  name_protected: 'this address contains a protected name',
  provider_failed: 'the provider did not answer as expected: try again in a moment',
  too_many_checks: 'too many checks: try again in a few minutes',
}
const refuse = (code: PartnerDomainCode) => new Reject(REFUSALS[code], code)

type DomainRow = typeof partner_domains.$inferSelect
type PartnerRow = typeof partners.$inferSelect
/** What we keep of Cloudflare's last answer (`provider_status`), plus the failed live checks in a row. */
type ProviderStatus = { status?: string; ssl_status?: string; errors?: string[]; misses?: number }
type ProviderRecords = { ownership?: { name: string; value: string } | null }

/**
 * The provider partner addresses use now, or null (Partner › Domain hidden): the fake when PARTNER_DOMAINS=fake, else
 * Cloudflare for SaaS once its token, zone and CNAME target are stored in Server admin › Providers.
 */
export async function domainProvider(
  env: Record<string, string | undefined> = process.env,
): Promise<DomainProvider | null> {
  if (env.PARTNER_DOMAINS === 'fake') return fakeDomains(env.PARTNER_DOMAINS_CNAME_TARGET || 'partners.linedesk.test')
  const active = await activeProvider(db, 'domains').catch(e => {
    console.error('partner domains: could not read the provider settings', e instanceof Error ? e.message : e)
    return null
  })
  if (active?.provider !== 'cloudflare_saas') return null
  const value = (field: string) => active.config[field]?.value?.trim() || ''
  const [token, zoneId, cnameTarget] = [value('api_token'), value('zone_id'), value('cname_target')]
  if (!token || !zoneId || !cnameTarget) return null
  return cloudflareSaas({ token, zoneId, cnameTarget, customOrigin: value('custom_origin') || null })
}

// --- Which names a partner may use -----------------------------------------------------------------------------------

/** The registrable domain of a host (`app.linedesk.ai` → `linedesk.ai`), or the host itself where there is none. */
const registrable = (host: string) => getDomain(host, { allowPrivateDomains: true }) ?? host

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url.trim()).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * The install's own domains: those of its own addresses (WEB_ORIGIN, PUBLIC_URL, BETTER_AUTH_URL, the development
 * origins), its sender (EMAIL_FROM) and the provider's CNAME target, each as its registrable domain. A partner address
 * on one of them, or under one, would be ours.
 */
export function ownDomains(env: Record<string, string | undefined> = process.env, cnameTarget?: string): string[] {
  const hosts = [
    hostOf(env.WEB_ORIGIN ?? 'http://localhost:5173'),
    hostOf(env.PUBLIC_URL),
    hostOf(env.BETTER_AUTH_URL),
    ...(env.LINEDESK_DEV_ORIGINS ?? '').split(',').map(o => hostOf(o)),
    cnameTarget?.toLowerCase() ?? null,
  ]
  const from = installAddress(env.EMAIL_FROM)
  if (from.includes('@')) hosts.push(from.slice(from.lastIndexOf('@') + 1).toLowerCase())
  return [...new Set(hosts.filter((h): h is string => !!h).map(registrable))]
}

/**
 * Why a (parsed) host name cannot be a partner's address, or null: an apex or a public suffix (`app.co.uk` is an
 * apex), one of ours, or a protected name in a label (in its punycode and its Unicode form, as brand names).
 */
export function hostnameRefusal(
  host: string,
  protectedList: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cnameTarget?: string,
): 'domain_apex' | 'domain_ours' | 'name_protected' | null {
  if (isMainHost(host) || ownDomains(env, cnameTarget).some(own => host === own || host.endsWith(`.${own}`)))
    return 'domain_ours'
  const domain = getDomain(host, { allowPrivateDomains: true })
  if (!domain || domain === host) return 'domain_apex'
  const forms = [host, domainToUnicode(host) || host]
  for (const form of forms) {
    const labels = form.split('.').slice(0, -1)
    if (labels.some(label => protectedNameIn(label.replace(/-/g, ' '), protectedList))) return 'name_protected'
    if (protectedNameIn(labels.join(' '), protectedList)) return 'name_protected'
  }
  return null
}

// --- The network checks ----------------------------------------------------------------------------------------------

/** How a check looks at the world: our TXT and the probe. The fake provider simulates both; tests may replace them. */
export type DomainCheckDeps = {
  txt(hostname: string, expected: string): Promise<'match' | 'missing' | 'unknown'>
  probe(hostname: string, domainId: string): Promise<boolean>
}

const PROBE_TIMEOUT_MS = 5_000
const PROBE_MAX_BYTES = 4096
// Only public addresses, checked on the address the connection uses (no DNS rebinding to an internal service).
// Made at the first probe, not at import (webhooks.ts is part of an import cycle with the actions).
let probeAgent: Agent | null = null
const probeDispatcher = () =>
  (probeAgent ??= new Agent({ connect: { lookup: publicLookup() as never, timeout: PROBE_TIMEOUT_MS } }))

/**
 * GET https://<hostname>/v1/health/host?nonce=<fresh> through Cloudflare: passes only when the answer is this install's
 * HMAC of the id and the nonce (hostProbePassed). https only, public addresses only, no redirects, a small body.
 */
export async function probeHost(hostname: string, domainId: string): Promise<boolean> {
  const nonce = randomBytes(24).toString('base64url')
  try {
    const res = await undiciFetch(`https://${hostname}/v1/health/host?nonce=${nonce}`, {
      redirect: 'manual',
      dispatcher: probeDispatcher(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      return false
    }
    // The partner's DNS decides where this goes: read at most PROBE_MAX_BYTES, never a whole body it sends.
    let text = ''
    const decoder = new TextDecoder()
    for await (const chunk of res.body ?? []) {
      text += decoder.decode(chunk as Uint8Array, { stream: true })
      if (text.length > PROBE_MAX_BYTES) {
        await res.body?.cancel().catch(() => {})
        return false
      }
    }
    return hostProbePassed(domainId, nonce, JSON.parse(text) as { domainId?: unknown; proof?: unknown })
  } catch {
    return false
  }
}

const networkDeps: DomainCheckDeps = {
  txt: (hostname, expected) => txtProven(challengeName(hostname), expected),
  probe: probeHost,
}
let depsOverride: DomainCheckDeps | null = null
/** For tests: the TXT lookup and the probe every check uses until reset with null. */
export const setDomainCheckDeps = (deps: DomainCheckDeps | null) => {
  depsOverride = deps
}
const depsFor = (provider: DomainProvider): DomainCheckDeps => {
  if (depsOverride) return depsOverride
  const simulated = provider.simulated
  if (!simulated) return networkDeps
  return {
    txt: async hostname => (simulated.txtFound(hostname) ? 'match' : 'missing'),
    probe: async hostname => simulated.probePasses(hostname),
  }
}

/** What one check saw, before its transaction: our TXT (and what Cloudflare made then), or the custom hostname. */
export type Observation =
  | { kind: 'txt'; txt: 'match' | 'missing' | 'unknown'; created: CustomHostname | null }
  | { kind: 'hostname'; found: CustomHostname | null; probe: boolean | null }
  /** "Check now" on an address that failed before it was ever live: the custom hostname was deleted to start again. */
  | { kind: 'restarted' }

/**
 * The network part of a check (never in a transaction): without a custom hostname, our TXT, and only when it matches
 * the custom hostname is created; with one, Cloudflare's state and, when it says active, the probe. `restart` ("Check
 * now") deletes the custom hostname of an address that never went live and failed or stopped, so it starts again.
 */
export async function observeDomain(
  row: DomainRow,
  provider: DomainProvider,
  { restart = false }: { restart?: boolean } = {},
): Promise<Observation> {
  const deps = depsFor(provider)
  if (row.provider_id && restart && !row.active_at && (row.status === 'failed' || row.status === 'stopped')) {
    await provider.remove(row.provider_id)
    return { kind: 'restarted' }
  }
  if (!row.provider_id) {
    const txt = await deps.txt(row.hostname, challengeValue(row.challenge_token))
    return { kind: 'txt', txt, created: txt === 'match' ? await provider.create(row.hostname) : null }
  }
  const found = await provider.get(row.provider_id)
  const probe = found && hostnameState(found) === 'active' ? await deps.probe(row.hostname, row.id) : null
  return { kind: 'hostname', found, probe }
}

// --- Applying a check ------------------------------------------------------------------------------------------------

/** What a check changed that needs work after its commit. */
export type CheckOutcome = {
  row: DomainRow | null
  /** The status before and after. */
  from: DomainRow['status']
  to: DomainRow['status']
  /** A custom hostname this check created for a row that is gone now: deleted again after the commit. */
  orphan: string | null
  email: PartnerDomainEmail | null
}

const statusOf = (h: CustomHostname, misses = 0): ProviderStatus => ({
  status: h.status,
  ssl_status: h.sslStatus,
  errors: h.errors,
  misses,
})

/** Why a live address that did not pass this check is not working. */
const liveFailure = (found: CustomHostname | null, probe: boolean | null): PartnerDomainFailure => {
  if (!found) return 'cname_missing'
  const state = hostnameState(found)
  if (state === 'cert_failed') return 'cert_failed'
  if (state === 'active' && probe === false) return 'probe_failed'
  return 'cname_missing'
}

/**
 * Stores what a check saw and moves the row's state (in the caller's transaction, the row locked). `restart`: "Check
 * now", which gives a stopped or failed address 72 more hours.
 */
export async function applyDomainCheck(
  tx: Tx,
  rowId: string,
  seen: Observation,
  now: string,
  { restart = false }: { restart?: boolean } = {},
): Promise<CheckOutcome> {
  const [row] = await tx.select().from(partner_domains).where(eq(partner_domains.id, rowId)).for('update')
  const created = seen.kind === 'txt' ? seen.created : null
  if (!row || row.status === 'removed' || (created && row.provider_id && row.provider_id !== created.id))
    return {
      row: row ?? null,
      from: row?.status ?? 'removed',
      to: row?.status ?? 'removed',
      orphan: created?.id ?? null,
      email: null,
    }
  const nowMs = Date.parse(now)
  const until = restart ? new Date(nowMs + DOMAIN_CHECKS_FOR_MS).toISOString() : row.checks_until
  const pastDeadline = !restart && !!until && Date.parse(until) < nowMs
  const previous = (row.provider_status ?? {}) as ProviderStatus
  const set: Partial<typeof partner_domains.$inferInsert> = { last_checked_at: now, checks_until: until }
  let email: PartnerDomainEmail | null = null
  let status = row.status

  if (seen.kind === 'restarted') {
    Object.assign(set, {
      provider_id: null,
      provider_records: null,
      provider_status: null,
      failure: null,
      failed_at: null,
    })
    status = 'pending'
  } else if (seen.kind === 'txt') {
    if (created) {
      Object.assign(set, {
        provider_id: created.id,
        provider_records: { ownership: created.ownership } satisfies ProviderRecords,
        provider_status: statusOf(created),
        failure: null,
      })
      status = 'verifying'
    } else {
      status = pastDeadline ? 'stopped' : 'pending'
      set.failure = null
    }
  } else {
    const { found, probe } = seen
    const state = found ? hostnameState(found) : null
    const passed = state === 'active' && probe === true
    if (found) {
      set.provider_status = statusOf(found, passed ? 0 : (previous.misses ?? 0))
      set.provider_records = { ownership: found.ownership } satisfies ProviderRecords
    }
    const wasLive = row.status === 'active' || (row.status === 'failed' && !!row.active_at)
    if (passed) {
      status = 'active'
      Object.assign(set, { failure: null, failed_at: null })
      if (row.status !== 'active') {
        set.active_at = now
        email = { kind: 'live', hostname: row.hostname }
      }
    } else if (wasLive) {
      // Live before: `moved` at once, anything else twice in a row (one DNS or certificate hiccup is not enough).
      const misses = (previous.misses ?? 0) + 1
      set.provider_status = { ...((set.provider_status as ProviderStatus) ?? previous), misses }
      if (row.status === 'active' && (state === 'moved' || misses >= 2)) {
        status = 'failed'
        Object.assign(set, { failure: state === 'moved' ? 'moved' : liveFailure(found, probe), failed_at: now })
        email = { kind: 'failed', hostname: row.hostname }
      }
    } else if (!found) {
      // Deleted at the provider before it went live: start again from our TXT.
      Object.assign(set, { provider_id: null, provider_records: null, provider_status: null, failure: null })
      status = pastDeadline ? 'stopped' : 'pending'
    } else if (state === 'cert_failed' || state === 'blocked') {
      status = 'failed'
      Object.assign(set, { failure: 'cert_failed', failed_at: row.failed_at ?? now })
    } else {
      status = pastDeadline ? 'stopped' : 'verifying'
      set.failure = state === 'active' && probe === false ? 'probe_failed' : state === 'moved' ? 'cname_missing' : null
    }
  }
  set.status = status
  const [updated] = await tx
    .update(partner_domains)
    .set(set)
    .where(and(eq(partner_domains.id, row.id), ne(partner_domains.status, 'removed')))
    .returning()
  if (email?.kind === 'live' || email?.kind === 'failed')
    await recordSystemAudit(tx, email.kind === 'live' ? 'partnerDomain.live' : 'partnerDomain.failed', row, {
      failure: set.failure ?? null,
    })
  return { row: updated ?? null, from: row.status, to: status, orphan: null, email }
}

/** An audit entry the job writes itself (kind Partners): an address went live, failed, or was removed after 30 days. */
export async function recordSystemAudit(
  tx: Tx,
  action: 'partnerDomain.live' | 'partnerDomain.failed' | 'partnerDomain.expired',
  row: Pick<DomainRow, 'id' | 'partner_id' | 'hostname'>,
  data: Record<string, unknown> = {},
) {
  await tx.insert(commands).values({
    id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
    workspace_id: null,
    actor_id: DOMAIN_SYSTEM_ACTOR,
    action,
    input: { partnerId: row.partner_id, hostname: row.hostname },
    result: { ok: true, rows: {}, data: { domainId: row.id, ...data } },
  })
}

/** After a check's commit: the host map, the owner's email, and a custom hostname nobody stores any more. */
async function afterCheck(outcome: CheckOutcome, provider: DomainProvider | null) {
  if (outcome.from !== outcome.to || outcome.email) await reloadHosts()
  if (outcome.email && outcome.row) await emailOwner(db, outcome.row.partner_id, outcome.email)
  if (outcome.orphan && provider)
    await provider.remove(outcome.orphan).catch(e => console.error('could not delete a custom hostname', errorText(e)))
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

// --- The jobs --------------------------------------------------------------------------------------------------------

/** Whether the frequent job checks a new address now: 5 minutes apart in its first hour, then 30, until stopped. */
export function domainCheckDue(row: DomainRow, now: string): boolean {
  if (row.status !== 'pending' && row.status !== 'verifying') return false
  const nowMs = Date.parse(now)
  const last = row.last_checked_at ? Date.parse(row.last_checked_at) : 0
  const until = row.checks_until ? Date.parse(row.checks_until) : 0
  if (nowMs > until) return true // once more, to turn it stopped
  const every = nowMs - (until - DOMAIN_CHECKS_FOR_MS) < HOUR ? 5 * MINUTE : 30 * MINUTE
  return nowMs - last >= every
}

/** Checks one address now (the job, or the first check after it was added). Never throws. */
export async function checkOneDomain(rowId: string, now = new Date().toISOString(), provider?: DomainProvider | null) {
  const using = provider === undefined ? await domainProvider() : provider
  const [row] = await db.select().from(partner_domains).where(eq(partner_domains.id, rowId))
  if (!row || row.status === 'removed') return null
  try {
    const pastDeadline = row.checks_until && Date.parse(row.checks_until) < Date.parse(now)
    if (!using || ((row.status === 'pending' || row.status === 'verifying') && pastDeadline)) {
      // Past its 72 hours: stopped without asking anyone.
      if (pastDeadline && (row.status === 'pending' || row.status === 'verifying')) {
        await db
          .update(partner_domains)
          .set({ status: 'stopped' })
          .where(and(eq(partner_domains.id, row.id), inArray(partner_domains.status, ['pending', 'verifying'])))
        await reloadHosts()
      }
      return null
    }
    const seen = await observeDomain(row, using)
    const outcome = await db.transaction(tx => applyDomainCheck(tx, row.id, seen, now))
    await afterCheck(outcome, using)
    return outcome
  } catch (e) {
    console.error(`partner domain check of ${row.partner_id} failed:`, errorText(e))
    return null
  }
}

/** The frequent job (every 5 minutes): new addresses that are due. Never throws. */
export async function checkPartnerDomains(now = new Date().toISOString()) {
  const provider = await domainProvider()
  const rows = await db
    .select({ row: partner_domains, partnerStatus: partners.status })
    .from(partner_domains)
    .innerJoin(partners, eq(partners.id, partner_domains.partner_id))
    .where(inArray(partner_domains.status, ['pending', 'verifying']))
  for (const { row, partnerStatus } of rows)
    if (partnerStatus !== 'suspended' && domainCheckDue(row, now)) await checkOneDomain(row.id, now, provider)
}

/**
 * The daily job: every live or failed address is checked again (Cloudflare and the probe); an address that failed 30
 * days ago, or whose partner is suspended or whose bill ended 30 days ago, is removed at Cloudflare and here. Never
 * throws.
 */
export async function recheckPartnerDomains(now = new Date().toISOString()) {
  const provider = await domainProvider()
  const nowMs = Date.parse(now)
  const rows = await db
    .select({
      row: partner_domains,
      partner: partners,
      billStatus: billing_accounts.status,
      billEnded: billing_accounts.canceled_at,
    })
    .from(partner_domains)
    .innerJoin(partners, eq(partners.id, partner_domains.partner_id))
    .leftJoin(billing_accounts, eq(billing_accounts.id, partners.billing_account_id))
    .where(ne(partner_domains.status, 'removed'))
  for (const { row, partner, billStatus, billEnded } of rows) {
    const old = (at: string | null) => !!at && nowMs - Date.parse(at) >= DOMAIN_REMOVE_AFTER_MS
    const expired =
      (row.status === 'failed' && old(row.failed_at)) ||
      (partner.status === 'suspended' && old(partner.suspended_at)) ||
      (billStatus === 'canceled' && old(billEnded))
    try {
      if (expired) {
        if (row.provider_id && provider) await provider.remove(row.provider_id)
        const removed = await db.transaction(async tx => {
          const done = await markRemoved(tx, row.id, DOMAIN_SYSTEM_ACTOR, now, 'expired')
          if (done) await recordSystemAudit(tx, 'partnerDomain.expired', done)
          return done
        })
        await reloadHosts()
        if (removed) await emailOwner(db, row.partner_id, { kind: 'expired', hostname: row.hostname })
        continue
      }
      if (partner.status === 'suspended' || !provider) continue
      if (row.status !== 'active' && row.status !== 'failed') continue
      if (row.last_checked_at && nowMs - Date.parse(row.last_checked_at) < DAY - HOUR) continue
      const seen = await observeDomain(row, provider)
      const outcome = await db.transaction(tx => applyDomainCheck(tx, row.id, seen, now))
      await afterCheck(outcome, provider)
    } catch (e) {
      console.error(`partner domain recheck of ${row.partner_id} failed:`, errorText(e))
    }
  }
}

// --- What the page reads ---------------------------------------------------------------------------------------------

const currentRow = async (tx: Pick<Tx, 'select'>, partnerId: string) =>
  (
    await tx
      .select()
      .from(partner_domains)
      .where(and(eq(partner_domains.partner_id, partnerId), ne(partner_domains.status, 'removed')))
  )[0] ?? null

/** Whether Partner › Domain is shown: this server has a provider for partner addresses, or the partner has one already. */
export async function domainOffered(tx: Pick<Tx, 'select'>, partnerId: string): Promise<boolean> {
  return !!(await domainProvider()) || !!(await currentRow(tx, partnerId))
}

/** The records the partner adds: our TXT, the CNAME, and Cloudflare's ownership TXT when it asks for one. */
export function recordsOf(row: DomainRow, cnameTarget: string): DomainRecord[] {
  const cf = (row.provider_status ?? {}) as ProviderStatus
  const routed = row.status === 'active' || cf.status === 'active'
  const ownership = ((row.provider_records ?? {}) as ProviderRecords).ownership
  return [
    {
      type: 'TXT',
      name: challengeName(row.hostname),
      value: challengeValue(row.challenge_token),
      found: !!row.provider_id || row.status === 'active',
    },
    { type: 'CNAME', name: row.hostname, value: cnameTarget, found: routed },
    ...(ownership ? [{ type: 'TXT', name: ownership.name, value: ownership.value, found: routed }] : []),
  ]
}

async function domainData(
  tx: Tx,
  partner: PartnerRow,
  role: string,
  provider: DomainProvider | null,
): Promise<PartnerDomainData> {
  const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, partner.id))
  const gate = await brandGate(tx, partner)
  const brandApproved = !!brand?.approved_name && gate.approved
  const row = await currentRow(tx, partner.id)
  const [removed] = row
    ? []
    : await tx
        .select()
        .from(partner_domains)
        .where(and(eq(partner_domains.partner_id, partner.id), isNotNull(partner_domains.removed_reason)))
        .orderBy(desc(partner_domains.removed_at))
        .limit(1)
  return {
    available: !!provider,
    locked: brandApproved && gate.paid ? null : { brandApproved, paid: gate.paid },
    domain: row
      ? {
          hostname: row.hostname,
          origin: `https://${row.hostname}`,
          status: row.status as PartnerDomainState,
          records: recordsOf(row, provider?.cnameTarget ?? ''),
          failure: row.failure,
          lastCheckedAt: row.last_checked_at,
          activeAt: row.active_at,
          failedAt: row.failed_at,
        }
      : null,
    removed:
      removed?.removed_reason && removed.removed_at
        ? {
            hostname: removed.hostname,
            reason: removed.removed_reason,
            byAdmin: removed.removed_by !== DOMAIN_SYSTEM_ACTOR,
            at: removed.removed_at,
          }
        : null,
    canEdit: role === 'owner' && partner.status !== 'suspended',
  }
}

/** One email to the partner's owner, in the install's brand (sent without waiting). */
async function emailOwner(tx: Pick<Tx, 'select'>, partnerId: string, content: PartnerDomainEmail) {
  const [owner] = await tx
    .select({ email: user.email })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.role, 'owner')))
  // i18n-ignore: the log label of a failed send, not shown to anyone
  const what = `partner domain email to ${partnerId}`
  if (owner)
    sendNotice({ to: owner.email, ...withEmailBrand(null, () => partnerDomainEmail(content, WEB_ORIGIN)) }, what)
}

async function markRemoved(tx: Tx, rowId: string, actorId: string, now: string, reason: string | null) {
  const [row] = await tx
    .update(partner_domains)
    .set({ status: 'removed', removed_at: now, removed_by: actorId, removed_reason: reason })
    .where(and(eq(partner_domains.id, rowId), ne(partner_domains.status, 'removed')))
    .returning()
  return row ?? null
}

// --- Actions ---------------------------------------------------------------------------------------------------------

const providerFailed = (e: unknown): never => {
  if (e instanceof DomainProviderError || (e instanceof Error && e.name === 'TimeoutError')) {
    console.error('partner domain provider:', e.message)
    throw refuse('provider_failed')
  }
  throw e
}

/** Deletes the custom hostname first (gone already is fine); without a provider any more, there is nothing to delete. */
async function removeAtProvider(row: DomainRow) {
  const provider = await domainProvider()
  if (!provider || !row.provider_id) return
  if (provider.name === 'fake' ? !row.provider_id.startsWith('fake_') : row.provider_id.startsWith('fake_')) return
  await provider.remove(row.provider_id).catch(providerFailed)
}

/**
 * What asks DNS or the provider runs before the transaction (handler-context.ts, Preparer): Check now looks and
 * creates, the removals delete at the provider first.
 */
export const partnerDomainPreparers: Record<string, Preparer> = {
  'partnerDomain.check': async ({ actor }, input: { partnerId: string }) => {
    const { row, provider } = await db.transaction(async tx => {
      await partnerOnTeam(tx, actor, input.partnerId, true)
      const provider = await domainProvider()
      if (!provider) throw refuse('domain_unavailable')
      const row = await currentRow(tx, input.partnerId)
      if (!row) throw refuse('no_domain')
      if (!allowCheck(input.partnerId)) throw refuse('too_many_checks')
      return { row, provider }
    })
    const seen = await observeDomain(row, provider, { restart: true }).catch(providerFailed)
    return { rowId: row.id, seen }
  },

  'partnerDomain.remove': async ({ actor }, input: { partnerId: string; hostname: string }) => {
    const row = await db.transaction(async tx => {
      await partnerOnTeam(tx, actor, input.partnerId, true)
      const row = await currentRow(tx, input.partnerId)
      // The address typed to confirm (DangerConfirmDialog): only the one the partner has.
      if (!row || row.hostname !== parsePartnerHostname(input.hostname)) throw refuse('no_domain')
      return row
    })
    await removeAtProvider(row)
    return { rowId: row.id }
  },

  'partnerDomain.adminRemove': async (_ctx, input: { partnerId: string }) => {
    const row = await currentRow(db, input.partnerId)
    if (!row) throw refuse('no_domain')
    await removeAtProvider(row)
    return { rowId: row.id }
  },
}

const uniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505'

export const partnerDomainHandlers: Record<string, Handler> = {
  'partnerDomain.get': async ({ tx, actor }, input: { partnerId: string }) => {
    const { partner, role } = await partnerOnTeam(tx, actor, input.partnerId, false)
    return { rows: {}, data: await domainData(tx, partner, role, await domainProvider()) }
  },

  'partnerDomain.add': async ({ tx, actor, now, onCommit }, input: { partnerId: string; hostname: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const provider = await domainProvider()
    if (!provider) throw refuse('domain_unavailable')
    const host = parsePartnerHostname(input.hostname)
    if (!host) throw refuse('domain_invalid')
    const before = await domainData(tx, team.partner, team.role, provider)
    // An approved brand and a paid first invoice first: a live address in the install's brand makes no sense, and a
    // look-alike name would need both.
    if (before.locked) throw refuse('domain_locked')
    if (before.domain) throw refuse('domain_exists')
    const refusal = hostnameRefusal(host, (await protectedNames(tx)).names, process.env, provider.cnameTarget)
    if (refusal) throw refuse(refusal)
    const [taken] = await tx
      .select({ id: partner_domains.id })
      .from(partner_domains)
      .where(and(eq(partner_domains.hostname, host), ne(partner_domains.status, 'removed')))
    if (taken) throw refuse('domain_taken')
    const id = `pd_${crypto.randomUUID()}`
    try {
      // A savepoint: another partner adding the same name at the same moment is refused, not an error.
      await tx.transaction(sp =>
        sp.insert(partner_domains).values({
          id,
          partner_id: input.partnerId,
          hostname: host,
          status: 'pending',
          // A fresh token for every claim: a TXT left behind by an earlier claim of the name never matches it.
          challenge_token: randomBytes(32).toString('hex'),
          checks_until: new Date(Date.parse(now) + DOMAIN_CHECKS_FOR_MS).toISOString(),
          created_by: actor.actorId,
        }),
      )
    } catch (e) {
      if (uniqueViolation(e)) throw refuse('domain_taken')
      throw e
    }
    await queueDomainCheck(tx, id)
    const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, input.partnerId))
    const alert = partnerDomainAddedAlert({
      partner: team.partner.name,
      hostname: host,
      brandName: brand?.approved_name ?? null,
      reviewUrl: `${WEB_ORIGIN}/#admin/partners`,
    })
    onCommit?.(async () => {
      await reloadHosts()
      alertInstanceAdmins(alert)
    })
    return { rows: {}, data: await domainData(tx, team.partner, team.role, provider) }
  },

  'partnerDomain.check': async ({ tx, actor, now, prepared, onCommit }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const { rowId, seen } = prepared as { rowId: string; seen: Observation }
    const provider = await domainProvider()
    const outcome = await applyDomainCheck(tx, rowId, seen, now, { restart: true })
    onCommit?.(() => afterCheck(outcome, provider))
    return { rows: {}, data: await domainData(tx, team.partner, team.role, provider) }
  },

  'partnerDomain.remove': async ({ tx, actor, now, prepared, onCommit }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    await markRemoved(tx, (prepared as { rowId: string }).rowId, actor.actorId, now, null)
    onCommit?.(() => reloadHosts())
    return { rows: {}, data: await domainData(tx, team.partner, team.role, await domainProvider()) }
  },

  'partnerDomain.adminRemove': async (
    { tx, actor, now, prepared, onCommit },
    input: { partnerId: string; reason: string },
  ) => {
    const row = await markRemoved(tx, (prepared as { rowId: string }).rowId, actor.actorId, now, input.reason)
    onCommit?.(async () => {
      await reloadHosts()
      if (row) await emailOwner(db, row.partner_id, { kind: 'removed', hostname: row.hostname, reason: input.reason })
    })
    return { rows: {}, data: { partnerId: input.partnerId } }
  },
}
