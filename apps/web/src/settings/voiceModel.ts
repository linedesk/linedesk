// The voice picker's rules, without React: which voice is in effect, what Save sends, the preview
// link, the checks before a recording is sent to be cloned, and how voices fit the assistant's languages: a voice
// can perform a language when its provider verified it for it (canPerform); the assistant's languages decide the voice
// (the order voices are listed in, the line that says which of them a voice performs, the voice to switch to).
import {
  CLONE_AUDIO_MAX_BYTES,
  type CatalogProvider,
  cloneAudioTypes,
  curatedVoices,
  LANGUAGES,
  type Language,
  languageDefaultOf,
  REALTIME_VOICE_PROVIDER,
  realtimeVoices,
  type VoiceCatalogData,
  type VoiceLanguage,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { fmt, intlLocale } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

export type VoiceChoice = { provider: string; voice_id: string }

/** One voice as the picker lists it, curated or from a provider's list. */
export type PickerVoice = {
  provider: string
  id: string
  name: string
  description: string | null
  /** Every language the provider lists (VoiceLanguage). Missing from older data: then `language` and `accent`. */
  languages?: readonly VoiceLanguage[]
  language?: string | null
  gender?: string | null
  accent?: string | null
  /**
   * Its name and description are the provider's own words (ElevenLabs' library writes them in English, "Susi -
   * Effortless and Confident"), not ours: shown in full only to an English reader (voiceWords).
   */
  providerWords?: boolean
}

/**
 * What a voice row shows, in the reader's language (LIN-648): a curated voice is described by its key; a voice the
 * provider describes in its own (English) words keeps them for an English reader, any other reader sees its first
 * name alone, with the row's facts (gender, languages) in their language beside it. Search and the picks still read
 * the provider's words (filterVoices, madeForCalls), the same for every reader.
 */
export function voiceWords(v: PickerVoice, locale: string): { name: string; description: string | null } {
  const curated = (curatedVoices[v.provider] ?? []).find(c => c.id === v.id)
  if (curated) return { name: curated.name, description: i18n().t(curated.description) }
  if (!v.providerWords || locale === 'en') return { name: v.name, description: v.description }
  return { name: v.name.split(' - ')[0]?.trim() || v.name, description: null }
}

/**
 * The realtime model's voices as the picker lists them (realtimeVoices in @linedesk/actions), OpenAI's recommended ones
 * first: named by their id ("marin" → "Marin"); `recommended` is the line under the ones OpenAI recommends. OpenAI says
 * nothing about gender or accent, so the picker shows neither.
 */
export const realtimePickerVoices = (recommended: string): PickerVoice[] =>
  realtimeVoices.map(v => ({
    provider: REALTIME_VOICE_PROVIDER,
    id: v.id,
    name: v.id.charAt(0).toUpperCase() + v.id.slice(1),
    description: v.recommended ? recommended : null,
    languages: v.languages,
    gender: null,
    accent: null,
  }))

/** A voice's identity in the picker: the same id can exist at two providers. */
export const voiceKey = (provider: string, voiceId: string) => `${provider}:${voiceId}`

/**
 * The voice that applies, as a voiceKey ('' for the default): a voice of a provider that is not set
 * up (no key) does not apply; the agent uses the default voice then, so the picker shows that.
 */
export const voiceInEffect = (voice: VoiceChoice, usable: readonly string[]): string =>
  voice.voice_id && usable.includes(voice.provider) ? voiceKey(voice.provider, voice.voice_id) : ''

/**
 * The sample of a voice, made once on the server and cached by the browser too. `provider` only when
 * it is not the one in effect; `language`, the assistant's main language, only when it is not English (the
 * server's default): a voice without a sample of the provider's own is spoken in it.
 */
export function previewUrl(voiceId: string, provider?: string | null, language?: string | null) {
  const query = new URLSearchParams()
  if (provider) query.set('provider', provider)
  if (language && language !== 'en') query.set('language', language)
  const rest = query.size ? `?${query}` : ''
  return `/v1/voices/preview/${encodeURIComponent(voiceId)}${rest}`
}

/**
 * `language`: '' every language, ASSISTANT_LANGUAGES the assistant's (main and the others it speaks), else one code.
 */
export type VoiceFilter = { query: string; provider: string; language: string; gender: string; accent: string }
export const NO_FILTER: VoiceFilter = { query: '', provider: '', language: '', gender: '', accent: '' }
/** The language filter's value for "the assistant's languages", what More voices opens with. */
export const ASSISTANT_LANGUAGES = 'assistant'
export const ASSISTANT_FILTER: VoiceFilter = { ...NO_FILTER, language: ASSISTANT_LANGUAGES }

const norm = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

/** A provider's language code without its region: "es-MX" → "es". */
const baseLanguage = (code: string | null | undefined) => norm(code).split(/[-_]/)[0] ?? ''

/**
 * A voice's languages, native ones first. Data of an older API (or an older catalog kept in the browser) has only
 * `language` and `accent`: that language, native.
 */
export function languagesOf(v: PickerVoice): readonly VoiceLanguage[] {
  if (v.languages?.length) return v.languages
  const code = baseLanguage(v.language)
  return code ? [{ code, accent: norm(v.accent) || null, native: true }] : []
}

/**
 * Whether a voice can perform a language: its provider verified it for it (ElevenLabs) or it was recorded in it
 * (Cartesia's native accents, the curated voices). Every voice can speak every language through a multilingual model;
 * that does not count.
 */
export const canPerform = (v: PickerVoice, code: string) => languagesOf(v).some(l => l.native && l.code === code)

/** The voice's own language (the one it was recorded in): `language` where it can perform it, else its first one. */
export function ownLanguage(v: PickerVoice): string | null {
  const own = baseLanguage(v.language)
  if (own && canPerform(v, own)) return own
  return languagesOf(v).find(l => l.native)?.code ?? null
}

/** Whether the provider says anything about the voice's languages (a cloned voice: nothing). */
export const languagesKnown = (v: PickerVoice) => languagesOf(v).length > 0

/**
 * How far a voice is from performing all the assistant's languages: 0 when it performs the main language and every
 * other one; else 1 per other language it can't perform, plus more than all of those when it can't perform the main
 * language. Lower is better: the main language first, then as many of the others as possible.
 */
export function languageGap(v: PickerVoice, main: string, others: readonly string[] = []): number {
  const missing = others.filter(code => code !== main && !canPerform(v, code)).length
  return (canPerform(v, main) ? 0 : others.length + 1) + missing
}

/** Whether the voice can perform the main language and every other one the assistant speaks. */
export const performsAll = (v: PickerVoice, main: string, others: readonly string[] = []) =>
  languageGap(v, main, others) === 0

/**
 * More voices' order: the voices that perform all the assistant's languages, then the main language and most of the
 * others (languageGap), then by name.
 */
export const byLanguageFit =
  (main: string, others: readonly string[] = []) =>
  (a: PickerVoice, b: PickerVoice) =>
    languageGap(a, main, others) - languageGap(b, main, others) || a.name.localeCompare(b.name)

/**
 * One entry per voice (provider and id), with the languages of every entry. A catalog kept in the browser from before
 * the API listed each library voice once can have the same voice once per language it is verified in.
 */
export function oncePerVoice<V extends PickerVoice>(voices: readonly V[]): V[] {
  const byKey = new Map<string, V>()
  for (const v of voices) {
    const key = voiceKey(v.provider, v.id)
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, v)
      continue
    }
    const languages = [...languagesOf(seen)]
    for (const l of languagesOf(v)) {
      const at = languages.findIndex(x => x.code === l.code)
      if (at < 0) languages.push(l)
      else if (l.native && !languages[at]!.native) languages[at] = l
    }
    byKey.set(key, { ...seen, languages })
  }
  return [...byKey.values()]
}

/**
 * Which voices "the assistant's languages" lists: the ones that perform all of them; when none does, the closest
 * (the ones that perform the main language); when none performs even that, every voice that speaks one of them.
 */
function assistantLanguagesTest(voices: readonly PickerVoice[], main: string, others: readonly string[]) {
  if (voices.some(v => performsAll(v, main, others))) return (v: PickerVoice) => performsAll(v, main, others)
  if (voices.some(v => canPerform(v, main))) return (v: PickerVoice) => canPerform(v, main)
  const all = [main, ...others]
  return (v: PickerVoice) => languagesOf(v).some(l => all.includes(l.code))
}

/**
 * The voices that match the search (name, description, accent, languages) and every filter that is set. `main` and
 * `others`: the assistant's languages, for the language filter's ASSISTANT_LANGUAGES.
 */
export function filterVoices<V extends PickerVoice>(
  voices: readonly V[],
  filter: VoiceFilter,
  main = '',
  others: readonly string[] = [],
): V[] {
  const words = norm(filter.query).split(/\s+/).filter(Boolean)
  const assistant =
    filter.language === ASSISTANT_LANGUAGES && main ? assistantLanguagesTest(voices, main, others) : null
  return voices.filter(v => {
    const languages = languagesOf(v)
    if (filter.provider && v.provider !== filter.provider) return false
    if (assistant && !assistant(v)) return false
    const one = filter.language !== ASSISTANT_LANGUAGES && filter.language
    if (one && !languages.some(l => l.code === one)) return false
    if (filter.gender && norm(v.gender) !== filter.gender) return false
    if (filter.accent && norm(v.accent) !== filter.accent) return false
    const names = languages.map(l => norm(languageName(l.code))).join(' ')
    const text = `${norm(v.name)} ${norm(v.description)} ${norm(v.accent)} ${names}`
    return words.every(w => text.includes(w))
  })
}

/** The values a filter can take in this list, sorted by label, each once. */
export function facetValues(voices: readonly PickerVoice[], field: 'language' | 'gender' | 'accent') {
  const values = new Set(
    field === 'language'
      ? voices.flatMap(v => languagesOf(v).map(l => l.code))
      : voices.map(v => norm(v[field])).filter(Boolean),
  )
  const label = field === 'language' ? languageName : field === 'gender' ? genderName : capitalize
  const locale = intlLocale()
  return [...values]
    .map(value => ({ value, label: label(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale))
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/** The genders providers give, in the reader's language; another value is shown as the provider wrote it. */
const GENDERS: Record<string, MessageKey> = {
  female: msg('settings.voice.gender.female'),
  male: msg('settings.voice.gender.male'),
  neutral: msg('settings.voice.gender.neutral'),
}

/** "female" → "Female" (translated where known). */
export function genderName(value: string): string {
  const key = GENDERS[norm(value)]
  return key ? i18n().t(key) : capitalize(value)
}
const titleCase = (value: string) =>
  value.replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, c: string) => gap + c.toUpperCase())
const languageNames = new Map<string, Intl.DisplayNames>()

/** "en" → "English" in the reader's language ("Englisch" in German); an unknown code stays as it is. */
export function languageName(code: string | null | undefined): string {
  if (!code) return ''
  const locale = intlLocale()
  const known = Object.hasOwn(LANGUAGES, code) ? LANGUAGES[code as Language] : null
  if (known && locale === 'en') return known
  try {
    let names = languageNames.get(locale)
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: 'language' })
      languageNames.set(locale, names)
    }
    return names.of(code) ?? known ?? code
  } catch {
    return known ?? code
  }
}

/** Accent names that say nothing about how a voice sounds ("standard German"). */
const PLAIN_ACCENTS = new Set(['standard', 'neutral', 'native', 'general', 'default'])

/** The accent a voice speaks `main` with, as a word for "with a … accent", or null when it can't be told. */
function accentFor(v: PickerVoice, main: string): string | null {
  const languages = languagesOf(v)
  const named = (accent: string | null | undefined) => {
    const word = norm(accent)
    // "German with a German accent" says nothing: the voice's own accent tells more.
    return word && !PLAIN_ACCENTS.has(word) && word !== norm(languageName(main)) ? titleCase(word) : null
  }
  // The accent the provider gives for this language (Cartesia), else the one of the voice's own language.
  const own = named(languages.find(l => l.code === main && !l.native)?.accent)
  if (own) return own
  const native = languages.find(l => l.native)
  if (!native) return null
  return named(native.accent) ?? (native.code !== main ? languageName(native.code) : null)
}

/**
 * Which of the assistant's languages the voice performs, for the muted line of its row, the main language first:
 * "Native German · English" ("Native" on the voice's own language). The main language when it can't perform it: how
 * it speaks it, "German with an American accent", or "German, non-native" when its accent can't be told. null when the
 * provider says nothing about the voice's languages (a cloned voice).
 */
export function languageLabel(v: PickerVoice, main: string, others: readonly string[] = []): string | null {
  if (!languagesKnown(v)) return null
  const { t } = i18n()
  const own = ownLanguage(v)
  const named = (code: string) =>
    code === own ? t('settings.voice.language.native', { language: languageName(code) }) : languageName(code)
  let first = named(main)
  if (!canPerform(v, main)) {
    const accent = accentFor(v, main)
    first = accent
      ? t('settings.voice.language.withAccent', {
          language: languageName(main),
          accent,
          // English needs "an" before a vowel; other languages ignore it.
          article: /^[aeiou]/i.test(accent) ? 'an' : 'a',
        })
      : t('settings.voice.language.nonNative', { language: languageName(main) })
  }
  const more = others.filter(code => code !== main && canPerform(v, code)).map(named)
  return [first, ...more].join(' · ')
}

/** "German", "German and English", "German, Dutch, and English", in the reader's language. */
export function listLanguages(codes: readonly string[]): string {
  return fmt().list(codes.map(languageName))
}

/**
 * The muted facts after a voice's name: "Female · British · Native English · Cartesia" (the accent only where the
 * voice performs the main language, the provider when there are several), "Female · German with an American accent",
 * "Female · Austrian · Native German · English" (the other languages of the assistant it performs).
 */
export function voiceFacts(
  v: PickerVoice,
  main: string,
  others: readonly string[] = [],
  providerLabel?: string,
): string {
  const accent = canPerform(v, main) ? norm(languagesOf(v).find(l => l.code === main)?.accent) : ''
  return [
    v.gender && genderName(v.gender),
    accent && !PLAIN_ACCENTS.has(accent) ? titleCase(accent) : null,
    languageLabel(v, main, others),
    providerLabel,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * What to say when a sample does not come back as audio: from the answer's status and the server's
 * error text (`status` 0: no answer at all).
 */
export function previewProblem(status: number, serverError?: string, providerMessage?: string): string {
  const { t } = i18n()
  if (status === 0) return t('common.load.noAnswer')
  if (status === 401) return t('settings.voice.preview.signedOut')
  if (status === 409) return t('settings.voice.preview.noKey')
  if (status === 429) return t('settings.voice.preview.tooMany')
  if (status === 404) return t('settings.voice.preview.unknownVoice')
  if (status === 403 && serverError) return serverError
  // The provider failed: the server says why in the shared provider-failure words (LIN-111), for admin or member.
  if (status === 502 && providerMessage) return providerMessage
  return t('settings.voice.preview.noAnswer')
}

const MB = 1024 * 1024

/** Why this recording cannot be cloned, or null. */
export function cloneProblem(input: {
  name: string
  file: { size: number; type: string } | null
  consent: boolean
}): string | null {
  const { t, format } = i18n()
  if (!input.name.trim()) return t('settings.voice.clone.noName')
  if (!input.file) return t('settings.voice.clone.noFile')
  if (!(cloneAudioTypes as readonly string[]).includes(input.file.type)) return t('settings.voice.clone.badType')
  if (input.file.size > CLONE_AUDIO_MAX_BYTES)
    return t('settings.voice.clone.tooLarge', {
      size: format.number(input.file.size / MB, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      max: format.number(CLONE_AUDIO_MAX_BYTES / MB, { maximumFractionDigits: 1 }),
    })
  if (!input.consent) return t('settings.voice.clone.noConsent')
  return null
}

/** A file's bytes as base64, the way voice.clone takes the recording. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Words in a voice's name or description that say it is made for calls with customers. */
const PHONE_VOICE =
  /\b(agent|assistant|customer|support|service|care|contact|call|phone|ivr|hotline|conversation(al)?)\b/i

const madeForCalls = (v: PickerVoice) => PHONE_VOICE.test(`${v.name} ${v.description ?? ''}`)

/**
 * The voice to switch to when the assistant's languages change (the main one or the others), or null to keep the
 * current one: kept while it performs all of them, or when its languages are unknown (a cloned voice) or it is not in
 * the list. Else the voice that performs the most of them (languageGap), and only when it performs more than the
 * current one; among those the provider and the gender of the current voice, then `favoured` (the default voice and the
 * curated ones, in order), a voice made for calls, then name.
 */
export function voiceForLanguages(
  voices: readonly PickerVoice[],
  main: string,
  others: readonly string[],
  current: PickerVoice | null,
  favoured: readonly PickerVoice[] = [],
): PickerVoice | null {
  if (!current || !languagesKnown(current)) return null
  const now = languageGap(current, main, others)
  if (now === 0) return null
  const gender = norm(current.gender)
  const favour = (v: PickerVoice) => {
    const at = favoured.findIndex(f => f.provider === v.provider && f.id === v.id)
    return at < 0 ? favoured.length : at
  }
  const rank = (v: PickerVoice) => [
    languageGap(v, main, others),
    Number(v.provider !== current.provider),
    Number(!!gender && norm(v.gender) !== gender),
    favour(v),
    Number(!madeForCalls(v)),
  ]
  const best = oncePerVoice(voices)
    .filter(languagesKnown)
    .map(v => ({ v, r: rank(v) }))
    .sort((a, b) => a.r.reduce((d, x, i) => d || x - b.r[i]!, 0) || a.v.name.localeCompare(b.v.name))[0]?.v
  return best && languageGap(best, main, others) < now ? best : null
}

/**
 * The main language's own default voice (languageDefaultVoices) as the picker shows it, described by the provider's
 * list where it has the voice; null for English, a language without one, or until the list says the provider in use
 * can use it (a free ElevenLabs plan can't use Voice Library voices; then calls fall back to the provider's default).
 */
export function usableLanguageDefault(
  provider: string | null,
  language: string,
  catalog: Pick<VoiceCatalogData, 'providers'> | undefined,
  listed: readonly PickerVoice[] = [],
): PickerVoice | null {
  const own = provider ? languageDefaultOf(provider, language) : null
  const state = catalog?.providers.find(p => p.provider === provider)
  if (!own || !provider || !state?.configured || state.freePlan) return null
  return listed.find(v => v.provider === provider && v.id === own.id) ?? { provider, ...own }
}

/**
 * The voice onboarding picks for an assistant without one of its own: its main language's default voice (saved with
 * the step, so the test call speaks with the voice shown checked), or null when it has one or there is none.
 */
export const languageDefaultPick = (voice: VoiceChoice, usable: PickerVoice | null): VoiceChoice | null =>
  voice.voice_id || !usable ? null : { provider: usable.provider, voice_id: usable.id }

/**
 * What Suggested lists for the assistant's languages, at most `limit`: the voices that perform the main language, the
 * ones that perform all the others first (languageGap); among those the main language's default voice (`first`,
 * languageDefaultVoices), then the voices recorded in the main language (ownLanguage: a German voice before an English
 * one verified in German), each group by the provider in use, the curated voices, a voice made for calls, then name.
 * null for English alone (Suggested keeps the default and curated voices), and when no voice performs the main
 * language: then Suggested keeps those, each saying its accent, and missingNativeNote says why.
 */
export function suggestedForLanguage(
  voices: readonly PickerVoice[],
  curated: readonly PickerVoice[],
  main: string,
  others: readonly string[],
  activeProvider: string | null,
  limit: number,
  first: PickerVoice | null = null,
): PickerVoice[] | null {
  if (main === 'en' && !others.some(code => code !== 'en')) return null
  const isCurated = (v: PickerVoice) => curated.some(c => c.provider === v.provider && c.id === v.id)
  const isFirst = (v: PickerVoice) => !!first && v.provider === first.provider && v.id === first.id
  const pool = oncePerVoice([...voices, ...curated, ...(first ? [first] : [])]).filter(v => canPerform(v, main))
  if (!pool.length) return null
  const rank = (v: PickerVoice) =>
    languageGap(v, main, others) * 64 +
    Number(!isFirst(v)) * 32 +
    Number(ownLanguage(v) !== main) * 16 +
    Number(v.provider !== activeProvider) * 4 +
    Number(!isCurated(v)) * 2 +
    Number(!madeForCalls(v))
  return pool.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit)
}

/**
 * The note when no voice performs all the assistant's languages but some perform the main one: which languages the
 * closest voice lacks. "No voice from ElevenLabs is verified in Dutch and Polish; the closest are shown." when no voice
 * performs those at all, else "... in all of German, Dutch and Polish ...". null when a voice performs them all, or none
 * performs the main language (missingNativeNote). `provider`: the label when every voice is of one provider.
 */
export function coverageNote(
  voices: readonly PickerVoice[],
  main: string,
  others: readonly string[],
  provider: string | null,
): string | null {
  if (!voices.some(v => canPerform(v, main)) || voices.some(v => performsAll(v, main, others))) return null
  const closest = [...voices].sort(byLanguageFit(main, others))[0]!
  const all = [main, ...others.filter(code => code !== main)]
  const missing = all.filter(code => !canPerform(closest, code))
  const nowhere = missing.every(code => !voices.some(v => canPerform(v, code)))
  const { t } = i18n()
  if (nowhere) {
    const languages = listLanguages(missing)
    return provider
      ? t('settings.voice.coverage.missingFrom', { provider, languages })
      : t('settings.voice.coverage.missing', { languages })
  }
  const languages = listLanguages(all)
  return provider
    ? t('settings.voice.coverage.notAllFrom', { provider, languages })
    : t('settings.voice.coverage.notAll', { languages })
}

/**
 * The note under Suggested when no voice is native in the main language (suggestedForLanguage gave null): why, and the
 * longer reason behind its "?". null for English, or before the provider's list is known.
 */
export function missingNativeNote(
  main: string,
  active: Pick<CatalogProvider, 'label' | 'freePlan'> | null | undefined,
): { text: string; help: string } | null {
  if (main === 'en' || !active) return null
  const { t } = i18n()
  const language = languageName(main)
  const provider = active.label
  if (active.freePlan)
    return {
      text: t('settings.voice.native.paidPlan', { provider }),
      help: t('settings.voice.native.paidPlanHelp', { provider, language }),
    }
  return {
    text: t('settings.voice.native.none', { provider, language }),
    help: t('settings.voice.native.speaks', { language }),
  }
}

/** A voice switch made because the assistant's languages changed: the voice now, its name, what it performs. */
export type FollowedVoice = { voice: VoiceChoice; name: string; speaks: readonly string[] }

/**
 * What the voice becomes when the assistant's languages change (voiceForLanguages), or null to keep it. `current`: the
 * voice in effect ('' for the default voice, which `defaultVoice` describes). Switching to the default voice gives
 * voice_id '' again, as picking it does.
 */
export function followLanguages(input: {
  voices: readonly PickerVoice[]
  curated: readonly PickerVoice[]
  defaultVoice: PickerVoice | null
  current: VoiceChoice
  main: string
  others: readonly string[]
}): FollowedVoice | null {
  const { curated, defaultVoice, current, main, others } = input
  const pool = oncePerVoice([...input.voices, ...curated, ...(defaultVoice ? [defaultVoice] : [])])
  const same = (v: PickerVoice, provider: string, id: string) => v.provider === provider && v.id === id
  const now = current.voice_id
    ? (pool.find(v => same(v, current.provider, current.voice_id)) ?? null)
    : defaultVoice && (pool.find(v => same(v, defaultVoice.provider, defaultVoice.id)) ?? defaultVoice)
  const favoured = defaultVoice ? [defaultVoice, ...curated] : curated
  const next = voiceForLanguages(pool, main, others, now, favoured)
  if (!next) return null
  const isDefault = !!defaultVoice && same(next, defaultVoice.provider, defaultVoice.id)
  return {
    voice: { provider: next.provider, voice_id: isDefault ? '' : next.id },
    name: next.name,
    speaks: [main, ...others.filter(code => code !== main)].filter(code => canPerform(next, code)),
  }
}

/** The notice after a switch: "Voice changed to Lena: speaks German and English natively." */
export const followedNotice = (followed: FollowedVoice) =>
  followed.speaks.length
    ? i18n().t('settings.voice.followed.speaks', { name: followed.name, languages: listLanguages(followed.speaks) })
    : i18n().t('settings.voice.followed.changed', { name: followed.name })
