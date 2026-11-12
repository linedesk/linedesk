// The ElevenLabs adapter's voice list against a fake API (no network): the account's voices plus a few Voice Library
// voices per supported language on a paid plan, picked for a phone assistant. Cartesia's languages pass through.
import { describe, expect, it, test, vi } from 'vitest'
import {
  cartesiaVoice,
  createVoiceProvider,
  elevenLabsLibraryVoice,
  genderBalanced,
  LIBRARY_LANGUAGES,
  LIBRARY_PER_LANGUAGE,
  type ProviderVoice,
} from './voice-provider.ts'

const KEY = 'xi-test-key'
const MODEL = 'eleven_flash_v2_5'
const sample = (id: string) => `https://storage.googleapis.com/eleven-public-prod/voices/${id}/sample.mp3`

/** A library voice as GET /v1/shared-voices returns it, fit for a phone assistant unless overridden. */
const shared = (voice_id: string, language: string, extra: object = {}) => ({
  voice_id,
  name: `${voice_id} - Warm and Clear`,
  description: 'Friendly support voice',
  gender: 'Female',
  accent: 'latin american',
  language,
  preview_url: sample(voice_id),
  rate: 1,
  fiat_rate: null,
  live_moderation_enabled: false,
  verified_languages: [{ language, model_id: MODEL, preview_url: null }],
  ...extra,
})

type Fake = { tier?: string | null; subscriptionStatus?: number; libraryStatus?: number; account?: object[] }

function fakeElevenLabs({ tier = 'creator', subscriptionStatus = 200, libraryStatus = 200, account }: Fake = {}) {
  const requests: { url: URL; key: string | null }[] = []
  const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, key: new Headers(init?.headers).get('xi-api-key') })
    if (url.pathname === '/v2/voices')
      return Response.json({
        voices: account ?? [{ voice_id: 'premade1', name: 'Sarah', category: 'premade', labels: { gender: 'female' } }],
        has_more: false,
      })
    if (url.pathname === '/v1/user/subscription')
      return subscriptionStatus === 200
        ? Response.json({ tier })
        : Response.json({ detail: { message: 'missing user_read' } }, { status: subscriptionStatus })
    if (url.pathname === '/v1/shared-voices') {
      if (libraryStatus !== 200) return Response.json({ detail: 'down' }, { status: libraryStatus })
      const language = url.searchParams.get('language') ?? ''
      return Response.json({
        voices: [
          shared(`${language}-f1`, language),
          shared(`${language}-f2`, language),
          shared(`${language}-f3`, language),
          shared(`${language}-f4`, language),
          shared(`${language}-m1`, language, { gender: 'male' }),
        ],
        has_more: true,
      })
    }
    return new Response('not found', { status: 404 })
  })
  return { doFetch: doFetch as unknown as typeof fetch, requests }
}

const listWith = (fake: ReturnType<typeof fakeElevenLabs>) =>
  createVoiceProvider('elevenlabs', { api_key: KEY }, fake.doFetch)!.listVoices()

describe('ElevenLabs Voice Library voices', () => {
  it('a paid plan lists a few native voices for every supported language besides English', async () => {
    const fake = fakeElevenLabs()
    const voices = await listWith(fake)
    expect(voices[0]).toMatchObject({ id: 'premade1', language: 'en' })
    for (const language of LIBRARY_LANGUAGES) {
      const ofLanguage = voices.filter(v => v.language === language)
      expect(ofLanguage).toHaveLength(LIBRARY_PER_LANGUAGE - 1) // the fake has five that fit
      expect(ofLanguage.map(v => v.id)).toContain(`${language}-m1`)
    }
    expect(LIBRARY_LANGUAGES).toEqual(['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
    expect(voices.find(v => v.id === 'es-m1')).toEqual({
      id: 'es-m1',
      name: 'es-m1 - Warm and Clear',
      description: 'Friendly support voice',
      language: 'es',
      gender: 'male',
      accent: 'latin american',
      previewUrl: sample('es-m1'),
      clone: false,
    })
  })

  it('asks for conversational voices, most used first, at the standard rate and without live moderation', async () => {
    const fake = fakeElevenLabs()
    await listWith(fake)
    const library = fake.requests.filter(r => r.url.pathname === '/v1/shared-voices')
    expect(library.map(r => r.url.searchParams.get('language')).sort()).toEqual([...LIBRARY_LANGUAGES].sort())
    expect(Object.fromEntries(library[0]!.url.searchParams)).toMatchObject({
      use_cases: 'conversational',
      sort: 'usage_character_count_1y',
      include_custom_rates: 'false',
      include_live_moderated: 'false',
    })
    // The key goes in the header, never in a URL.
    expect(fake.requests.every(r => r.key === KEY && !r.url.href.includes(KEY))).toBe(true)
  })

  it('a free plan, or a key that cannot read the plan, gets only the account’s voices', async () => {
    for (const fake of [fakeElevenLabs({ tier: 'free' }), fakeElevenLabs({ subscriptionStatus: 401 })]) {
      expect((await listWith(fake)).map(v => v.id)).toEqual(['premade1'])
      expect(fake.requests.some(r => r.url.pathname === '/v1/shared-voices')).toBe(false)
    }
  })

  it('the account’s voices still list when the library cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await listWith(fakeElevenLabs({ libraryStatus: 500 }))).map(v => v.id)).toEqual(['premade1'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Voice Library'))
    warn.mockRestore()
  })

  it('a library voice the account already added is listed once, as the account’s', async () => {
    const added = {
      voice_id: 'es-f1',
      name: 'Mine',
      category: 'professional',
      is_owner: false,
      labels: { language: 'es' },
      sharing: { status: 'copied', original_voice_id: 'es-f1' },
    }
    const voices = await listWith(fakeElevenLabs({ account: [added] }))
    expect(voices.filter(v => v.id === 'es-f1')).toEqual([expect.objectContaining({ name: 'Mine', clone: false })])
  })
})

describe('which library voices fit a phone assistant', () => {
  it('keeps a voice verified for the language with the model in use and a sample on the sample host', () => {
    expect(elevenLabsLibraryVoice(shared('a', 'fr'), 'fr', MODEL)).toMatchObject({
      id: 'a',
      language: 'fr',
      gender: 'female',
    })
    // No verified languages listed: the library's language filter is taken as it is.
    expect(elevenLabsLibraryVoice(shared('b', 'fr', { verified_languages: [] }), 'fr', MODEL)).not.toBeNull()
  })
  it('leaves out custom rates, live moderation and voices not verified for the model', () => {
    expect(elevenLabsLibraryVoice(shared('a', 'fr', { rate: 2 }), 'fr', MODEL)).toBeNull()
    expect(elevenLabsLibraryVoice(shared('a', 'fr', { fiat_rate: 0.25 }), 'fr', MODEL)).toBeNull()
    expect(elevenLabsLibraryVoice(shared('a', 'fr', { live_moderation_enabled: true }), 'fr', MODEL)).toBeNull()
    const v4Only = { verified_languages: [{ language: 'fr', model_id: 'eleven_v4' }] }
    expect(elevenLabsLibraryVoice(shared('a', 'fr', v4Only), 'fr', MODEL)).toBeNull()
    expect(elevenLabsLibraryVoice(shared('a', 'fr', v4Only), 'fr', 'eleven_v4')).not.toBeNull()
    expect(elevenLabsLibraryVoice({ name: 'no id' }, 'fr', MODEL)).toBeNull()
  })
  it('needs a sample ElevenLabs hosts: a preview made with the key would add the voice to the account', () => {
    const elsewhere = { preview_url: 'https://api.us.elevenlabs.io/v1/voices/a/preview' }
    expect(elevenLabsLibraryVoice(shared('a', 'fr', elsewhere), 'fr', MODEL)).toBeNull()
    const verifiedSample = {
      ...elsewhere,
      verified_languages: [{ language: 'fr', model_id: MODEL, preview_url: sample('fr-a') }],
    }
    expect(elevenLabsLibraryVoice(shared('a', 'fr', verifiedSample), 'fr', MODEL)?.previewUrl).toBe(sample('fr-a'))
  })
})

test('the picks per language mix female and male voices, in the order given', () => {
  const voice = (id: string, gender: string | null): ProviderVoice => ({
    id,
    name: id,
    description: null,
    language: 'es',
    gender,
    accent: null,
    previewUrl: null,
    clone: false,
  })
  const ranked = ['f1', 'f2', 'f3', 'f4', 'f5', 'm1', 'n1', 'm2'].map(id =>
    voice(id, id.startsWith('f') ? 'female' : id.startsWith('m') ? 'male' : null),
  )
  expect(genderBalanced(ranked).map(v => v.id)).toEqual(['f1', 'f2', 'f3', 'm1', 'm2', 'f4'])
  expect(genderBalanced(ranked.slice(0, 5)).map(v => v.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5'])
})

test('Cartesia voices keep the language Cartesia lists', () => {
  expect(cartesiaVoice({ id: 'c1', name: 'Lucía', language: 'es', gender: 'feminine' })).toMatchObject({
    language: 'es',
    gender: 'female',
  })
})
