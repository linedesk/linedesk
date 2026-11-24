// contact.merge: one person, two contacts → one contact with the picked details, all calls, and the
// old number still leading to it.
import { contacts } from '@linedesk/db'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  act,
  addMember,
  agent,
  createWorkspace,
  getCall,
  getContact,
  randomNumber,
  type User,
  type Workspace,
} from './helpers.ts'

let ws: Workspace
let other: Workspace
let member: User

const newContact = async (workspace: Workspace, over: Partial<typeof contacts.$inferInsert> = {}) =>
  (
    await db
      .insert(contacts)
      .values({
        id: `ct_${crypto.randomUUID().slice(0, 12)}`,
        workspace_id: workspace.id,
        phone: randomNumber(),
        ...over,
      })
      .returning()
  )[0]!

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
})

describe('contact.merge', () => {
  test('the kept contact gets the picked details and every call; the other one leaves Contacts', async () => {
    const mobile = await newContact(ws, { name: 'Sam P.', email: 'sam@example.com', note: 'Has a dog' })
    const call = await act(agent(), 'call.start', { from: mobile.phone, to: ws.number })
    const { status, body } = await act(member, 'contact.merge', {
      keepId: ws.contact.id,
      mergeId: mobile.id,
      name: 'Sam Patel',
      email: 'sam@example.com',
    })
    expect(status).toBe(200)
    expect(body.data).toEqual({ contactId: ws.contact.id, movedCalls: 1 })
    expect(await getContact(ws.contact.id)).toMatchObject({
      name: 'Sam Patel',
      email: 'sam@example.com',
      deleted_at: null,
    })
    expect(await getContact(mobile.id)).toMatchObject({ merged_into: ws.contact.id, deleted_at: expect.any(String) })
    expect((await getCall(call.body.data.callId))!.contact_id).toBe(ws.contact.id)
    expect(body.rows.calls.map((c: { id: string }) => c.id)).toEqual([call.body.data.callId]) // the browser moves them at once
  })

  test('a later call from the merged number lands on the kept contact; it cannot be added again', async () => {
    const landline = await newContact(ws, { name: 'Office line' })
    const keep = await newContact(ws, { name: 'Dana Lee' })
    await act(ws.owner, 'contact.merge', { keepId: keep.id, mergeId: landline.id })
    const call = await act(agent(), 'call.start', { from: landline.phone, to: ws.number })
    expect(call.body.data.contact.id).toBe(keep.id)
    expect((await getContact(landline.id))!.deleted_at).not.toBeNull() // not brought back by the call
    expect(await act(ws.owner, 'contact.create', { phone: landline.phone })).toMatchObject({
      status: 409,
      body: { error: `${landline.phone} is already a contact` },
    })

    // Merged again into a third contact: the old number follows in one step.
    const third = await newContact(ws, { name: 'Dana Lee (work)' })
    await act(ws.owner, 'contact.merge', { keepId: third.id, mergeId: keep.id })
    expect((await getContact(landline.id))!.merged_into).toBe(third.id)
    expect((await act(agent(), 'call.start', { from: landline.phone, to: ws.number })).body.data.contact.id).toBe(
      third.id,
    )
  })

  test('a blocked caller stays blocked after the merge', async () => {
    const blocked = await newContact(ws, { blocked_at: new Date().toISOString() })
    const keep = await newContact(ws)
    await act(ws.owner, 'contact.merge', { keepId: keep.id, mergeId: blocked.id })
    expect((await getContact(keep.id))!.blocked_at).not.toBeNull()
  })

  test('only contacts of the own workspace, two different ones, both still there', async () => {
    const mine = await newContact(ws)
    const theirs = await newContact(other)
    expect(await act(ws.owner, 'contact.merge', { keepId: mine.id, mergeId: theirs.id })).toMatchObject({
      status: 409,
      body: { error: 'contact not found' },
    })
    expect(await act(ws.owner, 'contact.merge', { keepId: theirs.id, mergeId: mine.id })).toMatchObject({ status: 409 })
    expect((await getContact(theirs.id))!.deleted_at).toBeNull()
    expect(await act(ws.owner, 'contact.merge', { keepId: mine.id, mergeId: mine.id })).toMatchObject({
      status: 409,
      body: { error: 'pick two different contacts' },
    })
  })
})
