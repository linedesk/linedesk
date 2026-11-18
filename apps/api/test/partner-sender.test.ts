// A white-label partner's own sender address (docs/white-label.md, slice S6): who may read and change it, which domains
// are refused, the states a domain moves through at the provider (the fake, SENDER_DOMAINS=fake), that emails use the
// address only while it is verified, and the support email's code before it becomes Reply-To. Makes an instance admin
// and changes process.env: an instance-wide file (vitest.config.ts).
import { commands, partner_branding, partner_sender_domains, user, verification } from '@linedesk/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { partnerSetupActor } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { fakeSenderDomains, SenderDomainError, stateOf } from '../src/domains/sender.ts'
import { type Email, emailSender, envelopeOf } from '../src/email.ts'
import { securityNoticeBrand } from '../src/email-brand.ts'
import { emailBrandOf, withWorkspaceBrand } from '../src/partner-brand.ts'
import {
  applySenderCheck,
  checkSenderDomains,
  domainRefusal,
  installDomains,
  SENDER_CHECKS_FOR_MS,
  SENDER_CLAIM_EXPIRES_MS,
  SENDER_FAILED_EXPIRES_MS,
  SENDER_SYSTEM_REMOVER,
  senderCheckDue,
} from '../src/partner-sender.ts'
import { runAction } from '../src/run-action.ts'
import { act, asServerAdmin, signUp, type User } from './helpers.ts'

type Sent = Email & { envelope: ReturnType<typeof envelopeOf> }
const sent: Sent[] = []
Object.assign(emailSender, {
  send: async (email: Email) => void sent.push({ ...email, envelope: envelopeOf(email, 'no-reply@mail.example') }),
})

const newEmail = (who = 'partner') => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const tokenFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
    .findLast(Boolean)
const codeFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/\b(\d{6})\b/)?.[1])
    .findLast(Boolean)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

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
async function approvedBrand(p: Partner, name: string, support: string) {
  await db
    .insert(partner_branding)
    .values({
      partner_id: p.id,
      name,
      support_email: support,
      updated_by: p.owner.userId,
      approved_revision: 1,
      approved_name: name,
      approved_support_email: support,
      approved_at: new Date().toISOString(),
    })
    .onConflictDoNothing()
}

const rowOf = (p: Partner) =>
  db
    .select()
    .from(partner_sender_domains)
    .where(and(eq(partner_sender_domains.partner_id, p.id), ne(partner_sender_domains.status, 'removed')))
    .then(rows => rows[0])

let a: Partner
let b: Partner
let clientA: string
let adminA: User
const watcherEmail = newEmail('watcher')
const saved = { SENDER_DOMAINS: process.env.SENDER_DOMAINS, EMAIL_FROM: process.env.EMAIL_FROM }

beforeAll(async () => {
  process.env.SENDER_DOMAINS = 'fake'
  admin = await signUp()
  await verify(admin)
  // An instance admin for good: a new sender domain is emailed to them.
  const watcher = await signUp(watcherEmail)
  await verify(watcher)
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, watcher.userId))
  a = await makePartner('Cascade IT Partners')
  b = await makePartner('Rival Agency')
  const res = await act(a.owner, 'workspace.createForClient', { partnerId: a.id, name: 'Brightwater Plumbing' })
  expect(res).toMatchObject({ status: 200 })
  clientA = res.body.data.workspace.id
  const email = newEmail('padmin')
  expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).toMatchObject({ status: 200 })
  adminA = await signUp(email)
  await verify(adminA)
  expect(await act(adminA, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
})

describe('domains a partner may not send from', () => {
  test("the install's own domains and those under them, never a bare co.uk", () => {
    const env = { WEB_ORIGIN: 'https://app.linedesk.ai', EMAIL_FROM: 'Linedesk <notify@mail.linedesk.ai>' }
    expect(installDomains(env).sort()).toEqual(['app.linedesk.ai', 'linedesk.ai', 'mail.linedesk.ai'])
    expect(installDomains({ WEB_ORIGIN: 'https://desk.example.co.uk' })).not.toContain('co.uk')
    expect(domainRefusal('linedesk.ai', [], env)).toBe('domain_install')
    expect(domainRefusal('partners.mail.linedesk.ai', [], env)).toBe('domain_install')
    expect(domainRefusal('notlinedesk.ai', [], env)).toBeNull()
  })

  test('a protected name in any label, also split by hyphens', () => {
    expect(domainRefusal('mail.paypal-billing.com', ['PayPal'], {})).toBe('domain_protected')
    expect(domainRefusal('pay.pal.example', ['PayPal'], {})).toBe('domain_protected')
    expect(domainRefusal('mail.cascade.example', ['PayPal'], {})).toBeNull()
  })

  test("only the provider's `verified` counts", () => {
    expect(stateOf('verified')).toBe('verified')
    expect(stateOf('partially_verified')).toBe('pending')
    expect(stateOf('temporary_failure')).toBe('failed')
    expect(stateOf('not_started')).toBe('pending')
  })
})

describe('who may read and change the sender', () => {
  test('hidden without a provider that verifies domains', async () => {
    delete process.env.SENDER_DOMAINS
    try {
      const res = await act(a.owner, 'partnerSender.get', { partnerId: a.id })
      expect(res).toMatchObject({ status: 200, body: { data: { available: false, sender: null } } })
      expect(
        await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'notify@mail.cascade.example' }),
      ).toMatchObject({ status: 409, body: { code: 'sender_unavailable' } })
    } finally {
      process.env.SENDER_DOMAINS = 'fake'
    }
  })

  test('locked until the brand is approved', async () => {
    const res = await act(a.owner, 'partnerSender.get', { partnerId: a.id })
    expect(res.body.data).toMatchObject({ available: true, locked: { brandApproved: false } })
    expect(
      await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'notify@mail.cascade.example' }),
    ).toMatchObject({ status: 409, body: { code: 'sender_locked' } })
    await approvedBrand(a, 'Cascade Desk', 'help@cascade.example')
    await approvedBrand(b, 'Rival Desk', 'help@rival.example')
    expect((await act(a.owner, 'partnerSender.get', { partnerId: a.id })).body.data.locked).toBeNull()
  })

  test('another partner, a team admin and the agent setup link are refused', async () => {
    expect((await act(b.owner, 'partnerSender.get', { partnerId: a.id })).status).toBe(403)
    expect(
      (await act(b.owner, 'partnerSender.add', { partnerId: a.id, address: 'notify@mail.cascade.example' })).status,
    ).toBe(403)
    expect((await act(adminA, 'partnerSender.get', { partnerId: a.id })).body.data.canEdit).toBe(false)
    for (const name of ['partnerSender.add', 'partnerSender.check', 'partnerSender.remove'])
      expect((await act(adminA, name, { partnerId: a.id, address: 'notify@mail.cascade.example' })).status, name).toBe(
        403,
      )
    expect((await act(adminA, 'partnerBrand.verifySupportEmail', { partnerId: a.id })).status).toBe(403)
    const actor = (await partnerSetupActor(a.owner.userId, 'test', a.id))!
    for (const [name, input] of [
      ['partnerSender.get', { partnerId: a.id }],
      ['partnerSender.add', { partnerId: a.id, address: 'notify@mail.cascade.example' }],
      ['partnerSender.check', { partnerId: a.id }],
      ['partnerSender.sendTest', { partnerId: a.id }],
      ['partnerSender.remove', { partnerId: a.id }],
      ['partnerBrand.verifySupportEmail', { partnerId: a.id }],
      ['partnerBrand.confirmSupportEmail', { partnerId: a.id, code: '123456' }],
    ] as const)
      expect((await runAction(name, input, actor)).status, name).toBe(403)
    expect(
      (await act(a.owner, 'partnerSender.adminRemove', { partnerId: a.id, reason: 'looks like a bank' })).status,
    ).toBe(403)
  })

  test('addresses and domains that are refused', async () => {
    for (const [address, code] of [
      ['not an address', 'address_invalid'],
      ['notify@localhost', 'address_invalid'],
      ['no tify@mail.cascade.example', 'address_invalid'],
      ['notify@mail.paypal-help.example', 'domain_protected'],
    ] as const)
      expect(await act(a.owner, 'partnerSender.add', { partnerId: a.id, address }), address).toMatchObject({
        status: 409,
        body: { code },
      })
    process.env.EMAIL_FROM = 'Desk <desk@notify.linedesk.test>'
    try {
      expect(
        await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'hi@clients.linedesk.test' }),
      ).toMatchObject({ status: 409, body: { code: 'domain_install' } })
    } finally {
      if (saved.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM
      else process.env.EMAIL_FROM = saved.EMAIL_FROM
    }
  })
})

describe('a sender from adding to removing', () => {
  test('added pending with its records; the admins are told; one per partner and per domain', async () => {
    sent.length = 0
    const res = await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'Notify@Mail.Cascade.example' })
    expect(res).toMatchObject({
      status: 200,
      body: { data: { sender: { address: 'notify@mail.cascade.example', status: 'pending' } } },
    })
    expect(res.body.data.sender.records.map((r: { type: string }) => r.type)).toEqual(['TXT', 'MX', 'TXT'])
    // Until it is verified: the partner's name, the install's address.
    expect(res.body.data.fromLine).toMatch(/^"Cascade Desk" <[^>]+>$/)
    expect(res.body.data.fromLine).not.toContain('cascade.example')
    await settle()
    expect(sent.some(e => e.to === watcherEmail && e.text.includes('notify@mail.cascade.example'))).toBe(true)
    expect(
      await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'hello@mail2.cascade.example' }),
    ).toMatchObject({ status: 409, body: { code: 'sender_exists' } })
    expect(
      await act(b.owner, 'partnerSender.add', { partnerId: b.id, address: 'other@mail.cascade.example' }),
    ).toMatchObject({ status: 409, body: { code: 'domain_taken' } })
    // Not used in emails while pending.
    expect((await emailBrandOf(clientA))?.fromAddress).toBeNull()
  })

  test('verified at the check: emails come from it, with the partner name; its owner is told', async () => {
    sent.length = 0
    const res = await act(a.owner, 'partnerSender.check', { partnerId: a.id })
    expect(res).toMatchObject({ status: 200, body: { data: { sender: { status: 'verified' } } } })
    expect(res.body.data.fromLine).toBe('"Cascade Desk" <notify@mail.cascade.example>')
    expect(await emailBrandOf(clientA)).toMatchObject({ fromAddress: 'notify@mail.cascade.example' })
    await withWorkspaceBrand(clientA, async () =>
      emailSender.send({ to: 'someone@brightwater.example', subject: 's', text: 't' }),
    )
    expect(sent.findLast(e => e.to === 'someone@brightwater.example')?.envelope.from).toBe(
      '"Cascade Desk" <notify@mail.cascade.example>',
    )
    await settle()
    expect(sent.some(e => e.to === a.ownerEmail && e.subject.includes('is verified'))).toBe(true)
  })

  test("a test email goes to the owner's own address only, from the partner's address", async () => {
    sent.length = 0
    const res = await act(a.owner, 'partnerSender.sendTest', { partnerId: a.id })
    expect(res).toMatchObject({ status: 200, body: { data: { sentTo: a.ownerEmail } } })
    const email = sent.find(e => e.to === a.ownerEmail)!
    expect(email.envelope).toEqual({ from: '"Cascade Desk" <notify@mail.cascade.example>' })
    expect((await act(b.owner, 'partnerSender.sendTest', { partnerId: b.id })).body.code).toBe('not_verified')
  })

  test('a verified domain falls back after two failed checks in a row, not one', async () => {
    const now = new Date().toISOString()
    const failed = { id: 'fake_x', status: 'failed', state: 'failed' as const, records: [] }
    await db.transaction(async tx => applySenderCheck(tx, (await rowOf(a))!, failed, now))
    expect((await rowOf(a))!.status).toBe('verified')
    sent.length = 0
    await db.transaction(async tx => applySenderCheck(tx, (await rowOf(a))!, failed, now))
    expect((await rowOf(a))!.status).toBe('failed')
    expect((await emailBrandOf(clientA))?.fromAddress).toBeNull()
    await settle()
    expect(sent.some(e => e.to === a.ownerEmail && e.subject.includes('stopped working'))).toBe(true)
    // "Check now" with the records back: verified again.
    expect((await act(a.owner, 'partnerSender.check', { partnerId: a.id })).body.data.sender.status).toBe('verified')
  })

  test('removed by its owner: the standard address again at once', async () => {
    const res = await act(a.owner, 'partnerSender.remove', { partnerId: a.id })
    expect(res).toMatchObject({ status: 200, body: { data: { sender: null, removedByAdmin: null } } })
    expect((await emailBrandOf(clientA))?.fromAddress).toBeNull()
    // The domain is free again.
    expect(
      await act(a.owner, 'partnerSender.add', { partnerId: a.id, address: 'notify@mail.cascade.example' }),
    ).toMatchObject({ status: 200 })
  })

  test('removed by a server admin with a reason its owner is emailed', async () => {
    sent.length = 0
    const res = await asServerAdmin(admin, () =>
      act(admin, 'partnerSender.adminRemove', { partnerId: a.id, reason: 'imitates a client of ours' }),
    )
    expect(res).toMatchObject({ status: 200 })
    await settle()
    expect(sent.some(e => e.to === a.ownerEmail && e.text.includes('imitates a client of ours'))).toBe(true)
    const data = (await act(a.owner, 'partnerSender.get', { partnerId: a.id })).body.data
    expect(data).toMatchObject({ sender: null, removedByAdmin: { reason: 'imitates a client of ours' } })
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerSender.adminRemove'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(logged).toMatchObject({ actor_id: admin.userId, rejected: false })
  })
})

describe('the check job', () => {
  test('a domain the provider never verifies stops after 72 hours; Check now restarts it', async () => {
    expect(
      await act(b.owner, 'partnerSender.add', { partnerId: b.id, address: 'notify@pending.rival.example' }),
    ).toMatchObject({ status: 200 })
    const row = (await rowOf(b))!
    const started = Date.parse(row.checks_until!) - SENDER_CHECKS_FOR_MS
    // Every 5 minutes in the first hour, then every 30.
    expect(senderCheckDue({ ...row, last_checked_at: null }, new Date(started + 60_000).toISOString())).toBe(true)
    const checked = { ...row, last_checked_at: new Date(started + 2 * 3600_000).toISOString() }
    expect(senderCheckDue(checked, new Date(started + 2 * 3600_000 + 10 * 60_000).toISOString())).toBe(false)
    expect(senderCheckDue(checked, new Date(started + 2 * 3600_000 + 31 * 60_000).toISOString())).toBe(true)
    await checkSenderDomains(db, new Date(started + 60_000).toISOString())
    expect((await rowOf(b))!.status).toBe('pending')
    await checkSenderDomains(db, new Date(started + SENDER_CHECKS_FOR_MS + 60_000).toISOString())
    expect((await rowOf(b))!.status).toBe('stopped')
    const res = await act(b.owner, 'partnerSender.check', { partnerId: b.id })
    expect(res.body.data.sender.status).toBe('pending')
  })
})

describe('the support email becomes Reply-To only once proven', () => {
  test('a code to the support address; three wrong tries; the right one proves it', async () => {
    expect((await emailBrandOf(clientA))?.replyTo).toBeNull()
    sent.length = 0
    expect(await act(a.owner, 'partnerBrand.verifySupportEmail', { partnerId: a.id })).toMatchObject({
      status: 200,
      body: { data: { sentTo: 'help@cascade.example' } },
    })
    await settle()
    const code = codeFor('help@cascade.example')!
    expect(code).toMatch(/^\d{6}$/)
    const wrong = code === '000000' ? '111111' : '000000'
    expect(await act(a.owner, 'partnerBrand.confirmSupportEmail', { partnerId: a.id, code: wrong })).toMatchObject({
      status: 409,
      body: { code: 'code_wrong' },
    })
    expect(await act(a.owner, 'partnerBrand.confirmSupportEmail', { partnerId: a.id, code })).toMatchObject({
      status: 200,
      body: { data: { support: { address: 'help@cascade.example', verified: true } } },
    })
    expect((await emailBrandOf(clientA))?.replyTo).toBe('help@cascade.example')
    // Security notices (impersonation) keep the partner's name but never its Reply-To.
    expect(securityNoticeBrand(await emailBrandOf(clientA))).toMatchObject({
      branding: { name: expect.any(String) },
      replyTo: null,
    })
    // The code is never in the command log.
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerBrand.confirmSupportEmail'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(JSON.stringify(logged!.input)).not.toContain(code)
  })

  test('out of tries, the code is spent; a code for an earlier address never proves a new one', async () => {
    await act(b.owner, 'partnerBrand.verifySupportEmail', { partnerId: b.id })
    await settle()
    const code = codeFor('help@rival.example')!
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 3; i++) await act(b.owner, 'partnerBrand.confirmSupportEmail', { partnerId: b.id, code: wrong })
    expect((await act(b.owner, 'partnerBrand.confirmSupportEmail', { partnerId: b.id, code })).body.code).toBe(
      'code_wrong',
    )
    await act(b.owner, 'partnerBrand.verifySupportEmail', { partnerId: b.id })
    await settle()
    const fresh = codeFor('help@rival.example')!
    await db
      .update(partner_branding)
      .set({ approved_support_email: 'new@rival.example', support_email: 'new@rival.example' })
      .where(eq(partner_branding.partner_id, b.id))
    expect((await act(b.owner, 'partnerBrand.confirmSupportEmail', { partnerId: b.id, code: fresh })).body.code).toBe(
      'code_wrong',
    )
    const [left] = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `partner-support:${b.id}`))
    expect(left).toBeUndefined()
  })
})

describe('security review of #1291', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const fake = { ...fakeSenderDomains }
  /** The fake provider's deletions while `work` runs (and any override of its calls). */
  async function atProvider<T>(override: Partial<typeof fakeSenderDomains>, work: (removed: string[]) => Promise<T>) {
    const removed: string[] = []
    Object.assign(fakeSenderDomains, {
      remove: async (id: string) => void removed.push(id),
      ...override,
    })
    try {
      return await work(removed)
    } finally {
      Object.assign(fakeSenderDomains, fake)
    }
  }
  const lastRemoved = (p: Partner) =>
    db
      .select()
      .from(partner_sender_domains)
      .where(and(eq(partner_sender_domains.partner_id, p.id), eq(partner_sender_domains.status, 'removed')))
      .orderBy(desc(partner_sender_domains.removed_at))
      .limit(1)
      .then(rows => rows[0])
  async function brandedPartner(name: string) {
    const p = await makePartner(`${name} Agency`)
    await approvedBrand(p, `${name} Desk`, `help@${name.toLowerCase()}.example`)
    return p
  }
  async function verifiedSender(p: Partner, address: string) {
    expect(await act(p.owner, 'partnerSender.add', { partnerId: p.id, address })).toMatchObject({ status: 200 })
    expect((await act(p.owner, 'partnerSender.check', { partnerId: p.id })).body.data.sender.status).toBe('verified')
  }

  test('L-1: a claim that never verifies ends after 7 days at the provider and frees the domain', async () => {
    const squatter = await brandedPartner('Squat')
    const real = await brandedPartner('Realowner')
    const address = 'notify@pending.realowner.example'
    expect(await act(squatter.owner, 'partnerSender.add', { partnerId: squatter.id, address })).toMatchObject({
      status: 200,
    })
    expect(await act(real.owner, 'partnerSender.add', { partnerId: real.id, address })).toMatchObject({
      status: 409,
      body: { code: 'domain_taken' },
    })
    const created = Date.parse((await rowOf(squatter))!.created_at)
    await checkSenderDomains(db, iso(created + SENDER_CHECKS_FOR_MS + 60_000))
    expect((await rowOf(squatter))!.status).toBe('stopped')
    // "Check now" checks again, but never makes the claim last longer.
    expect((await act(squatter.owner, 'partnerSender.check', { partnerId: squatter.id })).body.data.sender.status).toBe(
      'pending',
    )
    await checkSenderDomains(db, iso(created + SENDER_CLAIM_EXPIRES_MS - 60_000))
    expect(await rowOf(squatter)).toBeDefined()
    await atProvider({}, async removed => {
      await checkSenderDomains(db, iso(created + SENDER_CLAIM_EXPIRES_MS + 60_000))
      expect(removed).toContain('fake_pending.realowner.example')
    })
    expect(await rowOf(squatter)).toBeUndefined()
    expect(await lastRemoved(squatter)).toMatchObject({ removed_by: SENDER_SYSTEM_REMOVER, removed_reason: null })
    // Not shown as a server admin's removal; the real owner adds it now.
    expect((await act(squatter.owner, 'partnerSender.get', { partnerId: squatter.id })).body.data).toMatchObject({
      sender: null,
      removedByAdmin: null,
    })
    expect(await act(real.owner, 'partnerSender.add', { partnerId: real.id, address })).toMatchObject({ status: 200 })
  })

  test('L-1: a sender that verified once and then failed ends 30 days after it failed, not after 7', async () => {
    const p = await brandedPartner('Lapsed')
    await verifiedSender(p, 'notify@mail.lapsed.example')
    const failed = { id: 'fake_x', status: 'failed', state: 'failed' as const, records: [] }
    const now = new Date().toISOString()
    for (let i = 0; i < 2; i++) await db.transaction(async tx => applySenderCheck(tx, (await rowOf(p))!, failed, now))
    const row = (await rowOf(p))!
    expect(row.status).toBe('failed')
    await checkSenderDomains(db, iso(Date.parse(row.created_at) + SENDER_CLAIM_EXPIRES_MS + 60_000))
    expect((await rowOf(p))!.status).toBe('failed')
    await atProvider({}, async removed => {
      await checkSenderDomains(db, iso(Date.parse(row.failed_at!) + SENDER_FAILED_EXPIRES_MS + 60_000))
      expect(removed).toContain('fake_mail.lapsed.example')
    })
    expect(await rowOf(p)).toBeUndefined()
  })

  test('L-2: a verified sender is used only while the install sends with the provider that verified it', async () => {
    const p = await brandedPartner('Switch')
    const res = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Switch Client' })
    const client: string = res.body.data.workspace.id
    await verifiedSender(p, 'notify@mail.switch.example')
    expect((await emailBrandOf(client))?.fromAddress).toBe('notify@mail.switch.example')
    // The install stopped sending with Resend, or its domains key is gone: no provider for partner domains.
    delete process.env.SENDER_DOMAINS
    try {
      expect((await emailBrandOf(client))?.fromAddress).toBeNull()
      sent.length = 0
      await withWorkspaceBrand(client, async () =>
        emailSender.send({ to: 'someone@switch-client.example', subject: 's', text: 't' }),
      )
      const from = sent.findLast(e => e.to === 'someone@switch-client.example')!.envelope.from
      expect(from).toMatch(/^"Switch Desk" </)
      expect(from).not.toContain('switch.example>')
      const page = (await act(p.owner, 'partnerSender.get', { partnerId: p.id })).body.data
      expect(page.fromLine).not.toContain('mail.switch.example')
      expect(await act(p.owner, 'partnerSender.sendTest', { partnerId: p.id })).toMatchObject({
        status: 409,
        body: { code: 'not_verified' },
      })
    } finally {
      process.env.SENDER_DOMAINS = 'fake'
    }
    // A row verified at another provider than the one in use: the same.
    await db
      .update(partner_sender_domains)
      .set({ provider: 'resend' })
      .where(eq(partner_sender_domains.id, (await rowOf(p))!.id))
    expect((await emailBrandOf(client))?.fromAddress).toBeNull()
    await db
      .update(partner_sender_domains)
      .set({ provider: 'fake' })
      .where(eq(partner_sender_domains.id, (await rowOf(p))!.id))
    expect((await emailBrandOf(client))?.fromAddress).toBe('notify@mail.switch.example')
  })

  test('L-3: suspending a partner deletes its sender at the provider; the job never checks it; it adds it again after', async () => {
    const p = await brandedPartner('Suspend')
    await verifiedSender(p, 'notify@mail.suspend.example')
    await atProvider({}, async removed => {
      expect(await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: p.id }))).toMatchObject({
        status: 200,
      })
      expect(removed).toEqual(['fake_mail.suspend.example'])
    })
    expect(await rowOf(p)).toBeUndefined()
    expect(await lastRemoved(p)).toMatchObject({ removed_by: SENDER_SYSTEM_REMOVER, removed_reason: null })

    // The provider refuses at the suspension: the suspension stands, the job deletes it later and never checks it.
    const q = await brandedPartner('Refused')
    await verifiedSender(q, 'notify@mail.refused.example')
    const asked: string[] = []
    await atProvider(
      {
        remove: async () => {
          throw new SenderDomainError('Resend refused (500): try later', 500)
        },
        get: async id => {
          asked.push(id)
          return fake.get(id)
        },
      },
      async () => {
        expect(await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: q.id }))).toMatchObject({
          status: 200,
        })
        expect((await rowOf(q))!.status).toBe('verified')
        await checkSenderDomains(db, iso(Date.now() + 2 * 24 * 3600_000))
        expect(asked).not.toContain('fake_mail.refused.example')
        expect(await rowOf(q)).toBeDefined()
      },
    )
    await atProvider({}, async removed => {
      await checkSenderDomains(db, iso(Date.now() + 2 * 24 * 3600_000))
      expect(removed).toContain('fake_mail.refused.example')
    })
    expect(await rowOf(q)).toBeUndefined()
    // Unsuspended: the partner adds its sender again.
    expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: q.id }))).status).toBe(200)
    expect(
      await act(q.owner, 'partnerSender.add', { partnerId: q.id, address: 'notify@mail.refused.example' }),
    ).toMatchObject({ status: 200 })
  })

  test('L-5: punycode look-alikes are decoded before the protected-name check', async () => {
    // pаypal with a Cyrillic а.
    expect(domainRefusal('mail.xn--pypal-4ve.com', ['PayPal'], {})).toBe('domain_protected')
    expect(domainRefusal(new URL('https://mail.pаypal.com').hostname, ['PayPal'], {})).toBe('domain_protected')
    // A real IDN without a protected name is fine; one that does not decode is not an address.
    expect(domainRefusal('mail.xn--mnchen-3ya.de', ['PayPal'], {})).toBeNull()
    expect(domainRefusal('mail.xn--a.example', ['PayPal'], {})).toBe('address_invalid')
    // PayPal is on the built-in list.
    const p = await brandedPartner('Lookalike')
    const res = await act(p.owner, 'partnerSender.add', { partnerId: p.id, address: 'notify@mail.xn--pypal-4ve.com' })
    expect(res).toMatchObject({ status: 409, body: { code: 'domain_protected' } })
  })

  test('I-1: "Check now" asks the provider after the partner row is let go', async () => {
    const p = await brandedPartner('Slowcheck')
    expect(
      await act(p.owner, 'partnerSender.add', { partnerId: p.id, address: 'notify@mail.slowcheck.example' }),
    ).toMatchObject({ status: 200 })
    let answer: () => void = () => {}
    let asked: () => void = () => {}
    const askedNow = new Promise<void>(resolve => {
      asked = resolve
    })
    await atProvider(
      {
        verify: async () => {
          asked()
          await new Promise<void>(go => {
            answer = go
          })
        },
      },
      async () => {
        const checking = act(p.owner, 'partnerSender.check', { partnerId: p.id })
        await askedNow
        const renamed = act(p.owner, 'partner.update', { partnerId: p.id, name: 'Slowcheck Agency 2' })
        const first = await Promise.race([
          renamed.then(() => 'renamed'),
          new Promise(resolve => setTimeout(() => resolve('waited'), 3000)),
        ])
        answer()
        expect(first).toBe('renamed')
        expect(await renamed).toMatchObject({ status: 200 })
        expect((await checking).body.data.sender.status).toBe('verified')
      },
    )
  }, 15_000)
})
