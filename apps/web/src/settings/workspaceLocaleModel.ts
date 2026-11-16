// The options of Workspace settings › General › Country (and New workspace): every country of the phone field (flags,
// common ones first), opened by "Automatic (…)": the country worked out when none is set (workspace-locale.ts in
// @linedesk/actions).
import { phoneCountryName, type WorkspaceCountrySource } from '@linedesk/actions'
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
        : i18n().t('settings.general.locale.automaticCountry', {
            country: phoneCountryName(resolvedCountry, i18n()),
            source,
          }),
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
