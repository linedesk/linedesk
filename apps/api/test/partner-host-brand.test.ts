// White-label S5 PR 5.3 (docs/white-label.md "Own address"): the brand and the links by address. On a partner's own
// address the sign-in page, the web app manifest and the account emails asked there (sign-in and confirmation codes)
// carry the partner's approved brand, never its draft; every link of a client workspace (invitations, setup emails,
// webhooks, calendar events) goes to the partner's address while it is live (appOrigin, from the database). Writes
// partner addresses, which turn the host check on for the whole install: an instance-wide file (vitest.config.ts).
import { readFileSync } from 'node:fs'
import { calls, partner_branding, partner_members, partners, session, setup_events, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { type Email, type EmailSender, emailSender, envelopeOf } from '../src/email.ts'
import { appOrigin } from '../src/partner-brand.ts'
import { sendSetupEmailFor } from '../src/setup-emails.ts'
import { setupUnsubscribeToken } from '../src/setup-unsubscribe.ts'
import { callEndPayload } from '../src/webhooks.ts'
import { act, addMember, createWorkspace, request, signUp, type User } from './helpers.ts'
import { addDomain, makeClient, makePartner, onHost, setStatus, signInOn } from './partner-hosts.ts'

const HOST = 'app.cascade-agency.test'
const ORIGIN = `https://${HOST}`
const MAIN = 'http://localhost:5173'
const MAIN_HOST = 'localhost:5173'
/** An address that names neither this product nor its own domain, so an email to it can be checked for "Linedesk". */
const clientEmail = (who: string) => `${who}_${crypto.randomUUID().slice(0, 8)}@brightwater.example`
const NO_INSTALL = /linedesk|powered by|localhost/i

let partnerId: string
let domainId: string
let client: Awaited<ReturnType<typeof createWorkspace>>
/** On the partner's team and an admin of its client: sees the draft on the install's own address only. */
let teamMember: User

/** The partner's brand: approved as "Cascade Desk", its draft renamed since (waiting for review). */
async function brandWithDraft(id: string) {
  await db.insert(partner_branding).values({
    partner_id: id,
    name: 'Cascade Draft',
    color: '#0f766e',
    support_email: 'help@cascade.example',
    terms_url: 'https://cascade.example/terms',
    privacy_url: 'https://cascade.example/privacy',
    revision: 2,
    updated_by: 'cli',
    approved_revision: 1,
    approved_name: 'Cascade Desk',
    approved_support_email: 'help@cascade.example',
    approved_terms_url: 'https://cascade.example/terms',
    approved_privacy_url: 'https://cascade.example/privacy',
    approved_at: new Date().toISOString(),
    approved_by: 'cli',
  })
}

/** Collects what goes out through the install's sender while `run` runs, with the From line it would carry. */
async function capture(run: () => Promise<unknown>) {
  const sent: (Email & { envelope: ReturnType<typeof envelopeOf> })[] = []
  const spy = vi
    .spyOn(emailSender, 'send')
    .mockImplementation(
      async email => void sent.push({ ...email, envelope: envelopeOf(email, 'no-reply@mail.example') }),
    )
  try {
    await run()
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0))
    return sent
  } finally {
    spy.mockRestore()
  }
}

const inWorkspace = async (who: User, workspaceId: string): Promise<User> => {
  await db.update(session).set({ activeOrganizationId: workspaceId }).where(eq(session.userId, who.userId))
  return { ...who, headers: { ...who.headers, 'x-workspace-id': workspaceId } }
}

beforeAll(async () => {
  partnerId = await makePartner()
  await brandWithDraft(partnerId)
  domainId = await addDomain(partnerId, HOST, 'active')
  client = await createWorkspace('Brightwater Plumbing')
  await makeClient(client.id, partnerId)
  teamMember = await addMember(client.id, 'admin')
  await db.insert(partner_members).values({ partner_id: partnerId, user_id: teamMember.userId, role: 'admin' })
})

afterEach(() => vi.restoreAllMocks())

describe('the brand on the partner’s address', () => {
  test('before sign-in: the approved brand, never the draft; the install’s own address keeps the install’s', async () => {
    const here = await onHost(HOST, '/v1/branding')
    expect(here.status).toBe(200)
    expect(await here.json()).toMatchObject({
      name: 'Cascade Desk',
      poweredBy: false,
      starPrompt: false,
      partner: { id: partnerId, supportEmail: 'help@cascade.example', terms: 'https://cascade.example/terms' },
    })
    expect(here.headers.get('vary')).toMatch(/host/i)
    const main = await (await onHost(MAIN_HOST, '/v1/branding')).json()
    expect(main.name).not.toMatch(/Cascade/)
    expect(main.partner ?? null).toBeNull()
  })

  test('after sign-in: the approved brand for everyone there, the team’s draft only on the install’s own address', async () => {
    const onMain = await request(await inWorkspace(teamMember, client.id), 'GET', '/v1/branding')
    expect(onMain.body.name).toBe('Cascade Draft')
    const signedIn = await signInOn(HOST, teamMember)
    const there = await onHost(HOST, '/v1/branding', { who: signedIn })
    expect((await there.json()).name).toBe('Cascade Desk')
    const ownerThere = await signInOn(HOST, client.owner)
    expect((await (await onHost(HOST, '/v1/branding', { who: ownerThere })).json()).name).toBe('Cascade Desk')
  })

  test('the web app manifest names the partner there, the install on its own address', async () => {
    const here = await onHost(HOST, '/v1/branding/manifest.webmanifest')
    expect(here.headers.get('content-type')).toBe('application/manifest+json')
    expect(here.headers.get('vary')).toMatch(/host/i)
    expect(await here.json()).toMatchObject({ name: 'Cascade Desk', short_name: 'Cascade Desk' })
    expect((await (await onHost(MAIN_HOST, '/v1/branding/manifest.webmanifest')).json()).name).not.toMatch(/Cascade/)
  })

  test('the sign-in page’s terms, privacy and support are the partner’s', async () => {
    const res = await onHost(HOST, '/v1/auth-methods')
    expect(res.headers.get('vary')).toMatch(/host/i)
    const methods = await res.json()
    expect(methods.links).toEqual({
      terms: 'https://cascade.example/terms',
      privacy: 'https://cascade.example/privacy',
      supportEmail: 'help@cascade.example',
    })
    expect(methods.mainOrigin).toBe(MAIN)
  })

  test('without an approved brand the address shows the install’s', async () => {
    const other = await makePartner()
    const otherHost = 'app.unbranded-agency.test'
    await addDomain(other, otherHost, 'active')
    const branding = await (await onHost(otherHost, '/v1/branding')).json()
    expect(branding.partner ?? null).toBeNull()
    expect((await (await onHost(otherHost, '/v1/auth-methods')).json()).links).toEqual({
      terms: null,
      privacy: null,
      supportEmail: null,
    })
  })

  test('the partner area’s menu entry: on the partner’s address only that partner, opening at the install’s own', async () => {
    const there = await signInOn(HOST, teamMember)
    const me = await (await onHost(HOST, '/v1/me', { who: there })).json()
    expect(me.partners).toEqual([expect.objectContaining({ id: partnerId, areaOrigin: MAIN })])
    // The client's own owner is on no partner team.
    const owner = await signInOn(HOST, client.owner)
    expect((await (await onHost(HOST, '/v1/me', { who: owner })).json()).partners).toEqual([])
  })
})

describe('account emails asked on the partner’s address', () => {
  test('a sign-in code: the partner’s name, a link to its address (not the Origin sent), and no Linedesk', async () => {
    const email = clientEmail('caller')
    await signUp(email)
    const sent = await capture(async () => {
      // A page of the install's own may ask too (a trusted origin there): the link still names the partner's address.
      const res = await onHost(HOST, '/api/auth/email-otp/send-verification-otp', {
        origin: MAIN,
        body: { email, type: 'sign-in' },
      })
      expect(res.status).toBe(200)
    })
    const code = sent.find(e => e.to === email)!
    expect(code.subject).toContain('Cascade Desk')
    expect(code.text).toContain(`${ORIGIN}/#sign-in=`)
    expect(code.text).toContain(HOST)
    for (const part of [code.subject, code.text, code.html]) expect(part).not.toMatch(NO_INSTALL)
    expect(code.envelope).toEqual({ from: '"Cascade Desk" <no-reply@mail.example>' })
  })

  test('a confirmation code names the partner’s address and brand', async () => {
    const who = await addMember(client.id, 'member')
    const [account] = await db.select().from(user).where(eq(user.id, who.userId))
    const there = await signInOn(HOST, who)
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, who.userId))
    const sent = await capture(async () => {
      const res = await onHost(HOST, '/api/auth/email-otp/send-verification-otp', {
        who: there,
        origin: ORIGIN,
        body: { email: account!.email, type: 'email-verification' },
      })
      expect(res.status).toBe(200)
    })
    const code = sent.find(e => e.to === account!.email)!
    expect(code.subject).toContain('Cascade Desk')
    expect(code.text).toContain(HOST)
    expect(code.text).not.toContain(MAIN_HOST)
  })

  test('on the install’s own address a code is the install’s, as before', async () => {
    const email = clientEmail('main')
    await signUp(email)
    const sent = await capture(async () => {
      const res = await onHost(MAIN_HOST, '/api/auth/email-otp/send-verification-otp', {
        origin: MAIN,
        body: { email, type: 'sign-in' },
      })
      expect(res.status).toBe(200)
    })
    const code = sent.find(e => e.to === email)!
    expect(code.subject).not.toContain('Cascade')
    expect(code.text).toContain(`${MAIN}/#sign-in=`)
  })
})

describe('links of a client workspace go to the partner’s address (appOrigin)', () => {
  test('while the address is live and the brand may be used; else the install’s own', async () => {
    expect(await appOrigin(client.id)).toBe(ORIGIN)
    const { id: own } = await createWorkspace('No Partner Plumbing')
    expect(await appOrigin(own)).toBe(MAIN)
    await setStatus(domainId, 'failed')
    expect(await appOrigin(client.id)).toBe(MAIN)
    await setStatus(domainId, 'active')
    await db
      .update(partners)
      .set({ status: 'suspended', suspended_at: new Date().toISOString() })
      .where(eq(partners.id, partnerId))
    try {
      expect(await appOrigin(client.id)).toBe(MAIN)
    } finally {
      await db.update(partners).set({ status: 'approved', suspended_at: null }).where(eq(partners.id, partnerId))
    }
    // No approved brand: emails go out in the install's brand, so their links stay the install's too.
    const unbranded = await makePartner()
    await addDomain(unbranded, 'app.no-brand-agency.test', 'active')
    const { id: unbrandedClient } = await createWorkspace('Unbranded Client')
    await makeClient(unbrandedClient, unbranded)
    expect(await appOrigin(unbrandedClient)).toBe(MAIN)
    expect(await appOrigin(client.id)).toBe(ORIGIN)
  })

  test('a workspace invitation links to the partner’s address, in its brand', async () => {
    const to = clientEmail('invitee')
    const owner = await inWorkspace(client.owner, client.id)
    const sent = await capture(async () =>
      expect(await act(owner, 'team.invite', { email: to, role: 'member' })).toMatchObject({ status: 200 }),
    )
    const invitation = sent.find(e => e.to === to)!
    expect(invitation.text).toContain(`${ORIGIN}/?invite=`)
    for (const part of [invitation.subject, invitation.text, invitation.html]) expect(part).not.toMatch(NO_INSTALL)
  })

  test('the after-call webhook’s call_url', async () => {
    const payload = await callEndPayload(db, client.id, client.call.id)
    expect(payload?.call_url).toBe(`${ORIGIN}/#call/${client.call.id}`)
  })

  test('setup emails and their one-click unsubscribe link; the unsubscribe page names the partner', async () => {
    const ws = await createWorkspace('Brightwater Setup')
    await db.delete(calls).where(eq(calls.id, ws.call.id))
    await makeClient(ws.id, partnerId)
    await db
      .update(setup_events)
      .set({ at: new Date(Date.now() - 3 * 3_600_000).toISOString() })
      .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))
    const sent: Email[] = []
    const sender: EmailSender = {
      kind: 'smtp',
      send: async email => void sent.push(email),
      check: async () => ({ ok: true, message: '' }),
    }
    expect(await sendSetupEmailFor(db, sender, ws.id, new Date().toISOString())).toMatchObject({ sent: 1 })
    const email = sent[0]!
    expect(email.text).toContain(ORIGIN)
    expect(email.text).not.toContain(MAIN_HOST)
    expect(email.headers?.['List-Unsubscribe']).toContain(`<${ORIGIN}/api/unsubscribe/setup?t=`)
    const page = await onHost(HOST, `/api/unsubscribe/setup?t=${setupUnsubscribeToken(ws.id, ws.owner.userId)}`)
    const html = await page.text()
    expect(html).toContain('Cascade Desk')
    expect(html).not.toMatch(/linedesk/i)
  })

  test('every workspace link builder takes the workspace’s address, never WEB_ORIGIN', () => {
    const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    for (const file of ['team.ts', 'bookings.ts', 'setup-emails.ts', 'setup-unsubscribe.ts'])
      expect(source(file), file).not.toContain('WEB_ORIGIN')
    for (const file of ['team.ts', 'bookings.ts', 'setup-emails.ts', 'webhooks.ts'])
      expect(source(file), file).toMatch(/appOrigin\(workspaceId, tx\)|appOrigin\(invite\.organizationId, tx\)/)
    expect(source('webhooks.ts')).not.toMatch(/#call\/[^\n]*WEB_ORIGIN/)
  })
})
