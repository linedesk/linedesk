// A voice catalog for tests and local screenshots of the voice picker: ElevenLabs (in use, a paid plan) with its
// curated English voices and Voice Library voices verified in German, Dutch, Portuguese and English, and Cartesia.
// Alexandra is listed twice, once per language, as an older API did and a catalog kept in the browser still can.
import type { CatalogVoice, VoiceCatalogData, VoiceLanguage, VoiceOptionsData } from '@linedesk/actions'

const native = (code: string, accent: string | null = null): VoiceLanguage => ({ code, accent, native: true })
const voice = (
  id: string,
  name: string,
  gender: string,
  languages: VoiceLanguage[],
  extra: Partial<CatalogVoice> = {},
): CatalogVoice => ({
  provider: 'elevenlabs',
  id,
  name,
  description: null,
  languages,
  language: languages[0]?.code ?? null,
  gender,
  accent: languages[0]?.accent ?? null,
  ...extra,
})

/** Call quality on an install without billing: the three levels, no prices, anyone who edits may pick each. */
export const NO_PRICES: VoiceOptionsData['callQuality'] = {
  levels: (['standard', 'premium', 'ultra'] as const).map(level => ({
    level,
    centsPerMinute: null,
    models: [],
    voiceModels: {},
    realtimeModels: [],
    defaults: { llm: null, voice: {}, realtime: null },
  })),
  defaultLevel: 'standard',
  mayChange: true,
  mayRaise: true,
  partnerManaged: false,
  llmProvider: null,
}

export const SWITCH_OPTIONS: VoiceOptionsData = {
  provider: 'elevenlabs',
  callQuality: NO_PRICES,
  voices: [
    {
      id: 'cgSgspJ2msm6clMCkdW9',
      name: 'Jessica',
      description: 'Warm and bright, female',
      languages: [native('en', 'american')],
    },
    {
      id: 'cjVigY5qzO86Huf0OWal',
      name: 'Eric',
      description: 'Smooth and trustworthy, male',
      languages: [native('en', 'american')],
    },
  ],
  clones: [],
  canClone: false,
  defaultVoice: { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica' },
}

export const SWITCH_CATALOG: VoiceCatalogData = {
  providers: [
    { provider: 'elevenlabs', label: 'ElevenLabs', active: true, configured: true, error: null },
    { provider: 'cartesia', label: 'Cartesia', active: false, configured: true, error: null },
  ],
  voices: [
    voice('cgSgspJ2msm6clMCkdW9', 'Jessica', 'female', [native('en', 'american')]),
    voice('cjVigY5qzO86Huf0OWal', 'Eric', 'male', [native('en', 'american')]),
    voice('alexandra', 'Alexandra', 'female', [native('de', 'austrian'), native('nl'), native('pt')]),
    // The same voice once more, as listed for Dutch by an older API: only some of its languages, Dutch first.
    voice('alexandra', 'Alexandra', 'female', [native('nl'), native('de')], { language: 'nl', accent: null }),
    voice('lena', 'Lena - Customer Support', 'female', [native('de', 'standard'), native('en', 'british')]),
    voice('jonas', 'Jonas', 'male', [native('de')]),
    voice('sanne', 'Sanne', 'female', [native('nl')]),
    voice('daan', 'Daan', 'male', [native('nl'), native('en')]),
    voice('beatriz', 'Beatriz', 'female', [native('pt', 'brazilian'), native('en')]),
    voice('klaus', 'Klaus', 'male', [native('de'), { code: 'en', accent: 'german', native: false }], {
      provider: 'cartesia',
    }),
    voice('sophie', 'Sophie', 'female', [native('en', 'american'), { code: 'de', accent: 'american', native: false }], {
      provider: 'cartesia',
    }),
  ],
}
