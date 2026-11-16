// Assigning calls to teammates: members of the call's workspace only, and nothing else changes.
import { actions } from '@linedesk/actions'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { handlerNames } from '../src/handlers.ts'
import { act, addMember, createWorkspace, getCall, type User, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
let teammate: User
beforeAll(async () => {
  ws = await createWorkspace('Assign Plumbing')
  other = await createWorkspace('Other Assign Co')
  teammate = await addMember(ws.id, 'member')
})
afterAll(() => {})

describe('call.assign', () => {
  test('a member assigns a call to a teammate and takes it back', async () => {
    expect((await act(teammate, 'call.assign', { callId: ws.call.id, userId: teammate.userId })).status).toBe(200)
    expect((await getCall(ws.call.id))!.assignee_id).toBe(teammate.userId)
    expect((await act(ws.owner, 'call.assign', { callId: ws.call.id, userId: ws.owner.userId })).status).toBe(200)
    expect((await getCall(ws.call.id))!.assignee_id).toBe(ws.owner.userId)
    expect((await act(ws.owner, 'call.assign', { callId: ws.call.id, userId: null })).status).toBe(200)
    expect((await getCall(ws.call.id))!.assignee_id).toBeNull()
  })

  test('someone who is not a member of the workspace cannot be the assignee', async () => {
    const res = await act(ws.owner, 'call.assign', { callId: ws.call.id, userId: other.owner.userId })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('that user is not a member of this workspace')
    expect((await getCall(ws.call.id))!.assignee_id).toBeNull()
  })

  test("another workspace's call is not found", async () => {
    expect((await act(ws.owner, 'call.assign', { callId: other.call.id, userId: ws.owner.userId })).status).toBe(409)
    expect((await getCall(other.call.id))!.assignee_id).toBeNull()
  })
})

test('only app.updateSettings (checks the app has the switches, merges them), assistant.update (checks the voice), call.assign, call.delete and contact.delete (clear webhook payloads and the command log), call.flagUrgent (queues a push) and webhook.update (checks the URL) have both a patch and a handler', () => {
  const both = [...actions.values()].filter(def => def.patch && handlerNames.has(def.name)).map(def => def.name)
  expect(both.sort()).toEqual([
    'app.updateSettings',
    'assistant.update',
    'call.assign',
    'call.delete',
    'call.flagUrgent',
    'contact.delete',
    'webhook.update',
  ])
})
