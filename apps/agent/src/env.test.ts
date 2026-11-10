import type { Assistant } from '@callfront/db/types'
import { expect, test } from 'vitest'
import { DEV_LIVEKIT_SECRET, requireEnv, requireLivekitEnv } from './env.ts'
import { buildInstructions } from './prompt.ts'

test('requireEnv names every missing variable', () => {
  const env = { LIVEKIT_URL: 'ws://localhost:7880', AGENT_API_TOKEN: 't', OPENAI_API_KEY: 'o' }
  expect(() => requireEnv(['AGENT_API_TOKEN', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY'], env)).toThrow('Missing environment variables: DEEPGRAM_API_KEY, CARTESIA_API_KEY.')
  expect(() => requireEnv(['OPENAI_API_KEY', 'CARTESIA_API_KEY'], env)).toThrow('Missing environment variable: CARTESIA_API_KEY.')
  expect(requireEnv(['LIVEKIT_URL'], env)).toEqual({ LIVEKIT_URL: 'ws://localhost:7880' })
})

test('the development LiveKit secret is refused outside local development', () => {
  const local = { LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: DEV_LIVEKIT_SECRET }
  expect(requireLivekitEnv(local).LIVEKIT_API_SECRET).toBe(DEV_LIVEKIT_SECRET)
  expect(requireLivekitEnv({ ...local, LIVEKIT_URL: 'ws://127.0.0.1:7880' })).toBeTruthy()
  expect(() => requireLivekitEnv({ ...local, NODE_ENV: 'production' })).toThrow('still the development default')
  expect(() => requireLivekitEnv({ ...local, LIVEKIT_URL: 'wss://livekit.example.com' })).toThrow('still the development default')
  expect(() => requireLivekitEnv({ ...local, LIVEKIT_URL: 'ws://localhost.evil.com:7880' })).toThrow('still the development default')
  expect(requireLivekitEnv({ ...local, LIVEKIT_URL: 'wss://livekit.example.com', LIVEKIT_API_SECRET: 'a-real-secret-of-at-least-32-characters' })).toBeTruthy()
  expect(() => requireLivekitEnv({ LIVEKIT_URL: 'ws://localhost:7880' })).toThrow('Missing environment variables: LIVEKIT_API_KEY, LIVEKIT_API_SECRET.')
})

test('the system prompt carries the assistant name and business profile', () => {
  const assistant = {
    name: 'Maya', disclose_ai: true,
    business_profile: { description: 'Family-run plumbing company in Portland.', services: ['Leak repair', 'Water heaters'], hours: 'Mon–Fri 7 am – 6 pm', faqs: [{ q: 'Do you serve Lake Oswego?', a: 'Yes.' }] },
  } as Assistant
  const prompt = buildInstructions(assistant)
  expect(prompt).toContain('You are Maya')
  expect(prompt).toContain('About: Family-run plumbing company in Portland.')
  expect(prompt).toContain('Services: Leak repair, Water heaters')
  expect(prompt).toContain('Q: Do you serve Lake Oswego?\nA: Yes.')
  expect(prompt).toContain('you are an AI assistant')
  expect(prompt).not.toContain('Address:')
  expect(buildInstructions({ ...assistant, disclose_ai: false })).not.toContain('you are an AI assistant')
  expect(buildInstructions(null)).toContain('take_message')
})
