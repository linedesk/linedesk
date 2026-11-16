// Usage levels on Linedesk Cloud (decisions.md 2026-11-16): a call costs 5¢ a minute on the Standard level and 10¢ on
// Premium, the same for every workspace (partners too). A call is Premium when its voice or its language model is in
// the Premium list; options in neither list run only on the workspace's own provider keys. With own keys there is no
// usage fee and no restriction. Self-hosted installs (no billing) use every option, without levels. A call answered by
// a realtime (speech-to-speech) model is Ultra, which needs Allow Ultra (not built yet: no Cloud call is Ultra so far).
// The one source of truth for the lists: the voice picker, the API's checks (assistant.update, call.start) and billing.
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
 * What a call minute costs on each level, in US cents (billed per second). A level without a price here (`not_allowed`,
 * and Ultra until it is priced) never runs: centsPerMinute throws for it.
 */
export const USAGE_CENTS_PER_MINUTE = { standard: 5, premium: 10, own_keys: 0 } as const satisfies Partial<
  Record<UsageLevel, number>
>

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
 * Only the models the agent runs (the LiveKit plugin's RealtimeModels) and Janik put on Ultra: gpt-realtime-mini runs
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

/**
 * What a call uses, as the call starts: the voice (`provider` the voice provider, `model` the text-to-speech model id)
 * and the language model of live turns (`provider` one of llmEndpoints, `model` its id). A call answered by a realtime
 * model passes that model for both (REALTIME_PROVIDER): its level is the realtime model's. `ownKeys`: every part of
 * the call runs on the workspace's own provider keys (a call with any part on Linedesk's keys pays its level's price).
 * `allowPremium`: the owner's "Allow Premium" (workspace_settings.allow_premium); false turns a Premium call into
 * `not_allowed`. `allowUltra`: the owner's "Allow Ultra" (not built yet); anything but true turns an Ultra call into
 * `not_allowed`. `allowPremium` left out: the level by the voice and model alone.
 */
export type UsageLevelInput = {
  voice: { provider: string; model: string }
  model: { provider: string; model: string }
  ownKeys: boolean
  allowPremium?: boolean
  allowUltra?: boolean
}

/**
 * A call's level: own keys first (no fee, no restriction), then not allowed when its voice or model is in neither list
 * (or it is Premium and `allowPremium` is false), then Premium when either is Premium, else Standard. Pure: the level of
 * a whole call is decided once, at call start; a fallback to the backup voice during the call does not change it.
 */
export function usageLevel(input: UsageLevelInput): UsageLevel {
  if (input.ownKeys) return 'own_keys'
  const tier = usageTierOf(input)
  if (!tier) return 'not_allowed'
  if (tier === 'premium' && input.allowPremium === false) return 'not_allowed'
  if (tier === 'ultra' && input.allowUltra !== true) return 'not_allowed'
  return tier
}

/** The level by the voice and model alone, null when either is in no list. A realtime model: its own level. */
function usageTierOf({ voice, model }: Pick<UsageLevelInput, 'voice' | 'model'>): UsageTier | null {
  if (voice.provider === REALTIME_PROVIDER || model.provider === REALTIME_PROVIDER)
    return voice.provider === model.provider && voice.model === model.model ? realtimeModelLevel(model.model) : null
  const v = voiceModelLevel(voice.provider, voice.model)
  const m = languageModelLevel(model.provider, model.model)
  if (!v || !m) return null
  return v === 'premium' || m === 'premium' ? 'premium' : 'standard'
}

/**
 * Why a workspace on Linedesk Cloud may not use these choices, or null when it may: `premiumNotAllowed` (Premium
 * without the owner's "Allow Premium"), `ultraNotAllowed` (a realtime model without "Allow Ultra") or `ownKeysOnly` (an
 * option in no list, without own keys).
 */
export function usageLevelProblem(
  input: Omit<UsageLevelInput, 'allowPremium'> & { allowPremium: boolean },
): 'premiumNotAllowed' | 'ultraNotAllowed' | 'ownKeysOnly' | null {
  if (input.ownKeys) return null
  const tier = usageTierOf(input)
  if (!tier) return 'ownKeysOnly'
  if (tier === 'premium' && !input.allowPremium) return 'premiumNotAllowed'
  if (tier === 'ultra' && input.allowUltra !== true) return 'ultraNotAllowed'
  return null
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

/** One voice or language model an assistant can pick, with its level; `allowed` false: shown, not selectable. */
export type LevelChoice = { id: string; name: string; level: UsageTier; allowed: boolean }

/**
 * What the assistant editor shows of levels (voice.options `levels`). `billed`: this install bills usage (Linedesk
 * Cloud): levels and prices are shown and Allow Premium applies; false (self-hosted): every choice, no labels.
 * `voiceModels` per voice provider set up; `defaultVoiceModel` and `defaultModel`: what "Default" stands for, with
 * its level (null: in neither list).
 */
export type UsageLevelOptions = {
  billed: boolean
  allowPremium: boolean
  /** Allow Ultra: answering with a realtime model. Not built yet: false while billed. */
  allowUltra: boolean
  /** Whether an assistant may answer with a realtime model (`voice_pipeline` realtime): levelAllowed('ultra'). */
  realtimeAllowed: boolean
  ownKeys: boolean
  premiumCentsPerMinute: number
  standardCentsPerMinute: number
  voiceModels: Record<string, LevelChoice[]>
  defaultVoiceModels: Record<string, { id: string; level: UsageTier | null }>
  llmProvider: string | null
  models: LevelChoice[]
  defaultModel: { id: string; level: UsageTier | null } | null
}

/**
 * Whether a choice of this level can be picked: always without billing or with own keys, Premium with Allow Premium,
 * Ultra with Allow Ultra.
 */
export const levelAllowed = (
  level: UsageTier,
  o: Pick<UsageLevelOptions, 'billed' | 'allowPremium' | 'allowUltra' | 'ownKeys'>,
) => !o.billed || o.ownKeys || level === 'standard' || (level === 'premium' ? o.allowPremium : o.allowUltra)
