/**
 * The server's side (emails, notifications): `getT(locale)` gives `{ t, format }` for one language. Every catalog is
 * read once, the first time a language is asked for (about 100 KB each).
 */
import { readdirSync, readFileSync } from 'node:fs'
import {
  createTranslator,
  flatten,
  isUiLocale,
  matchLocale,
  parseAcceptLanguage,
  SOURCE,
  type Translator,
  type UiLocale,
} from './index.ts'

const LOCALES_DIR = new URL('../locales/', import.meta.url)

/** One language's catalogs from locales/<locale>/*.json, flat (full keys). Files starting with "_" are notes. */
export function readCatalog(locale: string): Record<string, string> {
  const dir = new URL(`${locale}/`, LOCALES_DIR)
  let files: string[]
  try {
    files = readdirSync(dir).filter(file => file.endsWith('.json') && !file.startsWith('_'))
  } catch {
    return {}
  }
  const catalogs: Record<string, Record<string, string>> = {}
  for (const file of files)
    catalogs[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
  return flatten(catalogs)
}

const translators = new Map<UiLocale, Translator>()

/** `{ t, format }` for a UI language; anything else gives English. */
export function getT(locale: string | null | undefined): Translator {
  const ui = isUiLocale(locale) ? locale : SOURCE
  let translator = translators.get(ui)
  if (!translator) {
    translator = createTranslator(ui, ui === SOURCE ? {} : readCatalog(ui))
    translators.set(ui, translator)
  }
  return translator
}

/** The user fields that hold a person's language (Better Auth's `user`). */
export interface LocaleFields {
  locale?: string | null
  localeAuto?: string | null
}

/**
 * The language for an email about a person's own account: their choice, else what "Automatic" last resolved to in
 * their browser, else the request's Accept-Language (sign-in code: often no user yet), else English.
 */
export function localeForUser(user: LocaleFields | null | undefined, acceptLanguage?: string | null): UiLocale {
  if (isUiLocale(user?.locale)) return user.locale
  if (isUiLocale(user?.localeAuto)) return user.localeAuto
  const requested = parseAcceptLanguage(acceptLanguage)
  return requested.length ? matchLocale(requested) : SOURCE
}
