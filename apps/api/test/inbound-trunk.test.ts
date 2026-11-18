// LiveKit's inbound trunk takes calls to exactly the connected numbers (inbound-trunk.ts): written after a number is
// set up or released, never written empty, never anything but the numbers. LiveKit is a fake here (its Twirp API).
// Reads every workspace's numbers, so this file has a database of its own (INSTANCE_WIDE_FILES).
import { phone_numbers } from '@linedesk/db'
import { devProvider } from '@linedesk/telephony'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { INBOUND_TRUNK_NAME, requestInboundTrunkSync, syncInboundTrunk } from '../src/inbound-trunk.ts'
import { act, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

vi.mock('../src/provider-settings.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/provider-settings.ts')>()
  return { ...original, telephonyProvider: async () => devProvider }
})

const env = {
  LIVEKIT_URL: 'ws://livekit.test:7880',
  LIVEKIT_API_KEY: 'lk-key',
  LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-lk',
}

type Trunk = { sipTrunkId: string; name: string; numbers?: string[]; allowedAddresses?: string[] }

/** LiveKit's SIP API with these inbound trunks; records every request. */
function fakeLivekit(trunks: Trunk[], { failWith }: { failWith?: number } = {}) {
  const requests: { method: string; body: Record<string, unknown> }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split('/').pop()!
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    requests.push({ method, body })
    if (failWith) return new Response('{"msg":"unavailable"}', { status: failWith })
    if (method === 'ListSIPInboundTrunk')
      // Protobuf JSON leaves an empty list out.
      return Response.json({ items: trunks.map(t => (t.numbers?.length ? t : { ...t, numbers: undefined })) })
    if (method === 'UpdateSIPInboundTrunk') {
      const trunk = trunks.find(t => t.sipTrunkId === body.sipTrunkId)!
      trunk.numbers = (body.update as { numbers: { set: string[] } }).numbers.set
      return Response.json(trunk)
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  const writes = () => requests.filter(r => r.method !== 'ListSIPInboundTrunk')
  return { fetch, requests, writes }
}

const connected = async () =>
  (await db.select({ e164: phone_numbers.e164 }).from(phone_numbers)).map(row => row.e164).sort()

let ws: Workspace
beforeAll(async () => {
  // The first test needs a database without numbers; every workspace below comes with one.
  await db.delete(phone_numbers)
})
beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('no number connected: the trunk keeps its numbers (an empty list would leave or open it)', async () => {
  expect(await connected()).toEqual([])
  const livekit = fakeLivekit([{ sipTrunkId: 'ST_in', name: INBOUND_TRUNK_NAME, numbers: ['+15035550100'] }])
  expect(await syncInboundTrunk({ env, fetch: livekit.fetch })).toEqual({ status: 'no-numbers' })
  expect(livekit.writes()).toEqual([])
})

test('without LiveKit settings nothing is asked', async () => {
  const livekit = fakeLivekit([])
  expect(await syncInboundTrunk({ env: {}, fetch: livekit.fetch })).toEqual({ status: 'off' })
  expect(livekit.requests).toEqual([])
})

test('writes exactly the connected numbers, only the numbers, and only the trunk of its name', async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  const numbers = await connected()
  const ours = {
    sipTrunkId: 'ST_in',
    name: INBOUND_TRUNK_NAME,
    numbers: ['+15035550100'],
    allowedAddresses: ['192.0.2.1'],
  }
  const other = { sipTrunkId: 'ST_oncall', name: 'linedesk-oncall-test', numbers: ['+15035550199'] }
  const livekit = fakeLivekit([ours, other])

  expect(await syncInboundTrunk({ env, fetch: livekit.fetch })).toEqual({
    status: 'updated',
    added: numbers,
    removed: ['+15035550100'],
  })
  // A field update of the numbers alone: addresses, headers and call length stay setup-sip's.
  expect(livekit.writes()).toEqual([
    { method: 'UpdateSIPInboundTrunk', body: { sipTrunkId: 'ST_in', update: { numbers: { set: numbers } } } },
  ])
  expect(other.numbers).toEqual(['+15035550199'])

  // Already right: nothing is written.
  const again = fakeLivekit([{ ...ours, numbers: [...numbers].reverse() }])
  expect(await syncInboundTrunk({ env, fetch: again.fetch })).toEqual({ status: 'unchanged' })
  expect(again.writes()).toEqual([])
})

test('no trunk yet (setup-sip makes it): nothing is created', async () => {
  const livekit = fakeLivekit([{ sipTrunkId: 'ST_x', name: 'something-else', numbers: ['+15035550100'] }])
  expect(await syncInboundTrunk({ env, fetch: livekit.fetch })).toEqual({ status: 'missing' })
  expect(livekit.writes()).toEqual([])
})

test('a number set up takes calls when the command answers, and a released one no longer', async () => {
  const trunk: Trunk = { sipTrunkId: 'ST_in', name: INBOUND_TRUNK_NAME, numbers: await connected() }
  const livekit = fakeLivekit([trunk])
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.stubGlobal('fetch', livekit.fetch)

  // A German number attached: as any other, it is added to the trunk.
  const e164 = `+4930${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const res = await act(ws.owner, 'phoneNumber.setup', { e164 })
  expect(res.status).toBe(200)
  expect(trunk.numbers).toContain(e164)
  expect(trunk.numbers).toEqual(await connected())

  const [row] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))
  const released = await act(ws.owner, 'phoneNumber.release', { phoneNumberId: row!.id, confirm: e164 })
  expect(released.status).toBe(200)
  expect(trunk.numbers).not.toContain(e164)
  expect(trunk.numbers).toEqual(await connected())
})

test('requests while a sync runs share one more sync, which sees every number committed before it', async () => {
  const trunk: Trunk = { sipTrunkId: 'ST_in', name: INBOUND_TRUNK_NAME, numbers: await connected() }
  const livekit = fakeLivekit([trunk])
  const first = requestInboundTrunkSync({ env, fetch: livekit.fetch })
  const added = randomNumber()
  await db
    .insert(phone_numbers)
    .values({ id: `pn_${crypto.randomUUID()}`, workspace_id: ws.id, e164: added, provider: 'dev' })
  const second = requestInboundTrunkSync({ env, fetch: livekit.fetch })
  const third = requestInboundTrunkSync({ env, fetch: livekit.fetch })
  expect(third).toBe(second)
  await Promise.all([first, second])
  expect(livekit.requests.filter(r => r.method === 'ListSIPInboundTrunk')).toHaveLength(2)
  expect(trunk.numbers).toContain(added)
  expect(trunk.numbers).toEqual(await connected())
})

test('LiveKit failing: logged as an ALERT, never thrown, and tried again later', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const down = fakeLivekit([], { failWith: 503 })
    expect(await requestInboundTrunkSync({ env, fetch: down.fetch })).toBeNull()
    expect(errors.mock.calls.flat().join(' ')).toMatch(/ALERT inbound trunk: .*HTTP 503/)
    expect(down.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(down.requests).toHaveLength(2))
  } finally {
    vi.useRealTimers()
  }
})
