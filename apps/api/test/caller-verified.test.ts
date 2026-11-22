// Caller ID is cheap to fake: call.start names the caller (the contact's name, the team's note, the history) only
// when the caller's carrier vouched for the number (STIR/SHAKEN attestation A), unless the assistant's owner turned
// "Recognize callers only when their carrier verified the number" off. Any other call is like one from an unknown number.
import { appointment_types, assistants, bookings, calls, contacts } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace } from './helpers.ts'

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`
const callRow = async (callId: string) => (await db.select().from(calls).where(eq(calls.id, callId)))[0]!

/** A workspace whose contact Linda Park has a note, an earlier call and an upcoming booking. */
async function knownCaller() {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  await db
    .update(contacts)
    .set({ name: 'Linda Park', name_source: 'member', note: 'Gate code 4411' })
    .where(eq(contacts.id, ws.contact.id))
  const typeId = id('at')
  await db.insert(appointment_types).values({ id: typeId, workspace_id: ws.id, name: 'Repair visit', duration_min: 60 })
  const start = new Date(Date.now() + 2 * 86_400_000).toISOString()
  await db.insert(bookings).values({
    id: id('bk'),
    workspace_id: ws.id,
    contact_id: ws.contact.id,
    appointment_type_id: typeId,
    start_at: start,
    end_at: new Date(Date.parse(start) + 3_600_000).toISOString(),
    status: 'confirmed',
    title: 'Repair visit · Linda Park',
  })
  return ws
}

type Started = {
  callId: string
  contact: { id: string; name: string | null; note: string | null; phone: string; name_source: string | null } | null
  callerHistory: unknown
  callerRecognized: boolean
}
const start = async (ws: { number: string; contact: { phone: string } }, extra: Record<string, unknown> = {}) => {
  const res = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number, ...extra })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as Started
}

test('a number the carrier vouched for (A) names the caller: name, note and history', async () => {
  const ws = await knownCaller()
  const data = await start(ws, { attestation: 'A' })
  expect(data.callerRecognized).toBe(true)
  expect(data.contact).toMatchObject({
    id: ws.contact.id,
    name: 'Linda Park',
    note: 'Gate code 4411',
    name_source: 'member',
  })
  expect(data.callerHistory).toMatchObject({ recentCalls: expect.any(Array), upcomingBookings: expect.any(Array) })
  expect(await callRow(data.callId)).toMatchObject({ caller_attestation: 'A', contact_id: ws.contact.id })
})

test('a carrier that says it did not vouch for the number: like an unknown number, only the number, no name, note, history or bookings', async () => {
  const ws = await knownCaller()
  for (const attestation of ['B', 'C', 'failed', 'none']) {
    const data = await start(ws, { attestation })
    expect(data.callerRecognized, String(attestation)).toBe(false)
    expect(data.contact).toEqual(
      expect.objectContaining({
        id: ws.contact.id,
        phone: ws.contact.phone,
        name: null,
        note: null,
        name_source: null,
      }),
    )
    expect(data.callerHistory).toBeNull()
    // The team still sees the call under the contact, with what the carrier said.
    expect(await callRow(data.callId)).toMatchObject({
      contact_id: ws.contact.id,
      caller_attestation: attestation,
    })
    await db.update(calls).set({ status: 'completed' }).where(eq(calls.id, data.callId))
  }
  // The contact itself is unchanged.
  expect((await db.select().from(contacts).where(eq(contacts.id, ws.contact.id)))[0]).toMatchObject({
    name: 'Linda Park',
    note: 'Gate code 4411',
  })
})

test('no attestation at all (a trunk without SIP headers): not verified, the caller is handled like an unknown number', async () => {
  const ws = await knownCaller()
  const data = await start(ws)
  expect(data.callerRecognized).toBe(false)
  expect(data.contact).toEqual(expect.objectContaining({ id: ws.contact.id, name: null, note: null }))
  expect(data.callerHistory).toBeNull()
  expect(await callRow(data.callId)).toMatchObject({ caller_attestation: null, contact_id: ws.contact.id })
})

test('no attestation with the switch off: the caller is named by the number', async () => {
  const ws = await knownCaller()
  await db
    .update(assistants)
    .set({ behaviours: { verified_caller_only: false } })
    .where(eq(assistants.workspace_id, ws.id))
  const data = await start(ws)
  expect(data.callerRecognized).toBe(true)
  expect(data.contact).toMatchObject({ name: 'Linda Park', note: 'Gate code 4411' })
})

test("the owner's switch off: every caller is named by the number, as before", async () => {
  const ws = await knownCaller()
  await db
    .update(assistants)
    .set({ behaviours: { verified_caller_only: false } })
    .where(eq(assistants.workspace_id, ws.id))
  const data = await start(ws, { attestation: 'B' })
  expect(data.callerRecognized).toBe(true)
  expect(data.contact).toMatchObject({ name: 'Linda Park', note: 'Gate code 4411' })
  expect(data.callerHistory).not.toBeNull()
})

test("the carrier's spam flag is kept on the call; a simulated call is always named and never flagged by a phone", async () => {
  const ws = await knownCaller()
  const flagged = await start(ws, { attestation: 'A', spamLikely: true })
  expect(await callRow(flagged.callId)).toMatchObject({ spam_likely: true })
  const plain = await start(ws, { attestation: 'A' })
  expect(await callRow(plain.callId)).toMatchObject({ spam_likely: false })
  const simulated = await start(ws, { source: 'simulated' })
  expect(simulated.callerRecognized).toBe(true)
  expect(simulated.contact).toMatchObject({ name: 'Linda Park' })
  expect(await callRow(simulated.callId)).toMatchObject({ caller_attestation: null, spam_likely: false })
})

test('the agent may only send the known attestations', async () => {
  const ws = await knownCaller()
  const res = await act(agent(), 'call.start', {
    from: ws.contact.phone,
    to: ws.number,
    attestation: 'TN-Validation-Passed',
  })
  expect(res.status).toBe(422)
})
