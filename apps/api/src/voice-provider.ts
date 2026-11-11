// The text-to-speech provider as the API needs it: a short sample of a voice (the preview in
// Settings › Assistant) and, where the provider offers it over its API, cloning a voice from a
// recording. Vendor HTTP lives only here; the voice agent has its own pipeline (apps/agent).
import { cloningProviders, type ProviderName } from '@linedesk/actions'

const TIMEOUT_MS = 20_000
/** The same fast model the voice agent uses by default, so the preview sounds like a call. */
export const ELEVENLABS_PREVIEW_MODEL = 'eleven_flash_v2_5'
const CARTESIA_VERSION = '2025-04-16'
const CARTESIA_DEFAULT_MODEL = 'sonic-2'

export type Audio = { bytes: Buffer; contentType: string }
export type CloneRequest = { name: string; audio: Buffer; mimeType: string }

export class VoiceProviderError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface VoiceProvider {
  readonly name: ProviderName
  /** The model previews are made with (part of the preview's cache key). */
  readonly model: string
  synthesize(voiceId: string, text: string): Promise<Audio>
  /** Present only when the provider clones over its API. Returns the new voice id. */
  cloneVoice?(request: CloneRequest): Promise<string>
  /** Deletes a voice cloned with cloneVoice. A voice that is already gone is fine. */
  deleteVoice?(voiceId: string): Promise<void>
}

type Values = { api_key: string; model?: string | null }

/** The provider's error text, short; never the key (it is not in a response body). */
async function failure(res: Response, what: string): Promise<VoiceProviderError> {
  const body = (await res.json().catch(() => null)) as {
    detail?: { message?: string } | string
    message?: string
  } | null
  const detail =
    typeof body?.detail === 'string' ? body.detail : (body?.detail?.message ?? body?.message ?? res.statusText)
  return new VoiceProviderError(`${what} failed (${res.status}): ${String(detail).slice(0, 200)}`, res.status)
}

function elevenlabs({ api_key, model }: Values, doFetch: typeof fetch): VoiceProvider {
  const headers = { 'xi-api-key': api_key }
  const previewModel = model || ELEVENLABS_PREVIEW_MODEL
  return {
    name: 'elevenlabs',
    model: previewModel,
    async synthesize(voiceId, text) {
      const res = await doFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: previewModel }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      if (!res.ok) throw await failure(res, 'voice preview')
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' }
    },
    // Instant voice cloning: one recording, a name; the voice is added to the account behind the key.
    async cloneVoice({ name, audio, mimeType }) {
      const form = new FormData()
      form.append('name', name)
      form.append(
        'files',
        new Blob([new Uint8Array(audio)], { type: mimeType }),
        `sample.${mimeType.split('/')[1] ?? 'audio'}`,
      )
      const res = await doFetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw await failure(res, 'voice cloning')
      const body = (await res.json()) as { voice_id?: string }
      if (!body.voice_id) throw new VoiceProviderError('voice cloning returned no voice id', 502)
      return body.voice_id
    },
    async deleteVoice(voiceId) {
      const res = await doFetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok && res.status !== 404) throw await failure(res, 'deleting the cloned voice')
    },
  }
}

function cartesia({ api_key, model }: Values, doFetch: typeof fetch): VoiceProvider {
  const previewModel = model || CARTESIA_DEFAULT_MODEL
  return {
    name: 'cartesia',
    model: previewModel,
    async synthesize(voiceId, text) {
      const res = await doFetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: { 'x-api-key': api_key, 'cartesia-version': CARTESIA_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({
          model_id: previewModel,
          transcript: text,
          voice: { mode: 'id', id: voiceId },
          output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 64000 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw await failure(res, 'voice preview')
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' }
    },
  }
}

/** The adapter for a text-to-speech provider of the registry, with its key; null for one it does not know. */
export function createVoiceProvider(
  name: ProviderName,
  values: Values,
  doFetch: typeof fetch = fetch,
): VoiceProvider | null {
  const provider =
    name === 'elevenlabs' ? elevenlabs(values, doFetch) : name === 'cartesia' ? cartesia(values, doFetch) : null
  // The registry says who clones (the picker shows it); an adapter only clones when listed there.
  if (provider && !cloningProviders.includes(name)) {
    delete provider.cloneVoice
    delete provider.deleteVoice
  }
  return provider
}
