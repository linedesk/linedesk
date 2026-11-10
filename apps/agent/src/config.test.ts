import { expect, test } from 'vitest'
import { AgentConfigError, loadAgentConfig } from './config.ts'

const keys = { DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }

test('defaults: Deepgram, OpenRouter with an OpenAI mini model, ElevenLabs', async () => {
  expect(await loadAgentConfig(keys)).toEqual({
    stt: { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' },
    llm: { provider: 'openrouter', apiKey: 'or', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini' },
    tts: { provider: 'elevenlabs', apiKey: 'el', model: undefined, voiceId: undefined },
  })
})

test('every stage can be changed by config', async () => {
  const config = await loadAgentConfig({
    ...keys, OPENAI_API_KEY: 'oa', CARTESIA_API_KEY: 'ca',
    LLM_PROVIDER: 'openai', TTS_PROVIDER: 'cartesia', STT_MODEL: 'nova-3', LLM_MODEL: 'gpt-5.4', TTS_MODEL: 'sonic-3', TTS_VOICE_ID: 'voice_1',
  })
  expect(config.stt.model).toBe('nova-3')
  expect(config.llm).toEqual({ provider: 'openai', apiKey: 'oa', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' })
  expect(config.tts).toEqual({ provider: 'cartesia', apiKey: 'ca', model: 'sonic-3', voiceId: 'voice_1' })
  expect((await loadAgentConfig({ ...keys, LLM_BASE_URL: 'https://llm.internal/v1/', LLM_MODEL: 'local' })).llm).toMatchObject({ baseUrl: 'https://llm.internal/v1', model: 'local' })
})

test('names every missing key for the chosen providers, and only those', async () => {
  await expect(loadAgentConfig({})).rejects.toThrow('Missing environment variables: DEEPGRAM_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_API_KEY.')
  await expect(loadAgentConfig({ ...keys, ELEVENLABS_API_KEY: '' })).rejects.toThrow('Missing environment variable: ELEVENLABS_API_KEY.')
  await expect(loadAgentConfig({ DEEPGRAM_API_KEY: 'dg', LLM_PROVIDER: 'openai', TTS_PROVIDER: 'cartesia' })).rejects.toThrow('Missing environment variables: OPENAI_API_KEY, CARTESIA_API_KEY.')
})

test('an unknown provider is an error, not a silent default', async () => {
  await expect(loadAgentConfig({ ...keys, LLM_PROVIDER: 'mistral' })).rejects.toThrow('unknown LLM_PROVIDER "mistral" (use openrouter or openai)')
  await expect(loadAgentConfig({ ...keys, TTS_PROVIDER: 'polly' })).rejects.toThrow('unknown TTS_PROVIDER "polly"')
  await expect(loadAgentConfig({ ...keys, STT_PROVIDER: 'whisper' })).rejects.toThrow('unknown STT_PROVIDER "whisper"')
})

test('the error says which stages are missing, for the inbox', async () => {
  const error = await loadAgentConfig({ DEEPGRAM_API_KEY: 'dg' }).catch(e => e)
  expect(error).toBeInstanceOf(AgentConfigError)
  expect(error.stages).toEqual(['language model', 'voice'])
  expect((await loadAgentConfig({ ...keys, LLM_PROVIDER: 'x' }).catch(e => e)).stages).toEqual(['language model'])
})
