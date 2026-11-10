// Which speech and language providers the agent uses, and with which models and keys.
// Source: the provider settings an admin stored in Linedesk (GET /v1/agent/provider-config),
// stage by stage; for a stage that is not set up there, the agent's own environment.
// `createConfigLoader()` builds the cached loader the worker uses (`loadAgentConfig` in worker.ts).
import { z } from 'zod'

export interface AgentConfig {
  stt: { provider: 'deepgram'; apiKey: string; model: string }
  /** Any OpenAI-compatible chat completions API. Used for the conversation and the call summary. */
  llm: { provider: 'openrouter' | 'openai'; apiKey: string; baseUrl: string; model: string }
  /** `voiceId` is the default voice; an assistant can bring its own for the same provider. */
  tts: { provider: 'elevenlabs' | 'cartesia'; apiKey: string; model?: string; voiceId?: string }
}

type Env = Record<string, string | undefined>

/** A pipeline stage, in the words the business sees (inbox, settings). */
export type Stage = 'speech recognition' | 'language model' | 'voice'

/** The agent cannot take calls. `message` is for the operator's log; `stages` is safe to show the business. */
export class AgentConfigError extends Error {
  readonly stages: Stage[]

  constructor(message: string, stages: Stage[]) {
    super(message)
    this.stages = stages
  }
}

// What the API returns per stage: the active provider with its fields in clear, or null.
const entry = z.object({
  provider: z.string(),
  api_key: z.string().nullish(),
  model: z.string().nullish(),
  voice_id: z.string().nullish(),
}).nullable()
const providerSettings = z.object({ stt: entry, llm: entry, tts: entry })
export type ProviderSettings = z.infer<typeof providerSettings>
type Entry = z.infer<typeof entry>

/** The response of GET /v1/agent/provider-config, checked. Throws without echoing the body (it holds keys). */
export function parseProviderSettings(body: unknown): ProviderSettings {
  const parsed = providerSettings.safeParse(body)
  if (!parsed.success) throw new Error('provider settings from the API have an unexpected shape')
  return parsed.data
}

const stages = {
  stt: { stage: 'speech recognition', providerEnv: 'STT_PROVIDER', fallback: 'deepgram', providers: { deepgram: 'DEEPGRAM_API_KEY' } },
  llm: { stage: 'language model', providerEnv: 'LLM_PROVIDER', fallback: 'openrouter', providers: { openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY' } },
  tts: { stage: 'voice', providerEnv: 'TTS_PROVIDER', fallback: 'elevenlabs', providers: { elevenlabs: 'ELEVENLABS_API_KEY', cartesia: 'CARTESIA_API_KEY' } },
} as const satisfies Record<keyof ProviderSettings, { stage: Stage; providerEnv: string; fallback: string; providers: Record<string, string> }>
type StageKey = keyof typeof stages

const modelEnv = { stt: 'STT_MODEL', llm: 'LLM_MODEL', tts: 'TTS_MODEL' } as const
const llmDefaults = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
} as const

/** One stage from the environment, in the API's shape; the provider is named even when its key is missing. */
function fromEnv(key: StageKey, env: Env): NonNullable<Entry> {
  const spec = stages[key]
  const provider = env[spec.providerEnv] || spec.fallback
  const keyVar = (spec.providers as Record<string, string>)[provider]
  return { provider, api_key: keyVar ? env[keyVar] : undefined, model: env[modelEnv[key]], voice_id: key === 'tts' ? env.TTS_VOICE_ID : undefined }
}

/** What to tell the operator about one stage that cannot be used. Never contains a value. */
function problem(key: StageKey, picked: NonNullable<Entry>, fromApp: boolean): string | null {
  const spec = stages[key]
  const keyVar = (spec.providers as Record<string, string>)[picked.provider]
  if (!keyVar) return `${spec.stage}: unknown provider "${picked.provider}" (use ${Object.keys(spec.providers).join(' or ')})`
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
    throw new AgentConfigError(`Not set up: ${problems.map(([, text]) => text).join('; ')}.`, problems.map(([stage]) => stage))
  }
  const { stt, llm, tts } = picked
  const llmProvider = llm.provider as keyof typeof llmDefaults
  return {
    stt: { provider: 'deepgram', apiKey: stt.api_key!, model: stt.model || 'flux-general-en' },
    llm: {
      provider: llmProvider, apiKey: llm.api_key!,
      // LLM_BASE_URL belongs to an env-configured LLM: a key stored in Linedesk only goes to its provider's own API.
      baseUrl: ((settings?.llm ? undefined : env.LLM_BASE_URL) || llmDefaults[llmProvider].baseUrl).replace(/\/$/, ''),
      model: llm.model || llmDefaults[llmProvider].model,
    },
    tts: { provider: tts.provider as AgentConfig['tts']['provider'], apiKey: tts.api_key!, model: tts.model || undefined, voiceId: tts.voice_id || undefined },
  }
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
export function createConfigLoader({ fetchSettings, env = process.env, ttlMs = SETTINGS_TTL_MS, now = Date.now, log = console.warn }: ConfigLoaderOptions) {
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
        if (problem !== lastProblem) log(`could not read provider settings from the API, using the environment: ${problem}`)
        lastProblem = problem
        return null
      },
    )
  // Calls that arrive together share one request: the pending promise is what gets cached.
  function settings(): Promise<ProviderSettings | null> {
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), settings: fetchOnce() }
    return cached.settings
  }
  return async (): Promise<AgentConfig> => resolveAgentConfig(await settings(), env)
}
