// Which languages an assistant speaks with callers (`assistants.languages`): a main language (unless set, the
// workspace language when calls can be answered in it, else English) and, besides it, none, a picked list, or every
// supported language. The greeting and the fixed lines are in the main language (spoken-lines.ts); the call's summary
// is written in the workspace language for the team (English unless set, workspace-locale.ts), its transcript stays
// in the language spoken.
import { z } from 'zod'

/**
 * The languages an assistant can speak: the ones Deepgram's multilingual models (Flux `flux-general-multi`,
 * Nova-3 `multi`) recognize, which ElevenLabs Flash v2.5 and Cartesia Sonic also speak.
 */
export const LANGUAGES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ru: 'Russian',
  hi: 'Hindi',
  ja: 'Japanese',
} as const
export type Language = keyof typeof LANGUAGES
export const languageCodes = Object.keys(LANGUAGES) as Language[]
const languageCode = z.enum(languageCodes as [Language, ...Language[]])

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
 * The main language: the one stored; when none (or an unknown one) is, `fallback` (the workspace language) when calls
 * can be answered in it, else English.
 */
export const mainLanguageOf = (languages: StoredLanguages, fallback?: string | null): Language =>
  languageCodes.find(code => code === languages?.main) ?? languageCodes.find(code => code === fallback) ?? 'en'

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
