// One command id, one outcome: replays return the first result and never write again.
import { appointment_types, calls, commands, contacts } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, getCall, getContact, randomNumber, type Workspace } from './helpers.ts'

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})

const recorded = (key: string) => db.select().from(commands).where(eq(commands.id, key))

test('an accepted command replayed does not write again; it returns its rows as they are now (the log keeps them by id)', async () => {
  const key = crypto.randomUUID()
  const first = await act(ws.owner, 'call.markRead', { callId: ws.call.id }, key)
  expect(first).toMatchObject({ status: 200, body: { ok: true, rows: { calls: [{ unread: false }] } } })
  await act(ws.owner, 'call.markUnread', { callId: ws.call.id })
  const before = await getCall(ws.call.id)

  const replay = await act(ws.owner, 'call.markRead', { callId: ws.call.id }, key)
  expect(replay).toEqual({ status: 200, body: { ...first.body, rows: { calls: [before] } } })
  expect(await getCall(ws.call.id)).toEqual(before) // still unread, version untouched
  expect(await recorded(key)).toMatchObject([
    { action: 'call.markRead', workspace_id: ws.id, actor_id: ws.owner.userId, rejected: false },
  ])
})

test('call.start replayed creates one call and one contact', async () => {
  const key = crypto.randomUUID()
  const from = randomNumber()
  const first = await act(agent(), 'call.start', { from, to: ws.number }, key)
  const replay = await act(agent(), 'call.start', { from, to: ws.number }, key)
  expect(first.status).toBe(200)
  // The log keeps call.start by ids only (command-log.ts): the replay has the same rows, and of its data the ids.
  // The call token is shown once: the log, and so a replay, keeps it redacted.
  expect(first.body.data.callToken).toMatch(/^ldcall_/)
  expect(replay.body.rows).toEqual(first.body.rows)
  expect(replay.body.data).toMatchObject({ callId: first.body.data.callId, workspaceId: ws.id, contact: '[omitted]', isNewContact: true, callToken: '[redacted]' })
  expect(await db.select().from(calls).where(eq(calls.from_number, from))).toHaveLength(1)
  expect(await db.select().from(contacts).where(eq(contacts.phone, from))).toHaveLength(1)
})

test('the same key with different input returns the first result and does not apply the second input', async () => {
  const key = crypto.randomUUID()
  const first = await act(ws.owner, 'contact.update', { contactId: ws.contact.id, note: 'first note' }, key)
  const second = await act(ws.owner, 'contact.update', { contactId: ws.contact.id, note: 'second note' }, key)
  expect(second).toEqual(first)
  expect((await getContact(ws.contact.id))?.note).toBe('first note')
  expect(await recorded(key)).toMatchObject([{ input: { contactId: ws.contact.id, note: 'first note' } }])
})

test('a rejected command is recorded, returns 409, and stays rejected when replayed', async () => {
  const key = crypto.randomUUID()
  const callId = `call_${crypto.randomUUID().slice(0, 8)}`
  const first = await act(ws.owner, 'call.markDone', { callId }, key)
  expect(first).toMatchObject({ status: 409, body: { ok: false, error: 'calls row not found' } })
  expect(await recorded(key)).toMatchObject([{ action: 'call.markDone', rejected: true, result: first.body }])

  // Even when the same command could succeed now, the first answer is final.
  await db.insert(calls).values({ id: callId, workspace_id: ws.id, from_number: '+15035550100', to_number: ws.number })
  const replay = await act(ws.owner, 'call.markDone', { callId }, key)
  expect(replay).toEqual(first)
  expect(await getCall(callId)).toMatchObject({ inbox_state: 'open' })
  expect(await recorded(key)).toHaveLength(1)
})

test('invalid input returns 422, writes nothing and records nothing', async () => {
  const key = crypto.randomUUID()
  const before = [await getCall(ws.call.id), await getContact(ws.contact.id)]
  expect((await act(ws.owner, 'call.remind', { callId: ws.call.id, at: 'tomorrow' }, key)).status).toBe(422)
  expect((await act(ws.owner, 'call.markDone', {}, key)).status).toBe(422)
  expect((await act(ws.owner, 'contact.update', { contactId: ws.contact.id, name: 42 }, key)).status).toBe(422)
  expect([await getCall(ws.call.id), await getContact(ws.contact.id)]).toEqual(before)
  expect(await recorded(key)).toEqual([])
  // The key is still free: the corrected command goes through.
  expect((await act(ws.owner, 'call.markDone', { callId: ws.call.id }, key)).status).toBe(200)
})

test('a key cannot be reused for a different action', async () => {
  const key = crypto.randomUUID()
  expect((await act(ws.owner, 'call.markRead', { callId: ws.call.id }, key)).status).toBe(200)
  const other = await act(ws.owner, 'call.delete', { callId: ws.call.id }, key)
  expect(other.status).toBe(409)
  expect(await getCall(ws.call.id)).toMatchObject({ deleted_at: null })
})

test('the same command sent twice at once writes once', async () => {
  const key = crypto.randomUUID()
  const from = randomNumber()
  const results = await Promise.all([1, 2].map(() => act(agent(), 'call.start', { from, to: ws.number }, key)))
  expect(results.map(r => r.status)).toContain(200)
  expect(await db.select().from(calls).where(eq(calls.from_number, from))).toHaveLength(1)
  expect(await recorded(key)).toHaveLength(1)
})

test('a read-only action is not recorded and runs again on every request', async () => {
  const key = crypto.randomUUID()
  const id = `at_${crypto.randomUUID().slice(0, 8)}`
  expect((await act(ws.owner, 'calendar.findSlots', { appointmentTypeId: id }, key)).status).toBe(409)
  await db.insert(appointment_types).values({ id, workspace_id: ws.id, name: 'Repair visit', duration_min: 60 })
  expect((await act(ws.owner, 'calendar.findSlots', { appointmentTypeId: id }, key)).status).toBe(200)
  expect(await recorded(key)).toEqual([])
})
