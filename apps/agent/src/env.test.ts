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

const assistant = {
  name: 'Maya', disclose_ai: true, greeting: 'Thanks for calling Brightwater. This is Maya. How can I help?',
  business_profile: { description: 'Family-run plumbing company in Portland.', services: ['Leak repair', 'Water heaters'], hours: 'Mon–Fri 7 am – 6 pm', faqs: [{ q: 'Do you serve Lake Oswego?', a: 'Yes.' }] },
} as Assistant

test('the system prompt is built from name, greeting and the free-text instructions', () => {
  const instructions = 'We are a plumbing company in Portland. We do not work on Sundays.\nAlways ask for the address.'
  const prompt = buildInstructions({ ...assistant, business_profile: { ...assistant.business_profile, instructions } } as Assistant)
  expect(prompt).toContain('You are Maya')
  expect(prompt).toContain('You have already opened the call with: "Thanks for calling Brightwater. This is Maya. How can I help?"')
  expect(prompt).toContain(`What the business wants you to know and do:\n${instructions}`)
  expect(prompt).not.toContain('Services: Leak repair') // the free text replaces the structured fields
})

test('without instructions the prompt falls back to the structured business profile', () => {
  for (const instructions of [undefined, '', '   ']) {
    const prompt = buildInstructions({ ...assistant, business_profile: { ...assistant.business_profile, instructions } } as Assistant)
    expect(prompt).toContain('About: Family-run plumbing company in Portland.')
    expect(prompt).toContain('Services: Leak repair, Water heaters')
    expect(prompt).toContain('Q: Do you serve Lake Oswego?\nA: Yes.')
    expect(prompt).not.toContain('Address:')
  }
})

test('the prompt holds the product rules: messages only, no transfer, no booking, urgent is a flag', () => {
  const prompt = buildInstructions(assistant)
  expect(prompt).toContain('you are an AI assistant')
  expect(buildInstructions({ ...assistant, disclose_ai: false })).not.toContain('you are an AI assistant')
  expect(prompt).toContain('asks for a person, you cannot transfer the call: take a message')
  expect(prompt).toContain('wants an appointment, you cannot book it: ask which day and time they prefer and take a message')
  expect(prompt).toContain('use the flag_urgent tool right away')
  expect(prompt).not.toMatch(/record/i) // no recording notice for now
  expect(buildInstructions(null)).toContain('take_message')
  expect(buildInstructions({ ...assistant, greeting: '' })).not.toContain('already opened the call')
})
