// The ElevenLabs adapter's voice list against a fake API (no network): the account's voices plus a few Voice Library
// voices per supported language on a paid plan, picked for a phone assistant. Cartesia's languages pass through.
import { describe, expect, it, test, vi } from 'vitest'
import {
  accentOfLocale,
  accentWords,
  CARTESIA_LIST_VERSION,
  cartesiaVoice,
  createVoiceProvider,
  elevenLabsLibraryVoice,
  elevenLabsVoice,
  genderBalanced,
  LIBRARY_LANGUAGES,
  LIBRARY_PER_LANGUAGE,
  type ProviderVoice,
  cartesiaSampleModel,
  REALTIME_PREVIEW_MODEL,
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

const listFull = (fake: ReturnType<typeof fakeElevenLabs>) =>
  createVoiceProvider('elevenlabs', { api_key: KEY }, fake.doFetch)!.listVoices()
const listWith = async (fake: ReturnType<typeof fakeElevenLabs>) => (await listFull(fake)).voices

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
    // Every language an assistant can speak (LIN-268 added Chinese to Hungarian), so the picker has native voices for each.
    expect(LIBRARY_LANGUAGES).toEqual([
      'es',
      'fr',
      'de',
      'it',
      'pt',
      'nl',
      'ru',
      'hi',
      'ja',
      'zh',
      'ko',
      'pl',
      'tr',
      'vi',
      'id',
      'sv',
      'ar',
      'uk',
      'ro',
      'cs',
      'el',
      'da',
      'fi',
      'no',
      'hu',
    ])
    expect(voices.find(v => v.id === 'es-m1')).toEqual({
      id: 'es-m1',
      name: 'es-m1 - Warm and Clear',
      description: 'Friendly support voice',
      languages: [{ code: 'es', accent: 'latin american', native: true }],
      language: 'es',
      gender: 'male',
      accent: 'latin american',
      // Synthesized with our settings: the hosted sample has the owner's (LIN-715).
      previewUrl: null,
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const fake of [fakeElevenLabs({ tier: 'free' }), fakeElevenLabs({ subscriptionStatus: 401 })]) {
      expect((await listWith(fake)).map(v => v.id)).toEqual(['premade1'])
      expect(fake.requests.some(r => r.url.pathname === '/v1/shared-voices')).toBe(false)
    }
    // Only a plan known to be free says so (the picker then explains why there are no native voices).
    expect((await listFull(fakeElevenLabs({ tier: 'free' }))).freePlan).toBe(true)
    expect((await listFull(fakeElevenLabs({ subscriptionStatus: 401 }))).freePlan).toBeUndefined()
    expect((await listFull(fakeElevenLabs())).freePlan).toBeUndefined()
    warn.mockRestore()
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

  it('a voice verified in several languages is listed once, of its own language, with every language it was listed for', async () => {
    // Alexandra: an Austrian German voice, verified in German, Dutch and Portuguese, so the library lists her for each.
    const alexandra = (listedFor: string) =>
      shared('alexandra', listedFor, {
        name: 'Alexandra',
        accent: 'austrian',
        language: 'de',
        verified_languages: ['de', 'nl', 'pt'].map(language => ({ language, model_id: MODEL, locale: null })),
      })
    const fake = fakeElevenLabs()
    const libraryFetch = fake.doFetch
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const language = url.searchParams.get('language') ?? ''
      if (url.pathname === '/v1/shared-voices' && ['de', 'nl', 'pt'].includes(language))
        return Response.json({ voices: [alexandra(language)], has_more: false })
      return libraryFetch(input, init)
    }) as typeof fetch
    const { voices } = await createVoiceProvider('elevenlabs', { api_key: KEY }, doFetch)!.listVoices()
    const listed = voices.filter(v => v.id === 'alexandra')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ language: 'de', accent: 'austrian' })
    expect(listed[0]!.languages).toEqual([
      { code: 'de', accent: 'austrian', native: true },
      { code: 'nl', accent: null, native: true },
      { code: 'pt', accent: null, native: true },
    ])
  })
})

describe('which library voices fit a phone assistant', () => {
  it('a voice listed for another language than its own keeps its own language and accent', () => {
    const voice = elevenLabsLibraryVoice(
      shared('alexandra', 'nl', {
        accent: 'austrian',
        language: 'de',
        verified_languages: [
          { language: 'de', model_id: MODEL },
          { language: 'nl', model_id: MODEL, accent: 'flemish' },
        ],
      }),
      'nl',
      MODEL,
    )
    expect(voice).toMatchObject({ language: 'de', accent: 'austrian' })
    expect(voice?.languages).toEqual([
      { code: 'de', accent: 'austrian', native: true },
      { code: 'nl', accent: 'flemish', native: true },
    ])
  })

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
  it("never uses the sample ElevenLabs hosts: it has the owner's settings, the preview is synthesized (LIN-715)", () => {
    const elsewhere = { preview_url: 'https://api.us.elevenlabs.io/v1/voices/a/preview' }
    expect(elevenLabsLibraryVoice(shared('a', 'fr', elsewhere), 'fr', MODEL)).toMatchObject({
      id: 'a',
      previewUrl: null,
    })
    expect(elevenLabsLibraryVoice(shared('a', 'fr'), 'fr', MODEL)?.previewUrl).toBeNull()
  })
})

test('the picks per language mix female and male voices, in the order given', () => {
  const voice = (id: string, gender: string | null): ProviderVoice => ({
    id,
    name: id,
    description: null,
    languages: [{ code: 'es', accent: null, native: true }],
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

test('Cartesia voices of an older API version (no accents) keep the language Cartesia lists, as native', () => {
  expect(cartesiaVoice({ id: 'c1', name: 'Lucía', language: 'es', gender: 'feminine' })).toMatchObject({
    languages: [{ code: 'es', accent: null, native: true }],
    language: 'es',
    gender: 'female',
  })
})

/** Voices as Cartesia's GET /voices returns them (API version 2026-08-14), trimmed to the fields we read. */
const CARTESIA_PAGE_1 = {
  data: [
    {
      id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
      is_owner: false,
      status: 'active',
      access: 'public',
      visibility: 'all',
      name: 'Skylar',
      tagline: 'Friendly Guide',
      description: 'A friendly, clear voice',
      gender: 'feminine',
      language: 'en',
      accents: [
        { accent: 'general-american', locale: 'en-US', is_native: true },
        { accent: 'mexican', locale: 'es-MX', is_native: false },
        { accent: 'castilian', locale: 'es-ES', is_native: false },
        { accent: 'standard-german', locale: 'de-DE', is_native: false },
      ],
      country: 'US',
      created_at: '2026-03-31T17:37:05.961874Z',
    },
  ],
  has_more: true,
  next_page: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
}
const CARTESIA_PAGE_2 = {
  data: [
    {
      id: 'b9de4a89-2257-424b-94c2-db18ba68c81a',
      is_owner: false,
      name: 'Johanna',
      description: 'Ruhig und freundlich',
      gender: 'feminine',
      language: 'de',
      accents: [{ accent: 'standard-german', locale: 'de-DE', is_native: true }],
    },
    // No locale: nothing to tell; the deprecated language is used.
    { id: 'c0ffee00-0000-4000-8000-000000000000', is_owner: true, name: 'Own', language: 'fr', accents: [] },
  ],
  has_more: false,
  next_page: null,
}

describe('Cartesia voice list (current API version)', () => {
  function fakeCartesia() {
    const requests: { url: URL; version: string | null }[] = []
    const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ url, version: new Headers(init?.headers).get('cartesia-version') })
      return Response.json(url.searchParams.get('starting_after') ? CARTESIA_PAGE_2 : CARTESIA_PAGE_1)
    })
    return { doFetch: doFetch as unknown as typeof fetch, requests }
  }

  it('reads every language from accents[]: native where it was recorded, the accent it speaks the others with', async () => {
    const fake = fakeCartesia()
    const { voices, freePlan } = await createVoiceProvider('cartesia', { api_key: 'sk' }, fake.doFetch)!.listVoices()
    expect(freePlan).toBeUndefined()
    expect(voices.map(v => v.name)).toEqual(['Skylar', 'Johanna', 'Own'])
    expect(voices[0]).toMatchObject({
      languages: [
        { code: 'en', accent: 'american', native: true },
        { code: 'es', accent: 'mexican', native: false },
        { code: 'de', accent: 'german', native: false },
      ],
      language: 'en',
      accent: 'american',
      gender: 'female',
    })
    expect(voices[1]).toMatchObject({ languages: [{ code: 'de', accent: 'german', native: true }], language: 'de' })
    expect(voices[2]).toMatchObject({ languages: [{ code: 'fr', accent: null, native: true }], clone: true })
    expect(fake.requests.map(r => r.version)).toEqual([CARTESIA_LIST_VERSION, CARTESIA_LIST_VERSION])
    expect(fake.requests[1]!.url.searchParams.get('starting_after')).toBe(CARTESIA_PAGE_1.next_page)
  })

  it('a native accent wins over another of the same language; a locale alone gives the accent of its region', () => {
    expect(
      cartesiaVoice({
        id: 'x1',
        name: 'X',
        accents: [
          { accent: 'mexican', locale: 'es-MX', is_native: false },
          { locale: 'es-AR', is_native: true },
        ],
      })?.languages,
    ).toEqual([{ code: 'es', accent: 'argentinian', native: true }])
  })
})

describe('ElevenLabs voice languages', () => {
  it('keeps every verified language, each native, once per language', () => {
    const voice = elevenLabsVoice({
      voice_id: 'v1',
      name: 'Lena',
      category: 'professional',
      is_owner: false,
      sharing: { status: 'copied', original_voice_id: 'o' },
      labels: { accent: 'standard', language: 'de' },
      verified_languages: [
        { language: 'de', model_id: 'eleven_multilingual_v2', accent: 'standard', locale: 'de-DE' },
        { language: 'de', model_id: MODEL, accent: 'standard', locale: 'de-DE' },
        { language: 'en', model_id: MODEL, accent: null, locale: 'en-GB' },
      ],
    })
    expect(voice?.languages).toEqual([
      { code: 'de', accent: 'standard', native: true },
      { code: 'en', accent: 'british', native: true },
    ])
    expect(voice).toMatchObject({ language: 'de', accent: 'standard' })
  })

  it('without verified languages: the language label, or English for a premade voice', () => {
    expect(
      elevenLabsVoice({ voice_id: 'p1', name: 'Sarah', category: 'premade', labels: { accent: 'american' } })
        ?.languages,
    ).toEqual([{ code: 'en', accent: 'american', native: true }])
    expect(elevenLabsVoice({ voice_id: 'g1', name: 'Gen', category: 'generated' })?.languages).toEqual([])
  })

  it('a library voice is native in the language it was listed for, and keeps its other verified ones', () => {
    const voice = elevenLabsLibraryVoice(
      shared('a', 'fr', {
        accent: 'parisian',
        verified_languages: [
          { language: 'fr', model_id: MODEL, locale: 'fr-FR' },
          { language: 'en', model_id: MODEL, accent: 'american', locale: 'en-US' },
        ],
      }),
      'fr',
      MODEL,
    )
    expect(voice?.languages).toEqual([
      { code: 'fr', accent: 'parisian', native: true },
      { code: 'en', accent: 'american', native: true },
    ])
  })

  it('accent words and locales', () => {
    expect(accentWords('general-american')).toBe('american')
    expect(accentWords('Latin American')).toBe('latin american')
    expect(accentWords('standard')).toBe('standard')
    expect(accentWords('')).toBeNull()
    expect(accentOfLocale('en-GB')).toBe('british')
    expect(accentOfLocale('pt_BR')).toBe('brazilian')
    expect(accentOfLocale('ja-JP')).toBeNull()
    expect(accentOfLocale(null)).toBeNull()
  })
})

describe('samples in a language', () => {
  const capture = () => {
    const bodies: Record<string, unknown>[] = []
    const doFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(new Uint8Array([0xff, 0xfb, 0, 0]))
    }) as unknown as typeof fetch
    return { bodies, doFetch }
  }
  it('ElevenLabs gets language_code with Flash or Turbo v2.5, other models only the text', async () => {
    const flash = capture()
    await createVoiceProvider('elevenlabs', { api_key: KEY }, flash.doFetch)!.synthesize('v', 'Hallo', 'de')
    await createVoiceProvider('elevenlabs', { api_key: KEY }, flash.doFetch)!.synthesize('v', 'Hi')
    // Always our settings at normal speed, as on a call: never the library voice owner's (LIN-712).
    const voice_settings = { stability: 0.5, similarity_boost: 0.75, speed: 1 }
    expect(flash.bodies).toEqual([
      { text: 'Hallo', model_id: MODEL, language_code: 'de', voice_settings },
      { text: 'Hi', model_id: MODEL, voice_settings },
    ])
    const other = capture()
    await createVoiceProvider(
      'elevenlabs',
      { api_key: KEY, model: 'eleven_multilingual_v2' },
      other.doFetch,
    )!.synthesize('v', 'Hallo', 'de')
    expect(other.bodies[0]).toMatchObject({ text: 'Hallo', model_id: 'eleven_multilingual_v2' })
    expect(other.bodies[0]).not.toHaveProperty('language_code')
  })
  it('Cartesia gets language', async () => {
    const fake = capture()
    await createVoiceProvider('cartesia', { api_key: 'sk' }, fake.doFetch)!.synthesize('v', 'Hallo', 'de')
    expect(fake.bodies[0]).toMatchObject({ transcript: 'Hallo', language: 'de', voice: { mode: 'id', id: 'v' } })
  })
})

test("a Cartesia sample without a model set uses Sonic 3 for a language Sonic 2 doesn't speak", () => {
  expect(cartesiaSampleModel()).toBe('sonic-2')
  expect(cartesiaSampleModel('ko')).toBe('sonic-2')
  expect(cartesiaSampleModel('vi')).toBe('sonic-3')
  expect(cartesiaSampleModel('hu')).toBe('sonic-3')
})

describe('the realtime model voices', () => {
  it("make a sample with OpenAI's speech model and the realtime key, in the voice by its name", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const doFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(new Uint8Array([0xff, 0xfb, 0, 0]))
    }) as unknown as typeof fetch
    const adapter = createVoiceProvider('openai_realtime', { api_key: 'sk-rt', model: 'gpt-realtime' }, doFetch)!
    expect(adapter.model).toBe(REALTIME_PREVIEW_MODEL)
    expect(adapter.cloneVoice).toBeUndefined()
    const audio = await adapter.synthesize('cedar', 'Hallo', 'de')
    expect(audio.contentType).toBe('audio/mpeg')
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech')
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sk-rt')
    // Not the realtime model: that one needs a session; the speech model speaks the same voices.
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'cedar',
      input: 'Hallo',
      response_format: 'mp3',
    })
  })

  it("say OpenAI's error, never the key", async () => {
    const doFetch = (async () =>
      Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 })) as unknown as typeof fetch
    const adapter = createVoiceProvider('openai_realtime', { api_key: 'sk-secret' }, doFetch)!
    const failure = (await adapter.synthesize('marin', 'Hi').then(
      () => null,
      (e: unknown) => e,
    )) as Error & { status: number }
    expect(failure.status).toBe(401)
    expect(failure.message).toContain('Incorrect API key provided')
    expect(failure.message).not.toContain('sk-secret')
  })

  it('list the ten realtime voices, named by their id, native in English, nothing more claimed', async () => {
    const { voices } = await createVoiceProvider('openai_realtime', { api_key: 'k' })!.listVoices()
    expect(voices.map(v => v.name)).toEqual([
      'Marin',
      'Cedar',
      'Alloy',
      'Ash',
      'Ballad',
      'Coral',
      'Echo',
      'Sage',
      'Shimmer',
      'Verse',
    ])
    for (const v of voices) expect(v).toMatchObject({ gender: null, accent: null, language: 'en', clone: false })
  })
})
