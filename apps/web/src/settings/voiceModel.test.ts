import { describe, expect, it, test } from 'vitest'
import {
  ASSISTANT_FILTER,
  byLanguageFit,
  cloneProblem,
  facetValues,
  fileToBase64,
  filterVoices,
  followLanguages,
  languageGap,
  languageLabel,
  languagesOf,
  missingNativeNote,
  NO_FILTER,
  type PickerVoice,
  previewProblem,
  previewUrl,
  suggestedForLanguage,
  voiceFacts,
  voiceForLanguages,
  voiceInEffect,
  voiceWords,
} from './voiceModel.ts'

describe('voice picker', () => {
  it("names and describes a voice in the reader's language (LIN-648)", () => {
    const susi: PickerVoice = {
      provider: 'elevenlabs',
      id: 'v3V1d2rk6528UrLKRuy8',
      name: 'Susi - Effortless and Confident',
      description: 'Imagine the voice of the telemarketing assistant',
      providerWords: true,
    }
    expect(voiceWords(susi, 'en')).toEqual({ name: susi.name, description: susi.description })
    expect(voiceWords(susi, 'de')).toEqual({ name: 'Susi', description: null })
    // A clone: the workspace's own name, kept for every reader.
    const clone = { ...susi, name: 'Mike - shop', description: 'Cloned', providerWords: false }
    expect(voiceWords(clone, 'de')).toEqual({ name: 'Mike - shop', description: 'Cloned' })
    // A curated voice: described by its key, whatever the provider's list says.
    const jessica = { ...susi, id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica - Playful', description: 'Young' }
    expect(voiceWords(jessica, 'de')).toEqual({ name: 'Jessica', description: 'Warm and bright, female' })
  })
  it('a voice of a provider without a key does not apply: the default is shown', () => {
    const jessica = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }
    expect(voiceInEffect(jessica, ['elevenlabs'])).toBe('elevenlabs:cgSgspJ2msm6clMCkdW9')
    expect(voiceInEffect({ provider: 'cartesia', voice_id: 'abc-123' }, ['elevenlabs', 'cartesia'])).toBe(
      'cartesia:abc-123',
    )
    expect(voiceInEffect({ provider: 'cartesia', voice_id: 'abc-123' }, ['elevenlabs'])).toBe('')
    expect(voiceInEffect({ provider: 'elevenlabs', voice_id: '' }, ['elevenlabs'])).toBe('')
  })
  it('previews name the provider only when it is not the one in effect', () => {
    expect(previewUrl('cgSgspJ2msm6clMCkdW9')).toBe('/v1/voices/preview/cgSgspJ2msm6clMCkdW9')
    expect(previewUrl('abc-123', 'cartesia')).toBe('/v1/voices/preview/abc-123?provider=cartesia')
  })
  it('previews name the main language when it is not English', () => {
    expect(previewUrl('v1', null, 'en')).toBe('/v1/voices/preview/v1')
    expect(previewUrl('v1', null, 'de')).toBe('/v1/voices/preview/v1?language=de')
    expect(previewUrl('v1', 'cartesia', 'ja')).toBe('/v1/voices/preview/v1?provider=cartesia&language=ja')
  })
  it('more voices: search by name, description, accent or language, and filters', () => {
    const voices = [
      {
        provider: 'elevenlabs',
        id: '1',
        name: 'Jessica',
        description: 'Warm and bright',
        language: 'en',
        gender: 'female',
        accent: 'american',
      },
      {
        provider: 'elevenlabs',
        id: '2',
        name: 'Lea',
        description: 'Young Swiss voice',
        language: 'de',
        gender: 'female',
        accent: 'standard',
      },
      {
        provider: 'cartesia',
        id: '3',
        name: 'Brooke',
        description: null,
        language: 'en',
        gender: 'female',
        accent: null,
      },
      {
        provider: 'cartesia',
        id: '4',
        name: 'Ronald',
        description: 'Calm narrator',
        language: 'en',
        gender: 'male',
        accent: 'British',
      },
    ]
    const ids = (filter: Partial<typeof NO_FILTER>) => filterVoices(voices, { ...NO_FILTER, ...filter }).map(v => v.id)
    expect(ids({})).toEqual(['1', '2', '3', '4'])
    expect(ids({ query: 'swiss' })).toEqual(['2'])
    expect(ids({ query: 'german' })).toEqual(['2'])
    expect(ids({ query: 'cal narr' })).toEqual(['4'])
    expect(ids({ provider: 'cartesia', gender: 'female' })).toEqual(['3'])
    expect(ids({ accent: 'british' })).toEqual(['4'])
    expect(ids({ language: 'de', query: 'jess' })).toEqual([])
    expect(facetValues(voices, 'language')).toEqual([
      { value: 'en', label: 'English' },
      { value: 'de', label: 'German' },
    ])
    expect(facetValues(voices, 'accent').map(f => f.label)).toEqual(['American', 'British', 'Standard'])
    expect(voiceFacts(voices[3]!, 'en', [], 'Cartesia')).toBe('Male · British · Native English · Cartesia')
    expect(voiceFacts(voices[2]!, 'en')).toBe('Female · Native English')
    expect(voiceFacts(voices[1]!, 'en')).toBe('Female · English with a German accent')
    expect([...voices].sort(byLanguageFit('en')).map(v => v.name)).toEqual(['Brooke', 'Jessica', 'Ronald', 'Lea'])
    expect([...voices].sort(byLanguageFit('de')).map(v => v.name)).toEqual(['Lea', 'Brooke', 'Jessica', 'Ronald'])
  })
  it('cloning needs a name, a recording of a known type up to 10 MB, and consent', () => {
    const file = { size: 1_000_000, type: 'audio/mpeg' }
    expect(cloneProblem({ name: 'Mike', file, consent: true })).toBeNull()
    expect(cloneProblem({ name: ' ', file, consent: true })).toMatch(/name/)
    expect(cloneProblem({ name: 'Mike', file: null, consent: true })).toMatch(/recording/)
    expect(cloneProblem({ name: 'Mike', file: { ...file, type: 'video/mp4' }, consent: true })).toMatch(/MP3/)
    expect(cloneProblem({ name: 'Mike', file: { ...file, size: 11 * 1024 * 1024 }, consent: true })).toMatch(/11\.0 MB/)
    expect(cloneProblem({ name: 'Mike', file, consent: false })).toMatch(/agreed/)
  })
  it('reads a recording as base64', async () => {
    expect(await fileToBase64(new Blob(['RIFF']))).toBe('UklGRg==')
  })
})

test('a sample that does not come back says why, and how to fix it where there is a fix', () => {
  expect(previewProblem(409)).toBe('Add a voice provider key in Server admin › Providers to hear samples.')
  expect(previewProblem(0)).toMatch(/Can't reach the server/)
  expect(previewProblem(401)).toMatch(/signed out/)
  expect(previewProblem(429)).toMatch(/this hour/)
  expect(previewProblem(404)).toMatch(/does not know this voice/)
  expect(previewProblem(403, 'missing permission call:read')).toBe('missing permission call:read')
  expect(previewProblem(502, 'voice preview failed (500): boom')).toBe('The voice provider did not answer. Try again.')
  expect(
    previewProblem(
      502,
      'quota_exceeded',
      'ElevenLabs has used up its quota or credit. Ask whoever runs this server to add credit.',
    ),
  ).toMatch(/^ElevenLabs has used up/)
})

describe('the voice when the main language changes (no other languages)', () => {
  const voices = [
    { provider: 'elevenlabs', id: 'jessica', name: 'Jessica', description: null, language: 'en', gender: 'female' },
    { provider: 'cartesia', id: 'lucia', name: 'Lucía', description: null, language: 'es', gender: 'female' },
    { provider: 'elevenlabs', id: 'mateo', name: 'Mateo', description: null, language: 'es-MX', gender: 'male' },
    { provider: 'elevenlabs', id: 'valeria', name: 'Valeria', description: null, language: 'es', gender: 'female' },
    { provider: 'elevenlabs', id: 'ana', name: 'Ana', description: 'Narration', language: 'es', gender: 'female' },
    {
      provider: 'elevenlabs',
      id: 'carla',
      name: 'Carla - Customer Care Agent',
      description: null,
      language: 'es',
      gender: 'female',
    },
  ]
  const [jessica, lucia, mateo] = voices
  const eric = { provider: 'elevenlabs', id: 'eric', name: 'Eric', description: null, language: 'en', gender: 'male' }
  it('another language: a voice that performs it; the same provider, the same gender and a voice for calls first', () => {
    expect(voiceForLanguages(voices, 'es', [], jessica!)).toMatchObject({ id: 'carla' })
    expect(voiceForLanguages([...voices, eric], 'es', [], eric)).toMatchObject({ id: 'mateo' })
    expect(voiceForLanguages(voices, 'es', [], { ...jessica!, provider: 'cartesia' })).toMatchObject({ id: 'lucia' })
  })
  it('keeps the voice when none performs the language, the current one does, or its languages are unknown', () => {
    expect(voiceForLanguages(voices, 'ja', [], jessica!)).toBeNull()
    expect(voiceForLanguages(voices, 'es', [], mateo!)).toBeNull()
    expect(voiceForLanguages(voices, 'es', [], lucia!)).toBeNull()
    expect(voiceForLanguages(voices, 'es', [], { ...jessica!, language: null })).toBeNull()
    expect(voiceForLanguages(voices, 'es', [], null)).toBeNull()
  })
  it('English: the default voice first among the voices of the same gender that perform it', () => {
    const defaultVoice = jessica!
    const toEnglish = (voice_id: string) =>
      followLanguages({
        voices: [...voices, eric],
        curated: [jessica!, eric],
        defaultVoice,
        current: { provider: 'elevenlabs', voice_id },
        main: 'en',
        others: [],
      })
    // The default voice is picked as the default (no id), as picking its row does.
    expect(toEnglish('valeria')).toEqual({
      voice: { provider: 'elevenlabs', voice_id: '' },
      name: 'Jessica',
      speaks: ['en'],
    })
    expect(toEnglish('mateo')).toEqual({
      voice: { provider: 'elevenlabs', voice_id: 'eric' },
      name: 'Eric',
      speaks: ['en'],
    })
    expect(
      followLanguages({
        voices,
        curated: [jessica!],
        defaultVoice,
        current: { provider: 'elevenlabs', voice_id: 'jessica' },
        main: 'en',
        others: [],
      }),
    ).toBeNull()
  })
})

describe('Voice Library voices for each language (ElevenLabs on a paid plan)', () => {
  // The catalog as the API sends it: the account's English voices plus native library voices per language.
  const library = (id: string, name: string, language: string, gender: string, description: string | null = null) => ({
    provider: 'elevenlabs',
    id,
    name,
    description,
    language,
    gender,
  })
  const jessica = {
    provider: 'elevenlabs',
    id: 'cgSgspJ2msm6clMCkdW9',
    name: 'Jessica',
    description: null,
    language: 'en',
    gender: 'female',
  }
  const eric = { provider: 'elevenlabs', id: 'eric', name: 'Eric', description: null, language: 'en', gender: 'male' }
  const voices = [
    jessica,
    eric,
    library('cristina', 'Cristina Campos - Friendly and Soft', 'es', 'female', 'A warm Argentinian voice.'),
    library('regina', 'Regina - Contact Center', 'es', 'female'),
    library('diego', 'Diego - Calm and Clear', 'es', 'male'),
    library('lucie', 'Lucie - Support Agent', 'fr', 'female'),
    library('marcel', 'Marcel - Warm and Conversational', 'fr', 'male'),
    library('kaori', 'Kaori - Relatable and Friendly Voice', 'ja', 'female'),
    { provider: 'cartesia', id: 'sofia', name: 'Sofía', description: null, language: 'es', gender: 'female' },
  ]

  it('every supported language gets a voice that performs it when the main language changes', () => {
    expect(voiceForLanguages(voices, 'es', [], jessica)).toMatchObject({ id: 'regina' })
    expect(voiceForLanguages(voices, 'fr', [], jessica)).toMatchObject({ id: 'lucie' })
    expect(voiceForLanguages(voices, 'ja', [], jessica)).toMatchObject({ id: 'kaori' })
  })

  it('a male voice stays male in the new language, where the language has one', () => {
    expect(voiceForLanguages(voices, 'es', [], eric)).toMatchObject({ id: 'diego' })
    expect(voiceForLanguages(voices, 'fr', [], eric)).toMatchObject({ id: 'marcel' })
    expect(voiceForLanguages(voices, 'ja', [], eric)).toMatchObject({ id: 'kaori' })
  })

  it('Suggested: the provider in use first, a voice made for calls before the rest, never another language', () => {
    expect(suggestedForLanguage(voices, [], 'es', [], 'elevenlabs', 6)?.map(v => v.id)).toEqual([
      'regina',
      'cristina',
      'diego',
      'sofia',
    ])
    expect(suggestedForLanguage(voices, [], 'es', [], 'cartesia', 6)?.[0]).toMatchObject({ id: 'sofia' })
    expect(suggestedForLanguage(voices, [], 'de', [], 'elevenlabs', 6)).toBeNull()
  })
})

/** A voice of the catalog as the API sends it now: every language, native or with its accent. */
const voice = (id: string, languages: PickerVoice['languages'], extra: Partial<PickerVoice> = {}): PickerVoice => ({
  provider: 'elevenlabs',
  id,
  name: id,
  description: null,
  languages,
  ...extra,
})
const AMERICAN = [{ code: 'en', accent: 'american', native: true }]

describe('voices and the assistant’s languages', () => {
  const jessica = voice('Jessica', AMERICAN, { gender: 'female' })
  const lena = voice('Lena', [{ code: 'de', accent: 'standard', native: true }], { gender: 'female' })
  const lucia = voice('Lucía', [{ code: 'es', accent: 'latin american', native: true }])
  const skylar = voice(
    'Skylar',
    [
      { code: 'en', accent: 'american', native: true },
      { code: 'es', accent: 'mexican', native: false },
      { code: 'de', accent: 'german', native: false },
    ],
    { provider: 'cartesia' },
  )
  const pierre = voice('Pierre', [{ code: 'fr', accent: null, native: true }])
  const clone = voice('Mine', [])

  it('each row says how the voice speaks the main language', () => {
    expect(languageLabel(lena, 'de')).toBe('Native German')
    expect(languageLabel(jessica, 'de')).toBe('German with an American accent')
    expect(languageLabel(lucia, 'de')).toBe('German with a Latin American accent')
    // Cartesia's own accent for the language says more than the voice's; "a German accent" for German says nothing.
    expect(languageLabel(skylar, 'es')).toBe('Spanish with a Mexican accent')
    expect(languageLabel(skylar, 'de')).toBe('German with an American accent')
    // No accent given: the voice's own language stands for it.
    expect(languageLabel(pierre, 'de')).toBe('German with a French accent')
    expect(languageLabel(voice('Plain', [{ code: 'de', accent: 'standard', native: true }]), 'it')).toBe(
      'Italian with a German accent',
    )
    expect(languageLabel(voice('Odd', [{ code: 'de', accent: null, native: false }]), 'de')).toBe('German, non-native')
    expect(languageLabel(clone, 'de')).toBeNull()
    expect(languageLabel(jessica, 'en')).toBe('Native English')
  })

  it('older data (language and accent only) is read as that language, native', () => {
    expect(
      languagesOf({ provider: 'x', id: '1', name: 'A', description: null, language: 'es-MX', accent: 'Mexican' }),
    ).toEqual([{ code: 'es', accent: 'mexican', native: true }])
    expect(languagesOf({ provider: 'x', id: '1', name: 'A', description: null })).toEqual([])
    expect(
      languageLabel({ provider: 'x', id: '1', name: 'A', description: null, language: 'en', accent: 'british' }, 'de'),
    ).toBe('German with a British accent')
  })

  it('the main language first, then as many of the other languages as the voice performs, then the rest', () => {
    // 0: performs all; 1 per other language it lacks; without the main language, more than all of those.
    expect([jessica, lena, lucia, skylar].map(v => languageGap(v, 'de', ['es']))).toEqual([3, 1, 2, 3])
    expect([jessica, skylar, lucia, lena, pierre].sort(byLanguageFit('de', ['es', 'fr'])).map(v => v.id)).toEqual([
      'Lena',
      'Lucía',
      'Pierre',
      'Jessica',
      'Skylar',
    ])
  })

  it('More voices opens on the assistant’s languages; All languages shows every voice', () => {
    const all = [jessica, lena, lucia, skylar, pierre]
    const ids = (filter = ASSISTANT_FILTER) => filterVoices(all, filter, 'de', ['es']).map(v => v.id)
    // No voice performs German and Spanish: the closest, the ones that perform German. Skylar speaks both only with
    // an accent (Cartesia: not native), which does not count.
    expect(ids()).toEqual(['Lena'])
    const both = voice('Mia', [
      { code: 'de', accent: null, native: true },
      { code: 'es', accent: null, native: true },
    ])
    expect(filterVoices([...all, both], ASSISTANT_FILTER, 'de', ['es']).map(v => v.id)).toEqual(['Mia'])
    // None performs even the main language: every voice that speaks one of them.
    expect(filterVoices(all, ASSISTANT_FILTER, 'ja', ['es']).map(v => v.id)).toEqual(['Lucía', 'Skylar'])
    expect(ids(NO_FILTER)).toEqual(['Jessica', 'Lena', 'Lucía', 'Skylar', 'Pierre'])
    expect(ids({ ...NO_FILTER, language: 'fr' })).toEqual(['Pierre'])
    expect(ids({ ...NO_FILTER, query: 'spanish' })).toEqual(['Lucía', 'Skylar'])
    expect(facetValues(all, 'language').map(f => f.label)).toEqual(['English', 'French', 'German', 'Spanish'])
  })

  it('Suggested: the voices that perform the main language, the ones that perform the others too first', () => {
    const curated = [jessica, voice('Eric', AMERICAN, { gender: 'male' })]
    const catalog = [
      jessica,
      lena,
      lucia,
      pierre,
      voice('Jonas - Support', [{ code: 'de', accent: null, native: true }]),
    ]
    expect(suggestedForLanguage(catalog, curated, 'de', ['es'], 'elevenlabs', 6)?.map(v => v.id)).toEqual([
      'Jonas - Support', // a voice made for calls first among the ones that perform German
      'Lena',
    ])
    const deEs = voice('Sofia', [
      { code: 'es', accent: null, native: true },
      { code: 'de', accent: null, native: true },
    ])
    expect(suggestedForLanguage([...catalog, deEs], curated, 'de', ['es'], 'elevenlabs', 2)?.map(v => v.id)).toEqual([
      'Sofia', // performs German and Spanish
      'Jonas - Support',
    ])
    // English with another language: the voices that perform English, the ones that also perform it first.
    const enDe = voice('Anna', [...AMERICAN, { code: 'de', accent: null, native: true }])
    expect(suggestedForLanguage([...catalog, enDe], curated, 'en', ['de'], 'elevenlabs', 6)?.map(v => v.id)).toEqual([
      'Anna',
      'Eric',
      'Jessica',
    ])
    // No native voice: Suggested keeps the default and curated voices. English: always.
    expect(suggestedForLanguage([jessica], curated, 'de', [], 'elevenlabs', 6)).toBeNull()
    expect(suggestedForLanguage(catalog, curated, 'en', [], 'elevenlabs', 6)).toBeNull()
  })

  it('without a native voice a note says why: a free ElevenLabs plan, or none for that language', () => {
    expect(missingNativeNote('de', { label: 'ElevenLabs', freePlan: true })).toEqual({
      text: 'Native voices need a paid ElevenLabs plan.',
      help: 'On the free plan, ElevenLabs has only English voices. Every voice here speaks German, in its own accent. A paid plan adds voices made for German.',
    })
    expect(missingNativeNote('hi', { label: 'Cartesia' })).toEqual({
      text: 'Cartesia has no native Hindi voice.',
      help: 'Every voice here speaks Hindi, in its own accent.',
    })
    expect(missingNativeNote('en', { label: 'ElevenLabs', freePlan: true })).toBeNull()
    expect(missingNativeNote('de', null)).toBeNull()
  })
})
