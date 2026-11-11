import { expect, test, vi } from 'vitest'
import { AgentConfigError, configFromEnv, createConfigLoader, parseProviderSettings, resolveAgentConfig, type ProviderSettings } from './config.ts'

const keys = { DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }
const stored: ProviderSettings = {
  stt: { provider: 'deepgram', api_key: 'dg-app', model: null },
  llm: { provider: 'openai', api_key: 'oa-app', model: 'gpt-5.4' },
  tts: { provider: 'elevenlabs', api_key: 'el-app', model: null, voice_id: 'voice_app' },
}

test('env defaults: Deepgram, OpenRouter with a fast live model and a stronger summary model, each with a fallback, ElevenLabs', async () => {
  expect(await configFromEnv(keys)).toEqual({
    stt: { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' },
    llm: {
      provider: 'openrouter', apiKey: 'or', baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-2.5-flash-lite', fallbacks: ['openai/gpt-4.1-mini'],
      summaryModel: 'google/gemini-2.5-flash', summaryFallbacks: ['openai/gpt-5.4-mini'],
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
  expect(config.llm).toEqual({ provider: 'openai', apiKey: 'oa', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', fallbacks: [], summaryModel: 'gpt-4.1-mini', summaryFallbacks: [] })
  expect(config.tts).toEqual({ provider: 'cartesia', apiKey: 'ca', model: 'sonic-3', voiceId: 'voice_1', others: [] })
  expect((await configFromEnv({ ...keys, LLM_BASE_URL: 'https://llm.internal/v1/', LLM_MODEL: 'local' })).llm).toMatchObject({ baseUrl: 'https://llm.internal/v1', model: 'local' })
})

test('settings stored in Linedesk win over the environment, stage by stage', () => {
  expect(resolveAgentConfig(stored, keys)).toEqual({
    stt: { provider: 'deepgram', apiKey: 'dg-app', model: 'flux-general-en' },
    llm: { provider: 'openai', apiKey: 'oa-app', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', fallbacks: [], summaryModel: 'gpt-4.1-mini', summaryFallbacks: [] },
    tts: { provider: 'elevenlabs', apiKey: 'el-app', model: undefined, voiceId: 'voice_app', others: [] },
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
  expect(error.message).toBe('Not set up: speech recognition: no API key for deepgram (set it in Linedesk under Providers, or DEEPGRAM_API_KEY in .env); language model: no API key for openrouter (set it in Linedesk under Providers, or OPENROUTER_API_KEY in .env); voice: no API key for elevenlabs (set it in Linedesk under Providers, or ELEVENLABS_API_KEY in .env).')

  const appWithoutKey = (() => { try { resolveAgentConfig({ ...stored, tts: { provider: 'elevenlabs', api_key: null } }, keys) } catch (e) { return e as AgentConfigError } })()!
  expect(appWithoutKey.stages).toEqual(['voice'])
  expect(appWithoutKey.message).toContain('voice: no API key for elevenlabs (set it in Linedesk under Providers)')
  for (const value of ['dg-app', 'oa-app']) expect(appWithoutKey.message).not.toContain(value)
})

test('an unknown provider is an error for its stage, not a silent default', () => {
  expect(() => resolveAgentConfig(null, { ...keys, LLM_PROVIDER: 'mistral' })).toThrow('language model: unknown provider "mistral" (use openrouter or openai)')
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
  expect((await load()).llm.apiKey).toBe('oa-app')
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
  expect((await load()).llm).toMatchObject({ provider: 'openrouter', apiKey: 'or' })
  clock = 1000
  await load()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]![0]).toBe('could not read provider settings from the API, using the environment: provider-config failed (502): Bad Gateway')

  down = false
  clock = 2000
  expect((await load()).llm.apiKey).toBe('oa-app')
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
  expect((await load()).tts.voiceId).toBe('voice_app')
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
  expect((await both).map(c => c.llm.apiKey)).toEqual(['oa-app', 'oa-app', 'oa-app'])
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
