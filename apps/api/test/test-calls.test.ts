// Test calls from the web app: a token for one new room, signed for the caller's own workspace,
// and the call the agent then opens in that workspace.
import { createHmac } from 'node:crypto'
import { calls, commands, contacts, provider_failures } from '@linedesk/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, anonymous, createWorkspace, type User, type Workspace } from './helpers.ts'
import {
  TEST_CALL_BURST,
  TEST_CALL_TOKEN,
  TEST_CALLS_PER_USER_PER_DAY,
  TEST_CALLS_UNAVAILABLE,
  unanswerable,
} from '../src/test-call.ts'
import { noteAgentSeen } from '../src/admin-overview.ts'
import type { Actor } from '../src/context.ts'

/** A realtime model in env: enough for the voice agent to answer (no provider keys in the shared test database). */
const REALTIME = { OPENAI_REALTIME_API_KEY: 'sk-test-realtime' }
const LIVEKIT = {
  LIVEKIT_URL: 'ws://livekit.internal:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret',
}
const saved = { ...process.env }

let ws: Workspace
let other: Workspace
let admin: User
let member: User
beforeAll(async () => {
  Object.assign(process.env, LIVEKIT, REALTIME, { LIVEKIT_PUBLIC_URL: 'wss://livekit.example.test' })
  noteAgentSeen()
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  admin = await addMember(ws.id, 'admin')
  member = await addMember(ws.id, 'member')
})
// The voice agent checks in every 30 s; a slow run must not look like it stopped.
beforeEach(() => noteAgentSeen())
afterAll(() => {
  process.env = saved
})

/** Checks the HS256 signature with the LiveKit secret and returns the claims. */
function verifiedClaims(token: string) {
  const [head, claims, signature] = token.split('.')
  const expected = createHmac('sha256', LIVEKIT.LIVEKIT_API_SECRET).update(`${head}.${claims}`).digest('base64url')
  expect(signature).toBe(expected)
  return JSON.parse(Buffer.from(claims!, 'base64url').toString())
}

test('an owner gets a token for one new room, dispatching the agent into their own workspace', async () => {
  const { status, body } = await act(ws.owner, 'assistant.startTestCall', {})
  expect(status).toBe(200)
  const { url, token, room, expiresAt } = body.data
  expect(url).toBe('wss://livekit.example.test')
  expect(room).toMatch(/^test-[0-9a-f]{16}$/)
  const claims = verifiedClaims(token)
  expect(claims.iss).toBe('test-key')
  expect(claims.sub).toMatch(/^web-/)
  expect(claims.exp - claims.nbf).toBe(70) // valid for 60 s; nbf is 10 s back for clock skew
  expect(new Date(expiresAt).getTime() / 1000).toBe(claims.exp)
  // Only this room, only the microphone, no data messages, no admin rights.
  expect(claims.video).toEqual({
    roomJoin: true,
    room,
    canPublish: true,
    canPublishSources: ['microphone'],
    canSubscribe: true,
    canPublishData: false,
  })
  expect(claims.roomConfig.maxParticipants).toBe(8) // the caller, the agent, a recording and teammates listening in (call.listen)
  expect(claims.roomConfig.agents).toEqual([
    { agentName: 'linedesk', metadata: JSON.stringify({ source: 'test', workspaceId: ws.id, simulateTransfer: true }) },
  ])
  // The command log keeps that a token was issued, for the limits, never the token.
  const logged = await db
    .select()
    .from(commands)
    .where(and(eq(commands.action, TEST_CALL_TOKEN), eq(commands.actor_id, ws.owner.userId)))
  expect(logged.map(c => c.result)).toContainEqual({ ok: true, rows: {}, data: { room } })
  expect(
    JSON.stringify(await db.execute('select input, result from commands order by created_at desc limit 20')),
  ).not.toContain(token)
})

test('each token is for a different room, and an admin may start one too', async () => {
  const first = (await act(admin, 'assistant.startTestCall', {})).body.data.room
  const second = (await act(admin, 'assistant.startTestCall', {})).body.data.room
  expect(first).not.toBe(second)
})

test('a member, the agent and a signed-out request get no token', async () => {
  expect((await act(member, 'assistant.startTestCall', {})).status).toBe(403)
  expect((await act(agent(ws.id), 'assistant.startTestCall', {})).status).toBe(403)
  expect((await act(anonymous, 'assistant.startTestCall', {})).status).toBe(401)
})

test("another workspace's owner gets a token for their own workspace only", async () => {
  const { body } = await act(other.owner, 'assistant.startTestCall', {})
  expect(JSON.parse(verifiedClaims(body.data.token).roomConfig.agents[0].metadata)).toEqual({
    source: 'test',
    workspaceId: other.id,
    simulateTransfer: true,
  })
})

test('without LiveKit on the server it is a rejection that says so', async () => {
  const url = process.env.LIVEKIT_URL
  delete process.env.LIVEKIT_URL
  try {
    const { status, body } = await act(other.owner, 'assistant.startTestCall', {})
    expect(status).toBe(409)
    expect(body.error).toBe('test calls are not set up: LiveKit is not configured on the server')
  } finally {
    process.env.LIVEKIT_URL = url
  }
})

test('nobody to answer: refused with why for the operator, plainly for everyone else', async () => {
  const operator: Actor = { actorId: 'u_op', role: 'owner', workspaceId: other.id, permissions: ['instance:admin'] }
  const owner: Actor = { ...operator, permissions: [] }
  // The voice agent has not checked in for ten minutes.
  noteAgentSeen(Date.now() - 10 * 60_000)
  try {
    const caller = await addMember(other.id, 'admin')
    expect(await act(caller, 'assistant.startTestCall', {})).toMatchObject({
      status: 409,
      body: { error: TEST_CALLS_UNAVAILABLE },
    })
    expect(await unanswerable(db, operator, Date.now())).toMatch(/voice agent isn't running.*Admin › Overview/)
    expect(await unanswerable(db, owner, Date.now())).toBe(TEST_CALLS_UNAVAILABLE)
  } finally {
    noteAgentSeen()
  }
  // No realtime model and no speech, language model and voice.
  delete process.env.OPENAI_REALTIME_API_KEY
  try {
    expect(await unanswerable(db, operator, Date.now())).toMatch(
      /speech to text, a language model and a voice.*Admin › Providers/,
    )
    expect(await unanswerable(db, owner, Date.now())).toBe(TEST_CALLS_UNAVAILABLE)
    expect((await act(other.owner, 'assistant.startTestCall', {})).body.error).toBe(TEST_CALLS_UNAVAILABLE)
  } finally {
    Object.assign(process.env, REALTIME)
  }
  expect(await unanswerable(db, operator, Date.now())).toBeNull()
})

test('too many test calls in a short time are refused', async () => {
  const caller = await addMember(other.id, 'admin')
  const statuses = []
  for (let i = 0; i <= TEST_CALL_BURST.max; i++)
    statuses.push((await act(caller, 'assistant.startTestCall', {})).status)
  expect(statuses).toEqual([...Array(TEST_CALL_BURST.max).fill(200), 409])
})

test('tokens asked for at once, none used yet, cannot get past the limits', async () => {
  const caller = await addMember(other.id, 'admin')
  const started = await Promise.all(Array.from({ length: 10 }, () => act(caller, 'assistant.startTestCall', {})))
  expect(started.filter(s => s.status === 200)).toHaveLength(TEST_CALL_BURST.max)
  expect(started.filter(s => s.status === 409).every(s => /Too many test calls/.test(s.body.error))).toBe(true)
})

test('the agent opens the test call in the workspace of the dispatch, filed under "Test call"', async () => {
  const first = await act(agent(ws.id), 'call.startTest', { room: 'test-room-1' })
  expect(first.status).toBe(200)
  expect(first.body.data).toMatchObject({
    workspaceId: ws.id,
    assistant: { id: ws.assistant.id },
    contact: { name: 'Test call', phone: 'test' },
  })
  const [call] = await db.select().from(calls).where(eq(calls.id, first.body.data.callId))
  expect(call).toMatchObject({
    workspace_id: ws.id,
    source: 'test',
    room: 'test-room-1',
    status: 'live',
    from_number: 'test',
  })

  // The same contact for every test call of the workspace.
  const second = await act(agent(ws.id), 'call.startTest', { room: 'test-room-2' })
  expect(second.body.data.contact.id).toBe(first.body.data.contact.id)
  expect(
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, ws.id), eq(contacts.phone, 'test'))),
  ).toHaveLength(1)
})

test('a room is one test call: the agent cannot open a second call in it (a rejoin after the room closed)', async () => {
  expect((await act(agent(ws.id), 'call.startTest', { room: 'test-room-once' })).status).toBe(200)
  const again = await act(agent(ws.id), 'call.startTest', { room: 'test-room-once' })
  expect(again).toMatchObject({ status: 409, body: { error: 'this test call has ended: start a new one' } })
})

test(`test calls a day: ${TEST_CALLS_PER_USER_PER_DAY} per user over all workspaces, tokens counted when issued, and the install's limit`, async () => {
  const caller = await addMember(ws.id, 'admin')
  // Tokens this user was issued today, in another workspace too, used or not; ones from yesterday do not count.
  const issued = (n: number, workspaceId: string, minutesAgo = 60) =>
    db.insert(commands).values(
      Array.from({ length: n }, (_, i) => ({
        id: `cmd_tc_${crypto.randomUUID().slice(0, 12)}_${i}`,
        workspace_id: workspaceId,
        actor_id: caller.userId,
        action: TEST_CALL_TOKEN,
        input: {},
        result: { ok: true, rows: {}, data: { room: 'test-x' } },
        created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      })),
    )
  await issued(TEST_CALLS_PER_USER_PER_DAY - 2, ws.id)
  await issued(5, ws.id, 25 * 60)
  expect((await act(caller, 'assistant.startTestCall', {})).status).toBe(200)
  await issued(1, other.id)
  expect(await act(caller, 'assistant.startTestCall', {})).toMatchObject({
    status: 409,
    body: { error: `You made ${TEST_CALLS_PER_USER_PER_DAY} test calls today. Try again tomorrow.` },
  })
  // Someone else may still, until the install's limit is reached.
  expect((await act(ws.owner, 'assistant.startTestCall', {})).status).toBe(200)
  const [{ n }] = (
    await db.execute(
      sql`select count(*)::int as n from commands where action = ${TEST_CALL_TOKEN} and created_at > now() - interval '1 day'`,
    )
  ).rows as [{ n: number }]
  process.env.TEST_CALLS_PER_DAY = String(n)
  const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await act(ws.owner, 'assistant.startTestCall', {})).toMatchObject({
      status: 409,
      body: { error: 'This server has had as many test calls today as it allows. Try again tomorrow.' },
    })
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^ALERT test calls/))
  } finally {
    alert.mockRestore()
    delete process.env.TEST_CALLS_PER_DAY
  }
})

test('a failed stage of the voice pipeline marks the call, once per stage, provider and reason; only the agent reports', async () => {
  const { body } = await act(agent(ws.id), 'call.startTest', { room: 'test-room-voice-failure' })
  const callId = body.data.callId
  const failure = {
    stage: 'tts',
    provider: 'elevenlabs',
    reason: 'no_output',
    message: 'TTS stream completed but no audio was received',
  }
  expect((await act(agent(ws.id), 'call.reportVoiceFailure', { callId, failure })).status).toBe(200)
  expect((await act(agent(ws.id), 'call.reportVoiceFailure', { callId, failure })).status).toBe(200)
  const llm = { stage: 'llm', provider: 'openrouter', reason: 'auth', message: 'No auth credentials found' }
  expect((await act(agent(ws.id), 'call.reportVoiceFailure', { callId, failure: llm })).status).toBe(200)
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  expect(call!.voice_failures).toEqual([
    { ...failure, at: expect.any(String) },
    { ...llm, at: expect.any(String) },
  ])
  // The same failures are the providers' own record (LIN-111): Admin › Providers shows them.
  const recorded = await db.select().from(provider_failures).where(inArray(provider_failures.provider, ['elevenlabs', 'openrouter']))
  expect(recorded.map(r => [r.provider, r.reason, r.source, r.call_id]).sort()).toEqual([
    ['elevenlabs', 'no_output', 'agent', callId],
    ['openrouter', 'auth', 'agent', callId],
  ])
  expect((await act(ws.owner, 'call.reportVoiceFailure', { callId, failure })).status).toBe(403)
  expect(
    (await act(agent(ws.id), 'call.reportVoiceFailure', { callId, failure: { ...failure, stage: 'phone' } })).status,
  ).toBe(422)
  // Another workspace's agent cannot mark this call.
  expect((await act(agent(other.id), 'call.reportVoiceFailure', { callId, failure })).status).not.toBe(200)
})

test('call.startTest needs the agent token and a workspace', async () => {
  expect((await act(agent(), 'call.startTest', { room: 'test-room-3' })).status).toBe(409)
  expect((await act(agent(ws.id, 'wrong-token'), 'call.startTest', { room: 'test-room-3' })).status).toBe(401)
  expect((await act(ws.owner, 'call.startTest', { room: 'test-room-3' })).status).toBe(403)
  expect((await act(agent('ws_does_not_exist'), 'call.startTest', { room: 'test-room-3' })).status).toBe(409)
})

test('a phone call is still filed as a phone call', async () => {
  const { body } = await act(agent(), 'call.start', { from: '+15035550111', to: ws.number })
  const [call] = await db.select().from(calls).where(eq(calls.id, body.data.callId))
  expect(call?.source).toBe('phone')
})

test('call.findForTest finds the newest call between two numbers since a moment, for the agent only', async () => {
  const since = new Date(Date.now() - 1000).toISOString()
  const from = '+19715550188'
  const none = await act(agent(), 'call.findForTest', { from, to: ws.number, since })
  expect(none.body.data).toEqual({
    workspaceId: ws.id,
    call: null,
    turns: { caller: 0, agent: 0, system: 0 },
    lines: [],
    bookingReady: false,
    bookings: [],
  })

  const { body } = await act(agent(), 'call.start', { from, to: ws.number })
  const callId = body.data.callId
  await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'agent', text: 'Hello', atMs: 0 })
  await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'caller', text: 'Hi', atMs: 900 })
  await act(agent(ws.id), 'call.finish', { callId, outcome: 'message', title: 'Test', summary: 'A test.' })
  const found = await act(agent(), 'call.findForTest', { from, to: ws.number, since })
  expect(found.body.data).toMatchObject({
    workspaceId: ws.id,
    call: { id: callId, status: 'completed', outcome: 'message', title: 'Test', action_items: 0 },
    turns: { caller: 1, agent: 1, system: 0 },
  })
  expect(found.body.data.lines).toEqual([
    { speaker: 'agent', text: 'Hello', at_ms: 0 },
    { speaker: 'caller', text: 'Hi', at_ms: 900 },
  ])

  // A no-phone test call is found by its room in the workspace of the business number.
  const test = await act(agent(ws.id), 'call.startTest', { room: 'call-test-room-a' })
  const byRoom = await act(agent(), 'call.findForTest', { to: ws.number, since, room: 'call-test-room-a' })
  expect(byRoom.body.data.call.id).toBe(test.body.data.callId)
  const otherRoom = await act(agent(), 'call.findForTest', { to: ws.number, since, room: 'no-such-room' })
  expect(otherRoom.body.data).toMatchObject({ workspaceId: ws.id, call: null })

  const later = await act(agent(), 'call.findForTest', {
    from,
    to: ws.number,
    since: new Date(Date.now() + 60_000).toISOString(),
  })
  expect(later.body.data.call).toBeNull()
  expect((await act(agent(), 'call.findForTest', { from, to: '+15550000000', since })).status).toBe(409)
  expect((await act(ws.owner, 'call.findForTest', { from, to: ws.number, since })).status).toBe(403)
})
