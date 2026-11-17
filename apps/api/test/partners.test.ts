// White-label partners (docs/white-label.md, slice S1): tenancy and permissions. A partner's team reaches its own
// partner and its client workspaces, never another partner's; client memberships follow the team (invite, accept,
// remove, suspend, approve); a partner's membership is changed only on the partner. Makes server admins and switches
// billing on for one test: an instance-wide file (vitest.config.ts).
import {
  api_keys,
  billing_accounts,
  billing_balances,
  billing_periods,
  commands,
  instance_settings,
  invitation,
  member,
  organization,
  partner_invitations,
  partner_members,
  partners,
  phone_numbers,
  session,
  usage_limit_alerts,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { listAudit } from '../src/audit.ts'
import { BILLING_ENABLED_KEY } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { type Email, emailSender } from '../src/email.ts'
import type { BillingProvider, SeatQuantityInput } from '@linedesk/billing'
import { lockExtraCalls } from '../src/extra-calls.ts'
import { postEntry } from '../src/ledger.ts'
import { createHash } from 'node:crypto'
import { PgBoss } from 'pg-boss'
import { createSeatSyncQueues, PARTNER_SEAT_SYNC, PARTNER_SEAT_SYNC_FAILED, setJobQueue } from '../src/jobs.ts'
import { runSeatSync, seatProration, seatSyncFailed, syncSeats } from '../src/partner-billing.ts'
import { canonicalJson } from '../src/run-action.ts'
import { mayCreateUser } from '../src/signup-gate.ts'
import {
  act,
  addMember,
  anonymous,
  appRequest,
  asServerAdmin,
  createWorkspace,
  FROM,
  randomIp,
  request,
  signUp,
  type User,
} from './helpers.ts'

const ORIGIN = 'http://localhost:5173'

/** Price ids a test pretends the catalog sync stored; null reads the real stored ones. */
const catalog = vi.hoisted(() => ({ prices: null as Record<string, string> | null }))
vi.mock('../src/billing-catalog.ts', async original => {
  const real = await original<typeof import('../src/billing-catalog.ts')>()
  return {
    ...real,
    pricesForCheckout: async (provider: Parameters<typeof real.pricesForCheckout>[0]) =>
      catalog.prices ?? real.pricesForCheckout(provider),
  }
})

const sent: Email[] = []
// The test env prints email to the log (EMAIL_TO_LOG); collect what would be sent instead.
Object.assign(emailSender, { send: async (email: Email) => void sent.push(email) })

const newEmail = (who = 'partner') => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const tokenFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
    .findLast(Boolean)

let admin: User

/** A partner made by a server admin, its owner signed up and joined through the emailed link. */
async function makePartner(name: string, approve = true) {
  const ownerEmail = newEmail('owner')
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  expect(created).toMatchObject({ status: 200, body: { ok: true } })
  const id: string = created.body.data.partner.id
  if (approve)
    expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: id }))).status).toBe(200)
  const owner = await signUp(ownerEmail)
  await verify(owner)
  const token = tokenFor(ownerEmail)
  expect(token).toBeTruthy()
  expect(await act(owner, 'partnerInvitation.accept', { token })).toMatchObject({ status: 200, body: { ok: true } })
  return { id, name, owner }
}
type Partner = Awaited<ReturnType<typeof makePartner>>

/** An admin of the partner team: invited by its owner, joined through the link. */
async function addPartnerAdmin(p: Partner) {
  const email = newEmail('padmin')
  expect(await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email })).toMatchObject({ status: 200 })
  const who = await signUp(email)
  await verify(who)
  expect(await act(who, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
  return who
}

/**
 * Signs in (or up) with an email code, the way the sign-in page does, through Better Auth and its hooks (a test user
 * made by signUp skips them).
 */
async function signInWithCode(email: string): Promise<{ status: number; who: User | null }> {
  const asked = await request(
    anonymous,
    'POST',
    '/api/auth/email-otp/send-verification-otp',
    { email, type: 'sign-in' },
    { origin: ORIGIN, [FROM]: randomIp() },
  )
  expect(asked.status).toBe(200)
  await vi.waitFor(() => expect(sent.some(e => e.to === email && /^\d{6} /.test(e.subject))).toBe(true))
  const otp = sent.findLast(e => e.to === email && /^\d{6} /.test(e.subject))!.subject.slice(0, 6)
  const res = await appRequest('/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, otp }),
  })
  if (res.status !== 200) return { status: res.status, who: null }
  const { user: account } = (await res.json()) as { user: { id: string } }
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { status: 200, who: { userId: account.id, headers: { cookie, origin: ORIGIN } } }
}

const accountExists = async (userId: string) =>
  (await db.select({ id: user.id }).from(user).where(eq(user.id, userId))).length === 1
const emailOf = async (u: User) => (await db.select().from(user).where(eq(user.id, u.userId)))[0]!.email

/** `owner` (an existing account) becomes the owner of a new approved partner without client workspaces. */
async function partnerOwnedBy(owner: User, name: string) {
  const ownerEmail = await emailOf(owner)
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  const id: string = created.body.data.partner.id
  await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: id }))
  await verify(owner)
  expect(await act(owner, 'partnerInvitation.accept', { token: tokenFor(ownerEmail) })).toMatchObject({ status: 200 })
  return id
}

async function createClient(p: Partner, name = 'Client Plumbing') {
  const res = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name })
  expect(res).toMatchObject({ status: 200, body: { ok: true } })
  return res.body.data.workspace.id as string
}

const partnerMembership = async (workspaceId: string, userId: string) =>
  (
    await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
  )[0]

let a: Partner
let b: Partner
let clientA: string
let clientB: string
let adminA: User

beforeAll(async () => {
  admin = await signUp()
  await verify(admin)
  a = await makePartner('Cascade IT Partners')
  b = await makePartner('Rival Agency')
  clientA = await createClient(a, 'Brightwater Plumbing')
  clientB = await createClient(b, 'Rival Client')
  adminA = await addPartnerAdmin(a)
})

describe('the partner and its team', () => {
  test('a server admin creates a partner pending, with its owner invited by email; approval makes it approved', async () => {
    const ownerEmail = newEmail('owner')
    const res = await asServerAdmin(admin, () => act(admin, 'partner.create', { name: 'New Partner', ownerEmail }))
    const [row] = await db.select().from(partners).where(eq(partners.id, res.body.data.partner.id))
    expect(row).toMatchObject({ status: 'pending', created_by: admin.userId, billing_account_id: null })
    const [inv] = await db.select().from(partner_invitations).where(eq(partner_invitations.partner_id, row!.id))
    expect(inv).toMatchObject({ email: ownerEmail, role: 'owner' })
    // Only the hash of the link's token is stored, and the command log keeps no token.
    const token = tokenFor(ownerEmail)!
    expect(inv!.token_hash).not.toBe(token)
    expect(sent.findLast(e => e.to === ownerEmail)?.subject).toContain('New Partner')
    await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: row!.id }))
    const [approved] = await db.select().from(partners).where(eq(partners.id, row!.id))
    expect(approved).toMatchObject({ status: 'approved', approved_by: admin.userId })
    expect(approved!.approved_at).toBeTruthy()
  })

  test('the owner sees the partner, its team, invitations and clients; an admin sees no invitations', async () => {
    const res = await act(a.owner, 'partner.get', { partnerId: a.id })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      partner: { id: a.id, name: a.name, status: 'approved' },
      role: 'owner',
      clients: [{ id: clientA, name: 'Brightwater Plumbing' }],
    })
    expect(res.body.data.members.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [a.owner.userId, adminA.userId].sort(),
    )
    const asAdmin = await act(adminA, 'partner.get', { partnerId: a.id })
    expect(asAdmin.body.data).toMatchObject({ role: 'admin', invitations: [] })
  })

  test('GET /v1/me lists the partners of the person, and only theirs', async () => {
    const me = await request(adminA, 'GET', '/v1/me')
    expect(me.body.partners).toEqual([{ id: a.id, name: a.name, status: 'approved', role: 'admin' }])
    expect(me.body.permissions).toContain('partner')
    const plain = await signUp()
    expect((await request(plain, 'GET', '/v1/me')).status).toBe(401)
  })

  test('every partner member is an admin of every client workspace, marked with the partner', async () => {
    for (const who of [a.owner, adminA]) {
      expect(await partnerMembership(clientA, who.userId)).toMatchObject({ role: 'admin', partnerId: a.id })
      expect(await partnerMembership(clientB, who.userId)).toBeUndefined()
    }
    const [org] = await db.select().from(organization).where(eq(organization.id, clientA))
    expect(org!.partnerId).toBe(a.id)
  })

  test('only the owner invites, removes, withdraws and renames', async () => {
    const forbidden = { status: 403, body: { code: 'forbidden' } }
    expect(await act(adminA, 'partnerMember.invite', { partnerId: a.id, email: newEmail() })).toMatchObject(forbidden)
    expect(await act(adminA, 'partnerMember.remove', { partnerId: a.id, userId: a.owner.userId })).toMatchObject(
      forbidden,
    )
    expect(await act(adminA, 'partner.update', { partnerId: a.id, name: 'Mine now' })).toMatchObject(forbidden)
    expect(await act(adminA, 'partnerMember.revokeInvite', { partnerId: a.id, invitationId: 'x' })).toMatchObject(
      forbidden,
    )
    expect(await act(a.owner, 'partner.update', { partnerId: a.id, name: 'Cascade IT' })).toMatchObject({ status: 200 })
    a.name = 'Cascade IT'
  })

  test('the owner is never removed; an invitation is refused twice and for a team member', async () => {
    expect(await act(a.owner, 'partnerMember.remove', { partnerId: a.id, userId: a.owner.userId })).toMatchObject({
      status: 409,
      body: { code: 'owner_stays' },
    })
    const [adminEmail] = await db.select({ email: user.email }).from(user).where(eq(user.id, adminA.userId))
    expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email: adminEmail!.email })).toMatchObject({
      status: 409,
      body: { code: 'already_member' },
    })
    const email = newEmail()
    expect((await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).status).toBe(200)
    expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).toMatchObject({
      status: 409,
      body: { code: 'already_invited' },
    })
    const [inv] = await db.select().from(partner_invitations).where(eq(partner_invitations.email, email))
    expect((await act(a.owner, 'partnerMember.revokeInvite', { partnerId: a.id, invitationId: inv!.id })).status).toBe(
      200,
    )
    // A withdrawn link joins nobody: without it the account has no partner access at all.
    const late = await signUp(email)
    await verify(late)
    expect(await act(late, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({
      status: 401,
      body: { code: 'no_workspace' },
    })
    // In a workspace of their own, the link is refused as withdrawn.
    const ws = await createWorkspace('Late Business')
    expect(await act(ws.owner, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({
      status: 409,
      body: { code: 'invitation_invalid' },
    })
  })

  test('disabling an account cancels the partner team invitations it sent (LIN-441)', async () => {
    const p = await makePartner('Disabled Inviter Partner')
    const email = newEmail()
    expect((await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email })).status).toBe(200)
    expect((await asServerAdmin(admin, () => act(admin, 'user.disable', { userId: p.owner.userId }))).status).toBe(200)
    const [inv] = await db.select().from(partner_invitations).where(eq(partner_invitations.email, email))
    expect(inv!.canceled_at).not.toBeNull()
    const invitee = await signUp(email)
    await verify(invitee)
    expect((await act(invitee, 'partnerInvitation.accept', { token: tokenFor(email)! })).status).not.toBe(200)
  })
})

describe('tenancy: nothing of another partner', () => {
  test('a member of one partner gets 403 on every action of another partner', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['partner.get', { partnerId: b.id }],
      ['partner.update', { partnerId: b.id, name: 'Taken over' }],
      ['partnerMember.invite', { partnerId: b.id, email: newEmail() }],
      ['partnerMember.revokeInvite', { partnerId: b.id, invitationId: 'pinv_x' }],
      ['partnerMember.remove', { partnerId: b.id, userId: b.owner.userId }],
      ['workspace.createForClient', { partnerId: b.id, name: 'Sneaky Client' }],
    ]
    for (const who of [a.owner, adminA])
      for (const [name, input] of calls)
        expect(await act(who, name, input), `${name}`).toMatchObject({ status: 403, body: { code: 'forbidden' } })
    // The same answer for a partner that does not exist: nothing tells which ids are real.
    expect(await act(a.owner, 'partner.get', { partnerId: 'ptn_missing' })).toMatchObject({ status: 403 })
    // Nothing changed at partner B.
    const [rowB] = await db.select().from(partners).where(eq(partners.id, b.id))
    expect(rowB!.name).toBe('Rival Agency')
    expect(await db.select().from(organization).where(eq(organization.name, 'Sneaky Client'))).toEqual([])
  })

  test("a partner member has no access to another partner's client workspace", async () => {
    // Asking for it by the workspace header: the session has no membership there.
    const res = await request(a.owner, 'GET', '/v1/me', undefined, { 'x-workspace-id': clientB })
    expect(res.body?.workspace?.id).not.toBe(clientB)
    expect(await partnerMembership(clientB, a.owner.userId)).toBeUndefined()
  })

  test('a workspace member or admin who is on no partner team has no partner permission', async () => {
    const ws = await createWorkspace('Plain Business')
    const wsAdmin = await addMember(ws.id, 'admin')
    for (const who of [ws.owner, wsAdmin]) {
      expect(await act(who, 'partner.get', { partnerId: a.id })).toMatchObject({ status: 403 })
      expect(await act(who, 'workspace.createForClient', { partnerId: a.id, name: 'X' })).toMatchObject({ status: 403 })
    }
  })

  test('the owner of a client workspace cannot run partner actions', async () => {
    // Any member of the client workspace who is not on the team (e.g. the business owner added later).
    const clientMember = await signUp()
    await verify(clientMember)
    await db.insert(member).values({
      id: crypto.randomUUID().replaceAll('-', ''),
      organizationId: clientA,
      userId: clientMember.userId,
      role: 'member',
      createdAt: new Date(),
    })
    expect(await act(clientMember, 'partner.get', { partnerId: a.id })).toMatchObject({ status: 403 })
  })

  test('partner actions with an API key are refused', async () => {
    const key = await act(adminA, 'apiKey.create', { name: 'Partner key', role: 'admin' })
    expect(key.status).toBe(200)
    const bearer = { headers: { authorization: `Bearer ${key.body.data.key}` } }
    expect(await act(bearer, 'partner.get', { partnerId: a.id })).toMatchObject({ status: 403 })
    await db
      .update(api_keys)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(api_keys.id, key.body.data.apiKeyId))
  })

  test('only instance admins list, create, approve and suspend partners', async () => {
    for (const [name, input] of [
      ['partner.adminList', {}],
      ['partner.create', { name: 'X', ownerEmail: newEmail() }],
      ['partner.approve', { partnerId: a.id }],
      ['partner.suspend', { partnerId: b.id }],
      ['partner.setClientLimit', { limit: 500 }],
    ] as const)
      expect(await act(a.owner, name, input), name).toMatchObject({ status: 403 })
    const listed = await asServerAdmin(admin, () => act(admin, 'partner.adminList', {}))
    const row = listed.body.data.partners.find((p: { id: string }) => p.id === a.id)
    expect(row).toMatchObject({ status: 'approved', members: 2, clients: 1, owner: { userId: a.owner.userId } })
  })

  test('an invitation link is accepted only by the address it was sent to, confirmed', async () => {
    const email = newEmail()
    await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })
    const token = tokenFor(email)!
    const stranger = await signUp()
    await verify(stranger)
    expect((await act(stranger, 'partnerInvitation.view', { token })).status).toBe(401)
    // An invitee with an unconfirmed address: refused until it is confirmed.
    const invitee = await signUp(email)
    expect(await act(invitee, 'partnerInvitation.view', { token })).toMatchObject({
      status: 200,
      body: { data: { partnerName: a.name, role: 'admin', state: 'open' } },
    })
    expect(await act(invitee, 'partnerInvitation.accept', { token })).toMatchObject({
      body: { code: 'email_unverified' },
    })
    // A team member of partner B with the link of partner A (forwarded to them): another address, refused.
    expect(await act(b.owner, 'partnerInvitation.view', { token })).toMatchObject({
      body: { data: { state: 'other_email' } },
    })
    expect(await act(b.owner, 'partnerInvitation.accept', { token })).toMatchObject({
      status: 409,
      body: { code: 'invitation_other_email' },
    })
    expect(await act(b.owner, 'partnerInvitation.accept', { token: 'x'.repeat(43) })).toMatchObject({
      body: { code: 'invitation_invalid' },
    })
  })
})

describe('client memberships follow the team', () => {
  test('a removed admin leaves every client workspace at once, their API keys there revoked', async () => {
    const p = await makePartner('Short Lived Partner')
    const c1 = await createClient(p, 'Client One')
    const c2 = await createClient(p, 'Client Two')
    const who = await addPartnerAdmin(p)
    expect(await partnerMembership(c1, who.userId)).toMatchObject({ partnerId: p.id })
    expect(await partnerMembership(c2, who.userId)).toMatchObject({ partnerId: p.id })
    // A key of theirs in the first client workspace (their first membership is the session's workspace).
    const key = await act(who, 'apiKey.create', { name: 'Zapier', role: 'member' })
    expect(key.status).toBe(200)
    expect(await act(p.owner, 'partnerMember.remove', { partnerId: p.id, userId: who.userId })).toMatchObject({
      status: 200,
      body: { data: { removedMemberships: 2 } },
    })
    expect(await partnerMembership(c1, who.userId)).toBeUndefined()
    expect(await partnerMembership(c2, who.userId)).toBeUndefined()
    const [row] = await db.select().from(api_keys).where(eq(api_keys.id, key.body.data.apiKeyId))
    expect(row!.revoked_at).toBeTruthy()
    expect(await act(who, 'partner.get', { partnerId: p.id })).toMatchObject({ status: 401 })
  })

  test('suspension removes the team from every client workspace and freezes the partner; approval brings them back', async () => {
    const p = await makePartner('Paused Partner')
    const c = await createClient(p, 'Paused Client')
    expect(await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: p.id }))).toMatchObject({
      status: 200,
      body: { data: { removedMemberships: 1 } },
    })
    expect(await partnerMembership(c, p.owner.userId)).toBeUndefined()
    expect(await act(p.owner, 'partner.get', { partnerId: p.id })).toMatchObject({
      status: 200,
      body: { data: { partner: { status: 'suspended' } } },
    })
    expect(await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'More' })).toMatchObject({
      status: 403,
    })
    expect(await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email: newEmail() })).toMatchObject({
      status: 403,
    })
    expect(await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: p.id }))).toMatchObject({
      status: 200,
      body: { data: { addedMemberships: 1 } },
    })
    expect(await partnerMembership(c, p.owner.userId)).toMatchObject({ role: 'admin', partnerId: p.id })
  })

  test('a pending partner sets up its team, and makes client workspaces only once approved', async () => {
    const p = await makePartner('Pending Partner', false)
    await addPartnerAdmin(p)
    expect(await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Too Early' })).toMatchObject({
      status: 409,
      body: { code: 'partner_pending' },
    })
    await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: p.id }))
    const c = await createClient(p, 'Pending Client')
    expect(await partnerMembership(c, p.owner.userId)).toMatchObject({ partnerId: p.id })
  })

  test('without billing, a partner makes at most the client workspaces the server admin allows', async () => {
    const listed = await asServerAdmin(admin, () => act(admin, 'partner.adminList', {}))
    expect(listed.body.data.clientLimit).toBe(25)
    const p = await makePartner('Limited Partner')
    await createClient(p, 'First Client')
    expect(await asServerAdmin(admin, () => act(admin, 'partner.setClientLimit', { limit: 2 }))).toMatchObject({
      status: 200,
    })
    try {
      await createClient(p, 'Second Client')
      expect(await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Third' })).toMatchObject({
        status: 409,
        body: { code: 'client_limit' },
      })
      expect((await asServerAdmin(admin, () => act(admin, 'partner.adminList', {}))).body.data.clientLimit).toBe(2)
      expect(await asServerAdmin(admin, () => act(admin, 'partner.setClientLimit', { limit: 0 }))).toMatchObject({
        status: 422,
      })
    } finally {
      await db.delete(instance_settings).where(eq(instance_settings.key, 'partners.client_limit'))
    }
  })

  test('a removed partner admin keeps no way back in: the invitations they sent end, and they never made admins', async () => {
    const p = await makePartner('Careful Partner')
    const c = await createClient(p, 'Careful Client')
    const who = await addPartnerAdmin(p)
    // Their session works in their only workspace, the client's.
    const second = newEmail('second')
    expect(await act(who, 'team.invite', { email: second, role: 'admin' })).toMatchObject({
      status: 409,
      body: { code: 'partner_admin_grant' },
    })
    expect(await act(who, 'team.invite', { email: second, role: 'member' })).toMatchObject({ status: 200 })
    const staff = await addMember(c, 'member')
    const staffRow = (await partnerMembership(c, staff.userId))!
    expect(await act(who, 'team.setRole', { memberId: staffRow.id, role: 'admin' })).toMatchObject({
      status: 409,
      body: { code: 'partner_admin_grant' },
    })
    expect(await act(p.owner, 'partnerMember.remove', { partnerId: p.id, userId: who.userId })).toMatchObject({
      status: 200,
      body: { data: { removedMemberships: 1, invitationsCanceled: 1 } },
    })
    const [sentByThem] = await db
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, c), eq(invitation.email, second)))
    expect(sentByThem!.status).toBe('canceled')
    // A workspace's own owner still makes admins as before.
    const businessOwner = await signUp()
    await verify(businessOwner)
    await asServerAdmin(admin, () =>
      act(admin, 'membership.add', { userId: businessOwner.userId, workspaceId: c, role: 'owner' }),
    )
    expect(await act(businessOwner, 'team.setRole', { memberId: staffRow.id, role: 'admin' })).toMatchObject({
      status: 200,
    })
  })

  test("a partner's membership is changed only on the partner, never in the client workspace", async () => {
    const p = await makePartner('Guarded Partner')
    const c = await createClient(p, 'Guarded Client')
    const who = await addPartnerAdmin(p)
    // The business owner of the client workspace, added by a server admin.
    const businessOwner = await signUp()
    await verify(businessOwner)
    await asServerAdmin(admin, () =>
      act(admin, 'membership.add', { userId: businessOwner.userId, workspaceId: c, role: 'owner' }),
    )
    const target = (await partnerMembership(c, who.userId))!
    const refused = { status: 409, body: { code: 'partner_managed' } }
    expect(await act(businessOwner, 'team.setRole', { memberId: target.id, role: 'member' })).toMatchObject(refused)
    expect(await act(businessOwner, 'team.removeMember', { memberId: target.id })).toMatchObject(refused)
    expect(await act(businessOwner, 'team.transferOwnership', { memberId: target.id })).toMatchObject(refused)
    expect(await act(who, 'team.leave', { deleteAccount: false })).toMatchObject(refused)
    expect(
      await asServerAdmin(admin, () => act(admin, 'membership.setRole', { memberId: target.id, role: 'member' })),
    ).toMatchObject(refused)
    expect(await asServerAdmin(admin, () => act(admin, 'membership.remove', { memberId: target.id }))).toMatchObject(
      refused,
    )
    expect(await partnerMembership(c, who.userId)).toMatchObject({ role: 'admin', partnerId: p.id })
  })

  test('the database refuses a partner membership that is not admin', async () => {
    const target = (await partnerMembership(clientA, adminA.userId))!
    await expect(db.update(member).set({ role: 'owner' }).where(eq(member.id, target.id))).rejects.toThrow()
  })

  test('where billing is on, a partner without a partner bill makes no client workspace (S2)', async () => {
    await db
      .insert(instance_settings)
      .values({ key: BILLING_ENABLED_KEY, value: 'on' })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: 'on' } })
    try {
      expect(await act(a.owner, 'workspace.createForClient', { partnerId: a.id, name: 'Billed Client' })).toMatchObject(
        {
          status: 409,
          body: { code: 'client_needs_bill' },
        },
      )
    } finally {
      await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY))
    }
  })
})

describe('accounts of a partner team', () => {
  test('a new address invited to a partner team signs up with an email code and joins', async () => {
    const email = newEmail('fresh')
    expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).toMatchObject({ status: 200 })
    const signedIn = await signInWithCode(email)
    expect(signedIn.status).toBe(200)
    const who = signedIn.who!
    expect(await accountExists(who.userId)).toBe(true)
    // In no workspace yet: the invitation is all it has.
    expect((await request(who, 'GET', '/v1/me')).body.partners).toEqual([])
    expect(await act(who, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
    expect(await partnerMembership(clientA, who.userId)).toMatchObject({ role: 'admin', partnerId: a.id })
    await act(a.owner, 'partnerMember.remove', { partnerId: a.id, userId: who.userId })
  })

  test('an account made for a partner invitation that ended unused goes with the sign-up sweep; an open one stays', async () => {
    const withdrawn = newEmail('withdrawn')
    const open = newEmail('open')
    for (const email of [withdrawn, open])
      expect(await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })).toMatchObject({ status: 200 })
    const gone = (await signInWithCode(withdrawn)).who!
    const kept = (await signInWithCode(open)).who!
    const [inv] = await db
      .select()
      .from(partner_invitations)
      .where(and(eq(partner_invitations.email, withdrawn), isNull(partner_invitations.canceled_at)))
    await act(a.owner, 'partnerMember.revokeInvite', { partnerId: a.id, invitationId: inv!.id })
    // Long after the accounts were made.
    // Loaded here: the handler registry has to be in place first (handlers.ts imports signup-handlers.ts).
    const { sweepSignUps } = await import('../src/signup-handlers.ts')
    await sweepSignUps(db, Date.now() + 365 * 86_400_000)
    expect(await accountExists(gone.userId)).toBe(false)
    expect(await accountExists(kept.userId)).toBe(true)
    // Team members without a workspace stay too.
    expect(await accountExists(a.owner.userId)).toBe(true)
  })

  test('no workspace removal or deletion deletes the account of someone on a partner team', async () => {
    const onTeam = async (userId: string) =>
      (await db.select().from(partner_members).where(eq(partner_members.user_id, userId))).length === 1

    // team.removeMember with deleteAccount: a member of the owner's business, and the owner of a partner.
    const business = await createWorkspace('Own Business One')
    const removed = await addMember(business.id, 'member')
    await partnerOwnedBy(removed, 'Removed Partner')
    const removedRow = (await partnerMembership(business.id, removed.userId))!
    const res = await act(business.owner, 'team.removeMember', { memberId: removedRow.id, deleteAccount: true })
    expect(res).toMatchObject({ status: 200 })
    expect(await accountExists(removed.userId)).toBe(true)
    expect(await onTeam(removed.userId)).toBe(true)

    // team.leave with deleteAccount.
    const second = await createWorkspace('Own Business Two')
    const leaving = await addMember(second.id, 'member')
    await partnerOwnedBy(leaving, 'Leaving Partner')
    expect(await act(leaving, 'team.leave', { deleteAccount: true })).toMatchObject({ status: 200 })
    expect(await accountExists(leaving.userId)).toBe(true)

    // Server admin's membership.remove.
    const third = await createWorkspace('Own Business Three')
    const byAdmin = await addMember(third.id, 'member')
    await partnerOwnedBy(byAdmin, 'Admin Removed Partner')
    const byAdminRow = (await partnerMembership(third.id, byAdmin.userId))!
    expect(
      await asServerAdmin(admin, () => act(admin, 'membership.remove', { memberId: byAdminRow.id })),
    ).toMatchObject({
      status: 200,
    })
    expect(await accountExists(byAdmin.userId)).toBe(true)

    // Server admin's workspace.delete of a client workspace (accounts not kept).
    const p = await makePartner('Deleted Client Partner')
    const c = await createClient(p, 'Deleted Client')
    expect(
      await asServerAdmin(admin, () => act(admin, 'workspace.delete', { workspaceId: c, name: 'Deleted Client' })),
    ).toMatchObject({ status: 200 })
    expect(await accountExists(p.owner.userId)).toBe(true)
    expect(await onTeam(p.owner.userId)).toBe(true)

    // workspace.deleteOwn by a business owner who is also a partner's owner.
    const fourth = await createWorkspace('Own Business Four')
    await partnerOwnedBy(fourth.owner, 'Owner Business Partner')
    expect(await act(fourth.owner, 'workspace.deleteOwn', { name: 'Own Business Four' })).toMatchObject({ status: 200 })
    expect(await accountExists(fourth.owner.userId)).toBe(true)
  })

  test("a partner's name keeps no control or bidi characters", async () => {
    const p = await makePartner('Plain Name Partner')
    expect(
      await act(p.owner, 'partner.update', { partnerId: p.id, name: 'Acme\u202E moc.lapyap\n\tIT' }),
    ).toMatchObject({ status: 200 })
    const [row] = await db.select().from(partners).where(eq(partners.id, p.id))
    expect(row!.name).toBe('Acme moc.lapyapIT')
    expect(await act(p.owner, 'partner.update', { partnerId: p.id, name: '\u202E\u2066' })).toMatchObject({
      status: 422,
    })
  })
})

describe('sign-up and audit', () => {
  test('an open partner invitation lets its address get an account; a withdrawn or suspended one does not', async () => {
    const email = newEmail()
    await act(a.owner, 'partnerMember.invite', { partnerId: a.id, email })
    expect(await mayCreateUser(db, email, true)).toBe(true)
    expect(await mayCreateUser(db, email, false)).toBe(false)
    const [inv] = await db
      .select()
      .from(partner_invitations)
      .where(and(eq(partner_invitations.email, email), isNull(partner_invitations.canceled_at)))
    await act(a.owner, 'partnerMember.revokeInvite', { partnerId: a.id, invitationId: inv!.id })
    expect(await mayCreateUser(db, email, true)).toBe(false)
  })

  test('partner changes are in the audit log under their own kind', async () => {
    const res = await asServerAdmin(admin, () => request(admin, 'GET', '/v1/admin/audit?kind=partners'))
    expect(res.status).toBe(200)
    const whats = new Set((res.body.entries ?? res.body.data?.entries ?? []).map((e: { what: string }) => e.what))
    for (const what of ['partner.create', 'partner.approve', 'partnerInvitation.accept', 'workspace.createForClient'])
      expect(whats.has(what), what).toBe(true)
    const logged = await db.select().from(commands).where(eq(commands.action, 'partnerInvitation.accept')).limit(5)
    for (const row of logged) expect(JSON.stringify(row.input)).not.toMatch(/"token":"[\w-]{20,}"/)
  })
})

// ---- Slice S2 (LIN-453): the partner bill, client owners, removing and releasing a partner ----

/** A partner with its partner bill in `status` (no Stripe subscription: seats follow nothing in these tests). */
async function billedPartner(name: string, status: (typeof billing_accounts.$inferSelect)['status'], approve = false) {
  const p = await makePartner(name, approve)
  const [bill] = await db
    .insert(billing_accounts)
    .values({ id: crypto.randomUUID(), kind: 'partner', owner_user_id: p.owner.userId, status, interval: 'month' })
    .returning()
  await db.update(partners).set({ billing_account_id: bill!.id }).where(eq(partners.id, p.id))
  return { ...p, billId: bill!.id }
}
const setBill = (id: string, status: (typeof billing_accounts.$inferSelect)['status']) =>
  db
    .update(billing_accounts)
    .set({ status, suspend_reason: status === 'suspended' ? 'admin' : null })
    .where(eq(billing_accounts.id, id))
const orgRow = async (id: string) => (await db.select().from(organization).where(eq(organization.id, id)))[0]!
/** `who`, working in `workspaceId` (their session switched there, as the workspace menu does). */
async function inWorkspace(who: User, workspaceId: string): Promise<User> {
  await db.update(session).set({ activeOrganizationId: workspaceId }).where(eq(session.userId, who.userId))
  return { ...who, headers: { ...who.headers, 'x-workspace-id': workspaceId } }
}

/** Someone with a workspace of their own (an account in no workspace accepts through Better Auth's own page). */
async function personElsewhere(name: string) {
  const { owner } = await createWorkspace(name)
  await verify(owner)
  return { who: owner, email: await emailOf(owner) }
}

/** The client's own owner: invited by the partner's owner, joined. */
async function giveOwner(p: Partner, workspaceId: string) {
  const { who, email } = await personElsewhere('Client Owner Home')
  expect(await act(p.owner, 'workspace.inviteClientOwner', { partnerId: p.id, workspaceId, email })).toMatchObject({
    status: 200,
  })
  const [invite] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.email, email)))
  expect(invite).toMatchObject({ role: 'owner', status: 'pending' })
  expect(await act(who, 'invitation.accept', { invitationId: invite!.id })).toMatchObject({ status: 200 })
  expect(await partnerMembership(workspaceId, who.userId)).toMatchObject({ role: 'owner', partnerId: null })
  return who
}

describe('the partner bill (S2)', () => {
  beforeAll(async () => {
    await db
      .insert(instance_settings)
      .values({ key: BILLING_ENABLED_KEY, value: 'on' })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: 'on' } })
  })
  afterAll(async () => {
    await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY))
  })

  test('client workspaces go on the running partner bill, also before approval; the trial takes at most its clients', async () => {
    const p = await billedPartner('Trial Partner', 'trialing')
    const first = await createClient(p, 'First Client')
    expect(await orgRow(first)).toMatchObject({ partnerId: p.id, billingAccountId: p.billId, billingState: 'active' })
    await createClient(p, 'Second Client')
    expect(await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Third' })).toMatchObject({
      status: 409,
      body: { code: 'trial_client_limit' },
    })
    expect((await act(p.owner, 'partner.get', { partnerId: p.id })).body.data.bill).toEqual({
      status: 'trialing',
      trialClientLimit: 2,
      mine: true,
    })
    await setBill(p.billId, 'active')
    await createClient(p, 'Third Client')
    const admin = await addPartnerAdmin(p)
    // An admin of the team makes client workspaces too; the bill is not theirs.
    expect(await act(admin, 'workspace.createForClient', { partnerId: p.id, name: 'Fourth' })).toMatchObject({
      status: 200,
    })
    expect((await act(admin, 'partner.get', { partnerId: p.id })).body.data.bill).toMatchObject({ mine: false })
  })

  test('no client workspace before Checkout, nor on a bill that does not run', async () => {
    const p = await billedPartner('Waiting Partner', 'pending_payment', true)
    const create = () => act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Nope' })
    expect(await create()).toMatchObject({ status: 409, body: { code: 'bill_not_started' } })
    for (const status of ['suspended', 'canceled'] as const) {
      await setBill(p.billId, status)
      expect(await create()).toMatchObject({ status: 409, body: { code: 'bill_inactive' } })
    }
    expect(await db.select().from(organization).where(eq(organization.partnerId, p.id))).toEqual([])
  })

  test("the partner's owner reads the partner bill by partnerId; an admin and another partner get 403", async () => {
    const p = await billedPartner('Bill Reader', 'trialing')
    const admin = await addPartnerAdmin(p)
    const extra = (name: string) => (name === 'billing.setExtraCalls' ? { workspaceId: 'ws_x', extraCalls: 5 } : {})
    expect(await act(p.owner, 'billing.state', { partnerId: p.id })).toMatchObject({ status: 200 })
    // Without Stripe keys there is no bill page to show; the owner is still let in (billing-checkout.test.ts reads it).
    expect(await act(p.owner, 'billing.overview', { partnerId: p.id })).toMatchObject({ status: 200 })
    for (const who of [admin, b.owner, a.owner])
      for (const name of [
        'billing.state',
        'billing.overview',
        'billing.openPortal',
        'billing.cancel',
        'billing.setExtraCalls',
      ])
        expect((await act(who, name, { partnerId: p.id, ...extra(name) })).status, `${name}`).toBe(403)
  })

  test("only the partner's owner invites a client's owner: never someone on the team, never another partner's client", async () => {
    const p = await billedPartner('Owner Inviter', 'active')
    const c = await createClient(p, 'Owned Client')
    const admin = await addPartnerAdmin(p)
    const invite = (who: User, input: Record<string, unknown>) =>
      act(who, 'workspace.inviteClientOwner', { partnerId: p.id, workspaceId: c, ...input })
    expect((await invite(admin, { email: newEmail('x') })).status).toBe(403)
    expect(
      (await act(admin, 'workspace.createForClient', { partnerId: p.id, name: 'X', ownerEmail: newEmail('x') })).status,
    ).toBe(403)
    expect(await invite(p.owner, { email: await emailOf(admin) })).toMatchObject({
      status: 409,
      body: { code: 'owner_on_team' },
    })
    expect(await invite(p.owner, { workspaceId: clientB, email: newEmail('x') })).toMatchObject({
      status: 409,
      body: { code: 'client_not_found' },
    })
    expect(
      (await act(b.owner, 'workspace.inviteClientOwner', { partnerId: p.id, workspaceId: c, email: newEmail('x') }))
        .status,
    ).toBe(403)
    const owner = await giveOwner(p, c)
    expect(await invite(p.owner, { email: newEmail('second') })).toMatchObject({
      status: 409,
      body: { code: 'client_has_owner' },
    })
    const client = (await act(p.owner, 'partner.get', { partnerId: p.id })).body.data.clients.find(
      (x: { id: string }) => x.id === c,
    )
    expect(client.owner).toEqual({ name: 'Test User', email: await emailOf(owner) })
    // The client's team page shows who is there through the partner.
    const team = await act(await inWorkspace(owner, c), 'team.list', {})
    expect(team.body.data.members.find((m: { userId: string }) => m.userId === admin.userId)).toMatchObject({
      partner: 'Owner Inviter',
    })
    expect(team.body.data.members.find((m: { userId: string }) => m.userId === owner.userId).partner).toBeNull()
  })

  test("the partner's owner sees every member of a client who is not on the team, with who invited them (N-1)", async () => {
    const p = await billedPartner('Watchful Partner', 'active')
    const c = await createClient(p, 'Watched Client')
    const owner = await giveOwner(p, c)
    const { who, email: staff } = await personElsewhere('Staff Home')
    expect(await act(await inWorkspace(owner, c), 'team.invite', { email: staff, role: 'admin' })).toMatchObject({
      status: 200,
    })
    const [sent] = await db
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, c), eq(invitation.email, staff)))
    expect(await act(who, 'invitation.accept', { invitationId: sent!.id })).toMatchObject({ status: 200 })
    const others = (await act(p.owner, 'partner.get', { partnerId: p.id })).body.data.clients[0].otherMembers
    expect(others).toEqual([
      { name: 'Test User', email: await emailOf(owner), role: 'owner', invitedBy: 'Test User' },
      { name: 'Test User', email: staff, role: 'admin', invitedBy: 'Test User' },
    ])
    const admin = await addPartnerAdmin(p)
    expect((await act(admin, 'partner.get', { partnerId: p.id })).body.data.clients[0].otherMembers).toEqual([])
  })

  test("releasing a client: the partner's owner hands it over, the team leaves, it moves to a bill of its owner", async () => {
    const p = await billedPartner('Releasing Partner', 'active')
    const c = await createClient(p, 'Leaving Client')
    const admin = await addPartnerAdmin(p)
    const release = (who: User, input: Record<string, unknown> = {}) =>
      act(who, 'partner.releaseClient', { partnerId: p.id, workspaceId: c, confirmName: 'Leaving Client', ...input })
    expect(await release(p.owner)).toMatchObject({ status: 409, body: { code: 'client_no_owner' } })
    const owner = await giveOwner(p, c)
    expect((await release(admin)).status).toBe(403)
    expect(
      (await act(b.owner, 'partner.releaseClient', { partnerId: p.id, workspaceId: c, confirmName: 'x' })).status,
    ).toBe(403)
    expect(await release(p.owner, { confirmName: 'Other Name' })).toMatchObject({
      status: 409,
      body: { code: 'confirm_mismatch' },
    })
    expect(await release(p.owner, { workspaceId: clientB })).toMatchObject({
      status: 409,
      body: { code: 'client_not_found' },
    })
    const key = await act(await inWorkspace(admin, c), 'apiKey.create', { name: 'Agency key', role: 'member' })
    expect(key.status).toBe(200)
    const done = await release(p.owner, { confirmName: '  leaving client ' })
    expect(done).toMatchObject({ status: 200, body: { data: { removedMemberships: 2 } } })
    const org = await orgRow(c)
    expect(org).toMatchObject({ partnerId: null, billingState: 'pending_payment' })
    expect(org.billingAccountId).not.toBe(p.billId)
    const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, org.billingAccountId!))
    expect(bill).toMatchObject({ kind: 'cloud', status: 'pending_payment', owner_user_id: owner.userId })
    expect(await partnerMembership(c, admin.userId)).toBeUndefined()
    expect(await partnerMembership(c, p.owner.userId)).toBeUndefined()
    const [row] = await db.select().from(api_keys).where(eq(api_keys.id, key.body.data.apiKeyId))
    expect(row!.revoked_at).toBeTruthy()
    expect((await act(p.owner, 'partner.get', { partnerId: p.id })).body.data.clients).toEqual([])
    // The released workspace waits for its owner's card: the sign-up sweep never takes it (it is older than the bill).
    await db
      .update(organization)
      .set({ createdAt: new Date(Date.now() - 60 * 86_400_000) })
      .where(eq(organization.id, c))
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() })
      .where(eq(billing_accounts.id, bill!.id))
    const { sweepSignUps } = await import('../src/signup-handlers.ts')
    await sweepSignUps(db)
    expect(await orgRow(c)).toMatchObject({ id: c })
  })

  test("removing the partner: only the client's owner, with the name typed; the team leaves and the owner pays", async () => {
    const p = await billedPartner('Removed Partner', 'active')
    const c = await createClient(p, 'Independent Client')
    const owner = await giveOwner(p, c)
    const admin = await addPartnerAdmin(p)
    // The partner's team are admins in the workspace, never its owner.
    expect(
      (await act(await inWorkspace(admin, c), 'workspace.removePartner', { confirmName: 'Independent Client' })).status,
    ).toBe(403)
    expect(
      (await act(await inWorkspace(p.owner, c), 'workspace.removePartner', { confirmName: 'Independent Client' }))
        .status,
    ).toBe(403)
    expect(await act(await inWorkspace(owner, c), 'workspace.removePartner', { confirmName: 'Other' })).toMatchObject({
      status: 409,
      body: { code: 'confirm_mismatch' },
    })
    expect(
      await act(await inWorkspace(owner, c), 'workspace.removePartner', { confirmName: 'Independent Client' }),
    ).toMatchObject({ status: 200, body: { data: { removedMemberships: 2 } } })
    const org = await orgRow(c)
    expect(org).toMatchObject({ partnerId: null, billingState: 'pending_payment' })
    const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, org.billingAccountId!))
    expect(bill).toMatchObject({ kind: 'cloud', owner_user_id: owner.userId })
    expect(await partnerMembership(c, admin.userId)).toBeUndefined()
    expect(
      await act(await inWorkspace(owner, c), 'workspace.removePartner', { confirmName: 'Independent Client' }),
    ).toMatchObject({
      status: 409,
      body: { code: 'no_partner' },
    })
  })

  test('a client workspace never leaves its partner bill through Server admin, and a partner bill is not handed over', async () => {
    const p = await billedPartner('Fixed Partner', 'active')
    const c = await createClient(p, 'Fixed Client')
    const other = await createWorkspace('Plain Business')
    const [plain] = await db
      .insert(billing_accounts)
      .values({ id: crypto.randomUUID(), kind: 'cloud', owner_user_id: other.owner.userId, status: 'active' })
      .returning()
    await db.update(organization).set({ billingAccountId: plain!.id }).where(eq(organization.id, other.id))
    const move = (workspaceId: string, toBillingAccountId: string) =>
      asServerAdmin(admin, () =>
        act(admin, 'billing.moveWorkspace', {
          workspaceId,
          toBillingAccountId,
          reason: 'support request',
          requestId: crypto.randomUUID(),
        }),
      )
    expect((await move(c, plain!.id)).status).toBe(409)
    expect((await move(other.id, p.billId)).status).toBe(409)
    expect(await orgRow(c)).toMatchObject({ billingAccountId: p.billId })
    expect(await orgRow(other.id)).toMatchObject({ billingAccountId: plain!.id })
    const teamAdmin = await addPartnerAdmin(p)
    const transfer = await asServerAdmin(admin, () =>
      act(admin, 'billing.transferOwner', { billingAccountId: p.billId, userId: teamAdmin.userId, reason: 'asked' }),
    )
    expect(transfer.status).toBe(409)
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, p.billId)))[0]).toMatchObject({
      owner_user_id: p.owner.userId,
    })
  })

  test('a partner owner manages billing only in a client workspace on their bill, never elsewhere (review of #1109, M-1)', async () => {
    const p = await billedPartner('Scoped Billing', 'active')
    const client = await createClient(p, 'Scoped Client')
    const perms = async (who: User) => (await request(who, 'GET', '/v1/me')).body.permissions as string[]
    expect(await perms(await inWorkspace(p.owner, client))).toContain('billing:manage')
    // A plain member of another workspace who signed up as a partner (no Checkout yet).
    const w = await createWorkspace('Plain Business')
    const plain = await inWorkspace(await addMember(w.id, 'member'), w.id)
    const [bill] = await db
      .insert(billing_accounts)
      .values({ id: crypto.randomUUID(), kind: 'partner', owner_user_id: plain.userId, status: 'pending_payment' })
      .returning()
    const partnerId = `ptn_${crypto.randomUUID()}`
    await db
      .insert(partners)
      .values({ id: partnerId, name: 'Self Made', billing_account_id: bill!.id, created_by: plain.userId })
    await db.insert(partner_members).values({ partner_id: partnerId, user_id: plain.userId, role: 'owner' })
    expect(await perms(plain)).toContain('partner')
    expect(await perms(plain)).not.toContain('billing:manage')
    for (const name of ['workspace.setAllowPremium', 'workspace.setAllowUltra'])
      expect((await act(plain, name, { on: false })).status, name).toBe(403)
    // Their own partner bill still answers them by partnerId, from a workspace that is not on it.
    expect((await act(plain, 'billing.state', { partnerId })).status).toBe(200)
    // A disabled workspace is read only: nobody switches them, not even its owner.
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, w.id))
    expect(await perms(plain)).not.toContain('billing:manage')
    for (const name of ['workspace.setAllowPremium', 'workspace.setAllowUltra']) {
      expect((await act(plain, name, { on: false })).status, name).toBe(403)
      expect((await act(w.owner, name, { on: false })).status, name).not.toBe(200)
    }
    await db.update(organization).set({ disabledAt: null }).where(eq(organization.id, w.id))
    expect((await act(w.owner, 'workspace.setAllowPremium', { on: false })).status).toBe(200)
  })

  test("someone who owns one of the partner's clients never joins its team (review of #1109, L-3)", async () => {
    const p = await billedPartner('No Double Role', 'active')
    const owned = await createClient(p, 'Owned Client')
    const clientOwner = await giveOwner(p, owned)
    expect(
      await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email: await emailOf(clientOwner) }),
    ).toMatchObject({
      status: 409,
      body: { code: 'client_owner' },
    })
    // Invited to the team first, then invited as a client's owner: the team invitation is refused at accept.
    const later = await personElsewhere('Later Owner')
    expect((await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email: later.email })).status).toBe(200)
    const second = await createClient(p, 'Second Client')
    expect(
      (await act(p.owner, 'workspace.inviteClientOwner', { partnerId: p.id, workspaceId: second, email: later.email }))
        .status,
    ).toBe(200)
    expect(await act(later.who, 'partnerInvitation.accept', { token: tokenFor(later.email) })).toMatchObject({
      status: 409,
      body: { code: 'client_owner' },
    })
  })

  test("the client's Team answers its partner also while the partner is suspended (review of #1109, L-5)", async () => {
    const p = await billedPartner('Suspended Later', 'active', true)
    const c = await createClient(p, 'Kept Client')
    const clientOwner = await inWorkspace(await giveOwner(p, c), c)
    expect((await act(clientOwner, 'team.list', {})).body.data.partner).toBe('Suspended Later')
    expect((await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: p.id }))).status).toBe(200)
    const team = (await act(clientOwner, 'team.list', {})).body.data
    expect(team.members.some((m: { partner?: string | null }) => m.partner)).toBe(false)
    expect(team.partner).toBe('Suspended Later')
  })
})

// ---- Slice S3 (LIN-454): Partner › Clients, the monthly usage limit, Allow Premium and Ultra; review of #1109 ----

const DAY_MS = 86_400_000
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** The partner bill's period around now. */
async function periodOf(billId: string) {
  const id = rid('bp')
  await db.insert(billing_periods).values({
    id,
    billing_account_id: billId,
    starts_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    ends_at: new Date(Date.now() + 20 * DAY_MS).toISOString(),
    kind: 'month',
  })
  return id
}

/** A ledger entry for one client, as a call (`usage`) or an extra number (`number`) would post it. */
const post = (
  billId: string,
  periodId: string,
  workspaceId: string,
  kind: 'usage' | 'number',
  micros: number,
  seconds = 0,
) =>
  db.transaction(tx =>
    postEntry(tx, {
      billing_account_id: billId,
      workspace_id: workspaceId,
      period_id: periodId,
      kind,
      amount_micros: -micros,
      ...(kind === 'usage'
        ? { seconds, included_seconds: 0, billable_seconds: seconds, price_basis: 'standard' as const }
        : {}),
      source_type: kind === 'usage' ? 'call' : 'phone_number',
      source_id: kind === 'number' ? `${rid('pn')}:${periodId}` : rid('src'),
    }),
  )

/** Someone a member of the workspace invited as `role`, joined. */
async function invitedBy(inviter: User, workspaceId: string, role: 'admin' | 'member' = 'member') {
  const { who, email } = await personElsewhere('Invited Home')
  expect(await act(await inWorkspace(inviter, workspaceId), 'team.invite', { email, role })).toMatchObject({
    status: 200,
  })
  const [sent] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.email, email)))
  expect(await act(who, 'invitation.accept', { invitationId: sent!.id })).toMatchObject({ status: 200 })
  return who
}

describe('Partner › Clients (S3)', () => {
  beforeAll(async () => {
    await db
      .insert(instance_settings)
      .values({ key: BILLING_ENABLED_KEY, value: 'on' })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: 'on' } })
  })
  afterAll(async () => {
    await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY))
  })

  test('the list: only its own clients, problems first, minutes and cost as the ledger has them, never call content', async () => {
    const p = await billedPartner('Listing Partner', 'active', true)
    const periodId = await periodOf(p.billId)
    const quiet = await createClient(p, 'Alpha Quiet')
    const busy = await createClient(p, 'Zeta Busy')
    await db.insert(phone_numbers).values({
      id: rid('pn'),
      workspace_id: quiet,
      e164: '+15035550111',
      provider: 'dev',
      mode: 'new',
      created_at: new Date().toISOString(),
    })
    await db
      .insert(phone_numbers)
      .values({ id: rid('pn'), workspace_id: busy, e164: '+15035550112', provider: 'dev', mode: 'new' })
    await post(p.billId, periodId, busy, 'usage', 6_000_000, 610)
    await post(p.billId, periodId, busy, 'usage', 1_500_000, 125)
    await post(p.billId, periodId, busy, 'number', 2_000_000)
    // Another workspace's use on another bill never counts.
    await post(p.billId, periodId, clientB, 'usage', 9_000_000, 900)
    await db.update(organization).set({ usageLimitCents: 1000 }).where(eq(organization.id, busy))

    const res = await act(p.owner, 'partner.listClients', { partnerId: p.id })
    expect(res.status).toBe(200)
    const { period, clients } = res.body.data
    expect(period).toMatchObject({ startsAt: expect.any(String), endsAt: expect.any(String) })
    expect(clients.map((c: { name: string }) => c.name)).toEqual(['Zeta Busy', 'Alpha Quiet'])
    const [first, second] = clients
    expect(first).toEqual({
      id: busy,
      name: 'Zeta Busy',
      owner: null,
      number: '+15035550112',
      numbers: 1,
      forwarding: 'not_needed',
      lastRealCallAt: null,
      calls: 0,
      seconds: 735,
      costCents: 950,
      limitCents: 1000,
      limitPercent: 95,
      allowPremium: false,
      allowUltra: false,
      billed: true,
      problems: ['limit_near'],
    })
    expect(second).toMatchObject({ id: quiet, seconds: 0, costCents: 0, limitCents: null, problems: [] })
    // Over the limit it is the first problem; a client without a number has one too.
    await post(p.billId, periodId, busy, 'usage', 600_000, 60)
    const empty = await createClient(p, 'Beta Empty')
    const after = (await act(p.owner, 'partner.listClients', { partnerId: p.id })).body.data.clients
    expect(after.map((c: { id: string; problems: string[] }) => [c.id, c.problems])).toEqual([
      [busy, ['limit_reached']],
      [empty, ['no_number']],
      [quiet, []],
    ])
    // An admin of the team reads it too.
    const padmin = await addPartnerAdmin(p)
    expect((await act(padmin, 'partner.listClients', { partnerId: p.id })).status).toBe(200)
  })

  test('the list is refused to another partner, a client member, its owner, and an API key', async () => {
    const p = await billedPartner('Private List', 'active', true)
    const c = await createClient(p, 'Hidden Client')
    const owner = await giveOwner(p, c)
    expect((await act(b.owner, 'partner.listClients', { partnerId: p.id })).status).toBe(403)
    expect((await act(adminA, 'partner.listClients', { partnerId: p.id })).status).toBe(403)
    expect((await act(await inWorkspace(owner, c), 'partner.listClients', { partnerId: p.id })).status).toBe(403)
    const key = await act(await inWorkspace(p.owner, c), 'apiKey.create', { name: 'Client key', role: 'admin' })
    const bearer = { headers: { authorization: `Bearer ${key.body.data.key}` } }
    expect((await act(bearer, 'partner.listClients', { partnerId: p.id })).status).toBe(403)
  })

  test('the team sets a usage limit on a billed client; never another partner, never a client off the bill', async () => {
    const p = await billedPartner('Limit Setter', 'active', true)
    const periodId = await periodOf(p.billId)
    const c = await createClient(p, 'Limited Client')
    const padmin = await addPartnerAdmin(p)
    const set = (who: User, limitUsd: number | null, workspaceId = c, partnerId = p.id) =>
      act(who, 'partner.setClientUsageLimit', { partnerId, workspaceId, limitUsd })
    // An admin sets one where there is none and lowers it; raising or removing it is the owner's (#1113, L-1).
    expect(await set(padmin, 25)).toMatchObject({ status: 200 })
    expect(await orgRow(c)).toMatchObject({ usageLimitCents: 2500 })
    expect(await set(padmin, 12.5)).toMatchObject({ status: 200 })
    expect(await orgRow(c)).toMatchObject({ usageLimitCents: 1250 })
    expect((await set(padmin, 20)).status).toBe(403)
    expect((await set(padmin, null)).status).toBe(403)
    expect(await orgRow(c)).toMatchObject({ usageLimitCents: 1250 })
    expect(await set(p.owner, 20)).toMatchObject({ status: 200 })
    expect(await set(padmin, 12.5)).toMatchObject({ status: 200 })
    expect((await set(b.owner, 5)).status).toBe(403)
    expect((await set(p.owner, 5, clientB)).body).toMatchObject({ code: 'client_not_found' })
    expect((await set(p.owner, 0.5)).status).toBe(422)
    // A client of a partner without a partner bill has nothing to measure on.
    expect(await set(a.owner, 5, clientA, a.id)).toMatchObject({ status: 409, body: { code: 'client_not_billed' } })
    // A limit below what was used this period marks the 80 % and 100 % emails for it at once (sent by a job).
    await post(p.billId, periodId, c, 'usage', 9_000_000, 600)
    expect(await set(padmin, 10)).toMatchObject({ status: 200 })
    const marks = async () =>
      (await db.select().from(usage_limit_alerts).where(eq(usage_limit_alerts.workspace_id, c)))
        .map(m => m.level)
        .sort()
    expect(await marks()).toEqual([80])
    const sentAt = (await db.select().from(usage_limit_alerts).where(eq(usage_limit_alerts.workspace_id, c)))[0]!
      .created_at
    // Saving it again, or changing it, never sends an email of this period twice (#1113, I-3).
    expect(await set(p.owner, 10)).toMatchObject({ status: 200 })
    expect(await set(p.owner, 50)).toMatchObject({ status: 200 })
    expect(await set(p.owner, 10)).toMatchObject({ status: 200 })
    const again = await db.select().from(usage_limit_alerts).where(eq(usage_limit_alerts.workspace_id, c))
    expect(again.map(m => [m.level, m.created_at])).toEqual([[80, sentAt]])
    expect(await set(p.owner, null)).toMatchObject({ status: 200 })
    expect(await orgRow(c)).toMatchObject({ usageLimitCents: null })
  })

  test("only the partner's owner switches Allow Premium and Ultra in a client; the client's owner and the team cannot (LIN-440)", async () => {
    const p = await billedPartner('Level Partner', 'active', true)
    const c = await createClient(p, 'Level Client')
    const owner = await inWorkspace(await giveOwner(p, c), c)
    const padmin = await addPartnerAdmin(p)
    const allow = (who: User, level: 'premium' | 'ultra', on: boolean) =>
      act(who, 'partner.setClientAllow', { partnerId: p.id, workspaceId: c, level, on })
    expect((await allow(padmin, 'premium', true)).status).toBe(403)
    expect((await allow(b.owner, 'premium', true)).status).toBe(403)
    expect(await allow(p.owner, 'premium', true)).toMatchObject({ status: 200 })
    expect(await allow(p.owner, 'ultra', true)).toMatchObject({ status: 200 })
    const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, c))
    expect(row).toMatchObject({ allow_premium: true, allow_ultra: true })
    // In the client workspace itself only the partner's owner switches them, never the client's owner.
    expect((await act(owner, 'workspace.setAllowPremium', { on: false })).status).toBe(403)
    expect((await act(owner, 'workspace.setAllowUltra', { on: false })).status).toBe(403)
    expect((await act(await inWorkspace(padmin, c), 'workspace.setAllowPremium', { on: false })).status).toBe(403)
    expect((await act(await inWorkspace(p.owner, c), 'workspace.setAllowUltra', { on: false })).status).toBe(200)
    // The client's people see no prices: the partner bills them its own way (L-2).
    const settings = (await act(owner, 'workspace.getSettings', {})).body.data
    expect(settings.partnerManaged).toBe(true)
    expect(settings).not.toHaveProperty('usageCentsPerMinute')
    const me = (await request(owner, 'GET', '/v1/me')).body
    expect(me.workspace).toMatchObject({ partnerManaged: true })
    const options = await act(owner, 'voice.options', {})
    expect(options.body.data.levels).toMatchObject({ partnerManaged: true })
  })

  test("people the team invited into a client stay on release unless picked; owners, former owners and the client's own never offered (#1113, M-1)", async () => {
    const p = await billedPartner('Inviting Partner', 'active', true)
    const c = await createClient(p, 'Invited Client')
    // The client's first owner, invited by the partner's owner, later hands ownership to a colleague they invited.
    const first = await inWorkspace(await giveOwner(p, c), c)
    const colleague = await invitedBy(first, c)
    expect(
      await act(first, 'team.transferOwnership', { memberId: (await partnerMembership(c, colleague.userId))!.id }),
    ).toMatchObject({ status: 200 })
    expect(await partnerMembership(c, first.userId)).toMatchObject({ role: 'admin' })
    const padmin = await addPartnerAdmin(p)
    const staff = await invitedBy(padmin, c)
    const helper = await invitedBy(p.owner, c)
    const memberId = async (u: User) => (await partnerMembership(c, u.userId))!.id
    // Only the people the team invited are offered: never the former owner, the owner, or whom the owner invited.
    const listed = (await act(p.owner, 'partner.get', { partnerId: p.id })).body.data.clients.find(
      (x: { id: string }) => x.id === c,
    )
    expect(listed.invitedByTeam.map((m: { memberId: string }) => m.memberId).sort()).toEqual(
      [await memberId(staff), await memberId(helper)].sort(),
    )
    const team = (await act(await inWorkspace(colleague, c), 'team.list', {})).body.data.members
    const flagged = team
      .filter((m: { invitedByPartner?: boolean }) => m.invitedByPartner)
      .map((m: { userId: string }) => m.userId)
    expect(flagged.sort()).toEqual([staff.userId, helper.userId].sort())
    const release = (removeMemberIds?: string[]) =>
      act(p.owner, 'partner.releaseClient', {
        partnerId: p.id,
        workspaceId: c,
        confirmName: 'Invited Client',
        ...(removeMemberIds ? { removeMemberIds } : {}),
      })
    // Ids that are not someone the team invited are refused, and nothing changes.
    for (const id of [await memberId(first), await memberId(colleague), 'mem_nobody'])
      expect(await release([id])).toMatchObject({ status: 409, body: { code: 'member_not_invited' } })
    expect(await orgRow(c)).toMatchObject({ partnerId: p.id })
    // Only the one picked leaves; the audit entry names the address.
    const done = await release([await memberId(staff)])
    expect(done).toMatchObject({
      status: 200,
      body: { data: { removedInvited: 1, removedPeople: [await emailOf(staff)] } },
    })
    expect(await partnerMembership(c, staff.userId)).toBeUndefined()
    for (const u of [helper, first]) expect(await partnerMembership(c, u.userId)).toBeTruthy()
    expect(await partnerMembership(c, colleague.userId)).toMatchObject({ role: 'owner' })
    const { entries } = await listAudit(db, { kind: 'partners', workspaceId: c, limit: 50 })
    const entry = entries.find(e => e.what === 'partner.releaseClient' && !e.refused)
    expect(entry?.removedPeople).toEqual([await emailOf(staff)])
  })

  test('by default a release or a partner removal takes nobody the team invited (#1113, M-1)', async () => {
    const p = await billedPartner('Default Keeper', 'active', true)
    const c = await createClient(p, 'Kept People')
    const owner = await inWorkspace(await giveOwner(p, c), c)
    const staff = await invitedBy(p.owner, c)
    expect(
      await act(p.owner, 'partner.releaseClient', { partnerId: p.id, workspaceId: c, confirmName: 'Kept People' }),
    ).toMatchObject({ status: 200, body: { data: { removedInvited: 0, removedPeople: [] } } })
    expect(await partnerMembership(c, staff.userId)).toMatchObject({ role: 'member' })
    // Removing a partner: the same, and the owner's pick is the only one that leaves.
    const q = await billedPartner('Removed Inviter', 'active', true)
    const d = await createClient(q, 'Freed Client')
    const owner2 = await inWorkspace(await giveOwner(q, d), d)
    const one = await invitedBy(q.owner, d)
    const two = await invitedBy(q.owner, d)
    // Someone the team invited who held the ownership for a while is a former owner: never removed this way.
    const oneId = (await partnerMembership(d, one.userId))!.id
    expect(await act(owner2, 'team.transferOwnership', { memberId: oneId })).toMatchObject({ status: 200 })
    const ownerId = (await partnerMembership(d, owner2.userId))!.id
    expect(await act(await inWorkspace(one, d), 'team.transferOwnership', { memberId: ownerId })).toMatchObject({
      status: 200,
    })
    expect(
      await act(owner2, 'workspace.removePartner', { confirmName: 'Freed Client', removeMemberIds: [oneId] }),
    ).toMatchObject({ status: 409, body: { code: 'member_not_invited' } })
    const removed = await act(owner2, 'workspace.removePartner', {
      confirmName: 'Freed Client',
      removeMemberIds: [(await partnerMembership(d, two.userId))!.id],
    })
    expect(removed).toMatchObject({
      status: 200,
      body: { data: { removedInvited: 1, removedPeople: [await emailOf(two)] } },
    })
    expect(await partnerMembership(d, one.userId)).toBeTruthy()
    expect(await partnerMembership(d, two.userId)).toBeUndefined()
    expect(owner).toBeTruthy()
  })

  test('a release waiting on the extra-calls lock holds no lock on the balance (review of #1109, L-6)', async () => {
    const p = await billedPartner('Lock Order', 'active', true)
    const c = await createClient(p, 'Locked Client')
    await giveOwner(p, c)
    await db.insert(billing_balances).values({ billing_account_id: p.billId }).onConflictDoNothing()
    let letGo!: () => void
    let held!: () => void
    const isHeld = new Promise<void>(resolve => {
      held = resolve
    })
    const holder = db.transaction(async tx => {
      await lockExtraCalls(tx, p.billId)
      held()
      await new Promise<void>(resolve => {
        letGo = resolve
      })
    })
    await isHeld
    const release = act(p.owner, 'partner.releaseClient', {
      partnerId: p.id,
      workspaceId: c,
      confirmName: 'Locked Client',
    })
    // The release is now waiting for the extra-calls lock (its first lock).
    await vi.waitFor(
      async () => {
        const waiting = await db.execute(
          `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
        )
        expect((waiting.rows[0] as { n: number }).n).toBeGreaterThan(0)
      },
      { timeout: 5000 },
    )
    // Meanwhile the balance is free: a call's gate on the partner bill is not held up behind the release.
    await db.transaction(async tx => {
      await tx.select().from(billing_balances).where(eq(billing_balances.billing_account_id, p.billId)).for('update', {
        noWait: true,
      })
    })
    letGo()
    await holder
    expect(await release).toMatchObject({ status: 200 })
  })

  test("a hand-over during a release: the owner never leaves, and the bill is the new owner's or none (#1113, N-1)", async () => {
    const p = await billedPartner('Racing Partner', 'active', true)
    const c = await createClient(p, 'Racing Client')
    const first = await giveOwner(p, c)
    const next = await invitedBy(p.owner, c)
    const nextId = (await partnerMembership(c, next.userId))!.id
    const firstId = (await partnerMembership(c, first.userId))!.id
    let letGo!: () => void
    let held!: () => void
    const isHeld = new Promise<void>(resolve => {
      held = resolve
    })
    // A hand-over to someone the team invited, as team.transferOwnership does it: the owner row locked first.
    const handOver = db.transaction(async tx => {
      await tx
        .select()
        .from(member)
        .where(and(eq(member.organizationId, c), eq(member.role, 'owner')))
        .for('update')
      await tx.update(member).set({ role: 'admin' }).where(eq(member.id, firstId))
      await tx.update(member).set({ role: 'owner' }).where(eq(member.id, nextId))
      held()
      await new Promise<void>(resolve => {
        letGo = resolve
      })
    })
    await isHeld
    const release = act(p.owner, 'partner.releaseClient', {
      partnerId: p.id,
      workspaceId: c,
      confirmName: 'Racing Client',
      removeMemberIds: [nextId],
    })
    // The release waits on the owner row, before it reads who the team invited.
    await vi.waitFor(
      async () => {
        const waiting = await db.execute(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
        )
        expect((waiting.rows[0] as { n: number }).n).toBeGreaterThan(0)
      },
      { timeout: 5000 },
    )
    letGo()
    await handOver
    expect(await release).toMatchObject({ status: 409, body: { code: 'member_not_invited' } })
    expect(await partnerMembership(c, next.userId)).toMatchObject({ role: 'owner' })
    expect(await orgRow(c)).toMatchObject({ partnerId: p.id, billingAccountId: p.billId })
    const bills = await db
      .select()
      .from(billing_accounts)
      .where(and(eq(billing_accounts.kind, 'cloud'), eq(billing_accounts.owner_user_id, first.userId)))
    expect(bills).toEqual([])
    // Released now, the bill is the new owner's, and they stay.
    expect(
      await act(p.owner, 'partner.releaseClient', { partnerId: p.id, workspaceId: c, confirmName: 'Racing Client' }),
    ).toMatchObject({ status: 200 })
    const [moved] = await db
      .select({ owner: billing_accounts.owner_user_id })
      .from(billing_accounts)
      .innerJoin(organization, eq(organization.billingAccountId, billing_accounts.id))
      .where(eq(organization.id, c))
    expect(moved).toEqual({ owner: next.userId })
    expect(await partnerMembership(c, next.userId)).toMatchObject({ role: 'owner' })
  })

  test('creating a client again with the same key gives the first client back, never a second one (#1113, L-3)', async () => {
    const p = await billedPartner('Retrying Partner', 'active', true)
    const key = `create_${rid('k')}`
    const input = { partnerId: p.id, name: 'Retried Client' }
    const one = await act(p.owner, 'workspace.createForClient', input, key)
    const two = await act(p.owner, 'workspace.createForClient', input, key)
    expect(one).toMatchObject({ status: 200 })
    expect(two).toMatchObject({ status: 200 })
    expect(two.body.data.workspace.id).toBe(one.body.data.workspace.id)
    const made = await db
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.partnerId, p.id), eq(organization.name, 'Retried Client')))
    expect(made).toHaveLength(1)
    // The key stays the sender's: someone else, also another member of the partner, gets no result with it.
    const other = await addPartnerAdmin(p)
    expect(await act(other, 'workspace.createForClient', input, key)).toMatchObject({ status: 409 })
  })

  test('a key reused with other input, or by someone else in no workspace, is refused; rows from before as before (#1115, L-1)', async () => {
    const p = await billedPartner('Keyed Partner', 'active', true)
    const q = await billedPartner('Other Keyed Partner', 'active', true)
    const key = `create_${rid('k')}`
    const first = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Keyed Client' }, key)
    expect(first).toMatchObject({ status: 200 })
    const [row] = await db.select().from(commands).where(eq(commands.id, key))
    expect(row?.input_hash).toMatch(/^[0-9a-f]{64}$/)
    // Keyed with the server's secret: the table alone cannot test a guess (security review of #1116, M-1).
    const plain = createHash('sha256')
      .update(canonicalJson({ partnerId: p.id, name: 'Keyed Client', removeMemberIds: [] }))
      .digest('hex')
    expect(row?.input_hash).not.toBe(plain)
    expect(row?.input_hash).not.toBe(
      createHash('sha256')
        .update(canonicalJson({ partnerId: p.id, name: 'Keyed Client' }))
        .digest('hex'),
    )
    // Another partner's owner, also in no workspace: never the first result, whatever they send with it.
    expect(
      await act(q.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Keyed Client' }, key),
    ).toMatchObject({ status: 409, body: { error: 'idempotency key was used for another command' } })
    expect(
      await act(q.owner, 'workspace.createForClient', { partnerId: q.id, name: 'Keyed Client' }, key),
    ).toMatchObject({ status: 409 })
    // The sender with other input: a mistake, not a retry, and nothing is made.
    expect(
      await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Another Client' }, key),
    ).toMatchObject({ status: 409, body: { error: 'idempotency key was used with different input' } })
    // The same input in another key order is the same input.
    const again = await act(p.owner, 'workspace.createForClient', { name: 'Keyed Client', partnerId: p.id }, key)
    expect(again.body.data.workspace.id).toBe(first.body.data.workspace.id)
    const made = await db.select({ id: organization.id }).from(organization).where(eq(organization.partnerId, p.id))
    expect(made).toHaveLength(1)
    // A command logged before the hash keeps the old answer: the first result.
    await db.update(commands).set({ input_hash: null }).where(eq(commands.id, key))
    const old = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name: 'Another Client' }, key)
    expect(old.body.data.workspace.id).toBe(first.body.data.workspace.id)
    expect(canonicalJson({ b: [1, { d: 1, c: undefined, a: 'x' }], a: null })).toBe(
      '{"a":null,"b":[1,{"a":"x","d":1}]}',
    )
  })
})

describe('partner seats follow what Stripe has (review of #1109, L-1)', () => {
  /** A Stripe stand-in: the subscription's seat item at `seats`, and every seat change asked of it. */
  function fakeSeats(seats: number, fails = 0) {
    const asked: SeatQuantityInput[] = []
    const state = { seats, fails }
    const provider = new Proxy({} as BillingProvider, {
      get: (_, name) => {
        if (name === 'subscription')
          return async (id: string) => ({
            id,
            customerId: 'cus_x',
            status: 'active',
            currentPeriodStart: null,
            currentPeriodEnd: null,
            billingCycleAnchor: null,
            interval: 'month',
            cancelAtPeriodEnd: false,
            trialEnd: null,
            defaultPaymentMethod: null,
            items: [
              { lookupKey: 'ws_monthly', quantity: state.seats },
              { lookupKey: 'extra_calls_monthly', quantity: 3 },
            ],
          })
        if (name === 'setSeatQuantity')
          return async (input: SeatQuantityInput) => {
            if (state.fails > 0) {
              state.fails--
              throw new Error('Stripe is down')
            }
            asked.push(input)
            state.seats = input.quantity
          }
        if (name === 'then') return undefined
        return () => {
          throw new Error(`not used: ${String(name)}`)
        }
      },
    })
    return { provider, asked, state }
  }

  beforeAll(() => {
    catalog.prices = { ws_monthly: 'price_ws_month', ws_yearly: 'price_ws_year' }
  })
  afterAll(() => {
    catalog.prices = null
  })

  test('a raise is prorated and a drop is not, by the seats Stripe has, not by the event that started the sync', () => {
    expect(seatProration(2, 3, 'month')).toBe('create_prorations')
    expect(seatProration(2, 3, 'year')).toBe('always_invoice')
    expect(seatProration(3, 2, 'month')).toBe('none')
    expect(seatProration(3, 3, 'month')).toBe('none')
  })

  test('a sync after a missed raise prorates it, even when its own event was a drop; equal counts ask nothing', async () => {
    const p = await billedPartner('Seat Partner', 'active', true)
    await createClient(p, 'Seat One')
    await createClient(p, 'Seat Two')
    await createClient(p, 'Seat Three')
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, p.billId))
    // Stripe still has one seat: two raises were missed. This sync comes from a release (a drop) and still charges.
    const stripe = fakeSeats(1)
    await syncSeats(p.billId, 'release_ws_x', stripe.provider)
    expect(stripe.asked).toEqual([
      {
        subscriptionId: expect.any(String),
        quantity: 3,
        prorationBehavior: 'create_prorations',
        idempotencyKey: `seats_release_ws_x_${p.billId}_1_3`,
        seatPrice: 'price_ws_month',
      },
    ])
    await syncSeats(p.billId, 'create_ws_y', stripe.provider)
    expect(stripe.asked).toHaveLength(1)
    // More seats in Stripe than clients: lowered, never refunded.
    stripe.state.seats = 5
    await syncSeats(p.billId, 'delete_ws_z', stripe.provider)
    expect(stripe.asked[1]).toMatchObject({ quantity: 3, prorationBehavior: 'none' })
  })

  test('a failed sync throws so the job runner tries again; after its last try the instance admins get an email', async () => {
    const p = await billedPartner('Flaky Seats', 'active', true)
    await createClient(p, 'Flaky Client')
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, p.billId))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      const job = { billId: p.billId, key: 'create_a', extraCalls: false }
      const once = fakeSeats(0, 1)
      await expect(runSeatSync(job, { last: false, provider: once.provider })).rejects.toThrow('Stripe is down')
      await runSeatSync(job, { last: false, provider: once.provider })
      expect(once.asked).toHaveLength(1)
      const before = sent.length
      const down = fakeSeats(0, 5)
      await runSeatSync({ ...job, key: 'create_b' }, { last: true, provider: down.provider })
      expect(down.asked).toEqual([])
      const to = await emailOf(admin)
      await vi.waitFor(() => expect(sent.slice(before).find(e => e.to === to)?.subject).toContain('Partner seats on'))
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
      error.mockRestore()
    }
  })

  test('with a job queue the seat sync is a job queued with the change, never a Stripe call in the request (#1113, L-3)', async () => {
    const p = await billedPartner('Queued Seats', 'active', true)
    await createClient(p, 'Queued One')
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, p.billId))
    const queued: { name: string; data: unknown }[] = []
    setJobQueue({ send: async (name: string, data: unknown) => void queued.push({ name, data }) } as never)
    let ws: string
    try {
      ws = await createClient(p, 'Queued Two')
    } finally {
      setJobQueue(null)
    }
    expect(queued.filter(j => j.name === PARTNER_SEAT_SYNC)).toEqual([
      { name: PARTNER_SEAT_SYNC, data: { billId: p.billId, key: `client_${ws}`, extraCalls: false } },
    ])
  })

  test('a Stripe call that hangs ends the try in time; on the last try the admins get an email (#1115, L-2)', async () => {
    const p = await billedPartner('Hanging Seats', 'active', true)
    await createClient(p, 'Hanging Client')
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, p.billId))
    const hanging = new Proxy({} as BillingProvider, {
      get: (_, name) => (name === 'then' ? undefined : () => new Promise(() => {})),
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      const job = { billId: p.billId, key: 'create_hang', extraCalls: false }
      await expect(runSeatSync(job, { last: false, provider: hanging, stepMs: 50 })).rejects.toThrow('no answer')
      const before = sent.length
      await runSeatSync(job, { last: true, provider: hanging, stepMs: 50 })
      const to = await emailOf(admin)
      await vi.waitFor(() => expect(sent.slice(before).find(e => e.to === to)?.subject).toContain('Partner seats on'))
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
      error.mockRestore()
    }
  })

  test('on the last try a failed extra-calls step ends the job with one email about the extra calls, none about seats (#1116, L-2)', async () => {
    const p = await billedPartner('Extra Hang', 'active', true)
    await createClient(p, 'Extra Client')
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, p.billId))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      // The seats follow; the extra-calls step never answers (its Stripe stand-in hangs in billingProvider's place).
      const stripe = fakeSeats(0)
      const job = { billId: p.billId, key: 'release_extra', extraCalls: true }
      const settings = await import('../src/billing-settings.ts')
      const hang = vi.spyOn(settings, 'billingProvider').mockImplementation(() => new Promise(() => {}))
      try {
        await expect(runSeatSync(job, { last: false, provider: stripe.provider, stepMs: 50 })).rejects.toThrow(
          'no answer',
        )
        const before = sent.length
        await runSeatSync(job, { last: true, provider: stripe.provider, stepMs: 50 })
        const to = await emailOf(admin)
        await vi.waitFor(() => expect(sent.slice(before).filter(e => e.to === to)).toHaveLength(1))
        const mine = sent.slice(before).filter(e => e.to === to)
        expect(mine[0]?.subject).toContain('Extra calls on')
        expect(mine.some(e => e.subject.includes('Partner seats on'))).toBe(false)
      } finally {
        hang.mockRestore()
      }
      expect(stripe.asked).toHaveLength(1)
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
      error.mockRestore()
    }
  })

  test('a seat sync job that ends failed for any reason goes to the dead-letter queue, which emails the admins (#1115, L-2)', async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: `pgboss_seats_${rid('t').slice(2, 12).toLowerCase()}`,
      supervise: false,
      schedule: false,
    })
    boss.on('error', () => {})
    await boss.start()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      // No tries left: as the last try that expired or whose worker stopped, which pg-boss marks failed.
      await createSeatSyncQueues(boss, 0)
      const job = { billId: rid('bill'), key: 'create_dead', extraCalls: false }
      const id = await boss.send(PARTNER_SEAT_SYNC, job)
      const [taken] = await boss.fetch(PARTNER_SEAT_SYNC)
      expect(taken?.id).toBe(id)
      await boss.fail(PARTNER_SEAT_SYNC, id!, { message: 'expired' })
      const [dead] = await boss.fetch<typeof job>(PARTNER_SEAT_SYNC_FAILED)
      expect(dead?.data).toEqual(job)
      // What its worker does: the admins' email.
      const before = sent.length
      await seatSyncFailed(dead!.data)
      const to = await emailOf(admin)
      await vi.waitFor(() => expect(sent.slice(before).find(e => e.to === to)?.subject).toContain('Partner seats on'))
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
      error.mockRestore()
      await boss.stop({ graceful: false, timeout: 1000 })
    }
  })
})
