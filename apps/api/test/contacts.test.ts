// Contacts by hand: add, delete (calls keep their link), restore; a deleted contact who calls again is back.
import { expect, test } from 'vitest'
import { act, addMember, agent, createWorkspace, getContact, randomNumber } from './helpers.ts'

test('a member adds a contact; the same number cannot be added twice', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const member = await addMember(ws.id, 'member')
  const phone = randomNumber()
  const added = await act(member, 'contact.create', { phone, name: 'Dana Ortiz', company: 'Ortiz Bakery' })
  expect(added.status).toBe(200)
  expect(await getContact(added.body.data.contactId)).toMatchObject({
    phone,
    name: 'Dana Ortiz',
    company: 'Ortiz Bakery',
    deleted_at: null,
  })
  expect((await act(member, 'contact.create', { phone })).status).toBe(409)
  expect((await act(member, 'contact.create', { phone: '503 555 0100' })).status).toBe(422)
})

test('delete and restore; adding or a call from a deleted number brings the same contact back', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const id = ws.contact.id
  expect((await act(ws.owner, 'contact.delete', { contactId: id })).status).toBe(200)
  expect((await getContact(id))?.deleted_at).toBeTruthy()
  expect((await act(ws.owner, 'contact.restore', { contactId: id })).status).toBe(200)
  expect((await getContact(id))?.deleted_at).toBeNull()

  await act(ws.owner, 'contact.delete', { contactId: id })
  const again = await act(ws.owner, 'contact.create', { phone: ws.contact.phone, name: 'Known Again' })
  expect(again.body.data.contactId).toBe(id)
  expect(await getContact(id)).toMatchObject({ name: 'Known Again', deleted_at: null })

  await act(ws.owner, 'contact.delete', { contactId: id })
  const call = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(call.body.data.contact.id).toBe(id)
  expect((await getContact(id))?.deleted_at).toBeNull()
})

test('call.start gives the agent the note of the contact for the calling number only', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  await act(ws.owner, 'contact.update', { contactId: ws.contact.id, note: 'Prefers mornings.' })
  await act(other.owner, 'contact.update', { contactId: other.contact.id, note: 'Not for this workspace.' })

  const known = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(known.body.data.contact).toMatchObject({ id: ws.contact.id, note: 'Prefers mornings.' })
  // Another number of the workspace: its own (new) contact, no note.
  expect((await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.contact.note).toBeNull()
  // The other workspace's contact calls this workspace: a contact here, without the other workspace's note.
  expect((await act(agent(), 'call.start', { from: other.contact.phone, to: ws.number })).body.data.contact.note).toBeNull()
  // Withheld number: no contact at all.
  expect((await act(agent(), 'call.start', { from: 'anonymous', to: ws.number })).body.data.contact).toBeNull()
})

test('another workspace cannot delete the contact', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  expect((await act(other.owner, 'contact.delete', { contactId: ws.contact.id })).status).toBe(409)
})
