// Which languages an assistant speaks with callers: English only (the default), English plus an allow-list,
// or any language the speech recognition understands. The greeting is always in English; the call's summary
// is written in English for the team, its transcript stays in the language spoken.
import { z } from 'zod'

/**
 * Languages other than English the assistant can switch to: the ones Deepgram's multilingual models
 * (Flux `flux-general-multi`, Nova-3 `multi`) recognize, which ElevenLabs Flash v2.5 and Cartesia Sonic also speak.
 */
export const CALLER_LANGUAGES = {
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
export type CallerLanguage = keyof typeof CALLER_LANGUAGES
export const callerLanguageCodes = Object.keys(CALLER_LANGUAGES) as CallerLanguage[]

/** `english`: English only; `allowed`: English and `allowed`; `any`: every language in CALLER_LANGUAGES. */
export const assistantLanguages = z.object({
  mode: z.enum(['english', 'allowed', 'any']),
  allowed: z
    .array(z.enum(callerLanguageCodes as [CallerLanguage, ...CallerLanguage[]]))
    .max(callerLanguageCodes.length),
})
export type AssistantLanguages = z.infer<typeof assistantLanguages>

export const ENGLISH_ONLY: AssistantLanguages = { mode: 'english', allowed: [] }

/** The languages besides English a call may switch to (none: English only). Unknown codes are dropped. */
export function otherLanguagesOf(
  languages: { mode?: string; allowed?: readonly string[] } | null | undefined,
): CallerLanguage[] {
  if (languages?.mode === 'any') return callerLanguageCodes
  if (languages?.mode !== 'allowed') return []
  return callerLanguageCodes.filter(code => languages.allowed?.includes(code))
}

/** "Spanish and German", "Spanish, French or German". */
export function languageNames(codes: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  const names = codes.map(code => CALLER_LANGUAGES[code as CallerLanguage] ?? 'English')
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}` : (names[0] ?? '')
}
