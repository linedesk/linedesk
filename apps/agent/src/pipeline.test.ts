import { expect, test, vi } from 'vitest'
import type { AgentConfig } from './config.ts'
import { chatJson, greetingVoice, SUMMARY_MAX_TOKENS, summaryLlm, ttsFor, voiceFor, warmUpLlm } from './pipeline.ts'

const openrouter = { apiKey: 'sk-or-test', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' }

test('chatJson asks the configured API for a JSON object and returns the message content', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
  expect(await chatJson(openrouter, fakeFetch)('system prompt', 'transcript')).toBe('{"ok":true}')
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'openai/gpt-4.1-mini', response_format: { type: 'json_object' }, max_tokens: SUMMARY_MAX_TOKENS })

  const direct = { ...openrouter, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }
  await chatJson(direct, fakeFetch)('s', 'u')
  expect(fakeFetch.mock.calls[1]![0]).toBe('https://api.openai.com/v1/chat/completions')

  const failing: typeof fetch = async () => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 })
  await expect(chatJson(openrouter, failing)('s', 'u')).rejects.toThrow('summary request failed (401): No auth credentials found')
})

test('chatJson gives up when the request takes longer than the timeout', async () => {
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
  })
  await expect(chatJson(openrouter, hanging, 20)('s', 'u')).rejects.toThrow(/timeout|aborted/i)
})

test('the voice of the assistant is used only for the provider it was chosen for', () => {
  const eleven = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice' }
  expect(voiceFor(eleven, { provider: 'elevenlabs', voice_id: 'maya' })).toBe('maya')
  expect(voiceFor(eleven, { provider: 'cartesia', voice_id: 'sonic_voice' })).toBe('default_voice')
  expect(voiceFor(eleven, { provider: 'elevenlabs', voice_id: '' })).toBe('default_voice')
  expect(voiceFor({ provider: 'elevenlabs', apiKey: 'k' }, null)).toBe('cgSgspJ2msm6clMCkdW9') // Jessica, the default voice
})

test('warmUpLlm sends the system prompt for a one-token answer and never throws', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [] }))
  await warmUpLlm(openrouter, 'You are Maya.', fakeFetch)
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'openai/gpt-4.1-mini', max_tokens: 1, messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user' }] })

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(warmUpLlm(openrouter, 's', async () => { throw new TypeError('fetch failed') })).resolves.toBeUndefined()
  await warmUpLlm(openrouter, 's', async () => new Response('busy', { status: 429 }))
  expect(warn.mock.calls.map(c => c[0])).toEqual(['LLM warm-up failed: fetch failed', 'LLM warm-up answered 429'])
  warn.mockRestore()
})

test('the summary uses the summary model, with OpenRouter fallbacks as `models`', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{}' } }] }))
  const llm: AgentConfig['llm'] = {
    provider: 'openrouter', ...openrouter, model: 'live/fast', fallbacks: ['live/backup'], summaryModel: 'sum/strong', summaryFallbacks: ['sum/backup'],
  }
  const config = { llm } as AgentConfig
  vi.stubGlobal('fetch', fakeFetch)
  await summaryLlm(config)('s', 'u')
  vi.unstubAllGlobals()
  expect(JSON.parse(String(fakeFetch.mock.calls[0]![1]!.body))).toMatchObject({ model: 'sum/strong', models: ['sum/strong', 'sum/backup'] })
  await chatJson({ ...openrouter, fallbacks: [] }, fakeFetch)('s', 'u')
  expect(JSON.parse(String(fakeFetch.mock.calls[1]![1]!.body))).not.toHaveProperty('models')
})

test('an assistant with a voice of another provider that has a key gets that provider', () => {
  const tts = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice', others: [{ provider: 'cartesia' as const, apiKey: 'ck', model: 'sonic-2' }] }
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: 'sonic_voice' })).toEqual({ provider: 'cartesia', apiKey: 'ck', model: 'sonic-2', voiceId: 'sonic_voice' })
  expect(ttsFor({ ...tts, others: [] }, { provider: 'cartesia', voice_id: 'sonic_voice' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: '' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' } } })).toEqual({ provider: 'cartesia', model: 'sonic-2', voiceId: 'sonic_voice', speed: 'normal' })
  // The talking speed is part of the cached greeting's voice.
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' }, talking_speed: 'fast' } })).toMatchObject({ speed: 'fast' })
})
