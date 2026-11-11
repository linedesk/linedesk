// contact.import: new rows become contacts; a row with the number or email of an existing contact
// only fills its empty fields; deleted numbers are skipped; one workspace only.
import { CONTACT_IMPORT_MAX_ROWS } from '@linedesk/actions'
import { contacts } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, createWorkspace, getContact, randomNumber, type User, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
let member: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
})

const byPhone = async (workspaceId: string, phone: string) =>
  (
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, workspaceId), eq(contacts.phone, phone)))
  )[0]

test('new rows are added; existing contacts only get their empty fields filled, by number or by email', async () => {
  await db.update(contacts).set({ email: 'known@example.com', company: null }).where(eq(contacts.id, ws.contact.id))
  const fresh = randomNumber()
  const { status, body } = await act(member, 'contact.import', {
    rows: [
      { phone: fresh, name: 'Grace Lindqvist', email: 'grace@example.com', note: 'Prefers texts' },
      { phone: ws.contact.phone, name: 'Overwritten?', company: 'Known Co' },
      { phone: randomNumber(), email: 'KNOWN@example.com', address: '12 Elm St' },
      { phone: fresh, name: 'Grace again', company: 'Lindqvist Design' }, // the same person twice in the file
    ],
  })
  expect(status).toBe(200)
  expect(body.data).toEqual({ created: 1, updated: 3, unchanged: 0, skipped: 0 })
  expect(await byPhone(ws.id, fresh)).toMatchObject({
    name: 'Grace Lindqvist',
    company: 'Lindqvist Design',
    note: 'Prefers texts',
  })
  expect(await getContact(ws.contact.id)).toMatchObject({
    name: 'Known Caller',
    company: 'Known Co',
    address: '12 Elm St',
  })
  expect(body.rows.contacts.length).toBe(2) // the browser shows them at once
})

test('two rows with one email and different numbers are two contacts, as the preview counts them', async () => {
  const [first, second] = [randomNumber(), randomNumber()]
  const { body } = await act(member, 'contact.import', {
    rows: [
      { phone: first, name: 'Hannah Cole', email: 'hannah@example.com' },
      { phone: second, name: 'Hannah C.', email: 'Hannah@example.com' },
    ],
  })
  expect(body.data).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 0 })
  expect(await byPhone(ws.id, second)).toMatchObject({ name: 'Hannah C.' }) // the second number is not lost
})

test('a number of a deleted contact is skipped, an identical row changes nothing, other workspaces are untouched', async () => {
  const gone = randomNumber()
  await db
    .insert(contacts)
    .values({
      id: `ct_${crypto.randomUUID().slice(0, 12)}`,
      workspace_id: ws.id,
      phone: gone,
      deleted_at: new Date().toISOString(),
    })
  const theirs = await byPhone(other.id, other.contact.phone)
  const { body } = await act(ws.owner, 'contact.import', {
    rows: [
      { phone: gone, name: 'Back?' },
      { phone: ws.contact.phone, name: 'Known Caller' },
      { phone: other.contact.phone, name: 'Mine now' },
    ],
  })
  expect(body.data).toEqual({ created: 1, updated: 0, unchanged: 1, skipped: 1 })
  expect((await byPhone(ws.id, gone))!.deleted_at).not.toBeNull()
  expect(await byPhone(other.id, other.contact.phone)).toEqual(theirs)
  expect((await byPhone(ws.id, other.contact.phone))!.name).toBe('Mine now')
})

test(`numbers must be E.164 and a request takes at most ${CONTACT_IMPORT_MAX_ROWS} rows`, async () => {
  expect((await act(ws.owner, 'contact.import', { rows: [{ phone: '503-555-0142' }] })).status).toBe(422)
  const many = Array.from({ length: CONTACT_IMPORT_MAX_ROWS + 1 }, () => ({ phone: randomNumber() }))
  expect((await act(ws.owner, 'contact.import', { rows: many })).status).toBe(422)
})

test('a number that was merged into another contact fills that one', async () => {
  const keep = (
    await db
      .insert(contacts)
      .values({
        id: `ct_${crypto.randomUUID().slice(0, 12)}`,
        workspace_id: ws.id,
        phone: randomNumber(),
        name: 'Dana Lee',
      })
      .returning()
  )[0]!
  const old = (
    await db
      .insert(contacts)
      .values({ id: `ct_${crypto.randomUUID().slice(0, 12)}`, workspace_id: ws.id, phone: randomNumber() })
      .returning()
  )[0]!
  await act(ws.owner, 'contact.merge', { keepId: keep.id, mergeId: old.id })
  const { body } = await act(ws.owner, 'contact.import', { rows: [{ phone: old.phone, company: 'Lee Landscaping' }] })
  expect(body.data).toEqual({ created: 0, updated: 1, unchanged: 0, skipped: 0 })
  expect(await getContact(keep.id)).toMatchObject({ name: 'Dana Lee', company: 'Lee Landscaping' })
})
