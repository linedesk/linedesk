/**
 * The web app's side: one provider per language, `useT()` for plain text, `<T>` for text with markup, `useFormat()`
 * for dates, numbers and lists, `useLocale()` for the active language.
 */
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { createIntl, createIntlCache, type IntlShape, RawIntlProvider } from 'react-intl'
import {
  type ActiveLocale,
  createFormatters,
  enMessages,
  type Formatters,
  intlConfig,
  type MessageKey,
  type Messages,
  type MessageValues,
  plainT,
  SOURCE,
} from './index.ts'

interface I18nValue {
  locale: ActiveLocale
  intl: IntlShape
  t: (key: MessageKey, values?: MessageValues) => string
  format: Formatters
}

const cache = createIntlCache()

/** Everything the hooks give, for one language and its messages. Also usable outside React (models, tests). */
export function createI18n(locale: ActiveLocale, messages: Messages = {}): I18nValue {
  const intl = createIntl(intlConfig(locale, messages), cache)
  return { locale, intl, t: plainT(intl, locale, messages), format: createFormatters(locale) }
}

const english = createI18n(SOURCE, enMessages)
const I18nContext = createContext<I18nValue>(english)

/** Gives its children one language. Without a provider (tests), everything is English. */
export function I18nProvider({ value, children }: { value: I18nValue; children: ReactNode }) {
  return (
    <I18nContext.Provider value={value}>
      <RawIntlProvider value={value.intl}>{children}</RawIntlProvider>
    </I18nContext.Provider>
  )
}

/** `t(key, values)`: a message as plain text in the active language. */
export function useT() {
  return useContext(I18nContext).t
}

/** Locale-aware formatting: `date`, `time`, `relative`, `number`, `currency`, `list`, `duration`. */
export function useFormat(): Formatters {
  return useContext(I18nContext).format
}

/** The active language ("en", "es", … or "en-XA"). */
export function useLocale(): ActiveLocale {
  return useContext(I18nContext).locale
}

type RichValue = string | number | boolean | Date | null | undefined | ReactNode | ((chunks: ReactNode[]) => ReactNode)

/**
 * A message with markup: `<T k="call.summary.from" values={{ name: 'Maya', b: chunks => <b>{chunks}</b> }} />`.
 * Tags in the message (`<b>…</b>`) map to functions in `values`; never build sentences by joining strings.
 */
export function T({ k, values }: { k: MessageKey; values?: Record<string, RichValue> }) {
  const { intl, t } = useContext(I18nContext)
  const node = useMemo(() => {
    if (!values) return t(k)
    return intl.formatMessage({ id: k, defaultMessage: enMessages[k] }, values as Record<string, ReactNode>)
  }, [intl, t, k, values])
  return <>{node}</>
}
