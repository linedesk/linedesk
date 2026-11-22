// Which languages an assistant speaks with callers (`assistants.languages`): a main language (unless set, the
// workspace language when calls can be answered in it, else English) and, besides it, none, a picked list, or every
// supported language. The greeting and the fixed lines are in the main language (spoken-lines.ts); the call's summary,
// title and next steps are written in the language the call is answered in (callLanguageOf), its transcript stays in the
// language spoken.
import { z } from 'zod'

/**
 * Every language an assistant can speak, with who supports it (checked against the official docs on 2026-11-15):
 * - `flux`: Deepgram Flux multilingual (`flux-general-multi`) recognizes it; a call whose languages all have it keeps
 *   Flux (its turn detection), any other call uses Deepgram Nova-3 `multi` (pipeline.ts createStt), which
 *   recognizes all of them (developers.deepgram.com/docs/models-languages-overview).
 * - `assemblyai`: AssemblyAI's Universal-3 Pro streaming hears it (`language_codes` in its API reference, 2026-11-17;
 *   the same list as ASSEMBLYAI_LANGUAGES in apps/agent/src/pipeline.ts). While AssemblyAI is the install's speech
 *   recognition, a call in a language without it uses Deepgram Nova-3 when Deepgram is set up too; else the language
 *   is not offered (sttHears; LIN-656: the Polish test call came out as Cyrillic).
 * - `elevenlabs`: ElevenLabs Flash v2.5 (and Turbo v2.5) speak it (elevenlabs.io/docs/overview/models).
 * - `cartesia`: Cartesia Sonic 3 speaks it (docs.cartesia.ai/build-with-cartesia/tts-models/latest).
 * - `codes`: the provider's code where it is not ours (none so far; Filipino would be `fil` at ElevenLabs, `tl` at
 *   Deepgram and Cartesia).
 * A language is offered only when a connected voice provider speaks it (spokenLanguages); every one needs its fixed
 * lines (spoken-lines.ts) and a preview text (apps/api/src/voices.ts).
 */
type LanguageSupport = {
  name: string
  flux: boolean
  assemblyai: boolean
  elevenlabs: boolean
  cartesia: boolean
  codes?: Partial<Record<LanguageProvider, string>>
}
/** The providers whose language codes can differ from ours. */
export type LanguageProvider = 'deepgram' | 'elevenlabs' | 'cartesia'

const all = { elevenlabs: true, cartesia: true } as const
export const LANGUAGE_SUPPORT = {
  en: { name: 'English', assemblyai: true, flux: true, ...all },
  es: { name: 'Spanish', assemblyai: true, flux: true, ...all },
  fr: { name: 'French', assemblyai: true, flux: true, ...all },
  de: { name: 'German', assemblyai: true, flux: true, ...all },
  it: { name: 'Italian', assemblyai: true, flux: true, ...all },
  pt: { name: 'Portuguese', assemblyai: true, flux: true, ...all },
  nl: { name: 'Dutch', assemblyai: true, flux: true, ...all },
  ru: { name: 'Russian', assemblyai: true, flux: true, ...all },
  hi: { name: 'Hindi', assemblyai: true, flux: true, ...all },
  ja: { name: 'Japanese', assemblyai: true, flux: true, ...all },
  zh: { name: 'Chinese (Mandarin)', assemblyai: true, flux: false, ...all },
  ko: { name: 'Korean', assemblyai: true, flux: false, ...all },
  pl: { name: 'Polish', assemblyai: false, flux: false, ...all },
  tr: { name: 'Turkish', assemblyai: true, flux: false, ...all },
  vi: { name: 'Vietnamese', assemblyai: true, flux: false, ...all },
  id: { name: 'Indonesian', assemblyai: false, flux: false, ...all },
  sv: { name: 'Swedish', assemblyai: true, flux: false, ...all },
  ar: { name: 'Arabic', assemblyai: true, flux: false, ...all },
  uk: { name: 'Ukrainian', assemblyai: false, flux: false, ...all },
  ro: { name: 'Romanian', assemblyai: true, flux: false, ...all },
  cs: { name: 'Czech', assemblyai: false, flux: false, ...all },
  el: { name: 'Greek', assemblyai: false, flux: false, ...all },
  da: { name: 'Danish', assemblyai: true, flux: false, ...all },
  fi: { name: 'Finnish', assemblyai: true, flux: false, ...all },
  no: { name: 'Norwegian', assemblyai: true, flux: false, ...all },
  hu: { name: 'Hungarian', assemblyai: false, flux: false, ...all },
} as const satisfies Record<string, LanguageSupport>

/** The languages an assistant can speak: code → English name (LANGUAGE_SUPPORT). */
export const LANGUAGES = Object.fromEntries(Object.entries(LANGUAGE_SUPPORT).map(([code, l]) => [code, l.name])) as {
  readonly [code in keyof typeof LANGUAGE_SUPPORT]: (typeof LANGUAGE_SUPPORT)[code]['name']
}
export type Language = keyof typeof LANGUAGE_SUPPORT
export const languageCodes = Object.keys(LANGUAGES) as Language[]
const languageCode = z.enum(languageCodes as [Language, ...Language[]])

/**
 * Languages the pickers do not offer for now. Empty since Mandarin and Korean passed their test calls on LIN-268
 * (room mode, three stages); they were hidden since LIN-461. To hide one again, add it
 * here. Hidden is only about new choices: an assistant that already has one keeps it, on calls and in its settings
 * (offeredLanguages in the web app, checkAssistantLanguages in the API), and the spoken lines stay.
 */
export const HIDDEN_LANGUAGES: readonly Language[] = []
/** Whether a language may be picked as a new choice (not in HIDDEN_LANGUAGES). */
export const isPickable = (code: string): boolean => !(HIDDEN_LANGUAGES as readonly string[]).includes(code)
/** The languages of `codes` that may be picked as a new choice, in the same order. */
export const pickableLanguages = <T extends string>(codes: readonly T[]): T[] => codes.filter(isPickable)

/**
 * `main`: the language the assistant greets and speaks in (missing: English). `mode`: the languages besides it:
 * `english` none (the name is from before the main language could be picked), `allowed` the `allowed` ones,
 * `any` every supported language.
 */
export const assistantLanguages = z.object({
  main: languageCode.optional(),
  mode: z.enum(['english', 'allowed', 'any']),
  allowed: z.array(languageCode).max(languageCodes.length),
})
export type AssistantLanguages = z.infer<typeof assistantLanguages>

export const ENGLISH_ONLY: AssistantLanguages = { main: 'en', mode: 'english', allowed: [] }

type StoredLanguages = { main?: string; mode?: string; allowed?: readonly string[] } | null | undefined

/**
 * The main language: the one stored (a hidden one too, HIDDEN_LANGUAGES); when none (or an unknown one) is, `fallback`
 * (the workspace language) when calls can be answered in it and it is not hidden, else English.
 */
export const mainLanguageOf = (languages: StoredLanguages, fallback?: string | null): Language =>
  languageCodes.find(code => code === languages?.main) ??
  languageCodes.find(code => code === fallback && isPickable(code)) ??
  'en'

/**
 * The language a call is answered in, which its title, summary and next steps for the team are written in (and the
 * texts a call that is not answered is filed with): the assistant's main language (mainLanguageOf, the workspace
 * language when it has none); without an assistant, the workspace language. A German assistant in a workspace whose
 * country is not set yet (the sign-up hint said US) writes its summaries in German, not English.
 */
export const callLanguageOf = (
  assistant: { languages?: StoredLanguages } | null | undefined,
  workspaceLanguage: string | null | undefined,
): string => (assistant ? mainLanguageOf(assistant.languages, workspaceLanguage) : workspaceLanguage || 'en')

/** The languages besides the main one a call may switch to (none: the main language only). Unknown codes are dropped. */
export function otherLanguagesOf(languages: StoredLanguages, fallback?: string | null): Language[] {
  const main = mainLanguageOf(languages, fallback)
  if (languages?.mode === 'any') return languageCodes.filter(code => code !== main)
  if (languages?.mode !== 'allowed') return []
  return languageCodes.filter(code => code !== main && languages.allowed?.includes(code))
}

/** "Spanish and German", "English, French or German". */
export function languageNames(codes: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  const names = codes.map(code => LANGUAGES[code as Language] ?? code)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}` : (names[0] ?? '')
}

/** Whether Deepgram Flux multilingual recognizes a language (else the call needs Nova-3 `multi`). */
export const fluxRecognizes = (code: Language): boolean => LANGUAGE_SUPPORT[code]?.flux ?? false

/** The code a provider takes for one of our languages. */
export const providerLanguageCode = (code: Language, provider: LanguageProvider): string =>
  (LANGUAGE_SUPPORT[code] as LanguageSupport | undefined)?.codes?.[provider] ?? code

/** The languages Cartesia's Sonic 2 speaks (docs.cartesia.ai, older models); Sonic 3 speaks every `cartesia` one. */
const SONIC_2_LANGUAGES: readonly string[] = [
  'en',
  'fr',
  'de',
  'es',
  'pt',
  'zh',
  'ja',
  'hi',
  'it',
  'ko',
  'nl',
  'pl',
  'ru',
  'sv',
  'tr',
]
/** Eleven Multilingual v2 speaks Flash v2.5's languages but these (elevenlabs.io/docs/overview/models). */
const NOT_MULTILINGUAL_V2: readonly string[] = ['hu', 'no', 'vi']

/** A connected voice provider and the model it speaks with (none set: the one the agent uses by default). */
export type SpeakingVoice = { provider: string; model?: string | null }

/**
 * Whether a voice provider speaks a language with its model: the table's column for the default models (ElevenLabs
 * Flash v2.5, Cartesia Sonic 3), less what an older model lacks (Eleven Multilingual v2, the English-only Eleven v2
 * models, Cartesia Sonic 2). Another provider: no.
 */
export function voiceSpeaks({ provider, model }: SpeakingVoice, code: Language): boolean {
  const support = LANGUAGE_SUPPORT[code]
  if (!support) return false
  const m = model?.trim().toLowerCase() ?? ''
  if (provider === 'elevenlabs') {
    if (/^eleven_(flash|turbo)_v2$|^eleven_monolingual/.test(m)) return code === 'en'
    if (m.startsWith('eleven_multilingual_v2')) return support.elevenlabs && !NOT_MULTILINGUAL_V2.includes(code)
    return support.elevenlabs
  }
  if (provider === 'cartesia')
    return m.startsWith('sonic-2') || m === 'sonic' ? SONIC_2_LANGUAGES.includes(code) : support.cartesia
  return false
}

/** The languages Flux recognizes: what an install without a voice provider (a realtime model only) offers. */
export const FLUX_LANGUAGES: readonly Language[] = languageCodes.filter(fluxRecognizes)

/**
 * The languages calls can be answered in on an install: those at least one connected voice provider speaks (English
 * always). No voice provider (calls answered by a realtime model only): the Flux languages, as before more were added.
 */
export function spokenLanguages(voices: readonly SpeakingVoice[]): Language[] {
  if (!voices.length) return [...FLUX_LANGUAGES]
  return languageCodes.filter(code => code === 'en' || voices.some(v => voiceSpeaks(v, code)))
}

/** The speech recognition in use: provider and model (none set: the provider's default; Deepgram's is Flux). */
export type HearingModel = {
  provider: string
  model?: string | null
  /** AssemblyAI only: Deepgram is set up too, so a call in a language AssemblyAI can't understand uses Deepgram Nova-3. */
  fallback?: unknown
}

/** The languages AssemblyAI's older Universal Streaming multilingual model hears (its docs, 2026-11-20). */
const ASSEMBLYAI_MULTILINGUAL: readonly string[] = ['en', 'es', 'fr', 'de', 'it', 'pt']

/**
 * Whether the speech recognition in use hears a language: AssemblyAI only those of its column (Universal Streaming
 * multilingual only its 6), unless Deepgram is set up too (`fallback`: such a call uses Deepgram Nova-3); every other
 * provider all of the table (Deepgram through Nova-3 `multi`, ElevenLabs Scribe, OpenAI transcription). None set up: yes.
 */
export function sttHears(stt: HearingModel | null | undefined, code: Language): boolean {
  if (stt?.provider !== 'assemblyai_stt' || stt.fallback) return true
  if (stt.model?.trim() === 'universal-streaming-multilingual') return ASSEMBLYAI_MULTILINGUAL.includes(code)
  return LANGUAGE_SUPPORT[code]?.assemblyai ?? false
}

/** The languages of `spoken` the speech recognition hears (sttHears); English always. */
export const heardLanguages = (spoken: readonly Language[], stt: HearingModel | null | undefined): Language[] =>
  spoken.filter(code => code === 'en' || sttHears(stt, code))

/**
 * What "any language" (`mode: 'any'`) covers: every language the install speaks (`spoken`), but with a Deepgram Flux
 * model only Flux's 10, so those assistants stay on Flux (coordinator decision on LIN-268). A language outside them is
 * used only when picked as the main language or in the allowed list. A hidden language (HIDDEN_LANGUAGES) never, nor one the
 * speech recognition does not hear (sttHears).
 */
export function anyModeLanguages(spoken: readonly Language[], stt?: HearingModel | null): Language[] {
  const flux = stt?.provider === 'deepgram' && (stt.model?.trim() || 'flux').startsWith('flux')
  // A hidden language (HIDDEN_LANGUAGES) is never part of "any": only an assistant that picked it speaks it.
  return heardLanguages(spoken, stt).filter(code => isPickable(code) && (!flux || fluxRecognizes(code)))
}

/** The codes of `languages` (as stored) that the install can't answer calls in (spokenLanguages); none: it can save them. */
export function unspokenLanguages(languages: StoredLanguages, spoken: readonly string[]): string[] {
  const codes = [
    ...(languages?.main ? [languages.main] : []),
    ...(languages?.mode === 'allowed' ? (languages.allowed ?? []) : []),
  ]
  return [...new Set(codes)].filter(code => !spoken.includes(code))
}
