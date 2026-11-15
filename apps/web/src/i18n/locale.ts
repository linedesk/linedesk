/**
 * Which language the web app shows (docs/translations.md, "Levels"):
 * 1. `?lang=` in the address (any UI language, or the pseudo-locale en-XA), for this visit only;
 * 2. the member's choice (`locale` from /v1/me);
 * 3. Automatic: the browser's languages matched to the UI languages (pt-PT gives pt-BR, fr-CA gives fr);
 * 4. English.
 * Before the session is known (sign-in page, boot): the last language this browser used, else the browser's.
 */
import { type ActiveLocale, isUiLocale, LOCALE_INFO, matchLocale, PSEUDO_LOCALE, type UiLocale } from '@linedesk/i18n'

/** The last language this browser showed; public/locale.js reads it to set <html lang> before the first paint. */
export const LOCALE_KEY = 'linedesk.locale'

export function readStoredLocale(): UiLocale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_KEY)
    return isUiLocale(value) ? value : null
  } catch {
    return null
  }
}

export function storeLocale(locale: ActiveLocale) {
  if (!isUiLocale(locale)) return
  try {
    window.localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Private mode: the next visit starts from the browser's languages again.
  }
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
}

/** `?lang=es` or `?lang=en-XA` from the address; anything else is ignored. */
export function queryLocale(search: string): ActiveLocale | null {
  const value = new URLSearchParams(search).get('lang')
  if (value === PSEUDO_LOCALE) return PSEUDO_LOCALE
  return isUiLocale(value) ? value : null
}

export interface LocaleInputs {
  query: ActiveLocale | null
  /** The member's choice; null: Automatic; undefined: not signed in (or not known yet). */
  choice: string | null | undefined
  stored: UiLocale | null
  languages: readonly string[]
}

/** The language to show, and what Automatic resolves to in this browser (saved for emails). */
export function resolveLocale({ query, choice, stored, languages }: LocaleInputs): {
  locale: ActiveLocale
  auto: UiLocale
} {
  const auto = matchLocale(languages)
  if (query) return { locale: query, auto }
  if (isUiLocale(choice)) return { locale: choice, auto }
  if (choice === undefined && stored) return { locale: stored, auto }
  return { locale: auto, auto }
}

/** <html lang> and dir for the active language (screen readers, hyphenation, fonts for Japanese). */
export function applyToDocument(locale: ActiveLocale) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.documentElement.dir = isUiLocale(locale) ? LOCALE_INFO[locale].dir : 'ltr'
}

/**
 * The browser's first language when Linedesk doesn't have it and it isn't English ("it-IT" gives "it"); null when it
 * is covered. Account › Preferences then offers to ask for it.
 */
export function missingBrowserLanguage(languages: readonly string[]): string | null {
  const first = languages[0]
  if (!first) return null
  const base = first.split('-')[0]?.toLowerCase() ?? ''
  if (!base || base === 'en') return null
  return matchLocale([first]) === 'en' ? first : null
}
