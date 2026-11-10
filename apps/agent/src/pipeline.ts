// The speech and language vendors, all in one place: Deepgram Flux (speech to text),
// OpenAI (conversation and call summary), Cartesia Sonic (text to speech), Silero (voice activity).
// The worker only sees LiveKit's interfaces and `CompleteJson`.
import type { voice } from '@livekit/agents'
import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import type { CompleteJson } from './summary.ts'

export const pipelineEnv = ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY'] as const

const SUMMARY_TIMEOUT_MS = 15_000
const llmModel = () => process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'

export type Vad = Awaited<ReturnType<typeof silero.VAD.load>>

/** Loaded once per worker process, before the first call. */
export const loadVad = (): Promise<Vad> => silero.VAD.load()

/** Session options for one call. `voiceId` is the assistant's configured voice, if any. */
export function createPipeline(vad: Vad, voiceId?: string): voice.AgentSessionOptions {
  return {
    vad,
    stt: new deepgram.STTv2({ model: 'flux-general-en' }),
    llm: new openai.LLM({ model: llmModel() }),
    tts: new cartesia.TTS(voiceId ? { voice: voiceId } : {}),
    // Local turn handling: no dependency on LiveKit Cloud inference when self-hosting.
    turnHandling: { turnDetection: 'vad', interruption: { mode: 'vad' } },
  }
}

/** CompleteJson backed by OpenAI's chat completions API. Gives up after `timeoutMs`. */
export function openAiJson(apiKey: string, model: string, doFetch: typeof fetch = fetch, timeoutMs = SUMMARY_TIMEOUT_MS): CompleteJson {
  return async (system, user) => {
    const res = await doFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null
    if (!res.ok) throw new Error(`OpenAI summary request failed (${res.status}): ${body?.error?.message ?? res.statusText}`)
    const content = body?.choices?.[0]?.message?.content
    if (!content) throw new Error('OpenAI summary response was empty')
    return content
  }
}

/** The LLM call used for the post-call summary. */
export const summaryLlm = (): CompleteJson => openAiJson(process.env.OPENAI_API_KEY ?? '', llmModel())
