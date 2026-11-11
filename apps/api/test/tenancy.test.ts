// A caller only ever reaches rows of their own workspace, whatever ids or parameters they send.
import { actions, CLIENT_PROTOCOL, type ActionDef } from '@linedesk/actions'
import { appointment_types, contacts, member, organization, phone_numbers, tableNames, transcript_segments } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { app } from '../src/app.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import {
  act,
  addMember,
  agent,
  anonymous,
  type Caller,
  createWorkspace,
  getAssistant,
  getAssistantCalendar,
  getWebhookEndpoint,
  getCall,
  getContact,
  randomNumber,
  request,
  type User,
  type Workspace,
} from './helpers.ts'

let a: Workspace
let b: Workspace
let memberOfA: User

beforeAll(async () => {
  a = await createWorkspace('Brightwater Plumbing & Heating')
  b = await createWorkspace('Other Business')
  memberOfA = await addMember(a.id, 'member')
})

const patchActions = [...actions.values()].filter(def => def.patch)

/** A valid input for a patch action that targets a row of the given workspace. */
function inputFor(def: ActionDef, ws: Workspace): Record<string, unknown> {
  const extra: Record<string, Record<string, unknown>> = {
    'call.remind': { at: '2030-01-01T09:00:00Z' },
    'call.setActionItems': { items: [{ text: 'changed', done: true }] },
    'call.assign': { userId: null },
  }
  const byTable: Record<string, Record<string, unknown>> = {
    calls: { callId: ws.call.id },
    contacts: { contactId: ws.contact.id, note: 'changed' },
    assistants: { assistantId: ws.assistant.id, greeting: 'changed' },
    assistant_calendars: { assistantCalendarId: ws.assistantCalendar.id, instruction: 'changed' },
    webhook_endpoints: { endpointId: ws.webhookEndpoint.id, enabled: false },
  }
  const input = { ...byTable[def.patch!.table], ...extra[def.name] }
  if (!def.input.safeParse(input).success) {
    throw new Error(`No sample input for patch action ${def.name}: add one here so its tenancy is tested`)
  }
  return input
}

/** Who runs the action in workspace `ws`: its owner, or the agent scoped to it for agent-only actions. */
const callerFor = (def: ActionDef, ws: Workspace): Caller => (def.permission === 'agent' ? agent(ws.id) : ws.owner)

const snapshot = async (ws: Workspace) => [
  await getCall(ws.call.id),
  await getContact(ws.contact.id),
  await getAssistant(ws.assistant.id),
  await getAssistantCalendar(ws.assistantCalendar.id),
  await getWebhookEndpoint(ws.webhookEndpoint.id),
]

/** Patch actions with a server handler of their own say so in their words. */
const notFound: Record<string, string> = { 'webhook.update': 'webhook endpoint not found', 'call.flagUrgent': 'call not found' }

describe('patch actions', () => {
  test.each(patchActions.map(def => [def.name, def] as const))(
    '%s cannot touch a row of another workspace',
    async (name, def) => {
      const before = await snapshot(b)
      const guessed = await act(callerFor(def, a), name, inputFor(def, b))
      expect(guessed).toMatchObject({ status: 409, body: { ok: false, error: notFound[name] ?? `${def.patch!.table} row not found` } })
      // Naming a workspace one is not a member of is refused before the action runs.
      const withHeader = await request(a.owner, 'POST', `/v1/actions/${name}`, inputFor(def, b), {
        'x-workspace-id': b.id,
      })
      expect(withHeader).toMatchObject({ status: 403, body: { code: 'workspace_access_lost' } })
      expect(await snapshot(b)).toEqual(before)
    },
  )

  test.each(patchActions.map(def => [def.name, def] as const))(
    '%s works on a row of the own workspace',
    async (name, def) => {
      const { status, body } = await act(callerFor(def, a), name, inputFor(def, a))
      expect(status).toBe(200)
      expect(body.rows[def.patch!.table]).toMatchObject([{ workspace_id: a.id }])
    },
  )
})

describe('agent-facing actions', () => {
  // Every agent-only action that works on an existing call.
  const onCall = (callId: string): [string, Record<string, unknown>][] => [
    ['call.appendTranscript', { callId, speaker: 'caller', text: 'hi', atMs: 0 }],
    ['call.finish', { callId, summary: 'taken over' }],
    ['call.takeMessage', { callId, message: 'taken over' }],
    ['call.flagUrgent', { callId }],
    ['call.setRecording', { callId }],
    ['call.transfer', { callId, to: '+15035550199', result: 'not_answered' }],
  ]

  // carrier.transferTrunk and carrier.provisionTransferTrunk are scoped by the workspace's numbers, not a call: apps/api/test/carrier-routing.test.ts.
  test('the list above covers every agent-only action except the ones that open or find a call, and the transfer carrier', () => {
    const agentOnly = [...actions.values()].filter(def => def.permission === 'agent').map(def => def.name)
    expect([...onCall('x').map(([name]) => name), 'call.start', 'call.startTest', 'call.findForTest', 'carrier.transferTrunk', 'carrier.provisionTransferTrunk'].sort()).toEqual(agentOnly.sort())
  })

  test('an agent scoped to one workspace cannot write to a call of another', async () => {
    const before = await getCall(b.call.id)
    for (const [name, input] of onCall(b.call.id)) {
      expect(await act(agent(a.id), name, input), name).toMatchObject({ status: 409, body: { ok: false } })
    }
    expect(await getCall(b.call.id)).toEqual(before)
    expect(await db.select().from(transcript_segments).where(eq(transcript_segments.call_id, b.call.id))).toEqual([])
  })

  test('an agent that names no workspace cannot write to any call', async () => {
    const before = await getCall(b.call.id)
    for (const [name, input] of onCall(b.call.id)) {
      expect(await act(agent(), name, input), name).toMatchObject({ status: 409, body: { ok: false } })
    }
    expect(await getCall(b.call.id)).toEqual(before)
  })

  test('a member cannot reach another workspace through agent actions', async () => {
    const before = await getCall(b.call.id)
    for (const who of [a.owner, memberOfA]) {
      for (const [name, input] of onCall(b.call.id)) expect((await act(who, name, input)).status, name).toBe(403)
      expect((await act(who, 'call.start', { from: '+15035550100', to: b.number })).status).toBe(403)
    }
    expect(await getCall(b.call.id)).toEqual(before)
  })
})

describe('handler actions for members', () => {
  test('calendar.findSlots only sees appointment types of the own workspace', async () => {
    const id = `at_${crypto.randomUUID().slice(0, 8)}`
    await db.insert(appointment_types).values({ id, workspace_id: b.id, name: 'Repair visit', duration_min: 60 })
    for (const who of [a.owner, memberOfA, agent(a.id)]) {
      expect(await act(who, 'calendar.findSlots', { appointmentTypeId: id })).toMatchObject({
        status: 409,
        body: { error: 'appointment type not found' },
      })
    }
    expect(await act(b.owner, 'calendar.findSlots', { appointmentTypeId: id })).toMatchObject({
      status: 200,
      body: { data: { appointmentTypeId: id } },
    })
  })

  test("phoneNumber.setup stores the number in the caller's workspace and cannot take a number of another", async () => {
    const e164 = randomNumber()
    const own = await act(a.owner, 'phoneNumber.setup', { e164 })
    expect(own).toMatchObject({ status: 200, body: { rows: { phone_numbers: [{ workspace_id: a.id, e164 }] } } })
    expect(await act(b.owner, 'phoneNumber.setup', { e164 })).toMatchObject({
      status: 409,
      body: { error: `${e164} is already set up` },
    })
    expect((await act(a.owner, 'phoneNumber.setup', { e164: b.number })).status).toBe(409)
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, b.number))).toMatchObject([
      { workspace_id: b.id },
    ])
    // Calls to the new number land in the workspace that set it up.
    const started = await act(agent(), 'call.start', { from: randomNumber(), to: e164 })
    expect(started.body.data.workspaceId).toBe(a.id)
  })
})

test("an idempotency key of another workspace does not return that workspace's result", async () => {
  const key = crypto.randomUUID()
  const first = await act(b.owner, 'contact.update', { contactId: b.contact.id, note: 'private note' }, key)
  expect(first.status).toBe(200)
  const replay = await act(a.owner, 'contact.update', { contactId: b.contact.id, note: 'private note' }, key)
  expect(replay.status).toBe(409)
  expect(JSON.stringify(replay.body)).not.toContain('private note')
})

describe('shape proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubElectric = () => {
    const upstream = vi.fn(
      async (_url: URL) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', upstream)
    return upstream
  }

  test("sends the caller's workspace filter and ignores table and where from the client", async () => {
    const upstream = stubElectric()
    const query = `table=contacts&where=${encodeURIComponent('1 = 1')}&${encodeURIComponent('params[1]')}=${b.id}&columns=id&replica=default&offset=-1&handle=h1`
    const { status } = await request(memberOfA, 'GET', `/v1/shape/calls?${query}`)
    expect(status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
    const url = upstream.mock.calls[0]![0]
    expect(url.origin + url.pathname).toBe('http://electric.test/v1/shape')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      table: 'calls',
      where: 'workspace_id = $1 AND deleted_at IS NULL',
      'params[1]': a.id,
      replica: 'full',
      offset: '-1',
      handle: 'h1',
    })
  })

  test.each(tableNames)('filters %s by workspace', async table => {
    const upstream = stubElectric()
    await request(b.owner, 'GET', `/v1/shape/${table}?offset=-1`)
    const params = Object.fromEntries(upstream.mock.calls[0]![0].searchParams)
    expect(params).toMatchObject({ table, 'params[1]': b.id })
    expect(params.where).toMatch(/^workspace_id = \$1( AND |$)/)
  })

  test('webhook endpoints (their URLs can carry a token) reach owners and admins only', async () => {
    const upstream = stubElectric()
    await request(memberOfA, 'GET', '/v1/shape/webhook_endpoints?offset=-1')
    await request(a.owner, 'GET', '/v1/shape/webhook_endpoints?offset=-1')
    expect(upstream.mock.calls.map(([url]) => url.searchParams.get('where'))).toEqual(['workspace_id = $1 AND false', 'workspace_id = $1'])
  })

  test('the agent reads the workspace it names, and nothing without one', async () => {
    const upstream = stubElectric()
    expect((await request(agent(), 'GET', '/v1/shape/calls?offset=-1')).status).toBe(404)
    expect((await request(agent(a.id, 'wrong-token'), 'GET', '/v1/shape/calls?offset=-1')).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()

    const query = `where=${encodeURIComponent('1 = 1')}&${encodeURIComponent('params[1]')}=${b.id}&offset=-1`
    expect((await request(agent(a.id), 'GET', `/v1/shape/calls?${query}`)).status).toBe(200)
    expect(Object.fromEntries(upstream.mock.calls[0]![0].searchParams)).toMatchObject({
      where: 'workspace_id = $1 AND deleted_at IS NULL',
      'params[1]': a.id,
    })
  })

  test('responses are never stored, not even by the browser (a polled table asks again with the same URL after a write), and vary by caller', async () => {
    const electricHeaders = {
      'cache-control': 'public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746',
      vary: 'accept-encoding',
    }
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: electricHeaders }))
    const res = await app.request('/v1/shape/calls?offset=-1', { headers: a.owner.headers })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const vary = res.headers.get('vary')!.toLowerCase()
    expect(vary).toContain('cookie')
    expect(vary).toContain('authorization')
    expect(vary).toContain('accept-encoding')

    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200 }))
    const bare = await app.request('/v1/shape/calls?offset=-1', { headers: a.owner.headers })
    expect(bare.headers.get('cache-control')).toBe('no-store')
  })

  test("Electric's 401 or 403 is a server fault (502), never the browser's session; its stream-position answers pass through", async () => {
    const answer = (status: number) => vi.stubGlobal('fetch', async () => new Response('{}', { status }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const status of [401, 403, 429]) {
      answer(status)
      expect((await request(a.owner, 'GET', '/v1/shape/calls?offset=-1')).status).toBe(502)
    }
    for (const status of [400, 409]) {
      answer(status)
      expect((await request(a.owner, 'GET', '/v1/shape/calls?offset=-1')).status).toBe(status)
    }
    quiet.mockRestore()
  })

  test('does not proxy tables that are not synced', async () => {
    const upstream = stubElectric()
    for (const table of ['commands', 'user', 'session', 'member']) {
      expect((await request(a.owner, 'GET', `/v1/shape/${table}?offset=-1`)).status).toBe(404)
    }
    expect(upstream).not.toHaveBeenCalled()
  })
})

test('/v1/me lists the workspaces the member belongs to, by name, and no others', async () => {
  const a = await createWorkspace('Zephyr Plumbing')
  const b = await createWorkspace('Alder Heating')
  await createWorkspace('Not Mine Roofing')
  await auth.api.addMember({ body: { userId: a.owner.userId, organizationId: b.id, role: 'member' } })
  const { body } = await request(a.owner, 'GET', '/v1/me')
  expect(body.workspaces).toEqual([
    { id: b.id, name: 'Alder Heating' },
    { id: a.id, name: 'Zephyr Plumbing' },
  ])
})

describe("a tab's workspace (x-workspace-id) must be the session's", () => {
  let home: Workspace
  let side: Workspace
  let both: User // owner of home, member of side
  beforeAll(async () => {
    home = await createWorkspace('Tab Home Plumbing')
    side = await createWorkspace('Tab Side Heating')
    both = home.owner
    await auth.api.addMember({ body: { userId: both.userId, organizationId: side.id, role: 'member' } })
  })
  const switchTo = (workspaceId: string) =>
    request(both, 'POST', '/api/auth/organization/set-active', { organizationId: workspaceId })
  const inTab = (workspaceId: string, name: string, input: unknown) =>
    request(both, 'POST', `/v1/actions/${name}`, input, { 'x-workspace-id': workspaceId })
  const contactsNamed = async (workspaceId: string, name: string) =>
    (await db.select().from(contacts).where(eq(contacts.workspace_id, workspaceId))).filter(c => c.name === name)
  const membershipId = async (userId: string, workspaceId: string) =>
    (await db.select().from(member).where(and(eq(member.userId, userId), eq(member.organizationId, workspaceId))))[0]!.id

  test('a tab still on the old workspace after a switch elsewhere is refused, and writes nowhere', async () => {
    expect((await switchTo(home.id)).status).toBe(200)
    expect((await inTab(home.id, 'call.markRead', { callId: home.call.id })).status).toBe(200)
    // Another tab switches the session to `side`.
    expect((await switchTo(side.id)).status).toBe(200)
    const refused = await inTab(home.id, 'contact.create', { phone: randomNumber(), name: 'Made in the home tab' })
    expect(refused).toMatchObject({ status: 403, body: { ok: false, code: 'workspace_switched', activeWorkspaceId: side.id } })
    expect(await contactsNamed(side.id, 'Made in the home tab')).toEqual([])
    expect(await contactsNamed(home.id, 'Made in the home tab')).toEqual([])
    // The tab that switched works in `side`; without the header the session's workspace is used, as before.
    expect((await inTab(side.id, 'call.markRead', { callId: side.call.id })).status).toBe(200)
    expect((await act(both, 'call.markRead', { callId: side.call.id })).status).toBe(200)
    // Switching back makes the first tab work again.
    expect((await switchTo(home.id)).status).toBe(200)
    expect((await inTab(home.id, 'call.markUnread', { callId: home.call.id })).status).toBe(200)
  })

  test("shapes: the header and the workspace in the URL must both be the session's", async () => {
    expect((await switchTo(home.id)).status).toBe(200)
    const upstream = vi.fn(async (_url: URL) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', upstream)
    const shape = (header: string, inUrl: string) =>
      request(both, 'GET', `/v1/shape/calls?offset=-1&workspace=${inUrl}`, undefined, { 'x-workspace-id': header })
    expect((await shape(home.id, home.id)).status).toBe(200)
    const sent = Object.fromEntries(upstream.mock.calls[0]![0].searchParams)
    expect(sent).toMatchObject({ 'params[1]': home.id })
    expect(sent.workspace).toBeUndefined() // not passed on to Electric
    expect(await shape(side.id, side.id)).toMatchObject({ status: 403, body: { code: 'workspace_switched' } })
    expect(await shape(home.id, side.id)).toMatchObject({ status: 403, body: { code: 'workspace_switched' } })
    expect(await shape(home.id, b.id)).toMatchObject({ status: 403, body: { code: 'workspace_access_lost' } })
    expect(upstream).toHaveBeenCalledOnce()
  })

  test('a member removed from the workspace their tab is on gets "no access", not "signed out"', async () => {
    const tab = { 'x-workspace-id': home.id }
    const leaving = await addMember(home.id, 'member')
    expect((await act(home.owner, 'team.removeMember', { memberId: await membershipId(leaving.userId, home.id) })).status).toBe(200)
    expect(await request(leaving, 'POST', '/v1/actions/call.markDone', { callId: home.call.id }, tab)).toMatchObject({
      status: 403,
      body: { code: 'workspace_access_lost' },
    })
    expect((await request(leaving, 'GET', '/v1/shape/calls?offset=-1', undefined, tab)).status).toBe(403)
    // Without a tab's header (curl, an older page) it stays what it was.
    expect((await request(leaving, 'GET', '/v1/me')).status).toBe(401)

    // Removed from one of two workspaces: the other one is never used in its place.
    const twoOf = await addMember(home.id, 'member')
    await auth.api.addMember({ body: { userId: twoOf.userId, organizationId: side.id, role: 'member' } })
    expect((await act(home.owner, 'team.removeMember', { memberId: await membershipId(twoOf.userId, home.id) })).status).toBe(200)
    const created = await request(twoOf, 'POST', '/v1/actions/contact.create', { phone: randomNumber(), name: 'Lost tab contact' }, tab)
    expect(created).toMatchObject({ status: 403, body: { code: 'workspace_access_lost' } })
    expect(await contactsNamed(side.id, 'Lost tab contact')).toEqual([])
  })

  test('signed out stays 401 with a header, and says so', async () => {
    expect(await request(anonymous, 'GET', '/v1/shape/calls?offset=-1', undefined, { 'x-workspace-id': home.id })).toMatchObject({
      status: 401,
      body: { code: 'signed_out' },
    })
  })

  test('every answer says whether the workspace is disabled, and again once it is enabled', async () => {
    expect((await switchTo(home.id)).status).toBe(200)
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200 }))
    const stateOf = async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
      (await app.request(path, {
        method,
        headers: { ...both.headers, 'x-workspace-id': home.id, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })).headers.get('x-workspace-state')
    expect(await stateOf('/v1/shape/calls?offset=-1')).toBe('active')
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, home.id))
    expect(await stateOf('/v1/shape/calls?offset=-1')).toBe('disabled')
    expect(await stateOf('/v1/actions/call.markRead', 'POST', { callId: home.call.id })).toBe('disabled') // refused (read-only), still says it
    await db.update(organization).set({ disabledAt: null }).where(eq(organization.id, home.id))
    expect(await stateOf('/v1/me')).toBe('active')
  })

  test('the agent names a workspace with the header, as before', async () => {
    expect((await act(agent(home.id), 'call.flagUrgent', { callId: home.call.id })).status).toBe(200)
  })

  test("a page opened for another account (someone else signed in on this browser) is refused, even in a workspace both are in", async () => {
    expect((await switchTo(home.id)).status).toBe(200)
    const name = `Other account ${crypto.randomUUID().slice(0, 6)}`
    const asPage = (account: string) =>
      request(both, 'POST', '/v1/actions/contact.create', { phone: randomNumber(), name }, { 'x-workspace-id': home.id, 'x-linedesk-account': account })
    expect(await asPage('someone-who-signed-out')).toMatchObject({ status: 403, body: { code: 'account_switched' } })
    expect(await contactsNamed(home.id, name)).toEqual([])
    expect((await asPage(both.userId)).status).toBe(200)
  })

  test('a browser page from before the deploy (no protocol, no workspace) is told to reload, and writes nothing', async () => {
    expect((await switchTo(home.id)).status).toBe(200)
    const browser = { 'sec-fetch-site': 'same-origin' }
    const current = { ...browser, 'x-workspace-id': home.id, 'x-linedesk-client': String(CLIENT_PROTOCOL) }
    const outdated = { ok: false, code: 'client_outdated', error: 'Linedesk was updated. Reload the page to continue.' }
    const name = `Old page ${crypto.randomUUID().slice(0, 6)}`
    const create = (headers: Record<string, string>) =>
      request(both, 'POST', '/v1/actions/contact.create', { phone: randomNumber(), name }, headers)
    expect(await create(browser)).toMatchObject({ status: 403, body: outdated })
    expect(await create({ ...browser, 'x-workspace-id': home.id })).toMatchObject({ status: 403, body: outdated }) // a workspace but no protocol
    expect(await contactsNamed(home.id, name)).toEqual([])
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 200 }))
    expect(await request(both, 'GET', '/v1/shape/calls?offset=-1', undefined, browser)).toMatchObject({ status: 403, body: outdated })
    // The current page works; /v1/me (which a page reads before it knows its workspace) is not asked.
    expect((await create(current)).status).toBe(200)
    expect((await request(both, 'GET', `/v1/shape/calls?offset=-1&workspace=${home.id}`, undefined, current)).status).toBe(200)
    expect((await request(both, 'GET', '/v1/me', undefined, browser)).status).toBe(200)
    // Not a browser (API clients, scripts): as before.
    expect((await act(both, 'call.markRead', { callId: home.call.id })).status).toBe(200)
  })
})
