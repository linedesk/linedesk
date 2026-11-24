// The country list of the phone field (PhoneInput.tsx): each country with its flag and calling code, common ones
// first, the search over name, ISO code and calling code, and where the caret goes when the number is formatted.
import { callingCodeOf, isPhoneCountry, phoneCountryCodes, phoneCountryName } from '@linedesk/actions'
import { intlLocale } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

export type PhoneCountryOption = {
  /** ISO 3166-1 alpha-2, "DE". */
  value: string
  /** "Germany". */
  name: string
  /** "49". */
  callingCode: string
  /** "🇩🇪". */
  flag: string
  /** "All countries" for every country after the common ones. */
  group?: string
}

/** Shown first, in this order, like the common currencies of the currency menu (the viewer's country before them). */
export const COMMON_PHONE_COUNTRIES = ['US', 'CA', 'GB', 'AU'] as const
export const allCountriesGroup = () => i18n().t('common.phoneCountry.allCountries')

/** "DE" → 🇩🇪 (two regional indicator letters). */
export const flagOf = (country: string): string =>
  String.fromCodePoint(...[...country.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))

const optionOf = (value: string, group?: string): PhoneCountryOption => ({
  value,
  name: phoneCountryName(value, i18n()),
  callingCode: callingCodeOf(value),
  flag: flagOf(value),
  ...(group ? { group } : {}),
})

/** The browser's first preferred language ("en-GB"), null without a browser or when it does not say. */
export function browserLocale(
  nav: Pick<Navigator, 'language' | 'languages'> | null = globalThis.navigator ?? null,
): string | null {
  try {
    return nav?.languages?.[0] || nav?.language || null
  } catch {
    return null
  }
}

/** The viewer's country ("de" → "DE"), or null when it is not a country a phone number can have. */
const countryOf = (viewer: string | null | undefined): string | null => {
  const country = viewer?.trim().toUpperCase()
  return isPhoneCountry(country) ? country : null
}

/**
 * The common countries, in order: the viewer's country (the workspace's, else the browser's; useDefaultPhoneCountry)
 * first when it is not one of them, then COMMON_PHONE_COUNTRIES. "DE" → DE, US, CA, GB, AU; "GB" or none → US, CA,
 * GB, AU.
 */
export function commonPhoneCountries(viewer?: string | null): string[] {
  const own = countryOf(viewer)
  const common: string[] = [...COMMON_PHONE_COUNTRIES]
  return own && !common.includes(own) ? [own, ...common] : common
}

/** The country search's placeholder with the viewer's calling code: "GB" → "Search a country or +44"; else +1. */
export function phoneCountrySearchPlaceholder(viewer?: string | null): string {
  const own = countryOf(viewer)
  let code = '1'
  try {
    if (own) code = callingCodeOf(own) || code
  } catch {
    // Unknown to the phone library: the US example stays.
  }
  return i18n().t('common.phoneCountry.searchPlaceholder', { code: `+${code}` })
}

const cached = new Map<string, PhoneCountryOption[]>()

/** The common countries (commonPhoneCountries), then every other one A–Z by name under "All countries". */
export function phoneCountryOptions(viewer?: string | null): PhoneCountryOption[] {
  const firsts = commonPhoneCountries(viewer)
  const group = allCountriesGroup()
  const locale = intlLocale()
  const key = `${locale}|${firsts.join(',')}|${group}`
  const known = cached.get(key)
  if (known) return known
  const common = new Set(firsts)
  const others = phoneCountryCodes()
    .filter(c => !common.has(c))
    .map(c => optionOf(c, group))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
  const options = [...firsts.map(c => optionOf(c)), ...others]
  cached.set(key, options)
  return options
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * The countries that match what was typed, best first, without the group headings: by calling code when the query is
 * digits ("+49", "49", "1"; the exact code first), else by ISO code ("DE") and by name ("ger", "united k").
 * An empty query: every option as listed.
 */
export function searchPhoneCountries(options: readonly PhoneCountryOption[], query: string): PhoneCountryOption[] {
  const q = fold(query.trim())
  if (!q) return [...options]
  const digits = q.replace(/^\+/, '').replace(/\s/g, '')
  const flat = options.map(({ group: _group, ...o }) => o)
  if (/^\d+$/.test(digits)) {
    const rank = (o: PhoneCountryOption) => (o.callingCode === digits ? 0 : o.callingCode.startsWith(digits) ? 1 : -1)
    return flat
      .filter(o => rank(o) >= 0)
      .sort((a, b) => rank(a) - rank(b) || a.callingCode.length - b.callingCode.length)
  }
  const rank = (o: PhoneCountryOption) => {
    const name = fold(o.name)
    if (o.value.toLowerCase() === q) return 0
    if (name.startsWith(q)) return 1
    if (name.split(/[\s,-]+/).some(word => word.startsWith(q))) return 2
    if (name.includes(q)) return 3
    return -1
  }
  return flat.filter(o => rank(o) >= 0).sort((a, b) => rank(a) - rank(b))
}

/** How many digits are left of `caret` in `text`. */
export const digitsBefore = (text: string, caret: number): number => text.slice(0, caret).replace(/\D/g, '').length

/** The caret position right after the `count`-th digit of `text` (0: before the first digit). */
export function caretAfterDigits(text: string, count: number): number {
  if (count <= 0) {
    const first = text.search(/\d/)
    return first < 0 ? text.length : first
  }
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]!)) seen++
    if (seen === count) return i + 1
  }
  return text.length
}

/**
 * The text an edit really meant. Deleting only a space, bracket or dash of the formatted number would come back
 * at once when it is formatted again, so Backspace or Delete on one removes the digit next to it instead.
 */
export function meantEdit(
  before: string,
  after: string,
  caret: number,
  key: 'backward' | 'forward' | null,
): { text: string; caret: number } {
  const same = before.replace(/\D/g, '') === after.replace(/\D/g, '')
  if (!key || !same || after.length >= before.length) return { text: after, caret }
  if (key === 'backward') {
    for (let i = caret - 1; i >= 0; i--) {
      if (/\d/.test(after[i]!)) return { text: after.slice(0, i) + after.slice(i + 1), caret: i }
    }
  } else {
    for (let i = caret; i < after.length; i++) {
      if (/\d/.test(after[i]!)) return { text: after.slice(0, i) + after.slice(i + 1), caret }
    }
  }
  return { text: after, caret }
}
