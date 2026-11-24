// A transcription service that hears a whole call recording after the call (after-call-transcript.ts). Vendor HTTP
// lives only in the adapters below; the rest of the API talks to `Transcriber`. Each adapter says the largest file it
// takes (checked before the recording is read) and never puts a response body into an error: a successful body is
// the caller's words. The recording comes as a Blob: a file on this server is not read into memory (openAsBlob).
import { type TranscriptService, transcriptModels } from '@linedesk/actions'
import { NO_HINTS, type TranscribeHints } from './transcript-hints.ts'

/** One speaker's turn, as a service with speaker labels hears it. `start` and `end` in milliseconds. */
export type HeardTurn = { speaker: string; start: number; end: number; text: string }
/** What a service heard: the whole text, and its turns with speakers and times where it gives them. */
export type Heard = { text: string; turns?: HeardTurn[] }

export interface Transcriber {
  /** What the admin area shows ("gpt-transcribe"). */
  readonly model: string
  /** The largest file it takes: a larger recording is skipped before it is read. */
  readonly maxBytes: number
  /** `hints`: names the call may contain and its language, where known (transcript-hints.ts). */
  transcribe(audio: Blob, file: { name: string; contentType: string }, hints?: TranscribeHints): Promise<Heard>
}

/** A transcription request that failed: the status, and what failed in our words (never the service's body). */
export class TranscriberError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`transcription failed (${status}): ${detail}`)
    this.name = 'TranscriberError'
    this.status = status
  }
}

type Options = { doFetch?: typeof fetch; wait?: (ms: number) => Promise<void> }

const MB = 1024 * 1024
/**
 * The largest recording any adapter takes. The job runs in the API process (128 MB by default), and a bucket's
 * recording is held in memory while it is sent; a 30-minute call (the assistant's longest limit) is about 24 MB.
 */
const MAX_FILE = 25 * MB
const TIMEOUT_MS = 300_000

/** The answer's JSON; a body that is not JSON fails without being quoted. */
async function jsonOf(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new TranscriberError(response.status, `${what} was refused`)
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new TranscriberError(response.status, `${what}: the answer is not JSON`)
  }
}

const asText = (value: unknown, status: number) => {
  if (typeof value !== 'string') throw new TranscriberError(status, 'the answer has no text')
  return value
}

/** OpenAI gpt-transcribe: its recommended file transcription model. Plain text only; 25 MB at most. */
export function openAiTranscriber(apiKey: string, { doFetch = fetch }: Options = {}): Transcriber {
  return {
    model: transcriptModels.openai,
    maxBytes: MAX_FILE,
    async transcribe(audio, file, { terms, language } = NO_HINTS) {
      const form = new FormData()
      form.append('file', audio, file.name)
      form.append('model', 'gpt-transcribe')
      form.append('response_format', 'json')
      for (const term of terms) form.append('keywords[]', term)
      if (language) form.append('languages[]', language)
      const response = await doFetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await jsonOf(response, 'the transcription')
      return { text: asText(body.text, response.status) }
    },
  }
}

/** Deepgram Nova-3 for recorded audio, with speaker labels (diarize) and turns (utterances). */
export function deepgramTranscriber(apiKey: string, { doFetch = fetch }: Options = {}): Transcriber {
  return {
    model: transcriptModels.deepgram,
    maxBytes: MAX_FILE,
    async transcribe(audio, file, { terms, language } = NO_HINTS) {
      // Without a language Deepgram hears English only: `multi` when the call may be in several.
      const query = new URLSearchParams([
        ['model', 'nova-3'],
        ['language', language ?? 'multi'],
        ['diarize', 'true'],
        ['utterances', 'true'],
        ['punctuate', 'true'],
        ['smart_format', 'true'],
        ['mip_opt_out', 'true'],
        ...terms.map(term => ['keyterm', term]),
      ])
      const response = await doFetch(`https://api.deepgram.com/v1/listen?${query}`, {
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': file.contentType },
        body: audio,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await jsonOf(response, 'the transcription')
      const results = body.results as
        | {
            channels?: { alternatives?: { transcript?: unknown }[] }[]
            utterances?: { speaker?: unknown; start?: unknown; end?: unknown; transcript?: unknown }[]
          }
        | undefined
      const text = asText(results?.channels?.[0]?.alternatives?.[0]?.transcript, response.status)
      const turns = (results?.utterances ?? []).flatMap(u =>
        typeof u.transcript === 'string' && typeof u.start === 'number' && typeof u.end === 'number'
          ? [{ speaker: String(u.speaker ?? ''), start: u.start * 1000, end: u.end * 1000, text: u.transcript }]
          : [],
      )
      return { text, turns }
    },
  }
}

/** How often the AssemblyAI result is asked for, and how long the whole run (upload included) may take. */
export const ASSEMBLYAI_POLL_MS = 2000
/** Below the job's expiry (jobs.ts, 600 s): a second run must not start while this one still waits. */
const ASSEMBLYAI_RUN_MS = 480_000

/**
 * AssemblyAI Universal (its default speech models), with speaker labels: upload, submit, then ask for the result.
 * A transcription AssemblyAI could not make is refused for good (no retry uploads the audio again), and the
 * transcript is deleted there once read (best effort): no copy of the caller's words stays with the vendor.
 */
export function assemblyAiTranscriber(
  apiKey: string,
  { doFetch = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }: Options = {},
): Transcriber {
  const base = 'https://api.assemblyai.com/v2'
  const headers = { authorization: apiKey }
  return {
    model: transcriptModels.assemblyai,
    maxBytes: MAX_FILE,
    async transcribe(audio, _file, { terms, language } = NO_HINTS) {
      const signal = AbortSignal.timeout(ASSEMBLYAI_RUN_MS)
      const uploaded = await jsonOf(
        await doFetch(`${base}/upload`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: audio,
          signal,
        }),
        'the upload',
      )
      const submitted = await jsonOf(
        await doFetch(`${base}/transcript`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            audio_url: uploaded.upload_url,
            speaker_labels: true,
            punctuate: true,
            // Without a language AssemblyAI detects it.
            ...(language ? { language_code: language } : { language_detection: true }),
            ...(terms.length ? { keyterms_prompt: terms } : {}),
          }),
          signal,
        }),
        'the transcription request',
      )
      if (typeof submitted.id !== 'string') throw new TranscriberError(200, 'the transcription request has no id')
      const url = `${base}/transcript/${encodeURIComponent(submitted.id)}`
      while (!signal.aborted) {
        const response = await doFetch(url, { headers, signal })
        const result = await jsonOf(response, 'the transcription')
        if (result.status === 'error') {
          await forget(url)
          throw new TranscriberError(422, 'the transcription failed at AssemblyAI')
        }
        if (result.status === 'completed') {
          await forget(url)
          const utterances = (result.utterances ?? []) as {
            speaker?: unknown
            start?: unknown
            end?: unknown
            text?: unknown
          }[]
          const turns = utterances.flatMap(u =>
            typeof u.text === 'string' && typeof u.start === 'number' && typeof u.end === 'number'
              ? [{ speaker: String(u.speaker ?? ''), start: u.start, end: u.end, text: u.text }]
              : [],
          )
          return { text: asText(result.text, response.status), turns }
        }
        await wait(ASSEMBLYAI_POLL_MS)
      }
      throw new TranscriberError(504, 'AssemblyAI did not finish in time')
    },
  }

  /** Deletes the transcript at AssemblyAI; a failure is logged with its status only, never the body. */
  async function forget(url: string) {
    try {
      const response = await doFetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) })
      await response.body?.cancel()
      if (!response.ok) console.warn(`AssemblyAI did not delete a transcript (${response.status})`)
    } catch {
      console.warn('AssemblyAI did not delete a transcript (no answer)')
    }
  }
}

/** ElevenLabs Scribe v2, with speaker labels (diarize) and word times; turns are the words of one speaker in a row. */
export function elevenLabsTranscriber(apiKey: string, { doFetch = fetch }: Options = {}): Transcriber {
  return {
    model: transcriptModels.elevenlabs,
    maxBytes: MAX_FILE,
    async transcribe(audio, file, { terms, language } = NO_HINTS) {
      const form = new FormData()
      form.append('file', audio, file.name)
      form.append('model_id', 'scribe_v2')
      // Without a language ElevenLabs detects it.
      if (language) form.append('language_code', language)
      for (const term of terms) form.append('keyterms', term)
      form.append('diarize', 'true')
      form.append('tag_audio_events', 'false')
      form.append('timestamps_granularity', 'word')
      const response = await doFetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await jsonOf(response, 'the transcription')
      const text = asText(body.text, response.status)
      const words = (body.words ?? []) as {
        text?: unknown
        type?: unknown
        start?: unknown
        end?: unknown
        speaker_id?: unknown
      }[]
      const turns: HeardTurn[] = []
      for (const word of words) {
        if (word.type !== 'word' || typeof word.text !== 'string') continue
        const speaker = String(word.speaker_id ?? '')
        const start = typeof word.start === 'number' ? word.start * 1000 : 0
        const end = typeof word.end === 'number' ? word.end * 1000 : start
        const last = turns.at(-1)
        if (last && last.speaker === speaker) {
          last.text = `${last.text} ${word.text}`
          last.end = end
        } else turns.push({ speaker, start, end, text: word.text })
      }
      return { text, turns }
    },
  }
}

/** The adapter of a transcription service, with its key. */
export function transcriberFor(service: TranscriptService, apiKey: string, options: Options = {}): Transcriber {
  switch (service) {
    case 'openai':
      return openAiTranscriber(apiKey, options)
    case 'deepgram':
      return deepgramTranscriber(apiKey, options)
    case 'assemblyai':
      return assemblyAiTranscriber(apiKey, options)
    case 'elevenlabs':
      return elevenLabsTranscriber(apiKey, options)
  }
}
