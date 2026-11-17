// A white-label partner's brand (docs/white-label.md, slice S4): who may read and change it, the protected names, the
// brand in the app per active workspace, and the gate for emails (approved, and a paid invoice where the install
// bills). Makes an instance admin, switches billing on and sets the protected names: an instance-wide file
// (vitest.config.ts).
import {
  billing_accounts,
  billing_invoices,
  commands,
  instance_settings,
  member,
  partners,
  session,
  user,
} from '@linedesk/db'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { BILLING_ENABLED_KEY } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { type Email, emailSender, envelopeOf } from '../src/email.ts'
import { alertInstanceAdmins } from '../src/admin-alerts.ts'
import { withEmailBrand } from '../src/email-brand.ts'
import { providerFailureAlert } from '../src/emails/alerts.ts'
import { emailBrandOf } from '../src/partner-brand.ts'
import { act, addMember, appRequest, asServerAdmin, createWorkspace, request, signUp, type User } from './helpers.ts'

type Sent = Email & { envelope: ReturnType<typeof envelopeOf> }
const sent: Sent[] = []
// The test env prints email to the log; collect what would be sent instead, with the From and Reply-To the SMTP
// sender would use at that moment (the brand scope is read when the email is sent).
Object.assign(emailSender, {
  send: async (email: Email) => void sent.push({ ...email, envelope: envelopeOf(email, 'no-reply@mail.example') }),
})

const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='}`
/** Another picture: a red pixel. */
const PNG_RED = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='}`
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`

const newEmail = (who = 'partner') => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
/** An address that does not name this product, so an email to it can be checked for "Linedesk". */
const clientEmail = (who: string) => `${who}_${crypto.randomUUID().slice(0, 8)}@brightwater.example`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const tokenFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
    .findLast(Boolean)

let admin: User
/** An instance admin for good: brand changes of new partners are emailed to them. */
let watcher: User
const watcherEmail = newEmail('watcher')

async function makePartner(name: string, approve = true) {
  const ownerEmail = newEmail('owner')
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  expect(created).toMatchObject({ status: 200, body: { ok: true } })
  const id: string = created.body.data.partner.id
  if (approve)
    expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: id }))).status).toBe(200)
  const owner = await signUp(ownerEmail)
  await verify(owner)
  expect(await act(owner, 'partnerInvitation.accept', { token: tokenFor(ownerEmail) })).toMatchObject({ status: 200 })
  return { id, name, owner }
}
type Partner = Awaited<ReturnType<typeof makePartner>>

async function addPartnerAdmin(p: Partner) {
  const email = newEmail('padmin')
  expect(await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email })).toMatchObject({ status: 200 })
  const who = await signUp(email)
  await verify(who)
  expect(await act(who, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
  return who
}

async function createClient(p: Partner, name: string) {
  const res = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name })
  expect(res).toMatchObject({ status: 200, body: { ok: true } })
  return res.body.data.workspace.id as string
}

/** `who`, working in `workspaceId` (their session switched there, as the workspace menu does). */
async function inWorkspace(who: User, workspaceId: string): Promise<User> {
  await db.update(session).set({ activeOrganizationId: workspaceId }).where(eq(session.userId, who.userId))
  return { ...who, headers: { ...who.headers, 'x-workspace-id': workspaceId } }
}

type Review = { partnerId: string; state: string; revision: number; contentHash: string; draft: { name: string } }
/** The partner's brand as an instance admin sees it for review. */
async function reviewOf(partnerId: string): Promise<Review> {
  const reviews = await asServerAdmin(admin, () => act(admin, 'partnerBrand.reviews', {}))
  return reviews.body.data.brands.find((r: Review) => r.partnerId === partnerId)
}
const approveAs = (review: Pick<Review, 'revision' | 'contentHash'>, partnerId: string, reason: string) =>
  asServerAdmin(admin, () =>
    act(admin, 'partnerBrand.approve', {
      partnerId,
      revision: review.revision,
      contentHash: review.contentHash,
      reason,
    }),
  )

/** An instance admin approves the partner's brand as it is now. */
async function approveBrand(partnerId: string) {
  const res = await approveAs(await reviewOf(partnerId), partnerId, 'checked: their own brand')
  expect(res).toMatchObject({ status: 200 })
}

const brandInput = (partnerId: string, extra: Record<string, unknown> = {}) => ({
  partnerId,
  name: 'Cascade Desk',
  color: '#0f766e',
  supportEmail: 'help@cascade.example',
  termsUrl: 'https://cascade.example/terms',
  privacyUrl: 'https://cascade.example/privacy',
  ...extra,
})

const setBilling = async (on: boolean) => {
  if (on)
    await db
      .insert(instance_settings)
      .values({ key: BILLING_ENABLED_KEY, value: 'on' })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: 'on' } })
  else await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY))
}

let a: Partner
let b: Partner
let clientA: string
let clientB: string
let adminA: User

beforeAll(async () => {
  admin = await signUp()
  await verify(admin)
  watcher = await signUp(watcherEmail)
  await verify(watcher)
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, watcher.userId))
  a = await makePartner('Cascade IT Partners')
  b = await makePartner('Rival Agency')
  clientA = await createClient(a, 'Brightwater Plumbing')
  clientB = await createClient(b, 'Rival Client')
  adminA = await addPartnerAdmin(a)
})

afterAll(async () => {
  await setBilling(false)
  await db.delete(instance_settings).where(eq(instance_settings.key, 'partner.protectedNames'))
})

describe('who may read and change the brand', () => {
  test('the owner sets it; the brand comes back with its gate, the change is in the command log', async () => {
    const res = await act(a.owner, 'partnerBrand.set', brandInput(a.id, { logo: PNG }))
    expect(res).toMatchObject({
      status: 200,
      body: {
        data: {
          brand: {
            name: 'Cascade Desk',
            supportEmail: 'help@cascade.example',
            termsUrl: 'https://cascade.example/terms',
          },
          // Nothing approved yet: clients and emails get the install's brand (security review of #1111, M-2).
          review: { state: 'none', approved: null, approvedAt: null },
          // The partner is approved and this install does not bill; only the brand's review is missing.
          emails: { active: false, approved: true, paid: true },
          canEdit: true,
        },
      },
    })
    expect(res.body.data.brand.logoUrl).toMatch(new RegExp(`^/v1/branding/partners/${a.id}/logo\\.png\\?v=\\w+$`))
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerBrand.set'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(logged).toMatchObject({ actor_id: a.owner.userId, rejected: false })
    // The logo is sensitive: the log notes it, not the image.
    expect(JSON.stringify(logged!.input)).not.toContain('iVBORw0KGgo')
  })

  test('a change that waits for review is emailed to the instance admins, with its logo, address and links', async () => {
    await vi.waitFor(() => {
      const alert = sent.find(e => e.to === watcherEmail && e.subject.includes('Cascade IT Partners'))
      expect(alert?.text).toContain('Cascade Desk')
      expect(alert?.text).toMatch(new RegExp(`/v1/branding/partners/${a.id}/logo\\.png\\?v=\\w+`))
      for (const shown of ['help@cascade.example', 'https://cascade.example/terms', 'https://cascade.example/privacy'])
        expect(alert?.text).toContain(shown)
      expect(alert?.text).toContain('#admin/partners')
      // Sent to this install's admins: the install's brand and no partner Reply-To.
      expect(alert?.envelope.from).not.toContain('Cascade Desk')
      expect(alert?.envelope).not.toHaveProperty('replyTo')
    })
  })

  test('a partner admin reads it but may not change it', async () => {
    expect(await act(adminA, 'partnerBrand.get', { partnerId: a.id })).toMatchObject({
      status: 200,
      body: { data: { brand: { name: 'Cascade Desk' }, canEdit: false } },
    })
    expect((await act(adminA, 'partnerBrand.set', brandInput(a.id, { name: 'Other Desk' }))).status).toBe(403)
  })

  test("another partner's team and a client's staff get 403, for reading and for changing", async () => {
    expect((await act(b.owner, 'partnerBrand.get', { partnerId: a.id })).status).toBe(403)
    expect((await act(b.owner, 'partnerBrand.set', brandInput(a.id, { name: 'Stolen Desk' }))).status).toBe(403)
    const staff = await addMember(clientA, 'admin')
    expect((await act(staff, 'partnerBrand.get', { partnerId: a.id })).status).toBe(403)
    expect((await act(staff, 'partnerBrand.set', brandInput(a.id))).status).toBe(403)
    expect((await act(b.owner, 'partnerBrand.get', { partnerId: 'no-such-partner' })).status).toBe(403)
  })

  test('a suspended partner keeps its brand but may not change it, and its clients see the install brand', async () => {
    const p = await makePartner('Paused Partner')
    const c = await createClient(p, 'Paused Client')
    expect((await act(p.owner, 'partnerBrand.set', brandInput(p.id, { name: 'Paused Desk' }))).status).toBe(200)
    await approveBrand(p.id)
    expect((await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: p.id }))).status).toBe(200)
    expect((await act(p.owner, 'partnerBrand.set', brandInput(p.id, { name: 'Paused Desk 2' }))).status).toBe(403)
    const owner = await inWorkspace(p.owner, c)
    const shown = await request(owner, 'GET', '/v1/branding')
    expect(shown.body.name).not.toBe('Paused Desk')
    expect(shown.body.partner ?? null).toBeNull()
  })

  test('only https links, a real email and a PNG logo (no SVG)', async () => {
    for (const bad of [
      { termsUrl: 'http://cascade.example/terms' },
      { privacyUrl: 'javascript:alert(1)' },
      { supportEmail: 'help' },
      { logo: SVG },
      { color: 'red' },
    ]) {
      expect((await act(a.owner, 'partnerBrand.set', brandInput(a.id, bad))).status, JSON.stringify(bad)).toBe(422)
    }
  })
})

describe('protected names', () => {
  test('a protected name, or one that contains it, is refused', async () => {
    for (const name of ['Linedesk', 'PayPal Desk', 'G00gle Voice', 'Bank of America Line']) {
      expect(await act(a.owner, 'partnerBrand.set', brandInput(a.id, { name }))).toMatchObject({
        status: 409,
        body: { code: 'name_protected' },
      })
    }
  })

  test('an instance admin sets the list; the next change is checked against it; null brings back the built-in one', async () => {
    expect((await act(a.owner, 'partnerBrand.setProtectedNames', { names: ['Acme'] })).status).toBe(403)
    expect((await act(a.owner, 'partnerBrand.protectedNames', {})).status).toBe(403)
    const set = await asServerAdmin(admin, () =>
      act(admin, 'partnerBrand.setProtectedNames', { names: ['Acme', ' Acme ', 'Globex'] }),
    )
    expect(set).toMatchObject({ status: 200, body: { data: { names: ['Acme', 'Globex'], builtIn: false } } })
    expect(await act(a.owner, 'partnerBrand.set', brandInput(a.id, { name: 'Acme Calls' }))).toMatchObject({
      status: 409,
      body: { code: 'name_protected' },
    })
    expect((await act(a.owner, 'partnerBrand.set', brandInput(a.id, { name: 'PayPal Desk' }))).status).toBe(200)
    const reset = await asServerAdmin(admin, () => act(admin, 'partnerBrand.setProtectedNames', { names: null }))
    expect(reset.body.data).toMatchObject({ builtIn: true })
    expect(reset.body.data.names).toContain('PayPal')
    expect((await act(a.owner, 'partnerBrand.set', brandInput(a.id))).status).toBe(200)
  })
})

describe('the brand in the app', () => {
  test("before an instance admin approves it, only the partner's team sees the brand", async () => {
    const staff = await addMember(clientA, 'member')
    const asClient = await request(await inWorkspace(staff, clientA), 'GET', '/v1/branding')
    expect(asClient.body.name).not.toBe('Cascade Desk')
    expect(asClient.body.partner ?? null).toBeNull()
    const asTeam = await request(await inWorkspace(a.owner, clientA), 'GET', '/v1/branding')
    expect(asTeam.body).toMatchObject({ name: 'Cascade Desk', partner: { id: a.id } })
    expect(await emailBrandOf(clientA)).toBeNull()
  })

  test('GET /v1/branding follows the active workspace', async () => {
    expect(
      (await act(b.owner, 'partnerBrand.set', brandInput(b.id, { name: 'Rival Desk', supportEmail: null }))).status,
    ).toBe(200)
    await approveBrand(a.id)
    await approveBrand(b.id)
    // Someone in a workspace of their own and in Partner A's client.
    const { owner: person, id: own } = await createWorkspace('Own Plumbing')
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: clientA,
      userId: person.userId,
      role: 'member',
      createdAt: new Date(),
    })
    const inClient = await request(await inWorkspace(person, clientA), 'GET', '/v1/branding')
    expect(inClient.body).toMatchObject({
      name: 'Cascade Desk',
      color: '#0f766e',
      poweredBy: false,
      starPrompt: false,
      partner: { id: a.id, supportEmail: 'help@cascade.example', terms: 'https://cascade.example/terms' },
    })
    const inOwn = await request(await inWorkspace(person, own), 'GET', '/v1/branding')
    expect(inOwn.body.name).not.toBe('Cascade Desk')
    expect(inOwn.body.partner ?? null).toBeNull()
    const rival = await request(await inWorkspace(b.owner, clientB), 'GET', '/v1/branding')
    expect(rival.body).toMatchObject({ name: 'Rival Desk', partner: { id: b.id, supportEmail: null } })
    // Never cached across people.
    const raw = await appRequest('/v1/branding', { headers: person.headers })
    expect(raw.headers.get('cache-control')).toBe('private, no-cache')
  })

  test("the partner's logo is served as a PNG that cannot run anything", async () => {
    const got = await act(a.owner, 'partnerBrand.get', { partnerId: a.id })
    const res = await appRequest(got.body.data.brand.logoUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect((await appRequest(`/v1/branding/partners/${b.id}/logo.png?v=1`)).status).toBe(404)
    // Only the versions it has: an address made up for another version is never served (security review #1111, L-4).
    expect((await appRequest(`/v1/branding/partners/${a.id}/logo.png?v=made-up`)).status).toBe(404)
    expect((await appRequest(`/v1/branding/partners/${a.id}/logo.png`)).status).toBe(404)
    // A 404 is never kept by a cache in front: the logo approved a moment later is served (security review #1111, C-1).
    for (const missing of [`${b.id}/logo.png?v=1`, `${a.id}/logo.png?v=made-up`, `nobody/logo.png`]) {
      const res = await appRequest(`/v1/branding/partners/${missing}`)
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('the brand in emails', () => {
  test("a client's invitation carries the partner's name, Reply-To its support email, and no Linedesk", async () => {
    const to = clientEmail('invitee')
    const owner = await inWorkspace(a.owner, clientA)
    expect(await act(owner, 'team.invite', { email: to, role: 'member' })).toMatchObject({ status: 200 })
    const email = sent.findLast(e => e.to === to)!
    expect(email.subject).toContain('Cascade Desk')
    for (const part of [email.subject, email.text, email.html]) expect(part).not.toMatch(/linedesk|powered by/i)
    expect(email.envelope).toEqual({ from: '"Cascade Desk" <no-reply@mail.example>', replyTo: 'help@cascade.example' })
  })

  test('an admin alert set off inside a partner scope goes out in the install brand, without its Reply-To', async () => {
    const captured: Sent[] = []
    const sender = {
      kind: 'smtp' as const,
      check: async () => ({ ok: true, message: '' }),
      send: async (email: Email) =>
        void captured.push({ ...email, envelope: envelopeOf(email, 'Linedesk <no-reply@mail.example>') }),
    }
    const brand = await emailBrandOf(clientA)
    expect(brand).not.toBeNull()
    await withEmailBrand(brand, () =>
      alertInstanceAdmins(providerFailureAlert('Resend', 'quota', 'quota_exceeded'), sender, { wait: true }),
    )
    const mine = captured.find(e => e.to === watcherEmail)!
    expect(mine.envelope).toEqual({ from: 'Linedesk <no-reply@mail.example>' })
    for (const part of [mine.subject, mine.text, mine.html]) expect(part).not.toContain('Cascade Desk')
  })

  test('a pending partner: its brand shows in the app, not in emails', async () => {
    const p = await makePartner('Pending Partner', false)
    const res = await act(p.owner, 'partnerBrand.set', brandInput(p.id, { name: 'Pending Desk' }))
    expect(res.body.data.emails).toEqual({ active: false, approved: false, paid: true })
  })

  test('where the install bills: emails carry the brand only after a paid subscription invoice, while the bill runs', async () => {
    const [bill] = await db
      .insert(billing_accounts)
      .values({
        id: crypto.randomUUID(),
        kind: 'partner',
        owner_user_id: a.owner.userId,
        status: 'active',
        interval: 'month',
      })
      .returning()
    await db.update(partners).set({ billing_account_id: bill!.id }).where(eq(partners.id, a.id))
    await setBilling(true)
    try {
      expect(await emailBrandOf(clientA)).toBeNull()
      const invoice = (status: 'open' | 'paid', total: number, kind: 'subscription' | 'topup' = 'subscription') =>
        db.insert(billing_invoices).values({
          stripe_invoice_id: `in_${crypto.randomUUID().slice(0, 12)}`,
          billing_account_id: bill!.id,
          kind,
          status,
          total_cents: total,
        })
      await invoice('open', 1900)
      await invoice('paid', 0)
      // A minutes top-up is no plan fee: a trial cannot buy the brand for $5 (security review of #1111, L-2).
      await invoice('paid', 500, 'topup')
      expect(await emailBrandOf(clientA)).toBeNull()
      expect((await act(a.owner, 'partnerBrand.get', { partnerId: a.id })).body.data.emails).toEqual({
        active: false,
        approved: true,
        paid: false,
      })
      // The workspace's emails go out with the install's brand meanwhile.
      const to = clientEmail('early')
      expect(
        await act(await inWorkspace(a.owner, clientA), 'team.invite', { email: to, role: 'member' }),
      ).toMatchObject({
        status: 200,
      })
      const early = sent.findLast(e => e.to === to)!
      expect(early.subject).not.toContain('Cascade Desk')
      expect(early.envelope).not.toHaveProperty('replyTo')
      await invoice('paid', 1900)
      expect(await emailBrandOf(clientA)).toMatchObject({
        branding: { name: 'Cascade Desk', poweredBy: false },
        replyTo: 'help@cascade.example',
      })
      // A bill that stops running takes the brand out of emails again; a comped one keeps it.
      for (const [status, branded] of [
        ['suspended', false],
        ['canceled', false],
        ['past_due', true],
        ['comped', true],
      ] as const) {
        await db
          .update(billing_accounts)
          .set({ status, suspend_reason: status === 'suspended' ? 'admin' : null })
          .where(eq(billing_accounts.id, bill!.id))
        expect(!!(await emailBrandOf(clientA)), status).toBe(branded)
      }
    } finally {
      await setBilling(false)
      await db.update(partners).set({ billing_account_id: null }).where(eq(partners.id, a.id))
    }
  })
})

describe('review of brand changes (security review of #1111, M-2)', () => {
  test('a change after approval waits: clients and emails keep the approved version, the team sees its draft', async () => {
    // Old enough that no "first days" rule could explain the alert.
    await db
      .update(partners)
      .set({ created_at: new Date(Date.now() - 90 * 86_400_000).toISOString() })
      .where(eq(partners.id, a.id))
    const res = await act(
      a.owner,
      'partnerBrand.set',
      brandInput(a.id, { name: 'Cascade Phones', supportEmail: 'billing@other.example' }),
    )
    expect(res.body.data).toMatchObject({
      brand: { name: 'Cascade Phones', supportEmail: 'billing@other.example' },
      review: { state: 'pending', approved: { name: 'Cascade Desk', supportEmail: 'help@cascade.example' } },
      emails: { active: true },
    })
    expect(await emailBrandOf(clientA)).toMatchObject({
      branding: { name: 'Cascade Desk' },
      replyTo: 'help@cascade.example',
    })
    const to = clientEmail('waiting')
    expect(await act(await inWorkspace(a.owner, clientA), 'team.invite', { email: to, role: 'member' })).toMatchObject({
      status: 200,
    })
    expect(sent.findLast(e => e.to === to)).toMatchObject({
      subject: expect.stringContaining('Cascade Desk'),
      envelope: { from: '"Cascade Desk" <no-reply@mail.example>', replyTo: 'help@cascade.example' },
    })
    const staff = await addMember(clientA, 'member')
    expect((await request(await inWorkspace(staff, clientA), 'GET', '/v1/branding')).body.name).toBe('Cascade Desk')
    expect((await request(await inWorkspace(a.owner, clientA), 'GET', '/v1/branding')).body.name).toBe('Cascade Phones')
    // Every change that waits is emailed, however old the partner is.
    await vi.waitFor(() =>
      expect(
        sent.some(
          e => e.to === watcherEmail && e.text.includes('Cascade Phones') && e.text.includes('billing@other.example'),
        ),
      ).toBe(true),
    )
  })

  test('only an instance admin approves, and only the version they saw; then it goes live', async () => {
    const reviews = await asServerAdmin(admin, () => act(admin, 'partnerBrand.reviews', {}))
    const review = reviews.body.data.brands.find((r: { partnerId: string }) => r.partnerId === a.id)
    expect(review).toMatchObject({
      state: 'pending',
      draft: { name: 'Cascade Phones' },
      approved: { name: 'Cascade Desk' },
    })
    // Pending changes are listed first.
    expect(reviews.body.data.brands[0].state).toBe('pending')
    const own = { partnerId: a.id, revision: review.revision, contentHash: review.contentHash, reason: 'mine' }
    expect((await act(a.owner, 'partnerBrand.approve', own)).status).toBe(403)
    expect((await act(a.owner, 'partnerBrand.reviews', {})).status).toBe(403)
    // An older revision, or a hash of other content, is not what the admin is approving now (#1111, N-1).
    for (const stale of [
      { revision: review.revision - 1, contentHash: review.contentHash },
      { revision: review.revision, contentHash: '0'.repeat(64) },
    ])
      expect(await approveAs(stale, a.id, 'looked at it')).toMatchObject({
        status: 409,
        body: { code: 'brand_changed' },
      })
    expect(
      (
        await asServerAdmin(admin, () =>
          act(admin, 'partnerBrand.approve', {
            partnerId: a.id,
            revision: review.revision,
            contentHash: review.contentHash,
          }),
        )
      ).status,
    ).toBe(422)
    const approved = await approveAs(review, a.id, 'their own new name')
    expect(approved).toMatchObject({ status: 200, body: { data: { review: { state: 'approved' } } } })
    expect(await emailBrandOf(clientA)).toMatchObject({
      branding: { name: 'Cascade Phones' },
      replyTo: 'billing@other.example',
    })
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerBrand.approve'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(logged).toMatchObject({ actor_id: admin.userId, rejected: false })
    expect(logged!.input).toMatchObject({ partnerId: a.id, reason: 'their own new name' })
  })

  test('only the color is not reviewed; going back to the approved version needs no review', async () => {
    const color = await act(
      a.owner,
      'partnerBrand.set',
      brandInput(a.id, { name: 'Cascade Phones', supportEmail: 'billing@other.example', color: '#1d4ed8' }),
    )
    expect(color.body.data.review.state).toBe('approved')
    expect((await emailBrandOf(clientA))?.branding.color).toBe('#1d4ed8')
    const away = await act(
      a.owner,
      'partnerBrand.set',
      brandInput(a.id, { name: 'Cascade Lines', supportEmail: 'billing@other.example', color: '#1d4ed8' }),
    )
    expect(away.body.data.review.state).toBe('pending')
    const back = await act(
      a.owner,
      'partnerBrand.set',
      brandInput(a.id, { name: 'Cascade Phones', supportEmail: 'billing@other.example', color: '#1d4ed8' }),
    )
    expect(back.body.data.review.state).toBe('approved')
  })

  test('the revision only goes up, and approve needs the hash of what the admin saw: A, B, back to A, then C (#1111, N-1)', async () => {
    const at = (name: string) =>
      act(
        a.owner,
        'partnerBrand.set',
        brandInput(a.id, { name, supportEmail: 'billing@other.example', color: '#1d4ed8' }),
      )
    const start = await reviewOf(a.id)
    expect(start.state).toBe('approved')
    expect((await at('Cascade Lines')).body.data.review.state).toBe('pending')
    // The admin opens the review of B ...
    const seen = await reviewOf(a.id)
    expect(seen).toMatchObject({ state: 'pending', draft: { name: 'Cascade Lines' } })
    // ... the partner goes back to A (approved again, no review) and on to C.
    expect((await at('Cascade Phones')).body.data.review.state).toBe('approved')
    const back = await reviewOf(a.id)
    expect(back.state).toBe('approved')
    expect((await at('Cascade Calls')).body.data.review.state).toBe('pending')
    const now = await reviewOf(a.id)
    expect([start.revision, seen.revision, back.revision, now.revision]).toEqual(
      [...[start.revision, seen.revision, back.revision, now.revision]].sort((x, y) => x - y),
    )
    expect(new Set([start.revision, seen.revision, back.revision, now.revision]).size).toBe(4)
    expect(now.contentHash).not.toBe(seen.contentHash)
    expect(back.contentHash).toBe(start.contentHash)
    // Approving B approves nothing: neither its revision nor its hash is C's.
    for (const stale of [seen, { revision: now.revision, contentHash: seen.contentHash }])
      expect(await approveAs(stale, a.id, 'the one I looked at')).toMatchObject({
        status: 409,
        body: { code: 'brand_changed' },
      })
    expect(await reviewOf(a.id)).toMatchObject({ state: 'pending', draft: { name: 'Cascade Calls' } })
    expect(await emailBrandOf(clientA)).toMatchObject({ branding: { name: 'Cascade Phones' } })
  })

  test('approve checks the name against the protected names as they are now (#1111, N-3)', async () => {
    const review = await reviewOf(a.id)
    expect(review.draft.name).toBe('Cascade Calls')
    await asServerAdmin(admin, () => act(admin, 'partnerBrand.setProtectedNames', { names: ['Cascade Calls'] }))
    try {
      expect(await approveAs(review, a.id, 'looks fine')).toMatchObject({
        status: 409,
        body: { code: 'name_protected' },
      })
      expect(await emailBrandOf(clientA)).toMatchObject({ branding: { name: 'Cascade Phones' } })
    } finally {
      await asServerAdmin(admin, () => act(admin, 'partnerBrand.setProtectedNames', { names: null }))
    }
    expect(await approveAs(review, a.id, 'looks fine')).toMatchObject({ status: 200 })
    expect(await emailBrandOf(clientA)).toMatchObject({ branding: { name: 'Cascade Calls' } })
  })

  test("a logo that waits for review is served only to the partner's team and instance admins, never cached (#1111, N-2)", async () => {
    const set = await act(a.owner, 'partnerBrand.set', {
      ...brandInput(a.id, { name: 'Cascade Calls', supportEmail: 'billing@other.example', color: '#1d4ed8' }),
      logo: PNG_RED,
    })
    expect(set.body.data.review.state).toBe('pending')
    const draft: string = set.body.data.brand.logoUrl
    const live: string = set.body.data.review.approved.logoUrl
    expect(draft).not.toBe(live)
    const staff = await addMember(clientA, 'member')
    for (const [who, label] of [
      [null, 'anonymous'],
      [b.owner, "another partner's owner"],
      [staff, "a client's staff"],
    ] as const) {
      const res = await appRequest(draft, who ? { headers: who.headers } : {})
      expect(res.status, label).toBe(404)
    }
    for (const [who, label] of [
      [a.owner, 'the owner'],
      [adminA, 'a partner admin'],
      [watcher, 'an instance admin'],
    ] as const) {
      const res = await appRequest(draft, { headers: who.headers })
      expect(res.status, label).toBe(200)
      expect(res.headers.get('cache-control'), label).toBe('private, no-store')
    }
    // The approved logo stays public and cacheable for good: its address changes with every new version.
    const approved = await appRequest(live)
    expect(approved.status).toBe(200)
    expect(approved.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  test("an instance admin removes a brand: clients and emails get the install's at once", async () => {
    expect((await act(a.owner, 'partnerBrand.reset', { partnerId: a.id, reason: 'mine' })).status).toBe(403)
    const reset = await asServerAdmin(admin, () =>
      act(admin, 'partnerBrand.reset', { partnerId: a.id, reason: 'borrowed a bank logo' }),
    )
    expect(reset.status).toBe(200)
    expect(await emailBrandOf(clientA)).toBeNull()
    const staff = await addMember(clientA, 'member')
    expect((await request(await inWorkspace(staff, clientA), 'GET', '/v1/branding')).body.partner ?? null).toBeNull()
    expect((await act(a.owner, 'partnerBrand.get', { partnerId: a.id })).body.data).toMatchObject({
      brand: null,
      review: { state: 'none' },
    })
    expect(
      await asServerAdmin(admin, () => act(admin, 'partnerBrand.reset', { partnerId: a.id, reason: 'again' })),
    ).toMatchObject({ status: 409, body: { code: 'no_brand' } })
    // A new brand waits for review again.
    const again = await act(a.owner, 'partnerBrand.set', brandInput(a.id))
    expect(again.body.data.review.state).toBe('none')
    expect(await emailBrandOf(clientA)).toBeNull()
  })
})
