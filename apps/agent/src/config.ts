// Which speech and language providers the agent uses, and with which keys.
// Source: the provider settings an admin stored in Linedesk (GET /v1/agent/provider-config),
// stage by stage; for a stage that is not set up there, the agent's own environment. A provider holds only its key
// (decisions.md 2026-11-18): the models come from the call's level (call.start names them on the assistant), else
// the provider's defaults here; the voice from the assistant, else the provider's default voice.
// A call is answered either by the three stages (AgentConfig) or by a realtime model (RealtimeCallConfig, which also
// holds the stages when both are set up): `CallConfig` is either; configForAssistant picks the assistant's one.
// `createConfigLoader()` builds the cached loader the worker uses (`loadAgentConfig` in worker.ts).
import {
  type CallQuality,
  type LlmProvider,
  languageModelFor,
  languageModelLevel,
  levelSttModel,
  llmEndpoints,
  type PipelinesSetUp,
  pipelineFor,
  REALTIME_DEFAULT_VOICE,
  realtimeModelFor,
  realtimeVoiceFor,
  SUMMARY_MODEL_DEFAULTS,
  type UsageLevel,
  VOICE_PIPELINE_LABELS,
  type VoicePipeline,
  zeroDataRetentionOn,
} from '@linedesk/actions'
import { z } from 'zod'
import { type RecordingConfig, recordingSettings, resolveRecording } from './recording.ts'

export interface AgentConfig {
  stt: { provider: SttProvider; apiKey: string; model: string }
  /**
   * Any OpenAI-compatible chat completions API: `model` for the conversation, `summaryModel` for the call
   * summary. `fallbacks` are tried by OpenRouter when the model fails (a rate limit, a provider outage);
   * other providers get none.
   */
  llm: {
    provider: LlmProvider
    apiKey: string
    baseUrl: string
    model: string
    fallbacks: string[]
    summaryModel: string
    summaryFallbacks: string[]
    /**
     * OpenRouter only: route to zero-data-retention endpoints (noTrainingFields). On unless the instance admin turned
     * it off; providers that train are excluded either way.
     */
    zeroDataRetention: boolean
  }
  /**
   * The voice provider in use; an assistant brings its own voice, also of another provider in `others` (every other
   * voice provider set up with a key). Without one: the provider's default voice (providerDefaultVoices).
   */
  tts: TtsConfig & { others?: TtsConfig[]; openAiBackup?: OpenAiVoiceBackup }
  /** Where calls are recorded (holds the S3 secret: never log it). Not a stage: `off` does not stop calls. */
  recording: RecordingConfig
}

export type TtsConfig = { provider: 'elevenlabs' | 'cartesia'; apiKey: string; model?: string }
/** OpenAI's speech model as the backup voice of the three stages (createTts): an OpenAI key set up for anything, and a voice. */
export type OpenAiVoiceBackup = { apiKey: string; voice: string }
export type SttProvider = keyof (typeof stages)['stt']['providers']

/** A speech-to-speech model: hears the caller and answers in its own voice. The summary goes to OpenAI's chat API with the same key. */
export type RealtimeConfig = {
  provider: 'openai_realtime'
  apiKey: string
  model: string
  voice: string
  summaryModel: string
}

/**
 * Calls answered by a realtime model. `stages` are the three stages when they are set up too: the call test's
 * own caller and the simulated on-call person still talk through them. A realtime call's transfer speaks and hears with
 * OpenAI's models on the realtime key (transferSpeechOf), so it does not need them.
 */
export type RealtimeCallConfig = { realtime: RealtimeConfig; recording: RecordingConfig; stages: AgentConfig | null }
export type CallConfig = AgentConfig | RealtimeCallConfig
export const isRealtime = (config: CallConfig): config is RealtimeCallConfig => 'realtime' in config
/** The three stages of either kind of config, or null when a realtime model answers and they are not set up. */
export const stagesOf = (config: CallConfig): AgentConfig | null => (isRealtime(config) ? config.stages : config)

/**
 * gpt-realtime, not gpt-realtime-mini: mini turned weekdays into the wrong date (Wednesday into Thursday the 19th), also
 * with every date written out in the prompt; gpt-realtime got them right, ~0.3 s slower and ~4.5x the cost per minute
 * (LIN-92 follow-up, staging comparison 2026-11-13). The Ultra level's realtime model (Server admin › Providers › Call
 * quality) picks another for a call; the voice is the assistant's.
 */
export const realtimeDefaults = {
  model: 'gpt-realtime',
  voice: REALTIME_DEFAULT_VOICE,
  summaryModel: SUMMARY_MODEL_DEFAULTS.openai_realtime[0],
} as const

type Env = Record<string, string | undefined>

/** A pipeline stage, in the words the business sees (inbox, settings). */
export type Stage = 'speech recognition' | 'language model' | 'voice' | 'realtime model'

/** The agent cannot take calls. `message` is for the operator's log; `stages` is safe to show the business. */
export class AgentConfigError extends Error {
  readonly stages: Stage[]

  constructor(message: string, stages: Stage[]) {
    super(message)
    this.stages = stages
  }
}

// What the API returns per stage: the active provider with its fields in clear, or null.
const entry = z
  .object({
    provider: z.string(),
    api_key: z.string().nullish(),
    zero_data_retention: z.string().nullish(),
  })
  .nullable()
// `recording` is missing from an API older than the agent: the environment applies then.
// `tts_providers` is missing from an API older than the agent: only the active voice provider then.
// `realtime` is missing from an API older than the agent: the environment applies then.
const providerSettings = z.object({
  stt: entry,
  llm: entry,
  tts: entry,
  realtime: entry.optional(),
  recording: recordingSettings,
  tts_providers: z.array(entry.unwrap()).optional(),
})
export type ProviderSettings = z.infer<typeof providerSettings>
type Entry = z.infer<typeof entry>

/** The response of GET /v1/agent/provider-config, checked. Throws without echoing the body (it holds keys). */
export function parseProviderSettings(body: unknown): ProviderSettings {
  const parsed = providerSettings.safeParse(body)
  if (!parsed.success) throw new Error('provider settings from the API have an unexpected shape')
  return parsed.data
}

const stages = {
  stt: {
    stage: 'speech recognition',
    providerEnv: 'STT_PROVIDER',
    fallback: 'deepgram',
    providers: {
      deepgram: 'DEEPGRAM_API_KEY',
      elevenlabs_stt: 'ELEVENLABS_STT_API_KEY',
      openai_stt: 'OPENAI_STT_API_KEY',
      assemblyai_stt: 'ASSEMBLYAI_STT_API_KEY',
    },
  },
  llm: {
    stage: 'language model',
    providerEnv: 'LLM_PROVIDER',
    fallback: 'openai',
    providers: {
      openai: 'OPENAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
      groq: 'GROQ_API_KEY',
      mistral: 'MISTRAL_API_KEY',
    },
  },
  tts: {
    stage: 'voice',
    providerEnv: 'TTS_PROVIDER',
    fallback: 'elevenlabs',
    providers: { elevenlabs: 'ELEVENLABS_API_KEY', cartesia: 'CARTESIA_API_KEY' },
  },
} as const satisfies Record<
  'stt' | 'llm' | 'tts',
  { stage: Stage; providerEnv: string; fallback: string; providers: Record<string, string> }
>
type StageKey = keyof typeof stages

/** The realtime model from the environment: its key switches it on (not OPENAI_API_KEY, which the language model may use). */
const realtimeEnv = { apiKey: 'OPENAI_REALTIME_API_KEY' } as const
/** Every variable the speech, model, voice and realtime stages read; docker-compose.yml passes each to the agent container. */
export const stageEnvVars = [
  ...new Set([
    ...Object.values(stages).flatMap(spec => [spec.providerEnv, ...Object.values(spec.providers)]),
    'LLM_BASE_URL',
    'OPENROUTER_ZERO_DATA_RETENTION',
    ...Object.values(realtimeEnv),
  ]),
]
/** Each language-model provider's API and default models (lists, first one first: "primary, fallback, ..."). */
export const llmDefaults = llmEndpoints

/** One stage from the environment, in the API's shape; the provider is named even when its key is missing. */
function fromEnv(key: StageKey, env: Env): NonNullable<Entry> {
  const spec = stages[key]
  const provider = env[spec.providerEnv] || spec.fallback
  const keyVar = (spec.providers as Record<string, string>)[provider]
  return {
    provider,
    api_key: keyVar ? env[keyVar] : undefined,
    zero_data_retention: key === 'llm' ? env.OPENROUTER_ZERO_DATA_RETENTION : undefined,
  }
}

/** What to tell the operator about one stage that cannot be used. Never contains a value. */
function problem(key: StageKey, picked: NonNullable<Entry>, fromApp: boolean): string | null {
  const spec = stages[key]
  const keyVar = (spec.providers as Record<string, string>)[picked.provider]
  if (!keyVar)
    return `${spec.stage}: unknown provider "${picked.provider}" (use one of ${Object.keys(spec.providers).join(', ')})`
  if (picked.api_key) return null
  return `${spec.stage}: no API key for ${picked.provider} (${fromApp ? 'set it in Linedesk under Providers' : `set it in Linedesk under Providers, or ${keyVar} in .env`})`
}

/**
 * The effective config from the stored settings (may be null: none or not reachable) and the environment.
 * A stage set up in Linedesk wins; otherwise the environment is used. Throws AgentConfigError naming every stage that is missing.
 */
export function resolveAgentConfig(settings: ProviderSettings | null, env: Env = process.env): AgentConfig {
  const picked = {} as Record<StageKey, NonNullable<Entry>>
  const problems: [Stage, string][] = []
  for (const key of Object.keys(stages) as StageKey[]) {
    const stored = settings?.[key]
    picked[key] = stored ?? fromEnv(key, env)
    const issue = problem(key, picked[key], Boolean(stored))
    if (issue) problems.push([stages[key].stage, issue])
  }
  if (problems.length) {
    throw new AgentConfigError(
      `Not set up: ${problems.map(([, text]) => text).join('; ')}.`,
      problems.map(([stage]) => stage),
    )
  }
  const { stt, llm, tts } = picked
  const llmProvider = llm.provider as keyof typeof llmDefaults
  const defaults = llmDefaults[llmProvider]
  const [model, ...fallbacks] = defaults.models
  const [summaryModel, ...summaryFallbacks] = defaults.summaryModels
  // Only OpenRouter takes a fallback list (`models`); another API would reject it.
  const withFallbacks = llmProvider === 'openrouter'
  return {
    stt: {
      provider: stt.provider as SttProvider,
      apiKey: stt.api_key!,
      // The provider's default speech model (STT_MODELS, first); a call hears with its level's (withSttModel).
      model: levelSttModel(stt.provider as SttProvider)!,
    },
    llm: {
      provider: llmProvider,
      apiKey: llm.api_key!,
      // LLM_BASE_URL belongs to an env-configured LLM: a key stored in Linedesk only goes to its provider's own API.
      baseUrl: ((settings?.llm ? undefined : env.LLM_BASE_URL) || defaults.baseUrl).replace(/\/$/, ''),
      model: model!,
      fallbacks: withFallbacks ? fallbacks : [],
      summaryModel: summaryModel!,
      summaryFallbacks: withFallbacks ? summaryFallbacks : [],
      zeroDataRetention: zeroDataRetentionOn(llm.zero_data_retention),
    },
    tts: {
      provider: tts.provider as TtsConfig['provider'],
      apiKey: tts.api_key!,
      others: (settings?.tts_providers ?? [])
        .filter(p => p.provider !== tts.provider && p.api_key && p.provider in stages.tts.providers)
        .map(p => ({ provider: p.provider as TtsConfig['provider'], apiKey: p.api_key! })),
      ...withOpenAiBackup(openAiVoiceBackup(settings, env)),
    },
    recording: resolveRecording(settings?.recording, env),
  }
}

const withOpenAiBackup = (backup: OpenAiVoiceBackup | null) => (backup ? { openAiBackup: backup } : {})

/**
 * The backup voice when the voice provider fails during a call (quota used up, refused key, outage): OpenAI's speech
 * model with an OpenAI key that is set up anyway (the realtime model's first, then OpenAI transcription or language
 * model, then OPENAI_API_KEY), in the default realtime voice. null: no OpenAI key anywhere.
 */
export function openAiVoiceBackup(settings: ProviderSettings | null, env: Env = process.env): OpenAiVoiceBackup | null {
  const realtime = settings?.realtime?.provider === 'openai_realtime' ? settings.realtime : null
  const apiKey =
    realtime?.api_key ||
    env[realtimeEnv.apiKey] ||
    (settings?.stt?.provider === 'openai_stt' ? settings.stt.api_key : null) ||
    (settings?.llm?.provider === 'openai' ? settings.llm.api_key : null) ||
    env.OPENAI_API_KEY
  if (!apiKey) return null
  return { apiKey, voice: realtimeDefaults.voice }
}

/** The realtime model connected in Linedesk, else one with OPENAI_REALTIME_API_KEY; null: the three stages answer calls. */
function pickedRealtime(settings: ProviderSettings | null, env: Env): NonNullable<Entry> | null {
  if (settings?.realtime) return settings.realtime
  const apiKey = env[realtimeEnv.apiKey]
  if (!apiKey) return null
  return { provider: 'openai_realtime', api_key: apiKey }
}

/** The three stages, or null when one of them is not set up. */
function stagesOrNull(settings: ProviderSettings | null, env: Env): AgentConfig | null {
  try {
    return resolveAgentConfig(settings, env)
  } catch (e) {
    if (!(e instanceof AgentConfigError)) throw e
    return null
  }
}

/** Why a connected realtime model cannot be used, or null. Never contains a value. */
function realtimeProblem(picked: NonNullable<Entry>, fromApp: boolean): string | null {
  if (picked.provider !== 'openai_realtime')
    return `realtime model: unknown provider "${picked.provider}" (use openai_realtime)`
  if (picked.api_key) return null
  const where = fromApp
    ? 'set it in Linedesk under Providers'
    : `set it in Linedesk under Providers, or ${realtimeEnv.apiKey} in .env`
  return `realtime model: no API key for OpenAI Realtime (${where})`
}

/**
 * Everything set up for business calls: the realtime model when one is connected (with the three stages when they are
 * set up too), else the three stages (resolveAgentConfig). Which of them a call uses is its assistant's
 * (configForAssistant). A realtime model that cannot be used leaves the three stages when they are set up.
 * Throws AgentConfigError.
 */
export function resolveCallConfig(settings: ProviderSettings | null, env: Env = process.env): CallConfig {
  const picked = pickedRealtime(settings, env)
  if (!picked) return resolveAgentConfig(settings, env)
  const stages = stagesOrNull(settings, env)
  const problem = realtimeProblem(picked, Boolean(settings?.realtime))
  if (problem) {
    if (stages) return stages
    throw new AgentConfigError(`Not set up: ${problem}.`, ['realtime model'])
  }
  return {
    realtime: {
      provider: 'openai_realtime',
      apiKey: picked.api_key!,
      model: realtimeDefaults.model,
      voice: realtimeDefaults.voice,
      summaryModel: realtimeDefaults.summaryModel,
    },
    recording: resolveRecording(settings?.recording, env),
    stages,
  }
}

/** The config with another realtime model (a call test comparing models); unchanged without one or without realtime. */
export const withRealtimeModel = (config: CallConfig, model: string | undefined): CallConfig =>
  model && isRealtime(config) ? { ...config, realtime: { ...config.realtime, model } } : config

/**
 * The config with the assistant's own realtime model (`assistants.realtime_model`, Settings › Assistant › General, Ultra
 * on Linedesk Cloud) when a realtime model answers and the model is in the list (realtimeModelFor); else the install's.
 * The call test's `--realtime-model` (withRealtimeModel) still wins over it.
 */
export const withAssistantRealtimeModel = (config: CallConfig, assistantModel: string | null | undefined): CallConfig =>
  isRealtime(config)
    ? { ...config, realtime: { ...config.realtime, model: realtimeModelFor(assistantModel, config.realtime.model) } }
    : config

/**
 * The config with the assistant's own realtime voice (`assistants.realtime_voice`, Settings › Assistant › Voice) when
 * a realtime model answers: the session is opened with it (session.update voice) and the fixed lines are said in it.
 * '' or a voice that is not a realtime one: the server's default voice (`realtime.voice`). The Realtime API fixes the
 * voice once the model has spoken in a session, so it is set here, before the call starts, and never changed during it.
 * Unchanged for the three stages, which speak with `assistants.voice`.
 */
export const withAssistantRealtimeVoice = (
  config: CallConfig,
  assistantVoice: string | null | undefined,
): CallConfig =>
  isRealtime(config)
    ? { ...config, realtime: { ...config.realtime, voice: realtimeVoiceFor(assistantVoice, config.realtime.voice) } }
    : config

/**
 * The config with the assistant's own language model (`assistants.llm_model`, Settings › Assistant › Voice) for live
 * turns, when the install's provider serves it (languageModelFor); else the install's model. OpenRouter keeps the
 * install's fallbacks after it. The summary model stays the install's.
 */
export function withAssistantModel(config: CallConfig, llmModel: string | null | undefined): CallConfig {
  const stages = stagesOf(config)
  if (!stages) return config
  const model = languageModelFor(stages.llm.provider, llmModel, stages.llm.model)
  if (model === stages.llm.model) return config
  const own: AgentConfig = {
    ...stages,
    llm: { ...stages.llm, model, fallbacks: [stages.llm.model, ...stages.llm.fallbacks].filter(m => m !== model) },
  }
  return isRealtime(config) ? { ...config, stages: own } : own
}

/**
 * The config with the speech recognition model of the call's level (Server admin › Providers › Call quality; call.start
 * `sttModel`), when the install's speech recognition provider streams it (STT_MODELS); else the provider's default.
 */
export function withSttModel(config: CallConfig, sttModel: string | null | undefined): CallConfig {
  const stages = stagesOf(config)
  if (!stages) return config
  const model = levelSttModel(stages.stt.provider, sttModel, stages.stt.model)
  if (!model || model === stages.stt.model) return config
  const own: AgentConfig = { ...stages, stt: { ...stages.stt, model } }
  return isRealtime(config) ? { ...config, stages: own } : own
}

/**
 * Linedesk Cloud: the install's fallback language models a call may use at its level. A Standard call keeps only
 * Standard ones, a Premium call Standard and Premium ones; a model in neither list never answers a priced call (the
 * API names it in an ALERT). No level (self-hosted) or the workspace's own keys: every fallback stays.
 */
export function withLevelFallbacks(config: CallConfig, level: UsageLevel | null | undefined, log: (line: string) => void = () => {}): CallConfig {
  const stages = stagesOf(config)
  if (!stages || (level !== 'standard' && level !== 'premium')) return config
  const fits = (m: string) => {
    const of = languageModelLevel(stages.llm.provider, m)
    return of === 'standard' || (of === 'premium' && level === 'premium')
  }
  const kept = stages.llm.fallbacks.filter(fits)
  if (kept.length === stages.llm.fallbacks.length) return config
  log(`fallback language models dropped on a ${level} call: ${stages.llm.fallbacks.filter(m => !fits(m)).join(', ')}`)
  const own: AgentConfig = { ...stages, llm: { ...stages.llm, fallbacks: kept } }
  return isRealtime(config) ? { ...config, stages: own } : own
}

/** Which pipelines a call config can answer with. */
export const pipelinesOf = (config: CallConfig): PipelinesSetUp => ({
  realtime: isRealtime(config),
  three_stage: stagesOf(config) !== null,
})

/**
 * The pipeline an assistant's call answers with, by the call quality the API decided for this call (call.start names
 * it on the assistant, decisions.md 2026-11-17): Ultra a realtime model, Standard and Premium the three stages. No
 * assistant (or none named): null, the install's default.
 */
export const pipelineOfAssistant = (assistant: { call_quality?: CallQuality | null } | null | undefined): VoicePipeline | null =>
  assistant?.call_quality ? (assistant.call_quality === 'ultra' ? 'realtime' : 'three_stage') : null

/**
 * The config one assistant's call uses: the pipeline of its call quality (pipelineOfAssistant; null: the realtime model
 * when one is set up). When that one is not set up the other answers, with a line in the log: a call never goes
 * unanswered over it (the API already falls back on an install that bills, so this is for one that does not).
 */
export function configForAssistant(
  config: CallConfig,
  choice: VoicePipeline | null | undefined,
  log: (line: string) => void = console.warn,
): CallConfig {
  const picked = pipelineFor(choice, pipelinesOf(config))
  if (choice && picked !== choice) {
    log(
      `assistant set to "${VOICE_PIPELINE_LABELS[choice]}", which is not set up: "${VOICE_PIPELINE_LABELS[picked]}" takes the call`,
    )
  }
  return picked === 'three_stage' ? (stagesOf(config) ?? config) : config
}

/** The environment alone, for scripts and tests that run without the API. */
export const configFromEnv = async (env: Env = process.env) => resolveAgentConfig(null, env)

export interface ConfigLoaderOptions {
  /** Reads the stored settings from the API. */
  fetchSettings: () => Promise<ProviderSettings>
  env?: Env
  /** How long fetched settings (or a failure to fetch them) are reused. */
  ttlMs?: number
  now?: () => number
  log?: (line: string) => void
}

/** Settings are read at most once per TTL; a change in the admin area reaches the next call after that. */
export const SETTINGS_TTL_MS = 30_000

/**
 * A `loadAgentConfig` that asks the API, caches the answer for `ttlMs`, and falls back to the
 * environment when the API cannot be reached. Logs a failure once, not on every call, and never a value.
 */
export function createConfigLoader({
  fetchSettings,
  env = process.env,
  ttlMs = SETTINGS_TTL_MS,
  now = Date.now,
  log = console.warn,
}: ConfigLoaderOptions): () => Promise<CallConfig> {
  let cached: { at: number; settings: Promise<ProviderSettings | null> } | undefined
  let lastProblem: string | null = null
  // A slow or failing API keeps the last settings read: the environment may no longer hold the keys.
  let lastGood: ProviderSettings | null = null
  const fetchOnce = () =>
    fetchSettings().then(
      ok => {
        if (lastProblem) log('provider settings from the API are available again')
        lastProblem = null
        lastGood = ok
        return ok
      },
      (e: unknown) => {
        const problem = e instanceof Error ? e.message : String(e)
        const using = lastGood ? 'the last settings read' : 'the environment'
        if (problem !== lastProblem) log(`could not read provider settings from the API, using ${using}: ${problem}`)
        lastProblem = problem
        return lastGood
      },
    )
  // Calls that arrive together share one request: the pending promise is what gets cached.
  function settings(): Promise<ProviderSettings | null> {
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), settings: fetchOnce() }
    return cached.settings
  }
  return async (): Promise<CallConfig> => resolveCallConfig(await settings(), env)
}

// --- White-label own keys (S7, docs/white-label.md) ---------------------------------------------------------------

// GET /v1/agent/call-provider-config?callId=…: the partner's own key per stage, for one call only. Never cached.
const partnerSettings = z.object({
  stt: entry.optional(),
  llm: entry.optional(),
  tts: entry.optional(),
  realtime: entry.optional(),
})
export type PartnerSettings = z.infer<typeof partnerSettings>

/** The response of the per-call route, checked. Throws without echoing the body (it holds keys). */
export function parsePartnerSettings(body: unknown): PartnerSettings {
  const parsed = partnerSettings.safeParse(body)
  if (!parsed.success) throw new Error('partner provider settings from the API have an unexpected shape')
  return parsed.data
}

/**
 * The call's config on the partner's own keys alone: never the environment's keys and never another provider of the
 * install (no backup voice of the install, no voice of another provider): every stage that answers is the partner's,
 * so `keySources` can say so. A backup voice is OpenAI's only when the partner's own OpenAI key is among its stages.
 * `recording` stays the install's (not a key the price covers). Null when the partner's keys do not cover the
 * pipeline the call asked for: the call then runs on the install's config and is billed.
 */
export function partnerCallConfig(
  partner: PartnerSettings,
  recording: RecordingConfig,
  pipeline: VoicePipeline | null,
): {
  config: CallConfig
  keySources: { stt?: 'partner'; llm?: 'partner'; tts?: 'partner'; realtime?: 'partner' }
} | null {
  const settings: ProviderSettings = {
    stt: partner.stt ?? null,
    llm: partner.llm ?? null,
    tts: partner.tts ?? null,
    realtime: partner.realtime ?? null,
    recording: null,
    tts_providers: partner.tts ? [partner.tts] : [],
  }
  const noEnv: Env = {}
  if (pipeline === 'realtime') {
    if (!partner.realtime?.api_key) return null
    let config: CallConfig
    try {
      config = resolveCallConfig(settings, noEnv)
    } catch (e) {
      if (e instanceof AgentConfigError) return null
      throw e
    }
    if (!isRealtime(config)) return null
    // The three stages of a realtime call are used only by the call test's caller and the simulated on-call person.
    return { config: { ...config, recording, stages: null }, keySources: { realtime: 'partner' } }
  }
  const stages = stagesOrNull({ ...settings, realtime: null }, noEnv)
  if (!stages) return null
  return { config: { ...stages, recording }, keySources: { stt: 'partner', llm: 'partner', tts: 'partner' } }
}
