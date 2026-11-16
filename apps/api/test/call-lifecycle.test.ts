// What the voice agent writes during a call: start, transcript, finish.
import { readFileSync } from 'node:fs'
import { assistants, calls, contacts, phone_numbers, transcript_segments } from '@linedesk/db'
import { DEFAULT_TRANSFERS } from '@linedesk/db/types'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { keptUrgent, LIVE_CALLS_PER_WORKSPACE, MESSAGES_PER_CALL } from '../src/handlers.ts'
import { CALL_PUSH, setJobQueue } from '../src/jobs.ts'
import { act, agent, createWorkspace, getCall, getContact, randomNumber, saveTransferContacts, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
afterEach(() => setJobQueue(null))
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

test('call.transfer records the number and the result and leaves the urgency as it is; members cannot write it', async () => {
  // Its own workspace: the calls of the tests above are still live and count toward the calls at once.
  const ws = await createWorkspace('Transfer Plumbing')
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId: string = body.data.callId
  const refused = await act(ws.owner, 'call.transfer', { callId, to: '+15035550199', result: 'connected' })
  expect(refused.status).toBe(403)
  const premium = await act(agent(ws.id), 'call.transfer', { callId, to: '+19005550199', result: 'connected' })
  expect(premium.status).toBe(422)

  const res = await act(agent(ws.id), 'call.transfer', { callId, to: '+15035550199', result: 'not_answered' })
  expect(res.status).toBe(200)
  expect(await getCall(callId)).toMatchObject({ transfer_to: '+15035550199', transfer_result: 'not_answered', urgency: 'normal', status: 'live' })
  // `urgent` from an older agent changes nothing either, and the call shows the contact's name.
  await saveTransferContacts(ws.assistant.id, ['+15035550187'])
  const billing = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId
  await act(agent(ws.id), 'call.transfer', { callId: billing, to: '+15035550187', name: 'Office', urgent: true, result: 'dialing' })
  expect(await getCall(billing)).toMatchObject({ transfer_name: 'Office', transfer_result: 'dialing', urgency: 'normal' })
})

test('call.transfer limits per workspace: one leg at a time, six started an hour', async () => {
  const limited = await createWorkspace('Limited Plumbing')
  await saveTransferContacts(limited.assistant.id, ['+15035550199'])
  await saveTransferContacts(other.assistant.id, ['+15035550199'])
  const startCall = async () => (await act(agent(), 'call.start', { from: randomNumber(), to: limited.number })).body.data.callId as string
  const transfer = (callId: string, result: string) => act(agent(limited.id), 'call.transfer', { callId, to: '+15035550199', result })

  const first = await startCall()
  expect((await transfer(first, 'dialing')).status).toBe(200)
  expect(await getCall(first)).toMatchObject({ transfer_result: 'dialing', urgency: 'normal' })
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
  // A test call (the call test's simulated on-call person) dials no real phone: it is not limited.
  const testCall = (await act(agent(limited.id), 'call.startTest', { room: 'transfer-limit-test' })).body.data.callId as string
  expect((await transfer(testCall, 'dialing')).status).toBe(200)
})

test('call.transfer: transfers of test calls do not count toward the limits', async () => {
  const tested = await createWorkspace('Tested Plumbing')
  await saveTransferContacts(tested.assistant.id, ['+15035550199'])
  const transfer = (callId: string, result: string) => act(agent(tested.id), 'call.transfer', { callId, to: '+15035550199', result })
  for (let i = 0; i < 7; i++) {
    const testCall = (await act(agent(tested.id), 'call.startTest', { room: `transfer-count-${i}` })).body.data.callId as string
    expect((await transfer(testCall, 'dialing')).status).toBe(200) // one still dialing does not hold up the next either
  }
  const phoneCall = (await act(agent(), 'call.start', { from: randomNumber(), to: tested.number })).body.data.callId as string
  expect((await transfer(phoneCall, 'dialing')).status).toBe(200)
})

const contact = (over: Record<string, unknown> = {}) => ({
  id: 'oncall', name: 'Mike', number: '+15035550199', condition: 'Urgent: a burst pipe', hours_only: true,
  ring_seconds: 25, if_no_answer: 'message', enabled: true, ...over,
})

test('assistant.update stores the transfer contacts in order; an invalid or Linedesk number is refused', async () => {
  const assistantId = ws.assistant.id
  const list = [contact(), contact({ id: 'office', name: 'Office', number: '+15035550187', condition: 'Billing questions', if_no_answer: 'next' })]
  const ok = await act(ws.owner, 'assistant.update', { assistantId, transfers: list })
  expect(ok.body.rows.assistants).toMatchObject([{ transfers: list }])
  const bad = await act(ws.owner, 'assistant.update', { assistantId, transfers: [contact({ number: '503-555-0199' })] })
  expect(bad.status).toBe(422)
  // A Linedesk number (the workspace's own, or another workspace's) would ring back into Linedesk.
  // Callable US numbers (the helper's random ones may not be valid on-call numbers).
  const own = `+1503248${String(Math.floor(1000 + Math.random() * 9000))}`
  const elsewhere = `+1971248${String(Math.floor(1000 + Math.random() * 9000))}`
  // The business's office line that forwards to its Linedesk number.
  const officeLine = `+1503249${String(Math.floor(1000 + Math.random() * 9000))}`
  await db.insert(phone_numbers).values([
    { id: `pn_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, e164: own, provider: 'dev', forwarded_from: officeLine },
    { id: `pn_${crypto.randomUUID().slice(0, 8)}`, workspace_id: other.id, e164: elsewhere, provider: 'dev' },
  ])
  for (const linedesk of [own, elsewhere]) {
    // Any contact of the list, not only the first.
    const looping = await act(ws.owner, 'assistant.update', { assistantId, transfers: [contact(), contact({ id: 'x', name: 'Desk', number: linedesk })] })
    expect(looping).toMatchObject({ status: 409, body: { error: expect.stringContaining("Desk's number is a Linedesk number") } })
  }
  const forwarding = await act(ws.owner, 'assistant.update', { assistantId, transfers: [contact({ number: officeLine })] })
  expect(forwarding).toMatchObject({ status: 409, body: { error: expect.stringContaining('forwards its calls to Linedesk') } })
  const started = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect(started.body.data.assistant).toMatchObject({ transfers: list })
})

test('a new assistant starts with one inactive contact for callers who ask for a person; a copy does not take the numbers', async () => {
  const created = await act(ws.owner, 'assistant.create', { copyOf: ws.assistant.id })
  const [copy] = await db.select().from(assistants).where(eq(assistants.id, created.body.data.assistantId))
  expect(copy?.transfers).toEqual(DEFAULT_TRANSFERS)
  expect(DEFAULT_TRANSFERS).toMatchObject([{ condition: 'The caller asks to speak to a person', number: null, enabled: true }])
})

test('migration 0070: a contact whose fallback was an urgent message takes a plain message, the rest unchanged', async () => {
  const migrate = readFileSync(new URL('../../../packages/db/migrations/0070_transfers_no_urgent_fallback.sql', import.meta.url), 'utf8')
  const id = `as_mig_urgent_${crypto.randomUUID().slice(0, 8)}`
  const contact = (over: Record<string, unknown>) => ({ id: 'oncall', name: 'On-call', number: '+15035550199', condition: 'Urgent', hours_only: false, ring_seconds: 25, if_no_answer: 'message', enabled: true, ...over })
  const before = [contact({ if_no_answer: 'next' }), contact({ id: 'backup', name: 'Backup', if_no_answer: 'message_urgent' }), contact({ id: 'office', name: 'Office' })]
  await db.insert(assistants).values({ id, workspace_id: ws.id, transfers: before as never })
  await db.execute(sql.raw(migrate.replace('WHERE "transfers"', `WHERE "id" = '${id}' AND "transfers"`)))
  const [row] = await db.select().from(assistants).where(eq(assistants.id, id))
  expect(row?.transfers).toEqual([before[0], { ...before[1], if_no_answer: 'message' }, before[2]])
  await db.delete(assistants).where(eq(assistants.id, id))
})

test('migration 0046: the old on-call number becomes the first contact, before the default one', async () => {
  const statements = readFileSync(new URL('../../../packages/db/migrations/0046_transfer_contacts.sql', import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
  const migrate = statements.find(s => s.includes('UPDATE "assistants"'))!
  const id = (tag: string) => `as_mig_${tag}_${crypto.randomUUID().slice(0, 8)}`
  const [on, off, none] = [id('on'), id('off'), id('none')]
  await db.insert(assistants).values([
    { id: on, workspace_id: ws.id, transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: true },
    { id: off, workspace_id: ws.id, transfer_urgent: false, transfer_number: '+15035550111' },
    { id: none, workspace_id: ws.id },
  ])
  await db.execute(sql.raw(migrate.replace('WHERE "transfer_number" IS NOT NULL', `WHERE "transfer_number" IS NOT NULL AND "id" IN ('${on}', '${off}', '${none}')`)))
  const transfersOf = async (assistantId: string) => (await db.select().from(assistants).where(eq(assistants.id, assistantId)))[0]?.transfers
  expect(await transfersOf(on)).toEqual([
    { id: 'oncall', name: 'On-call', number: '+15035550199', condition: 'Urgent: an emergency that needs a person right now', hours_only: true, ring_seconds: 25, if_no_answer: 'message_urgent', enabled: true },
    ...DEFAULT_TRANSFERS,
  ])
  // Transfer was off: the number is kept, switched off.
  expect(await transfersOf(off)).toMatchObject([{ number: '+15035550111', enabled: false }, { id: 'person' }])
  expect(await transfersOf(none)).toEqual(DEFAULT_TRANSFERS)
  await db.delete(assistants).where(sql`${assistants.id} in (${on}, ${off}, ${none})`)
})

test(`the assistant takes at most ${MESSAGES_PER_CALL} messages on one call`, async () => {
  // A workspace of its own: the calls this file leaves live count toward the calls at once (LIVE_CALLS_PER_WORKSPACE).
  const ws = await createWorkspace('Message Plumbing')
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId: string = body.data.callId
  // A next step that is no message (the note after failed booking changes) takes no slot.
  const note = { text: 'Several tries on the phone to change a booking did not match.' }
  await db.update(calls).set({ action_items: [note] }).where(eq(calls.id, callId))
  for (let i = 1; i <= MESSAGES_PER_CALL; i++) {
    expect((await act(agent(ws.id), 'call.takeMessage', { callId, message: `Message ${i}` })).status).toBe(200)
  }
  const refused = await act(agent(ws.id), 'call.takeMessage', { callId, message: 'One more' })
  expect(refused).toMatchObject({ status: 409, body: { error: expect.stringContaining(`${MESSAGES_PER_CALL} messages are saved on this call already`) } })
  expect((await getCall(callId))?.action_items).toEqual([note, ...Array.from({ length: MESSAGES_PER_CALL }, (_, i) => ({ text: `Message ${i + 1}`, kind: 'message' }))])
})

test('a call flagged urgent while it ran stays urgent and out of Spam, whatever the summary says', async () => {
  const ws = await createWorkspace('Urgent Plumbing')
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId: string = body.data.callId
  expect((await act(agent(ws.id), 'call.flagUrgent', { callId })).status).toBe(200)
  expect((await act(agent(ws.id), 'call.finish', { callId, outcome: 'spam', urgency: 'low', title: 'Prank' })).status).toBe(200)
  expect(await getCall(callId)).toMatchObject({ outcome: 'callback', urgency: 'urgent', title: 'Prank' })

  // A call that was not urgent takes the summary's verdict.
  const plain = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId
  await act(agent(ws.id), 'call.finish', { callId: plain, outcome: 'spam', urgency: 'low' })
  expect(await getCall(plain)).toMatchObject({ outcome: 'spam', urgency: 'low' })
  expect(keptUrgent('urgent', 'booked', 'normal')).toEqual({ outcome: 'booked', urgency: 'urgent' })
})

test(`at most ${LIVE_CALLS_PER_WORKSPACE} calls at once per workspace: the next one is filed as missed, not answered`, async () => {
  const busy = await createWorkspace('Busy Plumbing')
  const pushes: { name: string; data: { callId: string; kind: string } }[] = []
  setJobQueue({ send: async (name: string, data: { callId: string; kind: string }) => void pushes.push({ name, data }) } as never)
  const live = async () => (await db.select().from(calls).where(and(eq(calls.workspace_id, busy.id), eq(calls.status, 'live'), eq(calls.source, 'phone')))).length
  // Test calls from the web app have their own limits: they neither count nor are refused.
  const tests = await Promise.all(Array.from({ length: LIVE_CALLS_PER_WORKSPACE }, (_, i) => act(agent(busy.id), 'call.startTest', { room: `busy-test-${i}` })))
  expect(tests.every(t => t.status === 200 && !t.body.data.busy)).toBe(true)
  // Ten callers at once (the workspace has one live call already): no two see room for the same last line.
  const started = await Promise.all(Array.from({ length: 10 }, () => act(agent(), 'call.start', { from: randomNumber(), to: busy.number })))
  expect(started.every(s => s.status === 200)).toBe(true)
  expect(await live()).toBe(LIVE_CALLS_PER_WORKSPACE)
  const refused = started.filter(s => s.body.data.busy)
  expect(refused).toHaveLength(10 - (LIVE_CALLS_PER_WORKSPACE - 1))
  // An agent of any version hangs up: `blocked` is set too.
  expect(refused.every(s => s.body.data.blocked === true)).toBe(true)
  expect(await getCall(refused[0]!.body.data.callId)).toMatchObject({
    status: 'completed', outcome: 'hangup', title: 'Missed call', unread: true, action_items: [{ text: 'Call back' }], duration_sec: 0,
  })
  // The team gets the usual push for each missed one, and only for those.
  expect(pushes.filter(p => p.name === CALL_PUSH).map(p => p.data).sort((a, b) => a.callId.localeCompare(b.callId)))
    .toEqual(refused.map(s => ({ callId: s.body.data.callId, kind: 'finished' })).sort((a, b) => a.callId.localeCompare(b.callId)))

  // One call ends: the next caller is answered.
  const answered = started.find(s => !s.body.data.busy)!
  expect((await act(agent(busy.id), 'call.finish', { callId: answered.body.data.callId })).status).toBe(200)
  const next = await act(agent(), 'call.start', { from: randomNumber(), to: busy.number })
  expect(next.body.data).toMatchObject({ busy: false, blocked: false })

  // A live call older than the longest call has no agent any more and does not count.
  await db.update(calls).set({ started_at: new Date(Date.now() - 36 * 60_000).toISOString() }).where(and(eq(calls.workspace_id, busy.id), eq(calls.status, 'live')))
  expect((await act(agent(), 'call.start', { from: randomNumber(), to: busy.number })).body.data.busy).toBe(false)
  // Another workspace is not affected.
  expect((await act(agent(), 'call.start', { from: randomNumber(), to: other.number })).body.data.busy).toBe(false)
})
