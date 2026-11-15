/**
 * The web app's active language: loaded before the first render, changed by the member's choice, the sign-in page's
 * select or `?lang=`. React reads it through `useT()`/`useFormat()` (@linedesk/i18n/react); code outside components
 * (models, time.ts) through `i18n()`.
 */
import { type ActiveLocale, enMessages, type Messages, PSEUDO_LOCALE, SOURCE, type UiLocale } from '@linedesk/i18n'
import { createI18n, I18nProvider } from '@linedesk/i18n/react'
import { type ReactNode, useSyncExternalStore } from 'react'
import {
  applyToDocument,
  browserLanguages,
  queryLocale,
  readStoredLocale,
  resolveLocale,
  storeLocale,
} from './locale.ts'

type I18n = ReturnType<typeof createI18n>

// English is in the bundle; every other language is its own chunk, loaded when needed.
const catalogs = import.meta.glob<Record<string, string>>(
  ['../../../../packages/i18n/locales/*/*.json', '!../../../../packages/i18n/locales/en/*.json', '!**/_*.json'],
  { import: 'default' },
)

/** One language's messages, flat (full keys). A file that fails to load (offline) leaves English for its keys. */
export async function loadMessages(locale: ActiveLocale): Promise<Messages> {
  if (locale === SOURCE) return {}
  if (locale === PSEUDO_LOCALE) {
    const { pseudoMessages } = await import('@linedesk/i18n/pseudo')
    return pseudoMessages(enMessages)
  }
  const files = Object.entries(catalogs).filter(([path]) => path.includes(`/locales/${locale}/`))
  const parts = await Promise.all(
    files.map(async ([path, load]) => {
      const namespace = path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
      try {
        const messages = await load()
        return Object.entries(messages).map(([key, text]) => [`${namespace}.${key}`, text] as const)
      } catch (error) {
        console.warn(`[i18n] could not load ${locale}/${namespace}`, error)
        return []
      }
    }),
  )
  return Object.fromEntries(parts.flat())
}

let current: I18n = createI18n(SOURCE)
const listeners = new Set<() => void>()
let pending: ActiveLocale | null = null

/** The active language's `t` and `format`, for code outside components. */
export const i18n = (): I18n => current

/**
 * Shows `locale` once its messages are loaded; a later call wins over an earlier one still loading. `remember`: this
 * browser opens in it next time (not for `?lang=`, which is for one visit).
 */
export async function activate(locale: ActiveLocale, { remember = true } = {}): Promise<void> {
  if (remember) storeLocale(locale)
  if (locale === current.locale && pending === null) return
  pending = locale
  const messages = await loadMessages(locale)
  if (pending !== locale) return
  pending = null
  current = createI18n(locale, messages)
  applyToDocument(locale)
  for (const listener of listeners) listener()
}

/** Whether the address picks the language for this visit (`?lang=`). */
export const languageFromAddress = () => queryLocale(window.location.search) !== null

/** The language before the session is known: `?lang=`, then this browser's last one, then its languages. */
export function initialLocale(): ActiveLocale {
  return resolveLocale({
    query: queryLocale(window.location.search),
    choice: undefined,
    stored: readStoredLocale(),
    languages: browserLanguages(),
  }).locale
}

/** The language for a signed-in member, and what Automatic resolves to here. */
export function localeFor(choice: string | null | undefined): { locale: ActiveLocale; auto: UiLocale } {
  return resolveLocale({
    query: queryLocale(window.location.search),
    choice: choice ?? null,
    stored: readStoredLocale(),
    languages: browserLanguages(),
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Gives the app the active language; everything below re-renders when it changes. */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const value = useSyncExternalStore(subscribe, () => current)
  return <I18nProvider value={value}>{children}</I18nProvider>
}
