import { expect, test } from 'vitest'
import {
  anyModeLanguages,
  FLUX_LANGUAGES,
  LANGUAGE_SUPPORT,
  LANGUAGES,
  languageCodes,
  providerLanguageCode,
  spokenLanguages,
  unspokenLanguages,
  voiceSpeaks,
} from './languages.ts'

test('LANGUAGES stays code → English name, one per row of the support table', () => {
  expect(LANGUAGES.en).toBe('English')
  expect(LANGUAGES.ko).toBe('Korean')
  expect(Object.keys(LANGUAGES)).toEqual(Object.keys(LANGUAGE_SUPPORT))
  expect(FLUX_LANGUAGES).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  for (const code of languageCodes) expect(providerLanguageCode(code, 'deepgram')).toBe(code)
})

test('a voice provider speaks a language with its model', () => {
  expect(voiceSpeaks({ provider: 'elevenlabs' }, 'vi')).toBe(true)
  expect(voiceSpeaks({ provider: 'elevenlabs', model: 'eleven_flash_v2_5' }, 'hu')).toBe(true)
  expect(voiceSpeaks({ provider: 'elevenlabs', model: 'eleven_multilingual_v2' }, 'hu')).toBe(false)
  expect(voiceSpeaks({ provider: 'elevenlabs', model: 'eleven_multilingual_v2' }, 'ko')).toBe(true)
  expect(voiceSpeaks({ provider: 'elevenlabs', model: 'eleven_flash_v2' }, 'es')).toBe(false)
  expect(voiceSpeaks({ provider: 'cartesia' }, 'ar')).toBe(true)
  expect(voiceSpeaks({ provider: 'cartesia', model: 'sonic-3' }, 'cs')).toBe(true)
  expect(voiceSpeaks({ provider: 'cartesia', model: 'sonic-2' }, 'cs')).toBe(false)
  expect(voiceSpeaks({ provider: 'cartesia', model: 'sonic-2' }, 'pl')).toBe(true)
  expect(voiceSpeaks({ provider: 'openai_tts' }, 'de')).toBe(false)
})

test('the languages offered are those a connected voice provider speaks', () => {
  expect(spokenLanguages([{ provider: 'elevenlabs' }])).toEqual(languageCodes)
  expect(spokenLanguages([{ provider: 'cartesia', model: 'sonic-2' }])).not.toContain('vi')
  // Two providers: what either speaks.
  expect(spokenLanguages([{ provider: 'cartesia', model: 'sonic-2' }, { provider: 'elevenlabs' }])).toContain('vi')
  // No voice provider (a realtime model only): Flux's languages, as before.
  expect(spokenLanguages([])).toEqual(FLUX_LANGUAGES)
})

test('saving names the languages the install cannot answer calls in', () => {
  const spoken = spokenLanguages([{ provider: 'cartesia', model: 'sonic-2' }])
  expect(unspokenLanguages({ main: 'vi', mode: 'allowed', allowed: ['ko', 'hu'] }, spoken)).toEqual(['vi', 'hu'])
  expect(unspokenLanguages({ main: 'en', mode: 'english', allowed: ['hu'] }, spoken)).toEqual([])
  expect(unspokenLanguages({ main: 'ko', mode: 'any', allowed: [] }, spoken)).toEqual([])
})

test('"any language" covers Flux\'s 10 with a Flux model, everything spoken otherwise', () => {
  const spoken = spokenLanguages([{ provider: 'elevenlabs' }])
  expect(anyModeLanguages(spoken, { provider: 'deepgram', model: 'flux-general-en' })).toEqual(FLUX_LANGUAGES)
  // Deepgram without a model set: the agent's default, Flux.
  expect(anyModeLanguages(spoken, { provider: 'deepgram' })).toEqual(FLUX_LANGUAGES)
  expect(anyModeLanguages(spoken, { provider: 'deepgram', model: 'nova-3' })).toEqual(spoken)
  expect(anyModeLanguages(spoken, { provider: 'elevenlabs_stt', model: 'scribe_v2_realtime' })).toEqual(spoken)
  expect(anyModeLanguages(spoken, null)).toEqual(spoken)
})
