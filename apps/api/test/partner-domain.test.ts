// A white-label partner's own address (docs/white-label.md, slice S5, PR 5.4): which names are refused, that our TXT
// must resolve before anything is created at the provider (domain takeover), the states an address moves through with
// the fake provider (PARTNER_DOMAINS=fake), who may read and change it, the server admin's removal, suspension, and
// that every change reaches the host map. Makes an instance admin and changes process.env: an instance-wide file
// (vitest.config.ts).
import { challengeName, challengeValue } from '@linedesk/actions'
import { commands, partner_domains, partner_branding, partners, user } from '@linedesk/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { partnerSetupActor } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { RESOLVERS, txtProven } from '../src/domains/doh.ts'
import { fakeDomains } from '../src/domains/fake.ts'
import type { DomainProvider } from '../src/domains/provider.ts'
import { type Email, emailSender } from '../src/email.ts'
import {
  applyDomainCheck,
  checkOneDomain,
  checkPartnerDomains,
  DOMAIN_CHECKS_FOR_MS,
  DOMAIN_REMOVE_AFTER_MS,
  DOMAIN_SYSTEM_ACTOR,
  domainCheckDue,
  domainProvider,
  hostnameRefusal,
  ownDomains,
  recheckPartnerDomains,
  setDomainCheckDeps,
} from '../src/partner-domain.ts'
import { resolveHost } from '../src/request-host.ts'
import { runAction } from '../src/run-action.ts'
import { act, addMember, asServerAdmin, signUp, type User } from './helpers.ts'

const sent: Email[] = []
Object.assign(emailSender, { send: async (email: Email) => void sent.push(email) })

const newEmail = (who = 'partner') => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const tokenFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
    .findLast(Boolean)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const later = (ms: number) => new Date(Date.now() + ms).toISOString()

let admin: User
async function makePartner(name: string) {
  const ownerEmail = newEmail('owner')
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  expect(created).toMatchObject({ status: 200 })
  const id: string = created.body.data.partner.id
  expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: id }))).status).toBe(200)
  const owner = await signUp(ownerEmail)
  await verify(owner)
  expect(await act(owner, 'partnerInvitation.accept', { token: tokenFor(ownerEmail) })).toMatchObject({ status: 200 })
  return { id, owner, ownerEmail }
}
type Partner = Awaited<ReturnType<typeof makePartner>>

/** The brand as an instance admin approved it (partner-brand.test.ts covers the review itself). */
async function approvedBrand(p: Partner, name: string) {
  await db
    .insert(partner_branding)
    .values({
      partner_id: p.id,
      name,
      support_email: `help@${p.id}.example`,
      updated_by: p.owner.userId,
      approved_revision: 1,
      approved_name: name,
      approved_support_email: `help@${p.id}.example`,
      approved_at: new Date().toISOString(),
    })
    .onConflictDoNothing()
}

const rowOf = (p: Partner) =>
  db
    .select()
    .from(partner_domains)
    .where(and(eq(partner_domains.partner_id, p.id), ne(partner_domains.status, 'removed')))
    .then(rows => rows[0])

const add = (p: Partner, hostname: string, who: User = p.owner) =>
  act(who, 'partnerDomain.add', { partnerId: p.id, hostname })
const check = (p: Partner, who: User = p.owner) => act(who, 'partnerDomain.check', { partnerId: p.id })
const remove = (p: Partner, hostname: string) => act(p.owner, 'partnerDomain.remove', { partnerId: p.id, hostname })
const adminRemove = (p: Partner, reason: string) =>
  asServerAdmin(admin, () => act(admin, 'partnerDomain.adminRemove', { partnerId: p.id, reason }))
const statusOf = async (p: Partner) => (await rowOf(p))?.status

/** A fake provider that counts what it was asked to create and delete. */
function countingFake() {
  const fake = fakeDomains('partners.linedesk.test')
  const created: string[] = []
  const removed: string[] = []
  const provider: DomainProvider = {
    ...fake,
    create: async hostname => {
      created.push(hostname)
      return fake.create(hostname)
    },
    remove: async id => void removed.push(id),
  }
  return { provider, created, removed }
}

/**
 * A fake DNS over HTTPS behind the real TXT check (doh.ts): per name, the TXT values both resolvers answer. Only the
 * two fixed resolvers may be asked.
 */
function fakeDns(records: Record<string, string[]>) {
  const doFetch = (async (input: string) => {
    const url = new URL(input)
    expect(RESOLVERS).toContain(`${url.origin}${url.pathname}`)
    const answer = records[url.searchParams.get('name')!]
    if (!answer) return Response.json({ Status: 3 })
    return Response.json({ Status: 0, Answer: answer.map(v => ({ type: 16, TTL: 60, data: `"${v}"` })) })
  }) as typeof fetch
  setDomainCheckDeps({
    txt: (hostname, expected) => txtProven(challengeName(hostname), expected, doFetch),
    probe: async () => true,
  })
}

let a: Partner
let b: Partner
let adminA: User
let clientMember: User
const watcherEmail = newEmail('watcher')
const saved = { PARTNER_DOMAINS: process.env.PARTNER_DOMAINS }

beforeAll(async () => {
  process.env.PARTNER_DOMAINS = 'fake'
  admin = await signUp()
  await verify(admin)
  // An instance admin for good: every new address is emailed to them (no approval needed, D3).
  const watcher = await signUp(watcherEmail)
  await verify(watcher)
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, watcher.userId))
  a = await makePartner('Cascade IT Partners')
  b = await makePartner('Rival Agency')
  const res = await act(a.owner, 'workspace.createForClient', { partnerId: a.id, name: 'Brightwater Plumbing' })
  expect(res).toMatchObject({ status: 200 })
  clientMember = await addMember(res.body.data.workspace.id, 'admin')
  const email = newEmail('padmin')
  expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).toMatchObject({ status: 200 })
  adminA = await signUp(email)
  await verify(adminA)
  expect(await act(adminA, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
})

afterEach(() => setDomainCheckDeps(null))

afterAll(() => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
})

describe('names a partner may not use', () => {
  const env = {
    WEB_ORIGIN: 'https://app.linedesk.ai',
    PUBLIC_URL: 'https://api.linedesk.ai',
    EMAIL_FROM: 'Linedesk <notify@mail.linedesk-mail.com>',
  }

  test("the install's own domains, those under them, and the CNAME target's", () => {
    expect(ownDomains(env, 'partners.linedesk-edge.net').sort()).toEqual([
      'linedesk-edge.net',
      'linedesk-mail.com',
      'linedesk.ai',
    ])
    for (const host of ['desk.linedesk.ai', 'a.b.linedesk-mail.com', 'x.partners.linedesk-edge.net'])
      expect(hostnameRefusal(host, [], env, 'partners.linedesk-edge.net'), host).toBe('domain_ours')
    expect(hostnameRefusal('app.notlinedesk.ai', [], env)).toBeNull()
  })

  test('an apex or a public suffix is no subdomain: app.co.uk, desk.github.io are apexes', () => {
    expect(hostnameRefusal('cascade.co.uk', [], env)).toBe('domain_apex')
    expect(hostnameRefusal('app.co.uk', [], env)).toBe('domain_apex')
    // A private suffix (github.io): every user's name under it is its own registrable domain.
    expect(hostnameRefusal('cascade.github.io', [], env)).toBe('domain_apex')
    expect(hostnameRefusal('desk.cascade.co.uk', [], env)).toBeNull()
  })

  test('a protected name in any label, split by hyphens, and in its Unicode form', () => {
    expect(hostnameRefusal('login.paypal-billing.example', ['PayPal'], env)).toBe('name_protected')
    expect(hostnameRefusal('pay.pal.example', ['PayPal'], env)).toBe('name_protected')
    expect(hostnameRefusal('app.xn--lindesk-c1a.example', ['Lindésk'], env)).toBe('name_protected')
    expect(hostnameRefusal('app.cascade.example', ['PayPal'], env)).toBeNull()
  })
})

describe('who may read and change the address', () => {
  test('hidden without a provider for partner addresses', async () => {
    delete process.env.PARTNER_DOMAINS
    try {
      expect(await domainProvider()).toBeNull()
      const res = await act(a.owner, 'partnerDomain.get', { partnerId: a.id })
      expect(res).toMatchObject({ status: 200, body: { data: { available: false, domain: null } } })
      expect(await add(a, 'app.cascade.example')).toMatchObject({
        status: 409,
        body: { code: 'domain_unavailable' },
      })
    } finally {
      process.env.PARTNER_DOMAINS = 'fake'
    }
  })

  test('locked until the brand is approved', async () => {
    const res = await act(a.owner, 'partnerDomain.get', { partnerId: a.id })
    expect(res.body.data).toMatchObject({ available: true, locked: { brandApproved: false }, canEdit: true })
    expect(await add(a, 'app.cascade.example')).toMatchObject({ status: 409, body: { code: 'domain_locked' } })
    await approvedBrand(a, 'Cascade Desk')
    await approvedBrand(b, 'Rival Desk')
    expect((await act(a.owner, 'partnerDomain.get', { partnerId: a.id })).body.data.locked).toBeNull()
  })

  test('another partner, a team admin, a client and the agent setup link are refused', async () => {
    const input = { partnerId: a.id, hostname: 'app.cascade.example', reason: 'x' }
    for (const name of ['partnerDomain.get', 'partnerDomain.add', 'partnerDomain.check', 'partnerDomain.remove']) {
      expect((await act(b.owner, name, input)).status, `other partner ${name}`).toBe(403)
      expect((await act(clientMember, name, input)).status, `client ${name}`).toBe(403)
    }
    // A team admin reads it, never changes it.
    expect((await act(adminA, 'partnerDomain.get', { partnerId: a.id })).body.data.canEdit).toBe(false)
    for (const name of ['partnerDomain.add', 'partnerDomain.check', 'partnerDomain.remove'])
      expect((await act(adminA, name, input)).status, `team admin ${name}`).toBe(403)
    const actor = (await partnerSetupActor(a.owner.userId, 'test', a.id))!
    for (const name of ['partnerDomain.get', 'partnerDomain.add', 'partnerDomain.check', 'partnerDomain.remove'])
      expect((await runAction(name, input, actor)).status, `setup link ${name}`).toBe(403)
    // Only an instance admin removes another partner's address.
    expect((await act(a.owner, 'partnerDomain.adminRemove', { partnerId: a.id, reason: 'x' })).status).toBe(403)
  })

  test('names that are refused when added', async () => {
    for (const [hostname, code] of [
      ['not a name', 'domain_invalid'],
      ['127.0.0.1', 'domain_invalid'],
      ['app..cascade.example', 'domain_invalid'],
      [`${'abcdefghi.'.repeat(25)}example`, 'domain_invalid'],
      ['cascade.example', 'domain_invalid'],
      ['cascade.co.uk', 'domain_apex'],
      ['x.partners.linedesk.test', 'domain_ours'],
      ['login.paypal-help.example', 'name_protected'],
    ] as const)
      expect(await add(a, hostname), hostname).toMatchObject({ status: 409, body: { code } })
    expect(await rowOf(a)).toBeUndefined()
  })
})

describe('an address from adding to live', () => {
  test('added pending with a fresh token; the instance admins are told; one per partner and per name', async () => {
    sent.length = 0
    const res = await add(a, 'App.Cascade-IT.example')
    expect(res).toMatchObject({
      status: 200,
      body: { data: { domain: { hostname: 'app.cascade-it.example', status: 'pending' } } },
    })
    const row = (await rowOf(a))!
    expect(row.challenge_token).toMatch(/^[0-9a-f]{64}$/)
    expect(row.provider_id).toBeNull()
    expect(res.body.data.domain.records).toEqual([
      {
        type: 'TXT',
        name: '_linedesk.app.cascade-it.example',
        value: `linedesk-verify=${row.challenge_token}`,
        found: false,
      },
      { type: 'CNAME', name: 'app.cascade-it.example', value: 'partners.linedesk.test', found: false },
    ])
    await settle()
    expect(sent.some(e => e.to === watcherEmail && e.text.includes('app.cascade-it.example'))).toBe(true)
    expect(await add(a, 'desk.cascade-it.example')).toMatchObject({ status: 409, body: { code: 'domain_exists' } })
    expect(await add(b, 'app.cascade-it.example')).toMatchObject({ status: 409, body: { code: 'domain_taken' } })
    // The add was logged (audit kind Partners), the token never.
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerDomain.add'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(JSON.stringify(logged!.result)).not.toContain(row.challenge_token)
    expect(resolveHost('app.cascade-it.example').kind).not.toBe('partner')
  })

  test('the TXT found: created at the provider, verifying; then active, in the host map, its owner told', async () => {
    let res = await check(a)
    expect(res.body.data.domain).toMatchObject({ status: 'verifying' })
    expect((await rowOf(a))!.provider_id).toBe('fake_app.cascade-it.example')
    expect(res.body.data.domain.records[0].found).toBe(true)
    expect(resolveHost('app.cascade-it.example').kind).not.toBe('partner')
    sent.length = 0
    res = await check(a)
    expect(res.body.data.domain).toMatchObject({ status: 'active', origin: 'https://app.cascade-it.example' })
    expect(res.body.data.domain.records.every((r: { found: boolean }) => r.found)).toBe(true)
    // The map was loaded again after the commit (N-8): the address answers at once.
    expect(resolveHost('app.cascade-it.example')).toMatchObject({ kind: 'partner', partnerId: a.id })
    await settle()
    expect(sent.some(e => e.to === a.ownerEmail && e.subject.includes('app.cascade-it.example'))).toBe(true)
    const [live] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'partnerDomain.live'), eq(commands.actor_id, DOMAIN_SYSTEM_ACTOR)))
    expect(live).toBeDefined()
  })

  test('a live address fails after two missed rechecks, not one; `moved` fails it at once', async () => {
    const row = (await rowOf(a))!
    const now = new Date().toISOString()
    const missed = {
      kind: 'hostname' as const,
      found: { ...(await fakeDomains('x').get(row.provider_id!))!, status: 'active', sslStatus: 'active' },
      probe: false,
    }
    await db.transaction(tx => applyDomainCheck(tx, row.id, missed, now))
    expect(await statusOf(a)).toBe('active')
    await db.transaction(tx => applyDomainCheck(tx, row.id, missed, now))
    expect((await rowOf(a))!).toMatchObject({ status: 'failed', failure: 'probe_failed' })
    // Live again at the next good look; then `moved` (the CNAME points elsewhere now) fails it at once.
    await db.transaction(tx => applyDomainCheck(tx, row.id, { ...missed, probe: true }, now))
    expect(await statusOf(a)).toBe('active')
    const moved = { ...missed, found: { ...missed.found, status: 'moved' }, probe: null }
    await db.transaction(tx => applyDomainCheck(tx, row.id, moved, now))
    expect((await rowOf(a))!).toMatchObject({ status: 'failed', failure: 'moved' })
  })

  test('the daily recheck: a failed address that works again is live again', async () => {
    const row = (await rowOf(a))!
    await db
      .update(partner_domains)
      .set({ last_checked_at: later(-2 * 86_400_000) })
      .where(eq(partner_domains.id, row.id))
    await recheckPartnerDomains()
    expect(await statusOf(a)).toBe('active')
    expect(resolveHost('app.cascade-it.example')).toMatchObject({ kind: 'partner' })
  })
})

describe('TXT before anything is created at the provider (domain takeover)', () => {
  test('no TXT, or the TXT of an earlier claim: nothing is created, the address stays pending', async () => {
    // The name was B's before: its old CNAME and TXT are still in DNS when C claims it.
    const c = await makePartner('Claimant')
    await approvedBrand(c, 'Claimant Desk')
    expect(await add(c, 'desk.shared.example')).toMatchObject({ status: 200 })
    const row = (await rowOf(c))!
    const { provider, created } = countingFake()
    fakeDns({})
    await checkOneDomain(row.id, new Date().toISOString(), provider)
    expect(created).toEqual([])
    fakeDns({ [challengeName('desk.shared.example')]: [challengeValue('a'.repeat(64))] })
    await checkOneDomain(row.id, new Date().toISOString(), provider)
    expect(created).toEqual([])
    expect((await rowOf(c))!).toMatchObject({ status: 'pending', provider_id: null })
    expect(resolveHost('desk.shared.example').kind).not.toBe('partner')
  })

  test("another partner's token never proves this claim; a removed claim's token never proves the next", async () => {
    expect(await add(b, 'desk.rival.example')).toMatchObject({ status: 200 })
    const first = (await rowOf(b))!
    expect(await remove(b, 'desk.rival.example')).toMatchObject({ status: 200 })
    expect(await add(b, 'desk.rival.example')).toMatchObject({ status: 200 })
    const second = (await rowOf(b))!
    expect(second.challenge_token).not.toBe(first.challenge_token)
    const c = (await db.select().from(partner_domains).where(eq(partner_domains.hostname, 'desk.shared.example')))[0]!
    const { provider, created } = countingFake()
    fakeDns({
      [challengeName('desk.rival.example')]: [challengeValue(first.challenge_token), challengeValue(c.challenge_token)],
    })
    await checkOneDomain(second.id, new Date().toISOString(), provider)
    expect(created).toEqual([])
    // Only the claim's own token, at both resolvers, creates it.
    fakeDns({ [challengeName('desk.rival.example')]: [challengeValue(second.challenge_token)] })
    await checkOneDomain(second.id, new Date().toISOString(), provider)
    expect(created).toEqual(['desk.rival.example'])
    expect(await statusOf(b)).toBe('verifying')
  })
})

describe('the check job', () => {
  test('5 minutes apart in the first hour, then 30; stopped after 72 hours; Check now restarts it', async () => {
    expect(await remove(b, 'desk.rival.example')).toMatchObject({ status: 200 })
    expect(await add(b, 'pending.rival.example')).toMatchObject({ status: 200 })
    const row = (await rowOf(b))!
    const started = Date.parse(row.checks_until!) - DOMAIN_CHECKS_FOR_MS
    const at = (ms: number) => new Date(started + ms).toISOString()
    expect(domainCheckDue({ ...row, last_checked_at: null }, at(60_000))).toBe(true)
    expect(domainCheckDue({ ...row, last_checked_at: at(60_000) }, at(4 * 60_000))).toBe(false)
    expect(domainCheckDue({ ...row, last_checked_at: at(60_000) }, at(6 * 60_000))).toBe(true)
    const checked = { ...row, last_checked_at: at(2 * 3600_000) }
    expect(domainCheckDue(checked, at(2 * 3600_000 + 10 * 60_000))).toBe(false)
    expect(domainCheckDue(checked, at(2 * 3600_000 + 31 * 60_000))).toBe(true)
    await checkPartnerDomains(at(60_000))
    expect(await statusOf(b)).toBe('pending')
    await checkPartnerDomains(at(DOMAIN_CHECKS_FOR_MS + 60_000))
    expect(await statusOf(b)).toBe('stopped')
    const res = await check(b)
    expect(res.body.data.domain.status).toBe('pending')
    expect(Date.parse((await rowOf(b))!.checks_until!)).toBeGreaterThan(Date.now() + DOMAIN_CHECKS_FOR_MS - 60_000)
  })

  test('a certificate that never comes fails before going live; Check now starts it again', async () => {
    expect(await remove(b, 'pending.rival.example')).toMatchObject({ status: 200 })
    expect(await add(b, 'failing.rival.example')).toMatchObject({ status: 200 })
    expect((await check(b)).body.data.domain.status).toBe('verifying')
    expect((await check(b)).body.data.domain).toMatchObject({ status: 'failed', failure: 'cert_failed' })
    expect(resolveHost('failing.rival.example').kind).not.toBe('partner')
    const res = await check(b)
    expect(res.body.data.domain).toMatchObject({ status: 'pending', failure: null })
    expect((await rowOf(b))!.provider_id).toBeNull()
  })

  test('Check now is limited per partner', async () => {
    let last = 0
    for (let i = 0; i < 12 && last !== 409; i++) last = (await check(b)).status
    expect((await check(b)).body.code).toBe('too_many_checks')
  })
})

describe('removal', () => {
  test('by its owner only with the address typed; out of the host map at once', async () => {
    expect(await remove(a, 'other.cascade-it.example')).toMatchObject({ status: 409, body: { code: 'no_domain' } })
    expect(resolveHost('app.cascade-it.example').kind).toBe('partner')
    const res = await remove(a, 'app.cascade-it.example')
    expect(res).toMatchObject({ status: 200, body: { data: { domain: null, removed: null } } })
    expect(resolveHost('app.cascade-it.example').kind).not.toBe('partner')
    // The name is free again, with a new token.
    expect(await add(a, 'app.cascade-it.example')).toMatchObject({ status: 200 })
    await check(a)
    await check(a)
    expect(resolveHost('app.cascade-it.example').kind).toBe('partner')
  })

  test('by a server admin at once, with a reason its owner is emailed and the command log keeps', async () => {
    sent.length = 0
    expect(await adminRemove(a, 'imitates a bank')).toMatchObject({ status: 200 })
    expect(resolveHost('app.cascade-it.example').kind).not.toBe('partner')
    await settle()
    expect(sent.some(e => e.to === a.ownerEmail && e.text.includes('imitates a bank'))).toBe(true)
    const data = (await act(a.owner, 'partnerDomain.get', { partnerId: a.id })).body.data
    expect(data).toMatchObject({
      domain: null,
      removed: { hostname: 'app.cascade-it.example', reason: 'imitates a bank', byAdmin: true },
    })
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerDomain.adminRemove'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(logged).toMatchObject({ actor_id: admin.userId, rejected: false })
    expect(await adminRemove(a, 'again')).toMatchObject({ status: 409, body: { code: 'no_domain' } })
  })

  test('the server admin list shows each partner its address', async () => {
    expect(await add(a, 'desk.cascade-it.example')).toMatchObject({ status: 200 })
    const res = await asServerAdmin(admin, () => act(admin, 'partner.adminList', {}))
    const listed = res.body.data.partners.find((p: { id: string }) => p.id === a.id)
    expect(listed.domain).toEqual({ hostname: 'desk.cascade-it.example', status: 'pending' })
  })
})

describe('a suspended partner', () => {
  test('may not change its address, is not checked, leaves the host map, and loses it after 30 days', async () => {
    const s = await makePartner('Suspended Soon')
    await approvedBrand(s, 'Soon Desk')
    expect(await add(s, 'app.soon.example')).toMatchObject({ status: 200 })
    await check(s)
    await check(s)
    expect(resolveHost('app.soon.example').kind).toBe('partner')
    expect((await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: s.id }))).status).toBe(200)
    expect(resolveHost('app.soon.example').kind).not.toBe('partner')
    expect((await check(s)).status).toBe(403)
    expect((await remove(s, 'app.soon.example')).status).toBe(403)
    expect((await act(s.owner, 'partnerDomain.get', { partnerId: s.id })).body.data?.canEdit ?? false).toBe(false)
    await db
      .update(partners)
      .set({ suspended_at: later(-DOMAIN_REMOVE_AFTER_MS - 60_000) })
      .where(eq(partners.id, s.id))
    sent.length = 0
    await recheckPartnerDomains()
    expect(await rowOf(s)).toBeUndefined()
    const [expired] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'partnerDomain.expired'), eq(commands.actor_id, DOMAIN_SYSTEM_ACTOR)))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(expired!.input).toMatchObject({ partnerId: s.id, hostname: 'app.soon.example' })
  })

  test('a failed address is removed after 30 days', async () => {
    const f = await makePartner('Failing Partner')
    await approvedBrand(f, 'Failing Desk')
    expect(await add(f, 'app.failed.example')).toMatchObject({ status: 200 })
    await db
      .update(partner_domains)
      .set({ status: 'failed', failure: 'cert_failed', failed_at: later(-DOMAIN_REMOVE_AFTER_MS - 60_000) })
      .where(eq(partner_domains.hostname, 'app.failed.example'))
    sent.length = 0
    await recheckPartnerDomains()
    expect(await rowOf(f)).toBeUndefined()
    await settle()
    expect(sent.some(e => e.to === f.ownerEmail && e.text.includes('app.failed.example'))).toBe(true)
    const data = (await act(f.owner, 'partnerDomain.get', { partnerId: f.id })).body.data
    expect(data.removed).toMatchObject({ hostname: 'app.failed.example', reason: 'expired', byAdmin: false })
  })
})
