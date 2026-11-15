// The voice picker's rules, without React: which voice is in effect, what Save sends, the preview
// link, the checks before a recording is sent to be cloned, and how voices fit the assistant's languages: a voice
// can perform a language when its provider verified it for it (canPerform); the assistant's languages decide the voice
// (the order voices are listed in, the line that says which of them a voice performs, the voice to switch to).
import {
  CLONE_AUDIO_MAX_BYTES,
  type CatalogProvider,
  cloneAudioTypes,
  LANGUAGES,
  type Language,
  type VoiceLanguage,
} from '@linedesk/actions'

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
}

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
  const label = field === 'language' ? languageName : capitalize
  return [...values].map(value => ({ value, label: label(value) })).sort((a, b) => a.label.localeCompare(b.label))
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const titleCase = (value: string) =>
  value.replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, c: string) => gap + c.toUpperCase())
let languageNames: Intl.DisplayNames | null = null

/** "en" → "English"; an unknown code stays as it is. */
export function languageName(code: string | null | undefined): string {
  if (!code) return ''
  if (Object.hasOwn(LANGUAGES, code)) return LANGUAGES[code as Language]
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' })
    return languageNames.of(code) ?? code
  } catch {
    return code
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
  const own = ownLanguage(v)
  const named = (code: string) => (code === own ? `Native ${languageName(code)}` : languageName(code))
  let first = named(main)
  if (!canPerform(v, main)) {
    const accent = accentFor(v, main)
    first = accent
      ? `${languageName(main)} with ${/^[aeiou]/i.test(accent) ? 'an' : 'a'} ${accent} accent`
      : `${languageName(main)}, non-native`
  }
  const more = others.filter(code => code !== main && canPerform(v, code)).map(named)
  return [first, ...more].join(' · ')
}

/** "German", "German and English", "German, Dutch and English". */
export function listLanguages(codes: readonly string[]): string {
  const names = codes.map(languageName)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
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
    v.gender && capitalize(v.gender),
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
  if (status === 0) return "Can't reach the server. Check your connection and try again."
  if (status === 401) return 'You were signed out. Sign in again to hear samples.'
  if (status === 409) return 'Add a voice provider key in Server admin › Providers to hear samples.'
  if (status === 429) return 'Too many new samples this hour. Try again later.'
  if (status === 404) return 'The voice provider does not know this voice.'
  if (status === 403 && serverError) return serverError
  // The provider failed: the server says why in the shared provider-failure words (LIN-111), for admin or member.
  if (status === 502 && providerMessage) return providerMessage
  return 'The voice provider did not answer. Try again.'
}

const MB = 1024 * 1024

/** Why this recording cannot be cloned, or null. */
export function cloneProblem(input: {
  name: string
  file: { size: number; type: string } | null
  consent: boolean
}): string | null {
  if (!input.name.trim()) return 'Give the voice a name.'
  if (!input.file) return 'Choose a recording of the voice: one to two minutes of clear speech.'
  if (!(cloneAudioTypes as readonly string[]).includes(input.file.type))
    return 'Use an MP3, WAV, M4A, WebM or OGG recording.'
  if (input.file.size > CLONE_AUDIO_MAX_BYTES)
    return `The recording is ${(input.file.size / MB).toFixed(1)} MB; at most 10 MB.`
  if (!input.consent) return 'Confirm that the speaker agreed to their voice being cloned.'
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
 * What Suggested lists for the assistant's languages, at most `limit`: the voices that perform the main language, the
 * ones that perform all the others first (languageGap), each group by the provider in use, the curated voices, a voice
 * made for calls, then name. null for English alone (Suggested keeps the default and curated voices), and when no voice
 * performs the main language: then Suggested keeps those, each saying its accent, and missingNativeNote says why.
 */
export function suggestedForLanguage(
  voices: readonly PickerVoice[],
  curated: readonly PickerVoice[],
  main: string,
  others: readonly string[],
  activeProvider: string | null,
  limit: number,
): PickerVoice[] | null {
  if (main === 'en' && !others.some(code => code !== 'en')) return null
  const isCurated = (v: PickerVoice) => curated.some(c => c.provider === v.provider && c.id === v.id)
  const pool = oncePerVoice([...voices, ...curated]).filter(v => canPerform(v, main))
  if (!pool.length) return null
  const rank = (v: PickerVoice) =>
    languageGap(v, main, others) * 8 +
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
  const from = provider ? ` from ${provider}` : ''
  return nowhere
    ? `No voice${from} is verified in ${listLanguages(missing)}; the closest are shown.`
    : `No voice${from} is verified in all of ${listLanguages(all)}; the closest are shown.`
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
  const language = languageName(main)
  const speaks = `Every voice here speaks ${language}, in its own accent.`
  if (active.freePlan)
    return {
      text: `Native voices need a paid ${active.label} plan.`,
      help: `On the free plan, ${active.label} has only English voices. ${speaks} A paid plan adds voices made for ${language}.`,
    }
  return { text: `${active.label} has no native ${language} voice.`, help: speaks }
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
    ? `Voice changed to ${followed.name}: speaks ${listLanguages(followed.speaks)} natively.`
    : `Voice changed to ${followed.name}.`
