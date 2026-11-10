import { expect, test, vi } from 'vitest'
import type { AgentConfig } from './config.ts'
import { chatJson, voiceFor } from './pipeline.ts'

const openrouter: AgentConfig['llm'] = { provider: 'openrouter', apiKey: 'sk-or-test', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini' }

test('chatJson asks the configured API for a JSON object and returns the message content', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
  expect(await chatJson(openrouter, fakeFetch)('system prompt', 'transcript')).toBe('{"ok":true}')
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'openai/gpt-5.4-mini', response_format: { type: 'json_object' } })

  const direct = { ...openrouter, provider: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' }
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
  expect(voiceFor({ provider: 'elevenlabs', apiKey: 'k' }, null)).toBeUndefined() // the provider's own default voice
})
