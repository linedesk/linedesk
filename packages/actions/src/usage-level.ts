// Call quality on Linedesk (decision of 2026-11-17): every assistant has one level, Standard, Premium or Ultra, and
// the level alone decides what a call minute costs on Linedesk Cloud ($0.05, $0.10, $0.20 by default, the server's prices).
// Standard runs on Standard models, Premium on Premium and Standard ones, Ultra on a realtime (speech-to-speech) model.
// Options in no list run only on the workspace's own provider keys; with own keys there is no usage fee. Self-hosted
// installs (no billing) have the same three levels, without prices.
// The one source of truth for the lists: the assistant editor, the API's checks (assistant.update, call.start) and billing.
import { LEVEL_PRICES } from '@linedesk/db/types'
import type { LlmProvider } from './admin.ts'

export const USAGE_LEVELS = ['standard', 'premium', 'ultra'] as const
/** A voice's, a model's or a realtime model's level: Standard, Premium or Ultra. */
export type UsageTier = (typeof USAGE_LEVELS)[number]
/**
 * A call's level: `standard` and `premium` on Linedesk's keys, `own_keys` on the workspace's own provider keys (no usage
 * fee), `not_allowed` when its voice or model is in neither list and the workspace has no own keys.
 */
export type UsageLevel = UsageTier | 'own_keys' | 'not_allowed'

/**
 * What a call minute costs on each level, in US cents (billed per second), from the one billing price table
 * (`LEVEL_PRICES` in packages/db/src/billing-config.ts, Linedesk Cloud's defaults). A level without a price here
 * (`not_allowed`) never runs: centsPerMinute throws for it.
 */
export const USAGE_CENTS_PER_MINUTE = {
  standard: LEVEL_PRICES.standard.microsPerMinute / 10_000,
  premium: LEVEL_PRICES.premium.microsPerMinute / 10_000,
  ultra: LEVEL_PRICES.ultra.microsPerMinute / 10_000,
  own_keys: 0,
} as const satisfies Partial<Record<UsageLevel, number>>

/** What a call minute on this level costs, in US cents; throws for a level without a price (a call that must not run). */
export function centsPerMinute(level: UsageLevel): number {
  const cents = (USAGE_CENTS_PER_MINUTE as Partial<Record<UsageLevel, number>>)[level]
  if (cents === undefined) throw new Error(`no price for usage level ${level}: a call on it must not run`)
  return cents
}

/** A voice model (text to speech) with its level. `provider`: the voice provider; `model`: the id sent to it. */
export type LevelVoiceModel = { provider: string; model: string; name: string; level: UsageTier }

/**
 * The voice models with a level. ElevenLabs Flash v2.5 is the default. OpenAI's speech model is the automatic backup
 * voice (a fallback during a call never changes the call's level).
 */
export const VOICE_MODEL_LEVELS: readonly LevelVoiceModel[] = [
  { provider: 'elevenlabs', model: 'eleven_flash_v2_5', name: 'ElevenLabs Flash v2.5', level: 'standard' },
  { provider: 'cartesia', model: 'sonic-3.6', name: 'Cartesia Sonic 3.6', level: 'standard' },
  { provider: 'openai', model: 'gpt-4o-mini-tts', name: 'OpenAI gpt-4o-mini-tts', level: 'standard' },
  { provider: 'elevenlabs', model: 'eleven_multilingual_v2', name: 'ElevenLabs Multilingual v2', level: 'premium' },
  { provider: 'elevenlabs', model: 'eleven_v3', name: 'ElevenLabs v3', level: 'premium' },
]

/**
 * The model each voice provider speaks with when neither the assistant nor the install (TTS_MODEL) picks one. The
 * agent sends it; Cartesia's plugin would otherwise use its own older default (sonic-3).
 */
export const DEFAULT_VOICE_MODELS: Record<string, string> = {
  elevenlabs: 'eleven_flash_v2_5',
  cartesia: 'sonic-3.6',
}

/** A language model with its level and its id at each provider that serves it (`ids`). */
export type LevelLanguageModel = {
  id: string
  name: string
  level: UsageTier
  ids: Partial<Record<LlmProvider, string>>
}

/** The language models for live turns with a level. */
export const LANGUAGE_MODEL_LEVELS: readonly LevelLanguageModel[] = [
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    level: 'standard',
    ids: { openai: 'gpt-5.4-mini', openrouter: 'openai/gpt-5.4-mini' },
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    level: 'standard',
    ids: { openai: 'gpt-4.1-mini', openrouter: 'openai/gpt-4.1-mini' },
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 nano',
    level: 'standard',
    ids: { openai: 'gpt-5.4-nano', openrouter: 'openai/gpt-5.4-nano' },
  },
  {
    id: 'claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    level: 'standard',
    ids: { anthropic: 'claude-haiku-5-5', openrouter: 'anthropic/claude-haiku-5.5' },
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    level: 'standard',
    ids: { gemini: 'gemini-3.5-flash-lite', openrouter: 'google/gemini-3.5-flash-lite' },
  },
  { id: 'llama-3.3-70b', name: 'Llama 3.3 70B (Groq)', level: 'standard', ids: { groq: 'llama-3.3-70b-versatile' } },
  { id: 'mistral-small', name: 'Mistral Small', level: 'standard', ids: { mistral: 'mistral-small-latest' } },
  { id: 'gpt-5.4', name: 'GPT-5.4', level: 'premium', ids: { openai: 'gpt-5.4', openrouter: 'openai/gpt-5.4' } },
  { id: 'gpt-4.1', name: 'GPT-4.1', level: 'premium', ids: { openai: 'gpt-4.1', openrouter: 'openai/gpt-4.1' } },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    level: 'premium',
    ids: { gemini: 'gemini-3.8-flash', openrouter: 'google/gemini-3.8-flash' },
  },
]

/**
 * The realtime (speech-to-speech) models with a level: one hears the caller and answers in its own voice. All Ultra.
 * Only the models the agent runs (the LiveKit plugin's RealtimeModels) and put on Ultra by decision: gpt-realtime-mini runs
 * only on own keys (it got dates wrong, config.ts realtimeDefaults).
 */
export type LevelRealtimeModel = { provider: 'openai_realtime'; model: string; name: string; level: UsageTier }
export const REALTIME_MODEL_LEVELS: readonly LevelRealtimeModel[] = [
  { provider: 'openai_realtime', model: 'gpt-realtime', name: 'GPT Realtime', level: 'ultra' },
  { provider: 'openai_realtime', model: 'gpt-realtime-2', name: 'GPT Realtime 2', level: 'ultra' },
]

/** The provider of realtime models in UsageLevelInput (both `voice` and `model` name it on a realtime call). */
export const REALTIME_PROVIDER = 'openai_realtime'

/** The realtime model's level, or null when it is in no list. */
export function realtimeModelLevel(model: string): UsageTier | null {
  return REALTIME_MODEL_LEVELS.find(m => m.model === model.trim())?.level ?? null
}

/**
 * The realtime model a call answers with: the assistant's own (`realtime_model`) when it is in the list, else the
 * install's (REALTIME_MODEL, Server admin › Providers).
 */
export function realtimeModelFor(assistantModel: string | null | undefined, installModel: string) {
  const own = assistantModel?.trim()
  return own && realtimeModelLevel(own) ? own : installModel
}

/** The voice model's level, or null when it is in neither list. */
export function voiceModelLevel(provider: string, model: string): UsageTier | null {
  return VOICE_MODEL_LEVELS.find(v => v.provider === provider && v.model === model.trim())?.level ?? null
}

/** The language model's level at that provider, or null when it is in neither list. */
export function languageModelLevel(provider: string, model: string): UsageTier | null {
  const id = model.trim()
  return LANGUAGE_MODEL_LEVELS.find(m => m.ids[provider as LlmProvider] === id)?.level ?? null
}

/** The language models a provider serves with a level, in list order. */
export const languageModelsOf = (provider: string) =>
  LANGUAGE_MODEL_LEVELS.flatMap(m => {
    const id = m.ids[provider as LlmProvider]
    return id ? [{ id, name: m.name, level: m.level }] : []
  })

/** The voice models a voice provider has with a level, in list order. */
export const voiceModelsOf = (provider: string) => VOICE_MODEL_LEVELS.filter(v => v.provider === provider)

/** A voice (`provider` the voice provider, `model` the text-to-speech model id) or a language model of live turns. */
export type CallPart = { provider: string; model: string }

/**
 * What a call uses, as the call starts: the voice and the language model of live turns (`provider` one of
 * llmEndpoints). A call answered by a realtime model passes that model for both (REALTIME_PROVIDER).
 */
export type CallParts = { voice: CallPart; model: CallPart }

/**
 * Whether a part of this level belongs to a call quality (decision of 2026-11-17, call quality): Standard holds
 * Standard parts only, Premium Premium and Standard ones (a Premium call may use the fastest Standard voice), Ultra
 * realtime models only. A part in no list belongs to none.
 */
export function partFits(part: UsageTier | null, level: UsageTier): boolean {
  if (!part) return false
  if (level === 'ultra') return part === 'ultra'
  return part === 'standard' || (level === 'premium' && part === 'premium')
}

/** Whether every part of a call belongs to its call quality: a realtime model only on Ultra, the three stages never. */
export function partsFit({ voice, model }: CallParts, level: UsageTier): boolean {
  if (voice.provider === REALTIME_PROVIDER || model.provider === REALTIME_PROVIDER)
    return (
      level === 'ultra' &&
      voice.provider === model.provider &&
      voice.model === model.model &&
      partFits(realtimeModelLevel(model.model), level)
    )
  return (
    partFits(voiceModelLevel(voice.provider, voice.model), level) &&
    partFits(languageModelLevel(model.provider, model.model), level)
  )
}

/**
 * A call as it starts: `level` the assistant's call quality (`assistants.call_quality`), `parts` what answers it,
 * `ownKeys` every part runs on the workspace's own provider keys, `levelEnabled` the server admin has the level on
 * (Server admin › Settings › Calls › Call quality).
 */
export type UsageLevelInput = { level: UsageTier; parts: CallParts; ownKeys: boolean; levelEnabled: boolean }

/**
 * A call's level: the assistant's call quality alone decides it, not the highest of its parts. `not_allowed` for a
 * level the server admin turned off, or a part that does not belong to the level (and no own keys); `own_keys` when
 * every part runs on the workspace's own keys (no fee). Pure: decided once, at call start; a fallback to the backup
 * voice during the call does not change it.
 */
export function usageLevel({ level, parts, ownKeys, levelEnabled }: UsageLevelInput): UsageLevel {
  if (!levelEnabled) return 'not_allowed'
  if (ownKeys) return 'own_keys'
  return partsFit(parts, level) ? level : 'not_allowed'
}

/** The call qualities, cheapest first; a higher index costs more a minute. */
export const CALL_QUALITIES = USAGE_LEVELS
export type CallQuality = UsageTier
/** The levels' names: product names, the same in every language. */
// i18n-ignore: product names, the same in every language
export const CALL_QUALITY_LABELS: Record<CallQuality, string> = {
  standard: 'Standard',
  premium: 'Premium',
  ultra: 'Ultra',
}
/** Whether going from `from` to `to` raises the price: only a workspace owner or admin does that (level-raise.ts in the API). */
export const raisesLevel = (from: CallQuality, to: CallQuality) =>
  CALL_QUALITIES.indexOf(to) > CALL_QUALITIES.indexOf(from)

/**
 * The server's default models of one level: the language model (`llm`, the id at the install's language-model
 * provider), the voice model per voice provider, and speech recognition (`stt`, a model of the install's speech
 * recognition provider, STT_MODELS). Missing: CALL_QUALITY_DEFAULTS, for speech recognition the provider's first.
 */
export type LevelDefaults = { llm?: string; voice?: Record<string, string>; stt?: string }

/**
 * The install's call quality settings (instance_settings `call_quality`, Server admin › Settings › Calls › Call quality):
 * whether Premium and Ultra can be picked (Standard always can), the level new assistants start on, and per level the
 * models an assistant without its own pick uses.
 */
export type CallQualitySettings = {
  premium: boolean
  ultra: boolean
  default: CallQuality
  models: { standard: LevelDefaults; premium: LevelDefaults; ultra: { realtime?: string } }
}

/**
 * The one place of the default models per level (decision of 2026-11-17, call quality): what an install uses until
 * a server admin picks others. Language models by their id in LANGUAGE_MODEL_LEVELS (each provider's own id is looked
 * up), voice models per voice provider. Speech recognition defaults to each provider's first model in STT_MODELS (the
 * models calls used before it was a setting), at every level.
 */
export const CALL_QUALITY_DEFAULTS = {
  standard: {
    llm: 'gpt-4.1-mini',
    voice: { elevenlabs: 'eleven_flash_v2_5', cartesia: 'sonic-3.6', openai: 'gpt-4o-mini-tts' },
  },
  premium: { llm: 'gpt-4.1', voice: { elevenlabs: 'eleven_multilingual_v2' } },
  ultra: { realtime: 'gpt-realtime' },
} as const satisfies {
  standard: { llm: string; voice: Record<string, string> }
  premium: { llm: string; voice: Record<string, string> }
  ultra: { realtime: string }
}

/**
 * The after-call summary's model per language-model provider (first one first, then its fallbacks; decision of
 * 2026-11-18): not a setting, and the same at every level. `openai_realtime`: the chat model a realtime model's key
 * sums up with. Next to the level defaults above, so a change is one small PR here.
 */
export const SUMMARY_MODEL_DEFAULTS = {
  openrouter: ['google/gemini-3.5-flash-lite', 'openai/gpt-5.4-mini'],
  openai: ['gpt-4.1-mini'],
  anthropic: ['claude-sonnet-5-5'],
  gemini: ['gemini-3.5-flash-lite'],
  groq: ['llama-3.3-70b-versatile'],
  mistral: ['mistral-medium-latest'],
  openai_realtime: ['gpt-4.1-mini'],
} as const satisfies Record<
  'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'mistral' | 'openai_realtime',
  readonly [string, ...string[]]
>

/** A fresh install's settings: Premium and Ultra on (Ultra needs a realtime model to be picked), new assistants on Standard. */
export const CALL_QUALITY_INSTALL_DEFAULT: CallQualitySettings = {
  premium: true,
  ultra: true,
  default: 'standard',
  models: { standard: {}, premium: {}, ultra: {} },
}

/**
 * The language model of a level at this provider: the first of `picks` (the assistant's own, then the server admin's
 * default) that belongs to the level, else the level's default (CALL_QUALITY_DEFAULTS) when the provider serves it,
 * else the provider's first model of exactly that level, else its first that belongs to it; null: it has none.
 */
export function levelLanguageModel(
  provider: string,
  level: 'standard' | 'premium',
  ...picks: (string | null | undefined)[]
): string | null {
  for (const pick of picks) {
    const id = pick?.trim()
    if (id && partFits(languageModelLevel(provider, id), level)) return id
  }
  const preset = LANGUAGE_MODEL_LEVELS.find(m => m.id === CALL_QUALITY_DEFAULTS[level].llm)?.ids[
    provider as LlmProvider
  ]
  if (preset) return preset
  const models = languageModelsOf(provider)
  return (models.find(m => m.level === level) ?? models.find(m => partFits(m.level, level)))?.id ?? null
}

/** The voice model of a level for this voice provider, chosen like levelLanguageModel; null: the provider has none. */
export function levelVoiceModel(
  provider: string,
  level: 'standard' | 'premium',
  ...picks: (string | null | undefined)[]
): string | null {
  for (const pick of picks) {
    const id = pick?.trim()
    if (id && partFits(voiceModelLevel(provider, id), level)) return id
  }
  const preset = (CALL_QUALITY_DEFAULTS[level].voice as Record<string, string>)[provider]
  if (preset) return preset
  const models = voiceModelsOf(provider)
  return (models.find(m => m.level === level) ?? models.find(m => partFits(m.level, level)))?.model ?? null
}

/** Ultra's realtime model: the first of `picks` that an assistant can pick, else the default (CALL_QUALITY_DEFAULTS). */
export function levelRealtimeModel(...picks: (string | null | undefined)[]): string {
  for (const pick of picks) {
    const id = pick?.trim()
    if (id && realtimeModelLevel(id)) return id
  }
  return CALL_QUALITY_DEFAULTS.ultra.realtime
}

/** One model an assistant or the server admin can pick within a level. */
export type ModelChoice = { id: string; name: string }

/** The language models of a level at this provider, in list order. */
export const levelLanguageModelsOf = (provider: string, level: CallQuality): ModelChoice[] =>
  languageModelsOf(provider)
    .filter(m => partFits(m.level, level))
    .map(m => ({ id: m.id, name: m.name }))
/** The voice models of a level for this voice provider, in list order. */
export const levelVoiceModelsOf = (provider: string, level: CallQuality): ModelChoice[] =>
  voiceModelsOf(provider)
    .filter(m => partFits(m.level, level))
    .map(m => ({ id: m.model, name: m.name }))
/**
 * The speech recognition models a server admin can pick per level (Server admin › Settings › Calls › Call quality), per
 * speech recognition provider; the first is its default. Speech recognition has no price of its own: every model fits
 * every level of the three stages. The agent knows how to stream each (apps/agent/src/pipeline.ts, createStt).
 */
// i18n-ignore: product names, the same in every language
export const STT_MODELS: Record<string, readonly [ModelChoice, ...ModelChoice[]]> = {
  deepgram: [
    { id: 'flux-general-en', name: 'Deepgram Flux' },
    { id: 'nova-3', name: 'Deepgram Nova-3' },
  ],
  elevenlabs_stt: [{ id: 'scribe_v2_realtime', name: 'ElevenLabs Scribe v2 Realtime' }],
  openai_stt: [
    { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe' },
    { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe' },
  ],
  assemblyai_stt: [
    { id: 'universal-3-6-pro', name: 'AssemblyAI Universal-3 Pro' },
    { id: 'universal-streaming-multilingual', name: 'AssemblyAI Universal Streaming' },
  ],
}
/** The speech recognition models of this provider (none for one Linedesk does not know). */
export const levelSttModelsOf = (provider: string): ModelChoice[] => [...(STT_MODELS[provider] ?? [])]
/** Whether this provider streams this speech recognition model (STT_MODELS). */
export const sttModelFits = (provider: string, id: string | null | undefined) =>
  !!id && levelSttModelsOf(provider).some(m => m.id === id)
/** The speech recognition model a level hears with at this provider: the first of `picks` it has, else its first; null: an unknown provider. */
export function levelSttModel(provider: string, ...picks: (string | null | undefined)[]): string | null {
  for (const pick of picks) if (sttModelFits(provider, pick?.trim())) return pick!.trim()
  return STT_MODELS[provider]?.[0].id ?? null
}

/** The realtime models (all Ultra). */
export const levelRealtimeModelsOf = (): ModelChoice[] =>
  REALTIME_MODEL_LEVELS.map(m => ({ id: m.model, name: m.name }))

/** A model's name for people ("GPT-4.1 mini"), or its id when it is in no list. */
export function modelName(kind: 'llm' | 'voice' | 'realtime' | 'stt', provider: string, id: string): string {
  if (kind === 'stt') return STT_MODELS[provider]?.find(m => m.id === id)?.name ?? id
  if (kind === 'realtime') return REALTIME_MODEL_LEVELS.find(m => m.model === id)?.name ?? id
  if (kind === 'voice') return VOICE_MODEL_LEVELS.find(v => v.provider === provider && v.model === id)?.name ?? id
  return LANGUAGE_MODEL_LEVELS.find(m => m.ids[provider as LlmProvider] === id)?.name ?? id
}

/**
 * One call quality as the assistant editor shows it (voice.options `callQuality`): its price a minute in US cents
 * (null: no prices here, a white-label client, a workspace on no bill or an install that does not bill), the models
 * that belong to it and what "Default" stands for. Standard and Premium: language models (of the install's provider)
 * and voice models per voice provider set up; Ultra: realtime models.
 */
export type CallQualityLevelOption = {
  level: CallQuality
  centsPerMinute: number | null
  models: ModelChoice[]
  voiceModels: Record<string, ModelChoice[]>
  realtimeModels: ModelChoice[]
  defaults: { llm: string | null; voice: Record<string, string>; realtime: string | null }
}

/**
 * What the assistant editor shows of call quality (voice.options `callQuality`): the levels the server admin has on
 * (Standard always), the level new assistants start on, whether this member may change it at all (`mayChange`: false
 * for a white-label client's people while the partner keeps it, and the editor then shows no call quality) and raise
 * an assistant to a paid level (`mayRaise`: a workspace owner or admin, decision of 2026-11-18), and whether the
 * workspace is a white-label client.
 */
export type CallQualityOptions = {
  levels: CallQualityLevelOption[]
  defaultLevel: CallQuality
  mayChange: boolean
  mayRaise: boolean
  partnerManaged: boolean
  llmProvider: string | null
}

/**
 * The text-to-speech model a call speaks with: the assistant's own (`voice.model`) when it is one of the voice
 * provider's models with a level, else the install's (TTS_MODEL, Server admin › Providers), else the provider's
 * default (DEFAULT_VOICE_MODELS). A model of another provider (the voice provider changed since) is not used.
 */
export function voiceModelFor(
  provider: string,
  assistantModel: string | null | undefined,
  installModel?: string | null,
) {
  const own = assistantModel?.trim()
  if (own && voiceModelLevel(provider, own)) return own
  return installModel?.trim() || DEFAULT_VOICE_MODELS[provider] || ''
}

/**
 * The language model of a call's live turns: the assistant's own (`llm_model`) when the install's provider serves it
 * with a level, else the install's model (the first of its list, "model, fallback"), else the provider's default.
 */
export function languageModelFor(provider: string, assistantModel: string | null | undefined, installModel: string) {
  const own = assistantModel?.trim()
  return own && languageModelLevel(provider, own) ? own : installModel
}
