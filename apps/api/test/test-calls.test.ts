// Test calls from the web app: a token for one new room, signed for the caller's own workspace,
// and the call the agent then opens in that workspace.
import { createHmac } from 'node:crypto'
import { calls, contacts } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, anonymous, createWorkspace, type User, type Workspace } from './helpers.ts'

const LIVEKIT = { LIVEKIT_URL: 'ws://livekit.internal:7880', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret' }
const saved = { ...process.env }

let ws: Workspace
let other: Workspace
let admin: User
let member: User
beforeAll(async () => {
  Object.assign(process.env, LIVEKIT, { LIVEKIT_PUBLIC_URL: 'wss://livekit.example.test' })
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  admin = await addMember(ws.id, 'admin')
  member = await addMember(ws.id, 'member')
})
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
  expect(claims.video).toEqual({ roomJoin: true, room, canPublish: true, canPublishSources: ['microphone'], canSubscribe: true, canPublishData: false })
  expect(claims.roomConfig.maxParticipants).toBe(3)
  expect(claims.roomConfig.agents).toEqual([{ agentName: 'linedesk', metadata: JSON.stringify({ source: 'test', workspaceId: ws.id }) }])
  // Nothing is kept in the command log: the result holds a token.
  expect(JSON.stringify(await db.execute('select input from commands order by created_at desc limit 5'))).not.toContain(token)
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
  expect(JSON.parse(verifiedClaims(body.data.token).roomConfig.agents[0].metadata)).toEqual({ source: 'test', workspaceId: other.id })
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

test('too many test calls in a short time are refused', async () => {
  const caller = await addMember(other.id, 'admin')
  const statuses = []
  for (let i = 0; i < 7; i++) statuses.push((await act(caller, 'assistant.startTestCall', {})).status)
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 409])
})

test('the agent opens the test call in the workspace of the dispatch, filed under "Test call"', async () => {
  const first = await act(agent(ws.id), 'call.startTest', { room: 'test-room-1' })
  expect(first.status).toBe(200)
  expect(first.body.data).toMatchObject({ workspaceId: ws.id, assistant: { id: ws.assistant.id }, contact: { name: 'Test call', phone: 'test' } })
  const [call] = await db.select().from(calls).where(eq(calls.id, first.body.data.callId))
  expect(call).toMatchObject({ workspace_id: ws.id, source: 'test', room: 'test-room-1', status: 'live', from_number: 'test' })

  // The same contact for every test call of the workspace.
  const second = await act(agent(ws.id), 'call.startTest', { room: 'test-room-2' })
  expect(second.body.data.contact.id).toBe(first.body.data.contact.id)
  expect(await db.select().from(contacts).where(and(eq(contacts.workspace_id, ws.id), eq(contacts.phone, 'test')))).toHaveLength(1)
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
  const from = '+15035550192'
  const none = await act(agent(), 'call.findForTest', { from, to: ws.number, since })
  expect(none.body.data).toEqual({ workspaceId: ws.id, call: null, turns: { caller: 0, agent: 0, system: 0 }, lines: [] })

  const { body } = await act(agent(), 'call.start', { from, to: ws.number })
  const callId = body.data.callId
  await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'agent', text: 'Hello', atMs: 0 })
  await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'caller', text: 'Hi', atMs: 900 })
  await act(agent(ws.id), 'call.finish', { callId, outcome: 'message', title: 'Test', summary: 'A test.' })
  const found = await act(agent(), 'call.findForTest', { from, to: ws.number, since })
  expect(found.body.data).toMatchObject({ workspaceId: ws.id, call: { id: callId, status: 'completed', outcome: 'message', title: 'Test', action_items: 0 }, turns: { caller: 1, agent: 1, system: 0 } })
  expect(found.body.data.lines).toEqual([{ speaker: 'agent', text: 'Hello', at_ms: 0 }, { speaker: 'caller', text: 'Hi', at_ms: 900 }])

  // A no-phone test call is found by its room in the workspace of the business number.
  const test = await act(agent(ws.id), 'call.startTest', { room: 'call-test-room-a' })
  const byRoom = await act(agent(), 'call.findForTest', { to: ws.number, since, room: 'call-test-room-a' })
  expect(byRoom.body.data.call.id).toBe(test.body.data.callId)
  const otherRoom = await act(agent(), 'call.findForTest', { to: ws.number, since, room: 'no-such-room' })
  expect(otherRoom.body.data).toMatchObject({ workspaceId: ws.id, call: null })

  const later = await act(agent(), 'call.findForTest', { from, to: ws.number, since: new Date(Date.now() + 60_000).toISOString() })
  expect(later.body.data.call).toBeNull()
  expect((await act(agent(), 'call.findForTest', { from, to: '+15550000000', since })).status).toBe(409)
  expect((await act(ws.owner, 'call.findForTest', { from, to: ws.number, since })).status).toBe(403)
})
