// What the voice agent writes during a call: start, transcript, finish.
import { calls, contacts, transcript_segments } from '@linedesk/db'
import { asc, eq } from 'drizzle-orm'
import { beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, getCall, getContact, randomNumber, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
})

test('call.start resolves the workspace from the dialled number and creates a contact for a new caller', async () => {
  const from = randomNumber()
  const { status, body } = await act(agent(), 'call.start', { from, to: ws.number })
  expect(status).toBe(200)
  expect(body.data).toMatchObject({ workspaceId: ws.id, isNewContact: true, assistant: { id: ws.assistant.id } })
  expect(body.rows.calls).toMatchObject([
    {
      id: body.data.callId,
      workspace_id: ws.id,
      status: 'live',
      from_number: from,
      to_number: ws.number,
      unread: true,
    },
  ])
  expect(await db.select().from(contacts).where(eq(contacts.phone, from))).toMatchObject([
    { workspace_id: ws.id, name: null },
  ])
})

test('call.start reuses the contact of a known caller', async () => {
  const { body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(body.data).toMatchObject({ isNewContact: false, contact: { id: ws.contact.id, name: 'Known Caller' } })
  expect((await getCall(body.data.callId))?.contact_id).toBe(ws.contact.id)
  expect(await db.select().from(contacts).where(eq(contacts.phone, ws.contact.phone))).toHaveLength(1)
})

test('contacts are per workspace: the same caller dialling another business is a new contact there', async () => {
  const { body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: other.number })
  expect(body.data).toMatchObject({ workspaceId: other.id, isNewContact: true })
  expect(body.data.contact.id).not.toBe(ws.contact.id)
})

test('the dialled number decides the workspace, not the x-workspace-id header', async () => {
  const { body } = await act(agent(other.id), 'call.start', { from: randomNumber(), to: ws.number })
  expect(body.rows.calls).toMatchObject([{ workspace_id: ws.id }])
})

test('call.start is rejected for a number no workspace owns', async () => {
  const to = randomNumber()
  const res = await act(agent(), 'call.start', { from: randomNumber(), to })
  expect(res).toMatchObject({ status: 409, body: { ok: false, error: `no workspace for number ${to}` } })
  expect(await db.select().from(calls).where(eq(calls.to_number, to))).toEqual([])
})

test('a call from start to finish: transcript rows, summary, caller name, rising versions', async () => {
  const from = randomNumber()
  const started = await act(agent(), 'call.start', { from, to: ws.number })
  const { callId, contact } = started.body.data
  const versions = [started.body.rows.calls[0].version as number]

  const lines = [
    { speaker: 'agent', text: 'Thanks for calling Brightwater Plumbing & Heating.', atMs: 0 },
    { speaker: 'caller', text: 'A pipe under my sink burst.', atMs: 4200 },
    {
      speaker: 'system',
      text: 'Flagged as urgent',
      atMs: 5000,
      toolEvent: { tool: 'call.flagUrgent', label: 'Flagged as urgent' },
    },
  ]
  for (const line of lines) {
    const res = await act(agent(ws.id), 'call.appendTranscript', { callId, ...line })
    expect(res.body.rows.transcript_segments).toMatchObject([{ call_id: callId, workspace_id: ws.id, text: line.text }])
  }
  const segments = await db
    .select()
    .from(transcript_segments)
    .where(eq(transcript_segments.call_id, callId))
    .orderBy(asc(transcript_segments.at_ms))
  expect(segments.map(s => [s.speaker, s.at_ms, s.tool_event])).toEqual([
    ['agent', 0, null],
    ['caller', 4200, null],
    ['system', 5000, { tool: 'call.flagUrgent', label: 'Flagged as urgent' }],
  ])

  versions.push((await act(ws.owner, 'call.markRead', { callId })).body.rows.calls[0].version)

  const message = await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Wants a quote too' })
  expect(message.body.rows.calls).toMatchObject([{ action_items: [{ text: 'Wants a quote too' }], urgency: 'normal' }])
  const flagged = await act(agent(ws.id), 'call.flagUrgent', { callId })
  expect(flagged.body.rows.calls).toMatchObject([{ urgency: 'urgent', status: 'live' }])
  versions.push(message.body.rows.calls[0].version, flagged.body.rows.calls[0].version)

  const finished = await act(agent(ws.id), 'call.finish', {
    callId,
    outcome: 'callback',
    title: 'Burst pipe',
    summary: 'Water under the sink.',
    actionItems: [{ text: 'Call back within 15 minutes' }],
    fields: [{ label: 'Address', value: '12 Oak St' }],
    callerName: 'Sarah Whitfield',
  })
  expect(finished.status).toBe(200)
  versions.push(finished.body.rows.calls[0].version)
  expect(await getCall(callId)).toMatchObject({
    status: 'completed',
    outcome: 'callback',
    urgency: 'urgent',
    title: 'Burst pipe',
    summary: 'Water under the sink.',
    action_items: [{ text: 'Call back within 15 minutes' }],
    fields: [{ label: 'Address', value: '12 Oak St' }],
    unread: false,
  })
  const call = await getCall(callId)
  expect(call?.ended_at).not.toBeNull()
  expect(call?.duration_sec).toBeGreaterThanOrEqual(0)
  expect(call?.duration_sec).toBeLessThan(60)

  const named = await getContact(contact.id)
  expect(named?.name).toBe('Sarah Whitfield')
  expect(named!.version).toBeGreaterThan(contact.version)
  expect(versions).toEqual([...versions].sort((x, y) => x - y))
  expect(new Set(versions).size).toBe(versions.length)
})

test('call.finish keeps what it is not given and never renames a known contact', async () => {
  const { body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  const callId: string = body.data.callId
  await db
    .update(calls)
    .set({ title: 'Leak in the basement', summary: 'Set during the call.' })
    .where(eq(calls.id, callId))
  await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Call back after 5 pm' })
  await act(agent(ws.id), 'call.flagUrgent', { callId })

  const res = await act(agent(ws.id), 'call.finish', { callId, callerName: 'Someone Else' })
  expect(res.body.rows.calls).toMatchObject([
    {
      status: 'completed',
      outcome: 'answered',
      urgency: 'urgent',
      title: 'Leak in the basement',
      summary: 'Set during the call.',
      action_items: [{ text: 'Call back after 5 pm' }],
      fields: [],
    },
  ])
  expect(res.body.rows.contacts).toBeUndefined()
  expect((await getContact(ws.contact.id))?.name).toBe('Known Caller')
})

test('transcript and finish are rejected for a call that does not exist', async () => {
  const segment = { callId: 'call_missing', speaker: 'caller', text: 'hi', atMs: 0 }
  expect(await act(agent(ws.id), 'call.appendTranscript', segment)).toMatchObject({
    status: 409,
    body: { error: 'call not found' },
  })
  expect(await act(agent(ws.id), 'call.finish', { callId: 'call_missing' })).toMatchObject({
    status: 409,
    body: { error: 'call not found' },
  })
})

test('after call.start the agent has to name the workspace of the call', async () => {
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const res = await act(agent(), 'call.finish', { callId: body.data.callId })
  expect(res).toMatchObject({ status: 409, body: { error: 'no workspace (send x-workspace-id)' } })
  expect((await getCall(body.data.callId))?.status).toBe('live')
})

test('call.transfer records the number and the result and makes the call urgent; members cannot write it', async () => {
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId: string = body.data.callId
  const refused = await act(ws.owner, 'call.transfer', { callId, to: '+15035550199', result: 'connected' })
  expect(refused.status).toBe(403)
  const premium = await act(agent(ws.id), 'call.transfer', { callId, to: '+19005550199', result: 'connected' })
  expect(premium.status).toBe(422)

  const res = await act(agent(ws.id), 'call.transfer', { callId, to: '+15035550199', result: 'not_answered' })
  expect(res.status).toBe(200)
  expect(await getCall(callId)).toMatchObject({ transfer_to: '+15035550199', transfer_result: 'not_answered', urgency: 'urgent', status: 'live' })
})

test('call.transfer limits per workspace: one leg at a time, six started an hour', async () => {
  const limited = await createWorkspace('Limited Plumbing')
  const startCall = async () => (await act(agent(), 'call.start', { from: randomNumber(), to: limited.number })).body.data.callId as string
  const transfer = (callId: string, result: string) => act(agent(limited.id), 'call.transfer', { callId, to: '+15035550199', result })

  const first = await startCall()
  expect((await transfer(first, 'dialing')).status).toBe(200)
  expect(await getCall(first)).toMatchObject({ transfer_result: 'dialing', urgency: 'urgent' })
  expect((await getCall(first))?.transfer_at).not.toBeNull()
  const second = await startCall()
  expect(await transfer(second, 'dialing')).toMatchObject({ status: 409, body: { error: 'another transfer of this workspace is in progress' } })
  await transfer(first, 'connected')
  expect((await transfer(second, 'dialing')).status).toBe(409) // a connected leg still counts
  await transfer(first, 'not_answered')
  expect((await transfer(second, 'dialing')).status).toBe(200)
  await transfer(second, 'declined')
  // Another workspace is not affected.
  const elsewhere = (await act(agent(), 'call.start', { from: randomNumber(), to: other.number })).body.data.callId
  expect((await act(agent(other.id), 'call.transfer', { callId: elsewhere, to: '+15035550199', result: 'dialing' })).status).toBe(200)

  for (let i = 0; i < 4; i++) {
    const callId = await startCall()
    expect((await transfer(callId, 'dialing')).status).toBe(200)
    await transfer(callId, 'not_answered')
  }
  const seventh = await startCall()
  expect(await transfer(seventh, 'dialing')).toMatchObject({ status: 409, body: { error: 'transfer limit reached: 6 an hour' } })
})

test('assistant.update stores the transfer settings; an invalid on-call number is refused', async () => {
  const assistantId = ws.assistant.id
  const ok = await act(ws.owner, 'assistant.update', { assistantId, transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: true })
  expect(ok.body.rows.assistants).toMatchObject([{ transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: true }])
  const bad = await act(ws.owner, 'assistant.update', { assistantId, transfer_number: '503-555-0199' })
  expect(bad.status).toBe(422)
  const started = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect(started.body.data.assistant).toMatchObject({ transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: true })
})
