/**
 * The one place that says which languages exist (docs/translations.md). English is the source and the fallback.
 * Adding a language: add it to UI_LOCALES, LOCALE_INFO and BETA_LOCALES, give it a section in STYLE.md, translate
 * every key as in the release translation pass. It shows as "Beta" in the picker until a native speaker has reviewed
 * the core flows.
 */
export const SOURCE = 'en'

/** The languages of the web app and the emails, in picker order. */
export const UI_LOCALES = ['en', 'es', 'pt-BR', 'fr', 'de', 'ja'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

/** Each language's own name and writing direction. */
export const LOCALE_INFO: Record<UiLocale, { name: string; dir: 'ltr' | 'rtl' }> = {
  en: { name: 'English', dir: 'ltr' },
  es: { name: 'Español', dir: 'ltr' },
  'pt-BR': { name: 'Português (Brasil)', dir: 'ltr' },
  fr: { name: 'Français', dir: 'ltr' },
  de: { name: 'Deutsch', dir: 'ltr' },
  ja: { name: '日本語', dir: 'ltr' },
}

/** Shown as "Beta" until a native speaker has reviewed sign-in, inbox, call view and account settings. */
export const BETA_LOCALES: readonly UiLocale[] = ['es', 'pt-BR', 'fr', 'de', 'ja']

/** Development and staging only: accented, longer text that shows untranslated strings and overflow. */
export const PSEUDO_LOCALE = 'en-XA'
export type ActiveLocale = UiLocale | typeof PSEUDO_LOCALE

/** One JSON file per namespace in locales/<locale>/. The first segment of every key. */
export const NAMESPACES = [
  'account',
  'admin',
  'auth',
  'call',
  'common',
  'contacts',
  'email',
  'errors',
  'inbox',
  'insights',
  'onboarding',
  'settings',
  'shell',
  'team',
] as const
export type Namespace = (typeof NAMESPACES)[number]

/** The languages each namespace is translated into. UI namespaces: every UI language but English. */
export function targetsOf(_namespace: Namespace): readonly UiLocale[] {
  return UI_LOCALES.filter(locale => locale !== SOURCE)
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value)
}
