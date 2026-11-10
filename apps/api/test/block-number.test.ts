// A blocked number is not answered: call.start files the call quietly in Spam and tells the agent to hang up.
import { expect, test } from 'vitest'
import { act, addMember, agent, createWorkspace, getCall, getContact, randomNumber } from './helpers.ts'

test('a member blocks a caller; their next call lands in Spam, read, and the agent is told to hang up', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'contact.block', { contactId: ws.contact.id })).status).toBe(200)
  expect((await getContact(ws.contact.id))?.blocked_at).toBeTruthy()

  const { status, body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(status).toBe(200)
  expect(body.data.blocked).toBe(true)
  expect(await getCall(body.data.callId)).toMatchObject({
    status: 'completed',
    outcome: 'spam',
    unread: false,
    title: 'Blocked caller',
    duration_sec: 0,
  })

  expect((await act(member, 'contact.unblock', { contactId: ws.contact.id })).status).toBe(200)
  const again = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(again.body.data.blocked).toBe(false)
  expect((await getCall(again.body.data.callId))?.status).toBe('live')
})

test("other callers are answered as usual, and another workspace cannot block this one's contacts", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  const fresh = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect(fresh.body.data.blocked).toBe(false)
  expect((await act(other.owner, 'contact.block', { contactId: ws.contact.id })).status).toBe(409)
  expect((await getContact(ws.contact.id))?.blocked_at).toBeNull()
})
