// The speech and language vendors, all in one place. Which ones are used comes from AgentConfig:
// speech to text Deepgram; LLM any OpenAI-compatible API (OpenRouter by default, OpenAI direct);
// text to speech ElevenLabs or Cartesia. Turns are detected by Deepgram Flux, not by a local
// voice-activity model: that saves the CPU a small server does not have, and the endpointing delay.
// Or, when an admin picked one, a realtime model alone: it hears the caller and answers in its own voice.
// The worker only sees LiveKit's interfaces and `CompleteJson`.
import { type Language, providerDefaultVoices, SILENCE_FIRST_GAP_DEFAULT_S, TALKING_SPEED_PCT_DEFAULT, type TalkingSpeed, talkingSpeedPctOf } from '@linedesk/actions'
import type { voice } from '@livekit/agents'
import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as openai from '@livekit/agents-plugin-openai'
import type { AssistantVoice } from '@linedesk/db/types'
import { type AgentConfig, type CallConfig, isRealtime, llmDefaults, type RealtimeConfig, type TtsConfig } from './config.ts'
import type { CompleteJson } from './summary.ts'

const SUMMARY_TIMEOUT_MS = 15_000
/**
 * The most a summary may answer with. Without a cap OpenRouter reserves the model's whole output (65k tokens) against
 * the credits and refuses the request (402) once the balance is lower, although a summary needs a few hundred.
 */
export const SUMMARY_MAX_TOKENS = 2000
const WARM_UP_TIMEOUT_MS = 5000

/** ElevenLabs' lowest-latency model, unless another is configured. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5'
/** Flux decides when a turn ends; this only waits briefly for a last word on top. */
const ENDPOINTING = { minDelay: 100, maxDelay: 1000 }
/** Flux reports a likely end of turn this early, so the reply can be prepared while it confirms. */
const EAGER_END_OF_TURN = 0.5

/**
 * The voice provider and voice a call uses: the assistant's own voice with its provider when that one
 * is set up (the one in use or another with a key), else the configured default voice (or the provider's).
 */
export function ttsFor(tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null): TtsConfig & { voiceId?: string } {
  const own = assistantVoice?.voice_id
  if (own && assistantVoice.provider === tts.provider) return { provider: tts.provider, apiKey: tts.apiKey, model: tts.model, voiceId: own }
  const other = own ? tts.others?.find(o => o.provider === assistantVoice.provider) : undefined
  if (other) return { ...other, voiceId: own }
  return { provider: tts.provider, apiKey: tts.apiKey, model: tts.model, voiceId: tts.voiceId ?? providerDefaultVoices[tts.provider] }
}

/** The voice id a call uses (see ttsFor). */
export const voiceFor = (tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null): string | undefined =>
  ttsFor(tts, assistantVoice).voiceId

/** What a cached line in the assistant's voice is keyed by (with its text): provider, model, voice and speed. */
export function greetingVoice(config: AgentConfig, call: { assistant?: ({ voice?: AssistantVoice | null } & TalkingSpeedFields) | null }) {
  const tts = ttsFor(config.tts, call.assistant?.voice)
  return { provider: tts.provider, model: ttsModelOf(tts), voiceId: tts.voiceId, speed: talkingSpeedOf(call.assistant) }
}

/** Deepgram's multilingual Flux: same price and turn detection as English Flux, 10 languages, switches mid-call. */
export const FLUX_MULTILINGUAL = 'flux-general-multi'

/** The languages a call is spoken in: the assistant's main language first, then the others it may switch to. */
export type CallLanguages = { main: Language; others: readonly Language[] }
export const ENGLISH_CALL: CallLanguages = { main: 'en', others: [] }

/**
 * Speech recognition for a call. English only: the configured model as it is. Any other main language, or other
 * languages allowed: the multilingual model of the same family, biased toward the call's languages, so each
 * transcript reports the language spoken. An English-only model would turn other languages into nonsense.
 */
export function createStt({ apiKey, model }: AgentConfig['stt'], { main, others }: CallLanguages = ENGLISH_CALL) {
  const multi = main !== 'en' || others.length > 0
  const languageHint = multi ? [main, ...others] : undefined
  // Deepgram's Flux models speak a different protocol than Nova.
  if (model.startsWith('flux')) {
    return new deepgram.STTv2({ apiKey, model: multi ? FLUX_MULTILINGUAL : model, eagerEotThreshold: EAGER_END_OF_TURN, ...(languageHint ? { languageHint } : {}) })
  }
  // Only Nova-3 detects the language on a live stream (`multi`).
  return multi ? new deepgram.STT({ apiKey, model: 'nova-3', language: 'multi', languageHint }) : new deepgram.STT({ apiKey, model })
}

/** The model the voice provider is asked for (ElevenLabs gets its fast default). */
export const ttsModelOf = (tts: TtsConfig) => tts.model ?? (tts.provider === 'elevenlabs' ? ELEVENLABS_DEFAULT_MODEL : undefined)

/** `language`: what the voice speaks at first (Cartesia reads every text as English unless told); English is the providers' default. */
/**
 * `speedPct`: the talking speed in percent of the voice's own pace, sent as a factor (both providers take 0.8–1.2).
 * ElevenLabs' voice settings come as a whole, so a speed also sets stability and similarity, to ElevenLabs' defaults;
 * at the voice's own pace nothing is sent and the voice's own settings apply.
 */
export function createTts(config: AgentConfig['tts'], assistantVoice?: AssistantVoice | null, language: Language = 'en', speedPct = TALKING_SPEED_PCT_DEFAULT) {
  const { voiceId, ...tts } = ttsFor(config, assistantVoice)
  const spoken = language === 'en' ? {} : { language }
  const speed = speedPct !== TALKING_SPEED_PCT_DEFAULT ? speedPct / 100 : undefined
  if (tts.provider === 'cartesia')
    return new cartesia.TTS({ apiKey: tts.apiKey, ...(tts.model ? { model: tts.model } : {}), ...(voiceId ? { voice: voiceId } : {}), ...spoken, ...(speed ? { speed } : {}) })
  const paced = speed ? { voiceSettings: { stability: 0.5, similarity_boost: 0.75, speed } } : {}
  return new elevenlabs.TTS({ apiKey: tts.apiKey, model: tts.model ?? ELEVENLABS_DEFAULT_MODEL, ...(voiceId ? { voiceId } : {}), ...spoken, ...paced })
}

type TalkingSpeedFields = { talking_speed_pct?: number | null; talking_speed?: TalkingSpeed | null }
/** The assistant's talking speed in percent; a row of an older API has only slow, normal or fast, or nothing: 100. */
export const talkingSpeedOf = (assistant: TalkingSpeedFields | null | undefined): number => talkingSpeedPctOf(assistant)

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
export function createPipeline(config: AgentConfig, assistantVoice?: AssistantVoice | null, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, languages: CallLanguages = ENGLISH_CALL, speedPct = TALKING_SPEED_PCT_DEFAULT): voice.AgentSessionOptions & { tts: ReturnType<typeof createTts> } {
  // Flux turn detection needs Flux; with another Deepgram model the session falls back to its own detection.
  const fluxTurns = config.stt.model.startsWith('flux')
  return {
    vad: null,
    stt: createStt(config.stt, languages),
    llm: createLlm(config.llm),
    tts: createTts(config.tts, assistantVoice, languages.main, speedPct),
    turnHandling: { turnDetection: fluxTurns ? 'stt' : undefined, endpointing: ENDPOINTING, preemptiveGeneration: { enabled: true } },
    // The caller counts as away after this much silence on both sides; the worker then asks whether they are still
    // there, and in the end says goodbye and hangs up (remindOnSilence in hang-up.ts).
    userAwayTimeout: silenceFirstGapS,
  }
}


/**
 * Session options for a call answered by a realtime model: no speech to text and no voice provider. The model
 * detects the end of a turn itself (semantic VAD) and transcribes the caller for the call log and summary.
 * `speedPct`: the talking speed in percent, sent as a factor (OpenAI Realtime takes 0.25–1.5); at 100 nothing is sent.
 */
export function createRealtimePipeline({ apiKey, model, voice: voiceName }: RealtimeConfig, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, speedPct = TALKING_SPEED_PCT_DEFAULT): voice.AgentSessionOptions {
  return {
    llm: new openai.realtime.RealtimeModel({ apiKey, model, voice: voiceName, ...(speedPct !== TALKING_SPEED_PCT_DEFAULT ? { speed: speedPct / 100 } : {}) }),
    userAwayTimeout: silenceFirstGapS,
  }
}

/**
 * What a realtime model is told to make it say a fixed line (greeting, still there?, goodbye): as written, or in the
 * caller's language when the call goes on in another one.
 */
export const realtimeLine = (text: string) =>
  `Say exactly the following to the caller, nothing before or after it. If you are speaking another language with the caller, say it in that language instead: "${text}"`

/** Where one chat request goes. */
export type ChatModel = { apiKey: string; baseUrl: string; model: string; fallbacks?: string[] }

/** CompleteJson backed by an OpenAI-compatible chat completions API. Gives up after `timeoutMs`. */
export function chatJson({ apiKey, baseUrl, model, fallbacks = [] }: ChatModel, doFetch: typeof fetch = fetch, timeoutMs = SUMMARY_TIMEOUT_MS): CompleteJson {
  return async (system, user) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, ...modelsField(model, fallbacks), response_format: { type: 'json_object' }, max_tokens: SUMMARY_MAX_TOKENS,
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

/**
 * The LLM call used for the post-call summary: the summary model of the conversation's provider; with a realtime
 * model, its summary model on OpenAI's chat API with the same key.
 */
export function summaryLlm(config: CallConfig): CompleteJson {
  if (isRealtime(config)) return chatJson({ apiKey: config.realtime.apiKey, baseUrl: llmDefaults.openai.baseUrl, model: config.realtime.summaryModel })
  const { llm } = config
  return chatJson({ apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.summaryModel, fallbacks: llm.summaryFallbacks })
}

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
