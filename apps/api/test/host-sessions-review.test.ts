// Regression tests for the security review of white-label S5.2 (LIN-559; docs/white-label.md "Own address"), written as
// the exploits the review describes: an email code or sign-in link carried from one address to another, a partner's
// address showing and accepting other tenants' invitations, deleting an account there, a session outliving its
// address's row, profile pictures across tenants, and an address map that stopped loading. Writes partner addresses,
// which turn the host check on for the whole install: an instance-wide file (vitest.config.ts).
import { invitation, member, partners, session, user, user_avatars } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { sessionFitsHost } from '../src/host-sessions.ts'
import { HOSTS_FAIL_CLOSED_MS, mainHostOnlyAction, reloadHosts, resolveHost } from '../src/request-host.ts'
import { act, addMember, createWorkspace, type User } from './helpers.ts'
import { addDomain, makeClient, makePartner, onHost, setStatus, signInOn, uid } from './partner-hosts.ts'

const HOST = 'app.review-agency.test'
const ORIGIN = `https://${HOST}`
const OTHER_HOST = 'app.review-other-agency.test'
const MAIN_HOST = 'localhost:5173'
const MAIN = 'http://localhost:5173'
const originOf = (host: string) => (host === MAIN_HOST ? MAIN : `https://${host}`)

let partnerId: string
let domainId: string
let client: Awaited<ReturnType<typeof createWorkspace>>
let own: Awaited<ReturnType<typeof createWorkspace>>

beforeAll(async () => {
  partnerId = await makePartner()
  domainId = await addDomain(partnerId, HOST, 'active')
  await addDomain(await makePartner(), OTHER_HOST, 'active')
  client = await createWorkspace('Review Client')
  await makeClient(client.id, partnerId)
  own = await createWorkspace('Review No Partner')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const emailOf = async (who: User) =>
  (await db.select({ email: user.email }).from(user).where(eq(user.id, who.userId)))[0]!.email

/** Asks for a code on `host` as its sign-in page does; the emailed code and, for a sign-in code, the link's token. */
async function askCode(host: string, email: string, type: 'sign-in' | 'email-verification' = 'sign-in', who?: User) {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  try {
    const asked = await onHost(host, '/api/auth/email-otp/send-verification-otp', {
      origin: originOf(host),
      body: { email, type },
      who,
    })
    expect(asked.status).toBe(200)
    await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.to === email)).toBe(true))
    const mail = send.mock.calls
      .map(([m]) => m)
      .filter(m => m.to === email)
      .at(-1)!
    const otp = /\b(\d{6})\b/.exec(mail.subject)![1]!
    const token = /#sign-in=([A-Za-z0-9_-]{43})/.exec(mail.text ?? '')?.[1]
    return { otp, token }
  } finally {
    send.mockRestore()
  }
}

/** Signs in on `host` with an email and code, as the attacker's server would send it (any Origin it likes). */
const signInWith = (host: string, email: string, otp: string) =>
  onHost(host, '/api/auth/sign-in/email-otp', { origin: originOf(host), body: { email, otp } })

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')

const sessionOf = async (cookie: string) => {
  const token = decodeURIComponent(cookie.split('session_token=')[1]!.split(';')[0]!).split('.')[0]!
  return (await db.select().from(session).where(eq(session.token, token)))[0]
}

/** A member of the partner's client whose email is confirmed: a client the partner's address serves. */
async function clientMember(): Promise<{ who: User; email: string }> {
  const who = await addMember(client.id, 'member')
  return { who, email: await emailOf(who) }
}

describe('H-1: an email code works only on the address it was asked on', () => {
  test('a code asked on the partner’s address is refused on the install’s own and on another partner’s', async () => {
    const { email } = await clientMember()
    const { otp } = await askCode(HOST, email)
    for (const host of [MAIN_HOST, OTHER_HOST]) {
      const stolen = await signInWith(host, email, otp)
      expect(stolen.status, host).toBe(403)
      expect(await stolen.json(), host).toMatchObject({ code: 'code_other_address' })
      expect(stolen.headers.getSetCookie().join(), host).not.toMatch(/session_token=[^;]/)
    }
    // The refused tries did not spend it: the client still signs in where they asked, and the session is bound there.
    const signedIn = await signInWith(HOST, email, otp)
    expect(signedIn.status).toBe(200)
    const row = await sessionOf(cookieOf(signedIn))
    expect(row).toMatchObject({ host: HOST, hostDomainId: domainId })
  })

  test('a code asked on the install’s own address is refused on the partner’s', async () => {
    const { email } = await clientMember()
    const { otp } = await askCode(MAIN_HOST, email)
    const there = await signInWith(HOST, email, otp)
    expect(there.status).toBe(403)
    expect(await there.json()).toMatchObject({ code: 'code_other_address' })
    const signedIn = await signInWith(MAIN_HOST, email, otp)
    expect(signedIn.status).toBe(200)
    expect(await sessionOf(cookieOf(signedIn))).toMatchObject({ host: null, hostDomainId: null })
  })

  test('a fresh code asked on the install’s own address replaces a partner one: signing in there works again', async () => {
    const { email } = await clientMember()
    const partnerCode = await askCode(HOST, email)
    const mainCode = await askCode(MAIN_HOST, email)
    expect((await signInWith(MAIN_HOST, email, partnerCode.otp)).status).not.toBe(200)
    expect((await signInWith(MAIN_HOST, email, mainCode.otp)).status).toBe(200)
  })

  test('a confirmation code asked on the partner’s address is refused on the install’s own', async () => {
    const { who, email } = await clientMember()
    // Only the signed-in person asks for their own confirmation code (sign-in-limits.ts): here, on the partner's address.
    const here = await signInOn(HOST, who)
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, who.userId))
    const { otp } = await askCode(HOST, email, 'email-verification', here)
    const res = await onHost(MAIN_HOST, '/api/auth/email-otp/verify-email', { origin: MAIN, body: { email, otp } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'code_other_address' })
    expect((await db.select().from(user).where(eq(user.id, who.userId)))[0]!.emailVerified).toBe(false)
  })

  test('a sign-in link made on the partner’s address is spent on the install’s own; it still works where it was made', async () => {
    const { email } = await clientMember()
    const { token } = await askCode(HOST, email)
    expect(token).toBeTruthy()
    // The attacker's server sends it on with the install's own Origin, which it sets as it likes.
    const checked = await onHost(MAIN_HOST, '/v1/sign-in-link/check', { origin: MAIN, body: { token } })
    expect(await checked.json()).toEqual({ ok: true, state: 'spent' })
    const used = await onHost(MAIN_HOST, '/v1/sign-in-link/use', { origin: MAIN, body: { token } })
    expect(used.status).toBe(400)
    expect(await used.json()).toMatchObject({ ok: false, state: 'spent' })
    expect(used.headers.getSetCookie().join()).not.toMatch(/session_token=[^;]/)
    // Not taken by the refused try: on the partner's address it signs in, bound there.
    const here = await onHost(HOST, '/v1/sign-in-link/use', { origin: ORIGIN, body: { token } })
    expect(here.status).toBe(200)
    expect(await sessionOf(cookieOf(here))).toMatchObject({ host: HOST, hostDomainId: domainId })
  })

  test('a sign-in link made on the install’s own address is spent on the partner’s', async () => {
    const { email } = await clientMember()
    const { token } = await askCode(MAIN_HOST, email)
    const used = await onHost(HOST, '/v1/sign-in-link/use', { origin: ORIGIN, body: { token } })
    expect(used.status).toBe(400)
    expect(await used.json()).toMatchObject({ ok: false, state: 'spent' })
  })
})

describe('L-1: on a partner’s address only that partner’s invitations', () => {
  test('other tenants’ invitations are neither listed nor accepted there; the partner’s are', async () => {
    const { who, email } = await clientMember()
    const here = await signInOn(HOST, who)
    const secondClient = await createWorkspace('Review Second Client')
    await makeClient(secondClient.id, partnerId)
    const invite = async (workspaceId: string, inviterId: string) => {
      const id = uid('inv')
      await db.insert(invitation).values({
        id,
        organizationId: workspaceId,
        email,
        role: 'admin',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId,
      })
      return id
    }
    const elsewhere = await invite(own.id, own.owner.userId)
    const ours = await invite(secondClient.id, secondClient.owner.userId)

    const listed = await onHost(HOST, '/v1/actions/invitation.listMine', { who: here, origin: ORIGIN, body: {} })
    expect(listed.status).toBe(200)
    const ids = ((await listed.json()).data.invitations as { invitationId: string }[]).map(i => i.invitationId)
    expect(ids).toEqual([ours])
    // Better Auth's own list is the install's own address's.
    const baList = await onHost(HOST, '/api/auth/organization/list-user-invitations', { who: here })
    expect(baList.status).toBe(404)
    expect(await baList.json()).toMatchObject({ code: 'main_host_only' })

    for (const name of ['invitation.accept', 'invitation.decline']) {
      const res = await onHost(HOST, `/v1/actions/${name}`, {
        who: here,
        origin: ORIGIN,
        body: { invitationId: elsewhere },
      })
      expect(res.status, name).not.toBe(200)
    }
    const baAccept = await onHost(HOST, '/api/auth/organization/accept-invitation', {
      who: here,
      origin: ORIGIN,
      body: { invitationId: elsewhere },
    })
    expect(baAccept.status).toBe(403)
    expect(await baAccept.json()).toMatchObject({ code: 'other_partner' })
    const joined = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, own.id), eq(member.userId, who.userId)))
    expect(joined).toEqual([])
    expect((await db.select().from(invitation).where(eq(invitation.id, elsewhere)))[0]!.status).toBe('pending')

    // On the install's own address the person sees it; on the partner's they accept the partner's own.
    const onMain = await act(who, 'invitation.listMine', {})
    expect((onMain.body.data.invitations as { invitationId: string }[]).map(i => i.invitationId)).toEqual(
      expect.arrayContaining([elsewhere, ours]),
    )
    const accepted = await onHost(HOST, '/v1/actions/invitation.accept', {
      who: here,
      origin: ORIGIN,
      body: { invitationId: ours },
    })
    expect(accepted.status).toBe(200)
  })
})

describe('L-2: no account is deleted on a partner’s address', () => {
  test('team.leave and team.removeMember with deleteAccount are main_host_only there', async () => {
    const { who } = await clientMember()
    const leaving = await signInOn(HOST, who)
    const left = await onHost(HOST, '/v1/actions/team.leave', {
      who: leaving,
      origin: ORIGIN,
      body: { deleteAccount: true },
    })
    expect(left.status).toBe(404)
    expect(await left.json()).toMatchObject({ code: 'main_host_only' })

    const { who: removed } = await clientMember()
    const owner = await signInOn(HOST, client.owner)
    const [row] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, client.id), eq(member.userId, removed.userId)))
    const removing = await onHost(HOST, '/v1/actions/team.removeMember', {
      who: owner,
      origin: ORIGIN,
      body: { memberId: row!.id, deleteAccount: true },
    })
    expect(removing.status).toBe(404)
    expect(await removing.json()).toMatchObject({ code: 'main_host_only' })
    for (const id of [who.userId, removed.userId])
      expect(await db.select({ id: user.id }).from(user).where(eq(user.id, id))).toHaveLength(1)

    // Removing without deleting the account stays possible there.
    const plain = await onHost(HOST, '/v1/actions/team.removeMember', {
      who: owner,
      origin: ORIGIN,
      body: { memberId: row!.id },
    })
    expect(plain.status).toBe(200)
  })

  test('mainHostOnlyAction: deleteAccount set makes leave and remove main-only, nothing else', () => {
    const leave = { name: 'team.leave', permission: 'team:read' } as const
    const remove = { name: 'team.removeMember', permission: 'team:write' } as const
    expect(mainHostOnlyAction(leave, { deleteAccount: true })).toBe(true)
    expect(mainHostOnlyAction(remove, { memberId: 'm', deleteAccount: true })).toBe(true)
    expect(mainHostOnlyAction(leave, { deleteAccount: false })).toBe(false)
    expect(mainHostOnlyAction(remove, { memberId: 'm' })).toBe(false)
    expect(mainHostOnlyAction(leave, undefined)).toBe(false)
  })
})

describe('L-3: a session is bound to the address’s row', () => {
  async function partnerAddress(hostname: string) {
    const partner = await makePartner()
    const id = await addDomain(partner, hostname, 'active')
    const ws = await createWorkspace(`Review ${hostname}`)
    await makeClient(ws.id, partner)
    return { partner, id, ws }
  }
  const works = async (host: string, who: User) => (await onHost(host, '/v1/me', { who })).status

  test('an address that fails ends its sessions; active again, they do not come back', async () => {
    const host = 'app.review-fails.test'
    const { id, ws } = await partnerAddress(host)
    const here = await signInOn(host, ws.owner)
    expect(await works(host, here)).toBe(200)
    await setStatus(id, 'failed')
    expect(await sessionOf(here.headers.cookie!)).toBeUndefined()
    await setStatus(id, 'active')
    expect(await works(host, here)).toBe(401)
  })

  test('an address removed and the name added again: the old session does not come back', async () => {
    const host = 'app.review-readded.test'
    const { partner, id, ws } = await partnerAddress(host)
    const here = await signInOn(host, ws.owner)
    await setStatus(id, 'removed')
    const again = await addDomain(partner, host, 'active')
    expect(again).not.toBe(id)
    expect(await works(host, here)).toBe(401)
    // A new sign-in there is bound to the new row.
    const fresh = await signInOn(host, ws.owner)
    expect(await sessionOf(fresh.headers.cookie!)).toMatchObject({ host, hostDomainId: again })
  })

  test('a suspended partner’s sessions end; approved again, they do not come back', async () => {
    const host = 'app.review-suspended.test'
    const { partner, ws } = await partnerAddress(host)
    const here = await signInOn(host, ws.owner)
    await db
      .update(partners)
      .set({ status: 'suspended', suspended_at: new Date().toISOString() })
      .where(eq(partners.id, partner))
    await reloadHosts()
    expect(await sessionOf(here.headers.cookie!)).toBeUndefined()
    await db.update(partners).set({ status: 'approved', suspended_at: null }).where(eq(partners.id, partner))
    await reloadHosts()
    expect(await works(host, here)).toBe(401)
  })

  test('the same name on another row does not fit', () => {
    const live = { kind: 'partner', partnerId: 'p', domainId: 'pd_new', hostname: HOST, origin: ORIGIN } as const
    expect(sessionFitsHost({ host: HOST, hostDomainId: 'pd_new' }, live)).toBe(true)
    expect(sessionFitsHost({ host: HOST, hostDomainId: 'pd_old' }, live)).toBe(false)
    expect(sessionFitsHost({ host: HOST, hostDomainId: null }, live)).toBe(false)
    expect(sessionFitsHost({ host: null, hostDomainId: null }, { kind: 'main' })).toBe(true)
  })
})

describe('I-1: profile pictures on a partner’s address', () => {
  test('only of people who share one of that partner’s client workspaces', async () => {
    const { who } = await clientMember()
    // A co-member of the client only through a workspace of no partner.
    await auth.api.addMember({ body: { userId: who.userId, organizationId: own.id, role: 'member' } })
    const png = Buffer.from('not decoded here').toString('base64')
    for (const id of [own.owner.userId, client.owner.userId])
      await db.insert(user_avatars).values({ user_id: id, png, version: 'v1' }).onConflictDoNothing()
    const here = await signInOn(HOST, who)
    expect((await onHost(HOST, `/v1/avatars/${own.owner.userId}.png`, { who: here })).status).toBe(404)
    expect((await onHost(HOST, `/v1/avatars/${client.owner.userId}.png`, { who: here })).status).toBe(200)
    // On the install's own address the shared workspace of no partner counts.
    expect((await onHost(MAIN_HOST, `/v1/avatars/${own.owner.userId}.png`, { who })).status).toBe(200)
  })
})

describe('I-3: an address map that cannot be loaded fails closed for partner addresses', () => {
  test('older than HOSTS_FAIL_CLOSED_MS, no partner address resolves; the install’s own still does', async () => {
    await reloadHosts()
    expect(resolveHost(HOST).kind).toBe('partner')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOSTS_FAIL_CLOSED_MS + 1000 })
    expect(resolveHost(HOST).kind).toBe('unknown')
    expect(resolveHost(MAIN_HOST).kind).toBe('main')
    vi.useRealTimers()
    await reloadHosts()
    expect(resolveHost(HOST).kind).toBe('partner')
  })
})
