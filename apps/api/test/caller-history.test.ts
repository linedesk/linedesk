// call.start tells the agent about a returning caller: their last calls and upcoming bookings, only for the
// contact matched in the same workspace, nothing for a withheld number.
import { appointment_types, bookings, calls, contacts } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, randomNumber } from './helpers.ts'

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function pastCall(workspace_id: string, contact_id: string, days: number, extra: Partial<typeof calls.$inferInsert> = {}) {
  await db.insert(calls).values({
    id: id('call'), workspace_id, contact_id, from_number: '+15035550100', to_number: '+15035550101', status: 'completed',
    started_at: daysFromNow(-days), title: `Call ${days} days ago`, summary: 'Asked about a leak.', outcome: 'message', ...extra,
  })
}

async function booking(workspace_id: string, contact_id: string, typeId: string, days: number, name: string, status: 'confirmed' | 'cancelled' = 'confirmed') {
  await db.insert(bookings).values({
    id: id('bk'), workspace_id, contact_id, appointment_type_id: typeId, start_at: daysFromNow(days), end_at: daysFromNow(days + 0.04),
    status, title: `Repair visit · ${name}`,
  })
}

test('the last three calls and the upcoming bookings under the contact\'s name, capped; none for a withheld number', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  const contactId = ws.contact.id
  await db.update(contacts).set({ name: 'Linda Park' }).where(eq(contacts.id, contactId))
  const typeId = id('at')
  await db.insert(appointment_types).values({ id: typeId, workspace_id: ws.id, name: 'Repair visit', duration_min: 60 })

  await pastCall(ws.id, contactId, 1, { summary: 'x'.repeat(1000), action_items: [{ text: 'Send a quote' }, { text: 'Done already', done: true }] })
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
  expect(history.recentCalls.map((c: { title: string }) => c.title)).toEqual(['Call 1 days ago', 'Call 2 days ago', 'Call 3 days ago'])
  expect(history.recentCalls[0].summary).toHaveLength(240)
  expect(history.recentCalls[0].openSteps).toEqual(['Send a quote'])
  expect(history.recentCalls[0].when).toMatch(/^\w+day, \w+ \d+$/)
  if (body.data.booking?.canChangeBookings) {
    expect(history.upcomingBookings).toHaveLength(1)
    expect(history.upcomingBookings[0]).toMatchObject({ type: 'Repair visit', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
  } else {
    expect(history.upcomingBookings).toEqual([])
  }

  // Another workspace's call from the same number: nothing of this workspace's history.
  const elsewhere = await act(agent(), 'call.start', { from: ws.contact.phone, to: other.number })
  expect(elsewhere.body.data.callerHistory).toEqual({ recentCalls: [], upcomingBookings: [] })
  // A new caller: empty; a withheld number: none at all.
  expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callerHistory.recentCalls).toEqual([])
  expect((await act(agent(), 'call.start', { from: 'anonymous', to: ws.number })).body.data.callerHistory).toBeNull()
})
