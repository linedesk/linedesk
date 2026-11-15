// Who may do what: roles, the agent token, and no access without a session.
import { actions } from '@linedesk/actions'
import { beforeAll, describe, expect, test } from 'vitest'
import { user as users } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { app, WORKSPACE_CREATION_CLOSED } from '../src/app.ts'
import { db } from '../src/db.ts'
import { auth } from '../src/auth.ts'
import {
  act,
  addMember,
  agent,
  anonymous,
  createWorkspace,
  getAssistant,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

let ws: Workspace
let admin: User
let member: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  admin = await addMember(ws.id, 'admin')
  member = await addMember(ws.id, 'member')
})

const namesWith = (permission: string) =>
  [...actions.values()].filter(a => a.permission === permission).map(a => a.name)

describe('roles', () => {
  test('/v1/me reports the role and permissions of each member', async () => {
    expect((await request(ws.owner, 'GET', '/v1/me')).body).toMatchObject({ role: 'owner', workspace: { id: ws.id } })
    expect((await request(admin, 'GET', '/v1/me')).body).toMatchObject({ role: 'admin', workspace: { id: ws.id } })
    expect((await request(member, 'GET', '/v1/me')).body).toMatchObject({
      role: 'member',
      permissions: ['call:read', 'call:write', 'contact:write', 'calendar:read', 'calendar:write', 'team:read', 'invitation:respond'],
      workspace: { id: ws.id },
    })
  })

  test.each(namesWith('settings:write'))('a member cannot run %s', async name => {
    const before = await getAssistant(ws.assistant.id)
    const res = await act(member, name, { assistantId: ws.assistant.id, greeting: 'hijacked' })
    expect(res).toMatchObject({ status: 403, body: { ok: false, error: 'missing permission settings:write' } })
    expect(await getAssistant(ws.assistant.id)).toEqual(before)
  })

  test('owner and admin can change settings, a member can still triage calls', async () => {
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'from owner' })).status,
    ).toBe(200)
    expect(
      (await act(admin, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'from admin' })).status,
    ).toBe(200)
    expect((await getAssistant(ws.assistant.id))?.greeting).toBe('from admin')
    expect((await act(member, 'call.markDone', { callId: ws.call.id })).status).toBe(200)
  })

  test.each(namesWith('agent'))('no member role can run the agent-only action %s', async name => {
    for (const who of [ws.owner, admin, member]) {
      expect(await act(who, name, {})).toMatchObject({ status: 403, body: { error: 'missing permission agent' } })
    }
  })

  test.each(namesWith('settings:write'))('the agent cannot run %s', async name => {
    const res = await act(agent(ws.id), name, { assistantId: ws.assistant.id, greeting: 'from agent' })
    expect(res.status).toBe(403)
  })

  test('every role that reads the calendar can look for slots; the request is validated first', async () => {
    for (const who of [ws.owner, admin, member, agent(ws.id)]) {
      expect((await act(who, 'calendar.findSlots', {})).status).toBe(422)
      expect((await act(who, 'calendar.findSlots', { appointmentTypeId: 'at_missing' })).status).toBe(409)
    }
  })
})

describe('authentication', () => {
  const v1Routes = [
    ['GET', '/v1/me'],
    ['GET', '/v1/actions'],
    ['POST', '/v1/actions/call.markDone'],
    ['POST', '/v1/actions/call.start'],
    ['GET', '/v1/shape/calls?offset=-1'],
    ['POST', '/v1/workspaces'],
  ] as const

  test.each(v1Routes)('%s %s needs a session', async (method, path) => {
    const body =
      method === 'POST'
        ? { callId: ws.call.id, name: 'Sneaky Workspace', from: '+15035550100', to: ws.number }
        : undefined
    expect((await request(anonymous, method, path, body)).status).toBe(401)
  })

  test.each(v1Routes)('%s %s rejects a wrong agent token', async (method, path) => {
    const body =
      method === 'POST'
        ? { callId: ws.call.id, name: 'Sneaky Workspace', from: '+15035550100', to: ws.number }
        : undefined
    expect((await request(agent(ws.id, 'wrong-token'), method, path, body)).status).toBe(401)
  })

  test('a made-up session cookie is rejected', async () => {
    const forged = { headers: { cookie: 'better-auth.session_token=forged.signature' } }
    expect((await request(forged, 'GET', '/v1/me')).status).toBe(401)
  })

  test('a signed-in user without a workspace has no access', async () => {
    expect((await request(await signUp(), 'GET', '/v1/me')).status).toBe(401)
  })

  test('the agent token works, and only the health check is public', async () => {
    expect((await request(agent(ws.id), 'GET', '/v1/me')).body).toMatchObject({
      role: 'agent',
      workspace: { id: ws.id },
    })
    expect((await request(anonymous, 'GET', '/healthz')).status).toBe(200)
  })

  test('an unknown action is a 404', async () => {
    expect((await act(ws.owner, 'call.doesNotExist', {})).status).toBe(404)
  })
})

test('creating a workspace needs a name', async () => {
  const user = await signUp()
  await db.update(users).set({ instanceAdmin: true }).where(eq(users.id, user.userId))
  expect((await request(user, 'POST', '/v1/workspaces', {})).status).toBe(422)
  const notJson = await app.request('/v1/workspaces', {
    method: 'POST',
    headers: user.headers,
    body: 'name=Brightwater',
  })
  // Not JSON: refused before it is read (csrf.ts).
  expect(notJson.status).toBe(403)
  expect((await request(user, 'POST', '/v1/workspaces', { name: 'Brightwater Plumbing & Heating' })).status).toBe(200)
  expect((await request(user, 'GET', '/v1/me')).body).toMatchObject({
    role: 'owner',
    workspace: { name: 'Brightwater Plumbing & Heating' },
  })
  await db.update(users).set({ instanceAdmin: false }).where(eq(users.id, user.userId))
})

test('only server admins create workspaces, also with sign-up open: anyone else is told to ask one', async () => {
  const user = await signUp()
  expect(await request(user, 'POST', '/v1/workspaces', { name: 'Not Mine To Make' })).toMatchObject({
    status: 403,
    body: { ok: false, code: 'workspace_creation_closed', error: WORKSPACE_CREATION_CLOSED },
  })
  // A member of a workspace too, and an API key never can.
  expect((await request(member, 'POST', '/v1/workspaces', { name: 'Side Business' })).status).toBe(403)
})

describe('a user who belongs to two workspaces', () => {
  let home: Workspace
  let other: Workspace
  let user: User

  beforeAll(async () => {
    home = await createWorkspace('Home Workspace')
    other = await createWorkspace('Other Workspace')
    user = home.owner
    await auth.api.addMember({ body: { userId: user.userId, organizationId: other.id, role: 'member' } })
  })

  const switchTo = (workspaceId: string) =>
    request(user, 'POST', '/api/auth/organization/set-active', { organizationId: workspaceId })

  test('acts in the active workspace only, with the role they have there', async () => {
    expect((await request(user, 'GET', '/v1/me')).body).toMatchObject({ role: 'owner', workspace: { id: home.id } })
    expect((await act(user, 'call.markRead', { callId: home.call.id })).status).toBe(200)
    expect((await act(user, 'call.markRead', { callId: other.call.id })).status).toBe(409)
    expect((await act(user, 'assistant.update', { assistantId: home.assistant.id, greeting: 'as owner' })).status).toBe(
      200,
    )

    expect((await switchTo(other.id)).status).toBe(200)
    expect((await request(user, 'GET', '/v1/me')).body).toMatchObject({ role: 'member', workspace: { id: other.id } })
    expect((await act(user, 'call.markRead', { callId: other.call.id })).status).toBe(200)
    expect((await act(user, 'call.markRead', { callId: home.call.id })).status).toBe(409)
    // Owner at home, but only a member here.
    expect(
      (await act(user, 'assistant.update', { assistantId: other.assistant.id, greeting: 'as member' })).status,
    ).toBe(403)
    expect(
      (await act(user, 'assistant.update', { assistantId: home.assistant.id, greeting: 'from afar' })).status,
    ).toBe(403)
    expect((await getAssistant(home.assistant.id))?.greeting).toBe('as owner')
  })

  test('cannot make a workspace active they do not belong to', async () => {
    const stranger = await createWorkspace('Stranger Workspace')
    expect((await switchTo(stranger.id)).status).not.toBe(200)
    const me = (await request(user, 'GET', '/v1/me')).body
    expect(me.workspace.id).not.toBe(stranger.id)
    expect((await act(user, 'call.markRead', { callId: stranger.call.id })).status).toBe(409)
  })
})
