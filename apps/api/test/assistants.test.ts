// Several assistants per workspace: adding, copying and deleting them, which one answers a number
// or a test call, and that an assistant or number of another workspace is never used.
import { createHmac } from 'node:crypto'
import { DEFAULT_CALL_RULES } from '@linedesk/actions'
import { assistants, calls, phone_numbers } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, getAssistant, getCall, type User, type Workspace } from './helpers.ts'

const LIVEKIT = {
  LIVEKIT_URL: 'ws://livekit.internal:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret-test-secret-test-secret',
}
const saved = { ...process.env }

let ws: Workspace
let other: Workspace
let member: User
beforeAll(async () => {
  Object.assign(process.env, LIVEKIT)
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
})
afterAll(() => {
  process.env = saved
})

const numberRow = async (e164: string) =>
  (await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164)))[0]!
const dispatchMetadata = (token: string) =>
  JSON.parse(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).roomConfig.agents[0].metadata)

describe('assistant.create and assistant.delete', () => {
  test('a new assistant gets a free name, a greeting with it and the default rules', async () => {
    const { status, body } = await act(ws.owner, 'assistant.create', {})
    expect(status).toBe(200)
    const created = await getAssistant(body.data.assistantId)
    expect(created).toMatchObject({ workspace_id: ws.id, name: 'Ava', call_rules: null })
    expect(created!.name).not.toBe(ws.assistant.name)
    expect(created!.greeting).toBe(
      'Thanks for calling Brightwater Plumbing & Heating. This is Ava, the AI assistant. How can I help?',
    )
    expect(DEFAULT_CALL_RULES.length).toBeGreaterThan(0)
  })

  test('a copy keeps greeting, instructions and rules, under a new name', async () => {
    await act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      call_rules: 'Always ask for the address.',
      business_profile: { instructions: 'We fix leaks.' },
    })
    const { body } = await act(ws.owner, 'assistant.create', { copyOf: ws.assistant.id })
    const copy = await getAssistant(body.data.assistantId)
    expect(copy).toMatchObject({
      workspace_id: ws.id,
      name: `${ws.assistant.name} copy`,
      call_rules: 'Always ask for the address.',
      business_profile: { instructions: 'We fix leaks.' },
    })
    expect(copy!.id).not.toBe(ws.assistant.id)
  })

  test('an assistant of another workspace cannot be copied, deleted or picked', async () => {
    expect((await act(ws.owner, 'assistant.create', { copyOf: other.assistant.id })).status).toBe(409)
    expect((await act(ws.owner, 'assistant.delete', { assistantId: other.assistant.id })).status).toBe(409)
    expect(await getAssistant(other.assistant.id)).toBeTruthy()
  })

  test('members cannot add or delete assistants', async () => {
    expect((await act(member, 'assistant.create', {})).status).toBe(403)
    expect((await act(member, 'assistant.delete', { assistantId: ws.assistant.id })).status).toBe(403)
  })

  test('deleting an assistant moves its numbers to the first remaining one; the last one stays', async () => {
    const lone = await createWorkspace('Lone Assistant Co')
    const { body } = await act(lone.owner, 'assistant.create', { name: 'Second' })
    const second = body.data.assistantId as string
    const pn = await numberRow(lone.number)
    expect((await act(lone.owner, 'phoneNumber.update', { phoneNumberId: pn.id, assistantId: second })).status).toBe(
      200,
    )
    expect((await act(lone.owner, 'assistant.delete', { assistantId: second })).status).toBe(200)
    expect(await getAssistant(second)).toBeUndefined()
    expect((await numberRow(lone.number)).assistant_id).toBe(lone.assistant.id)
    const last = await act(lone.owner, 'assistant.delete', { assistantId: lone.assistant.id })
    expect(last.status).toBe(409)
    expect(last.body.error).toBe('a workspace keeps at least one assistant')
  })
})

describe('phoneNumber.update', () => {
  test('a number is answered by the assistant it names; mode can change too', async () => {
    const { body } = await act(ws.owner, 'assistant.create', { name: 'Night' })
    const night = body.data.assistantId as string
    const pn = await numberRow(ws.number)
    const res = await act(ws.owner, 'phoneNumber.update', {
      phoneNumberId: pn.id,
      assistantId: night,
      mode: 'forward_all',
    })
    expect(res.status).toBe(200)
    expect(await numberRow(ws.number)).toMatchObject({ assistant_id: night, mode: 'forward_all' })

    const call = await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })
    expect(call.body.data.assistant).toMatchObject({ id: night, name: 'Night' })
    expect((await getCall(call.body.data.callId))!.assistant_id).toBe(night)
  })

  test('without an assistant of its own a number is answered by the first one', async () => {
    const fresh = await createWorkspace('Fresh Business')
    await act(fresh.owner, 'assistant.create', {})
    const call = await act(agent(), 'call.start', { from: '+15035550178', to: fresh.number })
    expect(call.body.data.assistant.id).toBe(fresh.assistant.id)
  })

  test("another workspace's assistant or number is refused, and nothing changes", async () => {
    const pn = await numberRow(ws.number)
    const before = pn.assistant_id
    expect(
      (await act(ws.owner, 'phoneNumber.update', { phoneNumberId: pn.id, assistantId: other.assistant.id })).status,
    ).toBe(409)
    const otherPn = await numberRow(other.number)
    expect((await act(ws.owner, 'phoneNumber.update', { phoneNumberId: otherPn.id, mode: 'new' })).status).toBe(409)
    expect((await numberRow(ws.number)).assistant_id).toBe(before)
    expect((await numberRow(other.number)).mode).toBe(otherPn.mode)
    expect((await act(member, 'phoneNumber.update', { phoneNumberId: pn.id, mode: 'new' })).status).toBe(403)
  })
})

describe('test calls with a picked assistant', () => {
  test('the dispatch carries an assistant of the workspace, never another one', async () => {
    const { body } = await act(ws.owner, 'assistant.create', { name: 'Tester' })
    const tester = body.data.assistantId as string
    const ok = await act(ws.owner, 'assistant.startTestCall', { assistantId: tester })
    expect(ok.status).toBe(200)
    expect(dispatchMetadata(ok.body.data.token)).toEqual({ source: 'test', workspaceId: ws.id, assistantId: tester })
    const foreign = await act(ws.owner, 'assistant.startTestCall', { assistantId: other.assistant.id })
    expect(foreign.status).toBe(409)
  })

  test('call.startTest answers with the picked assistant and refuses one of another workspace', async () => {
    const { body } = await act(ws.owner, 'assistant.create', { name: 'Picked' })
    const picked = body.data.assistantId as string
    const ok = await act(agent(ws.id), 'call.startTest', { room: 'test-room-picked', assistantId: picked })
    expect(ok.status).toBe(200)
    expect(ok.body.data.assistant.id).toBe(picked)
    expect((await getCall(ok.body.data.callId))!.assistant_id).toBe(picked)
    const foreign = await act(agent(ws.id), 'call.startTest', {
      room: 'test-room-foreign',
      assistantId: other.assistant.id,
    })
    expect(foreign.status).toBe(409)
    expect(await db.select().from(calls).where(eq(calls.room, 'test-room-foreign'))).toHaveLength(0)
  })

  test('the signature still covers the dispatch', async () => {
    const { body } = await act(ws.owner, 'assistant.startTestCall', {})
    const [head, claims, signature] = (body.data.token as string).split('.')
    expect(createHmac('sha256', LIVEKIT.LIVEKIT_API_SECRET).update(`${head}.${claims}`).digest('base64url')).toBe(
      signature,
    )
    expect(dispatchMetadata(body.data.token)).toEqual({ source: 'test', workspaceId: ws.id })
  })
})

test('a workspace starts with exactly one assistant', async () => {
  const fresh = await createWorkspace('One Assistant Co')
  expect(await db.select().from(assistants).where(eq(assistants.workspace_id, fresh.id))).toHaveLength(1)
})
