import { expect, test } from 'vitest'
import { parseVoiceFailure, type VoiceFailure, voiceFailureReason, voiceFailureText } from './voice-failure.ts'

test('the reason: status first, then the provider text', () => {
  expect(voiceFailureReason({ status: 401, text: 'quota_exceeded' })).toBe('quota')
  expect(voiceFailureReason({ status: 402 })).toBe('quota')
  expect(voiceFailureReason({ status: 429, text: 'You exceeded your current quota' })).toBe('quota')
  expect(voiceFailureReason({ status: 401 })).toBe('auth')
  expect(voiceFailureReason({ text: 'Invalid API key' })).toBe('auth')
  expect(voiceFailureReason({ status: 404 })).toBe('not_found')
  expect(voiceFailureReason({ text: 'voice_not_found' })).toBe('not_found')
  expect(voiceFailureReason({ status: 504 })).toBe('timeout')
  expect(voiceFailureReason({ status: 403, text: 'missing_permissions: text_to_speech' })).toBe('permission')
  expect(voiceFailureReason({ status: 422, text: 'invalid voice settings' })).toBe('config')
  expect(voiceFailureReason({ text: 'Request timed out.' })).toBe('timeout')
  expect(voiceFailureReason({ text: 'TTS stream completed but no audio was received' })).toBe('no_output')
  expect(voiceFailureReason({ status: 500, text: 'boom' })).toBe('network')
  expect(voiceFailureReason({ text: 'something odd' })).toBe('unknown')
})

const quota: VoiceFailure = { stage: 'tts', provider: 'elevenlabs', reason: 'quota', message: 'quota_exceeded' }

test('the operator learns which stage and provider, why and where to fix it; everyone else no provider', () => {
  expect(voiceFailureText(quota, true)).toBe(
    "The assistant's voice: ElevenLabs has used up its quota or credit. Add credit or raise the limit at ElevenLabs, then test it under Server admin › Providers.",
  )
  expect(voiceFailureText({ ...quota, reason: 'no_output' }, true)).toMatch(
    /^The assistant's voice: ElevenLabs answered with nothing\. Try again/,
  )
  expect(voiceFailureText({ stage: 'llm', provider: 'openrouter', reason: 'auth', message: '' }, true)).toBe(
    "The assistant's language model: OpenRouter rejected the key it was given. Enter a valid key under Server admin › Providers.",
  )
  const plain = voiceFailureText(quota, false)
  expect(plain).toBe("The assistant's voice isn't working right now. Ask whoever runs this server.")
  expect(plain).not.toMatch(/ElevenLabs|quota|Server admin|Admin/)
})

test('the attribute round-trips; anything else is no failure', () => {
  expect(parseVoiceFailure(JSON.stringify(quota))).toEqual(quota)
  expect(parseVoiceFailure('elevenlabs')).toBeNull()
  expect(parseVoiceFailure(JSON.stringify({ ...quota, stage: 'phone' }))).toBeNull()
  expect(parseVoiceFailure(undefined)).toBeNull()
})
