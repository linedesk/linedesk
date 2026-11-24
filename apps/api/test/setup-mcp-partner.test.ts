// A white-label partner owner's setup link (agent-setup.ts, partner keys; agent-first, 2026-11-18): an AI agent sets
// up the partner (company name, brand, team) and its client workspaces, never the partner bill, a new client workspace
// (a seat on the bill), a number or a real call, another partner, the owner's own business or the server. In
// INSTANCE_WIDE_FILES: it makes a server admin, who creates the partners.
import { agent_setup_keys, billing_accounts, organization, partners, session, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, onTestFinished, test } from 'vitest'
import { partnerSetupActor, setupActorIn } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { type Email, emailSender } from '../src/email.ts'
import { EMAIL_NOT_VERIFIED, PARTNER_KEY_SCOPE, runAction } from '../src/run-action.ts'
import { act, appRequest, asServerAdmin, FROM, randomIp, request, signUp, type User } from './helpers.ts'

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

let id = 0
async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
  const res = await appRequest(`/mcp/setup/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [FROM]: randomIp() },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return { status: res.status, body: JSON.parse(json) as any }
}
const call = (key: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(key, 'tools/call', { name, arguments: args })
// biome-ignore lint/suspicious/noExplicitAny: tool answers are asserted on in the tests
const data = (res: { body: { result: { structuredContent: any } } }) => res.body.result.structuredContent
const errorText = (res: { body: { result: { isError?: boolean; content: { text: string }[] } } }) =>
  res.body.result.isError ? res.body.result.content[0]!.text : null
const toolNames = async (key: string) =>
  ((await mcp(key, 'tools/list')).body.result.tools as { name: string }[]).map(t => t.name)

let admin: User

/** A partner made by a server admin and approved, its owner signed up and joined through the emailed link. */
async function makePartner(name: string) {
  const ownerEmail = newEmail('owner')
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  expect(created).toMatchObject({ status: 200, body: { ok: true } })
  const partnerId: string = created.body.data.partner.id
  // Without billing (the test install) client workspaces need the approval.
  expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId }))).status).toBe(200)
  const owner = await signUp(ownerEmail)
  await verify(owner)
  expect(await act(owner, 'partnerInvitation.accept', { token: tokenFor(ownerEmail) })).toMatchObject({ status: 200 })
  return { id: partnerId, owner }
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

async function makePartnerKey(p: Partner) {
  const res = await act(p.owner, 'agentSetup.createPartnerKey', { partnerId: p.id })
  expect(res).toMatchObject({ status: 200, body: { ok: true } })
  return res.body.data as { key: string; keyId: string }
}

let a: Partner
let b: Partner
let clientA: string
let clientB: string
let ownBusiness: string
beforeAll(async () => {
  admin = await signUp()
  a = await makePartner('Northwind Agency')
  b = await makePartner('Southside Digital')
  clientA = await createClient(a, 'Brightwater Plumbing')
  clientB = await createClient(b, 'Lakeside Dental')
  // The partner owner's own business, outside the partner: a partner key never reaches it.
  const own = await asServerAdmin(a.owner, () => request(a.owner, 'POST', '/v1/workspaces', { name: 'Northwind HQ' }))
  expect(own.status).toBe(200)
  ownBusiness = own.body.workspace.id
})

describe('who makes a partner setup link', () => {
  test("the partner's owner; never a partner admin or someone outside the partner", async () => {
    const made = await makePartnerKey(a)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, made.keyId))
    expect(row).toMatchObject({ partner_id: a.id, workspace_id: null, role: null })
    const partnerAdmin = await addPartnerAdmin(a)
    expect((await act(partnerAdmin, 'agentSetup.createPartnerKey', { partnerId: a.id })).status).toBe(403)
    // Another partner's owner, for this partner.
    expect((await act(b.owner, 'agentSetup.createPartnerKey', { partnerId: a.id })).status).toBe(403)
    // Someone on no partner team and in no workspace: no account context at all (401, as partners.test.ts).
    expect((await act(await signUp(), 'agentSetup.createPartnerKey', { partnerId: a.id })).status).toBe(401)
  })

  test('the owner confirms the email first (NEEDS_CONFIRMED_EMAIL, as email-confirmation.test.ts for a workspace)', async () => {
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, a.owner.userId))
    try {
      expect(await act(a.owner, 'agentSetup.createPartnerKey', { partnerId: a.id })).toMatchObject({
        status: 403,
        body: { code: EMAIL_NOT_VERIFIED },
      })
    } finally {
      await verify(a.owner)
    }
    await makePartnerKey(a)
  })

  test('the page reads its link and progress; nobody else does', async () => {
    await makePartnerKey(a)
    const page = await request(a.owner, 'GET', `/v1/partner/agent-setup?partnerId=${a.id}`)
    expect(page.status).toBe(200)
    expect(page.body.key).toBeTruthy()
    expect(page.body.progress.steps.map((s: { id: string }) => s.id).slice(0, 4)).toEqual([
      'company',
      'brand',
      'team',
      'clients',
    ])
    expect(page.body.progress.workspaces.map((w: { id: string }) => w.id)).toEqual([clientA])
    expect((await request(b.owner, 'GET', `/v1/partner/agent-setup?partnerId=${a.id}`)).status).toBe(403)
  })

  // The page's checklist is written in its reader's language (2026-11-18): it showed English in the German app. The MCP
  // and the CLI stay English.
  test("the page's checklist is in the reader's language", async () => {
    const label = async () => {
      const page = await request(a.owner, 'GET', `/v1/partner/agent-setup?partnerId=${a.id}`)
      return (page.body.progress.steps as { id: string; label: string }[]).find(s => s.id === 'brand')?.label
    }
    expect(await label()).toBe('Your brand')
    await db.update(user).set({ locale: 'de' }).where(eq(user.id, a.owner.userId))
    onTestFinished(() =>
      db
        .update(user)
        .set({ locale: null })
        .where(eq(user.id, a.owner.userId))
        .then(() => {}),
    )
    expect(await label()).toBe('Deine Marke')
  })
})

describe('what a partner setup link reaches', () => {
  test('the partner tools and the workspace setup, never the bill, a seat, a number, a real call or the server', async () => {
    const { key } = await makePartnerKey(a)
    const tools = await toolNames(key)
    expect(tools).toEqual(
      expect.arrayContaining([
        'setup_status',
        'partner_get',
        'partner_update',
        'partnerBrand_get',
        'partnerBrand_set',
        'partnerMember_invite',
        'partner_setSetupStep',
        'workspace_rename',
        'assistant_update',
        'workspace_updateSettings',
        'notifications_update',
        'onboarding_setStep',
        'forwarding_guide',
        'setup_endAccess',
      ]),
    )
    for (const never of [
      'phoneNumber_setup',
      'phoneNumber_checkForwarding',
      'phoneNumber_lookupLine',
      'workspace_create',
      'workspace_createForClient',
      'workspace_inviteClientOwner',
      'partner_releaseClient',
      'partnerMember_remove',
      'providers_list',
      'provider_setKeys',
    ])
      expect(tools).not.toContain(never)
    expect(tools.filter(t => t.startsWith('billing'))).toEqual([])
  })

  test("setup_status: the partner's steps, then its client workspaces only; adding a client is the owner's row", async () => {
    const { key } = await makePartnerKey(a)
    const status = data(await call(key, 'setup_status', { read_only: true }))
    expect(status.you_act_as.role).toBe('partner owner')
    expect(status.partner).toMatchObject({ id: a.id, name: 'Northwind Agency' })
    expect(status.steps.map((s: { id: string; group: string }) => [s.id, s.group])).toEqual([
      ['company', 'partner'],
      ['brand', 'partner'],
      ['team', 'partner'],
      ['clients', 'partner'],
    ])
    // The partner admin added above: the team step is done.
    const byId = Object.fromEntries(status.steps.map((s: { id: string }) => [s.id, s]))
    expect(byId.team.state).toBe('done')
    expect(byId.clients.state).toBe('done')
    // The owner's own business and the other partner's client are not there.
    expect(status.workspaces.map((w: { id: string }) => w.id)).toEqual([clientA])
    const phone = status.workspaces[0].steps.find((s: { id: string }) => s.id === 'phone')
    expect(phone.state).toBe('admin_only')
    expect(phone.how.join(' ')).toContain('Only the partner owner adds the number')
  })

  test('a client workspace\'s steps speak about the client; the client\'s own owner and a business keep "Your …"', async () => {
    // Janik, 2026-11-18: a partner (its key, or one of its team in the client workspace) reads the client's words.
    const label = (steps: { id: string; label: string; hint?: string }[], id: string) => steps.find(s => s.id === id)
    // A partner of its own: setup links per person are limited (allowWorkspaceKeyMint).
    const c = await makePartner('Clearwater Studio')
    const client = await createClient(c, 'Harbor Dental')
    const made0 = await asServerAdmin(c.owner, () =>
      request(c.owner, 'POST', '/v1/workspaces', { name: 'Clearwater HQ' }),
    )
    expect(made0.status).toBe(200)
    const ownWs: string = made0.body.workspace.id
    const { key } = await makePartnerKey(c)
    const status = data(await call(key, 'setup_status', { read_only: true }))
    const steps = status.workspaces[0].steps
    expect(label(steps, 'business')).toMatchObject({ label: "Client's business" })
    expect(label(steps, 'assistant')).toMatchObject({ label: "Client's assistant" })
    expect(label(steps, 'pickup')?.hint).toBe('calls the client misses, after hours, or every call')
    expect(label(steps, 'phone')?.hint).toBe("a new number, or forwarding from the client's")
    // The partner owner's own setup link in the client workspace (a workspace link, through the partner's team).
    const [before] = await db.select().from(session).where(eq(session.userId, c.owner.userId))
    onTestFinished(async () => {
      await db
        .update(session)
        .set({ activeOrganizationId: before!.activeOrganizationId })
        .where(eq(session.userId, c.owner.userId))
    })
    await db.update(session).set({ activeOrganizationId: client }).where(eq(session.userId, c.owner.userId))
    const inClient = { ...c.owner, headers: { ...c.owner.headers, 'x-workspace-id': client } }
    const made = await act(inClient, 'agentSetup.createWorkspaceKey', {})
    expect(made.status).toBe(200)
    const own = data(await call(made.body.data.key, 'setup_status', { read_only: true }))
    expect(label(own.workspaces[0].steps, 'business')).toMatchObject({ label: "Client's business" })
    // The same owner's own business (not through a partner): "Your business".
    await db.update(session).set({ activeOrganizationId: ownWs }).where(eq(session.userId, c.owner.userId))
    const inOwn = { ...c.owner, headers: { ...c.owner.headers, 'x-workspace-id': ownWs } }
    const mine = await act(inOwn, 'agentSetup.createWorkspaceKey', {})
    expect(mine.status).toBe(200)
    const business = data(await call(mine.body.data.key, 'setup_status', { read_only: true }))
    expect(label(business.workspaces[0].steps, 'business')).toMatchObject({ label: 'Your business' })
    expect(label(business.workspaces[0].steps, 'assistant')).toMatchObject({ label: 'Your assistant' })
  })

  test("before the first client: adding one is the owner's row, with the seat price; no workspaces yet", async () => {
    const c = await makePartner('Eastgate Media')
    const { key } = await makePartnerKey(c)
    const status = data(await call(key, 'setup_status', { read_only: true }))
    const clients = status.steps.find((s: { id: string }) => s.id === 'clients')
    expect(clients.state).toBe('admin_only')
    expect(clients.how.join(' ')).toContain('Never add one for them')
    expect(clients.how.join(' ')).toContain('Add client')
    expect(status.workspaces).toEqual([])
    // The company's name was given at sign-up: that step is done, the brand is next.
    expect(status.steps.find((s: { id: string }) => s.id === 'company').state).toBe('done')
    expect(status.next_step).toBe('brand')
  })

  test("before White-label Cloud is paid: the Activate row is the owner's, drafts wait for it, no invitation goes out", async () => {
    // Setup before payment (2026-11-18): a partner whose bill waits for its Checkout.
    const c = await makePartner('Westfield Studio')
    const [bill] = await db
      .insert(billing_accounts)
      .values({ id: crypto.randomUUID(), kind: 'partner', owner_user_id: c.owner.userId, status: 'pending_payment' })
      .returning()
    await db.update(partners).set({ billing_account_id: bill!.id }).where(eq(partners.id, c.id))
    const draft = await createClient(c, 'Draft Bakery')
    const { key } = await makePartnerKey(c)
    const status = data(await call(key, 'setup_status', { read_only: true }))
    expect(status.steps.map((s: { id: string }) => s.id)).toEqual(['company', 'brand', 'team', 'clients', 'plan'])
    const byId = Object.fromEntries(status.steps.map((s: { id: string }) => [s.id, s]))
    expect(byId.plan).toMatchObject({ label: 'Activate White-label Cloud', state: 'admin_only' })
    expect(byId.plan.hint).toMatch(/^\$\d+ a month, plus \$\d+ per client workspace$/)
    expect(byId.plan.how.join(' ')).toContain('no free trial')
    expect(byId.plan.how.join(' ')).toContain('Never start it for them')
    // The team step, once it is next: the invitations wait for the activation.
    expect((await call(key, 'partner_setSetupStep', { step: 'team' })).body.result.isError).toBeFalsy()
    const atTeam = data(await call(key, 'setup_status', { read_only: true }))
    expect(atTeam.next_step).toBe('team')
    const team = atTeam.steps.find((s: { id: string }) => s.id === 'team')
    expect(team.how.join(' ')).toContain('once the partner owner activated White-label Cloud')
    // The draft's number waits for the activation: not the owner's Add number row yet, no card step of its own.
    const steps = status.workspaces.find((w: { id: string }) => w.id === draft).steps
    expect(steps.map((s: { id: string }) => s.id)).not.toContain('activate')
    const phone = steps.find((s: { id: string }) => s.id === 'phone')
    expect(phone.state).toBe('todo')
    // The key has the same limits as the owner: no team invitation (a number is never a key's tool).
    expect(errorText(await call(key, 'partnerMember_invite', { email: newEmail('team') }))).toContain(
      'activate White-label Cloud first',
    )
    // Paid: the row is done.
    await db.update(billing_accounts).set({ status: 'active' }).where(eq(billing_accounts.id, bill!.id))
    await db.update(organization).set({ billingState: 'active' }).where(eq(organization.id, draft))
    const paid = data(await call(key, 'setup_status', { read_only: true }))
    expect(paid.steps.find((s: { id: string }) => s.id === 'plan').state).toBe('done')
  })

  test("the partner's own tools act on its partner only, whatever partnerId the agent sends", async () => {
    const { key } = await makePartnerKey(a)
    const renamed = await call(key, 'partner_update', { name: 'Northwind Agency LLC', partnerId: b.id })
    expect(errorText(renamed)).toBeNull()
    const [mine] = await db.select().from(partners).where(eq(partners.id, a.id))
    const [theirs] = await db.select().from(partners).where(eq(partners.id, b.id))
    expect(mine!.name).toBe('Northwind Agency LLC')
    expect(theirs!.name).toBe('Southside Digital')
    // The step goes on and never back.
    expect(errorText(await call(key, 'partner_setSetupStep', { step: 'team' }))).toBeNull()
    expect(errorText(await call(key, 'partner_setSetupStep', { step: 'team' }))).toBeNull()
    const [after] = await db.select().from(partners).where(eq(partners.id, a.id))
    expect(after!.setup_step).toBe('team')
    // Behind the tools: the key's actor naming another partner is refused by runAction itself.
    const actor = (await partnerSetupActor(a.owner.userId, 'test', a.id))!
    const other = await runAction('partner.update', { partnerId: b.id, name: 'Taken' }, actor)
    expect(other).toMatchObject({ status: 403, body: { error: PARTNER_KEY_SCOPE() } })
  })

  test("business tools: the partner's client workspaces, never the owner's own business or another partner's", async () => {
    const { key } = await makePartnerKey(a)
    expect(
      errorText(await call(key, 'workspace_rename', { workspaceId: clientA, name: 'Brightwater Plumbing Co' })),
    ).toBeNull()
    for (const workspaceId of [ownBusiness, clientB])
      expect(errorText(await call(key, 'workspace_rename', { workspaceId, name: 'Taken' }))).toContain(
        "not one of this partner's client workspaces",
      )
  })

  test('the bill, a seat, a client owner, a number and a real call are refused behind the tools too', async () => {
    const actor = (await partnerSetupActor(a.owner.userId, 'test', a.id))!
    expect(actor.permissions).not.toContain('billing:manage')
    for (const [name, input] of [
      ['billing.startCheckout', { partnerId: a.id, interval: 'month' }],
      ['workspace.createForClient', { partnerId: a.id, name: 'Sneaky Seat' }],
      ['workspace.inviteClientOwner', { partnerId: a.id, workspaceId: clientA, email: newEmail('client') }],
      ['partner.releaseClient', { partnerId: a.id, workspaceId: clientA, confirmName: 'Brightwater Plumbing Co' }],
      ['partnerMember.remove', { partnerId: a.id, userId: b.owner.userId }],
      ['agentSetup.createPartnerKey', { partnerId: a.id }],
    ] as const)
      expect((await runAction(name, input, actor)).status, name).toBe(403)
    // In the client workspace, as the team's admin: no number, forwarding check or lookup.
    const inClient = (await setupActorIn(actor, clientA))!
    expect(inClient.workspaceId).toBe(clientA)
    expect(inClient.permissions).not.toContain('billing:manage')
    for (const [name, input] of [
      ['phoneNumber.setup', { mode: 'new', areaCode: '415', purchase: true }],
      ['phoneNumber.checkForwarding', { phoneNumberId: 'x', businessNumber: '+14155550100' }],
      ['phoneNumber.lookupLine', { number: '+14155550100' }],
    ] as const)
      expect((await runAction(name, input, inClient)).status, name).toBe(403)
    expect(await setupActorIn(actor, ownBusiness)).toBeNull()
    expect(await setupActorIn(actor, clientB)).toBeNull()
  })
})

describe('when a partner setup link ends', () => {
  test('End access on the page, and a suspended partner', async () => {
    const first = await makePartnerKey(a)
    expect((await act(a.owner, 'agentSetup.revokePartner', { partnerId: a.id })).status).toBe(200)
    expect((await mcp(first.key, 'tools/list')).status).toBe(401)
    const second = await makePartnerKey(a)
    expect((await mcp(second.key, 'tools/list')).status).toBe(200)
    expect(await asServerAdmin(admin, () => act(admin, 'partner.suspend', { partnerId: a.id }))).toMatchObject({
      status: 200,
    })
    const ended = await mcp(second.key, 'tools/list')
    expect(ended.status).toBe(401)
    expect(JSON.stringify(ended.body)).toContain('SETUP_KEY_ENDED')
  })
})
