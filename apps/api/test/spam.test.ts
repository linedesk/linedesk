// A real call misfiled as spam can be rescued, and a sales call that got through can be filed as spam.
import { expect, test } from 'vitest'
import { act, addMember, createWorkspace, getCall } from './helpers.ts'

test('a member files a call as spam and takes it back out', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const member = await addMember(ws.id, 'member')

  expect((await act(member, 'call.markSpam', { callId: ws.call.id })).status).toBe(200)
  expect(await getCall(ws.call.id)).toMatchObject({ outcome: 'spam', unread: false })

  await act(member, 'call.markDone', { callId: ws.call.id })
  expect((await act(member, 'call.markNotSpam', { callId: ws.call.id })).status).toBe(200)
  expect(await getCall(ws.call.id)).toMatchObject({ outcome: 'callback', inbox_state: 'open' })
})

test('another workspace cannot touch the call', async () => {
  const home = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  expect((await act(other.owner, 'call.markSpam', { callId: home.call.id })).status).toBe(409)
  expect((await getCall(home.call.id))?.outcome).not.toBe('spam')
})
