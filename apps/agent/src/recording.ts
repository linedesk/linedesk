// Call recording: LiveKit egress mixes the room's audio into one file in the recording store
// (a directory shared with the API, or an S3 bucket). The agent starts it, stops it the moment
// the caller is gone and tells the API once the file is final.
import { callSetRecording, recordingKey } from '@callfront/actions'
import { EgressClient, EgressStatus, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk'
import type { ApiClient } from './api-client.ts'
import type { CallSession } from './call-session.ts'
import { livekitHttpUrl, requireEnv, requireLivekitEnv } from './env.ts'
import { withRetry, type RetryOptions } from './retry.ts'

export interface CallRecorder {
  /** Starts recording the room into `key`; returns the recording's id. */
  start(room: string, key: string): Promise<string>
  /** Ends the recording now. Returns at once; the file is written in the background. */
  stop(recordingId: string): Promise<void>
  /** Waits until the file is final. False if it failed or is not final after `timeoutMs`. */
  waitUntilFinal(recordingId: string, timeoutMs: number): Promise<boolean>
}

type Env = Record<string, string | undefined>
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The agent records only when a recording store is named; without one, recording is off and silent. */
export const recordingMode = (env: Env = process.env): 'file' | 's3' | 'off' =>
  env.RECORDING_STORE === 'file' || env.RECORDING_STORE === 's3' ? env.RECORDING_STORE : 'off'

/** One line for the worker's start-up log. */
export function describeRecording(env: Env = process.env): string {
  const mode = recordingMode(env)
  if (mode === 'off') return 'call recording is off (set RECORDING_STORE=file and run `pnpm recording:up` to record calls)'
  return `call recording is on: LiveKit egress writes to ${mode === 'file' ? 'the shared recordings directory' : `the S3 bucket ${env.S3_BUCKET}`}`
}

/** Pause before the second try to start a recording (egress busy or the room not ready yet). */
export const RECORDING_RETRY_MS = 1000

/** The recording's id, or null: off for this workspace, or it could not start (tried twice). Never rejects. */
export async function startRecording(recorder: CallRecorder | null, call: CallSession, room: string, retryMs = RECORDING_RETRY_MS): Promise<string | null> {
  if (!recorder || call.assistant?.record_calls === false) return null
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

/** Waits for the file, then reports it. If this does not happen in time, the API links the file later by its derived key. */
export async function saveRecording(api: ApiClient, call: CallSession, recorder: CallRecorder | null, recordingId: string | null, waitMs: number, retry?: RetryOptions) {
  if (!recorder || !recordingId) return
  if (!(await recorder.waitUntilFinal(recordingId, waitMs))) return console.warn(`recording of call ${call.callId} did not complete in time`)
  await withRetry(() => api.run(callSetRecording, { callId: call.callId }, call.workspaceId), retry)
}

/** Where egress finds the recordings directory inside its container (see docker-compose.yml). */
const EGRESS_RECORDINGS_DIR = '/recordings'

/** The file egress writes for `key`, matching the API's store: a path in the shared directory, or an S3 upload. */
export function recordingOutput(key: string, env: Env = process.env): EncodedFileOutput {
  const fileType = EncodedFileType.OGG
  if (recordingMode(env) !== 's3') {
    return new EncodedFileOutput({ fileType, disableManifest: true, filepath: `${env.RECORDINGS_EGRESS_DIR || EGRESS_RECORDINGS_DIR}/${key}` })
  }
  const s3 = requireEnv(['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], env)
  const upload = new S3Upload({
    endpoint: s3.S3_ENDPOINT, bucket: s3.S3_BUCKET, accessKey: s3.S3_ACCESS_KEY_ID, secret: s3.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION || 'us-east-1', forcePathStyle: true,
  })
  return new EncodedFileOutput({ fileType, disableManifest: true, filepath: key, output: { case: 's3', value: upload } })
}

const failed = [EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED]

/** CallRecorder backed by LiveKit egress (audio only, OGG), or null when recording is off. */
export function livekitRecorder(env: Env = process.env): CallRecorder | null {
  if (recordingMode(env) === 'off') return null
  const livekit = requireLivekitEnv(env)
  const egress = new EgressClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  return {
    async start(room, key) {
      return (await egress.startRoomCompositeEgress(room, { file: recordingOutput(key, env) }, { audioOnly: true })).egressId
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
