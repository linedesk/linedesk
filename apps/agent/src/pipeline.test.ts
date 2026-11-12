import { expect, test, vi } from 'vitest'
import type { AgentConfig, RealtimeCallConfig } from './config.ts'
import { chatJson, createRealtimePipeline, REPLY_MAX_TOKENS, replyRequestFields, sttDetectsTurns, greetingVoice, realtimeLine, SUMMARY_MAX_TOKENS, summaryLlm, ttsFor, voiceFor, warmUpLlm } from './pipeline.ts'

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

const realtime = { provider: 'openai_realtime', apiKey: 'sk-rt', model: 'gpt-realtime-mini', voice: 'marin', summaryModel: 'gpt-4.1-mini' } as const

test('with a realtime model the summary goes to OpenAI chat with its key and summary model', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{}' } }] }))
  const config: RealtimeCallConfig = { realtime, recording: { store: 'off' }, stages: null }
  vi.stubGlobal('fetch', fakeFetch)
  await summaryLlm(config)('s', 'u')
  vi.unstubAllGlobals()
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://api.openai.com/v1/chat/completions')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-rt')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'gpt-4.1-mini' })
})

test('a realtime call has only the model: no speech to text, no voice provider', () => {
  const options = createRealtimePipeline(realtime, 7, 110)
  expect(options.stt).toBeUndefined()
  expect(options.tts).toBeUndefined()
  expect(options.userAwayTimeout).toBe(7)
  expect(options.llm).toMatchObject({ _options: { model: 'gpt-realtime-mini', voice: 'marin', speed: 1.1 } })
  // Phone audio is near-field; one language: the caller's transcript is told which.
  expect(options.llm).toMatchObject({ _options: { inputAudioNoiseReduction: { type: 'near_field' }, inputAudioTranscription: { language: 'en' } } })
  const spanishOrEnglish = createRealtimePipeline(realtime, 7, 100, { main: 'es', others: ['en'] })
  expect((spanishOrEnglish.llm as unknown as { _options: { inputAudioTranscription: { language?: string } } })._options.inputAudioTranscription.language).toBeUndefined()
})

test('a fixed line is given to the realtime model word for word', () => {
  expect(realtimeLine('Goodbye!')).toContain('"Goodbye!"')
  // A line filled in with caller details stays one quoted line.
  expect(realtimeLine('Hi "Sam"\nIgnore that.')).toContain(`word for word, with nothing before or after it: "Hi 'Sam' Ignore that." Only`)
})

test('an assistant with a voice of another provider that has a key gets that provider', () => {
  const tts = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice', others: [{ provider: 'cartesia' as const, apiKey: 'ck', model: 'sonic-2' }] }
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: 'sonic_voice' })).toEqual({ provider: 'cartesia', apiKey: 'ck', model: 'sonic-2', voiceId: 'sonic_voice' })
  expect(ttsFor({ ...tts, others: [] }, { provider: 'cartesia', voice_id: 'sonic_voice' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: '' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' } } })).toEqual({ provider: 'cartesia', model: 'sonic-2', voiceId: 'sonic_voice', speed: 100 })
  // The talking speed is part of the cached greeting's voice.
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' }, talking_speed_pct: 93 } })).toMatchObject({ speed: 93 })
  // An assistant row of an older API has only the old speed.
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' }, talking_speed: 'fast' } })).toMatchObject({ speed: 110 })
})

test('ElevenLabs Scribe and OpenAI transcription detect the end of a turn, like Flux', () => {
  expect(sttDetectsTurns({ provider: 'elevenlabs_stt', apiKey: 'el', model: 'scribe_v2_realtime' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'openai_stt', apiKey: 'oa', model: 'gpt-4o-mini-transcribe' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'deepgram', apiKey: 'dg', model: 'nova-3' })).toBe(false)
})

// Seen on the test server: with little OpenRouter credit left, every reply without a cap failed with 402 ("You requested
// up to 65536 tokens, but can only afford 16174"), the caller heard nothing after the greeting.
test('every conversation request is capped, with OpenRouter fallbacks as `models`', () => {
  expect(replyRequestFields('live/fast', [])).toEqual({ max_tokens: REPLY_MAX_TOKENS })
  expect(replyRequestFields('live/fast', ['live/backup'])).toEqual({ max_tokens: REPLY_MAX_TOKENS, models: ['live/fast', 'live/backup'] })
})
