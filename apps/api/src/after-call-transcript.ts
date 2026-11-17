// After-call transcription. During the call the caller is transcribed live (speech to text, or the realtime model's
// transcriber): fast, but it mishears, and a noise can turn into a word of another language. Once the call's
// recording is saved (call.setRecording), the `call.transcribe` job uploads the recording file to the transcription
// provider an instance admin selected and replaces the caller's lines with what it heard (transcript-align.ts). The
// assistant's lines stay: they are the text its voice spoke. Workspace members just see the better transcript.
//
// Server admin › Providers › After-call transcription (the registry's `transcript` category): OpenAI gpt-transcribe,
// Deepgram Nova-3, AssemblyAI Universal or ElevenLabs Scribe. Off until an admin selects one (no first-set-up
// fallback, no variable picks it). A provider without a key of its own can use, with one click, the key saved for
// the active provider of the same service (`REUSE_FROM`): a reference to that stored key, as one-key mode does, never
// a copy, never a key only in .env, never the key of a provider that is not active. Removing the provider or its
// key, or selecting none, stops the job. A failure leaves the live transcript as it is.

import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  type AfterCallTranscriptData,
  type AfterCallTranscriptOption,
  type ProviderCategory,
  type ProviderName,
  type TranscriptProviderName,
  transcriptModels,
  transcriptProviders,
} from '@linedesk/actions'
import { calls, type Tx, transcript_segments } from '@linedesk/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { activeProvider, keySource, linkProviderKey, resolveProvider, setActiveProvider } from './provider-settings.ts'
import { ownRecordingKey, recordingContentType } from './recording-route.ts'
import type { RecordingStore } from './recording-store.ts'
import { type Heard, isTranscriptProvider, type Transcriber, TranscriberError, transcriberFor } from './transcriber.ts'
import { alignCallerLines, type StoredLine } from './transcript-align.ts'
import { NO_HINTS, transcriptHints } from './transcript-hints.ts'

type Env = Record<string, string | undefined>

/** The active providers whose stored key a transcription provider of the same service may use, in this order. */
export const REUSE_FROM: Record<TranscriptProviderName, readonly [ProviderCategory, ProviderName][]> = {
  openai_transcript: [
    ['stt', 'openai_stt'],
    ['realtime', 'openai_realtime'],
    ['llm', 'openai'],
  ],
  deepgram_transcript: [['stt', 'deepgram']],
  assemblyai: [['stt', 'assemblyai_stt']],
  elevenlabs_transcript: [
    ['stt', 'elevenlabs_stt'],
    ['tts', 'elevenlabs'],
  ],
}

/** A key stored in the admin area (its own, or linked to another stored key); a key only in .env does not count. */
async function storedKey(tx: Tx, provider: ProviderName, env?: Env): Promise<string | null> {
  const key = (await resolveProvider(tx, provider, env)).api_key
  return key?.source === 'app' && key.value ? key.value : null
}

/** The first of `provider`'s sources that is the active provider of its category with a stored key. */
async function reusableSource(tx: Tx, provider: TranscriptProviderName, env?: Env): Promise<ProviderName | null> {
  for (const [category, source] of REUSE_FROM[provider]) {
    const active = await activeProvider(tx, category, env)
    if (active?.provider === source && (await storedKey(tx, source, env))) return source
  }
  return null
}

/** The selected provider (instance_settings `active_provider.transcript`), or null: off. */
async function selected(tx: Tx, env?: Env): Promise<TranscriptProviderName | null> {
  const active = await activeProvider(tx, 'transcript', env)
  return active && isTranscriptProvider(active.provider) ? active.provider : null
}

export async function afterCallTranscriptState(tx: Tx, env?: Env): Promise<AfterCallTranscriptData> {
  const inUse = await selected(tx, env)
  const options: AfterCallTranscriptOption[] = []
  for (const provider of transcriptProviders) {
    const connected = !!(await storedKey(tx, provider, env))
    const source = connected ? null : await reusableSource(tx, provider, env)
    const state = provider === inUse && connected ? 'in_use' : connected ? 'connected' : source ? 'reusable' : 'none'
    options.push({ provider, model: transcriptModels[provider], state, reuseFrom: source })
  }
  const recording = !!(await activeProvider(tx, 'recording', env))
  return { selected: inUse && (await storedKey(tx, inUse, env)) ? inUse : null, recording, options }
}

/** The transcriber to use for a call now: the selected provider with its stored key, else null (off). */
export async function transcriberInEffect(tx: Tx, env?: Env, doFetch?: typeof fetch): Promise<Transcriber | null> {
  const provider = await selected(tx, env)
  const key = provider && (await storedKey(tx, provider, env))
  return provider && key ? transcriberFor(provider, key, { doFetch }) : null
}

/** Whether a call whose recording was just saved is transcribed again. Never throws: an unreadable key means no. */
export async function transcribesAfterCalls(tx: Tx): Promise<boolean> {
  try {
    return !!(await transcriberInEffect(tx))
  } catch (e) {
    console.warn(`after-call transcription is off: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * Selects a provider (or none: off). One without a key of its own gets a reference to the stored key of its active
 * source; one with neither is refused (connect it with its key first).
 */
export async function selectTranscriptProvider(
  tx: Tx,
  provider: TranscriptProviderName | null,
  actorId: string,
  now: string,
  env?: Env,
) {
  if (provider && !(await storedKey(tx, provider, env))) {
    const source = await reusableSource(tx, provider, env)
    if (!source) throw new Reject(`connect ${provider} with its key first`)
    // The key's owner: a source that itself uses another provider's key passes that one on.
    await linkProviderKey(tx, provider, (await keySource(tx, source)) ?? source, actorId, now)
  }
  await setActiveProvider(tx, 'transcript', provider, actorId, now)
}

export const afterCallTranscriptHandlers: Record<string, Handler> = {
  'afterCallTranscript.get': async ({ tx }) => ({ rows: {}, data: await afterCallTranscriptState(tx) }),
  'afterCallTranscript.set': async ({ tx, actor, now }, input: { provider: TranscriptProviderName | null }) => {
    await selectTranscriptProvider(tx, input.provider, actor.actorId, now)
    return { rows: {}, data: await afterCallTranscriptState(tx) }
  },
}

/** A recording ready to send, and what to do once it is sent (delete the temp copy of a bucket recording). */
export type Recording = { audio: Blob; release: () => Promise<void> }

/**
 * Reads a recording from its store: a file on this server (a Blob backed by the file, not read into memory), or a
 * signed link to the bucket, streamed to a temp file and sent from there, so a long call never sits in the API's
 * memory (LIN-328). 'too large' when it is bigger than `maxBytes`, found before it is read (the file's size, the
 * bucket's content-length); a bucket that sends more than it said is cut off.
 */
export async function readRecording(
  store: RecordingStore,
  key: string,
  maxBytes: number,
  doFetch: typeof fetch = fetch,
): Promise<Recording | null | 'too large'> {
  const location = await store.locate(key, 300)
  if (!location) return null
  const type = recordingContentType(key)
  if ('path' in location) {
    if (location.size > maxBytes) return 'too large'
    return { audio: await openAsBlob(location.path, { type }), release: async () => {} }
  }
  const response = await doFetch(location.url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`the recording could not be read from the bucket (${response.status})`)
  const length = Number(response.headers.get('content-length'))
  if (!response.body || !response.headers.has('content-length') || !Number.isFinite(length) || length > maxBytes) {
    await response.body?.cancel()
    if (length > maxBytes) return 'too large'
    throw new Error('the bucket did not say how large the recording is')
  }
  const dir = await mkdtemp(join(tmpdir(), 'linedesk-recording-'))
  const release = () => rm(dir, { recursive: true, force: true })
  try {
    const path = join(dir, 'audio')
    let bytes = 0
    await pipeline(
      response.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          bytes += chunk.length
          if (bytes > length) throw new Error('the bucket sent more than it said')
          yield chunk
        }
      },
      createWriteStream(path),
    )
    return { audio: await openAsBlob(path, { type }), release }
  } catch (e) {
    await release()
    throw e
  }
}

/**
 * What the provider refuses for good (a bad request, the key, the file, a recording it could not transcribe): trying
 * again changes nothing and would only upload the audio again.
 */
const REFUSED_FOR_GOOD = new Set([400, 401, 403, 404, 413, 415, 422])
/** What a provider answers to a request field it does not take. */
const HINTS_REFUSED = new Set([400, 422])

export type TranscribeResult =
  | { status: 'updated'; lines: number; model: string }
  | {
      status: 'skipped'
      reason: 'off' | 'no call' | 'no recording' | 'too large' | 'refused' | 'nothing to change' | 'not trusted'
    }

/**
 * Transcribes a finished call again from its recording and replaces the caller's lines with what the model heard.
 * `tx` is best the database itself: the model takes seconds, and no transaction should stay open meanwhile.
 * Throws when the call is still live, or the store or the model fails for now (the job tries again); the transcript
 * then stays as it is. A recording too large for the model, or a request the model refuses for good, is skipped
 * (logged, no retry). `transcriber` null: switched off, nothing happens.
 */
export async function transcribeCallAgain(
  tx: Tx,
  callId: string,
  transcriber: Transcriber | null,
  storeFor: (name: 'file' | 's3' | null) => Promise<RecordingStore>,
  doFetch: typeof fetch = fetch,
): Promise<TranscribeResult> {
  if (!transcriber) return { status: 'skipped', reason: 'off' }
  const [call] = await tx
    .select({
      id: calls.id,
      workspace_id: calls.workspace_id,
      status: calls.status,
      recording_key: calls.recording_key,
      recording_store: calls.recording_store,
    })
    .from(calls)
    .where(and(eq(calls.id, callId), isNull(calls.deleted_at)))
  if (!call) return { status: 'skipped', reason: 'no call' }
  if (call.status === 'live') throw new Error(`call ${callId} is still live`)
  const key = ownRecordingKey(call)
  if (!key) return { status: 'skipped', reason: 'no recording' }

  const lines: StoredLine[] = await tx
    .select({ id: transcript_segments.id, speaker: transcript_segments.speaker, text: transcript_segments.text })
    .from(transcript_segments)
    .where(eq(transcript_segments.call_id, call.id))
    .orderBy(asc(transcript_segments.at_ms), asc(transcript_segments.id))
  if (!lines.some(l => l.speaker === 'caller')) return { status: 'skipped', reason: 'nothing to change' }

  const recording = await readRecording(await storeFor(call.recording_store), key, transcriber.maxBytes, doFetch)
  if (!recording) return { status: 'skipped', reason: 'no recording' }
  if (recording === 'too large') {
    console.warn(
      `after-call transcription of call ${callId} skipped: the recording is larger than ${transcriber.model} takes`,
    )
    return { status: 'skipped', reason: 'too large' }
  }
  let heard: Heard
  const file = { name: key.split('/').pop()!, contentType: recordingContentType(key) }
  const hints = await transcriptHints(tx, call.id)
  try {
    heard = await transcriber.transcribe(recording.audio, file, hints).catch(e => {
      // A provider that refuses the hints (a term it does not take, a language it lacks) still hears the call without.
      if (!(e instanceof TranscriberError) || !HINTS_REFUSED.has(e.status) || (!hints.terms.length && !hints.language))
        throw e
      console.warn(
        `after-call transcription of call ${callId}: ${transcriber.model} refused the hints, trying without: ${e.message}`,
      )
      return transcriber.transcribe(recording.audio, file, NO_HINTS)
    })
  } catch (e) {
    if (!(e instanceof TranscriberError) || !REFUSED_FOR_GOOD.has(e.status)) throw e
    console.warn(`after-call transcription of call ${callId} skipped: ${e.message}`)
    return { status: 'skipped', reason: 'refused' }
  } finally {
    await recording.release()
  }
  const updates = alignCallerLines(lines, heard)
  if (!updates.length) return { status: 'skipped', reason: heard.text.trim() ? 'not trusted' : 'nothing to change' }

  // In one transaction, so the call's transcript changes at once. Only lines that still say what was aligned: a line
  // changed meanwhile (never today) keeps the change.
  const before = new Map(lines.map(l => [l.id, l.text]))
  const changed = await tx.transaction(async write => {
    let count = 0
    for (const update of updates) {
      const rows = await write
        .update(transcript_segments)
        .set({ text: update.text })
        .where(
          and(
            eq(transcript_segments.id, update.id),
            eq(transcript_segments.call_id, call.id),
            eq(transcript_segments.speaker, 'caller'),
            eq(transcript_segments.text, before.get(update.id)!),
          ),
        )
        .returning({ id: transcript_segments.id })
      count += rows.length
    }
    return count
  })
  return { status: 'updated', lines: changed, model: transcriber.model }
}
