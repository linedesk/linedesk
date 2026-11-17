// White-label partners (docs/white-label.md, slice S1): tenancy and permissions. A partner's team reaches its own
// partner and its client workspaces, never another partner's; client memberships follow the team (invite, accept,
// remove, suspend, approve); a partner's membership is changed only on the partner. Makes server admins and switches
// billing on for one test: an instance-wide file (vitest.config.ts).
import {
  api_keys,
  commands,
  instance_settings,
  invitation,
  member,
  organization,
  partner_invitations,
  partner_members,
  partners,
  user,
} from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { BILLING_ENABLED_KEY } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { type Email, emailSender } from '../src/email.ts'
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

  test('where billing is on, client workspaces wait for the partner bill (S2)', async () => {
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
