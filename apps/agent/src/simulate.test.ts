import { expect, test } from 'vitest'
import { ActionError, createApiClient } from './api-client.ts'
import { simScripts } from './sim-scripts.ts'
import { defaultNumber, explain, parseArgs, playScript } from './simulate.ts'

type Sent = { action: string; body: any; headers: Record<string, string> }

function fakeApi(sent: Sent[]) {
  const fakeFetch: typeof fetch = async (url, init) => {
    const action = String(url).split('/v1/actions/')[1]!
    sent.push({ action, body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> })
    const data = action === 'call.start'
      ? { callId: 'call_1', workspaceId: 'ws_1', contact: { id: 'ct_1' }, assistant: { greeting: 'Hello from Maya.' } }
      : undefined
    return Response.json({ ok: true, rows: {}, data })
  }
  return createApiClient({ baseUrl: 'http://api.test', token: 'secret', fetch: fakeFetch })
}

test('plays a script as start, transcript segments, finish', async () => {
  const sent: Sent[] = []
  const callId = await playScript(fakeApi(sent), simScripts.leak, { to: '+15035550142', wait: async () => {} })

  expect(callId).toBe('call_1')
  expect(sent.map(s => s.action)).toEqual(['call.start', ...simScripts.leak.lines.map(() => 'call.appendTranscript'), 'call.finish'])
  expect(sent[0]!.body).toEqual({ from: simScripts.leak.from, to: '+15035550142', source: 'simulated' })
  expect(sent[0]!.headers.authorization).toBe('Bearer secret')
  expect(sent[1]!.body).toMatchObject({ callId: 'call_1', speaker: 'agent', text: 'Hello from Maya.' })
  expect(sent[1]!.headers['x-workspace-id']).toBe('ws_1')
  const flagged = sent.find(s => s.body.toolEvent?.tool === 'call.flagUrgent')
  expect(flagged?.body.speaker).toBe('system')
  expect(sent.at(-1)!.body).toMatchObject({ callId: 'call_1', outcome: 'callback', urgency: 'urgent' })
})

test('a rejected action throws with the API error', async () => {
  const api = createApiClient({
    baseUrl: 'http://api.test', token: 'secret',
    fetch: async () => Response.json({ ok: false, error: 'no workspace for number +1' }, { status: 409 }),
  })
  await expect(playScript(api, simScripts.hangup, { to: '+1', wait: async () => {} }))
    .rejects.toThrow(new ActionError('call.start', 409, 'no workspace for number +1'))
})

test('--to takes the number in either form and is never read as the script', () => {
  expect(parseArgs(['booking', '--to', '+15550100000', '--fast'])).toEqual({ to: '+15550100000', fast: true, name: 'booking' })
  expect(parseArgs(['--to=+15550100000'])).toEqual({ to: '+15550100000', fast: false, name: 'leak' })
  expect(parseArgs([])).toEqual({ to: undefined, fast: false, name: 'leak' })
  expect(() => parseArgs(['--to'])).toThrow('--to needs a number')
})

const listing = (numbers: string[]) => createApiClient({
  baseUrl: 'http://api.test', token: 'secret',
  fetch: async () => Response.json({ ok: true, rows: {}, data: { numbers } }),
})

test("without --to the install's only number is dialled; none or several say what to pass", async () => {
  expect(await defaultNumber(listing(['+15550100000']))).toBe('+15550100000')
  await expect(defaultNumber(listing([]))).rejects.toThrow('has no Linedesk number yet')
  await expect(defaultNumber(listing(['+15550100000', '+15550100001']))).rejects.toThrow('Pass --to <your Linedesk number>')
})

test('a wrong number or token says what to do', () => {
  expect((explain(new ActionError('call.start', 409, 'no workspace for number +1')) as Error).message)
    .toBe('No workspace has this number. Pass --to <your Linedesk number>.')
  expect((explain(new ActionError('call.listNumbers', 401, 'not signed in or no workspace')) as Error).message)
    .toBe("AGENT_API_TOKEN does not match the API's. Use the same value as the API's .env.")
})
