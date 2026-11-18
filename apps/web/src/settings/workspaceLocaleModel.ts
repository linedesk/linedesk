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

/**
 * Only the countries a workspace may be in (`served`), in that order, plus the one it has (`value`) when that is
 * another (a workspace that came to a Cloud bill from elsewhere still shows its country). "Automatic" stays first. No
 * group headings: the list is short.
 */
export function servedOptions(all: readonly SearchOption[], served: readonly string[], value: string): SearchOption[] {
  const byCode = new Map(all.map(o => [o.value, o]))
  const codes = [...served, ...(value && value !== AUTOMATIC && !served.includes(value) ? [value] : [])]
  const automatic = all.filter(o => o.value === AUTOMATIC)
  const countries = codes.flatMap(code => {
    const option = byCode.get(code)
    if (!option) return []
    const { group: _group, ...rest } = option
    return [rest]
  })
  return [...automatic, ...countries]
}

/** The country search of the phone field (name, ISO code), with "Automatic" kept when it matches. */
export function searchCountries(options: readonly SearchOption[], query: string): SearchOption[] {
  if (!query.trim()) return [...options]
  const automatic = options.filter(o => o.value === AUTOMATIC && searchOptions([o], query).length)
  const phone = phoneCountryOptions()
  const found = new Set(searchPhoneCountries(phone, query).map(o => o.value))
  const byCode = new Map(options.map(o => [o.value, o]))
  // Only the options offered (a list of the served countries is shorter than the phone field's).
  const countries = [...found].flatMap(code => {
    const option = byCode.get(code)
    return option ? [{ ...option, group: undefined }] : []
  })
  return [...automatic, ...countries]
}
