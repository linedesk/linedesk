// Where a workspace is and which language it works in (workspace_settings.country, Workspace settings › General; the
// language is no setting, it follows the country). A workspace made in the app starts with its country set (New
// workspace asks for it, prefilled from the country hint). One made without it (the API, the setup MCP, the command line), or from before, gets it worked out
// when it is read: from the number its assistant answers, the business's own phone, its holiday calendar, the country
// hint saved when it was made, its time zone, else the US; the language from the country. One function for the API and
// the web app (workspaceCountryOf), so both always say the same. The country is the default region for phone numbers
// (the phone field, the voice agent reading a number a caller says), the forwarding guide, the holiday calendar and
// the currency; the language is what the assistant greets in (unless the assistant has its own main language) and
// what call summaries and messages for the team are written in.
import { z } from 'zod'
import { type Language, LANGUAGES, languageCodes } from './languages.ts'
import { countryOfNumber, isPhoneCountry, localeRegion, phoneCountryCodes, phoneCountryName } from './phone-input.ts'
import type { JobValueCurrency } from './insights.ts'
import { TIME_ZONES_BY_COUNTRY } from './time-zone-countries.ts'

/**
 * Where a country hint came from, most telling first: the country of the address the workspace was made from (only
 * the country code a proxy in front of the install adds, CF-IPCountry behind Cloudflare; never the address itself),
 * the time zone's country, the region of the browser's language ("de-AT": AT).
 */
export const countryHintSources = ['sign_up_location', 'time_zone', 'browser_language'] as const
export type CountryHintSource = (typeof countryHintSources)[number]
/** A guess at where a business is, from the moment its workspace was made (workspace_settings.country_hint). */
export type CountryHint = { country: string; source: CountryHintSource }

/**
 * Where the resolved country came from: set by the owner, one of the workspace's numbers, its holidays, the hint saved
 * when it was made (its source), its time zone, else the US.
 */
export type WorkspaceCountrySource =
  | 'explicit'
  | 'assistant_number'
  | 'business_phone'
  | 'holidays'
  | CountryHintSource
  | 'default'

let zoneCountries: Map<string, string> | null = null
/** The country of an IANA time zone ("Europe/Madrid": ES, "US/Eastern": US); null for UTC and unknown names. */
export function countryOfTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null
  zoneCountries ??= new Map(
    Object.entries(TIME_ZONES_BY_COUNTRY).flatMap(([country, zones]) => zones.split(' ').map(z => [z, country])),
  )
  const country = zoneCountries.get(timeZone.trim())
  return country && isPhoneCountry(country) ? country : null
}

/**
 * The main time zone of each country with more than one in the tz database (old link names count): the zone where
 * most of its people and businesses are (US: Eastern, Canada: Toronto, Australia: Sydney, Brazil: São Paulo, Russia:
 * Moscow). A country with one zone has that one. Used when a workspace's country and time zone do not match
 * (workspaceTimeZoneFor, LIN-433).
 */
export const MAIN_TIME_ZONES: Readonly<Record<string, string>> = {
  AQ: 'Antarctica/McMurdo',
  AR: 'America/Argentina/Buenos_Aires',
  AS: 'Pacific/Pago_Pago',
  AU: 'Australia/Sydney',
  BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels',
  BR: 'America/Sao_Paulo',
  BT: 'Asia/Thimphu',
  CA: 'America/Toronto',
  CD: 'Africa/Kinshasa',
  CI: 'Africa/Abidjan',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  CU: 'America/Havana',
  CY: 'Asia/Nicosia',
  DE: 'Europe/Berlin',
  EC: 'America/Guayaquil',
  EG: 'Africa/Cairo',
  ES: 'Europe/Madrid',
  FM: 'Pacific/Pohnpei',
  FO: 'Atlantic/Faroe',
  GB: 'Europe/London',
  GL: 'America/Nuuk',
  GR: 'Europe/Athens',
  HK: 'Asia/Hong_Kong',
  ID: 'Asia/Jakarta',
  IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  IR: 'Asia/Tehran',
  JM: 'America/Jamaica',
  JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi',
  KI: 'Pacific/Tarawa',
  KR: 'Asia/Seoul',
  KZ: 'Asia/Almaty',
  LY: 'Africa/Tripoli',
  MD: 'Europe/Chisinau',
  MH: 'Pacific/Majuro',
  MM: 'Asia/Yangon',
  MN: 'Asia/Ulaanbaatar',
  MO: 'Asia/Macau',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  NP: 'Asia/Kathmandu',
  NZ: 'Pacific/Auckland',
  PA: 'America/Panama',
  PF: 'Pacific/Tahiti',
  PG: 'Pacific/Port_Moresby',
  PL: 'Europe/Warsaw',
  PR: 'America/Puerto_Rico',
  PS: 'Asia/Gaza',
  PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow',
  SB: 'Pacific/Guadalcanal',
  SG: 'Asia/Singapore',
  TM: 'Asia/Ashgabat',
  TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei',
  UA: 'Europe/Kyiv',
  UM: 'Pacific/Wake',
  US: 'America/New_York',
  UZ: 'Asia/Tashkent',
  VN: 'Asia/Ho_Chi_Minh',
}

const zonesOf = (country: string): string[] => TIME_ZONES_BY_COUNTRY[country.trim().toUpperCase()]?.split(' ') ?? []

/** The main time zone of a country (MAIN_TIME_ZONES, else its one zone); null for a code the tz database lacks. */
export function mainTimeZoneOf(country: string | null | undefined): string | null {
  if (!country) return null
  const code = country.trim().toUpperCase()
  const zones = zonesOf(code)
  return MAIN_TIME_ZONES[code] ?? (zones.length === 1 ? zones[0]! : null)
}

/** Whether an IANA time zone is one of a country's ("America/Chicago" in US: yes; "Europe/Berlin" in US: no). */
export const timeZoneInCountry = (timeZone: string | null | undefined, country: string | null | undefined): boolean =>
  !!timeZone && !!country && zonesOf(country).includes(timeZone.trim())

/**
 * The time zone a workspace in `country` gets from `timeZone` (the browser's, or the one it has): kept when it is in
 * that country, else the country's main zone (LIN-433: a US business set up from a browser in
 * Berlin gets US Eastern, not Berlin). Without a country, or one without a known zone, `timeZone` as given.
 */
export function workspaceTimeZoneFor(
  country: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (timeZoneInCountry(timeZone, country)) return timeZone!.trim()
  return mainTimeZoneOf(country) ?? timeZone ?? null
}

/**
 * The country hint for a new workspace: the sign-up location's country code, else the time zone's country, else the
 * region of the browser's language; null when none says. Only a two-letter code and its source are kept.
 */
export function countryHintOf(from: {
  /** The country code a trusted proxy sent with the request (CF-IPCountry); "XX" and "T1" (Tor) count as none. */
  ipCountry?: string | null
  timeZone?: string | null
  /** The browser's language tag ("de-DE"). */
  locale?: string | null
}): CountryHint | null {
  const ip = countryCode(from.ipCountry)
  if (ip) return { country: ip, source: 'sign_up_location' }
  const zone = countryOfTimeZone(from.timeZone)
  if (zone) return { country: zone, source: 'time_zone' }
  const region = localeRegion(from.locale)
  if (region) return { country: region, source: 'browser_language' }
  return null
}

/** workspace.create `countryHint`: what the app prefilled the country with, and where that came from. */
export const countryHintSchema = z.object({
  country: z
    .string()
    .trim()
    .transform(code => code.toUpperCase())
    .refine(code => phoneCountryCodes().includes(code), 'a country code like US or CA'),
  source: z.enum(countryHintSources),
})

export type WorkspaceCountryInput = {
  /** workspace_settings.country: what the owner set; null: not set. */
  country?: string | null
  /** The numbers the workspace's assistants answer, oldest first (E.164). */
  assistantNumbers?: string[]
  /** The business's own phone from the assistant's business profile (counts only with its country code). */
  businessPhone?: string | null
  /** The country of the workspace's public holiday calendar. */
  holidayCountry?: string | null
  /** The hint saved when the workspace was made (workspace_settings.country_hint and its source). */
  hint?: { country: string | null; source: string | null } | null
}

function countryCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase()
  return code && isPhoneCountry(code) ? code : null
}

/** The workspace's country and where it came from (see resolveWorkspaceCountry). */
export function workspaceCountryOf(input: WorkspaceCountryInput): { country: string; source: WorkspaceCountrySource } {
  const explicit = countryCode(input.country)
  if (explicit) return { country: explicit, source: 'explicit' }
  const number = (input.assistantNumbers ?? []).map(countryOfNumber).find(c => c !== null)
  if (number) return { country: number, source: 'assistant_number' }
  const business = countryOfNumber(input.businessPhone)
  if (business) return { country: business, source: 'business_phone' }
  const holidays = countryCode(input.holidayCountry)
  if (holidays) return { country: holidays, source: 'holidays' }
  const hinted = countryCode(input.hint?.country)
  const hintSource = countryHintSources.find(s => s === input.hint?.source)
  if (hinted && hintSource) return { country: hinted, source: hintSource }
  return { country: 'US', source: 'default' }
}

/**
 * Whether something the business did names the country (set, a number, the business phone, holidays), not only a
 * guess (a hint or the US fallback). Buying a number follows only a named country: with a guess, the area code picked
 * names it and the bought number then sets it, so a hint from where the workspace was made never blocks a purchase
 * (LIN-300, security review of #826 F2).
 */
export const countryNamed = (source: WorkspaceCountrySource): boolean =>
  source !== 'default' && !countryHintSources.some(s => s === source)

/**
 * The country a phone field starts with: the workspace's country by the same order (workspaceCountryOf), and where
 * nothing of the workspace says, the region of the browser's language, else the US. Before the workspace settings
 * have loaded the web app passes what it has (its numbers, the business phone, the browser's own hint).
 */
export function defaultPhoneCountry(from: WorkspaceCountryInput & { locale?: string | null }): string {
  const { country, source } = workspaceCountryOf(from)
  return source === 'default' ? (localeRegion(from.locale) ?? country) : country
}

/**
 * The workspace's country (ISO 3166-1 alpha-2, upper case): the one set, else the country of the first number the
 * assistant answers, else the business phone's (written with its country code), else the holiday calendar's, else the
 * hint saved when the workspace was made, else its time zone's country, else 'US'.
 */
export const resolveWorkspaceCountry = (input: WorkspaceCountryInput): string => workspaceCountryOf(input).country

/**
 * The main language of a country (BCP 47 primary tag, as LANGUAGES writes it: Norwegian is `no`). Belgium is
 * Dutch-speaking by majority, Switzerland has French and Italian regions: both get the language most businesses there
 * use with customers across the country (fr, de); an assistant greets in another one when it is its main language
 * (Settings › Assistant › Languages). Canada is English (a business in Quebec sets French as the assistant's main
 * language), Puerto Rico Spanish (English is its second official language).
 */
export const COUNTRY_LANGUAGES: Readonly<Record<string, string>> = {
  US: 'en',
  GB: 'en',
  CA: 'en',
  AU: 'en',
  NZ: 'en',
  IE: 'en',
  IN: 'en',
  SG: 'en',
  ZA: 'en',
  PH: 'en',
  DE: 'de',
  AT: 'de',
  CH: 'de',
  LI: 'de',
  FR: 'fr',
  BE: 'fr',
  LU: 'fr',
  MC: 'fr',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  CL: 'es',
  CO: 'es',
  PE: 'es',
  PR: 'es',
  IT: 'it',
  SM: 'it',
  PT: 'pt',
  BR: 'pt',
  NL: 'nl',
  SE: 'sv',
  NO: 'no',
  DK: 'da',
  FI: 'fi',
  PL: 'pl',
  JP: 'ja',
  KR: 'ko',
  AE: 'ar',
  SA: 'ar',
  IL: 'he',
  RU: 'ru',
}

/**
 * The workspace's language: the main language of its country (COUNTRY_LANGUAGES), else 'en'. Not a setting (the
 * workspace "Call language" was removed): what call summaries and messages for the team are
 * written in, and what an assistant without a main language of its own greets in.
 */
export function resolveWorkspaceLanguage(input: { country: string }): string {
  return COUNTRY_LANGUAGES[input.country.trim().toUpperCase()] ?? 'en'
}

/** Whether calls can be answered in a language (one the voice pipeline speaks, LANGUAGES in languages.ts). */
export const isVoiceLanguage = (language: string | null | undefined): language is Language =>
  !!language && (languageCodes as readonly string[]).includes(language)

/** The language calls are answered in for a workspace language: it, when the voice pipeline speaks it, else English. */
export const voiceLanguageOf = (language: string | null | undefined): Language =>
  isVoiceLanguage(language) ? language : 'en'

const languageNamesEn = new Intl.DisplayNames(['en'], { type: 'language' })
/** "de" → "German", "ko" → "Korean". */
export const workspaceLanguageName = (code: string): string =>
  LANGUAGES[code as Language] ?? languageNamesEn.of(code) ?? code

/** workspace.updateSettings `country`: an ISO 3166-1 alpha-2 code libphonenumber knows ("DE"); null: worked out again. */
export const workspaceCountrySchema = z
  .string()
  .trim()
  .transform(code => code.toUpperCase())
  .refine(code => phoneCountryCodes().includes(code), 'a country code like US or CA')

/** The currency of a country, when Insights offers it (jobValueCurrencies); null otherwise. */
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK MC SM VA AD ME XK'.split(' ')
const COUNTRY_CURRENCIES: Readonly<Record<string, JobValueCurrency>> = {
  ...Object.fromEntries(EURO.map(c => [c, 'EUR' as const])),
  US: 'USD',
  AE: 'AED',
  AR: 'ARS',
  AU: 'AUD',
  BR: 'BRL',
  CA: 'CAD',
  CH: 'CHF',
  LI: 'CHF',
  CL: 'CLP',
  CN: 'CNY',
  CO: 'COP',
  CZ: 'CZK',
  DK: 'DKK',
  EG: 'EGP',
  GB: 'GBP',
  HK: 'HKD',
  HU: 'HUF',
  ID: 'IDR',
  IL: 'ILS',
  IN: 'INR',
  JP: 'JPY',
  KE: 'KES',
  KR: 'KRW',
  MX: 'MXN',
  MY: 'MYR',
  NG: 'NGN',
  NO: 'NOK',
  NZ: 'NZD',
  PE: 'PEN',
  PH: 'PHP',
  PL: 'PLN',
  RO: 'RON',
  SA: 'SAR',
  SE: 'SEK',
  SG: 'SGD',
  TH: 'THB',
  TR: 'TRY',
  TW: 'TWD',
  ZA: 'ZAR',
}

/** "DE" → "EUR", "KR" → "KRW"; null for a country whose currency Insights does not offer. */
export const currencyOfCountry = (country: string | null | undefined): JobValueCurrency | null =>
  (country && COUNTRY_CURRENCIES[country.trim().toUpperCase()]) || null

/** Why the country is what it is, for "Automatic (Germany, from your phone number)". */
const SOURCE_WORDS: Record<WorkspaceCountrySource, string> = {
  explicit: '',
  assistant_number: "from your assistant's number",
  business_phone: 'from your business phone',
  holidays: 'from your holiday calendar',
  sign_up_location: 'from where the workspace was created',
  time_zone: 'from the time zone it was created in',
  browser_language: 'from the browser language it was created in',
  default: 'nothing else set',
}

/** "Automatic (Germany, from your assistant's number)". */
export const automaticCountryLabel = (country: string, source: WorkspaceCountrySource): string =>
  `Automatic (${phoneCountryName(country)}, ${SOURCE_WORDS[source] || 'set'})`

/** EU and EEA countries and Switzerland: 112 everywhere. */
const EMERGENCY_112 =
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH MC SM AD IN'.split(' ')
const EMERGENCY_NUMBERS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(EMERGENCY_112.map(c => [c, '112'])),
  US: '911',
  CA: '911',
  PR: '911',
  VI: '911',
  GU: '911',
  AS: '911',
  MP: '911',
  MX: '911',
  PH: '911',
  GB: '999',
  AU: '000',
  NZ: '111',
  JP: '110 for the police or 119 for fire and an ambulance',
  KR: '112 for the police or 119 for fire and an ambulance',
}

/**
 * What callers in danger are told to dial in a country, as the assistant says it: "911" in the US and Canada, "112" in
 * the EU, EEA and Switzerland, "999" in the UK, "000" in Australia, "110 for the police or 119 for fire and an
 * ambulance" in Japan; for a country not listed, "the local emergency number" (a wrong number is worse than none).
 */
export const emergencyNumberOf = (country: string | null | undefined): string =>
  (country && EMERGENCY_NUMBERS[country.trim().toUpperCase()]) || 'the local emergency number'
