import { expect, test, vi } from 'vitest'
import { openAiJson } from './pipeline.ts'

test('openAiJson asks for a JSON object and returns the message content', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
  expect(await openAiJson('sk-test', 'gpt-5.4-mini', fakeFetch)('system prompt', 'transcript')).toBe('{"ok":true}')
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://api.openai.com/v1/chat/completions')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'gpt-5.4-mini', response_format: { type: 'json_object' } })

  const failing: typeof fetch = async () => Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 })
  await expect(openAiJson('bad', 'gpt-5.4-mini', failing)('s', 'u')).rejects.toThrow('OpenAI summary request failed (401): Incorrect API key')
})

test('openAiJson gives up when the request takes longer than the timeout', async () => {
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
  })
  await expect(openAiJson('sk-test', 'gpt-5.4-mini', hanging, 20)('s', 'u')).rejects.toThrow(/timeout|aborted/i)
})
