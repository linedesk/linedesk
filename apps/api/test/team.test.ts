// Team management: who may invite, who may accept, last owner protection, removal and no open sign-up.
import { account, api_keys, commands, invitation, member, passkey, session, user, webhook_endpoints } from '@linedesk/db'
import { dropUnprovenAccess } from '../src/account-linking.ts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { LEAVE_SAY_ACCOUNT, OWNER_STAYS } from '../src/team.ts'
import { type Email, emailSender } from '../src/email.ts'
import { act, addMember, agent, anonymous, appRequest, asServerAdmin, createWorkspace, FROM, randomIp, request, signUp, type User, type Workspace } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const sent: Email[] = []
// The test env prints email to the log (EMAIL_TO_LOG); collect what would be sent instead.
Object.assign(emailSender, { send: async (email: Email) => void sent.push(email) })

const newEmail = () => `invitee_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const linkTo = (to: string) => sent.findLast(e => e.to === to)?.text.match(/\?invite=([\w%-]+)/)?.[1]

async function invite(by: User, email: string, role: 'admin' | 'member' = 'member') {
  const res = await act(by, 'team.invite', { email, role })
  expect(res).toMatchObject({ status: 200, body: { ok: true } })
  return res.body.data.invitationId as string
}

/** Signs in (or up) with an email code, the way the invitation page does; the code proves the address. */
async function signInWithCode(email: string): Promise<User> {
  const asked = await request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, { origin: ORIGIN, [FROM]: randomIp() })
  expect(asked.status).toBe(200)
  await vi.waitFor(() => expect(sent.some(e => e.to === email && /^\d{6} /.test(e.subject))).toBe(true))
  const otp = sent.findLast(e => e.to === email)!.subject.slice(0, 6)
  const res = await appRequest('/api/auth/sign-in/email-otp', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() }, body: JSON.stringify({ email, otp }),
  })
  expect(res.status).toBe(200)
  const { user: account } = (await res.json()) as { user: { id: string } }
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return { userId: account.id, headers: { cookie, origin: ORIGIN } }
}

const accept = (who: User, invitationId: string) =>
  request(who, 'POST', '/api/auth/organization/accept-invitation', { invitationId }, { [FROM]: randomIp() })

async function joinAs(ws: Workspace, role: 'admin' | 'member') {
  const email = newEmail()
  const id = await invite(ws.owner, email, role)
  const joined = await signUp(email)
  await verify(joined)
  expect((await accept(joined, id)).status).toBe(200)
  return joined
}

const memberIdOf = async (wsId: string, u: User) =>
  (await db.select().from(member).where(eq(member.userId, u.userId))).find(m => m.organizationId === wsId)!.id

let ws: Workspace
let admin: User
let plain: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  admin = await addMember(ws.id, 'admin')
  plain = await addMember(ws.id, 'member')
})

describe('inviting', () => {
  test('one address gets at most 3 invitation emails an hour, with the same answer whether or not it has an account', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email)
    for (let i = 0; i < 2; i++) expect((await act(ws.owner, 'team.resendInvite', { invitationId: id })).status).toBe(200)
    const limited = await act(ws.owner, 'team.resendInvite', { invitationId: id })
    expect(limited.body.error).toBe('too many invitations to this address in the last hour; try again later')
    expect(sent.filter(e => e.to === email)).toHaveLength(3)
  })

  test('URL-like workspace and inviter names stay out of the email', async () => {
    const other = await createWorkspace('Pay now at evil.example')
    const email = newEmail()
    await invite(other.owner, email)
    const mail = sent.findLast(e => e.to === email)!
    expect(mail.subject).toBe('Join your team on Linedesk')
    expect(mail.text).not.toMatch(/evil\.example/)
    expect(mail.text).toMatch(/invited you to join your team/)
    expect(mail.html).not.toMatch(/evil\.example/)
  })

  test('owners and admins can invite; members cannot', async () => {
    await invite(ws.owner, newEmail(), 'admin')
    await invite(admin, newEmail())
    const refused = await act(plain, 'team.invite', { email: newEmail(), role: 'member' })
    expect(refused).toMatchObject({ status: 403, body: { error: 'missing permission team:write' } })
  })

  test('sends an email with the link and stores the invitation for seven days', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email, 'admin')
    expect(linkTo(email)).toBe(encodeURIComponent(id))
    const [row] = await db.select().from(invitation).where(eq(invitation.id, id))
    expect(row).toMatchObject({ email, role: 'admin', status: 'pending', organizationId: ws.id })
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
  })

  test('owner cannot be given by invitation; a bad address is refused', async () => {
    expect((await act(ws.owner, 'team.invite', { email: newEmail(), role: 'owner' })).status).toBe(422)
    expect((await act(ws.owner, 'team.invite', { email: 'not-an-email', role: 'member' })).status).toBe(422)
  })

  test('refuses someone already on the team or already invited', async () => {
    const email = newEmail()
    await invite(ws.owner, email)
    expect(await act(ws.owner, 'team.invite', { email: email.toUpperCase(), role: 'member' })).toMatchObject({ status: 409, body: { error: `${email} is already invited; resend the invitation instead` } })
    const joined = await joinAs(ws, 'member')
    const [account] = await db.select().from(user).where(eq(user.id, joined.userId))
    expect((await act(ws.owner, 'team.invite', { email: account!.email, role: 'member' })).status).toBe(409)
  })

  test('Better Auth endpoints that change members are switched off', async () => {
    for (const path of ['invite-member', 'cancel-invitation', 'update-member-role', 'remove-member', 'leave']) {
      const res = await request(ws.owner, 'POST', `/api/auth/organization/${path}`, { email: newEmail(), role: 'admin', organizationId: ws.id })
      expect(res.status, path).toBe(404)
    }
  })

  test('resend extends the link and sends again; revoke stops it', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email)
    await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, id))
    expect((await request({ headers: {} }, 'GET', `/v1/invitations/${id}`)).body).toEqual({ status: 'expired' })
    sent.length = 0
    expect((await act(admin, 'team.resendInvite', { invitationId: id })).status).toBe(200)
    expect(linkTo(email)).toBe(encodeURIComponent(id))
    expect((await request({ headers: {} }, 'GET', `/v1/invitations/${id}`)).body).toMatchObject({ status: 'pending', email, workspaceName: 'Brightwater Plumbing & Heating' })
    expect((await act(admin, 'team.revokeInvite', { invitationId: id })).status).toBe(200)
    expect((await request({ headers: {} }, 'GET', `/v1/invitations/${id}`)).body).toEqual({ status: 'gone' })
    const invitee = await signUp(email)
    await verify(invitee)
    expect((await accept(invitee, id)).status).toBe(400)
  })

  test('another workspace cannot resend, revoke or see the invitation', async () => {
    const other = await createWorkspace('Other Business')
    const id = await invite(ws.owner, newEmail())
    expect(await act(other.owner, 'team.revokeInvite', { invitationId: id })).toMatchObject({ status: 409, body: { error: 'invitation not found' } })
    expect((await act(other.owner, 'team.resendInvite', { invitationId: id })).status).toBe(409)
    const list = await act(other.owner, 'team.list', {})
    expect(list.body.data.invitations).toEqual([])
  })
})

describe('accepting', () => {
  test('only the invited email can accept, and only once it is verified', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email, 'admin')

    const stranger = await signUp()
    await verify(stranger)
    expect(await accept(stranger, id)).toMatchObject({ status: 403, body: { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' } })

    const invitee = await signUp(email)
    expect((await accept(invitee, id)).status).toBe(403) // not verified yet
    await verify(invitee)
    expect((await accept(invitee, id)).status).toBe(200)
    expect(await request(invitee, 'GET', '/v1/me')).toMatchObject({ status: 200, body: { role: 'admin', workspace: { id: ws.id } } })
    expect((await accept(invitee, id)).status).toBe(400) // used
  })

  test('an expired invitation cannot be accepted', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email)
    await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, id))
    const invitee = await signUp(email)
    await verify(invitee)
    expect((await accept(invitee, id)).status).toBe(400)
  })
})

describe('roles', () => {
  test('invalid input is answered in a plain sentence, not as JSON', async () => {
    const res = await act(ws.owner, 'team.setRole', { memberId: await memberIdOf(ws.id, plain), role: 'chief' })
    expect(res).toMatchObject({ status: 422, body: { ok: false, error: 'Role must be one of admin, member.' } })
  })

  test('a member sees the team read-only', async () => {
    const res = await act(plain, 'team.list', {})
    expect(res.status).toBe(200)
    expect(res.body.data.canManage).toBe(false)
    expect(res.body.data.members.map((m: { role: string }) => m.role)).toEqual(expect.arrayContaining(['owner', 'admin', 'member']))
    expect((await act(ws.owner, 'team.list', {})).body.data.canManage).toBe(true)
  })

  test("a member does not see pending invitees' addresses, not through team.list and not through Better Auth", async () => {
    // Its own workspace: invitations to `ws` are rate-limited per hour.
    const own = await createWorkspace('Invitee Privacy Co')
    const [ownAdmin, ownMember] = [await addMember(own.id, 'admin'), await addMember(own.id, 'member')]
    const email = newEmail()
    await invite(own.owner, email)
    for (const manager of [own.owner, ownAdmin]) {
      expect((await act(manager, 'team.list', {})).body.data.invitations.map((i: { email: string }) => i.email)).toContain(email)
    }
    expect((await act(ownMember, 'team.list', {})).body.data.invitations).toEqual([])
    for (const path of ['/api/auth/organization/get-full-organization', '/api/auth/organization/list-invitations']) {
      const res = await request(ownMember, 'GET', path)
      expect(res.status, path).toBe(404)
      expect(JSON.stringify(res.body ?? '')).not.toContain(email)
    }
  })

  test('a role change applies to the next request of an existing session', async () => {
    const joined = await joinAs(ws, 'member')
    expect((await act(joined, 'team.invite', { email: newEmail(), role: 'member' })).status).toBe(403)
    expect((await act(admin, 'team.setRole', { memberId: await memberIdOf(ws.id, joined), role: 'admin' })).status).toBe(200)
    expect((await act(joined, 'team.invite', { email: newEmail(), role: 'member' })).status).toBe(200)
    expect((await act(admin, 'team.setRole', { memberId: await memberIdOf(ws.id, joined), role: 'member' })).status).toBe(200)
    expect((await act(joined, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'x' })).status).toBe(403)
  })

  test('nobody demotes or removes the owner, not even the owner (exactly one owner: only a transfer changes it)', async () => {
    const ownerMemberId = await memberIdOf(ws.id, ws.owner)
    const stays = { status: 403, body: { error: OWNER_STAYS, code: 'forbidden' } }
    for (const who of [ws.owner, admin]) {
      expect(await act(who, 'team.setRole', { memberId: ownerMemberId, role: 'admin' })).toMatchObject(stays)
      expect(await act(who, 'team.setRole', { memberId: ownerMemberId, role: 'member' })).toMatchObject(stays)
      expect(await act(who, 'team.removeMember', { memberId: ownerMemberId })).toMatchObject(stays)
    }
    expect((await act(ws.owner, 'team.list', {})).body.data.members[0]).toMatchObject({ role: 'owner' })
  })

  test('team.setRole never makes an owner; the database keeps one owner per workspace', async () => {
    const own = await createWorkspace('Two Owners')
    const second = await addMember(own.id, 'admin')
    const secondId = await memberIdOf(own.id, second)
    expect((await act(own.owner, 'team.setRole', { memberId: secondId, role: 'owner' })).status).toBe(422)
    await expect(db.update(member).set({ role: 'owner' }).where(eq(member.id, secondId))).rejects.toThrow()
  })

  test('the owner hands over: the new owner has the workspace, the old one is an admin; an admin cannot hand over', async () => {
    const own = await createWorkspace('Hand Over Co')
    const [second, third] = [await addMember(own.id, 'admin'), await addMember(own.id, 'admin')]
    const secondId = await memberIdOf(own.id, second)
    expect(await act(third, 'team.transferOwnership', { memberId: secondId })).toMatchObject({
      status: 403,
      body: { error: 'missing permission workspace:own' },
    })
    expect((await act(own.owner, 'team.transferOwnership', { memberId: await memberIdOf(own.id, own.owner) })).status).toBe(409)
    expect((await act(own.owner, 'team.transferOwnership', { memberId: secondId })).status).toBe(200)
    const roles = async () => Object.fromEntries((await db.select().from(member).where(eq(member.organizationId, own.id))).map(m => [m.userId, m.role]))
    expect(await roles()).toMatchObject({ [own.owner.userId]: 'admin', [second.userId]: 'owner', [third.userId]: 'admin' })
    // The old owner is an admin now: handing over again is the new owner's call.
    expect((await act(own.owner, 'team.transferOwnership', { memberId: await memberIdOf(own.id, third) })).status).toBe(403)
    const logged = await db.select().from(commands).where(and(eq(commands.actor_id, own.owner.userId), eq(commands.action, 'team.transferOwnership')))
    expect(logged).toContainEqual(expect.objectContaining({ input: { memberId: secondId }, rejected: false }))
  })

  test('a member of another workspace cannot be changed', async () => {
    const other = await createWorkspace('Elsewhere')
    const res = await act(ws.owner, 'team.removeMember', { memberId: await memberIdOf(other.id, other.owner) })
    expect(res).toMatchObject({ status: 409, body: { error: 'member not found' } })
  })
})

describe('removing', () => {
  test('a removed member loses access at once', async () => {
    const leaving = await joinAs(ws, 'member')
    expect((await request(leaving, 'GET', '/v1/me')).status).toBe(200)
    expect((await act(admin, 'team.removeMember', { memberId: await memberIdOf(ws.id, leaving) })).status).toBe(200)
    expect((await request(leaving, 'GET', '/v1/me')).status).toBe(401)
    expect((await act(leaving, 'call.markDone', { callId: ws.call.id })).status).toBe(401)
    expect((await request(leaving, 'GET', '/v1/shape/calls?offset=-1')).status).toBe(401)
  })

  test('members cannot remove anyone', async () => {
    const res = await act(plain, 'team.removeMember', { memberId: await memberIdOf(ws.id, admin) })
    expect(res.status).toBe(403)
  })
  const accountExists = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId))).length === 1

  test('their last workspace: the account is deleted by default, keepAccount keeps it without a workspace', async () => {
    const gone = await addMember(ws.id, 'member')
    const removed = await act(admin, 'team.removeMember', { memberId: await memberIdOf(ws.id, gone) })
    expect(removed).toMatchObject({ status: 200, body: { data: { accountDeleted: true } } })
    expect(await accountExists(gone)).toBe(false)

    const kept = await addMember(ws.id, 'member')
    const keeping = await act(admin, 'team.removeMember', { memberId: await memberIdOf(ws.id, kept), keepAccount: true })
    expect(keeping).toMatchObject({ status: 200, body: { data: { accountDeleted: false } } })
    expect(await accountExists(kept)).toBe(true)
    expect(await db.select().from(member).where(eq(member.userId, kept.userId))).toEqual([])
    // Still signed in, without a workspace: the page that waits for an invitation.
    expect((await request(kept, 'GET', '/api/auth/get-session')).body).toMatchObject({ user: { id: kept.userId } })
  })

  test('a member of another workspace keeps the account and continues there', async () => {
    const other = await createWorkspace('Second Shop Electric')
    const both = await addMember(ws.id, 'member')
    await auth.api.addMember({ body: { userId: both.userId, organizationId: other.id, role: 'member' } })
    const res = await act(admin, 'team.removeMember', { memberId: await memberIdOf(ws.id, both) })
    expect(res).toMatchObject({ status: 200, body: { data: { accountDeleted: false } } })
    expect(await accountExists(both)).toBe(true)
    expect((await request(both, 'GET', '/v1/me')).body).toMatchObject({ workspace: { id: other.id } })
  })
})

describe('no open sign-up', () => {
  const passwordSignUp = (email: string) =>
    appRequest('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ name: 'Test User', email, password: 'test-password-1234' }),
    })

  test('refuses new accounts, but an invited address signs in with an email code and joins in the same step', async () => {
    const stranger = newEmail()
    expect((await passwordSignUp(stranger)).status).toBe(400)
    expect(await db.select().from(user).where(eq(user.email, stranger))).toEqual([])

    const email = newEmail()
    const id = await invite(ws.owner, email)
    const invitee = await signInWithCode(email)
    expect((await request(invitee, 'GET', '/v1/me')).body).toMatchObject({ workspace: { id: ws.id } })
    const [row] = await db.select().from(invitation).where(eq(invitation.id, id))
    expect(row!.status).toBe('accepted')
  })

  test('a password sign-up cannot take an invited address: it does not prove the address is yours', async () => {
    const email = newEmail()
    await invite(ws.owner, email)
    expect((await passwordSignUp(email)).status).toBe(400)
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([])
    // The real owner of the address still gets in with a code and joins.
    const invitee = await signInWithCode(email)
    expect((await request(invitee, 'GET', '/v1/me')).body).toMatchObject({ workspace: { id: ws.id } })
  })

  test('a revoked or expired invitation no longer opens sign-up', async () => {
    const email = newEmail()
    const id = await invite(ws.owner, email)
    await act(ws.owner, 'team.revokeInvite', { invitationId: id })
    const asked = await request(anonymous, 'POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, { origin: ORIGIN, [FROM]: randomIp() })
    expect(asked.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(sent.some(e => e.to === email && /^\d{6} /.test(e.subject))).toBe(false)
  })

  test('the verification email works for an invited password account', async () => {
    const email = newEmail()
    await invite(ws.owner, email)
    const invitee = await signUp(email)
    sent.length = 0
    const res = await request(invitee, 'POST', '/api/auth/send-verification-email', { email, callbackURL: ORIGIN }, { [FROM]: randomIp() })
    expect(res.status).toBe(200)
    expect(sent.find(e => e.to === email)?.text).toMatch(/verify-email\?token=/)
  })
})

describe('confirming an address by email link (security M1)', () => {
  const linkFor = (email: string) => {
    const url = sent.findLast(e => e.to === email)?.text.match(/(https?:\/\/\S*verify-email\?token=\S+)/)?.[1]
    if (!url) throw new Error(`no link for ${email}`)
    const { pathname, search } = new URL(url)
    return `${pathname}${search}`
  }
  const open = (path: string, cookie?: string) =>
    appRequest(path, { headers: { ...(cookie ? { cookie } : {}), [FROM]: randomIp() }, redirect: 'manual' })
  const credentialsOf = (userId: string) =>
    db.select().from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
  const sessionsOf = (userId: string) => db.select().from(session).where(eq(session.userId, userId))

  test("someone who signed up with another person's address loses every way in and out once that person confirms it", async () => {
    const victim = newEmail()
    const attacker = await signUp(victim)
    // What they set up before the owner confirmed: a workspace with an API key, a webhook, an invitation,
    // a passkey (inserted: adding one is refused for an unconfirmed address) and another sign-in account.
    // Only server admins create workspaces now; made as one here to stand for a workspace from before.
    const made = await asServerAdmin(attacker, () => request(attacker, 'POST', '/v1/workspaces', { name: 'Before Confirmation' }))
    expect(made.status).toBe(200)
    // Legacy access from before confirmation was required. New creation is refused.
    expect((await act(attacker, 'apiKey.create', { name: 'Exfil', role: 'admin' })).status).toBe(403)
    await db.insert(api_keys).values({ id: crypto.randomUUID(), workspace_id: made.body.workspace.id, name: 'Legacy', prefix: 'ldk_legacy', key_hash: crypto.randomUUID(), role: 'admin', created_by: attacker.userId })
    await db.insert(webhook_endpoints).values({ id: `whe_${crypto.randomUUID().slice(0, 12)}`, workspace_id: made.body.workspace.id, url: 'https://collector.example.com/hook', events: [], created_by: attacker.userId })
    expect((await act(attacker, 'team.invite', { email: newEmail(), role: 'admin' })).status).toBe(403)
    await db.insert(invitation).values({ id: crypto.randomUUID(), organizationId: made.body.workspace.id, email: newEmail(), role: 'admin', status: 'pending', inviterId: attacker.userId, expiresAt: new Date(Date.now() + 86400000) })
    await db.insert(passkey).values({ id: `pk_${crypto.randomUUID().slice(0, 12)}`, userId: attacker.userId, publicKey: 'cHVibGlj', credentialID: `cred-${crypto.randomUUID()}`, counter: 0, deviceType: 'singleDevice', backedUp: false })
    await db.insert(account).values({ id: `acc_${crypto.randomUUID().slice(0, 12)}`, userId: attacker.userId, accountId: 'attacker-sub', providerId: 'github', createdAt: new Date(), updatedAt: new Date() })
    // No session needed to have our genuine link sent to the address.
    const asked = await request(anonymous, 'POST', '/api/auth/send-verification-email', { email: victim, callbackURL: ORIGIN }, { origin: ORIGIN, [FROM]: randomIp() })
    expect(asked.status).toBe(200)
    // The real owner opens it in their own browser, without a session of that account.
    const opened = await open(linkFor(victim))
    expect(opened.status).toBeLessThan(400)
    expect((await db.select().from(user).where(eq(user.id, attacker.userId)))[0]!.emailVerified).toBe(true)
    expect(await credentialsOf(attacker.userId)).toEqual([])
    // Only the session the link just started is left, and it is the owner's browser's.
    const sessions = await sessionsOf(attacker.userId)
    expect(sessions).toHaveLength(1)
    expect(opened.headers.getSetCookie().join(';')).toContain(sessions[0]!.token)
    expect((await request(attacker, 'GET', '/v1/me')).status).toBe(401)
    const again = await request(anonymous, 'POST', '/api/auth/sign-in/email', { email: victim, password: 'test-password-1234' }, { origin: ORIGIN, [FROM]: randomIp() })
    expect(again.status).toBeGreaterThanOrEqual(400)
    // No other sign-in account, passkey, live API key, webhook or pending invitation of theirs is left.
    expect(await db.select().from(account).where(eq(account.userId, attacker.userId))).toEqual([])
    expect(await db.select().from(passkey).where(eq(passkey.userId, attacker.userId))).toEqual([])
    expect((await db.select().from(api_keys).where(eq(api_keys.created_by, attacker.userId))).every(k => k.revoked_at)).toBe(true)
    expect(await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.created_by, attacker.userId))).toEqual([])
    expect((await db.select().from(invitation).where(eq(invitation.inviterId, attacker.userId))).map(i => i.status)).toEqual(['canceled'])
    // The workspace stays, now the owner's.
    expect((await db.select().from(member).where(eq(member.userId, attacker.userId))).length).toBe(1)
  })

  test('a provider proving the address drops the same, but keeps the provider account it links', async () => {
    const victim = newEmail()
    const attacker = await signUp(victim)
    await db.insert(passkey).values({ id: `pk_${crypto.randomUUID().slice(0, 12)}`, userId: attacker.userId, publicKey: 'cHVibGlj', credentialID: `cred-${crypto.randomUUID()}`, counter: 0, deviceType: 'singleDevice', backedUp: false })
    const [linked] = await db.insert(account).values({ id: `acc_${crypto.randomUUID().slice(0, 12)}`, userId: attacker.userId, accountId: 'victim-sub', providerId: 'google', createdAt: new Date(), updatedAt: new Date() }).returning()
    await dropUnprovenAccess(linked!)
    expect((await db.select().from(account).where(eq(account.userId, attacker.userId))).map(a => a.providerId)).toEqual(['google'])
    expect(await db.select().from(passkey).where(eq(passkey.userId, attacker.userId))).toEqual([])
    expect(await sessionsOf(attacker.userId)).toEqual([])
  })

  test('the person who signed up keeps their password when they open the link in their own session', async () => {
    const email = newEmail()
    const own = await signUp(email)
    await request(own, 'POST', '/api/auth/send-verification-email', { email, callbackURL: ORIGIN }, { [FROM]: randomIp() })
    const opened = await open(linkFor(email), own.headers.cookie)
    expect(opened.status).toBeLessThan(400)
    expect(await credentialsOf(own.userId)).toHaveLength(1)
    const token = own.headers.cookie!.match(/session_token=([^.;]+)/)?.[1]
    expect((await sessionsOf(own.userId)).some(s => s.token === token)).toBe(true)
  })
})

describe('answering an invitation inside the app', () => {
  const mine = async (who: User) =>
    (await act(who, 'invitation.listMine', {})).body.data.invitations as { invitationId: string; workspaceName: string; role: string }[]
  const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email
  const statusOf = async (id: string) => (await db.select().from(invitation).where(eq(invitation.id, id)))[0]?.status

  /** Someone with a workspace of their own, invited to `ws`. */
  async function invitedOwner(role: 'admin' | 'member' = 'member') {
    const theirs = await createWorkspace('Janik Electric')
    await verify(theirs.owner)
    const id = await invite(ws.owner, (await emailOf(theirs.owner)).toLowerCase(), role)
    return { who: theirs.owner, id }
  }

  test('an existing user sees the invitation, accepts it and becomes a member with the invited role; logged as a command', async () => {
    const { who, id } = await invitedOwner('admin')
    expect(await mine(who)).toEqual([
      expect.objectContaining({ invitationId: id, workspaceId: ws.id, workspaceName: 'Brightwater Plumbing & Heating', role: 'admin' }),
    ])
    const res = await act(who, 'invitation.accept', { invitationId: id })
    expect(res).toMatchObject({ status: 200, body: { ok: true, data: { workspaceId: ws.id } } })
    expect((await db.select().from(member).where(eq(member.userId, who.userId))).find(m => m.organizationId === ws.id)?.role).toBe('admin')
    expect(await statusOf(id)).toBe('accepted')
    expect(await mine(who)).toEqual([])
    const [logged] = await db.select().from(commands).where(and(eq(commands.actor_id, who.userId), eq(commands.action, 'invitation.accept')))
    // The invitation id opens the invitation: the log keeps it redacted.
    expect(logged).toMatchObject({ input: { invitationId: '[redacted]' }, rejected: false })
    expect((await act(who, 'invitation.accept', { invitationId: id })).body.error).toBe('invitation not found')
  })

  test('declining ends the invitation; it is gone from the list and cannot be accepted', async () => {
    const { who, id } = await invitedOwner()
    expect((await act(who, 'invitation.decline', { invitationId: id })).status).toBe(200)
    expect(await statusOf(id)).toBe('rejected')
    expect(await mine(who)).toEqual([])
    expect((await act(who, 'invitation.accept', { invitationId: id })).body.error).toBe('invitation not found')
  })

  test("only the invitee: someone else's invitation is not found, neither listed nor accepted nor declined", async () => {
    const { id } = await invitedOwner()
    const verified = (await createWorkspace('Someone Else Co')).owner
    await verify(verified)
    for (const stranger of [ws.owner, admin, plain, verified]) {
      expect((await mine(stranger)).map(i => i.invitationId)).not.toContain(id)
      // Unverified: asked to confirm first (before any lookup); verified: not found.
      expect((await act(stranger, 'invitation.accept', { invitationId: id })).status).toBe(409)
      expect(await act(stranger, 'invitation.decline', { invitationId: id })).toMatchObject({ status: 409, body: { error: 'invitation not found' } })
    }
    expect((await act(verified, 'invitation.accept', { invitationId: id })).body.error).toBe('invitation not found')
    expect(await statusOf(id)).toBe('pending')
  })

  test('an unverified address sees nothing and cannot accept', async () => {
    const theirs = await createWorkspace('Unverified Co', false)
    const id = await invite(ws.owner, (await emailOf(theirs.owner)).toLowerCase())
    expect(await mine(theirs.owner)).toEqual([])
    expect((await act(theirs.owner, 'invitation.accept', { invitationId: id })).body.error).toBe('confirm your email address first')
  })

  test('an expired invitation is not listed and cannot be accepted', async () => {
    const { who, id } = await invitedOwner()
    await db.update(invitation).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invitation.id, id))
    expect(await mine(who)).toEqual([])
    expect((await act(who, 'invitation.accept', { invitationId: id })).body.error).toBe('this invitation has expired; ask for a new one')
  })

  test("Better Auth's own reject endpoint is off: declining goes through the registry", async () => {
    const { who, id } = await invitedOwner()
    const res = await request(who, 'POST', '/api/auth/organization/reject-invitation', { invitationId: id }, { [FROM]: randomIp() })
    expect(res.status).toBe(404)
    expect(await statusOf(id)).toBe('pending')
  })

  test('the agent cannot list or answer invitations', async () => {
    const { id } = await invitedOwner()
    expect((await act(agent(ws.id), 'invitation.accept', { invitationId: id })).status).toBe(403)
    expect((await act(agent(ws.id), 'invitation.listMine', {})).status).toBe(403)
  })
})

describe('leaving', () => {
  test('a member leaves: access ends at once, the next workspace is named, and it is logged', async () => {
    const leaving = await joinAs(ws, 'member')
    const own = await createWorkspace('Leaver Own Co')
    await auth.api.addMember({ body: { userId: leaving.userId, organizationId: own.id, role: 'admin' } })
    const res = await act(leaving, 'team.leave', {})
    expect(res).toMatchObject({ status: 200, body: { ok: true, data: { nextWorkspaceId: own.id } } })
    expect((await db.select().from(member).where(eq(member.userId, leaving.userId))).map(m => m.organizationId)).toEqual([own.id])
    expect((await request(leaving, 'GET', '/v1/me')).body.workspace.id).toBe(own.id)
    const [logged] = await db.select().from(commands).where(and(eq(commands.actor_id, leaving.userId), eq(commands.action, 'team.leave')))
    expect(logged).toMatchObject({ workspace_id: ws.id, rejected: false })
  })

  test('the only workspace: the request must say whether the account goes; a request that does not is refused and changes nothing', async () => {
    const leaving = await addMember(ws.id, 'member')
    expect(await act(leaving, 'team.leave', {})).toMatchObject({ status: 409, body: { error: LEAVE_SAY_ACCOUNT } })
    expect(await db.select().from(member).where(eq(member.userId, leaving.userId))).toHaveLength(1)
    expect(await db.select().from(user).where(eq(user.id, leaving.userId))).toHaveLength(1)
    // With another workspace left the field is not needed: the account stays anyway.
    const other = await createWorkspace('Leaver Field Co')
    await auth.api.addMember({ body: { userId: leaving.userId, organizationId: other.id, role: 'member' } })
    expect((await act(leaving, 'team.leave', {})).body.data).toEqual({ nextWorkspaceId: other.id, accountDeleted: false })
  })

  test('the only workspace with deleteAccount: the account is deleted, with its sessions, passkeys and API keys', async () => {
    const leaving = await addMember(ws.id, 'admin')
    const key = (await act(leaving, 'apiKey.create', { name: 'Leaver key', role: 'admin' })).body.data.key as string
    expect((await appRequest('/v1/me', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)
    await db.insert(passkey).values({ id: `pk_${crypto.randomUUID().slice(0, 12)}`, userId: leaving.userId, publicKey: 'cHVibGlj', credentialID: `cred-${crypto.randomUUID()}`, counter: 0, deviceType: 'singleDevice', backedUp: false })
    expect((await act(leaving, 'team.leave', { deleteAccount: true })).body.data).toEqual({ nextWorkspaceId: null, accountDeleted: true })
    expect(await db.select().from(user).where(eq(user.id, leaving.userId))).toEqual([])
    expect(await db.select().from(session).where(eq(session.userId, leaving.userId))).toEqual([])
    expect(await db.select().from(passkey).where(eq(passkey.userId, leaving.userId))).toEqual([])
    expect((await request(leaving, 'GET', '/v1/me')).status).toBe(401)
    expect((await appRequest('/v1/me', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401)
    const [logged] = await db.select().from(commands).where(and(eq(commands.actor_id, leaving.userId), eq(commands.action, 'team.leave')))
    expect(logged).toMatchObject({ workspace_id: ws.id, rejected: false })
  })

  test('the only workspace with deleteAccount false: the account stays, signed in, without a workspace', async () => {
    const leaving = await addMember(ws.id, 'member')
    expect((await act(leaving, 'team.leave', { deleteAccount: false })).body.data).toEqual({ nextWorkspaceId: null, accountDeleted: false })
    expect(await db.select().from(user).where(eq(user.id, leaving.userId))).toHaveLength(1)
    expect(await db.select().from(member).where(eq(member.userId, leaving.userId))).toEqual([])
    expect((await request(leaving, 'GET', '/api/auth/get-session')).body).toMatchObject({ user: { id: leaving.userId } })
  })

  test("deleteAccount never deletes a server admin's account", async () => {
    const serverAdmin = await addMember(ws.id, 'admin')
    const left = await asServerAdmin(serverAdmin, () => act(serverAdmin, 'team.leave', { deleteAccount: true }))
    expect(left.body.data).toEqual({ nextWorkspaceId: null, accountDeleted: false })
    expect(await db.select().from(user).where(eq(user.id, serverAdmin.userId))).toHaveLength(1)
  })

  test('a hand-over at the same moment: leave waits for it and then refuses, the new owner stays (#734 re-check, R2)', async () => {
    const shop = await createWorkspace('Leave Race Co')
    const next = await addMember(shop.id, 'admin')
    const ownerId = await memberIdOf(shop.id, shop.owner)
    const nextId = await memberIdOf(shop.id, next)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => { locked = resolve })
    // The hand-over (as team.transferOwnership does it) holds the new owner's row while it runs.
    const handOver = db.transaction(async tx => {
      await tx.select().from(member).where(eq(member.id, nextId)).for('update')
      locked()
      await held
      await tx.update(member).set({ role: 'admin' }).where(eq(member.id, ownerId))
      await tx.update(member).set({ role: 'owner' }).where(eq(member.id, nextId))
    })
    await isLocked
    const leave = act(next, 'team.leave', { deleteAccount: true })
    await new Promise(resolve => setTimeout(resolve, 200))
    release()
    await handOver
    expect(await leave).toMatchObject({ status: 409, body: { error: 'you are the owner: make someone else the owner first (Workspace settings › Team)' } })
    const [row] = await db.select().from(member).where(eq(member.id, nextId))
    expect(row).toMatchObject({ role: 'owner' })
    expect(await db.select().from(user).where(eq(user.id, next.userId))).toHaveLength(1)
  })

  test('the owner cannot leave; after handing over they can', async () => {
    const solo = await createWorkspace('Solo Owner Co')
    expect(await act(solo.owner, 'team.leave', {})).toMatchObject({
      status: 409,
      body: { error: 'you are the owner: make someone else the owner first (Workspace settings › Team)' },
    })
    const second = await addMember(solo.id, 'admin')
    expect((await act(solo.owner, 'team.transferOwnership', { memberId: await memberIdOf(solo.id, second) })).status).toBe(200)
    expect((await act(solo.owner, 'team.leave', { deleteAccount: false })).status).toBe(200)
    expect((await db.select().from(member).where(eq(member.organizationId, solo.id))).map(m => m.userId)).toEqual([second.userId])
  })

  test('the agent cannot leave a workspace', async () => {
    expect((await act(agent(ws.id), 'team.leave', {})).status).toBe(403)
  })
})
