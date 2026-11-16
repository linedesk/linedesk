// Personal API keys (LIN-339): made, listed and revoked by the person signed in as themselves; a key acts exactly as
// its maker does now (every workspace, the role there, server admin), over /v1, MCP and records.list, never managing
// keys and never reaching the browser's routes. Instance-wide file (vitest.config.ts): it makes a server admin.
import { IRREVERSIBLE_ACTIONS, actions } from '@linedesk/actions'
import { admin_authenticators, assistants, commands, member, passkey, personal_keys, session, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { dropUnprovenAccessOf } from '../src/account-linking.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { NOT_OVER_MCP_FOR_PERSONAL_KEYS, toolName } from '../src/mcp.ts'
import { revokePersonalKeysOf, revokeSetupKeysOf } from '../src/passkey-enrolment.ts'
import {
  act,
  addMember,
  appRequest,
  createWorkspace,
  FROM,
  randomIp,
  request,
  type User,
  type Workspace,
} from './helpers.ts'

let ws: Workspace
let other: Workspace
let ownerKey: string

const asKey = (key: string, workspaceId?: string) => ({
  headers: {
    authorization: `Bearer ${key}`,
    [FROM]: randomIp(),
    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  },
})

async function makeKey(who: User, name = 'Laptop CLI') {
  const res = await act(who, 'personalKey.create', { name })
  expect(res.status).toBe(200)
  return res.body.data.key as string
}

let id = 0
async function mcp(
  key: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await appRequest('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
      [FROM]: randomIp(),
      ...headers,
    },
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

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  // The owner of ws is a plain member of the other workspace.
  await auth.api.addMember({ body: { userId: ws.owner.userId, organizationId: other.id, role: 'member' } })
  ownerKey = await makeKey(ws.owner)
})

test('every irreversible action named exists', () => {
  for (const name of IRREVERSIBLE_ACTIONS) expect(actions.has(name), name).toBe(true)
})

describe('managing personal keys', () => {
  test('the key is shown once, stored as a hash, listed without it', async () => {
    const key = await makeKey(ws.owner, 'Script')
    expect(key).toMatch(/^ldp_[A-Za-z0-9_-]{43}$/)
    const [row] = await db
      .select()
      .from(personal_keys)
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    expect(row!.key_hash).not.toContain(key)
    const list = await act(ws.owner, 'personalKey.list', {})
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body.data)).not.toContain(key)
    expect(list.body.data.keys.some((k: { name: string }) => k.name === 'Script')).toBe(true)
  })

  test('making a key needs a sign-in from the last 10 minutes, and emails the person', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    try {
      const person = await addMember(ws.id, 'member')
      const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, person.userId))
      await makeKey(person, 'Fresh')
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            to: account!.email,
            subject: 'A personal API key was created for your Linedesk account',
          }),
        ),
      )
      await db
        .update(session)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(session.userId, person.userId))
      expect(await act(person, 'personalKey.create', { name: 'Late' })).toMatchObject({
        status: 403,
        body: { code: 'SIGN_IN_AGAIN' },
      })
      const rows = await db.select().from(personal_keys).where(eq(personal_keys.user_id, person.userId))
      expect(rows.map(r => r.name)).toEqual(['Fresh'])
    } finally {
      send.mockRestore()
    }
  })

  test('with a passkey, making a key needs a passkey or authenticator confirmation from the last 10 minutes', async () => {
    const before = process.env.ADMIN_SECOND_FACTOR
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const person = await addMember(ws.id, 'admin')
    try {
      await db.insert(passkey).values({
        id: `pk_${crypto.randomUUID().slice(0, 12)}`,
        userId: person.userId,
        publicKey: 'cHVibGlj',
        credentialID: `cred-${crypto.randomUUID()}`,
        counter: 0,
        deviceType: 'multiDevice',
        backedUp: true,
      })
      const confirmedAt = (at: Date | null, method: 'passkey' | 'authenticator' | null = null) =>
        db
          .update(session)
          .set({ passkeyVerifiedAt: at, secondFactorMethod: method })
          .where(eq(session.userId, person.userId))
      // A fresh sign-in without the passkey is not enough; the refusal offers no authenticator to a non-admin.
      await confirmedAt(null)
      expect(await act(person, 'personalKey.create', { name: 'No passkey yet' })).toMatchObject({
        status: 403,
        body: { code: 'PASSKEY_STEP_UP_REQUIRED', stepUp: 'confirm', authenticator: false },
      })
      await confirmedAt(new Date(Date.now() - 11 * 60_000), 'passkey')
      expect((await act(person, 'personalKey.create', { name: 'Old passkey' })).status).toBe(403)
      await confirmedAt(new Date(), 'passkey')
      await makeKey(person, 'Passkey')
      // An instance admin with an authenticator app is offered it, and a code checked just now counts.
      await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, person.userId))
      await db
        .insert(admin_authenticators)
        .values({ user_id: person.userId, secret: 'x', confirmed_at: new Date().toISOString() })
      await confirmedAt(new Date(Date.now() - 11 * 60_000), 'passkey')
      expect(await act(person, 'personalKey.create', { name: 'Old again' })).toMatchObject({
        status: 403,
        body: { code: 'PASSKEY_STEP_UP_REQUIRED', authenticator: true },
      })
      await confirmedAt(new Date(), 'authenticator')
      await makeKey(person, 'Authenticator')
      const rows = await db.select().from(personal_keys).where(eq(personal_keys.user_id, person.userId))
      expect(rows.map(r => r.name).sort()).toEqual(['Authenticator', 'Passkey'])
    } finally {
      if (before === undefined) delete process.env.ADMIN_SECOND_FACTOR
      else process.env.ADMIN_SECOND_FACTOR = before
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, person.userId))
    }
  })

  test('a key never makes, lists or revokes keys', async () => {
    for (const [name, input] of [
      ['personalKey.create', { name: 'x' }],
      ['personalKey.list', {}],
      ['personalKey.revoke', { personalKeyId: 'pkey_x' }],
      ['apiKey.create', { name: 'x', role: 'member' }],
    ] as const) {
      const res = await act(asKey(ownerKey), name, input)
      expect(res.status, name).toBe(403)
    }
  })

  test("nobody revokes another person's key", async () => {
    const key = await makeKey(ws.owner, 'Mine')
    const [row] = await db
      .select()
      .from(personal_keys)
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    const res = await act(other.owner, 'personalKey.revoke', { personalKeyId: row!.id })
    expect(res).toMatchObject({ status: 409, body: { error: 'personal key not found' } })
    expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(200)
  })

  test('a password change, a passkey reset, signing out everywhere or an email change revokes every key; a lost admin role ends its admin', async () => {
    for (const end of [
      (id: string) => revokeSetupKeysOf(db, id, 'password_changed'),
      (id: string) => revokeSetupKeysOf(db, id, 'sessions_ended'),
      (id: string) => dropUnprovenAccessOf(id),
      (id: string) => revokeSetupKeysOf(db, id, 'passkeys_reset'),
      (id: string) => revokePersonalKeysOf(db, id),
    ]) {
      const person = await addMember(ws.id, 'member')
      const key = await makeKey(person)
      await end(person.userId)
      expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(401)
    }
    const admin = await addMember(ws.id, 'admin')
    const key = await makeKey(admin)
    await db
      .update(personal_keys)
      .set({ passkey_confirmed: true })
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    await revokeSetupKeysOf(db, admin.userId, 'admin_role_removed')
    const [row] = await db
      .select()
      .from(personal_keys)
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    expect(row).toMatchObject({ passkey_confirmed: false, revoked_at: null })
  })

  test('"sign out all other sessions" in the app revokes every key', async () => {
    const person = await addMember(ws.id, 'member')
    const key = await makeKey(person)
    expect((await request(person, 'POST', '/api/auth/revoke-other-sessions', {})).status).toBe(200)
    expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(401)
  })

  test("a passkey sign-in is carried only by a server admin's key", async () => {
    const person = await addMember(ws.id, 'member')
    await makeKey(person)
    const rows = await db.select().from(personal_keys).where(eq(personal_keys.user_id, person.userId))
    expect(rows.every(r => !r.passkey_confirmed)).toBe(true)
  })

  test('a revoked key stops at once', async () => {
    const key = await makeKey(ws.owner, 'Old')
    const [row] = await db
      .select()
      .from(personal_keys)
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    expect((await act(ws.owner, 'personalKey.revoke', { personalKeyId: row!.id })).status).toBe(200)
    expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(401)
  })
})

describe('a key acts as its maker', () => {
  test('runs what the owner runs in their workspace, logged with the key', async () => {
    const res = await act(asKey(ownerKey), 'call.markDone', { callId: ws.call.id })
    expect(res.status).toBe(200)
    const mine = await db
      .select()
      .from(commands)
      .where(and(eq(commands.actor_id, ws.owner.userId), eq(commands.action, 'call.markDone')))
    expect(mine.some(c => c.personal_key_id?.startsWith('pkey_'))).toBe(true)
    const me = await request(asKey(ownerKey), 'GET', '/v1/me')
    expect(me.body.permissions).toContain('settings:write')
    expect(me.body.permissions).not.toContain('account:own')
  })

  test('in another of their workspaces with their role there, picked with x-workspace-id', async () => {
    const there = asKey(ownerKey, other.id)
    expect((await act(there, 'call.markDone', { callId: other.call.id })).status).toBe(200)
    const invite = await act(there, 'team.invite', { email: 'new@brightwater.example', role: 'member' })
    expect(invite).toMatchObject({ status: 403, body: { error: 'missing permission team:write' } })
  })

  test('never in a workspace they do not belong to', async () => {
    const stranger = await createWorkspace('Stranger Co')
    const res = await request(asKey(ownerKey, stranger.id), 'GET', '/v1/me')
    expect(res.status).toBe(403)
    expect((await act(asKey(ownerKey, stranger.id), 'call.markDone', { callId: stranger.call.id })).status).toBe(403)
  })

  test("a member's key gets a member's rights, and loses them with the membership", async () => {
    const person = await addMember(ws.id, 'member')
    const key = await makeKey(person)
    expect((await act(asKey(key), 'assistant.update', { assistantId: ws.assistant.id, name: 'Maya' })).status).toBe(403)
    expect((await act(asKey(key), 'call.markDone', { callId: ws.call.id })).status).toBe(200)
    await db.delete(member).where(and(eq(member.userId, person.userId), eq(member.organizationId, ws.id)))
    expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(401)
  })

  test("a disabled account's keys stop", async () => {
    const person = await addMember(ws.id, 'admin')
    const key = await makeKey(person)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, person.userId))
    expect((await request(asKey(key), 'GET', '/v1/me')).status).toBe(401)
  })

  test("a server admin's key is a server admin while they are one", async () => {
    const admin = await addMember(ws.id, 'admin')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    const key = await makeKey(admin)
    expect((await request(asKey(key), 'GET', '/v1/admin/overview')).status).toBe(200)
    expect((await act(asKey(key), 'calendarTools.get', {})).status).toBe(200)
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
    expect((await request(asKey(key), 'GET', '/v1/admin/overview')).status).toBe(403)
  })

  test('only a passkey sign-in, not an authenticator code, gives an admin key Server admin', async () => {
    const admin = await addMember(ws.id, 'admin')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      const confirmed = async (method: 'passkey' | 'authenticator') => {
        await db
          .update(session)
          .set({ passkeyVerifiedAt: new Date(), secondFactorMethod: method })
          .where(eq(session.userId, admin.userId))
        const key = await makeKey(admin, method)
        const [row] = await db
          .select()
          .from(personal_keys)
          .where(eq(personal_keys.prefix, key.slice(0, 12)))
        return row!.passkey_confirmed
      }
      expect(await confirmed('authenticator')).toBe(false)
      expect(await confirmed('passkey')).toBe(true)
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
    }
  })

  test('where the passkey check is on, only a key made after it is a server admin', async () => {
    const admin = await addMember(ws.id, 'admin')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.userId))
    const key = await makeKey(admin)
    const before = process.env.ADMIN_SECOND_FACTOR
    process.env.ADMIN_SECOND_FACTOR = 'on'
    try {
      expect((await request(asKey(key), 'GET', '/v1/admin/overview')).status).toBe(403)
      await db
        .update(personal_keys)
        .set({ passkey_confirmed: true })
        .where(eq(personal_keys.prefix, key.slice(0, 12)))
      expect((await request(asKey(key), 'GET', '/v1/admin/overview')).status).toBe(200)
      // For PERSONAL_KEY_ADMIN_DAYS only (security review M3): a key made 31 days ago is no server admin any more.
      await db
        .update(personal_keys)
        .set({ created_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() })
        .where(eq(personal_keys.prefix, key.slice(0, 12)))
      expect((await request(asKey(key), 'GET', '/v1/admin/overview')).status).toBe(403)
      // Still the person in their workspaces.
      expect((await act(asKey(key), 'member.list', {})).status).toBe(200)
      const listed = await act(admin, 'personalKey.list', {})
      const row = listed.body.data.keys.find((k: { prefix: string }) => k.prefix === key.slice(0, 12))
      expect(Date.parse(row.admin_until)).toBeLessThan(Date.now())
    } finally {
      if (before === undefined) delete process.env.ADMIN_SECOND_FACTOR
      else process.env.ADMIN_SECOND_FACTOR = before
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
    }
  })
})

describe('what a key reads', () => {
  test('lists the actions it may run, with their input', async () => {
    const res = await request(asKey(ownerKey), 'GET', '/v1/me/actions')
    expect(res.status).toBe(200)
    const names = res.body.actions.map((a: { name: string }) => a.name)
    expect(names).toContain('call.markDone')
    expect(names).toContain('records.list')
    expect(names).not.toContain('personalKey.create')
    expect(names).not.toContain('instanceAdmin.grant')
    const byName = new Map(res.body.actions.map((a: { name: string }) => [a.name, a]))
    expect(byName.get('team.transferOwnership')).toMatchObject({ destructive: true })
    expect(res.body.actions.find((a: { name: string }) => a.name === 'call.markDone').input.properties).toHaveProperty(
      'callId',
    )
  })

  test("records.list reads the workspace's rows only, page by page", async () => {
    const first = await act(asKey(ownerKey), 'records.list', { table: 'calls', limit: 1 })
    expect(first.status).toBe(200)
    expect(first.body.data.rows.every((r: { workspace_id: string }) => r.workspace_id === ws.id)).toBe(true)
    const one = await act(asKey(ownerKey), 'records.list', { table: 'calls', id: other.call.id })
    expect(one.body.data.rows).toEqual([])
  })

  test("the browser's routes answer 403", async () => {
    expect((await request(asKey(ownerKey), 'GET', '/v1/shape/calls')).status).toBe(403)
    expect((await request(asKey(ownerKey), 'POST', '/v1/impersonation/stop', {})).status).toBe(403)
    expect((await request(asKey(ownerKey), 'GET', '/v1/workspace/agent-setup')).status).toBe(403)
  })
})

describe('MCP with a personal key', () => {
  test('offers every action its maker may run, destructive ones marked, and acts in a named workspace', async () => {
    const tools = await mcp(ownerKey, 'tools/list')
    expect(tools.status).toBe(200)
    const byName = new Map(tools.body.result.tools.map((t: { name: string }) => [t.name, t]))
    expect(byName.has('workspaces_list')).toBe(true)
    expect(byName.has('api_get')).toBe(true)
    const destructive = [...byName.values()].find(
      (t: unknown) => (t as { annotations?: { destructiveHint?: boolean } }).annotations?.destructiveHint,
    )
    expect(destructive).toBeDefined()
    // Every write is marked destructive (the client asks first); where calls are sent stays in the app.
    for (const t of byName.values()) {
      const a = (t as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations
      expect(a?.readOnlyHint || a?.destructiveHint, String((t as { name: string }).name)).toBe(true)
    }
    expect([...byName.keys()].some(n => String(n).toLowerCase().includes('webhook_create'))).toBe(false)
    const markDone = [...byName.keys()].find(n => String(n).toLowerCase().includes('markdone'))
    expect(markDone).toBeDefined()
    const res = await mcp(ownerKey, 'tools/call', {
      name: markDone,
      arguments: { callId: other.call.id, workspaceId: other.id },
    })
    expect(res.body.result.isError ?? false).toBe(false)
    const records = [...byName.keys()].find(n => String(n).toLowerCase().includes('records'))
    const read = await mcp(ownerKey, 'tools/call', { name: records, arguments: { table: 'calls', limit: 1 } })
    expect(read.body.result.content[0].text).toContain('untrusted_caller_content')
  })

  test('keeps what lets strangers in or sends calls elsewhere out of MCP', async () => {
    const tools = await mcp(ownerKey, 'tools/list')
    const names = new Set(tools.body.result.tools.map((t: { name: string }) => t.name))
    for (const name of NOT_OVER_MCP_FOR_PERSONAL_KEYS) expect(names.has(toolName(name)), name).toBe(false)
    for (const name of [
      'team.invite',
      'phoneNumber.update',
      'carrier.set',
      'provider.connectOneKey',
      'systemPrompt.setPart',
      'systemPrompt.resetPart',
    ])
      expect(NOT_OVER_MCP_FOR_PERSONAL_KEYS.has(name), name).toBe(true)
    expect(names.has('assistant_update')).toBe(true)
    const [assistant] = await db.select().from(assistants).where(eq(assistants.workspace_id, ws.id))
    // The assistant is fully changeable over MCP, transfer contacts included.
    const transfers = await mcp(ownerKey, 'tools/call', {
      name: 'assistant_update',
      arguments: { assistantId: assistant!.id, name: 'Maya', transfers: [] },
    })
    expect(transfers.body.result.isError ?? false).toBe(false)
  })

  test('refuses a workspace its maker does not belong to', async () => {
    const stranger = await createWorkspace('Another Stranger')
    const res = await mcp(ownerKey, 'tools/call', { name: 'calls_list', arguments: { workspaceId: stranger.id } })
    expect(res.body.result.isError).toBe(true)
    expect((await mcp(ownerKey, 'tools/list', {}, { 'x-workspace-id': stranger.id })).status).toBe(401)
  })

  test('api_get reads listed routes only', async () => {
    const ok = await mcp(ownerKey, 'tools/call', { name: 'api_get', arguments: { path: '/v1/me/workspaces' } })
    expect(ok.body.result.isError ?? false).toBe(false)
    // Names in these answers can come from other people: marked as data, as the call tools do.
    expect(ok.body.result.structuredContent.untrusted_caller_content.notice).toBeTruthy()
    expect(JSON.stringify(ok.body.result.structuredContent.untrusted_caller_content.data)).toContain(ws.id)
    const refused = await mcp(ownerKey, 'tools/call', { name: 'api_get', arguments: { path: '/v1/shape/calls' } })
    expect(refused.body.result.isError).toBe(true)
  })
})

test('the 25-key cap holds when keys are made at the same time', async () => {
  const someone = await addMember(ws.id, 'member')
  const made = await Promise.all(
    Array.from({ length: 30 }, (_, i) => act(someone, 'personalKey.create', { name: `Key ${i}` })),
  )
  expect(made.filter(r => r.status === 200)).toHaveLength(25)
  const open = await db.select().from(personal_keys).where(eq(personal_keys.user_id, someone.userId))
  expect(open).toHaveLength(25)
})
