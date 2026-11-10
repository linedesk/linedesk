// LiveKit is part of the install, not a provider: its URL, key and secret are set in env. The
// admin area only shows whether the server and its SIP service answer.
import { createHmac } from 'node:crypto'
import { errorText, TIMEOUT_MS } from './provider-test.ts'

type Env = Record<string, string | undefined>
export type ServiceStatus = { ok: boolean; message: string }
/** `sip` is the SIP setup on the server (inbound trunks); the SIP bridge itself is not probed. */
export type LivekitStatus = { url: string | null; server: ServiceStatus; sip: ServiceStatus }

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** A LiveKit access token with the given grants: by default for one minute, for the admin checks. */
export function livekitToken(
  apiKey: string,
  apiSecret: string,
  grants: object,
  nowSec = Math.floor(Date.now() / 1000),
  { identity = 'callfront-admin', ttlSec = 60 }: { identity?: string; ttlSec?: number } = {},
) {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({ iss: apiKey, sub: identity, nbf: nowSec - 10, exp: nowSec + ttlSec, ...grants }),
  )
  return `${head}.${claims}.${base64url(createHmac('sha256', apiSecret).update(`${head}.${claims}`).digest())}`
}

async function call(
  doFetch: typeof fetch,
  url: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await doFetch(url, {
    method: 'POST',
    body: '{}',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, body: ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {} }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const failure = (status: number, body: Record<string, unknown>) =>
  status === 401 || status === 403
    ? `rejected the API key and secret (HTTP ${status})`
    : `answered HTTP ${status}${typeof body.msg === 'string' ? `: ${body.msg.slice(0, 160)}` : ''}`

async function check(run: () => Promise<ServiceStatus>): Promise<ServiceStatus> {
  try {
    return await run()
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    return {
      ok: false,
      message: timedOut ? `No answer within ${TIMEOUT_MS / 1000} seconds` : `Not reachable: ${errorText(e)}`,
    }
  }
}

/** Asks the LiveKit server for its rooms and its SIP trunks. `doFetch` is replaced in tests. */
export async function livekitStatus(env: Env = process.env, doFetch: typeof fetch = fetch): Promise<LivekitStatus> {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env
  if (!url || !key || !secret) {
    const missing = {
      ok: false,
      message: 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not all set in the environment',
    }
    return { url: url ?? null, server: missing, sip: missing }
  }
  const base = `${url.replace(/^ws/, 'http').replace(/\/+$/, '')}/twirp`
  const server = await check(async () => {
    const { status, body } = await call(
      doFetch,
      `${base}/livekit.RoomService/ListRooms`,
      livekitToken(key, secret, { video: { roomList: true } }),
    )
    if (status !== 200) return { ok: false, message: `LiveKit ${failure(status, body)}` }
    return { ok: true, message: `Reachable, ${count(Array.isArray(body.rooms) ? body.rooms.length : 0, 'room')} open` }
  })
  if (!server.ok) return { url, server, sip: { ok: false, message: 'Not checked: the LiveKit server does not answer' } }
  const sip = await check(async () => {
    const { status, body } = await call(
      doFetch,
      `${base}/livekit.SIP/ListSIPInboundTrunk`,
      livekitToken(key, secret, { sip: { admin: true } }),
    )
    if (status !== 200) return { ok: false, message: `The SIP API ${failure(status, body)}` }
    const trunks = Array.isArray(body.items) ? body.items.length : 0
    // The server answers this without the SIP bridge running; it shows the setup, not that the bridge is up.
    if (!trunks) return { ok: false, message: 'No inbound trunk, so no call can arrive (run setup-sip)' }
    return { ok: true, message: `${count(trunks, 'inbound trunk')} configured` }
  })
  return { url, server, sip }
}
