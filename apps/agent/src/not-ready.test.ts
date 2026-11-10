import { expect, test, vi } from 'vitest'
import type { CallSession } from './call-session.ts'
import { configFromEnv } from './config.ts'
import { checkReadiness, declineCall, describeReadiness, missedResult } from './not-ready.ts'

const keys = { DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }
const fakeCall = (over: Partial<CallSession> = {}) =>
  ({ callId: 'call_1', workspaceId: 'ws_1', append: vi.fn(async () => {}), finish: vi.fn(async () => {}), ...over }) as unknown as CallSession & { append: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }

test('without keys the agent is not ready, and says in one line what is missing', async () => {
  const readiness = await checkReadiness(() => configFromEnv({}))
  expect(readiness).toEqual({
    ready: false, stages: ['speech recognition', 'language model', 'voice'],
    reason: expect.stringMatching(/^Not set up: speech recognition: no API key for deepgram .*DEEPGRAM_API_KEY.*OPENROUTER_API_KEY.*ELEVENLABS_API_KEY in \.env\)\.$/),
  })
  const line = describeReadiness(readiness)
  expect(line).toContain('not answering calls yet: Not set up: speech recognition: no API key for deepgram')
  expect(line).toContain('checked again at every call')
  expect(line).not.toContain('\n')
})

test('a wrong provider name is also "not ready", not a crash', async () => {
  const readiness = await checkReadiness(() => configFromEnv({ ...keys, TTS_PROVIDER: 'polly' }))
  expect(readiness).toMatchObject({ ready: false, stages: ['voice'], reason: expect.stringContaining('voice: unknown provider "polly"') })
})

test('readiness is checked anew each time: ready as soon as the config loads', async () => {
  const env: Record<string, string> = {}
  const load = () => configFromEnv(env)
  expect((await checkReadiness(load)).ready).toBe(false)
  Object.assign(env, keys)
  const readiness = await checkReadiness(load)
  expect(readiness.ready).toBe(true)
  expect(describeReadiness(readiness)).toBe('answering calls. Speech to text: deepgram flux-general-en; LLM: openrouter openai/gpt-5.4-mini; text to speech: elevenlabs')
})

test('a call that cannot be answered is logged as missed, naming what is missing but no key', async () => {
  const call = fakeCall()
  const hangUp = vi.fn(async () => {})
  const readiness = { reason: 'Missing environment variable: ELEVENLABS_API_KEY.', stages: ['voice' as const] }
  await declineCall(call, readiness, hangUp, { wait: async () => {} })
  expect(call.append).toHaveBeenCalledWith('system', 'Not answered: the assistant is not set up yet')
  expect(call.finish).toHaveBeenCalledWith({
    outcome: 'hangup', title: 'Missed call: assistant not set up yet', actionItems: [{ text: 'Call back' }],
    summary: 'Linedesk did not answer this call because the assistant is not set up yet. No voice provider is configured yet. Add them under Settings, Providers.',
    fields: [{ label: 'Not set up', value: 'voice' }],
  })
  expect(hangUp).toHaveBeenCalledTimes(1)
})

test('the inbox text lists the missing stages in words, never keys or provider names', () => {
  expect(missedResult(['speech recognition', 'language model', 'voice']).summary).toContain('No speech recognition, language model and voice provider is configured yet.')
  expect(missedResult(['language model', 'voice']).fields).toEqual([{ label: 'Not set up', value: 'language model and voice' }])
  expect(missedResult([]).summary).toContain('Its providers are not configured yet.')
  for (const stages of [['speech recognition', 'language model', 'voice'], []] as const) {
    expect(JSON.stringify(missedResult([...stages]))).not.toMatch(/API_KEY|deepgram|openrouter|elevenlabs|cartesia|openai/i)
  }
})

test('declining never throws: the caller is hung up on even if the API or the room is gone', async () => {
  const hangUp = vi.fn(async () => { throw new Error('room already closed') })
  const call = fakeCall({ append: vi.fn(async () => { throw new TypeError('fetch failed') }) })
  await expect(declineCall(call, { reason: 'not set up', stages: [] }, hangUp, { wait: async () => {} })).resolves.toBeUndefined()
  expect(hangUp).toHaveBeenCalled()

  const finishing = fakeCall({ finish: vi.fn<() => Promise<void>>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue() })
  await declineCall(finishing, { reason: 'not set up', stages: [] }, async () => {}, { wait: async () => {} })
  expect(finishing.finish).toHaveBeenCalledTimes(2)
})
