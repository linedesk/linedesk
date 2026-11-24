// Where call recordings live. LiveKit egress writes the audio files; the API hands them out.
// Two adapters behind one interface: `file` (a directory shared with egress, the default) and
// `s3` (any S3-compatible bucket). Which one records new calls is the `recording` provider category
// (Server admin › Providers › Recording storage, else RECORDING_STORE); each call keeps the store its
// recording went to (calls.recording_store), so switching stores leaves older recordings playable.
// Keys are always `recordingKey(workspace, call)` or, for uploaded documents, `documentKey(workspace,
// document)`; both adapters refuse anything else.
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isStoreKey, recordingObjectKey, recordingStores, type RecordingStoreName } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { AwsClient } from 'aws4fetch'
import { activeProvider, resolveProvider } from './provider-settings.ts'
import { s3Fetch } from './s3-endpoint.ts'

/** How the API gets a recording to the browser: a local file to stream, or a link to redirect to. */
export type RecordingLocation = { path: string; size: number } | { url: string }

export interface RecordingStore {
  exists(key: string): Promise<boolean>
  /** Null when there is no such file. A `url` is signed and stops working after `expiresInSec`. */
  locate(key: string, expiresInSec: number): Promise<RecordingLocation | null>
  /** Stores a file the API was given (an uploaded document), replacing one with the same key. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  /** Removes the recording; a key with no file is fine (already gone). */
  delete(key: string): Promise<void>
  /** "Test connection": writes a small object, reads it back and deletes it. Throws on the first step that fails. */
  probe(): Promise<void>
}

/** The recording store is selected or configured wrongly: the operator's problem, not a server bug. */
export class RecordingConfigError extends Error {}

/** An S3 request failed. `code` is S3's error code (`NoSuchBucket`, `SignatureDoesNotMatch`), never its message. */
export class S3RequestError extends Error {
  readonly status: number
  readonly code: string | null
  readonly step: string

  constructor(step: string, status: number, code: string | null) {
    super(`recording store: ${step} failed (${status}${code ? ` ${code}` : ''})`)
    this.step = step
    this.status = status
    this.code = code
  }
}

function assertRecordingKey(key: string) {
  if (!isStoreKey(key)) throw new Error(`not a recording key: ${key}`)
}

const probeName = () => `.linedesk-probe-${crypto.randomUUID()}.txt`
const PROBE_BODY = 'Linedesk recording storage test. Safe to delete.'

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
    async put(key, body) {
      assertRecordingKey(key)
      const path = resolve(root, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
    },
    async delete(key) {
      const file = await find(key)
      if (file) await unlink(file.path)
    },
    async probe() {
      // The directory is created like egress would; the test file sits at its top, outside any workspace.
      await mkdir(root, { recursive: true })
      const path = join(root, probeName())
      await writeFile(path, PROBE_BODY)
      try {
        if ((await readFile(path, 'utf8')) !== PROBE_BODY) throw new Error('the test file read back differently')
      } finally {
        await unlink(path)
      }
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
  /** Put before every key, e.g. `linedesk/` (egress writes to the same place). */
  prefix?: string
  /** `endpoint/bucket/key` (default; works with every S3-compatible server) instead of `bucket.endpoint/key`. */
  forcePathStyle?: boolean
  fetch?: typeof fetch
  /** Waits before each new try after a server error; replaced in tests. */
  retryDelaysMs?: readonly number[]
}

/** Server errors and throttling: worth a new try. */
const RETRY_STATUSES = [429, 500, 502, 503, 504]
const RETRY_DELAYS_MS = [250, 1000]

/** S3's error code from an XML error body (`<Code>NoSuchBucket</Code>`); only a plain word, never the message. */
async function s3ErrorCode(res: Response): Promise<string | null> {
  const text = await res.text().catch(() => '')
  const code = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text)?.[1]
  return code ?? null
}

export function createS3RecordingStore({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  prefix,
  forcePathStyle = true,
  fetch: doFetch = fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
}: S3Options): RecordingStore {
  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' })
  const base = new URL(endpoint)
  const basePath = base.pathname.replace(/\/$/, '')
  const encode = (objectKey: string) => objectKey.split('/').map(encodeURIComponent).join('/')
  function urlFor(objectKey: string) {
    if (forcePathStyle) return `${base.origin}${basePath}/${encodeURIComponent(bucket)}/${encode(objectKey)}`
    return `${base.protocol}//${bucket}.${base.host}${basePath}/${encode(objectKey)}`
  }
  const objectUrl = (key: string) => urlFor(recordingObjectKey(prefix, key))

  // A passing server error (R2 answers HTTP 500 now and then) is tried again, as the AWS SDKs do (LIN-736).
  async function send(step: string, url: string, init: RequestInit, okStatuses: number[] = []) {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(await aws.sign(url, init))
      if (res.ok || okStatuses.includes(res.status)) return res
      if (attempt < retryDelaysMs.length && RETRY_STATUSES.includes(res.status)) {
        await res.body?.cancel()
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]))
        continue
      }
      throw new S3RequestError(step, res.status, await s3ErrorCode(res))
    }
  }

  return {
    async exists(key) {
      const res = await send(`HEAD ${key}`, objectUrl(key), { method: 'HEAD' }, [404])
      return res.ok
    },
    // The link is signed without asking the bucket; a missing object shows as 404 when it is fetched.
    async locate(key, expiresInSec) {
      const signed = await aws.sign(`${objectUrl(key)}?X-Amz-Expires=${expiresInSec}`, { aws: { signQuery: true } })
      return { url: signed.url }
    },
    async put(key, body, contentType) {
      await send(`PUT ${key}`, objectUrl(key), {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
      })
    },
    async delete(key) {
      await send(`DELETE ${key}`, objectUrl(key), { method: 'DELETE' }, [404])
    },
    async probe() {
      const prefixed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
      const url = urlFor(prefixed ? `${prefixed}/${probeName()}` : probeName())
      await send('writing a test object', url, {
        method: 'PUT',
        body: PROBE_BODY,
        headers: { 'content-type': 'text/plain' },
      })
      try {
        const res = await send('reading the test object back', url, { method: 'GET' })
        if ((await res.text()) !== PROBE_BODY) throw new Error('the test object read back differently')
      } finally {
        await send('deleting the test object', url, { method: 'DELETE' }, [404])
      }
    },
  }
}

type Env = Record<string, string | undefined>
/** The s3 provider's fields as stored (registry field names), already resolved against env. */
export type S3Values = Partial<Record<string, string>>
const s3Required = [
  ['endpoint', 'Endpoint URL'],
  ['bucket', 'Bucket'],
  ['access_key_id', 'Access key ID'],
  ['secret_access_key', 'Secret access key'],
] as const

/** `data/recordings` in the repository root: the directory docker compose mounts into LiveKit egress. */
const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL('../../../data/recordings', import.meta.url))
/** The directory of the file store. */
export const recordingsDir = (env: Env = process.env): string => env.RECORDINGS_DIR || DEFAULT_RECORDINGS_DIR

/** The S3 store from the s3 provider's values. Throws RecordingConfigError naming (never showing) what is missing. */
export function s3StoreFromValues(values: S3Values, doFetch?: typeof fetch): RecordingStore {
  const missing = s3Required.filter(([field]) => !values[field]).map(([, label]) => label)
  if (missing.length) throw new RecordingConfigError(`S3 storage is missing: ${missing.join(', ')}`)
  try {
    new URL(values.endpoint!)
  } catch {
    throw new RecordingConfigError('the S3 endpoint is not a URL')
  }
  return createS3RecordingStore({
    endpoint: values.endpoint!,
    region: values.region || 'us-east-1',
    bucket: values.bucket!,
    accessKeyId: values.access_key_id!,
    secretAccessKey: values.secret_access_key!,
    prefix: values.prefix || undefined,
    forcePathStyle: values.force_path_style !== 'false',
    // Never to link-local or cloud metadata addresses, whoever set the endpoint (s3-endpoint.ts).
    fetch: doFetch ?? s3Fetch(),
  })
}

const isStoreName = (name: string): name is RecordingStoreName => (recordingStores as readonly string[]).includes(name)

/**
 * The store a recording is in. `name` is calls.recording_store; null (recorded before stores were per
 * call) means the one RECORDING_STORE names, `file` without it. s3 settings: the admin area first, then
 * the S3_* variables. Throws RecordingConfigError, or SecretsKeyError when stored keys cannot be decrypted.
 */
export async function recordingStoreNamed(
  tx: Tx,
  name: RecordingStoreName | null,
  env: Env = process.env,
): Promise<RecordingStore> {
  const kind = name ?? (env.RECORDING_STORE || 'file')
  if (!isStoreName(kind)) throw new RecordingConfigError(`unknown RECORDING_STORE "${kind}" (use file or s3)`)
  if (kind === 'file') return createFileRecordingStore(recordingsDir(env))
  const config = await resolveProvider(tx, 's3', env)
  return s3StoreFromValues(Object.fromEntries(Object.entries(config).map(([field, entry]) => [field, entry?.value])))
}

/**
 * The store new calls are recorded into, or null when recording is off: no store picked in the admin
 * area and none named by RECORDING_STORE, or the picked one is not set up.
 */
export async function activeRecordingStore(
  tx: Tx,
  env: Env = process.env,
): Promise<{ name: RecordingStoreName; store: RecordingStore } | null> {
  const active = await activeProvider(tx, 'recording', env)
  if (!active || !isStoreName(active.provider)) return null
  return { name: active.provider, store: await recordingStoreNamed(tx, active.provider, env) }
}

/** A resolver that builds each store once (per job run or sweep), for loops over many recordings. */
export function recordingStoreCache(tx: Tx, env: Env = process.env) {
  const stores = new Map<string, Promise<RecordingStore>>()
  return (name: RecordingStoreName | null) => {
    const kind = name ?? 'legacy'
    if (!stores.has(kind)) stores.set(kind, recordingStoreNamed(tx, name, env))
    return stores.get(kind)!
  }
}
