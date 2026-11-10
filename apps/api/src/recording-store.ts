// Where call recordings live. LiveKit egress writes the audio files; the API hands them out.
// Two adapters behind one interface: `file` (a directory shared with egress, the default) and
// `s3` (any S3-compatible bucket). Selected by RECORDING_STORE.
// Keys are always `recordingKey(workspace, call)`; both adapters refuse anything else.
import { realpath, stat, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecordingKey } from '@callfront/actions'
import { AwsClient } from 'aws4fetch'

/** How the API gets a recording to the browser: a local file to stream, or a link to redirect to. */
export type RecordingLocation = { path: string; size: number } | { url: string }

export interface RecordingStore {
  exists(key: string): Promise<boolean>
  /** Null when there is no such file. A `url` is signed and stops working after `expiresInSec`. */
  locate(key: string, expiresInSec: number): Promise<RecordingLocation | null>
  /** Removes the recording; a key with no file is fine (already gone). */
  delete(key: string): Promise<void>
}

/** The recording store is selected or configured wrongly: the operator's problem, not a server bug. */
export class RecordingConfigError extends Error {}

function assertRecordingKey(key: string) {
  if (!isRecordingKey(key)) throw new Error(`not a recording key: ${key}`)
}

/** Recordings as files under `root`; the key is the path below it. */
export function createFileRecordingStore(root: string): RecordingStore {
  /** The real file behind `key`, or null: missing, not a file, or (through a symlink) outside the root. */
  async function find(key: string): Promise<{ path: string; size: number } | null> {
    assertRecordingKey(key)
    const base = await realpath(root).catch(() => null)
    const path = base && (await realpath(resolve(base, key)).catch(() => null))
    if (!base || !path || !path.startsWith(base + sep)) return null
    const info = await stat(path)
    return info.isFile() ? { path, size: info.size } : null
  }
  return {
    exists: async key => (await find(key)) !== null,
    locate: key => find(key),
    async delete(key) {
      const file = await find(key)
      if (file) await unlink(file.path)
    },
  }
}

export interface S3Options {
  /** Base URL of the S3 API, e.g. https://s3.us-east-1.amazonaws.com. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  fetch?: typeof fetch
}

export function createS3RecordingStore({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  fetch: doFetch = fetch,
}: S3Options): RecordingStore {
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' })
  // Path-style URLs work with every S3-compatible server.
  function objectUrl(key: string) {
    assertRecordingKey(key)
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`
  }
  return {
    async exists(key) {
      const res = await doFetch(await aws.sign(objectUrl(key), { method: 'HEAD' }))
      if (res.ok) return true
      if (res.status === 404) return false
      throw new Error(`recording store: HEAD ${key} failed (${res.status})`)
    },
    // The link is signed without asking the bucket; a missing object shows as 404 when it is fetched.
    async locate(key, expiresInSec) {
      const signed = await aws.sign(`${objectUrl(key)}?X-Amz-Expires=${expiresInSec}`, { aws: { signQuery: true } })
      return { url: signed.url }
    },
    async delete(key) {
      const res = await doFetch(await aws.sign(objectUrl(key), { method: 'DELETE' }))
      if (!res.ok && res.status !== 404) throw new Error(`recording store: DELETE ${key} failed (${res.status})`)
    },
  }
}

type Env = Record<string, string | undefined>
const s3Env = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
/** `data/recordings` in the repository root: the directory docker compose mounts into LiveKit egress. */
const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL('../../../data/recordings', import.meta.url))

/** The store selected by RECORDING_STORE (default: file). Throws RecordingConfigError naming what is wrong. */
/** The directory of the file store (RECORDING_STORE=file or unset); null for any other store. */
export const recordingsDirFromEnv = (env: Env): string | null =>
  (env.RECORDING_STORE || 'file') === 'file' ? env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR : null

export function recordingStoreFromEnv(env: Env): RecordingStore {
  const kind = env.RECORDING_STORE || 'file'
  if (kind === 'file') return createFileRecordingStore(env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR)
  if (kind !== 's3') throw new RecordingConfigError(`unknown RECORDING_STORE "${kind}" (use file or s3)`)
  const missing = s3Env.filter(name => !env[name])
  if (missing.length) throw new RecordingConfigError(`${missing.join(', ')} not set (needed for RECORDING_STORE=s3)`)
  return createS3RecordingStore({
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  })
}
