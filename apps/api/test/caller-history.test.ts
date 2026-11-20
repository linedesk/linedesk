// call.start tells the agent about a returning caller: their last calls and upcoming bookings, only for the
// contact matched in the same workspace, nothing for a withheld number.
import { appointment_types, assistants, bookings, calls, contacts } from '@linedesk/db'
import { eq, inArray, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, getContact, randomNumber } from './helpers.ts'

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function pastCall(
  workspace_id: string,
  contact_id: string,
  days: number,
  extra: Partial<typeof calls.$inferInsert> = {},
) {
  await db.insert(calls).values({
    id: id('call'),
    workspace_id,
    contact_id,
    from_number: '+15035550100',
    to_number: '+15035550101',
    status: 'completed',
    started_at: daysFromNow(-days),
    title: `Call ${days} days ago`,
    summary: 'Asked about a leak.',
    outcome: 'message',
    ...extra,
  })
}

async function booking(
  workspace_id: string,
  contact_id: string,
  typeId: string,
  days: number,
  name: string,
  status: 'confirmed' | 'cancelled' = 'confirmed',
) {
  await db.insert(bookings).values({
    id: id('bk'),
    workspace_id,
    contact_id,
    appointment_type_id: typeId,
    start_at: daysFromNow(days),
    end_at: daysFromNow(days + 0.04),
    status,
    title: `Repair visit · ${name}`,
  })
}

test("the last three calls and the upcoming bookings under the contact's name, capped; none for a withheld number", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  const contactId = ws.contact.id
  await db.update(contacts).set({ name: 'Linda Park', name_source: 'member' }).where(eq(contacts.id, contactId))
  const typeId = id('at')
  await db.insert(appointment_types).values({ id: typeId, workspace_id: ws.id, name: 'Repair visit', duration_min: 60 })

  await pastCall(ws.id, contactId, 1, {
    summary: 'x'.repeat(1000),
    action_items: [{ text: 'Send a quote' }, { text: 'Done already', done: true }],
  })
  await pastCall(ws.id, contactId, 2)
  await pastCall(ws.id, contactId, 3)
  await pastCall(ws.id, contactId, 4) // fourth: left out
  await pastCall(ws.id, contactId, 0.5, { outcome: 'spam' })
  await pastCall(ws.id, contactId, 0.6, { deleted_at: daysFromNow(0) })
  await pastCall(ws.id, contactId, 0.7, { source: 'test' })

  await booking(ws.id, contactId, typeId, 2, 'Linda Park')
  await booking(ws.id, contactId, typeId, 3, 'Sam Patel') // another name: not listed
  await booking(ws.id, contactId, typeId, 4, 'Linda Park', 'cancelled')
  await booking(ws.id, contactId, typeId, -2, 'Linda Park') // past

  const { body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  const history = body.data.callerHistory
  expect(history.recentCalls.map((c: { title: string }) => c.title)).toEqual([
    'Call 1 days ago',
    'Call 2 days ago',
    'Call 3 days ago',
  ])
  expect(history.recentCalls[0].summary).toHaveLength(240)
  expect(history.recentCalls[0].openSteps).toEqual(['Send a quote'])
  expect(history.recentCalls[0].when).toMatch(/^\w+day, \w+ \d+$/)
  if (body.data.booking?.canChangeBookings) {
    expect(history.upcomingBookings).toHaveLength(1)
    expect(history.upcomingBookings[0]).toMatchObject({
      type: 'Repair visit',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
  } else {
    expect(history.upcomingBookings).toEqual([])
  }

  // Another workspace's call from the same number: nothing of this workspace's history.
  const elsewhere = await act(agent(), 'call.start', { from: ws.contact.phone, to: other.number })
  expect(elsewhere.body.data.callerHistory).toEqual({ recentCalls: [], upcomingBookings: [] })
  // A new caller: empty; a withheld number: none at all.
  expect(
    (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callerHistory.recentCalls,
  ).toEqual([])
  expect((await act(agent(), 'call.start', { from: 'anonymous', to: ws.number })).body.data.callerHistory).toBeNull()
})

/** One finished phone call from `from`, in which the summary found the caller's name `callerName`. */
async function finishedCall(ws: { id: string; number: string }, from: string, callerName?: string) {
  const { body } = await act(agent(), 'call.start', { from, to: ws.number })
  await act(agent(ws.id), 'call.finish', {
    callId: body.data.callId,
    title: 'Leaking water heater',
    summary: 'Water under the heater.',
    callerName,
  })
  return body.data as { callId: string; contact: { id: string } }
}

test("any matched contact gets its history, also one named only by a caller; the owner's switch off sends none", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const number = randomNumber()
  // The first call: the summary found the caller's name, saved on the new contact as a caller's.
  const first = await finishedCall(ws, number, 'Linda Park')
  expect(await getContact(first.contact.id)).toMatchObject({ name: 'Linda Park', name_source: 'caller' })
  // The next call from that number: its earlier call reaches the assistant (no name check, decision of 2026-11-15).
  const { body } = await act(agent(), 'call.start', { from: number, to: ws.number })
  expect(body.data.contact).toMatchObject({ id: first.contact.id, name: 'Linda Park', name_source: 'caller' })
  expect(body.data.callerHistory.recentCalls.map((c: { title: string }) => c.title)).toEqual(['Leaking water heater'])
  // A later caller's name never replaces it.
  await act(agent(ws.id), 'call.finish', { callId: body.data.callId, callerName: 'Someone Else' })
  expect(await getContact(first.contact.id)).toMatchObject({ name: 'Linda Park', name_source: 'caller' })

  // "Know the caller's previous calls" off: call.start sends no history at all.
  await db
    .update(assistants)
    .set({ behaviours: { caller_history: false } })
    .where(eq(assistants.workspace_id, ws.id))
  const off = await act(agent(), 'call.start', { from: number, to: ws.number })
  expect(off.body.data.callerHistory).toBeNull()
})

test("a name a member typed is the team's: contact.create, contact.update, contact.import", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [typed, renamed, imported] = [randomNumber(), randomNumber(), randomNumber()]
  const created = await act(ws.owner, 'contact.create', { phone: typed, name: 'Dana Ortiz' })
  expect(created.body.rows.contacts).toMatchObject([{ name_source: 'member' }])
  await act(ws.owner, 'contact.import', { rows: [{ phone: imported, name: 'Sam Patel' }] })
  // A caller-named contact a member renames: the new name is the team's.
  const named = await finishedCall(ws, renamed, 'Jo Smith')
  await act(ws.owner, 'contact.update', { contactId: named.contact.id, name: 'Joanne Smith' })
  expect(await getContact(named.contact.id)).toMatchObject({ name: 'Joanne Smith', name_source: 'member' })
  await finishedCall(ws, typed)
  await finishedCall(ws, imported)
  for (const from of [typed, renamed, imported]) {
    const { body } = await act(agent(), 'call.start', { from, to: ws.number })
    expect(body.data.contact.name_source).toBe('member')
    expect(body.data.callerHistory.recentCalls).toHaveLength(1)
  }
})

test("contact.merge: the kept name keeps the source of the contact it came from; a typed one is the team's", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const fromCaller = await finishedCall(ws, randomNumber(), 'Linda Park')
  const fromTeam = (await act(ws.owner, 'contact.create', { phone: randomNumber(), name: 'Linda P.' })).body.data
    .contactId
  const kept = await act(ws.owner, 'contact.merge', {
    keepId: fromTeam,
    mergeId: fromCaller.contact.id,
    name: 'Linda Park',
  })
  expect(kept.body.rows.contacts[0]).toMatchObject({ id: fromTeam, name: 'Linda Park', name_source: 'caller' })
  const other = await finishedCall(ws, randomNumber(), 'Linda')
  const typed = await act(ws.owner, 'contact.merge', {
    keepId: fromTeam,
    mergeId: other.contact.id,
    name: 'Linda Park-Ortiz',
  })
  expect(typed.body.rows.contacts[0]).toMatchObject({ name: 'Linda Park-Ortiz', name_source: 'member' })
})

test("migration 0075: a named contact without calls was named by the team; with calls the name counts as a caller's", async () => {
  const statements = readFileSync(
    new URL('../../../packages/db/migrations/0075_contacts_name_source.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint')
  const backfill = statements.find(s => s.includes('UPDATE "contacts"'))!
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [called, typed, unnamed] = [id('ct'), id('ct'), id('ct')]
  await db.insert(contacts).values([
    { id: called, workspace_id: ws.id, phone: randomNumber(), name: 'Linda Park' },
    { id: typed, workspace_id: ws.id, phone: randomNumber(), name: 'Dana Ortiz' },
    { id: unnamed, workspace_id: ws.id, phone: randomNumber() },
  ])
  await pastCall(ws.id, called, 1)
  const ids = [called, typed, unnamed]
  await db.execute(
    sql.raw(
      backfill.replace(
        'WHERE "name" IS NOT NULL',
        `WHERE "name" IS NOT NULL AND "id" IN (${ids.map(i => `'${i}'`).join(', ')})`,
      ),
    ),
  )
  const rows = await db
    .select({ id: contacts.id, name_source: contacts.name_source })
    .from(contacts)
    .where(inArray(contacts.id, ids))
  expect(Object.fromEntries(rows.map(r => [r.id, r.name_source]))).toEqual({
    [called]: 'caller',
    [typed]: 'member',
    [unnamed]: null,
  })
})
