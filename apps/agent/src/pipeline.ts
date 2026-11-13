// The speech and language vendors, all in one place. Which ones are used comes from AgentConfig:
// speech to text Deepgram; LLM any OpenAI-compatible API (OpenRouter by default, OpenAI direct);
// text to speech ElevenLabs or Cartesia. Turns are detected by Deepgram Flux, not by a local
// voice-activity model: that saves the CPU a small server does not have, and the endpointing delay.
// Or, when an admin picked one, a realtime model alone: it hears the caller and answers in its own voice.
// The worker only sees LiveKit's interfaces and `CompleteJson`.
import { type Language, mainLanguageOf, providerDefaultVoices, SILENCE_FIRST_GAP_DEFAULT_S, TALKING_SPEED_PCT_DEFAULT, type TalkingSpeed, talkingSpeedPctOf } from '@linedesk/actions'
import { tts as ttsTypes, type voice } from '@livekit/agents'
import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as openai from '@livekit/agents-plugin-openai'
import type { AssistantVoice } from '@linedesk/db/types'
import { type AgentConfig, type CallConfig, isRealtime, llmDefaults, type RealtimeConfig, type TtsConfig } from './config.ts'
import type { GreetingVoice } from './greeting-cache.ts'
import { quotedData } from './prompt.ts'
import type { CompleteJson } from './summary.ts'

const SUMMARY_TIMEOUT_MS = 15_000
/**
 * The most a summary may answer with. Without a cap OpenRouter reserves the model's whole output (65k tokens) against
 * the credits and refuses the request (402) once the balance is lower, although a summary needs a few hundred.
 */
export const SUMMARY_MAX_TOKENS = 2000
/**
 * The most one reply on a call may answer with (a few sentences and a tool call). Same reason as SUMMARY_MAX_TOKENS:
 * without it every reply on a call fails with 402 once the OpenRouter balance is below the model's whole output.
 */
export const REPLY_MAX_TOKENS = 1024
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
export function createStt({ provider, apiKey, model }: AgentConfig['stt'], { main, others }: CallLanguages = ENGLISH_CALL) {
  const multi = main !== 'en' || others.length > 0
  // ElevenLabs Scribe and OpenAI transcription stream and detect the end of a turn on their side. With other languages
  // allowed they detect the language of each turn (reported with the transcript); else they are told the one.
  if (provider === 'elevenlabs_stt') return new elevenlabs.STT({ apiKey, model, useRealtime: true, ...(multi ? {} : { languageCode: main }) })
  if (provider === 'openai_stt') return new openai.STT({ apiKey, model, useRealtime: true, detectLanguage: multi, language: main })
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
/**
 * The voice of a call. With a backup (VoiceWithBackup: OpenAI's speech model when an OpenAI key is set up, else another
 * voice provider with a key) it switches to that when the voice provider fails: a used-up quota (ElevenLabs then
 * answers with no audio and no error), a refused key, an outage or a timeout. Without one it is still watched the same
 * way, so a voice that gives no audio is an error the session reports (voice-failures.ts) instead of a silent call.
 */
export function createTts(config: AgentConfig['tts'], assistantVoice?: AssistantVoice | null, language: Language = 'en', speedPct = TALKING_SPEED_PCT_DEFAULT): CallVoice {
  const own = ttsFor(config, assistantVoice)
  const primary = providerTts(own, language, speedPct)
  const others = [config, ...(config.others ?? [])].filter(other => other.provider !== own.provider)
  const backups = [
    ...(config.openAiBackup ? [createRealtimeLineTts(config.openAiBackup, speedPct)] : []),
    ...others.map(other => providerTts({ ...other, voiceId: providerDefaultVoices[other.provider] }, language, speedPct)),
  ]
  return new VoiceWithBackup(primary, backups)
}

function providerTts({ voiceId, ...tts }: TtsConfig & { voiceId?: string }, language: Language, speedPct: number) {
  const spoken = language === 'en' ? {} : { language }
  const speed = speedPct !== TALKING_SPEED_PCT_DEFAULT ? speedPct / 100 : undefined
  if (tts.provider === 'cartesia')
    return new cartesia.TTS({ apiKey: tts.apiKey, ...(tts.model ? { model: tts.model } : {}), ...(voiceId ? { voice: voiceId } : {}), ...spoken, ...(speed ? { speed } : {}) })
  const paced = speed ? { voiceSettings: { stability: 0.5, similarity_boost: 0.75, speed } } : {}
  return new elevenlabs.TTS({ apiKey: tts.apiKey, model: tts.model ?? ELEVENLABS_DEFAULT_MODEL, ...(voiceId ? { voiceId } : {}), ...spoken, ...paced })
}

/** A voice whose language can be changed mid-call (followCallerLanguage): either provider, or one with a backup. */
export type CallVoice = ttsTypes.TTS & { updateOptions(opts: { language?: string }): void }

/**
 * How long a voice provider that failed rests before it is tried again: longer than any call, so a call that switched to
 * its backup stays with it to the end (a provider that answers again right away, as after a single timeout, comes back).
 */
export const VOICE_PROVIDER_REST_MS = 2 * 60 * 60_000

/**
 * The voice provider with backups (LiveKit's FallbackAdapter): the first request it cannot answer goes to the next one,
 * and the rest of the call stays there. `fellBack`: something was said by a backup, so it is not stored as the voice's
 * own audio (greeting and line cache). With no backups the provider is only watched: a line it gives no audio for
 * fails with an error (LiveKit's "no audio was received") instead of playing silence.
 */
export class VoiceWithBackup extends ttsTypes.FallbackAdapter {
  fellBack = false

  constructor(primary: ttsTypes.TTS & { updateOptions(opts: { language?: string }): void }, backups: ttsTypes.TTS[], log: (line: string) => void = console.warn) {
    super({ ttsInstances: [primary, ...backups], maxRetryPerTTS: 0, recoveryDelayMs: VOICE_PROVIDER_REST_MS })
    this.on('tts_availability_changed' as never, (({ tts, available }: ttsTypes.AvailabilityChangedEvent) => {
      const backup = backups[0]
      if (tts !== primary || available || this.fellBack || !backup) return
      this.fellBack = true
      log(`voice ${primary.provider} failed: speaking with ${backup.provider} ${backup.model} for the rest of the call`)
    }) as never)
  }

  /** The language goes to the voice providers that take one; OpenAI's speech model reads it from the text. */
  updateOptions(opts: { language?: string }) {
    for (const instance of this.ttsInstances) if (instance instanceof elevenlabs.TTS || instance instanceof cartesia.TTS) instance.updateOptions(opts)
  }
}

/** Whether a backup voice said any of this (VoiceWithBackup): then it is not cached as the voice's own audio. */
export const spokeWithBackup = (tts: ttsTypes.TTS) => tts instanceof VoiceWithBackup && tts.fellBack

type TalkingSpeedFields = { talking_speed_pct?: number | null; talking_speed?: TalkingSpeed | null }
/** The assistant's talking speed in percent; a row of an older API has only slow, normal or fast, or nothing: 100. */
export const talkingSpeedOf = (assistant: TalkingSpeedFields | null | undefined): number => talkingSpeedPctOf(assistant)

/** OpenRouter's `models`: the model first, then the ones it tries when that one fails. */
const modelsField = (model: string, fallbacks: string[]) => (fallbacks.length ? { models: [model, ...fallbacks] } : {})

/** What every conversation request carries on top of the plugin's own fields: the reply cap, and OpenRouter fallbacks. */
export const replyRequestFields = (model: string, fallbacks: string[]) => ({ max_tokens: REPLY_MAX_TOKENS, ...modelsField(model, fallbacks) })

/** The conversation LLM: every request carries replyRequestFields. */
function createLlm({ apiKey, baseUrl, model, fallbacks }: AgentConfig['llm']) {
  const options = { apiKey, baseURL: baseUrl, model }
  const extra = replyRequestFields(model, fallbacks)
  return new (class extends openai.LLM {
    override chat(args: Parameters<openai.LLM['chat']>[0]) {
      return super.chat({ ...args, extraKwargs: { ...args.extraKwargs, ...extra } })
    }
  })(options)
}

/**
 * Whether the speech recognition says where a turn ends: Flux, ElevenLabs Scribe and OpenAI transcription do. With
 * another Deepgram model the session falls back to its own detection.
 */
export const sttDetectsTurns = ({ provider, model }: AgentConfig['stt']) => provider !== 'deepgram' || model.startsWith('flux')

/**
 * How many tool rounds in a row one caller turn may take before the model must answer with tools off (LiveKit's
 * maxToolSteps, default 3: the 4th round is the last). Each collection step is a round, so a booking turn can take
 * find_slots, get_name, get_phone_number, get_address, get_email and book_appointment one after another.
 */
export const MAX_TOOL_STEPS = 8

/** Session options for one call. */
export function createPipeline(config: AgentConfig, assistantVoice?: AssistantVoice | null, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, languages: CallLanguages = ENGLISH_CALL, speedPct = TALKING_SPEED_PCT_DEFAULT): voice.AgentSessionOptions & { tts: CallVoice } {
  const sttTurns = sttDetectsTurns(config.stt)
  return {
    vad: null,
    stt: createStt(config.stt, languages),
    llm: createLlm(config.llm),
    tts: createTts(config.tts, assistantVoice, languages.main, speedPct),
    turnHandling: { turnDetection: sttTurns ? 'stt' : undefined, endpointing: ENDPOINTING, preemptiveGeneration: { enabled: true } },
    // The caller counts as away after this much silence on both sides; the worker then asks whether they are still
    // there, and in the end says goodbye and hangs up (remindOnSilence in hang-up.ts).
    userAwayTimeout: silenceFirstGapS,
    maxToolSteps: MAX_TOOL_STEPS,
  }
}


/**
 * A realtime session's raw OpenAI events, as the plugin emits them (for timing, realtime-timing.ts), and its way to send
 * one (for the fixed lines, realtime-lines.ts).
 */
export type RealtimeEvents = {
  on(event: 'openai_client_event_queued' | 'openai_server_event_received', listener: (event: { type?: string }) => void): unknown
  sendEvent(event: object): void
}

/** The realtime model, handing each session it opens to `onSession` (one per call, again after a reconnect). */
class ObservedRealtimeModel extends openai.realtime.RealtimeModel {
  readonly #onSession?: (session: RealtimeEvents) => void
  constructor(onSession: ((session: RealtimeEvents) => void) | undefined, options: ConstructorParameters<typeof openai.realtime.RealtimeModel>[0]) {
    super(options)
    this.#onSession = onSession
  }
  override session(...args: Parameters<openai.realtime.RealtimeModel['session']>) {
    const session = super.session(...args)
    this.#onSession?.(session as unknown as RealtimeEvents)
    return session
  }
}

/** What transcribes the caller on a realtime call (the model itself hears the audio). */
const REALTIME_TRANSCRIPTION = 'gpt-4o-mini-transcribe'

/** A phone handset is close to the mouth: near-field noise reduction cleans what the model hears. */
const REALTIME_NOISE_REDUCTION = { type: 'near_field' } as const
/** The caller's transcript (call log, summary): told the language when the call has only one. */
const realtimeTranscription = ({ main, others }: CallLanguages) => ({ model: REALTIME_TRANSCRIPTION, ...(others.length ? {} : { language: main }) })

/**
 * The session.update that turns the realtime model's own replies off (`replies` false) or on again: the input audio
 * settings of createRealtimePipeline, sent whole, with `create_response` set. While its replies are off the model still
 * hears and transcribes the caller, but does not answer (realtime-lines.ts).
 */
export const realtimeRepliesEvent = (replies: boolean, languages: CallLanguages = ENGLISH_CALL) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: REALTIME_NOISE_REDUCTION,
        transcription: realtimeTranscription(languages),
        turn_detection: { ...REALTIME_TURNS, create_response: replies },
      },
    },
  },
})

/**
 * When the realtime model takes its turn: after this much silence (OpenAI's server VAD). Its semantic detection waited
 * about 2.5 s after the caller stopped, even at "high" eagerness: 85 % of a reply's wait in the phone test
 * (realtime-timing.ts), while the model's first audio took 0.3 s. 500 ms of silence is about what Flux waits in the
 * three-stage pipeline; a caller who pauses longer mid-sentence may be answered early.
 */
export const REALTIME_TURNS = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
  create_response: true,
  interrupt_response: true,
} as const

/**
 * Session options for a call answered by a realtime model: no speech to text and no voice provider. The model
 * detects the end of a turn itself (server VAD, REALTIME_TURNS) and transcribes the caller for the call log and summary.
 * `speedPct`: the talking speed in percent, sent as a factor (OpenAI Realtime takes 0.25–1.5); at 100 nothing is sent.
 */
export function createRealtimePipeline({ apiKey, model, voice: voiceName }: RealtimeConfig, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, speedPct = TALKING_SPEED_PCT_DEFAULT, languages: CallLanguages = ENGLISH_CALL, onSession?: (session: RealtimeEvents) => void): voice.AgentSessionOptions {
  return {
    llm: new ObservedRealtimeModel(onSession, {
      apiKey, model, voice: voiceName, turnDetection: REALTIME_TURNS,
      inputAudioNoiseReduction: REALTIME_NOISE_REDUCTION,
      inputAudioTranscription: realtimeTranscription(languages),
      ...(speedPct !== TALKING_SPEED_PCT_DEFAULT ? { speed: speedPct / 100 } : {}),
    }),
    userAwayTimeout: silenceFirstGapS,
    maxToolSteps: MAX_TOOL_STEPS,
  }
}

/**
 * What a realtime model is told to make it say a fixed line (greeting, still there?, goodbye): as written, or in the
 * caller's language when the call goes on in another one. It comes after the whole prompt, so it says plainly that
 * this reply is that line and nothing else.
 */
export const realtimeLine = (text: string) =>
  `Your next reply is exactly this line, word for word, with nothing before or after it: ${quotedData(text)} Only if the caller has been speaking another language, say it in that language instead.`

/** What says the fixed lines on a realtime call: OpenAI's speech model, with the realtime model's key and voice. */
export const REALTIME_LINE_TTS = 'gpt-4o-mini-tts'

type OpenAiVoice = NonNullable<ConstructorParameters<typeof openai.TTS>[0]>['voice']

/** OpenAI's speech model in the realtime model's voice and pace: a fixed line then sounds like the rest of the call. */
export function createRealtimeLineTts({ apiKey, voice: voiceName }: Pick<RealtimeConfig, 'apiKey' | 'voice'>, speedPct = TALKING_SPEED_PCT_DEFAULT) {
  return new openai.TTS({ apiKey, model: REALTIME_LINE_TTS, voice: voiceName as OpenAiVoice, ...(speedPct !== TALKING_SPEED_PCT_DEFAULT ? { speed: speedPct / 100 } : {}) })
}

/**
 * The voice the fixed lines of a call are made in, outside the model's own turns: what makes them, and what a line is
 * cached by (with its text). The three stages: the assistant's voice. A realtime model: OpenAI's speech model in the
 * realtime voice (the model itself, asked to say a line, often said something else).
 */
export type LineVoice = { tts: () => ttsTypes.TTS; key: Omit<GreetingVoice, 'text'> }
type LineAssistant = ({ voice?: AssistantVoice | null; languages?: Parameters<typeof mainLanguageOf>[0] } & TalkingSpeedFields) | null | undefined

export function lineVoiceOf(config: CallConfig, assistant: LineAssistant): LineVoice {
  const speed = talkingSpeedOf(assistant)
  if (isRealtime(config)) {
    const { realtime } = config
    return { key: { provider: 'openai_tts', model: REALTIME_LINE_TTS, voiceId: realtime.voice, speed }, tts: () => createRealtimeLineTts(realtime, speed) }
  }
  return { key: greetingVoice(config, { assistant }), tts: () => createTts(config.tts, assistant?.voice, mainLanguageOf(assistant?.languages), speed) }
}

/** A realtime voice other than `voice`: the simulated on-call person of a call test must not sound like the assistant. */
const otherRealtimeVoice = (voiceName: string) => (voiceName === 'cedar' ? 'marin' : 'cedar')

/**
 * What a warm transfer speaks and hears with, outside the call's own session (transfer-tool.ts, transfer-call.ts): the
 * connecting line to the caller in the call's line voice, the consult leg's voice and speech recognition with the on-call
 * person, and the simulated on-call person's voice in a call test. The three stages: their voice provider and speech to
 * text, as before. A realtime model: OpenAI's speech and transcription models with its key, so a transfer works when only
 * the realtime model is set up.
 */
export type TransferSpeech = {
  line: LineVoice
  consult: { tts: () => ttsTypes.TTS; stt: AgentConfig['stt'] }
  onCallVoice: () => ttsTypes.TTS
}

export function transferSpeechOf(config: CallConfig, assistant: LineAssistant, testCallerVoice = process.env.TEST_CALLER_VOICE_ID): TransferSpeech {
  const line = lineVoiceOf(config, assistant)
  if (!isRealtime(config)) {
    return {
      line,
      consult: { tts: () => createTts(config.tts, assistant?.voice), stt: config.stt },
      onCallVoice: () => createTts(config.tts, testCallerVoice ? { provider: config.tts.provider, voice_id: testCallerVoice } : null),
    }
  }
  const { realtime, stages } = config
  return {
    line,
    consult: { tts: () => createRealtimeLineTts(realtime), stt: { provider: 'openai_stt', apiKey: realtime.apiKey, model: REALTIME_TRANSCRIPTION } },
    // The test caller's voice when the three stages are set up too (as on the three stages), else another realtime voice.
    onCallVoice: stages
      ? transferSpeechOf(stages, assistant, testCallerVoice).onCallVoice
      : () => createRealtimeLineTts({ apiKey: realtime.apiKey, voice: otherRealtimeVoice(realtime.voice) }),
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
