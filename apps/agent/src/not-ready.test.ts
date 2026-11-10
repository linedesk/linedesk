import { expect, test, vi } from 'vitest'
import type { CallSession } from './call-session.ts'
import { loadAgentConfig } from './config.ts'
import { checkReadiness, declineCall, describeReadiness, missedResult } from './not-ready.ts'

const keys = { DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }
const fakeCall = (over: Partial<CallSession> = {}) =>
  ({ callId: 'call_1', workspaceId: 'ws_1', append: vi.fn(async () => {}), finish: vi.fn(async () => {}), ...over }) as unknown as CallSession & { append: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }

test('without keys the agent is not ready, and says in one line what is missing', async () => {
  const readiness = await checkReadiness(() => loadAgentConfig({}))
  expect(readiness).toEqual({ ready: false, reason: 'Missing environment variables: DEEPGRAM_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_API_KEY. Set them in .env (see .env.example).' })
  const line = describeReadiness(readiness)
  expect(line).toContain('not answering calls yet: Missing environment variables: DEEPGRAM_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_API_KEY.')
  expect(line).toContain('checked again at every call')
  expect(line).not.toContain('\n')
})

test('a wrong provider name is also "not ready", not a crash', async () => {
  const readiness = await checkReadiness(() => loadAgentConfig({ ...keys, TTS_PROVIDER: 'polly' }))
  expect(readiness).toMatchObject({ ready: false, reason: expect.stringContaining('unknown TTS_PROVIDER "polly"') })
})

test('readiness is checked anew each time: ready as soon as the config loads', async () => {
  const env: Record<string, string> = {}
  const load = () => loadAgentConfig(env)
  expect((await checkReadiness(load)).ready).toBe(false)
  Object.assign(env, keys)
  const readiness = await checkReadiness(load)
  expect(readiness.ready).toBe(true)
  expect(describeReadiness(readiness)).toBe('answering calls. Speech to text: deepgram flux-general-en; LLM: openrouter openai/gpt-5.4-mini; text to speech: elevenlabs')
})

test('a call that cannot be answered is logged as missed and the caller is hung up on', async () => {
  const call = fakeCall()
  const hangUp = vi.fn(async () => {})
  await declineCall(call, 'Missing environment variable: ELEVENLABS_API_KEY.', hangUp, { wait: async () => {} })
  expect(call.append).toHaveBeenCalledWith('system', 'Not answered: the assistant is not set up yet')
  expect(call.finish).toHaveBeenCalledWith(missedResult)
  expect(hangUp).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(missedResult)).not.toContain('API_KEY') // key names are for the operator's log, not the inbox
})

test('declining never throws: the caller is hung up on even if the API or the room is gone', async () => {
  const hangUp = vi.fn(async () => { throw new Error('room already closed') })
  const call = fakeCall({ append: vi.fn(async () => { throw new TypeError('fetch failed') }) })
  await expect(declineCall(call, 'not set up', hangUp, { wait: async () => {} })).resolves.toBeUndefined()
  expect(hangUp).toHaveBeenCalled()

  const finishing = fakeCall({ finish: vi.fn<() => Promise<void>>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue() })
  await declineCall(finishing, 'not set up', async () => {}, { wait: async () => {} })
  expect(finishing.finish).toHaveBeenCalledTimes(2)
})
