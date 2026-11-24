/**
 * Formatting outside components (models, labels built in plain functions): the active language's formatters. In a
 * component, `useFormat()` from @linedesk/i18n/react. Never a fixed 'en-US' (docs/translations.md, "Formatting").
 */
import { intlLocaleOf } from '@linedesk/i18n'
import { i18n } from './index.tsx'

/** Dates, numbers, currency, lists and durations in the active language. */
export const fmt = () => i18n().format

/** The locale Intl formats with right now ("en" for the pseudo-locale), for Intl objects the formatters lack. */
export const intlLocale = () => intlLocaleOf(i18n().locale)
