// Phone numbers as people type them, for the web app's phone field (apps/web/src/ui/PhoneInput.tsx): which countries
// there are with their calling codes, the number formatted as it is typed for the picked country, a pasted
// international number (with + or 00) switching the country, the value in E.164, and why a number cannot be one.
// libphonenumber-js with the same metadata as the transfer rules (transfer.ts), so the browser loads it once.
import {
  AsYouType,
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/max'
import examples from 'libphonenumber-js/mobile/examples'

/** Every country (ISO 3166-1 alpha-2) libphonenumber knows, with its calling code. */
const COUNTRIES = new Set<string>(getCountries())

export const isPhoneCountry = (country: string | null | undefined): country is CountryCode =>
  !!country && COUNTRIES.has(country.toUpperCase())

/** The countries a phone field offers, as ISO codes. */
export const phoneCountryCodes = (): string[] => [...COUNTRIES]

/** "DE" → "49". */
export const callingCodeOf = (country: string): string => getCountryCallingCode(country as CountryCode)

/** The country a calling code shared by several stands for, until the number says which one it is. */
const MAIN_COUNTRY: Record<string, string> = {
  '1': 'US',
  '7': 'RU',
  '39': 'IT',
  '44': 'GB',
  '47': 'NO',
  '61': 'AU',
  '212': 'MA',
  '262': 'RE',
  '290': 'SH',
  '358': 'FI',
  '590': 'GP',
  '599': 'CW',
}

const BY_CALLING_CODE = new Map<string, string>()
for (const country of COUNTRIES) {
  const code = callingCodeOf(country)
  if (!BY_CALLING_CODE.has(code)) BY_CALLING_CODE.set(code, MAIN_COUNTRY[code] ?? country)
}

/** The country of a calling code ("49" → "DE", "1" → "US"), or null when no country has it. */
export const countryOfCallingCode = (code: string): string | null => BY_CALLING_CODE.get(code) ?? null

/**
 * The country of a number in E.164, or null. A North American number libphonenumber cannot place (a 555 test
 * number) counts as a US one.
 */
export function countryOfNumber(e164: string | null | undefined): string | null {
  const text = e164?.trim()
  if (!text?.startsWith('+')) return null
  const parsed = parsePhoneNumberFromString(text)
  if (parsed?.country) return parsed.country
  return parsed?.countryCallingCode ? countryOfCallingCode(parsed.countryCallingCode) : null
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
/** Country names said with "the" in a sentence ("for the United States"). */
const WITH_THE = new Set('US GB NL PH AE DO BS GM CF KM MV MH SB VA CD CG'.split(' '))

/** "DE" → "Germany". */
export const phoneCountryName = (country: string): string => regionNames.of(country.toUpperCase()) ?? country

/** The name as it goes into a sentence: "the United States", "Germany". */
export const nameInSentence = (country: string) => `${WITH_THE.has(country) ? 'the ' : ''}${phoneCountryName(country)}`

/** The region of a locale: "de-DE" → "DE", "de" → "DE" (its likely region), "en" → "US"; null when unknown. */
export function localeRegion(locale: string | null | undefined): string | null {
  if (!locale) return null
  try {
    const region = new Intl.Locale(locale).maximize().region
    return isPhoneCountry(region) ? region : null
  } catch {
    return null
  }
}

/**
 * The country a phone field starts with, most telling first: the country of the number the workspace's assistant
 * answers, the workspace's country (its holiday calendar), the business's own phone (when written with its country
 * code), the browser's locale, else the US.
 */
export function defaultPhoneCountry(from: {
  assistantNumber?: string | null
  workspaceCountry?: string | null
  businessNumber?: string | null
  locale?: string | null
}): string {
  const found = [
    countryOfNumber(from.assistantNumber),
    from.workspaceCountry?.toUpperCase(),
    countryOfNumber(from.businessNumber),
    localeRegion(from.locale),
  ].find(isPhoneCountry)
  return found ?? 'US'
}

const trunkPrefixes = new Map<string, string>()
/** The digits a country dials before a number at home ("0" in Germany, "" in the US), from its example number. */
function trunkPrefix(country: string): string {
  let prefix = trunkPrefixes.get(country)
  if (prefix === undefined) {
    const example = isPhoneCountry(country) ? getExampleNumber(country, examples) : undefined
    const national = example ? digitsOf(example.formatNational()) : ''
    prefix =
      example && national.endsWith(example.nationalNumber) ? national.slice(0, -example.nationalNumber.length) : ''
    trunkPrefixes.set(country, prefix)
  }
  return prefix
}

/** What the field shows and what it means: the country picked, the number as shown, the value in E.164. */
export type TypedPhone = {
  country: string
  /** The number without its country code, formatted for the country as far as it is typed ("(503) 555-01"). */
  display: string
  /** E.164 as far as typed ("+150355501"); "" while nothing is typed. */
  e164: string
}

const digitsOf = (text: string) => text.replace(/\D/g, '')

/**
 * What typing (or pasting) `text` into the number field means while `country` is picked. Text with + or 00 in front
 * is an international number: its country code picks the country (the one picked stays when it shares that code,
 * like Canada with +1), and the field shows the number without it.
 */
export function typePhone(text: string, country: string): TypedPhone {
  const trimmed = text.trim()
  if (!digitsOf(trimmed)) return { country, display: trimmed.startsWith('+') ? '+' : '', e164: '' }
  if (/^(\+|00)/.test(trimmed)) {
    const international = `+${digitsOf(trimmed.replace(/^00/, ''))}`
    const typing = new AsYouType()
    typing.input(international)
    const code = typing.getCallingCode()
    if (!code) return { country, display: international, e164: international }
    const found =
      typing.getCountry() ?? (callingCodeOf(country) === code ? country : (countryOfCallingCode(code) ?? country))
    const national = international.slice(code.length + 1)
    const parsed = parsePhoneNumberFromString(international)
    // As the country writes it at home, trunk prefix included ("030 12"), so typing on reads it the same way.
    const display = parsed?.isValid()
      ? parsed.formatNational()
      : new AsYouType(found as CountryCode).input(trunkPrefix(found) + national)
    return { country: found, display, e164: international }
  }
  const typing = new AsYouType(country as CountryCode)
  const display = typing.input(trimmed)
  return { country, display, e164: typing.getNumberValue() ?? '' }
}

/** A stored value (E.164, or a number saved as typed before, like "(503) 555-0142") as the field shows it. */
export const phoneFromValue = (value: string | null | undefined, country: string): TypedPhone =>
  value?.trim() ? typePhone(value, country) : { country, display: '', e164: '' }

/** The number in the picked country's own format as the field's placeholder: "(201) 555-0123", "01512 3456789". */
export function phonePlaceholder(country: string): string {
  if (!isPhoneCountry(country)) return ''
  return getExampleNumber(country, examples)?.formatNational() ?? ''
}

/**
 * Why a value of the phone field is not a phone number, in words for the person typing it; null when it is one or
 * nothing is typed. Says which country it was checked for ("This number doesn't look complete for Germany.").
 */
export function phoneNumberProblem(e164: string | null | undefined): string | null {
  const value = e164?.trim()
  if (!value) return null
  if (!value.startsWith('+')) return 'Enter the number with its country code, like +1 503 555 0100.'
  const country = countryOfNumber(value)
  if (!country) return 'Pick the country of this number.'
  const where = nameInSentence(country)
  const length = validatePhoneNumberLength(value)
  if (length === 'TOO_LONG') return `This number is too long for ${where}.`
  if (length === 'TOO_SHORT' || length === 'NOT_A_NUMBER') return `This number doesn't look complete for ${where}.`
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed) return `This number doesn't look complete for ${where}.`
  // A North American 555 number is fine: demo and test numbers use them.
  if (!parsed.isValid() && !/^\+1\d{10}$/.test(value)) return `This doesn't look like a phone number in ${where}.`
  return null
}

/** The value as E.164 when it is a whole phone number (phoneNumberProblem has nothing to say), else null. */
export const completePhone = (e164: string | null | undefined): string | null =>
  e164?.trim() && !phoneNumberProblem(e164) ? e164.trim() : null

/**
 * The area code of a valid North American number (+1, the US and its neighbours): "+1 503 555 0142" → "503", also
 * typed without its country code ("(503) 555-0142"). Null for anything else, so another country's number is never
 * read as a US one ("+4930123456" has ten digits, but no area code 493).
 */
export function nanpAreaCode(number: string | null | undefined): string | null {
  const text = number?.trim()
  if (!text) return null
  const parsed = parsePhoneNumberFromString(text, text.startsWith('+') ? undefined : 'US')
  if (parsed?.countryCallingCode !== '1' || !parsed.isValid()) return null
  return parsed.nationalNumber.slice(0, 3)
}
