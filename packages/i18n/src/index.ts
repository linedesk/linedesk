/**
 * Linedesk's languages (docs/translations.md): ICU message catalogs, used by the web app (src/react.tsx) and the
 * server (src/server.ts) through FormatJS. English is the source; a key missing in another language shows English.
 */

import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { createIntl, createIntlCache, type IntlShape } from '@formatjs/intl'
import { match } from '@formatjs/intl-localematcher'
import {
  type ActiveLocale,
  isUiLocale,
  LOCALE_INFO,
  PSEUDO_LOCALE,
  SOURCE,
  UI_LOCALES,
  type UiLocale,
} from '../locales.ts'
import { EN_CATALOGS, type MessageKey } from './keys.ts'

export * from '../locales.ts'
export type { MessageKey } from './keys.ts'

/** A flat catalog: full key ("inbox.row.markHandled") to an ICU message, or its parsed form (pseudo-locale). */
export type Messages = Record<string, string | MessageFormatElement[]>
/** Values a plain-text message takes. */
export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>

/** Namespace files ({ "row.markHandled": "…" }) to one flat catalog with full keys. */
export function flatten(catalogs: Record<string, Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [namespace, messages] of Object.entries(catalogs))
    for (const [key, message] of Object.entries(messages)) out[`${namespace}.${key}`] = message
  return out
}

/** The English messages, the source and the fallback for every other language. */
export const enMessages: Record<string, string> = flatten(EN_CATALOGS)

/**
 * A key for a table of labels (navigation, menus) that is translated later with `t()`. Only marks the string as a
 * key for the type checker and `pnpm i18n:check`; it returns the key unchanged.
 */
export const msg = (key: MessageKey): MessageKey => key

/**
 * The best UI language for a list of preferred languages (the browser's `navigator.languages`, an Accept-Language
 * header): pt-PT and pt give pt-BR, es-419 gives es, fr-CA gives fr; nothing close gives English.
 */
export function matchLocale(requested: readonly string[]): UiLocale {
  const valid = requested.filter(tag => {
    try {
      return Intl.getCanonicalLocales(tag).length > 0
    } catch {
      return false
    }
  })
  if (!valid.length) return SOURCE
  try {
    return match(valid, UI_LOCALES, SOURCE, { algorithm: 'best fit' }) as UiLocale
  } catch {
    return SOURCE
  }
}

/** The languages of an Accept-Language header, best first ("fr-CA,fr;q=0.9,en;q=0.8" gives fr-CA, fr, en). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='))
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, index }
    })
    .filter(entry => entry.tag && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map(entry => entry.tag)
}

/** The locale Intl formats with: the pseudo-locale formats like English. */
export const intlLocaleOf = (locale: ActiveLocale): UiLocale => (locale === PSEUDO_LOCALE ? SOURCE : locale)

/** A language's name as `inLocale` writes it, capitalized for a list ("español" → "Español"); null when unknown. */
function displayName(code: string, inLocale: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(code)
    return name && name !== code ? name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1) : null
  } catch {
    return null
  }
}

/**
 * How a language list names a language (every language picker): its own name, then its name in the UI language,
 * "Español · Spanish" in English, "Español · Spanisch" in German; once when both are the same ("English" in English).
 * A UI language uses its name from LOCALE_INFO ("Português (Brasil)"), a voice language Intl's ("Português" for pt).
 */
export function languageLabel(code: string, uiLocale: ActiveLocale): string {
  const own = (isUiLocale(code) ? LOCALE_INFO[code].name : null) ?? displayName(code, code) ?? code
  const inUi = displayName(code, intlLocaleOf(uiLocale))
  return !inUi || inUi === own ? own : `${own} · ${inUi}`
}

/** A language's name in the UI language as a sentence writes it ("Spanish" in en, "Spanisch" in de, "inglés" in es). */
export function languageInSentence(code: string, uiLocale: ActiveLocale): string {
  try {
    return new Intl.DisplayNames([intlLocaleOf(uiLocale)], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export interface Formatters {
  /** A date ("Nov 14, 2026" in en, "14 nov 2026" in es). Default: medium date. */
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  /** A clock time ("2:58 PM" in en, "14:58" in de). */
  time(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  /** Any date and time fields; builds each formatter once. */
  dateTime(value: Date | number, options: Intl.DateTimeFormatOptions): string
  /** "in 3 days", "2 hours ago". */
  relative(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
  number(value: number, options?: Intl.NumberFormatOptions): string
  /** An amount in a currency ("$1,234.50" in en, "1.234,50 US$" in de). */
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string
  /** "A, B and C" in the active language. */
  list(items: readonly string[], options?: Intl.ListFormatOptions): string
  /**
   * A length of time from seconds: "1 min, 20 sec" (short), "1m 20s" (narrow) or "01:20" (digital: as short in every
   * language, for narrow columns; hours only when there are any, "1:03:01").
   */
  duration(seconds: number, style?: 'long' | 'short' | 'narrow' | 'digital'): string
}

const intlCache = new Map<string, unknown>()
function cached<T>(kind: string, locale: string, options: object | undefined, make: () => T): T {
  const key = `${kind}|${locale}|${options ? JSON.stringify(options) : ''}`
  let value = intlCache.get(key) as T | undefined
  if (!value) {
    value = make()
    intlCache.set(key, value)
  }
  return value
}

type DurationFormatCtor = new (
  locale: string,
  options: { style: string; hoursDisplay?: 'auto' | 'always' },
) => { format(duration: { hours?: number; minutes?: number; seconds?: number }): string }

/** Locale-aware formatting; every formatter is built once per locale and options (they are costly to build). */
export function createFormatters(active: ActiveLocale): Formatters {
  const locale = intlLocaleOf(active)
  const dtf = (options: Intl.DateTimeFormatOptions) =>
    cached('dt', locale, options, () => new Intl.DateTimeFormat(locale, options))
  return {
    date: (value, options = { dateStyle: 'medium' }) => dtf(options).format(value),
    time: (value, options = { hour: 'numeric', minute: '2-digit' }) => dtf(options).format(value),
    dateTime: (value, options) => dtf(options).format(value),
    relative: (value, unit, options = { numeric: 'auto' }) =>
      cached('rt', locale, options, () => new Intl.RelativeTimeFormat(locale, options)).format(value, unit),
    number: (value, options) =>
      cached('nf', locale, options, () => new Intl.NumberFormat(locale, options)).format(value),
    currency: (value, currency, options) => {
      const all = { style: 'currency', currency, ...options } as const
      return cached('cur', locale, all, () => new Intl.NumberFormat(locale, all)).format(value)
    },
    list: (items, options = { type: 'conjunction' }) =>
      cached('lf', locale, options, () => new Intl.ListFormat(locale, options)).format(items),
    duration: (seconds, style = 'short') => {
      const total = Math.max(0, Math.round(seconds))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const secs = total % 60
      const parts = {
        ...(hours ? { hours } : {}),
        ...(minutes ? { minutes } : {}),
        ...(secs || !total ? { seconds: secs } : {}),
      }
      const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat
      if (style === 'digital') {
        if (DurationFormat)
          return cached('df', locale, { style }, () => new DurationFormat(locale, { style, hoursDisplay: 'auto' })).format(
            { hours, minutes, seconds: secs },
          )
        const two = (value: number) =>
          cached('nf', locale, { minimumIntegerDigits: 2 }, () => new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 })).format(
            value,
          )
        return [...(hours ? [String(hours)] : []), two(minutes), two(secs)].join(':')
      }
      if (DurationFormat)
        return cached('df', locale, { style }, () => new DurationFormat(locale, { style })).format(parts)
      // No Intl.DurationFormat (older browsers): units through NumberFormat, joined as a list.
      const unitStyle = style === 'long' ? 'long' : style === 'narrow' ? 'narrow' : 'short'
      const unit = (value: number, name: string) =>
        cached(
          'nfu',
          locale,
          { name, unitStyle },
          () => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: unitStyle }),
        ).format(value)
      const pieces = [
        ...(hours ? [unit(hours, 'hour')] : []),
        ...(minutes ? [unit(minutes, 'minute')] : []),
        ...(secs || !total ? [unit(secs, 'second')] : []),
      ]
      return cached(
        'lfu',
        locale,
        { unitStyle },
        () => new Intl.ListFormat(locale, { type: 'unit', style: unitStyle }),
      ).format(pieces)
    },
  }
}

export interface Translator {
  locale: ActiveLocale
  intl: IntlShape<string>
  /** A message as plain text. A key missing in this language gives the English text. */
  t(key: MessageKey, values?: MessageValues): string
  format: Formatters
}

const warned = new Set<string>()
/** Development only: a key this language does not have yet, once per key. */
function warnMissing(locale: string, key: string) {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV
  if (!dev || warned.has(`${locale}|${key}`)) return
  warned.add(`${locale}|${key}`)
  console.warn(`[i18n] ${locale} has no "${key}" yet, showing English`)
}

const sharedCache = createIntlCache()

/** What FormatJS's createIntl needs for one language (web: react-intl's, server: @formatjs/intl's). */
export function intlConfig(locale: ActiveLocale, messages: Messages = {}) {
  const merged: Messages = locale === SOURCE ? enMessages : { ...enMessages, ...messages }
  return {
    locale: intlLocaleOf(locale),
    defaultLocale: SOURCE,
    // FormatJS takes strings or parsed messages (the pseudo-locale), mixed per key at runtime.
    messages: merged as Record<string, string>,
    onError: (error: { code: string; message: string }) => {
      if (error.code === 'MISSING_TRANSLATION') return
      console.error(`[i18n] ${error.message}`)
    },
  }
}

/** `t()` on top of an intl object: plain text, English for a key this language does not have yet. */
export function plainT(
  intl: {
    formatMessage(descriptor: { id: string; defaultMessage?: string }, values?: Record<string, unknown>): unknown
  },
  locale: ActiveLocale,
  messages: Messages,
) {
  return (key: MessageKey, values?: MessageValues): string => {
    if (locale !== SOURCE && !(key in messages)) warnMissing(locale, key)
    return String(intl.formatMessage({ id: key, defaultMessage: enMessages[key] }, values))
  }
}

/**
 * A translator for one language. `messages` are that language's (flat, full keys); English fills every gap.
 * Format errors (a broken translation) are logged.
 */
export function createTranslator(locale: ActiveLocale, messages: Messages = {}): Translator {
  const intl = createIntl<string>(intlConfig(locale, messages), sharedCache)
  return { locale, intl, t: plainT(intl, locale, messages), format: createFormatters(locale) }
}
