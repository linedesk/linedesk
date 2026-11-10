// Which speech and language providers the agent uses, and with which models and keys.
// One function returns the effective config. It reads the environment today; when provider
// settings move into the database, only `loadAgentConfig` changes its source.

export interface AgentConfig {
  stt: { provider: 'deepgram'; apiKey: string; model: string }
  /** Any OpenAI-compatible chat completions API. Used for the conversation and the call summary. */
  llm: { provider: 'openrouter' | 'openai'; apiKey: string; baseUrl: string; model: string }
  /** `voiceId` is the default voice; an assistant can bring its own for the same provider. */
  tts: { provider: 'elevenlabs' | 'cartesia'; apiKey: string; model?: string; voiceId?: string }
}

type Env = Record<string, string | undefined>

const llmProviders = {
  openrouter: { key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini' },
  openai: { key: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
} as const
const ttsProviders = { elevenlabs: { key: 'ELEVENLABS_API_KEY' }, cartesia: { key: 'CARTESIA_API_KEY' } } as const
const STT_KEY = 'DEEPGRAM_API_KEY'

function choose<T extends string>(variable: string, value: string | undefined, fallback: T, allowed: readonly T[]): T {
  const chosen = (value || fallback) as T
  if (!allowed.includes(chosen)) throw new Error(`unknown ${variable} "${value}" (use ${allowed.join(' or ')})`)
  return chosen
}

/** The effective agent config. Throws one error naming every key that is missing for the chosen providers. */
export async function loadAgentConfig(env: Env = process.env): Promise<AgentConfig> {
  choose('STT_PROVIDER', env.STT_PROVIDER, 'deepgram', ['deepgram'])
  const llm = choose('LLM_PROVIDER', env.LLM_PROVIDER, 'openrouter', ['openrouter', 'openai'])
  const tts = choose('TTS_PROVIDER', env.TTS_PROVIDER, 'elevenlabs', ['elevenlabs', 'cartesia'])
  const keys = [STT_KEY, llmProviders[llm].key, ttsProviders[tts].key]
  const missing = keys.filter(name => !env[name])
  if (missing.length) {
    throw new Error(`Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} in .env (see .env.example).`)
  }
  return {
    stt: { provider: 'deepgram', apiKey: env[STT_KEY]!, model: env.STT_MODEL || 'flux-general-en' },
    llm: {
      provider: llm, apiKey: env[llmProviders[llm].key]!,
      baseUrl: (env.LLM_BASE_URL || llmProviders[llm].baseUrl).replace(/\/$/, ''),
      model: env.LLM_MODEL || llmProviders[llm].model,
    },
    tts: { provider: tts, apiKey: env[ttsProviders[tts].key]!, model: env.TTS_MODEL || undefined, voiceId: env.TTS_VOICE_ID || undefined },
  }
}
