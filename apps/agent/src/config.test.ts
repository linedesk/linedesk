import { describe, expect, test, vi } from 'vitest'
import { AgentConfigError, configForAssistant, pipelineOfAssistant, configFromEnv, createConfigLoader, isRealtime, parseProviderSettings, resolveAgentConfig, resolveCallConfig, stageEnvVars, stagesOf, type ProviderSettings, withAssistantModel, withAssistantRealtimeModel, withAssistantRealtimeVoice, withLevelFallbacks, withRealtimeModel } from './config.ts'

// OpenRouter named: the tests below were written for it; the default (OpenAI) has its own test.
const keys = { DEEPGRAM_API_KEY: 'dg', LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }
const stored: ProviderSettings = {
  stt: { provider: 'deepgram', api_key: 'dg-app', model: null },
  llm: { provider: 'openai', api_key: 'oa-app', model: 'gpt-5.4' },
  tts: { provider: 'elevenlabs', api_key: 'el-app', model: null, voice_id: 'voice_app' },
}

test('without LLM_PROVIDER the language model is OpenAI, with its default model', async () => {
  const env = { DEEPGRAM_API_KEY: 'dg', OPENAI_API_KEY: 'oa', ELEVENLABS_API_KEY: 'el' }
  expect((await configFromEnv(env)).llm).toEqual({
    provider: 'openai', apiKey: 'oa', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini', fallbacks: [], summaryModel: 'gpt-4.1-mini', summaryFallbacks: [], zeroDataRetention: true,
  })
  const { OPENAI_API_KEY: _, ...withoutOpenAi } = env
  expect(() => resolveAgentConfig(null, withoutOpenAi)).toThrow('language model: no API key for openai')
})

test('env defaults: Deepgram, OpenRouter with a fast live model and a stronger summary model, each with a fallback, ElevenLabs', async () => {
  expect(await configFromEnv(keys)).toEqual({
    stt: { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' },
    llm: {
      provider: 'openrouter', apiKey: 'or', baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-3.5-flash-lite', fallbacks: ['openai/gpt-4.1-mini'],
      summaryModel: 'google/gemini-3.5-flash-lite', summaryFallbacks: ['openai/gpt-5.4-mini'],
      zeroDataRetention: true,
    },
    tts: { provider: 'elevenlabs', apiKey: 'el', model: undefined, voiceId: undefined, others: [] },
    recording: { store: 'off' },
  })
})

test('every stage can be changed by env', async () => {
  const config = await configFromEnv({
    ...keys, OPENAI_API_KEY: 'oa', CARTESIA_API_KEY: 'ca',
    LLM_PROVIDER: 'openai', TTS_PROVIDER: 'cartesia', STT_MODEL: 'nova-3', LLM_MODEL: 'gpt-5.4', TTS_MODEL: 'sonic-3', TTS_VOICE_ID: 'voice_1',
  })
  expect(config.stt.model).toBe('nova-3')
  expect(config.llm).toEqual({ provider: 'openai', apiKey: 'oa', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', fallbacks: [], summaryModel: 'gpt-4.1-mini', summaryFallbacks: [], zeroDataRetention: true })
  expect(config.tts).toEqual({ provider: 'cartesia', apiKey: 'ca', model: 'sonic-3', voiceId: 'voice_1', others: [], openAiBackup: { apiKey: 'oa', voice: 'marin' } })
  expect((await configFromEnv({ ...keys, LLM_BASE_URL: 'https://llm.internal/v1/', LLM_MODEL: 'local' })).llm).toMatchObject({ baseUrl: 'https://llm.internal/v1', model: 'local' })
})

test('settings stored in Linedesk win over the environment, stage by stage', () => {
  expect(resolveAgentConfig(stored, keys)).toEqual({
    stt: { provider: 'deepgram', apiKey: 'dg-app', model: 'flux-general-en' },
    llm: { provider: 'openai', apiKey: 'oa-app', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', fallbacks: [], summaryModel: 'gpt-4.1-mini', summaryFallbacks: [], zeroDataRetention: true },
    // The OpenAI language model's key also makes the backup voice.
    tts: { provider: 'elevenlabs', apiKey: 'el-app', model: undefined, voiceId: 'voice_app', others: [], openAiBackup: { apiKey: 'oa-app', voice: 'marin' } },
    recording: { store: 'off' },
  })
  // A stage that is not set up in Linedesk comes from the environment.
  const partly = resolveAgentConfig({ ...stored, llm: null }, keys)
  expect(partly.llm).toMatchObject({ provider: 'openrouter', apiKey: 'or' })
  expect(partly.stt.apiKey).toBe('dg-app')
})

test('names every stage that is missing, and where to set it, without any value', () => {
  const error = (() => { try { resolveAgentConfig(null, {}) } catch (e) { return e as AgentConfigError } })()!
  expect(error).toBeInstanceOf(AgentConfigError)
  expect(error.stages).toEqual(['speech recognition', 'language model', 'voice'])
  expect(error.message).toBe('Not set up: speech recognition: no API key for deepgram (set it in Linedesk under Providers, or DEEPGRAM_API_KEY in .env); language model: no API key for openai (set it in Linedesk under Providers, or OPENAI_API_KEY in .env); voice: no API key for elevenlabs (set it in Linedesk under Providers, or ELEVENLABS_API_KEY in .env).')

  const appWithoutKey = (() => { try { resolveAgentConfig({ ...stored, tts: { provider: 'elevenlabs', api_key: null } }, keys) } catch (e) { return e as AgentConfigError } })()!
  expect(appWithoutKey.stages).toEqual(['voice'])
  expect(appWithoutKey.message).toContain('voice: no API key for elevenlabs (set it in Linedesk under Providers)')
  for (const value of ['dg-app', 'oa-app']) expect(appWithoutKey.message).not.toContain(value)
})

test('an unknown provider is an error for its stage, not a silent default', () => {
  expect(() => resolveAgentConfig(null, { ...keys, LLM_PROVIDER: 'cohere' })).toThrow(
    'language model: unknown provider "cohere" (use one of openai, openrouter, anthropic, gemini, groq, mistral)',
  )
  const error = (() => { try { resolveAgentConfig({ ...stored, tts: { provider: 'polly', api_key: 'x' } }, keys) } catch (e) { return e as AgentConfigError } })()!
  expect(error.stages).toEqual(['voice'])
})

test('the API response is checked, and a bad one never shows its content', () => {
  expect(parseProviderSettings({ stt: null, llm: null, tts: null })).toEqual({ stt: null, llm: null, tts: null })
  expect(parseProviderSettings(stored)).toEqual(stored)
  expect(() => parseProviderSettings({ stt: { api_key: 'secret-value' } })).toThrow('provider settings from the API have an unexpected shape')
  try {
    parseProviderSettings({ stt: { api_key: 'secret-value' } })
  } catch (e) {
    expect((e as Error).message).not.toContain('secret-value')
  }
})

test('the loader caches the settings for the TTL, then asks again', async () => {
  let clock = 0
  const fetchSettings = vi.fn(async () => stored)
  const load = createConfigLoader({ fetchSettings, env: keys, ttlMs: 30_000, now: () => clock, log: () => {} })
  await load()
  clock = 29_999
  await load()
  expect(fetchSettings).toHaveBeenCalledTimes(1)
  clock = 30_000
  expect(stagesOf(await load())!.llm.apiKey).toBe('oa-app')
  expect(fetchSettings).toHaveBeenCalledTimes(2)
})

test('without the API the loader uses the environment and logs the problem once', async () => {
  let clock = 0
  const log = vi.fn()
  let down = true
  const fetchSettings = vi.fn(async () => {
    if (down) throw new Error('provider-config failed (502): Bad Gateway')
    return stored
  })
  const load = createConfigLoader({ fetchSettings, env: keys, ttlMs: 1000, now: () => clock, log })
  expect(stagesOf(await load())!.llm).toMatchObject({ provider: 'openrouter', apiKey: 'or' })
  clock = 1000
  await load()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]![0]).toBe('could not read provider settings from the API, using the environment: provider-config failed (502): Bad Gateway')

  down = false
  clock = 2000
  expect(stagesOf(await load())!.llm.apiKey).toBe('oa-app')
  expect(log).toHaveBeenLastCalledWith('provider settings from the API are available again')
  for (const [line] of log.mock.calls) for (const value of ['dg', 'or', 'el-app', 'oa-app']) expect(String(line)).not.toContain(`: ${value}`)
})

test('a stage that becomes set up in Linedesk is used from the next fetch on, without a restart', async () => {
  let clock = 0
  let settings: ProviderSettings = { stt: null, llm: null, tts: null }
  const load = createConfigLoader({ fetchSettings: async () => settings, env: {}, ttlMs: 1000, now: () => clock, log: () => {} })
  await expect(load()).rejects.toBeInstanceOf(AgentConfigError)
  settings = stored
  clock = 1000
  expect(stagesOf(await load())!.tts.voiceId).toBe('voice_app')
})

test('LLM_BASE_URL only applies to an LLM configured in env: a stored key goes to its provider only', () => {
  const env = { ...keys, LLM_BASE_URL: 'https://proxy.example/v1' }
  expect(resolveAgentConfig(null, env).llm.baseUrl).toBe('https://proxy.example/v1')
  expect(resolveAgentConfig(stored, env).llm.baseUrl).toBe('https://api.openai.com/v1')
  expect(resolveAgentConfig({ ...stored, llm: null }, env).llm.baseUrl).toBe('https://proxy.example/v1')
})

test('calls that arrive together share one request', async () => {
  let release!: (settings: ProviderSettings) => void
  const fetchSettings = vi.fn(() => new Promise<ProviderSettings>(resolve => { release = resolve }))
  const load = createConfigLoader({ fetchSettings, env: keys, now: () => 0, log: () => {} })
  const both = Promise.all([load(), load(), load()])
  release(stored)
  expect((await both).map(c => stagesOf(c)!.llm.apiKey)).toEqual(['oa-app', 'oa-app', 'oa-app'])
  expect(fetchSettings).toHaveBeenCalledTimes(1)
})

test('a different failure is logged again, the same one is not', async () => {
  let clock = 0
  const log = vi.fn()
  const errors = ['provider-config failed (502): Bad Gateway', 'provider-config failed (502): Bad Gateway', 'provider-config failed (409): stored keys cannot be decrypted']
  const fetchSettings = vi.fn(async () => { throw new Error(errors.shift()) })
  const load = createConfigLoader({ fetchSettings, env: keys, ttlMs: 1, now: () => clock++, log })
  await load(); await load(); await load()
  expect(log.mock.calls.map(([line]) => line)).toEqual([
    'could not read provider settings from the API, using the environment: provider-config failed (502): Bad Gateway',
    'could not read provider settings from the API, using the environment: provider-config failed (409): stored keys cannot be decrypted',
  ])
})

test('models are lists: "model, fallback, ..." for live turns and the summary, by env or stored', async () => {
  const env = await configFromEnv({ ...keys, LLM_MODEL: ' a/fast , b/backup ', SUMMARY_MODEL: 'c/strong' })
  expect(env.llm).toMatchObject({ model: 'a/fast', fallbacks: ['b/backup'], summaryModel: 'c/strong', summaryFallbacks: [] })
  const app = resolveAgentConfig({ ...stored, llm: { provider: 'openrouter', api_key: 'or-app', model: 'x/one', summary_model: 'y/two, z/three' } }, keys)
  expect(app.llm).toMatchObject({ model: 'x/one', fallbacks: [], summaryModel: 'y/two', summaryFallbacks: ['z/three'] })
  // OpenAI's API takes no fallback list: only the first model is used.
  expect((await configFromEnv({ ...keys, OPENAI_API_KEY: 'oa', LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-a, gpt-b' })).llm).toMatchObject({ model: 'gpt-a', fallbacks: [] })
})

test('OpenRouter asks for zero data retention unless the instance admin turned it off, stored or by env', async () => {
  expect((await configFromEnv(keys)).llm.zeroDataRetention).toBe(true)
  expect((await configFromEnv({ ...keys, OPENROUTER_ZERO_DATA_RETENTION: 'false' })).llm.zeroDataRetention).toBe(false)
  const app = (value: string | null) =>
    resolveAgentConfig({ ...stored, llm: { provider: 'openrouter', api_key: 'or-app', zero_data_retention: value } }, keys).llm.zeroDataRetention
  expect(app(null)).toBe(true)
  expect(app('true')).toBe(true)
  expect(app('false')).toBe(false)
  // The stored setting wins over the environment, as every other field.
  expect(resolveAgentConfig({ ...stored, llm: { provider: 'openrouter', api_key: 'or-app', zero_data_retention: 'true' } }, { ...keys, OPENROUTER_ZERO_DATA_RETENTION: 'false' }).llm.zeroDataRetention).toBe(true)
  expect(stageEnvVars).toContain('OPENROUTER_ZERO_DATA_RETENTION')
})

test('recording storage comes with the provider settings; without it (an older API, or null) the environment decides', () => {
  const s3 = { provider: 's3', endpoint: 'https://s3.test', region: null, bucket: 'calls', access_key_id: 'k', secret_access_key: 's', prefix: null, force_path_style: 'true' }
  const parsed = parseProviderSettings({ ...stored, recording: s3 })
  expect(resolveAgentConfig(parsed, { ...keys, RECORDING_STORE: 'file' }).recording).toMatchObject({ store: 's3', s3: { bucket: 'calls', secretAccessKey: 's' } })
  expect(resolveAgentConfig(parseProviderSettings(stored), { ...keys, RECORDING_STORE: 'file' }).recording).toEqual({ store: 'file' })
  expect(resolveAgentConfig({ ...stored, recording: null }, keys).recording).toEqual({ store: 'off' })
  expect(() => parseProviderSettings({ ...stored, recording: { provider: 's3', bucket: 42 } })).toThrow('unexpected shape')
})

test('every other voice provider with a key comes along, so an assistant can use a voice of it', () => {
  const config = resolveAgentConfig({
    ...stored,
    tts_providers: [
      { provider: 'elevenlabs', api_key: 'el-app', model: null },
      { provider: 'cartesia', api_key: 'ca-app', model: 'sonic-2' },
      { provider: 'unknown', api_key: 'x' },
      { provider: 'cartesia', api_key: null },
    ],
  }, {})
  expect(config.tts.others).toEqual([{ provider: 'cartesia', apiKey: 'ca-app', model: 'sonic-2' }])
  expect(parseProviderSettings({ stt: null, llm: null, tts: null }).tts_providers).toBeUndefined() // an older API
})

test('without a realtime model connected, a call goes through the three stages, also with OPENAI_API_KEY', () => {
  expect(isRealtime(resolveCallConfig(stored, {}))).toBe(false)
  expect(isRealtime(resolveCallConfig({ ...stored, realtime: null }, { ...keys, OPENAI_API_KEY: 'oa' }))).toBe(false)
})

test('a realtime model connected in Linedesk answers calls, with its defaults, and keeps the stages that are set up', () => {
  const config = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt-app' } }, {})
  if (!isRealtime(config)) throw new Error('expected a realtime config')
  expect(config.realtime).toEqual({ provider: 'openai_realtime', apiKey: 'rt-app', model: 'gpt-realtime', voice: 'marin', summaryModel: 'gpt-4.1-mini' })
  expect(config.stages?.llm.apiKey).toBe('oa-app')
})

test('a realtime model does not need the three stages', () => {
  const config = resolveCallConfig({ stt: null, llm: null, tts: null, realtime: { provider: 'openai_realtime', api_key: 'rt', model: 'gpt-realtime', voice: 'cedar', summary_model: 'gpt-5.4-mini' } }, {})
  if (!isRealtime(config)) throw new Error('expected a realtime config')
  expect(config.realtime).toMatchObject({ model: 'gpt-realtime', voice: 'cedar', summaryModel: 'gpt-5.4-mini' })
  expect(stagesOf(config)).toBeNull()
})

describe("withAssistantRealtimeModel: the assistant's own realtime model (Ultra)", () => {
  const config = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt' } }, {})
  const modelOf = (c: ReturnType<typeof resolveCallConfig>) => (isRealtime(c) ? c.realtime.model : null)

  test('a listed realtime model answers; none, or one in no list, leaves the install one', () => {
    expect(modelOf(withAssistantRealtimeModel(config, 'gpt-realtime-2'))).toBe('gpt-realtime-2')
    expect(modelOf(withAssistantRealtimeModel(config, null))).toBe('gpt-realtime')
    expect(modelOf(withAssistantRealtimeModel(config, 'gpt-realtime-2.1'))).toBe('gpt-realtime')
    expect(modelOf(withAssistantRealtimeModel(config, 'gpt-realtime-mini'))).toBe('gpt-realtime')
  })

  test("the call test's model still wins; the three stages are left as they are", () => {
    expect(modelOf(withRealtimeModel(withAssistantRealtimeModel(config, 'gpt-realtime-2'), 'gpt-realtime-mini'))).toBe(
      'gpt-realtime-mini',
    )
    const stages = configForAssistant(config, 'three_stage', () => {})
    expect(withAssistantRealtimeModel(stages, 'gpt-realtime-2')).toBe(stages)
  })
})

describe("withAssistantRealtimeVoice: the assistant's own realtime voice", () => {
  const serverVoice = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt', voice: 'cedar' } }, {})
  const noServerVoice = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt' } }, {})
  const voiceOf = (config: ReturnType<typeof resolveCallConfig>) => (isRealtime(config) ? config.realtime.voice : null)

  test('a realtime call speaks with the voice the assistant picked', () => {
    expect(voiceOf(withAssistantRealtimeVoice(serverVoice, 'ash'))).toBe('ash')
    expect(voiceOf(withAssistantRealtimeVoice(noServerVoice, 'verse'))).toBe('verse')
  })

  test("without a pick of its own (or an older API without the column) it is the server's default voice, else marin", () => {
    expect(voiceOf(withAssistantRealtimeVoice(serverVoice, ''))).toBe('cedar')
    expect(voiceOf(withAssistantRealtimeVoice(serverVoice, undefined))).toBe('cedar')
    expect(voiceOf(withAssistantRealtimeVoice(noServerVoice, null))).toBe('marin')
  })

  test('a voice that is not a realtime voice (a three-stage voice id, a removed one) falls back to the default', () => {
    expect(voiceOf(withAssistantRealtimeVoice(serverVoice, 'cgSgspJ2msm6clMCkdW9'))).toBe('cedar')
    expect(voiceOf(withAssistantRealtimeVoice(serverVoice, 'nova'))).toBe('cedar')
  })

  test('the three stages are left as they are: they speak with assistants.voice', () => {
    const stages = configForAssistant(serverVoice, 'three_stage', () => {})
    expect(withAssistantRealtimeVoice(stages, 'ash')).toBe(stages)
  })
})

test('OPENAI_REALTIME_API_KEY switches the realtime model on from the environment', () => {
  const config = resolveCallConfig(null, { OPENAI_REALTIME_API_KEY: 'oa', REALTIME_VOICE: 'cedar' })
  if (!isRealtime(config)) throw new Error('expected a realtime config')
  expect(config.realtime).toMatchObject({ apiKey: 'oa', voice: 'cedar', model: 'gpt-realtime' })
})

test('a realtime model without a key names the realtime model as not set up, never a value', () => {
  const run = () => resolveCallConfig({ stt: null, llm: null, tts: null, realtime: { provider: 'openai_realtime', api_key: null } }, {})
  expect(run).toThrow(AgentConfigError)
  try {
    run()
  } catch (e) {
    expect((e as AgentConfigError).stages).toEqual(['realtime model'])
  }
})

test('a realtime model without a key leaves the three stages when they are set up', () => {
  const config = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: null } }, {})
  expect(isRealtime(config)).toBe(false)
  expect(stagesOf(config)?.llm.apiKey).toBe('oa-app')
})

describe('configForAssistant: the pipeline an assistant chose', () => {
  const both = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt-app' } }, {})
  const realtimeOnly = resolveCallConfig({ stt: null, llm: null, tts: null, realtime: { provider: 'openai_realtime', api_key: 'rt' } }, {})
  const stagesOnly = resolveCallConfig(stored, {})

  test('with both set up: the assistant picks, no choice is the realtime model', () => {
    const log = vi.fn()
    expect(isRealtime(configForAssistant(both, 'realtime', log))).toBe(true)
    const stages = configForAssistant(both, 'three_stage', log)
    expect(isRealtime(stages)).toBe(false)
    expect(stagesOf(stages)?.tts.apiKey).toBe('el-app')
    expect(isRealtime(configForAssistant(both, null, log))).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  test('the chosen one not set up: the other answers, with a line in the log', () => {
    const log = vi.fn()
    expect(isRealtime(configForAssistant(realtimeOnly, 'three_stage', log))).toBe(true)
    expect(log).toHaveBeenLastCalledWith('assistant set to "Speech to text, model and voice", which is not set up: "Realtime model" takes the call')
    expect(isRealtime(configForAssistant(stagesOnly, 'realtime', log))).toBe(false)
    expect(log).toHaveBeenLastCalledWith('assistant set to "Realtime model", which is not set up: "Speech to text, model and voice" takes the call')
  })

  test('no choice: whatever is set up, without a log line', () => {
    const log = vi.fn()
    expect(isRealtime(configForAssistant(stagesOnly, null, log))).toBe(false)
    expect(isRealtime(configForAssistant(realtimeOnly, undefined, log))).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })
})

test('the realtime variables are passed to the agent container', () => {
  for (const name of ['OPENAI_REALTIME_API_KEY', 'REALTIME_MODEL', 'REALTIME_VOICE', 'REALTIME_SUMMARY_MODEL']) expect(stageEnvVars).toContain(name)
  expect(new Set(stageEnvVars).size).toBe(stageEnvVars.length)
})

test('every language-model provider answers on its own OpenAI-compatible API with its default models', () => {
  const env = { ...keys, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'an' }
  expect(resolveAgentConfig(null, env).llm).toEqual({
    provider: 'anthropic', apiKey: 'an', baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-5-5', fallbacks: [], summaryModel: 'claude-sonnet-5-5', summaryFallbacks: [], zeroDataRetention: true,
  })
  const gemini = resolveAgentConfig({ ...stored, llm: { provider: 'gemini', api_key: 'ge', model: 'gemini-2.5-flash, gemini-2.5-pro' } }, {}).llm
  expect(gemini).toMatchObject({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', fallbacks: [] })
  expect(resolveAgentConfig(null, { ...keys, LLM_PROVIDER: 'groq', GROQ_API_KEY: 'gq' }).llm.baseUrl).toBe('https://api.groq.com/openai/v1')
  expect(resolveAgentConfig(null, { ...keys, LLM_PROVIDER: 'mistral', MISTRAL_API_KEY: 'mi' }).llm.model).toBe('mistral-small-latest')
})

test('ElevenLabs Scribe and OpenAI transcription as speech recognition, with their streaming models by default', () => {
  expect(resolveAgentConfig(null, { ...keys, STT_PROVIDER: 'elevenlabs_stt', ELEVENLABS_STT_API_KEY: 'es' }).stt).toEqual({ provider: 'elevenlabs_stt', apiKey: 'es', model: 'scribe_v2_realtime' })
  expect(resolveAgentConfig(null, { ...keys, STT_PROVIDER: 'openai_stt', OPENAI_STT_API_KEY: 'os' }).stt).toEqual({ provider: 'openai_stt', apiKey: 'os', model: 'gpt-4o-mini-transcribe' })
  // The language model's or the voice's key does not count for speech recognition.
  expect(() => resolveAgentConfig(null, { ...keys, STT_PROVIDER: 'openai_stt', OPENAI_API_KEY: 'oa' })).toThrow(/no API key for openai_stt/)
})

test('AssemblyAI as speech recognition: Universal-3.6 Pro by default, its own key', () => {
  expect(resolveAgentConfig(null, { ...keys, STT_PROVIDER: 'assemblyai_stt', ASSEMBLYAI_STT_API_KEY: 'aa' }).stt).toEqual({ provider: 'assemblyai_stt', apiKey: 'aa', model: 'universal-3-6-pro' })
  const stored = resolveAgentConfig({ stt: { provider: 'assemblyai_stt', api_key: 'aa-app', model: 'assemblyai-stt-3-7-realtime-agent' }, llm: null, tts: null, recording: null }, keys).stt
  expect(stored).toEqual({ provider: 'assemblyai_stt', apiKey: 'aa-app', model: 'assemblyai-stt-3-7-realtime-agent' })
  // The after-call transcriber's key in the environment does not switch speech recognition on.
  expect(() => resolveAgentConfig(null, { ...keys, STT_PROVIDER: 'assemblyai_stt', ASSEMBLYAI_API_KEY: 'aa' })).toThrow(/no API key for assemblyai_stt/)
})

test('a call test may use another realtime model; the three stages and other calls are left alone', () => {
  const both = resolveCallConfig({ ...stored, realtime: { provider: 'openai_realtime', api_key: 'rt-app' } }, {})
  const picked = withRealtimeModel(both, 'gpt-realtime')
  if (!isRealtime(picked)) throw new Error('expected a realtime config')
  expect(picked.realtime.model).toBe('gpt-realtime')
  expect(withRealtimeModel(both, undefined)).toBe(both)
  const stagesOnly = resolveCallConfig(stored, {})
  expect(withRealtimeModel(stagesOnly, 'gpt-realtime')).toBe(stagesOnly)
})

describe("withAssistantModel: the assistant's own language model (usage levels)", () => {
  test("a listed model of the install's provider goes first, the install's model after it as a fallback", () => {
    const config = resolveCallConfig(stored, {})
    const own = stagesOf(withAssistantModel(config, 'gpt-4.1-mini'))!
    expect(own.llm).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini', fallbacks: ['gpt-5.4'] })
    // The summary model stays the install's.
    expect(own.llm.summaryModel).toBe(stagesOf(config)!.llm.summaryModel)
  })

  test("no pick, the install's own model, or a model the provider does not serve with a level: the config as it is", () => {
    const config = resolveCallConfig(stored, {})
    expect(withAssistantModel(config, null)).toBe(config)
    expect(withAssistantModel(config, 'gpt-5.4')).toBe(config)
    expect(withAssistantModel(config, 'google/gemini-3.8-flash')).toBe(config)
    expect(withAssistantModel(config, 'gpt-5.6-terra')).toBe(config)
  })

  test('with OpenRouter the install list stays behind it, without the picked one twice', async () => {
    const config = await configFromEnv(keys)
    expect(stagesOf(withAssistantModel(config, 'openai/gpt-4.1-mini'))!.llm).toMatchObject({
      model: 'openai/gpt-4.1-mini',
      fallbacks: ['google/gemini-3.5-flash-lite'],
    })
  })
})

describe('withLevelFallbacks: only fallback models of the call level (usage levels, N2)', () => {
  test('a Standard call drops a Premium or unlisted fallback; a Premium call keeps Premium ones; no level keeps all', () => {
    const config = resolveCallConfig(stored, {})
    const withList = (fallbacks: string[]) => {
      const s = stagesOf(config)!
      return { ...s, llm: { ...s.llm, model: 'gpt-4.1-mini', fallbacks } }
    }
    const list = withList(['gpt-5.4', 'gpt-5.4-nano', 'gpt-5.6-terra'])
    const log: string[] = []
    expect(stagesOf(withLevelFallbacks(list, 'standard', l => log.push(l)))!.llm.fallbacks).toEqual(['gpt-5.4-nano'])
    expect(log).toEqual(['fallback language models dropped on a standard call: gpt-5.4, gpt-5.6-terra'])
    expect(stagesOf(withLevelFallbacks(list, 'premium'))!.llm.fallbacks).toEqual(['gpt-5.4', 'gpt-5.4-nano'])
    for (const level of [null, undefined, 'own_keys'] as const) expect(withLevelFallbacks(list, level)).toBe(list)
    const clean = withList(['gpt-5.4-nano'])
    expect(withLevelFallbacks(clean, 'standard')).toBe(clean)
  })
})

test('after one good read, a failing API keeps the last settings instead of the environment', async () => {
  let clock = 0
  let fail = false
  const fetchSettings = vi.fn(async () => {
    if (fail) throw new Error('The operation was aborted due to timeout')
    return stored
  })
  const log = vi.fn()
  const load = createConfigLoader({ fetchSettings, env: {}, ttlMs: 1000, now: () => clock, log })
  const first = await load()
  fail = true
  clock = 2000
  expect(await load()).toEqual(first)
  expect(log).toHaveBeenLastCalledWith('could not read provider settings from the API, using the last settings read: The operation was aborted due to timeout')
})

test('the pipeline of a call follows the call quality the API named: Ultra a realtime model, the others three stages', () => {
  expect(pipelineOfAssistant({ call_quality: 'ultra' })).toBe('realtime')
  expect(pipelineOfAssistant({ call_quality: 'premium' })).toBe('three_stage')
  expect(pipelineOfAssistant({ call_quality: 'standard' })).toBe('three_stage')
  expect(pipelineOfAssistant(null)).toBeNull()
  expect(pipelineOfAssistant({})).toBeNull()
})
