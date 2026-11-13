// Which speech and language providers the agent uses, and with which models and keys.
// Source: the provider settings an admin stored in Linedesk (GET /v1/agent/provider-config),
// stage by stage; for a stage that is not set up there, the agent's own environment.
// A call is answered either by the three stages (AgentConfig) or by a realtime model (RealtimeCallConfig, which also
// holds the stages when both are set up): `CallConfig` is either; configForAssistant picks the assistant's one.
// `createConfigLoader()` builds the cached loader the worker uses (`loadAgentConfig` in worker.ts).
import {
  type LlmProvider,
  llmEndpoints,
  type PipelinesSetUp,
  pipelineFor,
  VOICE_PIPELINE_LABELS,
  type VoicePipeline,
} from '@linedesk/actions'
import { z } from 'zod'
import { recordingSettings, resolveRecording, type RecordingConfig } from './recording.ts'

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
  }
  /**
   * `voiceId` is the default voice; an assistant can bring its own, also of another provider in
   * `others` (every other voice provider set up with a key).
   */
  tts: TtsConfig & { voiceId?: string; others?: TtsConfig[] }
  /** Where calls are recorded (holds the S3 secret: never log it). Not a stage: `off` does not stop calls. */
  recording: RecordingConfig
}

export type TtsConfig = { provider: 'elevenlabs' | 'cartesia'; apiKey: string; model?: string }
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

export const realtimeDefaults = { model: 'gpt-realtime-mini', voice: 'marin', summaryModel: 'gpt-4.1-mini' } as const

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
    model: z.string().nullish(),
    summary_model: z.string().nullish(),
    voice_id: z.string().nullish(),
    voice: z.string().nullish(),
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
    },
  },
  llm: {
    stage: 'language model',
    providerEnv: 'LLM_PROVIDER',
    fallback: 'openrouter',
    providers: {
      openrouter: 'OPENROUTER_API_KEY',
      openai: 'OPENAI_API_KEY',
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

const modelEnv = { stt: 'STT_MODEL', llm: 'LLM_MODEL', tts: 'TTS_MODEL' } as const
/** The realtime model from the environment: its key switches it on (not OPENAI_API_KEY, which the language model may use). */
const realtimeEnv = {
  apiKey: 'OPENAI_REALTIME_API_KEY',
  model: 'REALTIME_MODEL',
  voice: 'REALTIME_VOICE',
  summaryModel: 'REALTIME_SUMMARY_MODEL',
} as const
/** Every variable the speech, model, voice and realtime stages read; docker-compose.yml passes each to the agent container. */
export const stageEnvVars = [
  ...new Set([
    ...Object.values(stages).flatMap(spec => [spec.providerEnv, ...Object.values(spec.providers)]),
    ...Object.values(modelEnv),
    'SUMMARY_MODEL',
    'TTS_VOICE_ID',
    'LLM_BASE_URL',
    ...Object.values(realtimeEnv),
  ]),
]
/** Each language-model provider's API and default models (lists, first one first: "primary, fallback, ..."). */
export const llmDefaults = llmEndpoints

/** The speech model when none is set: Deepgram's English Flux, ElevenLabs' and OpenAI's streaming models. */
const sttDefaultModels: Record<SttProvider, string> = {
  deepgram: 'flux-general-en',
  elevenlabs_stt: 'scribe_v2_realtime',
  openai_stt: 'gpt-4o-mini-transcribe',
}

/** "a, b , c" → ['a', 'b', 'c']; an empty or missing value is the default list. */
export function modelList(value: string | null | undefined, fallback: readonly string[]): string[] {
  const models = (value ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
  return models.length ? models : [...fallback]
}

/** One stage from the environment, in the API's shape; the provider is named even when its key is missing. */
function fromEnv(key: StageKey, env: Env): NonNullable<Entry> {
  const spec = stages[key]
  const provider = env[spec.providerEnv] || spec.fallback
  const keyVar = (spec.providers as Record<string, string>)[provider]
  return {
    provider,
    api_key: keyVar ? env[keyVar] : undefined,
    model: env[modelEnv[key]],
    summary_model: key === 'llm' ? env.SUMMARY_MODEL : undefined,
    voice_id: key === 'tts' ? env.TTS_VOICE_ID : undefined,
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
  const [model, ...fallbacks] = modelList(llm.model, defaults.models)
  const [summaryModel, ...summaryFallbacks] = modelList(llm.summary_model, defaults.summaryModels)
  // Only OpenRouter takes a fallback list (`models`); another API would reject it.
  const withFallbacks = llmProvider === 'openrouter'
  return {
    stt: {
      provider: stt.provider as SttProvider,
      apiKey: stt.api_key!,
      model: stt.model || sttDefaultModels[stt.provider as SttProvider],
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
    },
    tts: {
      provider: tts.provider as TtsConfig['provider'],
      apiKey: tts.api_key!,
      model: tts.model || undefined,
      voiceId: tts.voice_id || undefined,
      others: (settings?.tts_providers ?? [])
        .filter(p => p.provider !== tts.provider && p.api_key && p.provider in stages.tts.providers)
        .map(p => ({ provider: p.provider as TtsConfig['provider'], apiKey: p.api_key!, model: p.model || undefined })),
    },
    recording: resolveRecording(settings?.recording, env),
  }
}

/** The realtime model connected in Linedesk, else one with OPENAI_REALTIME_API_KEY; null: the three stages answer calls. */
function pickedRealtime(settings: ProviderSettings | null, env: Env): NonNullable<Entry> | null {
  if (settings?.realtime) return settings.realtime
  const apiKey = env[realtimeEnv.apiKey]
  if (!apiKey) return null
  return {
    provider: 'openai_realtime',
    api_key: apiKey,
    model: env[realtimeEnv.model],
    voice: env[realtimeEnv.voice],
    summary_model: env[realtimeEnv.summaryModel],
  }
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
      model: picked.model || realtimeDefaults.model,
      voice: picked.voice || realtimeDefaults.voice,
      summaryModel: picked.summary_model || realtimeDefaults.summaryModel,
    },
    recording: resolveRecording(settings?.recording, env),
    stages,
  }
}

/** The config with another realtime model (a call test comparing models); unchanged without one or without realtime. */
export const withRealtimeModel = (config: CallConfig, model: string | undefined): CallConfig =>
  model && isRealtime(config) ? { ...config, realtime: { ...config.realtime, model } } : config

/** Which pipelines a call config can answer with. */
export const pipelinesOf = (config: CallConfig): PipelinesSetUp => ({
  realtime: isRealtime(config),
  three_stage: stagesOf(config) !== null,
})

/**
 * The config one assistant's call uses: the pipeline it chose (pipelineFor; null: the realtime model when one is set
 * up). When that one is not set up the other answers, with a line in the log: a call never goes unanswered over it.
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
  const fetchOnce = () =>
    fetchSettings().then(
      ok => {
        if (lastProblem) log('provider settings from the API are available again')
        lastProblem = null
        return ok
      },
      (e: unknown) => {
        const problem = e instanceof Error ? e.message : String(e)
        if (problem !== lastProblem)
          log(`could not read provider settings from the API, using the environment: ${problem}`)
        lastProblem = problem
        return null
      },
    )
  // Calls that arrive together share one request: the pending promise is what gets cached.
  function settings(): Promise<ProviderSettings | null> {
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), settings: fetchOnce() }
    return cached.settings
  }
  return async (): Promise<CallConfig> => resolveCallConfig(await settings(), env)
}
