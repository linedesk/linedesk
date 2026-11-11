// The voice agent's token: only from inside the install (never through the public site), guessing it
// is throttled, it must be long, and the S3 secret never goes to the agent: the API starts S3 recordings.
import { agentTokenProblem, DEV_AGENT_TOKEN } from '@linedesk/actions'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { agentEntryAllowed, INVALID_AGENT_TOKENS_PER_IP } from '../src/context.ts'
import { s3EgressRequest } from '../src/recording-egress.ts'
import { assistants, calls } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, FROM, randomIp, request, type Workspace } from './helpers.ts'

let ws: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Agent Access')
})

describe('where the agent token works', () => {
  test('through the public site (Caddy marks it) it counts for nothing, inside the install it works', async () => {
    const publicEntry = { 'x-linedesk-entry': 'public' }
    expect((await request(agent(), 'GET', '/v1/agent/provider-config', undefined, publicEntry)).status).toBe(401)
    expect(
      (await act({ headers: { ...agent(ws.id).headers, ...publicEntry } }, 'call.flagUrgent', { callId: ws.call.id }))
        .status,
    ).toBe(401)
    expect(
      (await request(agent(), 'GET', '/v1/agent/provider-config', undefined, { 'x-linedesk-entry': 'internal' }))
        .status,
    ).toBe(200)
    expect((await request(agent(), 'GET', '/v1/agent/provider-config')).status).toBe(200)
  })

  test('only the internal listener counts; without the entry header only outside production', () => {
    expect(agentEntryAllowed('internal', true)).toBe(true)
    expect(agentEntryAllowed('public', false)).toBe(false)
    expect(agentEntryAllowed('anything', false)).toBe(false)
    // Straight to api:3100 on the install's network, around the proxy.
    expect(agentEntryAllowed(null, true)).toBe(false)
    expect(agentEntryAllowed(null, false)).toBe(true)
  })

  test('an address that guesses wrong tokens is refused for a while, also with the right one; others are not', async () => {
    const ip = randomIp()
    const from = (token?: string) => ({ headers: { ...agent(undefined, token).headers, [FROM]: ip } })
    for (let i = 1; i < INVALID_AGENT_TOKENS_PER_IP; i++) {
      expect((await request(from(`guess-${i}`), 'GET', '/v1/agent/provider-config')).status).toBe(401)
    }
    // The last allowed guess is answered with 429 at once, and so is everything after it.
    expect((await request(from('guess-again'), 'GET', '/v1/agent/provider-config')).status).toBe(429)
    expect((await request(from(), 'GET', '/v1/agent/provider-config')).status).toBe(429)
    expect((await request(agent(), 'GET', '/v1/agent/provider-config')).status).toBe(200)
  })
})

test('the token must be at least 32 characters and not a placeholder (the .env.example value only off a server)', () => {
  expect(agentTokenProblem(undefined)).toMatch('not set')
  expect(agentTokenProblem('change-me')).toMatch('placeholder')
  expect(agentTokenProblem('a'.repeat(31))).toMatch('shorter than 32')
  expect(agentTokenProblem('a'.repeat(32))).toBeNull()
  expect(agentTokenProblem(DEV_AGENT_TOKEN)).toBeNull()
  expect(agentTokenProblem(DEV_AGENT_TOKEN, { production: true })).toMatch('placeholder')
})

describe('S3 recordings are started by the API', () => {
  const env = {
    RECORDING_STORE: 's3',
    S3_ENDPOINT: 'https://s3.test',
    S3_BUCKET: 'calls',
    S3_ACCESS_KEY_ID: 'key-id',
    S3_SECRET_ACCESS_KEY: 'bucket-secret-0123456789',
    LIVEKIT_URL: 'ws://livekit.test:7880',
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-lk-secret',
  }
  const before = { ...process.env }
  afterEach(() => {
    process.env = { ...before }
    vi.restoreAllMocks()
  })

  /** LiveKit's egress service: remembers the rooms it records; `starts` lists each start request. */
  function fakeEgress() {
    const realFetch = globalThis.fetch
    const recording = new Map<string, string>()
    const starts: Record<string, unknown>[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url)
      if (!target.startsWith('http://livekit.test')) return realFetch(url, init)
      const body = JSON.parse(String(init!.body))
      if (target.endsWith('/ListEgress')) {
        const id = recording.get(body.room_name)
        return Response.json({ items: id ? [{ egress_id: id, room_name: body.room_name }] : [] })
      }
      expect(target).toBe('http://livekit.test:7880/twirp/livekit.Egress/StartRoomCompositeEgress')
      starts.push(body)
      const id = `EG_${starts.length}`
      recording.set(body.room_name, id)
      return Response.json({ egress_id: id })
    })
    return { starts, fetchSpy }
  }

  test('call.startRecording asks LiveKit egress to write the call into the bucket, with the keys only the API has', async () => {
    Object.assign(process.env, env)
    const { starts } = fakeEgress()
    const res = await act(agent(ws.id), 'call.startRecording', { callId: ws.call.id })
    expect(res).toMatchObject({ status: 200, body: { data: { egressId: 'EG_1' } } })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      audio_only: true,
      file_outputs: [
        {
          file_type: 'OGG',
          filepath: `${ws.id}/${ws.call.id}.ogg`,
          s3: { bucket: 'calls', secret: env.S3_SECRET_ACCESS_KEY },
        },
      ],
    })
    // The agent's settings never carry the secret.
    expect(JSON.stringify((await request(agent(), 'GET', '/v1/agent/provider-config')).body)).not.toContain(
      env.S3_SECRET_ACCESS_KEY,
    )
  })

  test('a repeated start returns the egress already recording the call, and starts no second one', async () => {
    Object.assign(process.env, env)
    const own = await createWorkspace('Agent Access Retry')
    const { starts } = fakeEgress()
    const first = await act(agent(own.id), 'call.startRecording', { callId: own.call.id })
    const again = await act(agent(own.id), 'call.startRecording', { callId: own.call.id })
    expect(first.body.data).toEqual({ egressId: 'EG_1' })
    expect(again.body.data).toEqual({ egressId: 'EG_1' })
    expect(starts).toHaveLength(1)
  })

  test('refused once the call has ended, and when its assistant does not record calls', async () => {
    Object.assign(process.env, env)
    const { starts } = fakeEgress()
    const ended = await createWorkspace('Agent Access Ended')
    await db.update(calls).set({ status: 'completed' }).where(eq(calls.id, ended.call.id))
    expect((await act(agent(ended.id), 'call.startRecording', { callId: ended.call.id })).body.error).toBe(
      'the call has ended',
    )
    const unrecorded = await createWorkspace('Agent Access No Recording')
    await db.update(assistants).set({ record_calls: false }).where(eq(assistants.id, unrecorded.assistant.id))
    await db.update(calls).set({ assistant_id: unrecorded.assistant.id }).where(eq(calls.id, unrecorded.call.id))
    expect((await act(agent(unrecorded.id), 'call.startRecording', { callId: unrecorded.call.id })).body.error).toBe(
      "the call's assistant does not record calls",
    )
    expect(starts).toHaveLength(0)
  })

  test("refused when the store is not S3, for another workspace's call, and for members", async () => {
    Object.assign(process.env, { ...env, RECORDING_STORE: 'file' })
    expect((await act(agent(ws.id), 'call.startRecording', { callId: ws.call.id })).body.error).toBe(
      'the recording storage in effect is not S3',
    )
    const other = await createWorkspace('Agent Access Other')
    expect((await act(agent(other.id), 'call.startRecording', { callId: ws.call.id })).body.error).toBe(
      'call not found',
    )
    expect((await act(ws.owner, 'call.startRecording', { callId: ws.call.id })).status).toBe(403)
  })

  test('names what is missing, never the values', () => {
    expect(() => s3EgressRequest('room', 'ws_1/call_1.ogg', { endpoint: 'https://s3.test', bucket: 'calls' })).toThrow(
      'S3 recording storage is missing: access_key_id, secret_access_key',
    )
  })
})
