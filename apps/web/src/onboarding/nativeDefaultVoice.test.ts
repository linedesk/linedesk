// Onboarding's assistant step for a German workspace: the assistant without a voice of its own takes German's default
// voice (languageDefaultVoices) as its pick, which the step saves (assistantChanges) before the test call, so the test
// call and real calls speak with the voice shown checked, not ElevenLabs' English default (Janik, 2026-11-19).
import { followLanguageDefault, providerDefaultVoices, type VoiceCatalogData } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { languageDefaultPick, usableLanguageDefault } from '../settings/voiceModel.ts'
import { assistantChanges } from './flow.ts'

const SUSI = 'v3V1d2rk6528UrLKRuy8'
const catalog = (state: Partial<VoiceCatalogData['providers'][number]> = {}): VoiceCatalogData => ({
  providers: [{ provider: 'elevenlabs', label: 'ElevenLabs', active: true, configured: true, error: null, ...state }],
  voices: [],
})
const saved = { name: 'Maya', greeting: 'Hallo', voice: { provider: 'elevenlabs', voice_id: '' } }

describe("the assistant step's voice for a German workspace", () => {
  it("is German's default voice, picked and saved with the step", () => {
    const usable = usableLanguageDefault('elevenlabs', 'de', catalog())
    expect(usable).toMatchObject({ provider: 'elevenlabs', id: SUSI, name: 'Susi', language: 'de' })
    const pick = languageDefaultPick(saved.voice, usable)
    expect(pick).toEqual({ provider: 'elevenlabs', voice_id: SUSI })
    expect(assistantChanges(saved, { name: 'Maya', greeting: 'Hallo', voice: pick! })).toEqual({ voice: pick })
  })

  it('described by the provider list when it lists the voice (its sample, its accent)', () => {
    const listed = { provider: 'elevenlabs', id: SUSI, name: 'Susi - Effortless and Confident', description: null }
    expect(usableLanguageDefault('elevenlabs', 'de', catalog(), [listed])).toBe(listed)
  })

  it('keeps a voice the owner picked', () => {
    const own = { provider: 'elevenlabs', voice_id: 'lena' }
    expect(languageDefaultPick(own, usableLanguageDefault('elevenlabs', 'de', catalog()))).toBeNull()
  })

  it('stays the default voice for English, on a free ElevenLabs plan, before the list is read, and without the provider', () => {
    expect(usableLanguageDefault('elevenlabs', 'en', catalog())).toBeNull()
    expect(usableLanguageDefault('elevenlabs', 'de', catalog({ freePlan: true }))).toBeNull()
    expect(usableLanguageDefault('elevenlabs', 'de', undefined)).toBeNull()
    expect(usableLanguageDefault('elevenlabs', 'de', catalog({ configured: false }))).toBeNull()
    expect(usableLanguageDefault('cartesia', 'de', catalog())).toBeNull()
    expect(usableLanguageDefault(null, 'de', catalog())).toBeNull()
  })

  it('follows a country changed on the step while it is untouched; a voice picked stays', () => {
    const adopted = { provider: 'elevenlabs', voice_id: SUSI }
    expect(followLanguageDefault(adopted, 'de', 'fr')?.voice_id).toBe('YxrwjAKoUKULGd0g8K9Y')
    expect(followLanguageDefault(adopted, 'de', 'en')?.voice_id).toBe('')
    expect(followLanguageDefault({ provider: 'elevenlabs', voice_id: 'lena' }, 'de', 'fr')).toBeNull()
    expect(providerDefaultVoices.elevenlabs).not.toBe(SUSI)
  })
})
