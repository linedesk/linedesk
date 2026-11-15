// The options of Workspace settings › General › Country and Language (and the onboarding business step): every country
// of the phone field (flags, common ones first) and the languages calls can be answered in, each list opened by
// "Automatic (…)": the country or language worked out when none is set (workspace-locale.ts in @linedesk/actions).
import {
  COUNTRY_LANGUAGES,
  isVoiceLanguage,
  LANGUAGES,
  languageCodes,
  phoneCountryName,
  type WorkspaceCountrySource,
  workspaceLanguageName,
} from '@linedesk/actions'
import { type ActiveLocale, intlLocaleOf, languageLabel, SOURCE } from '@linedesk/i18n'
import { i18n } from '../i18n/index.tsx'
import { phoneCountryOptions, searchPhoneCountries } from '../ui/phoneInputModel.ts'
import { type SearchOption, searchOptions } from '../ui/SearchSelect.tsx'

/** The value of "Automatic": nothing set (null in workspace.updateSettings). */
export const AUTOMATIC = ''

/** What the country list shows: `resolvedCountry` and its source while none is set. */
export function countryOptions(resolvedCountry: string, source: WorkspaceCountrySource): SearchOption[] {
  const automatic: SearchOption = {
    value: AUTOMATIC,
    label:
      source === 'explicit'
        ? i18n().t('settings.general.locale.automaticCountryExplicit')
        : i18n().t('settings.general.locale.automaticCountry', { country: phoneCountryName(resolvedCountry), source }),
  }
  return [
    automatic,
    ...phoneCountryOptions().map(o => ({
      value: o.value,
      label: o.name,
      icon: o.flag,
      meta: o.value,
      ...(o.group ? { group: o.group } : {}),
    })),
  ]
}

/** The country search of the phone field (name, ISO code), with "Automatic" kept when it matches. */
export function searchCountries(options: readonly SearchOption[], query: string): SearchOption[] {
  if (!query.trim()) return [...options]
  const automatic = options.filter(o => o.value === AUTOMATIC && searchOptions([o], query).length)
  const phone = phoneCountryOptions()
  const found = new Set(searchPhoneCountries(phone, query).map(o => o.value))
  const byCode = new Map(options.map(o => [o.value, o]))
  return [...automatic, ...[...found].map(code => ({ ...byCode.get(code)!, group: undefined }))]
}

/** The language a country speaks (COUNTRY_LANGUAGES), the one "Automatic" stands for. */
export const countryLanguage = (country: string): string => COUNTRY_LANGUAGES[country] ?? 'en'

/** A language's name in the UI language: the English name the API uses in English, Intl's in any other. */
function languageNameIn(language: string, ui: ActiveLocale): string {
  if (ui === SOURCE) return workspaceLanguageName(language)
  try {
    return (
      new Intl.DisplayNames([intlLocaleOf(ui)], { type: 'language' }).of(language) ?? workspaceLanguageName(language)
    )
  } catch {
    return workspaceLanguageName(language)
  }
}

/**
 * "Automatic (Deutsch · German, from your country)"; for a country whose language calls cannot be answered in yet,
 * what they are answered in instead: "Automatic (Korean summaries; calls in English)". `ui`: the UI language.
 */
export function automaticLanguageOption(country: string, ui: ActiveLocale): SearchOption {
  const language = countryLanguage(country)
  return {
    value: AUTOMATIC,
    label: isVoiceLanguage(language)
      ? i18n().t('settings.general.locale.automaticLanguage', { language: languageLabel(language, ui) })
      : i18n().t('settings.general.locale.automaticSummariesOnly', { language: languageNameIn(language, ui) }),
  }
}

/**
 * "Automatic", then every language calls can be answered in (A–Z by English name), each in its own name and in the UI
 * language `ui` ("Español · Spanish").
 */
export function languageOptions(country: string, ui: ActiveLocale): SearchOption[] {
  return [
    automaticLanguageOption(country, ui),
    ...[...languageCodes]
      .sort((a, b) => LANGUAGES[a].localeCompare(LANGUAGES[b], 'en'))
      .map(code => ({ value: code, label: languageLabel(code, ui), meta: code })),
  ]
}
