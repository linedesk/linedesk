// The speech and language vendors, all in one place. Which ones are used comes from AgentConfig:
// speech to text Deepgram; LLM any OpenAI-compatible API (OpenAI by default; OpenRouter, Anthropic, Gemini, Groq, Mistral);
// text to speech ElevenLabs or Cartesia. Turns are detected by Deepgram Flux, not by a local
// voice-activity model: that saves the CPU a small server does not have, and the endpointing delay.
// Or, when an admin picked one, a realtime model alone: it hears the caller and answers in its own voice.
// The worker only sees LiveKit's interfaces and `CompleteJson`.
import { DEFAULT_VOICE_MODELS, noPrivateEndpointText, noTrainingFields, voiceModelFor, anyModeLanguages, fluxRecognizes, sttHears, type HearingModel, type Language, mainLanguageOf, otherLanguagesOf, providerLanguageCode, type SpeakingVoice, spokenLanguages, defaultVoiceFor, providerDefaultVoices, ELEVENLABS_VOICE_SETTINGS, SILENCE_FIRST_GAP_DEFAULT_S, TALKING_SPEED_PCT_DEFAULT, type TalkingSpeed, talkingSpeedPctOf } from '@linedesk/actions'
import { DEFAULT_API_CONNECT_OPTIONS, tts as ttsTypes, type voice } from '@livekit/agents'
import * as assemblyai from '@livekit/agents-plugin-assemblyai'
import * as cartesia from '@livekit/agents-plugin-cartesia'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import * as openai from '@livekit/agents-plugin-openai'
import type { AssistantVoice } from '@linedesk/db/types'
import { type AgentConfig, type CallConfig, isRealtime, llmDefaults, type RealtimeConfig, type TtsConfig } from './config.ts'
import type { GreetingVoice } from './greeting-cache.ts'
import { quotedData } from './prompt.ts'
import type { CompleteJson } from './summary.ts'
import { type GatedSession, gateReplies, type RealtimeReplyGate } from './realtime-replies.ts'
import { REALTIME_CONNECT_TIMEOUT_MS } from './realtime-connect.ts'

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

/** ElevenLabs' lowest-latency model, unless another is configured (DEFAULT_VOICE_MODELS). */
export const ELEVENLABS_DEFAULT_MODEL = DEFAULT_VOICE_MODELS.elevenlabs!
/** Flux decides when a turn ends; this only waits briefly for a last word on top. */
const ENDPOINTING = { minDelay: 100, maxDelay: 1000 }
/** Flux reports a likely end of turn this early, so the reply can be prepared while it confirms. */
const EAGER_END_OF_TURN = 0.5

/**
 * The voice provider and voice a call uses: the assistant's own voice with its provider when that one
 * is set up (the one in use or another with a key), else the default voice for the call's main language
 * (defaultVoiceFor: a voice recorded in that language, languageDefaultVoices; English and a language without one: the
 * provider's default voice, providerDefaultVoices).
 * The model: the assistant's own voice model when it is one of that provider's (voiceModelFor; call.start sends the
 * level's), else the provider's default.
 */
export function ttsFor(tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null, language: Language = 'en'): TtsConfig & { voiceId?: string } {
  const own = assistantVoice?.voice_id
  const modelOf = (c: TtsConfig) => voiceModelFor(c.provider, assistantVoice?.provider === c.provider ? assistantVoice.model : undefined, c.model) || undefined
  if (own && assistantVoice.provider === tts.provider) return { provider: tts.provider, apiKey: tts.apiKey, model: modelOf(tts), voiceId: own }
  const other = own ? tts.others?.find(o => o.provider === assistantVoice.provider) : undefined
  if (other) return { ...other, model: modelOf(other), voiceId: own }
  return {
    provider: tts.provider,
    apiKey: tts.apiKey,
    model: modelOf(tts),
    voiceId: defaultVoiceFor(tts.provider, language),
  }
}

/** The voice id a call uses (see ttsFor). */
export const voiceFor = (tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null, language: Language = 'en'): string | undefined =>
  ttsFor(tts, assistantVoice, language).voiceId

/** What a cached line in the assistant's voice is keyed by (with its text): provider, model, voice and speed. */
export function greetingVoice(config: AgentConfig, call: { assistant?: ({ voice?: AssistantVoice | null; languages?: Parameters<typeof mainLanguageOf>[0] } & TalkingSpeedFields) | null }) {
  const tts = ttsFor(config.tts, call.assistant?.voice, mainLanguageOf(call.assistant?.languages))
  return { provider: tts.provider, model: ttsModelOf(tts), voiceId: tts.voiceId, speed: talkingSpeedOf(call.assistant) }
}

/** Deepgram's multilingual Flux: same price and turn detection as English Flux, 10 languages, switches mid-call. */
export const FLUX_MULTILINGUAL = 'flux-general-multi'

/**
 * The languages a call is spoken in: the assistant's main language first, then the others it may switch to.
 * `everyLanguage`: the assistant speaks every language the install offers (`mode: 'any'`), so speech recognition
 * detects the language rather than being biased toward a long list.
 */
export type CallLanguages = { main: Language; others: readonly Language[]; everyLanguage?: boolean }
export const ENGLISH_CALL: CallLanguages = { main: 'en', others: [] }

/**
 * A call's languages from the assistant's setting: its main language, and the others it may switch to that a voice
 * provider of the install speaks (spokenLanguages; `voices`: the call's voice providers, none for a realtime call).
 * "Any language" with a Flux model (`stt`) means Flux's 10, as before more languages were added (coordinator decision on
 * LIN-268: existing assistants are not moved off Flux); the others are used only when picked as the main language or
 * in the allowed list.
 */
export function callLanguagesOf(
  stored: Parameters<typeof otherLanguagesOf>[0],
  voices: readonly SpeakingVoice[] = [],
  stt?: HearingModel | null,
): CallLanguages {
  const spoken = spokenLanguages(voices)
  const any = stored?.mode === 'any'
  const allowed = any ? anyModeLanguages(spoken, stt) : spoken
  return {
    main: mainLanguageOf(stored),
    // A language the speech recognition does not hear (AssemblyAI: Polish and five more, sttHears) is left out.
    others: otherLanguagesOf(stored).filter(code => allowed.includes(code) && sttHears(stt, code)),
    ...(any ? { everyLanguage: true } : {}),
  }
}

/**
 * The assistant as this call speaks: its languages replaced by the call's (callLanguagesOf), so the instructions name
 * the languages the speech recognition and voice can handle.
 */
export function withCallLanguages<A extends { languages?: unknown }>(assistant: A | null, { main, others }: CallLanguages): A | null {
  if (!assistant) return assistant
  return { ...assistant, languages: { main, mode: others.length ? 'allowed' : 'english', allowed: [...others] } }
}

/**
 * The voice a call speaks with, for the languages it may switch to: the assistant's own (ttsFor), with the voice model
 * the call uses (an assistant on Eleven Multilingual v2 does not get the languages only Flash v2.5 speaks).
 */
export const callVoicesOf = (tts: AgentConfig['tts'], assistantVoice?: AssistantVoice | null): SpeakingVoice[] => {
  const voice = ttsFor(tts, assistantVoice)
  return [{ provider: voice.provider, model: ttsModelOf(voice) }]
}

/** Deepgram's recommended endpointing for code-switching (Nova-3 `multi`), in ms. */
export const NOVA_MULTI_ENDPOINTING_MS = 100

/** Whether a call speaks only English (no multilingual model needed). */
const englishOnly = ({ main, others }: CallLanguages) => main === 'en' && others.length === 0
/** Whether Flux multilingual recognizes every language of the call; else it needs Nova-3 `multi`. */
export const fluxCovers = ({ main, others }: CallLanguages) => [main, ...others].every(fluxRecognizes)

/** What Deepgram is asked for: Flux (its own protocol and turn detection) or Nova. */
export type DeepgramChoice =
  | { protocol: 'flux'; model: string; languageHint?: string[] }
  | { protocol: 'nova'; model: string; language?: 'multi'; languageHint?: string[]; endpointing?: number }

/**
 * The Deepgram model for a call. English only: the configured model as it is. A Flux model and languages Flux
 * multilingual covers: `flux-general-multi`, biased toward them. Any language outside Flux's 10 (or a Nova model):
 * Nova-3 `multi`, which code-switches across all of LANGUAGES, with the call's languages as hints (Deepgram's codes;
 * only the main one when the assistant speaks every language). An English-only model would turn other languages into
 * nonsense.
 */
export function deepgramChoice(model: string, languages: CallLanguages = ENGLISH_CALL): DeepgramChoice {
  const flux = model.startsWith('flux')
  if (englishOnly(languages)) return { protocol: flux ? 'flux' : 'nova', model }
  const { main, others, everyLanguage } = languages
  const hinted = (codes: readonly Language[]) => codes.map(code => providerLanguageCode(code, 'deepgram'))
  if (flux && fluxCovers(languages)) return { protocol: 'flux', model: FLUX_MULTILINGUAL, languageHint: hinted([main, ...others]) }
  // Only Nova-3 detects the language on a live stream (`multi`).
  return {
    protocol: 'nova',
    model: 'nova-3',
    language: 'multi',
    languageHint: hinted(everyLanguage ? [main] : [main, ...others]),
    endpointing: NOVA_MULTI_ENDPOINTING_MS,
  }
}

/**
 * AssemblyAI's turn setting: `max_accuracy` by default, which ends turns as late as Deepgram Flux and cut as few
 * callers off in the bench (LIN-516). `balanced` (Server admin › Providers › AssemblyAI, "Wait for
 * callers to finish" off) ends a turn after 128 ms of silence when the model is sure, at the latest after 1280 ms: about 0.25 s sooner,
 * but it cut callers off at a short pause in two thirds of the turns. Without a mode the LiveKit plugin ends every
 * turn after 100 ms of silence.
 */
export const assemblyAiTurnMode = (fastTurnEnd = false): 'balanced' | 'max_accuracy' => (fastTurnEnd ? 'balanced' : 'max_accuracy')
/** AssemblyAI steers toward at most 10 languages; with more (or every language) it is not steered and hears all it knows. */
const ASSEMBLYAI_MAX_LANGUAGES = 10
/** The languages AssemblyAI's Universal-3 Pro streaming takes in `language_codes` (its API reference, 2026-11-17). */
const ASSEMBLYAI_LANGUAGES: ReadonlySet<string> = new Set(['af', 'ar', 'yue', 'ca', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'gl', 'de', 'he', 'hi', 'it', 'ja', 'ko', 'zh', 'mr', 'no', 'nn', 'fa', 'pt', 'ro', 'ru', 'es', 'sv', 'tr', 'ur', 'vi', 'xh', 'zu'])
/** The models LiveKit's plugin takes the turn mode and languages for; it refuses both for any other model (a newer one typed in the model field). */
const ASSEMBLYAI_U3_PRO = new Set(['u3-rt-pro', 'u3-rt-pro-beta-1', 'universal-3-5-pro', 'universal-3-6-pro'])

/**
 * What AssemblyAI is asked for: the call's languages to steer toward (only those it takes; only the main one when the
 * assistant speaks every language), and the language of each turn reported when other languages are allowed. A model
 * outside Universal-3 Pro gets neither mode nor languages (the plugin would refuse to start).
 */
export function assemblyAiChoice(model: string, languages: CallLanguages = ENGLISH_CALL, fastTurnEnd = false) {
  const { main, others, everyLanguage } = languages
  const base = { speechModel: model as assemblyai.STTModels, languageDetection: !englishOnly(languages) }
  if (!ASSEMBLYAI_U3_PRO.has(model)) return base
  const steered = (everyLanguage ? [main] : [main, ...others]).filter(code => ASSEMBLYAI_LANGUAGES.has(code))
  const steer = steered.length > 0 && steered.length <= ASSEMBLYAI_MAX_LANGUAGES
  return { ...base, mode: assemblyAiTurnMode(fastTurnEnd), ...(steer ? { languageCodes: steered } : {}) }
}

/**
 * Speech recognition for a call (deepgramChoice for Deepgram, assemblyAiChoice for AssemblyAI). ElevenLabs Scribe,
 * OpenAI transcription and AssemblyAI stream and detect the end of a turn on their side. With other languages allowed they detect the language of each turn
 * (reported with the transcript); else they are told the one. Deepgram gets `mip_opt_out` on every stream, as the
 * after-call transcriber does: it then keeps no call audio for its Model Improvement Program (training).
 */
/**
 * The speech recognition a call hears with: the install's, except AssemblyAI for a call in a language it can't
 * understand (sttHears without the fallback: Polish and five more) when Deepgram is set up too: then Deepgram Nova-3,
 * which hears every language of the table (LIN-656).
 */
export function sttForCall(stt: AgentConfig['stt'], { main, others }: CallLanguages): AgentConfig['stt'] {
  if (stt.provider !== 'assemblyai_stt' || !stt.fallback) return stt
  const hearing = { provider: stt.provider, model: stt.model }
  if ([main, ...others].every(code => sttHears(hearing, code))) return stt
  return { provider: 'deepgram', apiKey: stt.fallback.apiKey, model: 'nova-3' }
}

export function createStt(config: AgentConfig['stt'], languages: CallLanguages = ENGLISH_CALL) {
  const { provider, apiKey, model, fastTurnEnd } = sttForCall(config, languages)
  const multi = !englishOnly(languages)
  const { main } = languages
  if (provider === 'elevenlabs_stt') return new elevenlabs.STT({ apiKey, model, useRealtime: true, ...(multi ? {} : { languageCode: main }) })
  if (provider === 'openai_stt') return new openai.STT({ apiKey, model, useRealtime: true, detectLanguage: multi, language: main })
  if (provider === 'assemblyai_stt') return new assemblyai.STT({ apiKey, ...assemblyAiChoice(model, languages, fastTurnEnd) })
  const choice = deepgramChoice(model, languages)
  const { languageHint } = choice
  // Deepgram's Flux models speak a different protocol than Nova.
  if (choice.protocol === 'flux') return new deepgram.STTv2({ apiKey, model: choice.model, eagerEotThreshold: EAGER_END_OF_TURN, mipOptOut: true, ...(languageHint ? { languageHint } : {}) })
  if (!choice.language) return new deepgram.STT({ apiKey, model: choice.model, mipOptOut: true })
  return new deepgram.STT({ apiKey, model: choice.model, language: choice.language, languageHint, endpointing: choice.endpointing, mipOptOut: true })
}

/** The model the voice provider is asked for (each gets its default, DEFAULT_VOICE_MODELS, when the call names none). */
export const ttsModelOf = (tts: TtsConfig) => tts.model || DEFAULT_VOICE_MODELS[tts.provider]

/** `language`: what the voice speaks at first (Cartesia reads every text as English unless told); English is the providers' default. */
/**
 * `speedPct`: the talking speed in percent of the voice's own pace, sent as a factor (both providers take 0.8–1.2).
 * ElevenLabs always gets its default settings with the speed (elevenLabsVoiceSettings), also at 100: else a Voice
 * Library voice speaks with the settings its owner saved, often much slower (LIN-712).
 */
/**
 * The voice of a call. With a backup (VoiceWithBackup: OpenAI's speech model when an OpenAI key is set up, else another
 * voice provider with a key) it switches to that when the voice provider fails: a used-up quota (ElevenLabs then
 * answers with no audio and no error), a refused key, an outage or a timeout. Without one it is still watched the same
 * way, so a voice that gives no audio is an error the session reports (voice-failures.ts) instead of a silent call.
 */
export function createTts(config: AgentConfig['tts'], assistantVoice?: AssistantVoice | null, language: Language = 'en', speedPct = TALKING_SPEED_PCT_DEFAULT): CallVoice {
  const own = ttsFor(config, assistantVoice, language)
  const primary = providerTts(own, language, speedPct)
  const others = [config, ...(config.others ?? [])].filter(other => other.provider !== own.provider)
  // A language's default voice is a Voice Library voice, which a free ElevenLabs plan can't use: the provider's own
  // default voice is the first backup then, before any other provider.
  const providerDefault = providerDefaultVoices[own.provider]
  const sameProvider = !!providerDefault && own.voiceId !== providerDefault && own.voiceId === defaultVoiceFor(own.provider, language)
  const backups = [
    ...(sameProvider ? [providerTts({ ...own, voiceId: providerDefault }, language, speedPct)] : []),
    ...(config.openAiBackup ? [createRealtimeLineTts(config.openAiBackup, speedPct)] : []),
    ...others.map(other => providerTts({ ...other, voiceId: providerDefaultVoices[other.provider] }, language, speedPct)),
  ]
  return new VoiceWithBackup(primary, backups)
}

function providerTts({ voiceId, ...tts }: TtsConfig & { voiceId?: string }, language: Language, speedPct: number) {
  const spoken = language === 'en' ? {} : { language: providerLanguageCode(language, tts.provider) }
  const speed = speedPct !== TALKING_SPEED_PCT_DEFAULT ? speedPct / 100 : undefined
  if (tts.provider === 'cartesia')
    return new cartesia.TTS({ apiKey: tts.apiKey, model: ttsModelOf(tts), ...(voiceId ? { voice: voiceId } : {}), ...spoken, ...(speed ? { speed } : {}) })
  return new elevenlabs.TTS({ apiKey: tts.apiKey, model: ttsModelOf(tts), ...(voiceId ? { voiceId } : {}), ...spoken, voiceSettings: elevenLabsVoiceSettings(speedPct), preferredAlignment: ELEVENLABS_ALIGNMENT })
}

/** What ElevenLabs is sent on every call: its default settings with the talking speed (LIN-712). */
export const elevenLabsVoiceSettings = (speedPct: number) => ({ ...ELEVENLABS_VOICE_SETTINGS, speed: speedPct / 100 })

/**
 * Which of ElevenLabs' word timings the reply's text is taken from. LiveKit takes the text the voice speaks along with
 * from the voice provider's timings, and that text, not the model's, becomes the reply in the call's history and
 * transcript. LiveKit's default is ElevenLabs' normalized text, which is romanized for Japanese (佐藤 → "Zuo Teng"):
 * the model then copied that style from its second reply on and the voice read the romanization out. The original
 * timings carry the model's own text in its own script, still word by word, so a reply the caller cuts off is kept up
 * to where it stopped as before (for English and every language written with spaces).
 */
export const ELEVENLABS_ALIGNMENT = 'original' as const

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
    const codeFor = (provider: 'elevenlabs' | 'cartesia') =>
      opts.language ? { ...opts, language: providerLanguageCode(opts.language as Language, provider) } : opts
    for (const instance of this.ttsInstances) {
      if (instance instanceof elevenlabs.TTS) instance.updateOptions(codeFor('elevenlabs'))
      else if (instance instanceof cartesia.TTS) instance.updateOptions(codeFor('cartesia'))
    }
  }
}

/** Whether a backup voice said any of this (VoiceWithBackup): then it is not cached as the voice's own audio. */
export const spokeWithBackup = (tts: ttsTypes.TTS) => tts instanceof VoiceWithBackup && tts.fellBack

type TalkingSpeedFields = { talking_speed_pct?: number | null; talking_speed?: TalkingSpeed | null }
/** The assistant's talking speed in percent; a row of an older API has only slow, normal or fast, or nothing: 100. */
export const talkingSpeedOf = (assistant: TalkingSpeedFields | null | undefined): number => talkingSpeedPctOf(assistant)

/** OpenRouter's `models`: the model first, then the ones it tries when that one fails. */
const modelsField = (model: string, fallbacks: string[]) => (fallbacks.length ? { models: [model, ...fallbacks] } : {})

/**
 * A cap on the answer's tokens. OpenAI's own API wants `max_completion_tokens` (its gpt-5 models refuse `max_tokens`
 * with a 400); OpenRouter and the other OpenAI-compatible APIs take `max_tokens`.
 */
export const tokenCap = (baseUrl: string, n: number) =>
  /^https:\/\/api\.openai\.com\//.test(baseUrl) ? { max_completion_tokens: n } : { max_tokens: n }

/**
 * What every conversation request carries on top of the plugin's own fields: the reply cap, OpenRouter fallbacks, and
 * OpenRouter's rule to route only to providers that don't train on the call, and with zero data retention unless the
 * instance admin turned that off (noTrainingFields).
 */
export const replyRequestFields = (model: string, fallbacks: string[], baseUrl: string, zeroDataRetention = true) => ({ ...tokenCap(baseUrl, REPLY_MAX_TOKENS), ...modelsField(model, fallbacks), ...noTrainingFields(baseUrl, zeroDataRetention) })

/** The conversation LLM: every request carries replyRequestFields. */
function createLlm({ apiKey, baseUrl, model, fallbacks, zeroDataRetention }: AgentConfig['llm']) {
  const options = { apiKey, baseURL: baseUrl, model }
  const extra = replyRequestFields(model, fallbacks, baseUrl, zeroDataRetention)
  return new (class extends openai.LLM {
    override chat(args: Parameters<openai.LLM['chat']>[0]) {
      return super.chat({ ...args, extraKwargs: { ...args.extraKwargs, ...extra } })
    }
  })(options)
}

/**
 * Whether the speech recognition says where a turn ends: Flux, ElevenLabs Scribe, OpenAI transcription and AssemblyAI do. With
 * another Deepgram model (also Nova-3 `multi` for a language outside Flux's 10) the session falls back to its own
 * detection.
 */
export const sttDetectsTurns = (stt: AgentConfig['stt'], languages: CallLanguages = ENGLISH_CALL) => {
  const { provider, model } = sttForCall(stt, languages)
  return provider !== 'deepgram' || deepgramChoice(model, languages).protocol === 'flux'
}

/**
 * How many tool rounds in a row one caller turn may take before the model must answer with tools off (LiveKit's
 * maxToolSteps, default 3: the 4th round is the last). Each collection step is a round, so a booking turn can take
 * find_slots, get_name, get_phone_number, get_address, get_email and book_appointment one after another.
 */
export const MAX_TOOL_STEPS = 8

/** Session options for one call. */
export function createPipeline(config: AgentConfig, assistantVoice?: AssistantVoice | null, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, languages: CallLanguages = ENGLISH_CALL, speedPct = TALKING_SPEED_PCT_DEFAULT): voice.AgentSessionOptions & { tts: CallVoice } {
  const sttTurns = sttDetectsTurns(config.stt, languages)
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
  /** One reply at a time (realtime-replies.ts): every reply asked for waits until the model is not answering. */
  replies: RealtimeReplyGate
}

/**
 * How a realtime call's conversation is cut once it is long (research §8.6). OpenAI cuts by itself at about 28.7k tokens
 * and again a little every turn after that, and every cut re-reads the whole rest uncached. Instead: past 4,000 tokens
 * after the instructions, keep half, in one cut, so the prompt cache breaks rarely. The facts stay in the call notes at
 * the end of the instructions (call-notes.ts), the earlier turns as text (realtime-history.ts). LiveKit has no option for
 * it, so the session.update the plugin builds (on open and after every reconnect) gets it added (withRealtimeTruncation).
 */
export const REALTIME_TRUNCATION = {
  type: 'retention_ratio',
  retention_ratio: 0.5,
  token_limits: { post_instructions: 4000 },
} as const

/** A full session.update with REALTIME_TRUNCATION in it (other events go through unchanged). */
export function withRealtimeTruncation<E extends { type?: string; session?: object }>(event: E): E {
  if (event.type !== 'session.update' || !event.session || !('type' in event.session) || event.session.type !== 'realtime') return event
  return { ...event, session: { ...event.session, truncation: REALTIME_TRUNCATION } }
}

/** The plugin's session, as far as the truncation needs it: the session.update it builds on open and on a reconnect. */
type SessionUpdates = { createSessionUpdateEvent(): { type?: string; session?: object }; sendEvent(event: object): void }

/**
 * Makes the session send REALTIME_TRUNCATION: once now (the session's first session.update is already queued without
 * it) and in every full session.update it builds later, the one after a reconnect included.
 */
export function sendRealtimeTruncation(session: SessionUpdates) {
  const build = session.createSessionUpdateEvent.bind(session)
  session.createSessionUpdateEvent = () => withRealtimeTruncation(build())
  session.sendEvent({ type: 'session.update', session: { type: 'realtime', truncation: REALTIME_TRUNCATION } })
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
    sendRealtimeTruncation(session as unknown as SessionUpdates)
    const replies = gateReplies(session as unknown as GatedSession)
    this.#onSession?.(Object.assign(session, { replies }) as unknown as RealtimeEvents)
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
 * An address no connection opens to (TEST-NET-1, RFC 5737): a call test's `--realtime-unreachable` points the model
 * there, so its connection hangs as it did on staging (LIN-634) and the call has to go on without it.
 */
export const REALTIME_UNREACHABLE_URL = 'https://192.0.2.1/v1'

/**
 * Session options for a call answered by a realtime model: no speech to text and no voice provider. The model
 * detects the end of a turn itself (server VAD, REALTIME_TURNS) and transcribes the caller for the call log and summary.
 * `speedPct`: the talking speed in percent, sent as a factor (OpenAI Realtime takes 0.25–1.5); at 100 nothing is sent.
 * `unreachable`: the model is pointed at REALTIME_UNREACHABLE_URL (call-test --realtime-unreachable).
 */
export function createRealtimePipeline({ apiKey, model, voice: voiceName }: RealtimeConfig, silenceFirstGapS = SILENCE_FIRST_GAP_DEFAULT_S, speedPct = TALKING_SPEED_PCT_DEFAULT, languages: CallLanguages = ENGLISH_CALL, onSession?: (session: RealtimeEvents) => void, unreachable = false): voice.AgentSessionOptions {
  return {
    llm: new ObservedRealtimeModel(onSession, {
      apiKey, model, voice: voiceName, turnDetection: REALTIME_TURNS,
      // A connection that does not open in time is given up sooner than LiveKit's 10 s (LIN-634, realtime-connect.ts).
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, timeoutMs: REALTIME_CONNECT_TIMEOUT_MS },
      ...(unreachable ? { baseURL: REALTIME_UNREACHABLE_URL } : {}),
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
  /** `language`: what the on-call person hears and answers in, the assistant's main language (LIN-510). */
  consult: { tts: () => ttsTypes.TTS; stt: AgentConfig['stt']; language: Language }
  onCallVoice: () => ttsTypes.TTS
}

export function transferSpeechOf(config: CallConfig, assistant: LineAssistant, testCallerVoice = process.env.TEST_CALLER_VOICE_ID): TransferSpeech {
  const line = lineVoiceOf(config, assistant)
  const language = mainLanguageOf(assistant?.languages)
  if (!isRealtime(config)) {
    return {
      line,
      consult: { tts: () => createTts(config.tts, assistant?.voice, language), stt: config.stt, language },
      onCallVoice: () => createTts(config.tts, testCallerVoice ? { provider: config.tts.provider, voice_id: testCallerVoice } : null),
    }
  }
  const { realtime, stages } = config
  return {
    line,
    consult: { tts: () => createRealtimeLineTts(realtime), stt: { provider: 'openai_stt', apiKey: realtime.apiKey, model: REALTIME_TRANSCRIPTION }, language },
    // The test caller's voice when the three stages are set up too (as on the three stages), else another realtime voice.
    onCallVoice: stages
      ? transferSpeechOf(stages, assistant, testCallerVoice).onCallVoice
      : () => createRealtimeLineTts({ apiKey: realtime.apiKey, voice: otherRealtimeVoice(realtime.voice) }),
  }
}

/** Where one chat request goes; `zeroDataRetention` (OpenRouter, default on): see noTrainingFields. */
export type ChatModel = { apiKey: string; baseUrl: string; model: string; fallbacks?: string[]; zeroDataRetention?: boolean }

/**
 * The error text of a failed chat request: OpenRouter's "no endpoint" under our privacy routing gets the clear text that
 * names the model and the fix (noPrivateEndpointText), logged as an error; else the provider's own message.
 */
function chatFailure({ baseUrl, model, zeroDataRetention = true }: ChatModel, status: number, message: string): string {
  const clear = noPrivateEndpointText(status, message, baseUrl, model, zeroDataRetention)
  if (clear) console.error(clear)
  return clear ?? message
}

/** CompleteJson backed by an OpenAI-compatible chat completions API. Gives up after `timeoutMs`. */
export function chatJson(chat: ChatModel, doFetch: typeof fetch = fetch, timeoutMs = SUMMARY_TIMEOUT_MS): CompleteJson {
  const { apiKey, baseUrl, model, fallbacks = [], zeroDataRetention = true } = chat
  return async (system, user) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, ...modelsField(model, fallbacks), ...noTrainingFields(baseUrl, zeroDataRetention), response_format: { type: 'json_object' }, ...tokenCap(baseUrl, SUMMARY_MAX_TOKENS),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null
    if (!res.ok) throw new Error(`summary request failed (${res.status}): ${chatFailure(chat, res.status, body?.error?.message ?? res.statusText)}`)
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
  return chatJson({ apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.summaryModel, fallbacks: llm.summaryFallbacks, zeroDataRetention: llm.zeroDataRetention })
}

/**
 * Sends the call's system prompt with a one-token answer while the greeting plays, so the caller's first
 * reply finds an open connection (same process, same fetch pool) and, where the provider caches prompts,
 * a cached prompt. Failures only cost the warm-up: they are logged and otherwise ignored.
 */
export async function warmUpLlm(chat: ChatModel, instructions: string, doFetch: typeof fetch = fetch) {
  const { apiKey, baseUrl, model, zeroDataRetention = true } = chat
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...tokenCap(baseUrl, 1), ...noTrainingFields(baseUrl, zeroDataRetention), messages: [{ role: 'system', content: instructions }, { role: 'user', content: 'Hello?' }] }),
      signal: AbortSignal.timeout(WARM_UP_TIMEOUT_MS),
    })
    // The same model and routing as the call's first reply: a model OpenRouter has no private endpoint for is named here.
    if (res.ok) await res.body?.cancel()
    else {
      chatFailure(chat, res.status, await res.text().catch(() => ''))
      console.warn(`LLM warm-up answered ${res.status}`)
    }
  } catch (e) {
    console.warn(`LLM warm-up failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
