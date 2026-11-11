import { createHmac } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { deleteLivekitRoom, livekitStatus } from './livekit-status.ts'

const env = {
  LIVEKIT_URL: 'wss://livekit.example.test/',
  LIVEKIT_API_KEY: 'APImadeup',
  LIVEKIT_API_SECRET: 'made-up-secret-0123456789',
}
type Call = [string, RequestInit]
const answers = (byPath: Record<string, [number, unknown]>) =>
  vi.fn(async (url: string) => {
    const [status, body] = Object.entries(byPath).find(([path]) => url.endsWith(path))![1]
    return new Response(JSON.stringify(body), { status })
  })

test('server and SIP service answer: both are reported with what they hold', async () => {
  const fetchMock = answers({ ListRooms: [200, { rooms: [{}, {}] }], ListSIPInboundTrunk: [200, { items: [{}] }] })
  expect(await livekitStatus(env, fetchMock as unknown as typeof fetch)).toEqual({
    url: 'wss://livekit.example.test/',
    server: { ok: true, message: 'Reachable, 2 rooms open' },
    sip: { ok: true, message: '1 inbound trunk configured' },
  })
  const [url, init] = fetchMock.mock.calls[0] as unknown as Call
  expect(url).toBe('https://livekit.example.test/twirp/livekit.RoomService/ListRooms')
  const [head, claims, signature] = new Headers(init.headers).get('authorization')!.replace('Bearer ', '').split('.')
  expect(createHmac('sha256', env.LIVEKIT_API_SECRET).update(`${head}.${claims}`).digest('base64url')).toBe(signature)
  const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString())
  expect(payload).toMatchObject({ iss: 'APImadeup', video: { roomList: true } })
  expect(payload.exp - payload.nbf).toBeLessThanOrEqual(120)
  const sipClaims = new Headers((fetchMock.mock.calls[1] as unknown as Call)[1].headers)
    .get('authorization')!
    .split('.')[1]!
  expect(JSON.parse(Buffer.from(sipClaims, 'base64url').toString()).sip).toEqual({ admin: true })
})

test('SIP: an error, and a server without an inbound trunk', async () => {
  const fetchMock = answers({
    ListRooms: [200, {}],
    ListSIPInboundTrunk: [500, { code: 'internal', msg: 'sip not connected (redis required)' }],
  })
  const status = await livekitStatus(env, fetchMock as unknown as typeof fetch)
  expect(status.server).toEqual({ ok: true, message: 'Reachable, 0 rooms open' })
  expect(status.sip).toEqual({
    ok: false,
    message: 'The SIP API answered HTTP 500: sip not connected (redis required)',
  })
})

test('a server that is down, rejects the key or is not configured; the secret never shows', async () => {
  const refused = vi.fn(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }) })
  })
  const down = await livekitStatus(env, refused as unknown as typeof fetch)
  expect(down.server).toEqual({ ok: false, message: 'Not reachable: ECONNREFUSED' })
  expect(down.sip).toEqual({ ok: false, message: 'Not checked: the LiveKit server does not answer' })
  expect(refused).toHaveBeenCalledTimes(1)

  const rejected = await livekitStatus(
    env,
    answers({ ListRooms: [401, { msg: 'invalid token' }] }) as unknown as typeof fetch,
  )
  expect(rejected.server).toEqual({ ok: false, message: 'LiveKit rejected the API key and secret (HTTP 401)' })

  const unset = await livekitStatus({ LIVEKIT_URL: 'ws://localhost:7880' }, refused as unknown as typeof fetch)
  expect(unset).toMatchObject({
    url: 'ws://localhost:7880',
    server: { ok: false },
    sip: { ok: false, message: 'Not checked: LiveKit is not set up' },
  })
  expect(JSON.stringify([down, rejected, unset])).not.toContain(env.LIVEKIT_API_SECRET)
})

test('a server without an inbound trunk cannot receive calls', async () => {
  const fetchMock = answers({ ListRooms: [200, {}], ListSIPInboundTrunk: [200, { items: [] }] })
  const status = await livekitStatus(env, fetchMock as unknown as typeof fetch)
  expect(status.server.ok).toBe(true)
  expect(status.sip).toEqual({ ok: false, message: 'No inbound trunk, so no call can arrive (run setup-sip)' })
})

test('deleting a room: one signed DeleteRoom request; gone already counts as deleted; no LiveKit set up is false', async () => {
  const fetchMock = answers({ DeleteRoom: [200, {}] })
  expect(await deleteLivekitRoom('call-abc', env, fetchMock as unknown as typeof fetch)).toBe(true)
  const [url, init] = fetchMock.mock.calls[0] as unknown as Call
  expect(url).toBe('https://livekit.example.test/twirp/livekit.RoomService/DeleteRoom')
  expect(JSON.parse(String(init.body))).toEqual({ room: 'call-abc' })
  const claims = new Headers(init.headers).get('authorization')!.replace('Bearer ', '').split('.')[1]!
  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ video: { roomCreate: true } })
  expect(await deleteLivekitRoom('call-gone', env, answers({ DeleteRoom: [404, { code: 'not_found' }] }) as unknown as typeof fetch)).toBe(true)
  expect(await deleteLivekitRoom('call-x', env, answers({ DeleteRoom: [401, {}] }) as unknown as typeof fetch)).toBe(false)
  expect(await deleteLivekitRoom('call-x', {}, fetchMock as unknown as typeof fetch)).toBe(false)
})
