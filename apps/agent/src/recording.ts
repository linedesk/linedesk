// Call recording: LiveKit egress mixes the room's audio into one file in the recording store
// (a directory shared with the API, or an S3 bucket). The agent starts it, stops it the moment
// the caller is gone and tells the API once the file is final, and in which store.
// Which store, with which keys: Linedesk's Providers > Recording storage (GET /v1/agent/provider-config),
// else this agent's RECORDING_STORE and S3_* variables. S3 keys travel in each egress request, so
// egress itself needs no storage settings.
import { callSetRecording, recordingKey, recordingObjectKey, type RecordingStoreName } from '@linedesk/actions'
import { EgressClient, EgressStatus, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk'
import { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import type { CallSession } from './call-session.ts'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'
import { withRetry, type RetryOptions } from './retry.ts'

export interface CallRecorder {
  /** The store egress writes into; reported to the API with the recording. */
  readonly store: RecordingStoreName
  /** Starts recording the room into `key`; returns the recording's id. */
  start(room: string, key: string): Promise<string>
  /** Ends the recording now. Returns at once; the file is written in the background. */
  stop(recordingId: string): Promise<void>
  /** Waits until the file is final. False if it failed or is not final after `timeoutMs`. */
  waitUntilFinal(recordingId: string, timeoutMs: number): Promise<boolean>
}

type Env = Record<string, string | undefined>
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The `recording` entry of GET /v1/agent/provider-config: the store and the s3 provider's fields, in clear. */
export const recordingSettings = z
  .object({
    provider: z.string(),
    endpoint: z.string().nullish(),
    region: z.string().nullish(),
    bucket: z.string().nullish(),
    access_key_id: z.string().nullish(),
    secret_access_key: z.string().nullish(),
    prefix: z.string().nullish(),
    force_path_style: z.string().nullish(),
  })
  .nullish()
export type RecordingSettings = z.infer<typeof recordingSettings>

export type S3Settings = {
  endpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  prefix?: string
  forcePathStyle: boolean
}
/** Where this agent records calls. `off`: no store named anywhere (or an unknown one). */
export type RecordingConfig = { store: 'off' } | { store: 'file' } | { store: 's3'; s3: S3Settings }

const orUndefined = (value: string | null | undefined) => value || undefined

/**
 * The store from Linedesk's settings when it names one, else from this agent's environment
 * (RECORDING_STORE, S3_*). Same rule as for the speech and language stages.
 */
export function resolveRecording(settings: RecordingSettings, env: Env = process.env): RecordingConfig {
  const s = settings ?? {
    provider: env.RECORDING_STORE ?? '',
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    access_key_id: env.S3_ACCESS_KEY_ID,
    secret_access_key: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
    force_path_style: env.S3_FORCE_PATH_STYLE,
  }
  if (s.provider === 'file') return { store: 'file' }
  if (s.provider !== 's3') return { store: 'off' }
  return {
    store: 's3',
    s3: {
      endpoint: orUndefined(s.endpoint),
      region: orUndefined(s.region),
      bucket: orUndefined(s.bucket),
      accessKeyId: orUndefined(s.access_key_id),
      secretAccessKey: orUndefined(s.secret_access_key),
      prefix: orUndefined(s.prefix),
      forcePathStyle: s.force_path_style !== 'false',
    },
  }
}

/** One line for the worker's start-up log. Names the bucket, never a key. */
export function describeRecording(recording: RecordingConfig): string {
  if (recording.store === 'off')
    return 'call recording is off (pick a store in Linedesk under Providers > Recording storage, or set RECORDING_STORE=file and run `pnpm recording:up`)'
  return `call recording is on: LiveKit egress writes to ${recording.store === 'file' ? 'the shared recordings directory' : `the S3 bucket ${recording.s3.bucket ?? '(not set)'}`}`
}

/** Pause before the second try to start a recording (egress busy or the room not ready yet). */
export const RECORDING_RETRY_MS = 1000

/**
 * The recording's id, or null: off for this assistant or workspace (one that keeps no recordings is not recorded:
 * the transcript and summary come from live speech recognition), or it could not start (tried twice). Never rejects.
 */
export async function startRecording(recorder: CallRecorder | null, call: CallSession, room: string, retryMs = RECORDING_RETRY_MS): Promise<string | null> {
  if (!recorder || call.assistant?.record_calls === false || call.keepRecording === false) return null
  const key = recordingKey(call.workspaceId, call.callId)
  try {
    return await recorder.start(room, key)
  } catch (first) {
    console.warn(`recording of call ${call.callId} did not start, trying once more: ${message(first)}`)
    await new Promise(resolve => setTimeout(resolve, retryMs))
    try {
      return await recorder.start(room, key)
    } catch (e) {
      console.warn(`call ${call.callId} is not recorded: ${message(e)}`)
      return null
    }
  }
}

/** Never rejects: a recording that cannot be stopped ends with the room. */
export async function stopRecording(recorder: CallRecorder | null, recordingId: string | null) {
  if (recorder && recordingId) await recorder.stop(recordingId).catch(() => {})
}

/**
 * Stops the recording and says so: rejects when it could not be stopped. For a warm transfer, which
 * must not put the caller through to the on-call person while the call is still being recorded.
 */
export async function stopRecordingOrThrow(recorder: CallRecorder | null, recordingId: string | null) {
  if (recorder && recordingId) await recorder.stop(recordingId)
}

/** Waits for the file, then reports it with its store. If this does not happen in time, the API links the file later by its derived key. */
export async function saveRecording(api: ApiClient, call: CallSession, recorder: CallRecorder | null, recordingId: string | null, waitMs: number, retry?: RetryOptions) {
  if (!recorder || !recordingId) return
  if (!(await recorder.waitUntilFinal(recordingId, waitMs))) return console.warn(`recording of call ${call.callId} did not complete in time`)
  await withRetry(() => api.run(callSetRecording, { callId: call.callId, store: recorder.store }, call), retry)
}

/** Where egress finds the recordings directory inside its container (see docker-compose.yml). */
const EGRESS_RECORDINGS_DIR = '/recordings'

const s3Required = [['endpoint', 'endpoint'], ['bucket', 'bucket'], ['accessKeyId', 'access key ID'], ['secretAccessKey', 'secret access key']] as const

/**
 * The file egress writes for `key`, matching the API's store: a path in the shared directory, or an
 * S3 upload with the keys in the request. Throws naming (never showing) a missing S3 setting.
 */
export function recordingOutput(key: string, recording: RecordingConfig, env: Env = process.env): EncodedFileOutput {
  const fileType = EncodedFileType.OGG
  if (recording.store !== 's3') {
    return new EncodedFileOutput({ fileType, disableManifest: true, filepath: `${env.RECORDINGS_EGRESS_DIR || EGRESS_RECORDINGS_DIR}/${key}` })
  }
  const { s3 } = recording
  const missing = s3Required.filter(([field]) => !s3[field]).map(([, label]) => label)
  if (missing.length) throw new Error(`S3 recording storage is missing: ${missing.join(', ')} (Linedesk > Providers > Recording storage, or S3_* in .env)`)
  const upload = new S3Upload({
    endpoint: s3.endpoint, bucket: s3.bucket, accessKey: s3.accessKeyId, secret: s3.secretAccessKey,
    region: s3.region || 'us-east-1', forcePathStyle: s3.forcePathStyle,
  })
  return new EncodedFileOutput({ fileType, disableManifest: true, filepath: recordingObjectKey(s3.prefix, key), output: { case: 's3', value: upload } })
}

const failed = [EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED]

/** Asks the API to start an S3 recording of the call (`call.startRecording`); the egress id. */
export type StartViaApi = () => Promise<string>

/**
 * CallRecorder backed by LiveKit egress (audio only, OGG) for this call's store, or null when recording is off.
 * S3 without the secret in the settings (the API keeps it) is started by the API through `startViaApi`;
 * an older API still sends the secret, and the agent then starts it itself.
 */
export function livekitRecorder(recording: RecordingConfig, env: Env = process.env, startViaApi?: StartViaApi): CallRecorder | null {
  if (recording.store === 'off') return null
  const livekit = requireLivekitEnv(env)
  const egress = new EgressClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  return {
    store: recording.store,
    async start(room, key) {
      if (recording.store === 's3' && !recording.s3.secretAccessKey && startViaApi) return startViaApi()
      return (await egress.startRoomCompositeEgress(room, { file: recordingOutput(key, recording, env) }, { audioOnly: true })).egressId
    },
    async stop(egressId) {
      await egress.stopEgress(egressId)
    },
    async waitUntilFinal(egressId, timeoutMs) {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
        const [info] = await egress.listEgress({ egressId })
        if (info?.status === EgressStatus.EGRESS_COMPLETE) return true
        if (!info || failed.includes(info.status)) return false
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      return false
    },
  }
}
