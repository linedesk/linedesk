// LiveKit is part of the install, not a provider: its URL, key and secret are set in env. The
// admin area only shows whether the server and its SIP service answer.
import { english, type Words } from '@linedesk/actions'
import { createHmac } from 'node:crypto'
import { normalizeCallerId } from '@linedesk/actions'
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
  { identity = 'linedesk-admin', ttlSec = 60 }: { identity?: string; ttlSec?: number } = {},
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

/** "LiveKit rejected the API key and secret (HTTP 401)", "The SIP API answered HTTP 500: …". */
const failure = (part: 'server' | 'sip', status: number, body: Record<string, unknown>, words: Words) =>
  status === 401 || status === 403
    ? words.t(part === 'server' ? 'admin.livekit.server.rejected' : 'admin.livekit.sip.rejected', { status })
    : typeof body.msg === 'string'
      ? words.t(part === 'server' ? 'admin.livekit.server.answeredWith' : 'admin.livekit.sip.answeredWith', {
          status,
          detail: body.msg.slice(0, 160),
        })
      : words.t(part === 'server' ? 'admin.livekit.server.answered' : 'admin.livekit.sip.answered', { status })

async function check(run: () => Promise<ServiceStatus>, words: Words): Promise<ServiceStatus> {
  try {
    return await run()
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    return {
      ok: false,
      message: timedOut
        ? words.t('admin.livekit.timeout', { seconds: TIMEOUT_MS / 1000 })
        : words.t('admin.livekit.unreachable', { error: errorText(e) }),
    }
  }
}

/** LiveKit's API base for a server URL (ws:// or http://). */
const twirpBase = (url: string) => `${url.replace(/^ws/, 'http').replace(/\/+$/, '')}/twirp`

/**
 * Deletes a LiveKit room: whoever is in it is disconnected, so a phone caller is hung up on and an agent still
 * in it stops. True when the room is gone (deleted, or not there); false when LiveKit is not set up or refused.
 */
export async function deleteLivekitRoom(room: string, env: Env = process.env, doFetch: typeof fetch = fetch): Promise<boolean> {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env
  if (!url || !key || !secret) return false
  const res = await doFetch(`${twirpBase(url)}/livekit.RoomService/DeleteRoom`, {
    method: 'POST',
    body: JSON.stringify({ room }),
    headers: { authorization: `Bearer ${livekitToken(key, secret, { video: { roomCreate: true } })}`, 'content-type': 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return res.ok || res.status === 404
}

/**
 * The rooms open on the LiveKit server right now (ListRooms answers all of them at once, no pages), each with how many
 * participants are in it. A room stays open with nobody in it after its agent died (LiveKit keeps it for the job), so
 * an open room alone does not mean anyone is on the call. A room without a participant count counts as occupied.
 * Null when LiveKit is not set up, refuses or does not answer: the caller cannot tell then which rooms are gone.
 */
export async function listLivekitRooms(env: Env = process.env, doFetch: typeof fetch = fetch): Promise<Map<string, number> | null> {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env
  if (!url || !key || !secret) return null
  try {
    const { status, body } = await call(
      doFetch,
      `${twirpBase(url)}/livekit.RoomService/ListRooms`,
      livekitToken(key, secret, { video: { roomList: true } }),
    )
    if (status !== 200 || (body.rooms !== undefined && !Array.isArray(body.rooms))) return null
    const rooms = (body.rooms ?? []) as { name?: unknown; num_participants?: unknown }[]
    return new Map(
      rooms.flatMap(r => (typeof r.name === 'string' ? [[r.name, r.num_participants === undefined ? 1 : Number(r.num_participants) || 0] as const] : [])),
    )
  } catch {
    return null
  }
}

/** The rooms inbound phone calls land in: the dispatch rule's prefix (apps/agent/src/setup-sip.ts). */
export const INBOUND_ROOM_PREFIX = 'call-'

/**
 * Whether a SIP participant is the inbound call from `from` to `to` (both E.164). Carriers send its numbers without
 * the "+" or as ten digits, so they are read the way call.start reads them (normalizeCallerId).
 */
export function isSipCall(attributes: Record<string, string> | undefined, call: { from: string; to: string }): boolean {
  const caller = attributes?.['sip.phoneNumber']
  const dialled = attributes?.['sip.trunkPhoneNumber']
  if (!caller || !dialled) return false
  return (
    normalizeCallerId(dialled, { nationalUs: true }) === call.to &&
    normalizeCallerId(caller, { nationalUs: call.to.startsWith('+1') }) === call.from
  )
}

/** Inbound call rooms LiveKit made at or after `sinceMs` (its creation time is in seconds; a second of slack). */
export function inboundRoomsSince(rooms: { name?: string; creation_time?: string | number }[], sinceMs: number) {
  return rooms
    .filter(r => r.name?.startsWith(INBOUND_ROOM_PREFIX) && Number(r.creation_time ?? 0) * 1000 >= sinceMs - 1000)
    .map(r => r.name!)
}

/**
 * The room an inbound phone call from `from` to `to` is in, when one is: an inbound call room made since `sinceMs`
 * with a SIP participant of that caller and dialled number. The forwarding check uses it to tell "the call reached
 * Linedesk but no assistant took it" from "voicemail picked up". Null when there is none, or LiveKit is not set up or
 * does not answer.
 */
export async function findSipCallerRoom(
  call: { from: string; to: string; sinceMs: number },
  env: Env = process.env,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env
  if (!url || !key || !secret) return null
  const post = async (method: string, body: object, grants: object) => {
    const res = await doFetch(`${twirpBase(url)}/livekit.RoomService/${method}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${livekitToken(key, secret, { video: grants })}`,
        'content-type': 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`LiveKit ${method} answered HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }
  try {
    // ListRooms answers all rooms at once (no pages); only the calls that came in since the dial are opened.
    const { rooms = [] } = (await post('ListRooms', {}, { roomList: true })) as {
      rooms?: { name?: string; creation_time?: string | number }[]
    }
    for (const room of inboundRoomsSince(rooms, call.sinceMs)) {
      const { participants = [] } = (await post('ListParticipants', { room }, { roomAdmin: true, room })) as {
        participants?: { attributes?: Record<string, string> }[]
      }
      if (participants.some(p => isSipCall(p.attributes, call))) return room
    }
    return null
  } catch {
    return null
  }
}

/** Asks the LiveKit server for its rooms and its SIP trunks. `doFetch` is replaced in tests. */
export async function livekitStatus(
  env: Env = process.env,
  doFetch: typeof fetch = fetch,
  words: Words = english,
): Promise<LivekitStatus> {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env
  if (!url || !key || !secret) {
    const missing = {
      ok: false,
      message: words.t('admin.livekit.notSet', { url: 'LIVEKIT_URL', key: 'LIVEKIT_API_KEY', secret: 'LIVEKIT_API_SECRET' }),
    }
    // SIP lives on the LiveKit server: say so once, not the same env message twice.
    return { url: url ?? null, server: missing, sip: { ok: false, message: words.t('admin.livekit.sip.notCheckedNoLivekit') } }
  }
  const base = twirpBase(url)
  const server = await check(async () => {
    const { status, body } = await call(
      doFetch,
      `${base}/livekit.RoomService/ListRooms`,
      livekitToken(key, secret, { video: { roomList: true } }),
    )
    if (status !== 200) return { ok: false, message: failure('server', status, body, words) }
    return {
      ok: true,
      message: words.t('admin.livekit.server.reachable', { count: Array.isArray(body.rooms) ? body.rooms.length : 0 }),
    }
  }, words)
  if (!server.ok)
    return { url, server, sip: { ok: false, message: words.t('admin.livekit.sip.notCheckedNoServer') } }
  const sip = await check(async () => {
    const { status, body } = await call(
      doFetch,
      `${base}/livekit.SIP/ListSIPInboundTrunk`,
      livekitToken(key, secret, { sip: { admin: true } }),
    )
    if (status !== 200) return { ok: false, message: failure('sip', status, body, words) }
    const trunks = Array.isArray(body.items) ? body.items.length : 0
    // The server answers this without the SIP bridge running; it shows the setup, not that the bridge is up.
    if (!trunks) return { ok: false, message: words.t('admin.livekit.sip.noTrunk', { command: 'setup-sip' }) }
    return { ok: true, message: words.t('admin.livekit.sip.trunks', { count: trunks }) }
  }, words)
  return { url, server, sip }
}
