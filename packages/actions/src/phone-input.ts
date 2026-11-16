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
import { english, type Words } from './words.ts'

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

/** Country names said with "the" in a sentence ("for the United States"). */
const WITH_THE = new Set('US GB NL PH AE DO BS GM CF KM MV MH SB VA CD CG'.split(' '))

/** "DE" → "Germany", "Deutschland" in German words. */
export const phoneCountryName = (country: string, words: Words = english): string =>
  words.format.region(country.toUpperCase())

/** The name as it goes into a sentence: "the United States", "Germany"; the "the" is English only. */
export const nameInSentence = (country: string, words: Words = english) =>
  words.t('common.phone.countryInSentence', {
    the: WITH_THE.has(country) ? 'yes' : 'no',
    country: phoneCountryName(country, words),
  })

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
export function phoneNumberProblem(e164: string | null | undefined, words: Words = english): string | null {
  const value = e164?.trim()
  if (!value) return null
  if (!value.startsWith('+')) return words.t('common.phone.problem.countryCode', { example: '+1 503 555 0100' })
  const country = countryOfNumber(value)
  if (!country) return words.t('common.phone.problem.pickCountry')
  const where = nameInSentence(country, words)
  const length = validatePhoneNumberLength(value)
  if (length === 'TOO_LONG') return words.t('common.phone.problem.tooLong', { where })
  if (length === 'TOO_SHORT' || length === 'NOT_A_NUMBER') return words.t('common.phone.problem.incomplete', { where })
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed) return words.t('common.phone.problem.incomplete', { where })
  // A North American 555 number is fine: demo and test numbers use them.
  if (!parsed.isValid() && !/^\+1\d{10}$/.test(value)) return words.t('common.phone.problem.notANumber', { where })
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

/** Why digits are not a phone number of a country: too few, too many, or not one of its numbers. */
export type NationalPhoneProblem = 'too_short' | 'too_long' | 'invalid'

/**
 * Digits a caller said (or typed) as a phone number, read the way people write numbers in `country`: a national
 * number with its trunk prefix ("01512345678" in Germany, "01012345678" in Korea), or with + and a country code from
 * anywhere ("+442079460958"); in a country whose international prefix is 00, "0044…" counts as +44. E.164 when it is a
 * whole number of its country, else why not.
 */
export function phoneFromDigits(
  digits: string,
  country: string,
): { ok: true; e164: string } | { ok: false; problem: NationalPhoneProblem; digits: number } {
  const plain = digits.replace(/[^\d+]/g, '')
  const region = (isPhoneCountry(country) ? country.toUpperCase() : 'US') as CountryCode
  const international = plain.startsWith('+')
    ? plain
    : plain.startsWith('00') && !plain.startsWith('000')
      ? `+${plain.slice(2)}`
      : null
  // "00" may also be how a national number starts (rare): the international reading counts only when it is valid.
  const candidates = international && !plain.startsWith('+') ? [international, plain] : [international ?? plain]
  let first: { problem: NationalPhoneProblem; digits: number } | null = null
  for (const text of candidates) {
    const parsed = text.startsWith('+') ? parsePhoneNumberFromString(text) : parsePhoneNumberFromString(text, region)
    if (parsed?.isValid()) return { ok: true, e164: parsed.number }
    const length = text.startsWith('+') ? validatePhoneNumberLength(text) : validatePhoneNumberLength(text, region)
    const count = text.replace(/\D/g, '').length
    // Some countries have short numbers (Germany's run from 5 digits): fewer than 7 is never a callback number.
    const short = length === 'TOO_SHORT' || length === 'NOT_A_NUMBER' || count < 7
    first ??= { problem: length === 'TOO_LONG' ? 'too_long' : short ? 'too_short' : 'invalid', digits: count }
  }
  return { ok: false, ...first! }
}

/** Splits a long group of digits the way people say it: up to 5 together, longer ones in threes and fours. */
function spokenGroups(group: string): string[] {
  const parts: string[] = []
  let rest = group
  while (rest.length > 5) {
    const size = rest.length % 4 === 0 ? 4 : 3
    parts.push(rest.slice(0, size))
    rest = rest.slice(size)
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * A number in E.164 in the groups people say it in, as written in `country`: a number of that country in its national
 * format ("0151 2345 6789" → ["0151", "2345", "6789"], "010-1234-5678" → ["010", "1234", "5678"]), one from elsewhere
 * with its country code first (["+44", "20", "7946", "0958"]). Long groups are split (spokenGroups).
 */
export function phoneGroups(e164: string, country: string): string[] {
  const parsed = parsePhoneNumberFromString(e164)
  if (!parsed) return [e164]
  const home = parsed.country === country.toUpperCase() || (!parsed.country && isPhoneCountry(country) && callingCodeOf(country) === parsed.countryCallingCode)
  const written = home ? parsed.formatNational() : parsed.formatInternational()
  return written
    .split(/[\s\-().]+/)
    .filter(Boolean)
    .flatMap(group => (group.startsWith('+') ? [group] : spokenGroups(group)))
}
