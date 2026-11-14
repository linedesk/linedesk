// The text-to-speech provider as the API needs it: a short sample of a voice (the preview in
// Settings › Assistant) and, where the provider offers it over its API, cloning a voice from a
// recording. Vendor HTTP lives only here; the voice agent has its own pipeline (apps/agent).
import {
  cloningProviders,
  type Language,
  languageCodes,
  type ProviderName,
  type VoiceLanguage,
} from '@linedesk/actions'

const TIMEOUT_MS = 20_000
/** The same fast model the voice agent uses by default, so the preview sounds like a call. */
export const ELEVENLABS_PREVIEW_MODEL = 'eleven_flash_v2_5'
/**
 * Cartesia's API versions. The voice list uses the current one, which describes a voice's languages as `accents[]`
 * (locale, accent, is_native) instead of the deprecated single `language`. Samples stay on the older version for now:
 * the current one no longer lists sonic-2, the model the assistant speaks with by default.
 */
export const CARTESIA_LIST_VERSION = '2026-08-14'
const CARTESIA_TTS_VERSION = '2025-04-16'
const CARTESIA_DEFAULT_MODEL = 'sonic-2'
/** ElevenLabs models that take `language_code` (the language to speak `text` in). */
const LANGUAGE_CODE_MODELS = /^eleven_(flash|turbo)_v2_5$/
/** Where ElevenLabs hosts its voice samples (public, no key). */
export const ELEVENLABS_SAMPLE_HOST = 'storage.googleapis.com'

export type Audio = { bytes: Buffer; contentType: string }
/**
 * A voice of the provider's list. `previewUrl`: a public sample the provider hosts (no key needed);
 * `clone`: the account itself cloned it from recordings of a person (ElevenLabs instant or professional
 * clone; not a voice added from the Voice Library).
 */
export type ProviderVoice = {
  id: string
  name: string
  description: string | null
  /** Every language the provider lists for the voice, native ones first (VoiceLanguage). */
  languages: VoiceLanguage[]
  /** The first native language of `languages` (what older clients read). */
  language: string | null
  gender: string | null
  /** The accent of that native language. */
  accent: string | null
  previewUrl: string | null
  clone: boolean
}
/**
 * What a provider's list gives: its voices, and `freePlan` when the plan offers no native voices besides English
 * (ElevenLabs' free plan, which cannot use Voice Library voices over the API).
 */
export type VoiceList = { voices: ProviderVoice[]; freePlan?: boolean }
export type CloneRequest = { name: string; audio: Buffer; mimeType: string }

export class VoiceProviderError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface VoiceProvider {
  readonly name: ProviderName
  /** The model previews are made with (part of the preview's cache key). */
  readonly model: string
  /** `language`: the language `text` is in (a code of LANGUAGES), so the provider speaks it as that language. */
  synthesize(voiceId: string, text: string, language?: Language): Promise<Audio>
  /** Present only when the provider clones over its API. Returns the new voice id. */
  cloneVoice?(request: CloneRequest): Promise<string>
  /** Deletes a voice cloned with cloneVoice. A voice that is already gone is fine. */
  deleteVoice?(voiceId: string): Promise<void>
  /** The voices the key can use (at most LIST_MAX of the account's, plus the Voice Library picks). */
  listVoices(): Promise<VoiceList>
}

/** The most voices read from one provider: a few pages, enough for an account's list. */
export const LIST_MAX = 500
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const httpsUrl = (value: unknown): string | null => {
  const url = text(value)
  return url?.startsWith('https://') ? url : null
}

/** "de-DE" or "de_de" → "de"; null for anything that is not a language code. */
export function baseLanguage(code: unknown): string | null {
  const base = text(code)?.toLowerCase().split(/[-_]/)[0]
  return base && /^[a-z]{2,3}$/.test(base) ? base : null
}

/** The accent a locale's region stands for, where it is a common one ("en-GB" → "british"); else null. */
const REGION_ACCENTS: Record<string, string> = {
  US: 'american',
  GB: 'british',
  AU: 'australian',
  CA: 'canadian',
  IE: 'irish',
  IN: 'indian',
  NZ: 'new zealand',
  ZA: 'south african',
  MX: 'mexican',
  ES: 'peninsular',
  AR: 'argentinian',
  CO: 'colombian',
  CL: 'chilean',
  FR: 'parisian',
  BE: 'belgian',
  CH: 'swiss',
  AT: 'austrian',
  BR: 'brazilian',
  PT: 'european',
}
export function accentOfLocale(locale: unknown): string | null {
  const region = text(locale)?.split(/[-_]/)[1]?.toUpperCase()
  return (region && REGION_ACCENTS[region]) || null
}

/** A provider's accent name in words, lower case: "general-american" → "american", "Latin American" → "latin american". */
export function accentWords(accent: unknown): string | null {
  const words = text(accent)
    ?.toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/^(general|standard)\s+(?=\S)/, '')
    .trim()
  return words || null
}

/**
 * The languages as stored per voice: one entry per language, native entries first (a native entry wins over another
 * one of the same language, else the first), unknown codes dropped.
 */
export function voiceLanguages(entries: readonly VoiceLanguage[]): VoiceLanguage[] {
  const byCode = new Map<string, VoiceLanguage>()
  for (const entry of entries) {
    const seen = byCode.get(entry.code)
    if (!seen || (!seen.native && entry.native) || (seen.native === entry.native && !seen.accent && entry.accent))
      byCode.set(entry.code, entry)
  }
  const all = [...byCode.values()]
  return [...all.filter(l => l.native), ...all.filter(l => !l.native)]
}

/**
 * The voice's own language and its accent (`language`, `accent`; older clients read only these): `own`, the language
 * the provider says the voice is of, when it is one of its native ones, else the first native language.
 */
const nativeOf = (languages: readonly VoiceLanguage[], own?: string | null) => {
  const native = languages.find(l => l.native && l.code === own) ?? languages.find(l => l.native)
  return { language: native?.code ?? null, accent: native?.accent ?? null }
}

/** One entry of ElevenLabs' `verified_languages`: a language (and model) the voice was checked to speak natively. */
type VerifiedLanguage = {
  language?: string | null
  model_id?: string | null
  accent?: string | null
  locale?: string | null
  preview_url?: string | null
}

/**
 * ElevenLabs' verified languages as VoiceLanguage, each native (verified means made for it). Without any: the voice's
 * `language` label, else English for a premade voice, with `accent` (its `accent` label).
 */
export function elevenLabsLanguages(
  verified: readonly VerifiedLanguage[] | null | undefined,
  fallback: { language: string | null; accent: string | null },
): VoiceLanguage[] {
  const entries = (verified ?? []).flatMap((l): VoiceLanguage[] => {
    const code = baseLanguage(l.language) ?? baseLanguage(l.locale)
    return code ? [{ code, accent: accentWords(l.accent) ?? accentOfLocale(l.locale), native: true }] : []
  })
  if (entries.length) return voiceLanguages(entries)
  const code = baseLanguage(fallback.language)
  return code ? [{ code, accent: accentWords(fallback.accent), native: true }] : []
}

type ElevenLabsVoice = {
  voice_id?: string
  name?: string
  category?: string
  description?: string | null
  preview_url?: string | null
  labels?: Record<string, string | undefined> | null
  verified_languages?: VerifiedLanguage[] | null
  is_owner?: boolean
  sharing?: { status?: string; original_voice_id?: string | null } | null
}

/**
 * A voice added from ElevenLabs' public Voice Library: a copy of another account's shared voice (its
 * consent is the library's sharing terms), not a voice this account made. A copy whose owner stopped
 * sharing (`copied_disabled`) is left out.
 */
export const isLibraryVoice = (v: ElevenLabsVoice) =>
  v.is_owner !== true && v.sharing?.status === 'copied' && !!text(v.sharing.original_voice_id)

/** One voice of ElevenLabs' GET /v2/voices, or null when it has no id or name. */
export function elevenLabsVoice(v: ElevenLabsVoice): ProviderVoice | null {
  const id = text(v.voice_id)
  const name = text(v.name)
  if (!id || !name) return null
  const labels = v.labels ?? {}
  const languages = elevenLabsLanguages(v.verified_languages, {
    language: text(labels.language) ?? (v.category === 'premade' ? 'en' : null),
    accent: text(labels.accent),
  })
  return {
    id,
    name,
    description: text(labels.description) ?? text(v.description) ?? text(labels.use_case),
    languages,
    ...nativeOf(languages, baseLanguage(labels.language)),
    gender: text(labels.gender),
    previewUrl: httpsUrl(v.preview_url),
    // A clone this account made (instant or professional): a person's voice, listed only with a
    // Linedesk consent record. Library voices are professional clones too, but of another account.
    clone: ['cloned', 'professional'].includes(v.category ?? '') && !isLibraryVoice(v),
  }
}

/** One of a Cartesia voice's accents: the locale it speaks, the accent's id, and whether it was recorded in it. */
type CartesiaAccent = { accent?: string | null; locale?: string | null; is_native?: boolean | null }

type CartesiaVoice = {
  id?: string
  name?: string
  description?: string | null
  /** Deprecated since the API version 2026-08-14 (still sent); the only language information before it. */
  language?: string | null
  accents?: CartesiaAccent[] | null
  gender?: string | null
  is_owner?: boolean
}

/**
 * A Cartesia voice's languages from `accents[]` (native: `is_native`); a voice of an older API version without
 * accents: its `language`, as native.
 */
export function cartesiaLanguages(v: Pick<CartesiaVoice, 'accents' | 'language'>): VoiceLanguage[] {
  const entries = (v.accents ?? []).flatMap((a): VoiceLanguage[] => {
    const code = baseLanguage(a.locale)
    return code
      ? [{ code, accent: accentWords(a.accent) ?? accentOfLocale(a.locale), native: a.is_native === true }]
      : []
  })
  if (entries.length) return voiceLanguages(entries)
  const code = baseLanguage(v.language)
  return code ? [{ code, accent: null, native: true }] : []
}

/** One voice of Cartesia's GET /voices, or null when it has no id or name. */
export function cartesiaVoice(v: CartesiaVoice): ProviderVoice | null {
  const id = text(v.id)
  const name = text(v.name)
  if (!id || !name) return null
  const languages = cartesiaLanguages(v)
  const gender =
    text(v.gender)
      ?.replace(/^masculine$/, 'male')
      .replace(/^feminine$/, 'female') ?? null
  return {
    id,
    name,
    description: text(v.description),
    languages,
    ...nativeOf(languages),
    gender: gender === 'gender_neutral' ? 'neutral' : gender,
    previewUrl: null,
    clone: v.is_owner === true,
  }
}

/**
 * Voice Library picks: ElevenLabs' public library has native voices for every language an assistant speaks, while an
 * account lists only its own (premade voices are English). A paid plan uses a library voice by its id; its first use
 * adds it to the account's voices (one voice slot). Free plans can't use library voices over the API.
 */
export const LIBRARY_PER_LANGUAGE = 6
/** The languages the library is read for: every supported one but English (the premade voices are English). */
export const LIBRARY_LANGUAGES: readonly Language[] = languageCodes.filter(code => code !== 'en')
/** How many of the most used voices of a language are looked at to pick LIBRARY_PER_LANGUAGE from. */
const LIBRARY_PAGE_SIZE = 50

type LibraryVoice = {
  voice_id?: string
  name?: string
  description?: string | null
  gender?: string | null
  accent?: string | null
  language?: string | null
  preview_url?: string | null
  rate?: number | null
  fiat_rate?: number | null
  live_moderation_enabled?: boolean
  verified_languages?: VerifiedLanguage[] | null
}

const sampleOnHost = (value: unknown): string | null => {
  const url = httpsUrl(value)
  return url && URL.canParse(url) && new URL(url).hostname === ELEVENLABS_SAMPLE_HOST ? url : null
}

/**
 * One voice of ElevenLabs' GET /v1/shared-voices for `language`, or null when it does not fit a phone assistant: no
 * sample on ElevenLabs' sample host (a preview made with the key would add the voice to the account), a custom rate
 * (costs more per character), live moderation, or not verified for this language with `model` when it lists verified
 * languages.
 */
export function elevenLabsLibraryVoice(v: LibraryVoice, language: string, model: string): ProviderVoice | null {
  const id = text(v.voice_id)
  const name = text(v.name)
  if (!id || !name) return null
  if ((v.rate ?? 1) !== 1 || v.fiat_rate != null || v.live_moderation_enabled) return null
  const verified = (v.verified_languages ?? []).filter(l => l.language === language)
  if (v.verified_languages?.length && !verified.some(l => l.model_id === model)) return null
  const previewUrl = sampleOnHost(v.preview_url) ?? verified.map(l => sampleOnHost(l.preview_url)).find(Boolean) ?? null
  if (!previewUrl) return null
  // The voice's own language (the one it was recorded in, `accent` is of it), then `language`, the one it was listed
  // for (verified in it, or the library's filter matched it), then its other verified ones; native in each. The same
  // voice is listed for every language it is verified in: it is the voice's own language only when it says so.
  const own = baseLanguage(v.language) ?? language
  const listedAccent =
    own === language ? null : (accentWords(verified[0]?.accent) ?? accentOfLocale(verified[0]?.locale))
  const languages = voiceLanguages([
    {
      code: own,
      accent: accentWords(v.accent) ?? (own === language ? accentOfLocale(verified[0]?.locale) : null),
      native: true,
    },
    { code: language, accent: listedAccent, native: true },
    ...elevenLabsLanguages(v.verified_languages, { language: null, accent: null }),
  ])
  return {
    id,
    name,
    description: text(v.description),
    languages,
    language: own,
    gender: text(v.gender)?.toLowerCase() ?? null,
    accent: languages[0]?.accent ?? null,
    previewUrl,
    clone: false,
  }
}

/**
 * One entry per voice id, with the languages of every entry: a library voice verified in several languages is listed
 * for each of them, and two entries with the same id would show twice in the picker, each with only some languages.
 */
export function oncePerVoice(voices: readonly ProviderVoice[]): ProviderVoice[] {
  const byId = new Map<string, ProviderVoice>()
  for (const voice of voices) {
    const seen = byId.get(voice.id)
    byId.set(voice.id, seen ? { ...seen, languages: voiceLanguages([...seen.languages, ...voice.languages]) } : voice)
  }
  return [...byId.values()]
}

/** Up to `max` voices, as many female as male where there are (in the given order), so either can be matched. */
export function genderBalanced(voices: readonly ProviderVoice[], max = LIBRARY_PER_LANGUAGE): ProviderVoice[] {
  const half = Math.ceil(max / 2)
  const female = voices.filter(v => v.gender === 'female').slice(0, half)
  const male = voices.filter(v => v.gender === 'male').slice(0, half)
  const picked = new Set([...female, ...male])
  const rest = voices.filter(v => !picked.has(v))
  return voices
    .filter(v => picked.has(v))
    .concat(rest)
    .slice(0, max)
}

type Values = { api_key: string; model?: string | null }

/** The provider's error text, short; never the key (it is not in a response body). */
async function failure(res: Response, what: string): Promise<VoiceProviderError> {
  const body = (await res.json().catch(() => null)) as {
    detail?: { message?: string } | string
    message?: string
  } | null
  const detail =
    typeof body?.detail === 'string' ? body.detail : (body?.detail?.message ?? body?.message ?? res.statusText)
  return new VoiceProviderError(`${what} failed (${res.status}): ${String(detail).slice(0, 200)}`, res.status)
}

function elevenlabs({ api_key, model }: Values, doFetch: typeof fetch): VoiceProvider {
  const headers = { 'xi-api-key': api_key }
  const previewModel = model || ELEVENLABS_PREVIEW_MODEL
  /** The account's own voices (GET /v2/voices), at most LIST_MAX. */
  async function accountVoices(): Promise<ProviderVoice[]> {
    const voices: ProviderVoice[] = []
    let pageToken: string | null = null
    do {
      const url = new URL('https://api.elevenlabs.io/v2/voices')
      url.searchParams.set('page_size', '100')
      if (pageToken) url.searchParams.set('next_page_token', pageToken)
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw await failure(res, 'listing voices')
      const body = (await res.json()) as {
        voices?: ElevenLabsVoice[]
        has_more?: boolean
        next_page_token?: string | null
      }
      for (const v of body.voices ?? []) {
        const voice = elevenLabsVoice(v)
        if (voice) voices.push(voice)
      }
      pageToken = body.has_more ? (body.next_page_token ?? null) : null
    } while (pageToken && voices.length < LIST_MAX)
    return voices.slice(0, LIST_MAX)
  }
  /** Whether the plan may use library voices over the API (not free; unknown when the key can't read it). */
  async function paidPlan(): Promise<boolean> {
    const res = await doFetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw await failure(res, 'reading the plan')
    const body = (await res.json()) as { tier?: string }
    return !!body.tier && body.tier !== 'free'
  }
  /** The most used conversational library voices of one language that fit (elevenLabsLibraryVoice). */
  async function libraryOf(language: string): Promise<ProviderVoice[]> {
    const url = new URL('https://api.elevenlabs.io/v1/shared-voices')
    url.searchParams.set('language', language)
    url.searchParams.set('use_cases', 'conversational')
    url.searchParams.set('sort', 'usage_character_count_1y')
    url.searchParams.set('include_custom_rates', 'false')
    url.searchParams.set('include_live_moderated', 'false')
    url.searchParams.set('page_size', String(LIBRARY_PAGE_SIZE))
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw await failure(res, `listing ${language} library voices`)
    const body = (await res.json()) as { voices?: LibraryVoice[] }
    const fitting = (body.voices ?? []).map(v => elevenLabsLibraryVoice(v, language, previewModel))
    return genderBalanced(fitting.filter(v => v !== null))
  }
  /**
   * The library picks for every language besides English; none on a free plan (`freePlan`) or when the plan or the
   * library can't be read.
   */
  async function libraryVoices(): Promise<VoiceList> {
    let paid: boolean
    try {
      paid = await paidPlan()
    } catch (e) {
      console.warn(`voice catalog: elevenlabs: Voice Library: ${e instanceof Error ? e.message : e}`)
      return { voices: [] }
    }
    if (!paid) return { voices: [], freePlan: true }
    try {
      return { voices: oncePerVoice((await Promise.all(LIBRARY_LANGUAGES.map(libraryOf))).flat()) }
    } catch (e) {
      console.warn(`voice catalog: elevenlabs: Voice Library: ${e instanceof Error ? e.message : e}`)
      return { voices: [] }
    }
  }
  return {
    name: 'elevenlabs',
    model: previewModel,
    async synthesize(voiceId, text, language) {
      // Only Flash and Turbo v2.5 take a language to enforce; other models tell it from the text.
      const languageCode = language && LANGUAGE_CODE_MODELS.test(previewModel) ? { language_code: language } : {}
      const res = await doFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: previewModel, ...languageCode }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      if (!res.ok) throw await failure(res, 'voice preview')
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' }
    },
    // Instant voice cloning: one recording, a name; the voice is added to the account behind the key.
    async cloneVoice({ name, audio, mimeType }) {
      const form = new FormData()
      form.append('name', name)
      form.append(
        'files',
        new Blob([new Uint8Array(audio)], { type: mimeType }),
        `sample.${mimeType.split('/')[1] ?? 'audio'}`,
      )
      const res = await doFetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw await failure(res, 'voice cloning')
      const body = (await res.json()) as { voice_id?: string }
      if (!body.voice_id) throw new VoiceProviderError('voice cloning returned no voice id', 502)
      return body.voice_id
    },
    async listVoices() {
      const [account, library] = await Promise.all([accountVoices(), libraryVoices()])
      const listed = new Set(account.map(v => v.id))
      return {
        voices: [...account, ...library.voices.filter(v => !listed.has(v.id))],
        ...(library.freePlan ? { freePlan: true } : {}),
      }
    },
    async deleteVoice(voiceId) {
      const res = await doFetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok && res.status !== 404) throw await failure(res, 'deleting the cloned voice')
    },
  }
}

function cartesia({ api_key, model }: Values, doFetch: typeof fetch): VoiceProvider {
  const previewModel = model || CARTESIA_DEFAULT_MODEL
  return {
    name: 'cartesia',
    model: previewModel,
    async synthesize(voiceId, text, language) {
      const res = await doFetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: { 'x-api-key': api_key, 'cartesia-version': CARTESIA_TTS_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({
          model_id: previewModel,
          transcript: text,
          voice: { mode: 'id', id: voiceId },
          ...(language ? { language } : {}),
          output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 64000 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw await failure(res, 'voice preview')
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' }
    },
    async listVoices() {
      const voices: ProviderVoice[] = []
      let after: string | null = null
      do {
        const url = new URL('https://api.cartesia.ai/voices')
        url.searchParams.set('limit', '100')
        if (after) url.searchParams.set('starting_after', after)
        const res = await doFetch(url, {
          headers: { 'x-api-key': api_key, 'cartesia-version': CARTESIA_LIST_VERSION },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) throw await failure(res, 'listing voices')
        const body = (await res.json()) as { data?: CartesiaVoice[]; has_more?: boolean; next_page?: string | null }
        const page = body.data ?? []
        for (const v of page) {
          const voice = cartesiaVoice(v)
          if (voice) voices.push(voice)
        }
        after = body.has_more ? (text(body.next_page) ?? text(page.at(-1)?.id)) : null
      } while (after && voices.length < LIST_MAX)
      return { voices: voices.slice(0, LIST_MAX) }
    },
  }
}

/** The adapter for a text-to-speech provider of the registry, with its key; null for one it does not know. */
export function createVoiceProvider(
  name: ProviderName,
  values: Values,
  doFetch: typeof fetch = fetch,
): VoiceProvider | null {
  const provider =
    name === 'elevenlabs' ? elevenlabs(values, doFetch) : name === 'cartesia' ? cartesia(values, doFetch) : null
  // The registry says who clones (the picker shows it); an adapter only clones when listed there.
  if (provider && !cloningProviders.includes(name)) {
    delete provider.cloneVoice
    delete provider.deleteVoice
  }
  return provider
}
