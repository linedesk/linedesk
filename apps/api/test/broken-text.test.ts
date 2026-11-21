// Text in any language arrives whole on every write path, and text that lost a letter (U+FFFD) is refused
// before it is stored (packages/actions/src/broken-text.ts). The frischluft case of 2026-11-19: an AI agent sent
// "Gespr\uFFFDch" through the setup MCP, and it was kept for good.
import { contacts, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, appRequest, createWorkspace, FROM, randomIp, type Workspace } from './helpers.ts'

const R = String.fromCharCode(0xfffd)
const TEXTS = [
  'Dieses Gespräch kann aufgezeichnet und transkribiert werden.',
  'Straße, Größe, Öffnungszeiten',
  'Café, niño, Łódź, Ærø',
  '日本語の通話は録音されます',
  'Этот звонок записывается',
  'قد يتم تسجيل هذه المكالمة',
  'Willkommen 👋🏽',
]

let ws: Workspace
let id = 0

const notice = async (workspaceId: string) =>
  (await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId)))[0]
    ?.recording_notice

async function mcp(path: string, args: Record<string, unknown>, tool: string, headers: Record<string, string> = {}) {
  const res = await appRequest(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [FROM]: randomIp(),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return JSON.parse(json) as any
}

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})

describe('POST /v1/actions (the web app, its outbox and the REST API)', () => {
  test('every script is stored as sent', async () => {
    for (const text of TEXTS) {
      const res = await act(ws.owner, 'workspace.updateSettings', { recordingNotice: text })
      expect(res.status).toBe(200)
      expect(await notice(ws.id)).toBe(text)
    }
  })

  test('the body is read as UTF-8 bytes, whatever charset its header names, and in tiny chunks', async () => {
    const text = 'Gespräch über Größe 日本語'
    const bytes = new TextEncoder().encode(JSON.stringify({ recordingNotice: text }))
    // A stream of one byte per chunk: a letter split across chunks still arrives whole.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(Uint8Array.of(b))
        c.close()
      },
    })
    const res = await appRequest('/v1/actions/workspace.updateSettings', {
      method: 'POST',
      headers: { ...ws.owner.headers, 'content-type': 'application/json; charset=iso-8859-1' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(200)
    expect(await notice(ws.id)).toBe(text)
  })

  test('U+FFFD is refused with a clear error and nothing is stored', async () => {
    await act(ws.owner, 'workspace.updateSettings', { recordingNotice: TEXTS[0] })
    const res = await act(ws.owner, 'workspace.updateSettings', { recordingNotice: `Dieses Gespr${R}ch kann …` })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/^Recording notice: it holds "\uFFFD" \(U\+FFFD\)/)
    expect(await notice(ws.id)).toBe(TEXTS[0])
    const contact = await act(ws.owner, 'contact.create', { phone: '+15035550188', name: `J${R}rg` })
    expect(contact.status).toBe(422)
    const stored = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, ws.id), eq(contacts.phone, '+15035550188')))
    expect(stored).toEqual([])
  })
})

describe('MCP (API keys) and the setup MCP (AI agents)', () => {
  test('a workspace MCP tool keeps umlauts and refuses U+FFFD', async () => {
    const made = await act(ws.owner, 'apiKey.create', { name: 'Claude', role: 'admin' })
    const auth = { authorization: `Bearer ${made.body.data.key}` }
    const ok = await mcp('/mcp', { phone: '+15035550177', name: 'Jürgen Größe' }, 'contact_create', auth)
    expect(ok.result.isError).toBeFalsy()
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, ws.id), eq(contacts.phone, '+15035550177')))
    expect(row?.name).toBe('Jürgen Größe')
    const bad = await mcp('/mcp', { phone: '+15035550178', name: `J${R}rgen` }, 'contact_create', auth)
    expect(bad.result.isError).toBe(true)
    expect(JSON.stringify(bad.result.content)).toContain('U+FFFD')
  })

  test("the setup MCP stores the agent's umlauts and refuses U+FFFD (the frischluft case)", async () => {
    const own = await createWorkspace('frischluft Fensterbrett')
    const made = await act(own.owner, 'agentSetup.createWorkspaceKey', {})
    expect(made.status).toBe(200)
    const path = `/mcp/setup/${made.body.data.key}`
    const ok = await mcp(path, { workspaceId: own.id, recordingNotice: TEXTS[0] }, 'workspace_updateSettings')
    expect(ok.result.isError).toBeFalsy()
    expect(await notice(own.id)).toBe(TEXTS[0])
    const bad = await mcp(
      path,
      { workspaceId: own.id, recordingNotice: `Dieses Gespr${R}ch kann aufgezeichnet werden.` },
      'workspace_updateSettings',
    )
    expect(bad.result.isError).toBe(true)
    expect(JSON.stringify(bad.result.content)).toContain('U+FFFD')
    expect(await notice(own.id)).toBe(TEXTS[0])
  })
})
