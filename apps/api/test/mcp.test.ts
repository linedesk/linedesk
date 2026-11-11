// MCP at /mcp: API keys only, tools from the public actions the key's role may run plus read tools,
// every call scoped to the key's workspace and run through the registry.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { calls, commands } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { MCP_CONCURRENT_PER_KEY, takeSlot } from '../src/mcp.ts'
import { act, appRequest, createWorkspace, FROM, getCall, randomIp, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace
let memberKey: string
let id = 0

async function createKey(owner: Workspace['owner'], role: 'member' | 'admin' = 'member') {
  const res = await act(owner, 'apiKey.create', { name: 'Claude', role })
  return res.body.data.key as string
}

/** One JSON-RPC request to /mcp (2025-era stateless), answered as JSON or a one-event SSE stream. */
async function mcp(
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await appRequest('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
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
  return { status: res.status, headers: res.headers, body: JSON.parse(json) as any }
}

const callTool = (key: string, name: string, args: Record<string, unknown>) =>
  mcp(key, 'tools/call', { name, arguments: args })
const toolData = (body: { result: { structuredContent: Record<string, unknown> } }) => body.result.structuredContent

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  memberKey = await createKey(ws.owner)
})

describe('access', () => {
  test('without a key, with a session cookie only, or with an unknown key: 401 with a Bearer challenge', async () => {
    const none = await mcp(null, 'tools/list')
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer /)
    expect((await mcp(null, 'tools/list', {}, ws.owner.headers)).status).toBe(401)
    expect((await mcp('ld_unknown', 'tools/list')).status).toBe(401)
  })

  test('refused keys count per address like on /v1', async () => {
    const from = { [FROM]: randomIp() }
    for (let i = 0; i < 19; i++) expect((await mcp(`ld_wrong-${i}`, 'tools/list', {}, from)).status).toBe(401)
    expect((await mcp('ld_wrong-last', 'tools/list', {}, from)).status).toBe(429)
    expect((await mcp(memberKey, 'tools/list', {}, from)).status).toBe(429)
  })
})

describe('tools', () => {
  test('a member key gets the read tools and the public actions of its role, nothing internal', async () => {
    const { status, body } = await mcp(memberKey, 'tools/list')
    expect(status).toBe(200)
    const names = body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'calls_list',
        'calls_get',
        'contacts_search',
        'call_markDone',
        'contact_update',
        'appointment_book',
      ]),
    )
    for (const internal of [
      'call_start',
      'apiKey_create',
      'team_setRole',
      'phoneNumber_setup',
      'webhook_create',
      'user_disable',
    ])
      expect(names).not.toContain(internal)
    const markDone = body.result.tools.find((t: { name: string }) => t.name === 'call_markDone')
    expect(markDone.inputSchema).toMatchObject({ type: 'object', required: ['callId'] })
  })

  test('an action runs through the registry as the key: logged, in its workspace only', async () => {
    const done = await callTool(memberKey, 'call_markDone', { callId: ws.call.id })
    expect(done.body.result.isError).toBeFalsy()
    expect((await getCall(ws.call.id))!.inbox_state).toBe('done')
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'call.markDone'), eq(commands.workspace_id, ws.id)))
    expect(logged!.actor_id).toMatch(/^apikey:/)

    const foreign = await callTool(memberKey, 'call_markDone', { callId: other.call.id })
    expect(foreign.body.result).toMatchObject({ isError: true, content: [{ text: 'calls row not found' }] })
    expect((await getCall(other.call.id))!.inbox_state).toBe('open')
    expect((await callTool(memberKey, 'call_markDone', {})).body.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/callId/) }],
    })
  })

  test('read tools see only the own workspace: calls, one call with its transcript, contacts', async () => {
    await db.update(calls).set({ inbox_state: 'open', title: 'Leaking water heater' }).where(eq(calls.id, ws.call.id))
    const listed = toolData((await callTool(memberKey, 'calls_list', { inbox: 'all' })).body)
    expect((listed.calls as { id: string }[]).map(c => c.id)).toEqual([ws.call.id])
    const one = toolData((await callTool(memberKey, 'calls_get', { callId: ws.call.id })).body)
    expect(one).toMatchObject({ call: { id: ws.call.id, title: 'Leaking water heater' }, transcript: [] })
    expect((await callTool(memberKey, 'calls_get', { callId: other.call.id })).body.result).toMatchObject({
      isError: true,
    })
    const found = toolData((await callTool(memberKey, 'contacts_search', { query: 'Known' })).body)
    expect((found.contacts as { id: string }[]).map(c => c.id)).toEqual([ws.contact.id])
    expect(toolData((await callTool(memberKey, 'contacts_search', { query: '%' })).body).contacts).toEqual([])
  })
})

describe('with the official MCP client', () => {
  test('connects with the key, lists the tools and calls one (current protocol, negotiated by the client)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${memberKey}` } },
      fetch: async (url, init) => appRequest(new URL(String(url)).pathname, init),
    })
    const client = new Client({ name: 'linedesk-test', version: '1' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain('calls_list')
    const result = await client.callTool({ name: 'contacts_search', arguments: { query: 'Known' } })
    expect(result.structuredContent).toMatchObject({ contacts: [{ id: ws.contact.id }] })
    await client.close()
  })
})

describe('one message per request', () => {
  const post = (body: string, method = 'POST') =>
    appRequest('/mcp', {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${memberKey}`,
      },
      ...(method === 'POST' ? { body } : {}),
    })

  test('a JSON-RPC batch is refused before anything runs', async () => {
    await db.update(calls).set({ inbox_state: 'open' }).where(eq(calls.id, ws.call.id))
    const batch = Array.from({ length: 50 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'call_markDone', arguments: { callId: ws.call.id } },
    }))
    const res = await post(JSON.stringify(batch))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'JSON-RPC batches are not supported: send one message per request' })
    expect((await getCall(ws.call.id))!.inbox_state).toBe('open')
  })

  test('no change subscriptions, no session requests, no oversized bodies', async () => {
    expect(
      (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} }))).status,
    ).toBe(400)
    expect((await post('', 'GET')).status).toBe(405)
    expect((await post('', 'DELETE')).status).toBe(405)
    expect(
      (
        await post(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(300_000) } }),
        )
      ).status,
    ).toBe(413)
  })

  test(`a key has at most ${MCP_CONCURRENT_PER_KEY} requests in flight; a slot comes back when its answer is sent`, () => {
    const slots = Array.from({ length: MCP_CONCURRENT_PER_KEY }, () => takeSlot('key_concurrency'))
    expect(slots.every(Boolean)).toBe(true)
    expect(takeSlot('key_concurrency')).toBeNull()
    expect(takeSlot('key_other')).not.toBeNull()
    slots[0]!()
    slots[0]!() // releasing twice gives back one slot only
    const again = takeSlot('key_concurrency')
    expect(again).not.toBeNull()
    expect(takeSlot('key_concurrency')).toBeNull()
    for (const release of [again, ...slots]) release!()
  })
})
