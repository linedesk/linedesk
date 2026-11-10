// The speech and language vendors, all in one place. Which ones are used comes from AgentConfig:
// speech to text Deepgram; LLM any OpenAI-compatible API (OpenRouter by default, OpenAI direct);
// text to speech ElevenLabs or Cartesia. Turns are detected by Deepgram Flux, not by a local
// voice-activity model: that saves the CPU a small server does not have, and the endpointing delay.
// The worker only sees LiveKit's interfaces and `CompleteJson`.
import type { voice } from '@livekit/agents'
import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as openai from '@livekit/agents-plugin-openai'
import type { AssistantVoice } from '@callfront/db/types'
import type { AgentConfig } from './config.ts'
import type { CompleteJson } from './summary.ts'

const SUMMARY_TIMEOUT_MS = 15_000
const WARM_UP_TIMEOUT_MS = 5000

/** ElevenLabs' lowest-latency model, unless another is configured. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5'
/** Flux decides when a turn ends; this only waits briefly for a last word on top. */
const ENDPOINTING = { minDelay: 100, maxDelay: 1000 }
/** Flux reports a likely end of turn this early, so the reply can be prepared while it confirms. */
const EAGER_END_OF_TURN = 0.5

/** The assistant's own voice if it was picked for the provider in use, else the configured default (or the provider's). */
export function voiceFor(tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null): string | undefined {
  return assistantVoice?.provider === tts.provider && assistantVoice.voice_id ? assistantVoice.voice_id : tts.voiceId
}

function createStt({ apiKey, model }: AgentConfig['stt']) {
  // Deepgram's Flux models speak a different protocol than Nova.
  return model.startsWith('flux') ? new deepgram.STTv2({ apiKey, model, eagerEotThreshold: EAGER_END_OF_TURN }) : new deepgram.STT({ apiKey, model })
}

/** The model the voice provider is asked for (ElevenLabs gets its fast default). */
export const ttsModelOf = (tts: AgentConfig['tts']) => tts.model ?? (tts.provider === 'elevenlabs' ? ELEVENLABS_DEFAULT_MODEL : undefined)

export function createTts(tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null) {
  const voiceId = voiceFor(tts, assistantVoice)
  if (tts.provider === 'cartesia') return new cartesia.TTS({ apiKey: tts.apiKey, ...(tts.model ? { model: tts.model } : {}), ...(voiceId ? { voice: voiceId } : {}) })
  return new elevenlabs.TTS({ apiKey: tts.apiKey, model: tts.model ?? ELEVENLABS_DEFAULT_MODEL, ...(voiceId ? { voiceId } : {}) })
}

/** OpenRouter's `models`: the model first, then the ones it tries when that one fails. */
const modelsField = (model: string, fallbacks: string[]) => (fallbacks.length ? { models: [model, ...fallbacks] } : {})

/** The conversation LLM; with fallbacks, every request carries the list. */
function createLlm({ apiKey, baseUrl, model, fallbacks }: AgentConfig['llm']) {
  const options = { apiKey, baseURL: baseUrl, model }
  if (!fallbacks.length) return new openai.LLM(options)
  const extra = modelsField(model, fallbacks)
  return new (class extends openai.LLM {
    override chat(args: Parameters<openai.LLM['chat']>[0]) {
      return super.chat({ ...args, extraKwargs: { ...args.extraKwargs, ...extra } })
    }
  })(options)
}

/** Session options for one call. */
export function createPipeline(config: AgentConfig, assistantVoice?: AssistantVoice | null): voice.AgentSessionOptions {
  // Flux turn detection needs Flux; with another Deepgram model the session falls back to its own detection.
  const fluxTurns = config.stt.model.startsWith('flux')
  return {
    vad: null,
    stt: createStt(config.stt),
    llm: createLlm(config.llm),
    tts: createTts(config.tts, assistantVoice),
    turnHandling: { turnDetection: fluxTurns ? 'stt' : undefined, endpointing: ENDPOINTING, preemptiveGeneration: { enabled: true } },
  }
}

/** Where one chat request goes. */
export type ChatModel = { apiKey: string; baseUrl: string; model: string; fallbacks?: string[] }

/** CompleteJson backed by an OpenAI-compatible chat completions API. Gives up after `timeoutMs`. */
export function chatJson({ apiKey, baseUrl, model, fallbacks = [] }: ChatModel, doFetch: typeof fetch = fetch, timeoutMs = SUMMARY_TIMEOUT_MS): CompleteJson {
  return async (system, user) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, ...modelsField(model, fallbacks), response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null
    if (!res.ok) throw new Error(`summary request failed (${res.status}): ${body?.error?.message ?? res.statusText}`)
    const content = body?.choices?.[0]?.message?.content
    if (!content) throw new Error('summary response was empty')
    return content
  }
}

/** The LLM call used for the post-call summary: the summary model of the conversation's provider. */
export const summaryLlm = ({ llm }: AgentConfig): CompleteJson =>
  chatJson({ apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.summaryModel, fallbacks: llm.summaryFallbacks })

/**
 * Sends the call's system prompt with a one-token answer while the greeting plays, so the caller's first
 * reply finds an open connection (same process, same fetch pool) and, where the provider caches prompts,
 * a cached prompt. Failures only cost the warm-up: they are logged and otherwise ignored.
 */
export async function warmUpLlm({ apiKey, baseUrl, model }: ChatModel, instructions: string, doFetch: typeof fetch = fetch) {
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'system', content: instructions }, { role: 'user', content: 'Hello?' }] }),
      signal: AbortSignal.timeout(WARM_UP_TIMEOUT_MS),
    })
    await res.body?.cancel()
    if (!res.ok) console.warn(`LLM warm-up answered ${res.status}`)
  } catch (e) {
    console.warn(`LLM warm-up failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
