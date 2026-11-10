// A caller only ever reaches rows of their own workspace, whatever ids or parameters they send.
import { actions, type ActionDef } from '@callfront/actions'
import { appointment_types, phone_numbers, tableNames, transcript_segments } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import {
  act,
  addMember,
  agent,
  type Caller,
  createWorkspace,
  getAssistant,
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
  }
  const byTable: Record<string, Record<string, unknown>> = {
    calls: { callId: ws.call.id },
    contacts: { contactId: ws.contact.id, note: 'changed' },
    assistants: { assistantId: ws.assistant.id, greeting: 'changed' },
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
]

describe('patch actions', () => {
  test.each(patchActions.map(def => [def.name, def] as const))(
    '%s cannot touch a row of another workspace',
    async (name, def) => {
      const before = await snapshot(b)
      const guessed = await act(callerFor(def, a), name, inputFor(def, b))
      expect(guessed).toMatchObject({ status: 409, body: { ok: false, error: `${def.patch!.table} row not found` } })
      // A member cannot pick the workspace with a header either: that is for the agent only.
      const withHeader = await request(a.owner, 'POST', `/v1/actions/${name}`, inputFor(def, b), {
        'x-workspace-id': b.id,
      })
      expect(withHeader.status).toBe(def.permission === 'agent' ? 403 : 409)
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
  ]

  test('the list above covers every agent-only action except call.start', () => {
    const agentOnly = [...actions.values()].filter(def => def.permission === 'agent').map(def => def.name)
    expect([...onCall('x').map(([name]) => name), 'call.start'].sort()).toEqual(agentOnly.sort())
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

  test('does not proxy tables that are not synced', async () => {
    const upstream = stubElectric()
    for (const table of ['commands', 'user', 'session', 'member']) {
      expect((await request(a.owner, 'GET', `/v1/shape/${table}?offset=-1`)).status).toBe(404)
    }
    expect(upstream).not.toHaveBeenCalled()
  })
})
