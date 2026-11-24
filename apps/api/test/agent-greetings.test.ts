// GET /v1/agent/greetings (LIN-679): what each assistant a phone number answers with would greet with, for the voice
// agent to store the greeting audio before the first call. The install-wide agent token only.
import { beforeAll, expect, test } from 'vitest'
import { act, agent, createWorkspace, randomNumber, request, type Workspace } from './helpers.ts'

let ws: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Agent Greetings')
})

test('the agent token reads the greeting of the assistant a number answers with', async () => {
  const { status, body } = await request(agent(), 'GET', '/v1/agent/greetings')
  expect(status).toBe(200)
  const mine = (body.greetings as { assistant: { workspace_id: string; greeting: string } }[]).filter(
    g => g.assistant.workspace_id === ws.id,
  )
  expect(mine.length).toBe(1)
  expect(typeof mine[0]!.assistant.greeting).toBe('string')
  expect(mine[0]).toHaveProperty('keepRecording')
})

test('a call token cannot read them', async () => {
  const started = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect(started.status).toBe(200)
  const res = await request(agent(ws.id, started.body.data.callToken as string), 'GET', '/v1/agent/greetings')
  expect(res.status).toBe(403)
})
