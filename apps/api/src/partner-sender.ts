// A white-label partner's own sender address (docs/white-label.md, slice S6; actions in
// packages/actions/src/partner-sender.ts).
//
// - The partner's owner adds one address on its domain (Partner › Email sender). The domain is created at the install's
//   email provider (Resend, domains/sender.ts), which returns the DNS records (DKIM, return path) the partner adds at
//   its DNS host. Its clients' emails come from the address only while the provider says `verified`
//   (partner-brand.ts verifiedSenderAddress); anything else sends from the install's address with the partner's name,
//   as S4 did. An email is never held back over its sender.
// - Checks: at once on "Check now" (rate limited), and by the job every 5 minutes for the first hour, then every 30
//   minutes up to 72 hours (then `stopped` until "Check now"). A verified domain is checked once a day; two failed
//   checks in a row turn it `failed` (fallback), and its owner is emailed.
// - Refused: a domain of the install's own, one with a protected name in a label (as brand names, IDN labels decoded
//   first), one another partner holds. Adding needs the brand approved and the first invoice paid (brandGate), like the
//   brand in emails.
// - Claims end (security review of #1291, L-1 and L-3): one that never verified is removed 7 days after it was added,
//   one that verified once and then failed 30 days after it failed, and a suspended partner's at once. Each is deleted
//   at the provider first, so it frees the domain for its real owner and the provider's domain slot.
// - Reply-To: the partner's approved support email once its owner proved it with a 6-digit code sent there (security
//   review of #1111 L-3); a new support email needs the code again.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { domainToUnicode } from 'node:url'
import {
  type PartnerSenderCode,
  type PartnerSenderData,
  type PartnerSenderState,
  parseSenderAddress,
  protectedNameIn,
  type SenderRecord,
} from '@linedesk/actions'
import {
  partner_branding,
  partner_members,
  partner_sender_domains,
  partners,
  type SenderDnsRecord,
  type Tx,
  user,
  verification,
} from '@linedesk/db'
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type SenderDomain, SenderDomainError, senderDomainProvider } from './domains/sender.ts'
import { emailSender, installAddress, partnerSenderLine, sendNotice } from './email.ts'
import { withEmailBrand } from './email-brand.ts'
import {
  partnerSenderAddedAlert,
  partnerSenderEmail,
  SUPPORT_CODE_MINUTES,
  senderTestEmail,
  supportEmailCodeEmail,
} from './emails/alerts.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { brandGate, brandingOf, partnerOnTeam, protectedNames, supportEmailVerified } from './partner-brand.ts'
import { createRateLimiter } from './rate-limit.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** A pending domain is checked this long, then `stopped` until "Check now". */
export const SENDER_CHECKS_FOR_MS = 72 * HOUR
/** A claim that never verified is removed this long after it was added (docs/decisions.md): 72 hours of checks, then
 * a few days in which "Check now" still works. It frees the domain for its real owner (security review of #1291, L-1). */
export const SENDER_CLAIM_EXPIRES_MS = 7 * 24 * HOUR
/** A sender that verified once and then failed is removed this long after it failed. */
export const SENDER_FAILED_EXPIRES_MS = 30 * 24 * HOUR
/** Who removed a claim that ended on its own (expired, or its partner suspended): the job, no person. */
export const SENDER_SYSTEM_REMOVER = 'system'
/** "Check now" asks the provider each time: a few in a row are normal, more per partner are refused. */
export const SENDER_CHECKS_PER_10_MIN = 10
export const SENDER_TESTS_PER_HOUR = 5
export const SUPPORT_CODES_PER_HOUR = 5
const SUPPORT_CODE_TRIES = 3
const allowCheck = createRateLimiter({ max: SENDER_CHECKS_PER_10_MIN, windowMs: 10 * MINUTE })
const allowTest = createRateLimiter({ max: SENDER_TESTS_PER_HOUR, windowMs: HOUR })
const allowCode = createRateLimiter({ max: SUPPORT_CODES_PER_HOUR, windowMs: HOUR })

// i18n-ignore: API error bodies for logs and API clients; the partner area shows team.partner.sender.error.<code>
const REFUSALS: Record<PartnerSenderCode, string> = {
  sender_unavailable: "this server's email provider cannot verify partner domains (Resend with a domains key)",
  sender_locked: 'a sender address needs an approved brand and a paid first invoice',
  sender_exists: 'this partner has a sender address already: remove it first',
  no_sender: 'this partner has no sender address',
  address_invalid: 'not an address a sender can use, like notify@mail.yourcompany.com',
  domain_install: "this domain is the server's own",
  domain_protected: 'this domain contains a protected name',
  domain_taken: 'another partner uses this domain',
  provider_failed: 'the email provider did not accept this: try again in a moment',
  too_many_checks: 'too many checks: try again in a few minutes',
  too_many_tests: 'too many test emails: try again in an hour',
  not_verified: 'the sender address is not verified yet',
  support_missing: 'the brand has no approved support email',
  too_many_codes: 'too many codes: try again in an hour',
  code_wrong: 'that code is wrong or expired: send a new one',
}
const refuse = (code: PartnerSenderCode) => new Reject(REFUSALS[code], code)

type SenderRow = typeof partner_sender_domains.$inferSelect
type PartnerRow = typeof partners.$inferSelect

// --- Domains ---------------------------------------------------------------------------------------------------------

/** A host name's labels from `example.com` up: `mail.example.com` → mail.example.com, example.com. */
function parentsOf(host: string): string[] {
  const labels = host.split('.')
  const out: string[] = []
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'))
  return out
}

/** A second-level label that registries use under a country code (`co.uk`, `com.au`): never a domain of its own. */
const isPublicSuffixLike = (domain: string) => {
  const labels = domain.split('.')
  return labels.length === 2 && labels[1]!.length === 2 && labels[0]!.length <= 3
}

/**
 * The install's own domains: those of WEB_ORIGIN, PUBLIC_URL and EMAIL_FROM, and the domains they sit under (but never
 * a bare `co.uk`). A partner sender on one of them, or under one, would send as the install.
 */
export function installDomains(env: Record<string, string | undefined> = process.env): string[] {
  const hosts: string[] = []
  for (const url of [env.WEB_ORIGIN, env.PUBLIC_URL]) {
    try {
      if (url) hosts.push(new URL(url).hostname.toLowerCase())
    } catch {
      // Not a URL: nothing to protect from it.
    }
  }
  const from = installAddress(env.EMAIL_FROM)
  if (from.includes('@')) hosts.push(from.slice(from.lastIndexOf('@') + 1).toLowerCase())
  const domains = new Set<string>()
  for (const host of hosts)
    for (const parent of parentsOf(host)) if (parent.includes('.') && !isPublicSuffixLike(parent)) domains.add(parent)
  return [...domains]
}

/**
 * Why a domain cannot be a partner's sender, or null: the install's own, or a protected name in a label. Punycode
 * labels (`xn--pypal-4ve`) are decoded first, so the look-alike folding of brand names sees `pаypal` (security review of
 * #1291, L-5); one that does not decode is not an address a sender can use.
 */
export function domainRefusal(
  domain: string,
  protectedList: readonly string[],
  env: Record<string, string | undefined> = process.env,
): 'domain_install' | 'domain_protected' | 'address_invalid' | null {
  if (installDomains(env).some(own => domain === own || domain.endsWith(`.${own}`))) return 'domain_install'
  const unicode = domain.split('.').some(label => label.startsWith('xn--')) ? domainToUnicode(domain) : domain
  if (!unicode || unicode.split('.').some(label => label.startsWith('xn--'))) return 'address_invalid'
  // Every label but the top-level one, as words ("paypal-billing" → "paypal billing"), as a brand name is checked.
  const labels = unicode.split('.').slice(0, -1)
  if (labels.some(label => protectedNameIn(label.replace(/-/g, ' '), protectedList))) return 'domain_protected'
  if (protectedNameIn(labels.join(' '), protectedList)) return 'domain_protected'
  return null
}

const addressOf = (row: Pick<SenderRow, 'local_part' | 'domain'>) => `${row.local_part}@${row.domain}`

/** Verified at the provider the install sends with now (as partner-brand.ts verifiedSenderAddress decides it). */
const sendsNow = (row: SenderRow | null): row is SenderRow =>
  row?.status === 'verified' && senderDomainProvider()?.name === row.provider

const recordsOf = (records: SenderDnsRecord[]): SenderRecord[] =>
  records.map(r => ({
    type: r.type,
    name: r.name,
    value: r.value,
    priority: r.priority ?? null,
    found: r.status === 'verified',
  }))

const currentRow = async (tx: Pick<Tx, 'select'>, partnerId: string) =>
  (
    await tx
      .select()
      .from(partner_sender_domains)
      .where(and(eq(partner_sender_domains.partner_id, partnerId), ne(partner_sender_domains.status, 'removed')))
  )[0] ?? null

async function senderData(tx: Tx, partner: PartnerRow, role: string): Promise<PartnerSenderData> {
  const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, partner.id))
  const gate = await brandGate(tx, partner)
  const brandApproved = !!brand?.approved_name && gate.approved
  const row = await currentRow(tx, partner.id)
  const [removed] = row
    ? []
    : await tx
        .select()
        .from(partner_sender_domains)
        .where(and(eq(partner_sender_domains.partner_id, partner.id), isNotNull(partner_sender_domains.removed_reason)))
        .orderBy(desc(partner_sender_domains.removed_at))
        .limit(1)
  const verified = sendsNow(row)
  return {
    available: !!senderDomainProvider(),
    locked: brandApproved && gate.paid ? null : { brandApproved, paid: gate.paid },
    sender: row
      ? {
          address: addressOf(row),
          domain: row.domain,
          status: row.status as PartnerSenderState,
          records: recordsOf(row.records),
          lastCheckedAt: row.last_checked_at,
          verifiedAt: row.verified_at,
          failedAt: row.failed_at,
        }
      : null,
    removedByAdmin:
      removed?.removed_reason && removed.removed_at
        ? { address: addressOf(removed), reason: removed.removed_reason, at: removed.removed_at }
        : null,
    fromLine: partnerSenderLine(
      brand?.approved_name ?? partner.name,
      verified ? addressOf(row) : installAddress(process.env.EMAIL_FROM),
    ),
    support: {
      address: brand?.approved_support_email ?? null,
      verified: !!brand && supportEmailVerified(brand),
      draft: brand && brand.support_email !== brand.approved_support_email ? brand.support_email : null,
    },
    canEdit: role === 'owner' && partner.status !== 'suspended',
  }
}

/** One email to the partner's owner, in the install's brand (sent without waiting). */
async function emailOwner(
  tx: Pick<Tx, 'select'>,
  partnerId: string,
  content: Parameters<typeof partnerSenderEmail>[0],
) {
  const [owner] = await tx
    .select({ email: user.email })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.role, 'owner')))
  // i18n-ignore: the log label of a failed send, not shown to anyone
  const what = `partner sender email to ${partnerId}`
  if (owner)
    sendNotice({ to: owner.email, ...withEmailBrand(null, () => partnerSenderEmail(content, WEB_ORIGIN)) }, what)
}

/**
 * Stores what the provider said about a domain and moves its state: verified when the provider says so; a verified one
 * turns `failed` after two failed checks in a row (owner emailed); a pending one `stopped` after its 72 hours, `failed`
 * when the provider says failed. `restart`: "Check now", which gives a stopped or failed one 72 more hours.
 */
export async function applySenderCheck(
  tx: Tx,
  row: SenderRow,
  found: SenderDomain | null,
  now: string,
  { restart = false }: { restart?: boolean } = {},
) {
  const nowMs = Date.parse(now)
  const until = restart ? new Date(nowMs + SENDER_CHECKS_FOR_MS).toISOString() : row.checks_until
  const state = found?.state ?? 'failed'
  const base = {
    last_checked_at: now,
    provider_status: found?.status ?? 'not_found',
    ...(found?.records.length ? { records: found.records } : {}),
    checks_until: until,
  }
  let status: SenderRow['status'] = row.status
  let email: Parameters<typeof partnerSenderEmail>[0] | null = null
  const set: Partial<typeof partner_sender_domains.$inferInsert> = { ...base }
  if (state === 'verified') {
    status = 'verified'
    set.failed_checks = 0
    set.failed_at = null
    if (row.status !== 'verified') {
      set.verified_at = now
      email = { kind: 'verified', address: addressOf(row) }
    }
  } else if (row.status === 'verified') {
    // Records gone, or the provider failed the domain: twice in a row before the fallback (one DNS hiccup is not).
    const failed = row.failed_checks + 1
    set.failed_checks = failed
    if (failed >= 2) {
      status = 'failed'
      set.failed_at = now
      set.checks_until = new Date(nowMs + SENDER_CHECKS_FOR_MS).toISOString()
      email = { kind: 'failed', address: addressOf(row) }
    }
  } else if (state === 'failed') {
    status = 'failed'
    set.failed_at = row.failed_at ?? now
  } else {
    // Still pending at the provider: checked until its 72 hours are over, then `stopped` until "Check now".
    status = !restart && until && Date.parse(until) < nowMs ? 'stopped' : 'pending'
  }
  set.status = status
  const [updated] = await tx
    .update(partner_sender_domains)
    .set(set)
    .where(and(eq(partner_sender_domains.id, row.id), ne(partner_sender_domains.status, 'removed')))
    .returning()
  if (email) await emailOwner(tx, row.partner_id, email)
  return updated ?? null
}

/** Whether the job checks this domain now: 5 minutes apart in its first hour, then 30, a verified one daily. */
export function senderCheckDue(row: SenderRow, now: string): boolean {
  const nowMs = Date.parse(now)
  const last = row.last_checked_at ? Date.parse(row.last_checked_at) : 0
  if (row.status === 'verified') return nowMs - last >= 24 * HOUR
  if (row.status !== 'pending' && row.status !== 'failed') return false
  const until = row.checks_until ? Date.parse(row.checks_until) : 0
  if (nowMs > until) return row.status === 'pending' // once more, to turn it stopped
  const startedAt = until - SENDER_CHECKS_FOR_MS
  const every = nowMs - startedAt < HOUR ? 5 * MINUTE : 30 * MINUTE
  return nowMs - last >= every
}

/**
 * When a claim that is not verified now ends (SENDER_CLAIM_EXPIRES_MS, SENDER_FAILED_EXPIRES_MS): never verified, a
 * week after it was added; verified once, 30 days after it failed. Null for a verified one.
 */
export function senderClaimEndsAt(row: SenderRow): number | null {
  if (row.status === 'verified' || row.status === 'removed') return null
  if (!row.verified_at) return Date.parse(row.created_at) + SENDER_CLAIM_EXPIRES_MS
  const since = row.failed_at ?? row.last_checked_at ?? row.created_at
  return Date.parse(since) + SENDER_FAILED_EXPIRES_MS
}

/**
 * Ends a claim on its own (expired, or its partner suspended): the domain is deleted at the provider first (gone
 * already is fine), then the row is `removed`, which frees the domain for another partner. The provider is asked
 * outside any transaction. When the install no longer has the provider the row was made at, nothing there can be
 * reached: the row is removed anyway (logged). False when the provider refused: the job tries again next time.
 */
async function endClaim(dbOrTx: typeof db, row: SenderRow, now: string, why: string): Promise<boolean> {
  const provider = senderDomainProvider()
  if (provider && row.provider_domain_id && row.provider === provider.name) {
    try {
      await provider.remove(row.provider_domain_id)
    } catch (e) {
      console.error(
        `could not delete the sender domain of ${row.partner_id} (${why})`,
        e instanceof Error ? e.message : e,
      )
      return false
    }
  } else if (row.provider_domain_id) {
    console.warn(
      `sender domain of ${row.partner_id} removed (${why}) without deleting it at ${row.provider}: not in use`,
    )
  }
  await dbOrTx
    .update(partner_sender_domains)
    .set({ status: 'removed', removed_at: now, removed_by: SENDER_SYSTEM_REMOVER, removed_reason: null })
    .where(and(eq(partner_sender_domains.id, row.id), ne(partner_sender_domains.status, 'removed')))
  return true
}

/**
 * A suspended partner's sender (security review of #1291, L-3): deleted at the provider and removed, right after the
 * suspension commits (partners.ts) and by the job for any left over. After an unsuspension the partner adds it again.
 */
export async function endSuspendedSenders(dbOrTx: typeof db = db, now = new Date().toISOString(), partnerId?: string) {
  const rows = await dbOrTx
    .select({ row: partner_sender_domains })
    .from(partner_sender_domains)
    .innerJoin(partners, eq(partners.id, partner_sender_domains.partner_id))
    .where(
      and(
        ne(partner_sender_domains.status, 'removed'),
        eq(partners.status, 'suspended'),
        ...(partnerId ? [eq(partners.id, partnerId)] : []),
      ),
    )
  for (const { row } of rows) await endClaim(dbOrTx, row, now, 'partner suspended')
}

/**
 * The job (every 5 minutes, jobs.ts): a suspended partner's sender and an expired claim are removed (endClaim); each
 * other due domain is verified again at the provider and its state moved on. A pending one past its 72 hours turns
 * `stopped` without asking. Never throws.
 */
export async function checkSenderDomains(dbOrTx: typeof db = db, now = new Date().toISOString()) {
  const provider = senderDomainProvider()
  const rows = await dbOrTx
    .select({ row: partner_sender_domains, partnerStatus: partners.status })
    .from(partner_sender_domains)
    .innerJoin(partners, eq(partners.id, partner_sender_domains.partner_id))
    .where(ne(partner_sender_domains.status, 'removed'))
  const nowMs = Date.parse(now)
  for (const { row, partnerStatus } of rows) {
    try {
      if (partnerStatus === 'suspended') {
        await endClaim(dbOrTx, row, now, 'partner suspended')
        continue
      }
      const ends = senderClaimEndsAt(row)
      if (ends !== null && ends <= nowMs) {
        await endClaim(dbOrTx, row, now, 'claim expired')
        continue
      }
      if (!senderCheckDue(row, now)) continue
      const pastDeadline =
        row.status === 'pending' && row.checks_until && Date.parse(row.checks_until) < Date.parse(now)
      if (pastDeadline) {
        await dbOrTx
          .update(partner_sender_domains)
          .set({ status: 'stopped' })
          .where(and(eq(partner_sender_domains.id, row.id), eq(partner_sender_domains.status, 'pending')))
        continue
      }
      if (!provider || !row.provider_domain_id) continue
      if (row.status !== 'verified') await provider.verify(row.provider_domain_id)
      const found = await provider.get(row.provider_domain_id)
      await dbOrTx.transaction(tx => applySenderCheck(tx, row, found, now))
    } catch (e) {
      console.error(`sender domain check of ${row.partner_id} failed`, e instanceof Error ? e.message : e)
    }
  }
}

// --- Support email code ----------------------------------------------------------------------------------------------

const supportIdentifier = (partnerId: string) => `partner-support:${partnerId}`
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

/** The stored code: `<sha256>:<tries>:<address>`, so a code sent to an earlier support email never proves a new one. */
const parseStored = (value: string) => {
  const [hash = '', tries = '0', ...address] = value.split(':')
  return { hash, tries: Number.parseInt(tries, 10) || 0, address: address.join(':') }
}

// --- Actions ---------------------------------------------------------------------------------------------------------

/** The owner's gate on a sender action, with the current row; the provider (refused when there is none). */
async function ownerAndProvider(tx: Tx, actor: Actor, partnerId: string) {
  const team = await partnerOnTeam(tx, actor, partnerId, true)
  const provider = senderDomainProvider()
  if (!provider) throw refuse('sender_unavailable')
  return { team, provider }
}

const providerFailed = (e: unknown): never => {
  if (e instanceof SenderDomainError || (e instanceof Error && e.name === 'TimeoutError')) {
    console.error('sender domain provider:', e.message)
    throw refuse('provider_failed')
  }
  throw e
}

/**
 * What asks the email provider runs before the transaction (handler-context.ts, Preparer): add creates the domain
 * there (deleted again when the command does not commit), check and the removals ask it, sendTest sends, and the
 * support code is checked and its try counted (a wrong one stays counted).
 */
export const partnerSenderPreparers: Record<string, Preparer> = {
  'partnerSender.add': async ({ actor, onRollback }, input: { partnerId: string; address: string }) => {
    const { provider, parsed } = await db.transaction(async tx => {
      const { team, provider } = await ownerAndProvider(tx, actor, input.partnerId)
      const parsed = parseSenderAddress(input.address)
      if (!parsed) throw refuse('address_invalid')
      const data = await senderData(tx, team.partner, team.role)
      if (data.locked) throw refuse('sender_locked')
      if (data.sender) throw refuse('sender_exists')
      const refusal = domainRefusal(parsed.domain, (await protectedNames(tx)).names)
      if (refusal) throw refuse(refusal)
      const [taken] = await tx
        .select({ id: partner_sender_domains.id })
        .from(partner_sender_domains)
        .where(and(eq(partner_sender_domains.domain, parsed.domain), ne(partner_sender_domains.status, 'removed')))
      if (taken) throw refuse('domain_taken')
      return { provider, parsed }
    })
    const created = await provider.create(parsed.domain).catch(providerFailed)
    onRollback(async () => {
      await provider.remove(created.id).catch(e => console.error('could not delete a sender domain', e))
      return `deleted sender domain ${parsed.domain} at ${provider.name}`
    })
    return { ...parsed, provider: provider.name, created }
  },

  'partnerSender.check': async ({ actor }, input: { partnerId: string }) => {
    const { provider, row } = await db.transaction(async tx => {
      const { provider } = await ownerAndProvider(tx, actor, input.partnerId)
      const row = await currentRow(tx, input.partnerId)
      if (!row?.provider_domain_id) throw refuse('no_sender')
      if (!allowCheck(input.partnerId)) throw refuse('too_many_checks')
      return { provider, row: { id: row.id, domainId: row.provider_domain_id } }
    })
    // Asked after the partner row's lock is let go (security review of #1291, I-1): up to two provider timeouts.
    await provider.verify(row.domainId).catch(providerFailed)
    return { rowId: row.id, found: await provider.get(row.domainId).catch(providerFailed) }
  },

  'partnerSender.sendTest': async ({ actor }, input: { partnerId: string }) => {
    const { to, brand, address } = await db.transaction(async tx => {
      const team = await partnerOnTeam(tx, actor, input.partnerId, true)
      const row = await currentRow(tx, input.partnerId)
      if (!sendsNow(row)) throw refuse('not_verified')
      if (!allowTest(input.partnerId)) throw refuse('too_many_tests')
      const [me] = await tx.select({ email: user.email }).from(user).where(eq(user.id, actor.actorId))
      const [brandRow] = await tx
        .select()
        .from(partner_branding)
        .where(eq(partner_branding.partner_id, team.partner.id))
      const brand =
        brandRow?.approved_name && brandRow.approved_revision !== null
          ? brandingOf(team.partner.id, {
              name: brandRow.approved_name,
              color: brandRow.color,
              logoUrl: null,
              supportEmail: brandRow.approved_support_email,
              termsUrl: brandRow.approved_terms_url,
              privacyUrl: brandRow.approved_privacy_url,
            })
          : null
      return { to: me!.email, brand, address: addressOf(row) }
    })
    if (!brand) throw refuse('sender_locked')
    // To the owner's own account email only, from the partner's address and in its brand; no Reply-To.
    await withEmailBrand({ branding: brand, replyTo: null, fromAddress: address, origin: WEB_ORIGIN }, () =>
      emailSender.send({ to, ...senderTestEmail(address, WEB_ORIGIN) }),
    ).catch(e => {
      console.error('sender test email failed', e instanceof Error ? e.message : e)
      throw refuse('provider_failed')
    })
    return { sentTo: to }
  },

  'partnerSender.remove': async ({ actor }, input: { partnerId: string }) => {
    const row = await db.transaction(async tx => {
      await partnerOnTeam(tx, actor, input.partnerId, true)
      const row = await currentRow(tx, input.partnerId)
      if (!row) throw refuse('no_sender')
      return row
    })
    await removeAtProvider(row)
    return { rowId: row.id }
  },

  'partnerSender.adminRemove': async (_ctx, input: { partnerId: string }) => {
    const row = await currentRow(db, input.partnerId)
    if (!row) throw refuse('no_sender')
    await removeAtProvider(row)
    return { rowId: row.id }
  },

  'partnerBrand.confirmSupportEmail': async ({ actor }, input: { partnerId: string; code: string }) =>
    db.transaction(async tx => {
      await partnerOnTeam(tx, actor, input.partnerId, true)
      const [stored] = await tx
        .select()
        .from(verification)
        .where(eq(verification.identifier, supportIdentifier(input.partnerId)))
        .for('update')
      if (!stored) return { right: false, address: null }
      const { hash, tries, address } = parseStored(stored.value)
      if (new Date(stored.expiresAt) < new Date() || tries >= SUPPORT_CODE_TRIES) {
        await tx.delete(verification).where(eq(verification.id, stored.id))
        return { right: false, address: null }
      }
      const given = Buffer.from(hashCode(input.code))
      const right = given.length === hash.length && timingSafeEqual(given, Buffer.from(hash))
      if (right) await tx.delete(verification).where(eq(verification.id, stored.id))
      else
        await tx
          .update(verification)
          .set({ value: `${hash}:${tries + 1}:${address}` })
          .where(eq(verification.id, stored.id))
      return { right, address: right ? address : null }
    }),
}

/** Deletes the domain at the provider first (gone already is fine); the fallback to the install's address follows. */
async function removeAtProvider(row: SenderRow) {
  const provider = senderDomainProvider()
  if (!provider || !row.provider_domain_id || row.provider !== provider.name) return
  await provider.remove(row.provider_domain_id).catch(providerFailed)
}

async function markRemoved(tx: Tx, rowId: string, actorId: string, now: string, reason: string | null) {
  const [row] = await tx
    .update(partner_sender_domains)
    .set({ status: 'removed', removed_at: now, removed_by: actorId, removed_reason: reason })
    .where(and(eq(partner_sender_domains.id, rowId), ne(partner_sender_domains.status, 'removed')))
    .returning()
  return row ?? null
}

export const partnerSenderHandlers: Record<string, Handler> = {
  'partnerSender.get': async ({ tx, actor }, input: { partnerId: string }) => {
    const { partner, role } = await partnerOnTeam(tx, actor, input.partnerId, false)
    return { rows: {}, data: await senderData(tx, partner, role) }
  },

  'partnerSender.add': async ({ tx, actor, now, prepared, onCommit }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const { localPart, domain, provider, created } = prepared as {
      localPart: string
      domain: string
      provider: string
      created: SenderDomain
    }
    if (await currentRow(tx, input.partnerId)) throw refuse('sender_exists')
    const [taken] = await tx
      .select({ id: partner_sender_domains.id })
      .from(partner_sender_domains)
      .where(and(eq(partner_sender_domains.domain, domain), ne(partner_sender_domains.status, 'removed')))
    if (taken) throw refuse('domain_taken')
    await tx.insert(partner_sender_domains).values({
      id: `psd_${crypto.randomUUID()}`,
      partner_id: input.partnerId,
      domain,
      local_part: localPart,
      status: 'pending',
      provider,
      provider_domain_id: created.id,
      records: created.records,
      provider_status: created.status,
      checks_until: new Date(Date.parse(now) + SENDER_CHECKS_FOR_MS).toISOString(),
      created_by: actor.actorId,
    })
    const data = await senderData(tx, team.partner, team.role)
    const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, input.partnerId))
    const alert = partnerSenderAddedAlert({
      partner: team.partner.name,
      address: `${localPart}@${domain}`,
      brandName: brand?.approved_name ?? null,
      reviewUrl: `${WEB_ORIGIN}/#admin/partners`,
    })
    onCommit?.(async () => alertInstanceAdmins(alert))
    return { rows: {}, data }
  },

  'partnerSender.check': async ({ tx, actor, now, prepared }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const { rowId, found } = prepared as { rowId: string; found: SenderDomain | null }
    const row = await currentRow(tx, input.partnerId)
    if (row?.id === rowId) await applySenderCheck(tx, row, found, now, { restart: true })
    return { rows: {}, data: await senderData(tx, team.partner, team.role) }
  },

  'partnerSender.sendTest': async ({ prepared }) => ({ rows: {}, data: prepared as { sentTo: string } }),

  'partnerSender.remove': async ({ tx, actor, now, prepared }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    await markRemoved(tx, (prepared as { rowId: string }).rowId, actor.actorId, now, null)
    return { rows: {}, data: await senderData(tx, team.partner, team.role) }
  },

  'partnerSender.adminRemove': async (
    { tx, actor, now, prepared, onCommit },
    input: { partnerId: string; reason: string },
  ) => {
    const row = await markRemoved(tx, (prepared as { rowId: string }).rowId, actor.actorId, now, input.reason)
    if (row) {
      const content = { kind: 'removed' as const, address: addressOf(row), reason: input.reason }
      onCommit?.(() => emailOwner(db, row.partner_id, content))
    }
    return { rows: {}, data: { partnerId: input.partnerId } }
  },

  'partnerBrand.verifySupportEmail': async ({ tx, actor, onCommit }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, input.partnerId))
    const address = brand?.approved_support_email
    if (!address) throw refuse('support_missing')
    if (!allowCode(input.partnerId)) throw refuse('too_many_codes')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await tx.delete(verification).where(eq(verification.identifier, supportIdentifier(input.partnerId)))
    await tx.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: supportIdentifier(input.partnerId),
      value: `${hashCode(code)}:0:${address}`,
      expiresAt: new Date(Date.now() + SUPPORT_CODE_MINUTES * MINUTE),
    })
    const email = withEmailBrand(null, () => supportEmailCodeEmail(code, team.partner.name, WEB_ORIGIN))
    // i18n-ignore: the log label of a failed send, not shown to anyone
    const what = `support email code of ${input.partnerId}`
    onCommit?.(async () => sendNotice({ to: address, ...email }, what))
    return { rows: {}, data: { sentTo: address } }
  },

  'partnerBrand.confirmSupportEmail': async ({ tx, actor, prepared }, input: { partnerId: string }) => {
    const team = await partnerOnTeam(tx, actor, input.partnerId, true)
    const { right, address } = prepared as { right: boolean; address: string | null }
    const [brand] = await tx.select().from(partner_branding).where(eq(partner_branding.partner_id, input.partnerId))
    // The code proves the address it was sent to, and only while that is still the approved support email.
    if (!right || !address || brand?.approved_support_email !== address) throw refuse('code_wrong')
    await tx
      .update(partner_branding)
      .set({ support_email_verified: address })
      .where(eq(partner_branding.partner_id, input.partnerId))
    return { rows: {}, data: await senderData(tx, team.partner, team.role) }
  },
}
