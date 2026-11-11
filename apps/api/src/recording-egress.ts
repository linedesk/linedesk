// S3 recordings are started by the API, not the voice agent: LiveKit egress needs the bucket's keys
// in the request, and those keys stay with the API (GET /v1/agent/provider-config leaves them out).
// The agent asks with `call.startRecording` and stops and waits for the file itself (LiveKit keys only).
import { recordingObjectKey } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { Reject } from './handler-context.ts'
import { livekitToken } from './livekit-status.ts'
import { activeProvider } from './provider-settings.ts'

type Env = Record<string, string | undefined>
const TIMEOUT_MS = 8000
const required = ['endpoint', 'bucket', 'access_key_id', 'secret_access_key'] as const

/** The Twirp request that records `room` (audio only, OGG) into the bucket under `key`. */
export function s3EgressRequest(room: string, key: string, values: Partial<Record<string, string | null>>) {
  const missing = required.filter(field => !values[field])
  if (missing.length) throw new Reject(`S3 recording storage is missing: ${missing.join(', ')}`)
  return {
    room_name: room,
    audio_only: true,
    file_outputs: [
      {
        file_type: 'OGG',
        filepath: recordingObjectKey(values.prefix, key),
        disable_manifest: true,
        s3: {
          access_key: values.access_key_id,
          secret: values.secret_access_key,
          region: values.region || 'us-east-1',
          endpoint: values.endpoint,
          bucket: values.bucket,
          force_path_style: values.force_path_style !== 'false',
        },
      },
    ],
  }
}

type Twirp = { status: number; ok: boolean; body: Record<string, unknown> | null }

/** One request to LiveKit's egress service (Twirp, JSON) with a token that may record rooms. */
async function egressCall(method: string, payload: unknown, env: Env, doFetch: typeof fetch): Promise<Twirp> {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Reject('LiveKit is not configured on the server')
  const res = await doFetch(new URL(`/twirp/livekit.Egress/${method}`, LIVEKIT_URL.replace(/^ws/, 'http')), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { video: { roomRecord: true } })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, ok: res.ok, body: (await res.json().catch(() => null)) as Twirp['body'] }
}

const egressIdOf = (item: unknown) => {
  const e = item as { egress_id?: string; egressId?: string } | null
  return e?.egress_id ?? e?.egressId
}

/** The egress already recording `room`, if any: a repeated start (agent retry) must not record the call twice. */
async function activeEgress(room: string, env: Env, doFetch: typeof fetch): Promise<string | undefined> {
  const res = await egressCall('ListEgress', { room_name: room, active: true }, env, doFetch)
  if (!res.ok) throw new Reject(`LiveKit did not list the room's recordings (${res.status})`)
  const items = (res.body?.items ?? []) as unknown[]
  return items.map(egressIdOf).find(Boolean)
}

/**
 * Starts egress for `room` into the S3 store in effect, or returns the one already recording it; the
 * egress id. Refuses when the store is not S3. The caller serializes starts for a call (row lock).
 */
export async function startS3Recording(
  tx: Tx,
  room: string,
  key: string,
  env: Env = process.env,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const store = await activeProvider(tx, 'recording', env)
  if (store?.provider !== 's3') throw new Reject('the recording storage in effect is not S3')
  const values = Object.fromEntries(Object.entries(store.config).map(([field, entry]) => [field, entry?.value ?? null]))
  const request = s3EgressRequest(room, key, values)
  const running = await activeEgress(room, env, doFetch)
  if (running) return running
  const res = await egressCall('StartRoomCompositeEgress', request, env, doFetch)
  const egressId = egressIdOf(res.body)
  const msg = typeof res.body?.msg === 'string' ? res.body.msg : ''
  if (!res.ok || !egressId)
    throw new Reject(`LiveKit did not start the recording (${res.status}${msg ? `: ${msg.slice(0, 160)}` : ''})`)
  return egressId
}
