// GET /v1/calls/:id/recording: the audio of a call, for members of the call's workspace only.
// A file store is streamed from here, with Range support so players can seek; an S3 store gets
// a redirect to a short-lived signed link.
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { isRecordingKey, recordingFormats, recordingKey } from '@callfront/actions'
import { calls } from '@callfront/db'
import { and, eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { RecordingConfigError, recordingStoreFromEnv } from './recording-store.ts'

const SIGNED_URL_TTL_SEC = 300
const contentType = (key: string) =>
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
function ownKey(call: { id: string; workspace_id: string; recording_key: string | null }): string | null {
  const key = call.recording_key
  const own =
    key &&
    isRecordingKey(key) &&
    recordingFormats.some(format => key === recordingKey(call.workspace_id, call.id, format))
  return own ? key : null
}

export async function serveRecording(actor: Actor, callId: string, rangeHeader: string | undefined): Promise<Response> {
  if (!actor.workspaceId || !actor.permissions.includes('call:read')) return error(403, 'missing permission call:read')
  const [call] = await db
    .select({ id: calls.id, workspace_id: calls.workspace_id, recording_key: calls.recording_key })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, actor.workspaceId)))
  const key = call && ownKey(call)
  if (!key) return error(404, 'no recording for this call')
  try {
    const location = await recordingStoreFromEnv(process.env).locate(key, SIGNED_URL_TTL_SEC)
    if (!location) return error(404, 'no recording for this call')
    if ('url' in location)
      return new Response(null, {
        status: 302,
        headers: { location: location.url, 'cache-control': 'private, no-store' },
      })
    return fileResponse(location.path, location.size, contentType(key), rangeHeader)
  } catch (e) {
    if (e instanceof RecordingConfigError) return error(409, `recording storage is not set up: ${e.message}`)
    throw e
  }
}
