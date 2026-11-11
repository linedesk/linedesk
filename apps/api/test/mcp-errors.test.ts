// MCP tools never pass an unexpected error's text (a database error carries SQL and parameters) to the caller.
import { beforeAll, expect, test, vi } from 'vitest'
import { act, appRequest, createWorkspace, type Workspace } from './helpers.ts'

vi.mock('../src/run-action.ts', async original => ({
  ...(await original<typeof import('../src/run-action.ts')>()),
  runAction: vi.fn(async (name: string, ...rest: unknown[]) => {
    if (name === 'call.markDone')
      throw new Error('update "calls" set "inbox_state" = $1 where "id" = $2 -- params: done,call_secret')
    const real = await vi.importActual<typeof import('../src/run-action.ts')>('../src/run-action.ts')
    return real.runAction(name, ...(rest as [unknown, never]))
  }),
}))

let ws: Workspace
let key: string

beforeAll(async () => {
  ws = await createWorkspace('Error Plumbing')
  key = (await act(ws.owner, 'apiKey.create', { name: 'Claude', role: 'member' })).body.data.key
})

test('an unexpected error becomes "internal error"; the details stay in the server log', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const res = await appRequest('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'call_markDone', arguments: { callId: ws.call.id } },
    }),
  })
  const text = await res.text()
  expect(text).toContain('internal error')
  expect(text).not.toContain('inbox_state')
  expect(text).not.toContain('call_secret')
  expect(logged.mock.calls.flat().join(' ')).toContain('inbox_state')
  logged.mockRestore()
})
