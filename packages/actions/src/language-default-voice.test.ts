// The voice an assistant speaks with when it picked none follows its main language (languageDefaultVoices): a German
// assistant speaks with a voice recorded in German, not ElevenLabs' English default (Janik, 2026-11-19).
import { describe, expect, it } from 'vitest'
import { languageCodes } from './languages.ts'
import {
  defaultVoiceFor,
  followLanguageDefault,
  isLanguageDefaultVoice,
  languageDefaultOf,
  languageDefaultVoices,
  providerDefaultVoices,
} from './voices.ts'

const JESSICA = providerDefaultVoices.elevenlabs!
const SUSI = 'v3V1d2rk6528UrLKRuy8'
const LUCIE = 'YxrwjAKoUKULGd0g8K9Y'

describe('the default voice per language', () => {
  it('German speaks with Susi, a voice recorded in German; English keeps Jessica', () => {
    expect(defaultVoiceFor('elevenlabs', 'de')).toBe(SUSI)
    expect(languageDefaultOf('elevenlabs', 'de')).toMatchObject({ name: 'Susi', language: 'de', gender: 'female' })
    expect(defaultVoiceFor('elevenlabs', 'en')).toBe(JESSICA)
    expect(defaultVoiceFor('elevenlabs', null)).toBe(JESSICA)
    expect(defaultVoiceFor('elevenlabs', 'fr')).toBe(LUCIE)
  })

  it('every language but English has one at ElevenLabs, recorded in that language and native in it', () => {
    for (const code of languageCodes.filter(c => c !== 'en')) {
      const voice = languageDefaultOf('elevenlabs', code)
      expect(voice, code).not.toBeNull()
      expect(voice!.language).toBe(code)
      expect(voice!.languages).toEqual([{ code, accent: null, native: true }])
    }
    const ids = Object.values(languageDefaultVoices.elevenlabs!).map(v => v!.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a provider without language defaults (Cartesia) and an unknown provider fall back cleanly', () => {
    expect(defaultVoiceFor('cartesia', 'de')).toBe(providerDefaultVoices.cartesia)
    expect(defaultVoiceFor('someone_else', 'de')).toBeUndefined()
    expect(languageDefaultOf('someone_else', 'de')).toBeNull()
  })

  it('knows its voices', () => {
    expect(isLanguageDefaultVoice('elevenlabs', SUSI)).toBe(true)
    expect(isLanguageDefaultVoice('cartesia', SUSI)).toBe(false)
    expect(isLanguageDefaultVoice('elevenlabs', JESSICA)).toBe(false)
  })
})

describe('a new main language moves only an untouched default voice', () => {
  it("the old language's default becomes the new one's, with its model", () => {
    const susi = { provider: 'elevenlabs', voice_id: SUSI, model: 'eleven_flash_v2_5' }
    expect(followLanguageDefault(susi, 'de', 'fr')).toEqual({ ...susi, voice_id: LUCIE })
    // English has no language default: the provider's default voice ('').
    expect(followLanguageDefault(susi, 'de', 'en')).toEqual({ ...susi, voice_id: '' })
  })

  it('a voice picked by name stays, and so do the default (it follows on its own) and an unchanged language', () => {
    const lena = { provider: 'elevenlabs', voice_id: 'lena' }
    expect(followLanguageDefault(lena, 'de', 'fr')).toBeNull()
    // Susi picked for a French assistant is not French's default: she stays when the language changes again.
    expect(followLanguageDefault({ provider: 'elevenlabs', voice_id: SUSI }, 'fr', 'es')).toBeNull()
    expect(followLanguageDefault({ provider: 'elevenlabs', voice_id: '' }, 'de', 'fr')).toBeNull()
    expect(followLanguageDefault({ provider: 'elevenlabs', voice_id: SUSI }, 'de', 'de')).toBeNull()
  })
})
