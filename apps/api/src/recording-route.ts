// GET /v1/calls/:id/recording: the audio of a call, for members of the call's workspace (and its API
// keys), or for anyone with a signed link (recordingLink: the after-call webhook's, valid RECORDING_LINK_DAYS,
// bound to the call's workspace and refused while that workspace is disabled).
// A file store is streamed from here, with Range support so players can seek; an S3 store gets
// a redirect to a short-lived signed link. The store is the one the call's recording went to
// (calls.recording_store), resolved on each request: settings changed in the admin area apply at once.
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { isRecordingKey, RECORDING_LINK_DAYS, recordingFormats, recordingKey } from '@linedesk/actions'
import { calls, organization } from '@linedesk/db'
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import { s3Problem } from './provider-test.ts'
import { RecordingConfigError, recordingStoreNamed, S3RequestError } from './recording-store.ts'
import { SecretsKeyError, signWithSecretsKey } from './secrets.ts'

const SIGNED_URL_TTL_SEC = 300
/** The media type of a recording file, by its extension. */
export const recordingContentType = (key: string) =>
  key.endsWith('.ogg') ? 'audio/ogg' : key.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream'
const error = (status: number, message: string) => Response.json({ ok: false, error: message }, { status })

/** First and last byte of a `Range: bytes=…` header for a file of `size` bytes. Null if it cannot be satisfied. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start <= end && start < size ? { start, end } : null
}

function fileResponse(path: string, size: number, type: string, rangeHeader: string | undefined): Response {
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' }
  if (!rangeHeader) {
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(body, { headers: { ...headers, 'content-length': String(size) } })
  }
  const range = parseRange(rangeHeader, size)
  if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
  const body = Readable.toWeb(createReadStream(path, range)) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    },
  })
}

/** The stored key, if it is the one this call can have. Anything else in the column is not served. */
export function ownRecordingKey(call: { id: string; workspace_id: string; recording_key: string | null }): string | null {
  const key = call.recording_key
  const own =
    key &&
    isRecordingKey(key) &&
    recordingFormats.some(format => key === recordingKey(call.workspace_id, call.id, format))
  return own ? key : null
}

export async function serveRecording(actor: Actor, callId: string, rangeHeader: string | undefined): Promise<Response> {
  if (!actor.workspaceId || !actor.permissions.includes('call:read')) return error(403, 'missing permission call:read')
  return serveCallRecording(and(eq(calls.id, callId), eq(calls.workspace_id, actor.workspaceId)), rangeHeader)
}

// --- Signed links ------------------------------------------------------------------------------

const LINK_PURPOSE = 'recording-link'
// The workspace is in the signed text: a link only opens a call of the workspace it was made for.
const linkText = (workspaceId: string, callId: string, expires: number) => JSON.stringify([workspaceId, callId, expires])

/** A link that opens the call's audio without signing in until `expires_at`; `base` is where the API is reached. */
export function recordingLink(callId: string, workspaceId: string, base: string, now = new Date()): { url: string; expires_at: string } {
  const expires = Math.floor(now.getTime() / 1000) + RECORDING_LINK_DAYS * 86_400
  const url = new URL(`/v1/calls/${encodeURIComponent(callId)}/recording`, base)
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('signature', signWithSecretsKey(LINK_PURPOSE, linkText(workspaceId, callId, expires)))
  return { url: url.toString(), expires_at: new Date(expires * 1000).toISOString() }
}

const notValid = () => error(403, 'this recording link is not valid')

/** Whether a request carries a signed-link query; then it needs no sign-in, the signature decides. */
export const isSignedRecordingRequest = (path: string, query: { signature?: string }) =>
  /^\/v1\/calls\/[^/]+\/recording$/.test(path) && query.signature !== undefined

/**
 * Serves the audio for a signed link: refused once it has expired, when the signature is not the API's own
 * for this call and its workspace, or when that workspace is disabled. An unknown call is refused like a bad
 * signature; a deleted call answers "no recording" only after the signature checked out.
 */
export async function serveSignedRecording(callId: string, expires: string | undefined, signature: string | undefined, rangeHeader: string | undefined, now = Date.now()) {
  const until = Number(expires)
  if (!Number.isInteger(until) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return notValid()
  if (until * 1000 < now) return error(403, 'this recording link has expired; fetch the recording with an API key')
  const [call] = await db
    .select({ workspace_id: calls.workspace_id, disabledAt: organization.disabledAt })
    .from(calls)
    .innerJoin(organization, eq(organization.id, calls.workspace_id))
    .where(eq(calls.id, callId))
  if (!call) return notValid()
  let expected: string
  try {
    expected = signWithSecretsKey(LINK_PURPOSE, linkText(call.workspace_id, callId, until))
  } catch (e) {
    if (e instanceof SecretsKeyError) return notValid()
    throw e
  }
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return notValid()
  if (call.disabledAt) return error(403, 'this recording link is not valid: the workspace is disabled')
  return serveCallRecording(and(eq(calls.id, callId), eq(calls.workspace_id, call.workspace_id)), rangeHeader)
}

async function serveCallRecording(which: SQL | undefined, rangeHeader: string | undefined): Promise<Response> {
  const [call] = await db
    .select({
      id: calls.id,
      workspace_id: calls.workspace_id,
      recording_key: calls.recording_key,
      recording_store: calls.recording_store,
    })
    .from(calls)
    .where(and(which, isNull(calls.deleted_at)))
  const key = call && ownRecordingKey(call)
  if (!key) return error(404, 'no recording for this call')
  try {
    const store = await recordingStoreNamed(db, call.recording_store)
    const location = await store.locate(key, SIGNED_URL_TTL_SEC)
    if (!location) return error(404, 'no recording for this call')
    if (call.recording_store === 's3') void noteProviderOk('s3')
    if ('url' in location)
      return new Response(null, {
        status: 302,
        headers: { location: location.url, 'cache-control': 'private, no-store' },
      })
    return fileResponse(location.path, location.size, recordingContentType(key), rangeHeader)
  } catch (e) {
    // The bucket refused or is gone: recorded for the admins (provider-failures.ts).
    if (e instanceof S3RequestError) void noteProviderFailure('s3', s3Problem(e), 'recording')
    if (e instanceof RecordingConfigError) return error(409, `recording storage is not set up: ${e.message}`)
    if (e instanceof SecretsKeyError) return error(409, `recording storage keys cannot be read: ${e.message}`)
    throw e
  }
}
