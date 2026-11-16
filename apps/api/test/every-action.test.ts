// Every action and every key read route, on all three ways in for a personal key (LIN-339): the API
// (POST /v1/actions/<name>), the CLI (packages/cli) and MCP, for an owner, an admin, a member and a server admin.
// A probe sends input no action takes (`[]`): the permission checks run before the input is read (run-action.ts), so
// it answers 403 when the key may not run the action and 422 when it may, and changes nothing either way. The
// expected answer is worked out twice: from the role's permissions, and from the same person signed in (a key is its
// maker, minus what personal-key-scope.ts refuses). Instance-wide file (vitest.config.ts): it makes a server admin.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actions, rolePermissions, type Permission } from '@linedesk/actions'
import { commands, user as users } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { main } from '../../../packages/cli/src/index.ts'
import { db } from '../src/db.ts'
import { KEY_READ_ROUTES } from '../src/key-reads.ts'
import { NOT_OVER_MCP, NOT_OVER_MCP_FOR_PERSONAL_KEYS } from '../src/mcp.ts'
import { PERSONAL_KEY_REFUSED } from '../src/personal-key-scope.ts'
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

type RoleName = 'owner' | 'admin' | 'member' | 'serverAdmin'
const ROLES: readonly RoleName[] = ['owner', 'admin', 'member', 'serverAdmin']
const TEAM_PERMISSIONS = new Set<Permission>([
  ...rolePermissions.owner,
  ...rolePermissions.admin,
  ...rolePermissions.member,
])
const READ_TOOLS = ['calls_list', 'calls_get', 'contacts_search', 'workspaces_list', 'api_get']
const ALL = [...actions.values()]
/** Actions with their own route: POST /v1/actions/<name> answers 400 and names it, to a session and a key alike. */
const OWN_ROUTE = new Set([
  'account.authenticatorConfirm',
  'account.authenticatorCheck',
  'user.impersonate',
  'impersonation.stop',
])
const toolName = (action: string) => action.replaceAll('.', '_')

/** Keys of one person, a new one before the per-key limit (300 a minute) is near. */
class KeyPool {
  private key = ''
  private used = 0
  private readonly who: User
  constructor(who: User) {
    this.who = who
  }
  async next(): Promise<string> {
    if (!this.key || this.used >= 250) {
      const res = await act(this.who, 'personalKey.create', { name: `Probe ${Date.now()}` })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      this.key = res.body.data.key
      this.used = 0
    }
    this.used++
    return this.key
  }
}

type Person = { user: User; keys: KeyPool; session: Set<string>; key: Set<string> }
let ws: Workspace
let invitationId: string
const people = {} as Record<RoleName, Person>
let configHome: string
const secondFactor = process.env.ADMIN_SECOND_FACTOR

const keyHeaders = (key: string) => ({ authorization: `Bearer ${key}`, [FROM]: randomIp() })

async function keyPost(p: Person, name: string, body: unknown) {
  const res = await appRequest(`/v1/actions/${name}`, {
    method: 'POST',
    headers: { ...keyHeaders(await p.keys.next()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted on
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

async function keyGet(p: Person, path: string) {
  const res = await appRequest(path, { headers: keyHeaders(await p.keys.next()) })
  return res.status
}

let rpc = 0
async function mcp(p: Person, method: string, params: Record<string, unknown> = {}) {
  const res = await appRequest('/mcp', {
    method: 'POST',
    headers: {
      ...keyHeaders(await p.keys.next()),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on
  return { status: res.status, body: JSON.parse(json) as any }
}

/**
 * Runs the CLI with its requests sent to the app. `probe`: every action POST goes out with `[]` as its body instead,
 * and the statuses of those POSTs are returned.
 */
async function cli(p: Person, argv: string[], probe = false) {
  const out: string[] = []
  const err: string[] = []
  const posts: { path: string; status: number }[] = []
  const realFetch = globalThis.fetch
  process.env.LINEDESK_URL = 'http://localhost:3999'
  process.env.LINEDESK_API_KEY = await p.keys.next()
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('http://localhost:3999')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${process.env.LINEDESK_API_KEY}`)
    const isAction = init.method === 'POST' && url.pathname.startsWith('/v1/actions/')
    const res = await appRequest(url.pathname + url.search, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), [FROM]: randomIp() },
      ...(probe && isAction ? { body: '[]' } : {}),
    })
    if (isAction) posts.push({ path: url.pathname, status: res.status })
    return res
  }) as typeof fetch
  try {
    const code = await main(argv, { out: t => out.push(t), err: t => err.push(t) })
    return { code, out: out.join('\n'), err: err.join('\n'), posts }
  } finally {
    globalThis.fetch = realFetch
  }
}

/** What a key of this person should run, worked out from the role alone. */
function byRole(role: RoleName, permission: Permission): boolean | null {
  if (permission === 'instance:admin') return role === 'serverAdmin'
  if (permission === 'account:own' || permission === 'agent') return false
  if (TEAM_PERMISSIONS.has(permission))
    return rolePermissions[role === 'serverAdmin' ? 'member' : role].includes(permission)
  return null
}

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'linedesk-cli-'))
  process.env.XDG_CONFIG_HOME = configHome
  // The server admin's passkey check is switched off: what a key of a server admin runs, not the check, is tested here.
  process.env.ADMIN_SECOND_FACTOR = 'off'
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  const admin = await addMember(ws.id, 'admin')
  const member = await addMember(ws.id, 'member')
  const serverAdmin = await addMember(ws.id, 'member')
  await db.update(users).set({ instanceAdmin: true }).where(eq(users.id, serverAdmin.userId))
  const users_ = { owner: ws.owner, admin, member, serverAdmin }
  for (const role of ROLES)
    people[role] = { user: users_[role], keys: new KeyPool(users_[role]), session: new Set(), key: new Set() }
  const invite = await act(ws.owner, 'team.invite', { email: 'dana.probe@brightwater.example', role: 'member' })
  expect(invite.status, JSON.stringify(invite.body)).toBe(200)
  invitationId = invite.body.data.invitationId ?? invite.body.data.id
}, 60_000)

afterAll(async () => {
  if (secondFactor === undefined) delete process.env.ADMIN_SECOND_FACTOR
  else process.env.ADMIN_SECOND_FACTOR = secondFactor
  delete process.env.LINEDESK_URL
  delete process.env.LINEDESK_API_KEY
  delete process.env.XDG_CONFIG_HOME
  await db.update(users).set({ instanceAdmin: false }).where(eq(users.id, people.serverAdmin.user.userId))
  await rm(configHome, { recursive: true, force: true })
})

describe.each(ROLES)('%s', role => {
  test('API: every action answers a key as it answers the same person signed in, minus what keys never run', async () => {
    const p = people[role]
    const wrong: string[] = []
    for (const def of ALL) {
      const session = await request(p.user, 'POST', `/v1/actions/${def.name}`, [], { [FROM]: randomIp() })
      const key = await keyPost(p, def.name, [])
      for (const [via, res] of [
        ['session', session],
        ['key', key],
      ] as const) {
        const ok = OWN_ROUTE.has(def.name) ? [400] : [403, 422]
        if (!ok.includes(res.status)) wrong.push(`${via} ${def.name}: ${res.status} ${JSON.stringify(res.body)}`)
      }
      if (session.status === 422) p.session.add(def.name)
      if (key.status === 422) p.key.add(def.name)
      const expected = session.status === 422 && !PERSONAL_KEY_REFUSED.has(def.name) && def.permission !== 'account:own'
      if ((key.status === 422) !== expected) wrong.push(`key ${def.name}: ${key.status}, session ${session.status}`)
      const roleSays = byRole(role, def.permission)
      if (roleSays !== null && (key.status === 422) !== (roleSays && !PERSONAL_KEY_REFUSED.has(def.name)))
        wrong.push(`key ${def.name} (${def.permission}): ${key.status}, the role says ${roleSays}`)
    }
    expect(wrong).toEqual([])
    // Every refused action is refused to every key; a server admin's key runs the server's actions.
    for (const name of PERSONAL_KEY_REFUSED.keys()) expect(p.key.has(name), name).toBe(false)
    expect(ALL.some(d => d.permission === 'instance:admin' && p.key.has(d.name))).toBe(role === 'serverAdmin')
  }, 180_000)

  test('CLI: `actions` lists exactly what the key runs; `run` reaches every one of them and refuses the rest', async () => {
    const p = people[role]
    const listed = await cli(p, ['actions'])
    expect(listed.code, listed.err).toBe(0)
    const names = new Set(listed.out.split('\n').map(line => line.split(/\s/)[0]!))
    expect([...names].sort()).toEqual([...p.key].sort())
    const wrong: string[] = []
    for (const def of ALL) {
      const res = await cli(p, ['run', def.name, '--yes'], true)
      if (p.key.has(def.name)) {
        // Sent to the API (with the probe body): the action's own input check answers.
        if (res.posts.length !== 1 || res.posts[0]!.path !== `/v1/actions/${def.name}` || res.posts[0]!.status !== 422)
          wrong.push(`${def.name}: ${JSON.stringify(res.posts)} ${res.err}`)
        if (res.code !== 1) wrong.push(`${def.name}: exit ${res.code}`)
      } else if (res.posts.length || res.code !== 1 || !res.err.includes(`no action ${def.name} you may run here`))
        wrong.push(`${def.name} ran or was not refused: ${JSON.stringify(res.posts)} ${res.err}`)
    }
    expect(wrong).toEqual([])
  }, 300_000)

  test('MCP: the tools are exactly the actions the key runs (less the ones kept off MCP), and the others fail', async () => {
    const p = people[role]
    const list = await mcp(p, 'tools/list')
    expect(list.status).toBe(200)
    const tools = new Set<string>(list.body.result.tools.map((t: { name: string }) => t.name))
    const expected = [
      ...READ_TOOLS,
      ...[...p.key].filter(n => !NOT_OVER_MCP.has(n) && !NOT_OVER_MCP_FOR_PERSONAL_KEYS.has(n)).map(toolName),
    ]
    expect([...tools].sort()).toEqual(expected.sort())
    // A tool not offered cannot be called by name either.
    const wrong: string[] = []
    for (const def of ALL) {
      if (tools.has(toolName(def.name))) continue
      const res = await mcp(p, 'tools/call', { name: toolName(def.name), arguments: {} })
      const failed = Boolean(res.body?.error) || res.body?.result?.isError === true
      if (!failed) wrong.push(`${def.name}: ${JSON.stringify(res.body)}`)
    }
    expect(wrong).toEqual([])
  }, 180_000)

  test('every key read route answers the key as it answers the same person signed in', async () => {
    const p = people[role]
    const ids: Record<string, string> = {
      '/v1/invitations/:id': invitationId,
      '/v1/admin/workspaces/:id/members': ws.id,
      '/v1/calls/:id/recording': ws.call.id,
      '/v1/voices/preview/:voiceId': 'no-such-voice',
      '/v1/workspace-icons/:file': 'none.png',
      '/v1/avatars/:file': 'none.png',
    }
    const wrong: string[] = []
    for (const route of KEY_READ_ROUTES) {
      const path = route.path.replace(/:[a-zA-Z]+/, m => {
        const id = ids[route.path]
        if (!id) throw new Error(`no id for ${route.path} (${m})`)
        return id
      })
      const session = (await request(p.user, 'GET', path, undefined, { [FROM]: randomIp() })).status
      const key = await keyGet(p, path)
      if (key !== session || key >= 500) wrong.push(`${path}: key ${key}, session ${session}`)
      if (path.startsWith('/v1/admin/') && (key === 200) !== (role === 'serverAdmin')) wrong.push(`${path}: ${key}`)
    }
    expect(wrong).toEqual([])
    // Routes a key does not read: the browser's table sync and the rest of the browser-only routes.
    expect(await keyGet(p, '/v1/shape/calls?offset=-1')).toBe(403)
    expect(await keyGet(p, '/v1/workspace/agent-setup')).toBe(403)
  }, 120_000)
})

/** The person's newest command of `action`, and the key it was run with. */
async function lastCommand(who: User, action: string) {
  const rows = await db
    .select({ key: commands.personal_key_id, workspace: commands.workspace_id })
    .from(commands)
    .where(and(eq(commands.actor_id, who.userId), eq(commands.action, action)))
  return rows.at(-1)
}

describe.each(['owner', 'admin', 'member'] as const)('%s: real runs on every way in', role => {
  test('API', async () => {
    const p = people[role]
    const marked = await keyPost(p, 'call.markDone', { callId: ws.call.id })
    expect(marked.status, JSON.stringify(marked.body)).toBe(200)
    expect((await lastCommand(p.user, 'call.markDone'))?.key).toBeTruthy()
    expect((await keyPost(p, 'call.markNotDone', { callId: ws.call.id })).status).toBe(200)
    const contact = await keyPost(p, 'contact.create', {
      phone: `+1503555014${ROLES.indexOf(role)}`,
      name: `Probe ${role}`,
    })
    expect(contact.status, JSON.stringify(contact.body)).toBe(200)
    expect((await lastCommand(p.user, 'contact.create'))?.workspace).toBe(ws.id)
    const rows = await keyPost(p, 'records.list', { table: 'calls', limit: 5 })
    expect(rows.status).toBe(200)
    expect(JSON.stringify(rows.body)).toContain(ws.call.id)
    expect((await keyPost(p, 'member.list', {})).status).toBe(200)
    const rename = await keyPost(p, 'workspace.rename', { name: 'Brightwater Plumbing & Heating' })
    expect(rename.status).toBe(role === 'member' ? 403 : 200)
  })

  test('CLI', async () => {
    const p = people[role]
    const who = await cli(p, ['whoami'])
    expect(who.code, who.err).toBe(0)
    expect(who.out).toContain(p.user.userId)
    expect((await cli(p, ['workspaces'])).out).toContain(ws.id)
    expect((await cli(p, ['get', '/v1/assistant/status'])).code).toBe(0)
    const done = await cli(p, ['run', 'call.markRead', '--callId', ws.call.id])
    expect(done.code, done.err).toBe(0)
    expect(done.out).toContain('"ok": true')
    expect((await cli(p, ['call.markUnread', '--callId', ws.call.id])).code).toBe(0)
    const rows = await cli(p, ['records.list', '--table', 'contacts', '--limit', '5'])
    expect(rows.code, rows.err).toBe(0)
    expect(rows.out).toContain(ws.contact.id)
    const rename = await cli(p, ['workspace.rename', '--name', 'Brightwater Plumbing & Heating'])
    expect(rename.code).toBe(role === 'member' ? 1 : 0)
  })

  test('MCP', async () => {
    const p = people[role]
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await mcp(p, 'tools/call', { name, arguments: args })
      expect(res.status).toBe(200)
      return res.body.result as { isError?: boolean; content: { text: string }[] }
    }
    const marked = await call('call_markDone', { callId: ws.call.id })
    expect(marked.isError, JSON.stringify(marked)).toBeFalsy()
    expect((await call('call_markNotDone', { callId: ws.call.id })).isError).toBeFalsy()
    const rows = await call('records_list', { table: 'calls', limit: 5 })
    expect(rows.isError).toBeFalsy()
    expect(JSON.stringify(rows)).toContain(ws.call.id)
    expect(JSON.stringify(await call('workspaces_list', {}))).toContain(ws.id)
    expect(JSON.stringify(await call('api_get', { path: '/v1/me' }))).toContain(p.user.userId)
    expect(JSON.stringify(await call('calls_list', { inbox: 'all' }))).toContain(ws.call.id)
    const rename = await mcp(p, 'tools/call', {
      name: 'workspace_rename',
      arguments: { name: 'Brightwater Plumbing & Heating' },
    })
    const failed = Boolean(rename.body.error) || rename.body.result?.isError === true
    expect(failed).toBe(role === 'member')
  })
})
