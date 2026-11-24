// The main language picker's search: a language by its name, or by a country that speaks it ("Mexico" finds Spanish).
import { COUNTRY_LANGUAGES } from '@linedesk/actions'
import { type SearchOption, searchOptions } from '../ui/SearchSelect.tsx'

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** A country's code and the names it is searched by (the UI language's and English). */
export type CountryNames = { code: string; names: readonly string[] }

/** Each country of COUNTRY_LANGUAGES with its names, from a name function per locale (Intl.DisplayNames' `of`). */
export function countryNames(nameOf: readonly ((code: string) => string | undefined)[]): CountryNames[] {
  return Object.keys(COUNTRY_LANGUAGES).map(code => ({
    code,
    names: [...new Set(nameOf.map(of => of(code)).filter((n): n is string => !!n && n !== code))],
  }))
}

/**
 * The languages whose name matches first (searchOptions), then the ones a matching country speaks, the country's
 * name as the option's meta ("Español · Spanish   Mexico"). A country matches when one of its names or a word of one
 * starts with what was typed.
 */
export function searchLanguages(
  options: readonly SearchOption[],
  query: string,
  countries: readonly CountryNames[],
  countryLabel: (code: string) => string,
): SearchOption[] {
  const byName = searchOptions(options, query)
  const q = fold(query.trim())
  if (q.length < 2) return byName
  const found = new Set(byName.map(o => o.value))
  const byCountry: SearchOption[] = []
  for (const { code, names } of countries) {
    const hit = names.some(
      name =>
        fold(name)
          .split(/[\s(),-]+/)
          .some(word => word.startsWith(q)) || fold(name).startsWith(q),
    )
    if (!hit) continue
    const option = options.find(o => o.value === COUNTRY_LANGUAGES[code])
    if (!option || found.has(option.value)) continue
    found.add(option.value)
    byCountry.push({ value: option.value, label: option.label, icon: option.icon, meta: countryLabel(code) })
  }
  return [...byName, ...byCountry]
}
