// Agent setup counts (agent-setup-counts.ts, LIN-657): a setup link counts as made with the agent picked, and as
// connected once, on its agent's first setup_status call. Only counts: no person, workspace or key in them. Reads every
// count of the install, so this file has a database of its own (INSTANCE_WIDE_FILES).
import { agent_setup_counts, agent_setup_keys } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { adminAgentSetupCounts, countLinkConnected, countsKind } from '../src/agent-setup-counts.ts'
import { db } from '../src/db.ts'
import { act, appRequest, asServerAdmin, createWorkspace, FROM, randomIp, request, type Workspace } from './helpers.ts'

let id = 0
const setupStatus = (key: string) =>
  appRequest(`/mcp/setup/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [FROM]: randomIp() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name: 'setup_status', arguments: { read_only: true } },
    }),
  })

const rowOf = async (kind: 'all' | 'workspace' | 'install', client: string) =>
  (await adminAgentSetupCounts(db, 4, kind)).rows.find(r => r.client === client)

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})

describe('agent setup counts', () => {
  test('a workspace link counts as made with its agent, and as connected once on setup_status', async () => {
    const made = await act(ws.owner, 'agentSetup.createWorkspaceKey', { client: 'chatgpt' })
    expect(made.status).toBe(200)
    const { key, keyId } = made.body.data as { key: string; keyId: string }
    expect(await rowOf('workspace', 'chatgpt')).toEqual({ client: 'chatgpt', made: 1, connected: 0 })

    expect((await setupStatus(key)).status).toBe(200)
    expect((await setupStatus(key)).status).toBe(200)
    expect(await rowOf('workspace', 'chatgpt')).toEqual({ client: 'chatgpt', made: 1, connected: 1 })
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row?.client).toBe('chatgpt')
    expect(row?.connected_at).not.toBeNull()
    // The counts hold no person, workspace or key.
    const [count] = await db.select().from(agent_setup_counts)
    expect(Object.keys(count!).sort()).toEqual(['client', 'connected', 'day', 'kind', 'made'])
  })

  test('a link made without an agent counts as none; an unknown agent is refused', async () => {
    expect((await act(ws.owner, 'agentSetup.createWorkspaceKey', {})).status).toBe(200)
    expect(await rowOf('workspace', 'none')).toEqual({ client: 'none', made: 1, connected: 0 })
    expect((await act(ws.owner, 'agentSetup.createWorkspaceKey', { client: 'evil' })).status).toBe(422)
  })

  test('install links count apart, and the admin route sums by agent', async () => {
    const res = await asServerAdmin(ws.owner, () => act(ws.owner, 'agentSetup.createKey', { client: 'chatgpt' }))
    expect(res.status).toBe(200)
    expect(await rowOf('install', 'chatgpt')).toEqual({ client: 'chatgpt', made: 1, connected: 0 })
    expect(await rowOf('all', 'chatgpt')).toEqual({ client: 'chatgpt', made: 2, connected: 1 })

    const page = await asServerAdmin(ws.owner, () =>
      request(ws.owner, 'GET', '/v1/admin/agent-setup-counts?weeks=4&kind=all'),
    )
    expect(page.status).toBe(200)
    expect(page.body.total).toEqual({ made: 3, connected: 1 })
    expect(page.body.rows[0]).toEqual({ client: 'chatgpt', made: 2, connected: 1 })
    // Not for anyone else.
    expect((await request(ws.owner, 'GET', '/v1/admin/agent-setup-counts')).status).toBe(403)
  })

  test('a link from before the counts is never counted as connected', async () => {
    const made = await act(ws.owner, 'agentSetup.createWorkspaceKey', { client: 'gemini' })
    const { key } = made.body.data as { key: string }
    await db.delete(agent_setup_counts).where(eq(agent_setup_counts.client, 'gemini'))
    expect((await setupStatus(key)).status).toBe(200)
    expect(await rowOf('all', 'gemini')).toBeUndefined()
  })

  test('connected never fails and needs a key', async () => {
    await expect(countLinkConnected(undefined)).resolves.toBeUndefined()
    await expect(countLinkConnected('no_such_key')).resolves.toBeUndefined()
    expect(countsKind('partner')).toBe('partner')
    expect(countsKind('x')).toBe('all')
  })
})
