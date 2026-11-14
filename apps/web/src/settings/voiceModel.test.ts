import { describe, expect, it, test } from 'vitest'
import {
  byEnglishThenName,
  cloneProblem,
  facetValues,
  fileToBase64,
  filterVoices,
  NO_FILTER,
  previewProblem,
  previewUrl,
  voiceFacts,
  voiceForMainLanguage,
  voiceInEffect,
  voicesForLanguage,
} from './voiceModel.ts'

describe('voice picker', () => {
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
    expect(voiceFacts(voices[3]!, 'Cartesia')).toBe('Male · British · English · Cartesia')
    expect(voiceFacts(voices[2]!)).toBe('Female · English')
    expect([...voices].sort(byEnglishThenName).map(v => v.name)).toEqual(['Brooke', 'Jessica', 'Ronald', 'Lea'])
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
  expect(previewProblem(0)).toMatch(/No connection/)
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

describe('voice for the main language', () => {
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
  const jessica = { provider: 'elevenlabs', voice_id: 'jessica' }
  it('another language: a voice made for it; the provider in use, the same gender and a voice for calls first', () => {
    expect(voiceForMainLanguage(voices, 'es', jessica, 'elevenlabs')).toMatchObject({ id: 'carla' })
    expect(
      voiceForMainLanguage(voices, 'es', { provider: 'elevenlabs', voice_id: 'mateo-en' }, 'elevenlabs'),
    ).toMatchObject({ id: 'carla' })
    expect(
      voiceForMainLanguage(
        [
          ...voices,
          { provider: 'elevenlabs', id: 'eric', name: 'Eric', description: null, language: 'en', gender: 'male' },
        ],
        'es',
        { provider: 'elevenlabs', voice_id: 'eric' },
        'elevenlabs',
      ),
    ).toMatchObject({ id: 'mateo' })
    expect(voiceForMainLanguage(voices, 'es', jessica, 'cartesia')).toMatchObject({ id: 'lucia' })
  })
  it('keeps the voice when none is made for the language, or the current one already is', () => {
    expect(voiceForMainLanguage(voices, 'ja', jessica, 'elevenlabs')).toBeNull()
    expect(voiceForMainLanguage(voices, 'es', { provider: 'elevenlabs', voice_id: 'mateo' }, 'elevenlabs')).toBeNull()
  })
  it('English: back to the default voice only from a voice of another language', () => {
    expect(voiceForMainLanguage(voices, 'en', { provider: 'elevenlabs', voice_id: 'mateo' }, 'elevenlabs')).toBe(
      'default',
    )
    expect(voiceForMainLanguage(voices, 'en', jessica, 'elevenlabs')).toBeNull()
    expect(voiceForMainLanguage(voices, 'en', { provider: 'elevenlabs', voice_id: 'unknown' }, 'elevenlabs')).toBeNull()
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
  const voices = [
    {
      provider: 'elevenlabs',
      id: 'cgSgspJ2msm6clMCkdW9',
      name: 'Jessica',
      description: null,
      language: 'en',
      gender: 'female',
    },
    { provider: 'elevenlabs', id: 'eric', name: 'Eric', description: null, language: 'en', gender: 'male' },
    library('cristina', 'Cristina Campos - Friendly and Soft', 'es', 'female', 'A warm Argentinian voice.'),
    library('regina', 'Regina - Contact Center', 'es', 'female'),
    library('diego', 'Diego - Calm and Clear', 'es', 'male'),
    library('lucie', 'Lucie - Support Agent', 'fr', 'female'),
    library('marcel', 'Marcel - Warm and Conversational', 'fr', 'male'),
    library('kaori', 'Kaori - Relatable and Friendly Voice', 'ja', 'female'),
    { provider: 'cartesia', id: 'sofia', name: 'Sofía', description: null, language: 'es', gender: 'female' },
  ]
  const noVoice = { provider: 'elevenlabs', voice_id: '' }

  it('every supported language gets a native voice when the main language changes', () => {
    expect(voiceForMainLanguage(voices, 'es', noVoice, 'elevenlabs')).toMatchObject({ id: 'regina' })
    expect(voiceForMainLanguage(voices, 'fr', noVoice, 'elevenlabs')).toMatchObject({ id: 'lucie' })
    expect(voiceForMainLanguage(voices, 'ja', noVoice, 'elevenlabs')).toMatchObject({ id: 'kaori' })
  })

  it('a male voice stays male in the new language, where the language has one', () => {
    const eric = { provider: 'elevenlabs', voice_id: 'eric' }
    expect(voiceForMainLanguage(voices, 'es', eric, 'elevenlabs')).toMatchObject({ id: 'diego' })
    expect(voiceForMainLanguage(voices, 'fr', eric, 'elevenlabs')).toMatchObject({ id: 'marcel' })
    expect(voiceForMainLanguage(voices, 'ja', eric, 'elevenlabs')).toMatchObject({ id: 'kaori' })
  })

  it('Suggested: the provider in use first, a voice made for calls before the rest, never another language', () => {
    expect(voicesForLanguage(voices, 'es', 'elevenlabs').map(v => v.id)).toEqual([
      'regina',
      'cristina',
      'diego',
      'sofia',
    ])
    expect(voicesForLanguage(voices, 'es', 'elevenlabs', 'male').map(v => v.id)).toEqual([
      'diego',
      'regina',
      'cristina',
      'sofia',
    ])
    expect(voicesForLanguage(voices, 'es', 'cartesia')[0]).toMatchObject({ id: 'sofia' })
    expect(voicesForLanguage(voices, 'de', 'elevenlabs')).toEqual([])
  })
})
