import type { Assistant } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import type { AgentConfig } from './config.ts'
import { createGreetingCache, greetingKey } from './greeting-cache.ts'
import {
  greetingsToMake,
  greetingVariants,
  openingOf,
  prewarmGreetings,
  storedGreetingText,
} from './greeting-prewarm.ts'
import { greetingVoice } from './pipeline.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stages = {
  stt: { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' },
  llm: { provider: 'openrouter', apiKey: 'or', model: 'm', fallbacks: [] },
  tts: { provider: 'elevenlabs', apiKey: 'el', others: [] },
  recording: { store: 'off' },
} as unknown as AgentConfig

const maya = {
  id: 'as_1',
  greeting: 'Hi {{name|there}}, thanks for calling Brightwater. How can I help?',
  greeting_outside: 'Thanks for calling Brightwater. We are closed right now. How can I help?',
  voice: { provider: 'elevenlabs', voice_id: 'v1' },
  languages: { main: 'en', mode: 'english', allowed: [] },
  call_quality: 'standard',
  talking_speed_pct: 100,
  record_calls: true,
} as unknown as Assistant

test('a greeting with caller details is stored without them: what a call plays when they come late', () => {
  expect(storedGreetingText(maya.greeting)).toBe('Hi there, thanks for calling Brightwater. How can I help?')
  expect(storedGreetingText('Thanks for calling.')).toBe('Thanks for calling.')
})

test('an assistant without a greeting opens with the fallback greeting', () => {
  expect(openingOf({ ...maya, greeting: '' })).toBeTruthy()
  expect(openingOf({ ...maya, greeting: '' })).not.toBe('')
})

test('variants: open and closed, each with the recording notice when the call is recorded', () => {
  const plain = greetingVariants({ assistant: maya, workspaceLanguage: 'en' }).map(a => a.greeting)
  expect(plain).toEqual([maya.greeting, maya.greeting_outside])
  const recorded = greetingVariants({
    assistant: maya,
    recordingNotice: 'This call may be recorded.',
    keepRecording: true,
  })
  expect(recorded).toHaveLength(4)
  expect(recorded[2]!.greeting).toContain('This call may be recorded.')
  // A workspace that keeps no recordings records nothing, so no call says the notice.
  expect(
    greetingVariants({ assistant: maya, recordingNotice: 'This call may be recorded.', keepRecording: false }),
  ).toHaveLength(2)
  // A closure running now: its own greeting instead of the outside-hours one.
  const closure = greetingVariants({
    assistant: maya,
    businessHours: { openNow: false, summary: 'Closed', closure: { greeting: 'We are on vacation until Monday.' } },
  })
  expect(closure.map(a => a.greeting)).toEqual([maya.greeting, 'We are on vacation until Monday.'])
})

test('the keys are the ones a call looks up; a realtime assistant stores nothing', () => {
  const made = greetingsToMake([{ assistant: maya }], stages)
  const text = 'Hi there, thanks for calling Brightwater. How can I help?'
  expect(made.map(m => m.key)).toContain(greetingKey({ ...greetingVoice(stages, { assistant: maya }), text }))
  expect(made).toHaveLength(2)
  // Two numbers on the same assistant: each greeting once.
  expect(greetingsToMake([{ assistant: maya }, { assistant: maya }], stages)).toHaveLength(2)
  const realtimeOnly = { realtime: { model: 'gpt-realtime', voice: 'marin', apiKey: 'k' }, recording: { store: 'off' } }
  expect(
    greetingsToMake([{ assistant: { ...maya, call_quality: 'ultra' } as Assistant }], realtimeOnly as never),
  ).toEqual([])
})

test('a round stores nothing it already has, and never throws when the API fails', async () => {
  const cache = createGreetingCache(mkdtempSync(join(tmpdir(), 'greet-')))
  for (const { key } of greetingsToMake([{ assistant: maya }], stages))
    await cache.put(key, { sampleRate: 24000, channels: 1, samples: new Int16Array([1, 2, 3]) })
  const lines: string[] = []
  await prewarmGreetings(
    { greetings: async () => ({ greetings: [{ assistant: maya }] }) },
    async () => stages,
    cache,
    l => lines.push(l),
  )
  expect(lines).toEqual([])
  await prewarmGreetings(
    {
      greetings: async () => {
        throw new Error('API down')
      },
    },
    async () => stages,
    cache,
    l => lines.push(l),
  )
  expect(lines).toEqual(['greetings not stored in advance: API down'])
})

test('a very long greeting is left to its first call', () => {
  const long = { ...maya, greeting: 'Hello. '.repeat(120), greeting_outside: null } as unknown as Assistant
  expect(greetingsToMake([{ assistant: long }], stages)).toEqual([])
})
