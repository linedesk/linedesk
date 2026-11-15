// A workspace owner's setup link (agent-setup.ts, workspace keys): an AI agent sets up that one workspace, never the
// server or another workspace. These are the guarantees the security review checks: who makes one, what it reaches,
// that it ends (expiry, End access, the agent's own end, a newer link, losing the owner role, a disabled workspace)
// and that everything it does is logged with the key. In INSTANCE_WIDE_FILES: it makes an instance admin.
import { SETUP_MCP_INSTRUCTIONS, SETUP_MCP_WORKSPACE_INSTRUCTIONS } from '@linedesk/actions'
import { agent_setup_keys, commands, member, organization, session, user } from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { workspaceSetupActor } from '../src/agent-setup.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runAction, WORKSPACE_KEY_SCOPE } from '../src/run-action.ts'
import {
  act,
  addMember,
  appRequest,
  asServerAdmin,
  createWorkspace,
  FROM,
  randomIp,
  request,
  type User,
  type Workspace,
} from './helpers.ts'

let id = 0

async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
  const res = await appRequest(`/mcp/setup/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [FROM]: randomIp() },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return { status: res.status, body: JSON.parse(json) as any }
}
const call = (key: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(key, 'tools/call', { name, arguments: args })
// biome-ignore lint/suspicious/noExplicitAny: tool answers are asserted on in the tests
const data = (res: { body: { result: { structuredContent: any } } }) => res.body.result.structuredContent
const toolNames = async (key: string) =>
  ((await mcp(key, 'tools/list')).body.result.tools as { name: string }[]).map(t => t.name)

async function makeWorkspaceKey(who: User) {
  const res = await act(who, 'agentSetup.createWorkspaceKey', {})
  expect(res.status).toBe(200)
  return res.body.data as { key: string; url: string; keyId: string; expiresAt: string; prefix: string }
}

/** A second workspace for the same owner (as a server admin makes one for them). */
async function secondWorkspaceOf(owner: User, name: string): Promise<string> {
  const { status, body } = await asServerAdmin(owner, () => request(owner, 'POST', '/v1/workspaces', { name }))
  expect(status).toBe(200)
  return body.workspace.id
}

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})

describe('who makes a workspace setup link', () => {
  test('the owner, signed in as themselves; never an admin, a member, an API key or an unconfirmed address', async () => {
    const made = await makeWorkspaceKey(ws.owner)
    expect(made.key).toMatch(/^lds_[A-Za-z0-9_-]{43}$/)
    expect(made.url).toMatch(new RegExp(`/mcp/setup/${made.key}$`))
    expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(3.9 * 3_600_000)
    expect(Date.parse(made.expiresAt) - Date.now()).toBeLessThanOrEqual(4 * 3_600_000)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, made.keyId))
    expect(row).toMatchObject({ workspace_id: ws.id, created_by: ws.owner.userId, passkey_confirmed_until: null })
    expect(row!.key_hash).not.toContain(made.key)
    // The key is returned once and never stored in the command log.
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'agentSetup.createWorkspaceKey'), eq(commands.actor_id, ws.owner.userId)))
    expect(JSON.stringify(logged)).not.toContain(made.key)
    expect(logged!.workspace_id).toBe(ws.id)

    for (const role of ['admin', 'member'] as const) {
      const other = await addMember(ws.id, role)
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, other.userId))
      expect(await act(other, 'agentSetup.createWorkspaceKey', {})).toMatchObject({
        status: 403,
        body: { error: 'missing permission workspace:own' },
      })
    }
    const apiKey = (await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'admin' })).body.data.key
    expect(
      (await act({ headers: { authorization: `Bearer ${apiKey}` } }, 'agentSetup.createWorkspaceKey', {})).status,
    ).toBe(403)
    // The server-wide link stays an instance admin's.
    expect((await act(ws.owner, 'agentSetup.createKey', {})).status).toBe(403)

    const unconfirmed = await createWorkspace('Unconfirmed Business', false)
    expect(await act(unconfirmed.owner, 'agentSetup.createWorkspaceKey', {})).toMatchObject({
      status: 403,
      body: { code: 'EMAIL_NOT_VERIFIED' },
    })
  })
})

describe('what a workspace setup link reaches', () => {
  test('only the workspace tools: no provider, install or workspace-creating tool', async () => {
    const own = await createWorkspace('Tools Business')
    const { key } = await makeWorkspaceKey(own.owner)
    const names = await toolNames(key)
    expect(names).toEqual(
      expect.arrayContaining([
        'setup_status',
        'setup_endAccess',
        'forwarding_guide',
        'assistant_update',
        'phoneNumber_setup',
        'workspace_rename',
      ]),
    )
    expect(names.filter(n => /^(provider|providers|install)_/.test(n) || n === 'workspace_create')).toEqual([])
    // Its own playbook: nothing about provider keys.
    const init = await mcp(key, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.body.result.instructions).toBe(SETUP_MCP_WORKSPACE_INSTRUCTIONS)
    expect(SETUP_MCP_WORKSPACE_INSTRUCTIONS).not.toMatch(/provider_setKeys|Telnyx API key|Resend API key/)
    // Calling a server tool by name anyway is refused by the MCP server (the tool does not exist for it).
    const refused = await call(key, 'provider_setKeys', { provider: 'deepgram', values: { api_key: 'x' } })
    expect(refused.body.result?.isError ?? Boolean(refused.body.error)).toBe(true)
    expect((await call(key, 'workspace_create', { name: 'Sneaky' })).body.result?.isError ?? true).toBe(true)
  })

  test('setup_status: its one workspace, no server steps, no Server admin links', async () => {
    const own = await createWorkspace('Status Business')
    const { key } = await makeWorkspaceKey(own.owner)
    const status = data(await call(key, 'setup_status'))
    expect(status.steps).toEqual([])
    expect(status.workspaces.map((w: { id: string }) => w.id)).toEqual([own.id])
    expect(status.you_act_as.role).toBe('workspace owner')
    expect(typeof status.server_ready).toBe('boolean')
    expect(JSON.stringify(status.app_links)).not.toMatch(/#admin/)
    expect(status.optional).toBeUndefined()
  })

  test('another workspace, even one the same person owns, is refused and stays unchanged', async () => {
    const first = await createWorkspace('Owner Of Two')
    const second = await secondWorkspaceOf(first.owner, 'Second Location')
    // The link is for the session's active workspace; the owner's other one is out of its reach.
    const { key, keyId } = await makeWorkspaceKey(first.owner)
    const [made] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    const own = { id: made!.workspace_id!, owner: first.owner }
    const other = own.id === first.id ? second : first.id
    const otherName = other === second ? 'Second Location' : 'Owner Of Two'
    const res = await call(key, 'workspace_rename', { workspaceId: other, name: 'Renamed By Agent' })
    expect(res.body.result.isError).toBe(true)
    expect(res.body.result.content[0].text).toMatch(/not one you can set up/)
    const foreign = await call(key, 'workspace_rename', { workspaceId: ws.id, name: 'Renamed By Agent' })
    expect(foreign.body.result.isError).toBe(true)
    const names = await db.select({ id: organization.id, name: organization.name }).from(organization)
    expect(names.find(o => o.id === other)?.name).toBe(otherName)
    expect(names.find(o => o.id === ws.id)?.name).toBe('Brightwater Plumbing & Heating')
    expect(data(await call(key, 'setup_status')).workspaces.map((w: { id: string }) => w.id)).toEqual([own.id])
    // Its own workspace works, and the command is logged with the key, in that workspace (audit log).
    const ok = await call(key, 'workspace_rename', { workspaceId: own.id, name: 'Owner Of Two Renamed' })
    expect(ok.body.result.isError).toBeFalsy()
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'workspace.rename'), eq(commands.setup_key_id, keyId)))
    expect(logged).toMatchObject({ workspace_id: own.id, actor_id: own.owner.userId, rejected: false })
  })

  test('an owner who is also an instance admin: the workspace link still gets nothing of the server', async () => {
    const own = await createWorkspace('Admin Owner Business')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, own.owner.userId))
    try {
      const { key, keyId } = await makeWorkspaceKey(own.owner)
      const names = await toolNames(key)
      expect(names.filter(n => /^(provider|providers|install)_/.test(n) || n === 'workspace_create')).toEqual([])
      expect(data(await call(key, 'setup_status')).steps).toEqual([])
      // Its actor carries no instance admin rights, whatever its maker has.
      const actor = await workspaceSetupActor(own.owner.userId, keyId, own.id)
      expect(actor!.permissions).toEqual(['setupLink:end'])
      // The admin's install page does not show it as their install link.
      expect((await request(own.owner, 'GET', '/v1/admin/agent-setup')).body.key).toBeNull()
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, own.owner.userId))
    }
  })

  test('the backstop in runAction: a forged workspace-key actor never runs an instance-admin action or another workspace', async () => {
    const own = await createWorkspace('Backstop Business')
    const { keyId } = await makeWorkspaceKey(own.owner)
    const base = (await workspaceSetupActor(own.owner.userId, keyId, own.id))!
    // Even with instance:admin slipped into its permissions, the server's actions are refused.
    const forgedAdmin: Actor = { ...base, permissions: ['instance:admin', 'setupLink:end'], passkeyConfirmed: true }
    expect(await runAction('provider.setActive', { category: 'telephony', provider: null }, forgedAdmin)).toMatchObject(
      {
        status: 403,
        body: { error: WORKSPACE_KEY_SCOPE },
      },
    )
    expect(await runAction('instanceAdmin.grant', { userId: own.owner.userId }, forgedAdmin)).toMatchObject({
      status: 403,
    })
    // In another workspace, with that workspace's owner permissions: refused.
    const forgedElsewhere: Actor = { ...base, workspaceId: ws.id, role: 'owner', permissions: ['settings:write'] }
    expect(await runAction('workspace.rename', { name: 'Taken Over' }, forgedElsewhere)).toMatchObject({
      status: 403,
      body: { error: WORKSPACE_KEY_SCOPE },
    })
    // Outside any workspace, only ending its own link.
    const nowhere: Actor = { ...base, permissions: ['setupLink:end', 'settings:write'] }
    expect(await runAction('workspace.rename', { name: 'Nowhere' }, nowhere)).toMatchObject({ status: 403 })
    const [name] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, ws.id))
    expect(name!.name).toBe('Brightwater Plumbing & Heating')
  })
})

describe('a workspace setup link ends', () => {
  test('after its 4 hours', async () => {
    const own = await createWorkspace('Expiring Business')
    const { key, keyId } = await makeWorkspaceKey(own.owner)
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    await db
      .update(agent_setup_keys)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, keyId))
    expect(await mcp(key, 'tools/list')).toMatchObject({
      status: 401,
      body: { code: 'SETUP_KEY_ENDED', reason: 'expired' },
    })
  })

  test('with End access; a newer link replaces it; one link at a time', async () => {
    const own = await createWorkspace('Ending Business')
    const first = await makeWorkspaceKey(own.owner)
    const second = await makeWorkspaceKey(own.owner)
    expect(await mcp(first.key, 'tools/list')).toMatchObject({ status: 401, body: { reason: 'replaced' } })
    expect((await mcp(second.key, 'tools/list')).status).toBe(200)
    expect(await act(own.owner, 'agentSetup.revokeWorkspace', {})).toMatchObject({
      status: 200,
      body: { data: { ended: 1 } },
    })
    expect(await mcp(second.key, 'tools/list')).toMatchObject({
      status: 401,
      body: { code: 'SETUP_KEY_ENDED', reason: 'ended' },
    })
    // Only the owner ends it this way.
    const admin = await addMember(own.id, 'admin')
    expect((await act(admin, 'agentSetup.revokeWorkspace', {})).status).toBe(403)
  })

  test('the agent ends its own link, and only that one', async () => {
    const own = await createWorkspace('Self Ending Business')
    const { key } = await makeWorkspaceKey(own.owner)
    expect(data(await call(key, 'setup_endAccess'))).toMatchObject({ ended: true })
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { reason: 'ended_by_agent' } })
    const page = (await request(own.owner, 'GET', '/v1/workspace/agent-setup')).body
    expect(page.key).toBeNull()
    expect(Date.parse(page.endedByAgentAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  test('when its maker is no longer the owner, or the workspace is disabled', async () => {
    const own = await createWorkspace('Handed Over Business')
    const { key } = await makeWorkspaceKey(own.owner)
    await db
      .update(member)
      .set({ role: 'admin' })
      .where(and(eq(member.organizationId, own.id), eq(member.userId, own.owner.userId)))
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })

    const off = await createWorkspace('Disabled Business')
    const made = await makeWorkspaceKey(off.owner)
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, off.id))
    expect(await mcp(made.key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })

    const gone = await createWorkspace('Disabled Account Business')
    const theirs = await makeWorkspaceKey(gone.owner)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, gone.owner.userId))
    expect(await mcp(theirs.key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
  })
})

describe('a workspace setup link ends for good (security review of #822)', () => {
  const ownerMember = (workspaceId: string, userId: string) =>
    and(eq(member.organizationId, workspaceId), eq(member.userId, userId))

  test('F1: losing the owner role ends it; getting the role back does not bring it back', async () => {
    const own = await createWorkspace('Back And Forth Business')
    const { key, keyId } = await makeWorkspaceKey(own.owner)
    await db.update(member).set({ role: 'admin' }).where(ownerMember(own.id, own.owner.userId))
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
    await db.update(member).set({ role: 'owner' }).where(ownerMember(own.id, own.owner.userId))
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row).toMatchObject({ ended_reason: 'owner_lost' })
    expect(row!.revoked_at).not.toBeNull()
  })

  test('F1: handing the workspace over ends it at once, also when it is handed back before the link is used', async () => {
    const own = await createWorkspace('Handed Back Business')
    const { key, keyId } = await makeWorkspaceKey(own.owner)
    const next = await addMember(own.id, 'admin')
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, next.userId))
    const [nextRow] = await db.select().from(member).where(ownerMember(own.id, next.userId))
    expect((await act(own.owner, 'team.transferOwnership', { memberId: nextRow!.id })).status).toBe(200)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row).toMatchObject({ ended_reason: 'owner_lost' })
    const [ownerRow] = await db.select().from(member).where(ownerMember(own.id, own.owner.userId))
    expect((await act(next, 'team.transferOwnership', { memberId: ownerRow!.id })).status).toBe(200)
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
  })

  test('F1: disabling the workspace ends it; enabling it again does not bring it back', async () => {
    const own = await createWorkspace('Switched Off Business')
    const { key, keyId } = await makeWorkspaceKey(own.owner)
    const operator = (await createWorkspace('Operator Business')).owner
    await asServerAdmin(operator, async () => {
      expect((await act(operator, 'workspace.disable', { workspaceId: own.id })).status).toBe(200)
      const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
      expect(row).toMatchObject({ ended_reason: 'workspace_disabled' })
      expect((await act(operator, 'workspace.enable', { workspaceId: own.id })).status).toBe(200)
    })
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
  })

  test('F2: a password change ends every setup link of that person, install links too', async () => {
    const own = await createWorkspace('Password Business')
    const { key, keyId } = await makeWorkspaceKey(own.owner)
    const res = await request(own.owner, 'POST', '/api/auth/change-password', {
      currentPassword: 'test-password-1234',
      newPassword: 'another-password-5678',
    })
    expect(res.status).toBe(200)
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row).toMatchObject({ ended_reason: 'password_changed' })
  })

  test('F2: "sign out other sessions" ends every setup link of that person, install links too', async () => {
    const own = await createWorkspace('Sessions Business')
    const { key } = await makeWorkspaceKey(own.owner)
    expect((await request(own.owner, 'POST', '/api/auth/revoke-other-sessions', {})).status).toBe(200)
    expect(await mcp(key, 'tools/list')).toMatchObject({ status: 401, body: { code: 'SETUP_KEY_ENDED' } })

    // An instance admin's install link ends the same way.
    const admin = await createWorkspace('Install Link Business')
    await asServerAdmin(admin.owner, async () => {
      const made = await act(admin.owner, 'agentSetup.createKey', {})
      expect(made.status).toBe(200)
      expect((await request(admin.owner, 'POST', '/api/auth/revoke-other-sessions', {})).status).toBe(200)
      const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, made.body.data.keyId))
      expect(row).toMatchObject({ workspace_id: null, ended_reason: 'sessions_ended' })
      expect(await mcp(made.body.data.key, 'tools/list')).toMatchObject({ status: 401 })
    })
  })

  test('F2: making a link needs a sign-in from the last 10 minutes', async () => {
    const own = await createWorkspace('Old Session Business')
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(session.userId, own.owner.userId))
    expect(await act(own.owner, 'agentSetup.createWorkspaceKey', {})).toMatchObject({
      status: 403,
      body: { code: 'SIGN_IN_AGAIN' },
    })
    expect(await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.created_by, own.owner.userId))).toEqual(
      [],
    )
  })

  test('F3: links made at the same moment leave exactly one working', async () => {
    const own = await createWorkspace('Parallel Business')
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => act(own.owner, 'agentSetup.createWorkspaceKey', {})))
    expect(made.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
    const working = await db
      .select()
      .from(agent_setup_keys)
      .where(and(eq(agent_setup_keys.created_by, own.owner.userId), isNull(agent_setup_keys.revoked_at)))
    expect(working).toHaveLength(1)
  })

  test('F6: making links is limited per owner; a deleted workspace takes its links with it', async () => {
    const own = await createWorkspace('Many Links Business')
    for (let i = 0; i < 10; i++) await makeWorkspaceKey(own.owner)
    const refused = await act(own.owner, 'agentSetup.createWorkspaceKey', {})
    expect(refused.status).not.toBe(200)
    expect(refused.body.error).toMatch(/Too many setup links/)

    const gone = await createWorkspace('Deleted Business')
    const { keyId } = await makeWorkspaceKey(gone.owner)
    await db.delete(organization).where(eq(organization.id, gone.id))
    expect(await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))).toEqual([])
  })
})

describe('GET /v1/workspace/agent-setup', () => {
  test("the owner's working link (never the key) and the workspace's steps only; nobody else", async () => {
    const own = await createWorkspace('Page Business')
    const before = (await request(own.owner, 'GET', '/v1/workspace/agent-setup')).body
    expect(before.key).toBeNull()
    const made = await makeWorkspaceKey(own.owner)
    const res = await request(own.owner, 'GET', '/v1/workspace/agent-setup')
    expect(res.status).toBe(200)
    expect(res.body.key.prefix).toBe(made.prefix)
    expect(JSON.stringify(res.body)).not.toContain(made.key)
    const groups = new Set(res.body.progress.steps.map((s: { group: string }) => s.group))
    expect([...groups]).toEqual(['business'])
    expect(res.body.progress.workspaces).toEqual([
      { id: own.id, name: 'Page Business', done: expect.any(Number), total: expect.any(Number) },
    ])
    expect(res.body.progress.workspace).toMatchObject({ id: own.id })
    // Nothing on this page reads like the server's own steps.
    expect(JSON.stringify(SETUP_MCP_INSTRUCTIONS)).not.toBe(JSON.stringify(SETUP_MCP_WORKSPACE_INSTRUCTIONS))

    const admin = await addMember(own.id, 'admin')
    expect((await request(admin, 'GET', '/v1/workspace/agent-setup')).status).toBe(403)
    const memberUser = await addMember(own.id, 'member')
    expect((await request(memberUser, 'GET', '/v1/workspace/agent-setup')).status).toBe(403)
    expect((await request({ headers: {} }, 'GET', '/v1/workspace/agent-setup')).status).toBe(401)
  })
})
