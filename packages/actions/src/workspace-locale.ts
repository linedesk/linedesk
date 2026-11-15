// Where a workspace is and which language it works in (workspace_settings.country and .language, Workspace settings ›
// General). Both are optional: a workspace that never set them gets them worked out when they are read, from the
// number its assistant answers, the business's own phone, its holiday calendar, else the US and English. So a US
// workspace from before these settings behaves as it always did. The country is the default region for phone numbers
// (the phone field, the voice agent reading a number a caller says), the forwarding guide, the holiday calendar and
// the currency; the language is what the assistant greets in (unless the assistant has its own main language) and
// what call summaries and messages for the team are written in.
import { z } from 'zod'
import { type Language, LANGUAGES, languageCodes } from './languages.ts'
import { countryOfNumber, isPhoneCountry, phoneCountryCodes, phoneCountryName } from './phone-input.ts'
import type { JobValueCurrency } from './insights.ts'

/** Where the resolved country came from: set by the owner, or worked out from one of the workspace's numbers or its holidays. */
export type WorkspaceCountrySource = 'explicit' | 'assistant_number' | 'business_phone' | 'holidays' | 'default'

export type WorkspaceCountryInput = {
  /** workspace_settings.country: what the owner set; null: not set. */
  country?: string | null
  /** The numbers the workspace's assistants answer, oldest first (E.164). */
  assistantNumbers?: string[]
  /** The business's own phone from the assistant's business profile (counts only with its country code). */
  businessPhone?: string | null
  /** The country of the workspace's public holiday calendar. */
  holidayCountry?: string | null
}

const countryCode = (value: string | null | undefined): string | null => {
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
  return { country: 'US', source: 'default' }
}

/**
 * The workspace's country (ISO 3166-1 alpha-2, upper case): the one set, else the country of the first number the
 * assistant answers, else the business phone's (written with its country code), else the holiday calendar's, else 'US'.
 */
export const resolveWorkspaceCountry = (input: WorkspaceCountryInput): string => workspaceCountryOf(input).country

/**
 * The main language of a country (BCP 47 primary tag, as LANGUAGES writes it: Norwegian is `no`). Belgium is
 * Dutch-speaking by majority, Switzerland has French and Italian regions: both get the language most businesses there
 * use with customers across the country (fr, de), and the owner sets another one in Workspace settings › General.
 * Canada is English (French for a business in Quebec, set by the owner), Puerto Rico Spanish (English is its second
 * official language).
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

/** The workspace's language: the one set, else the main language of its country (COUNTRY_LANGUAGES), else 'en'. */
export function resolveWorkspaceLanguage(input: { language?: string | null; country: string }): string {
  const explicit = input.language?.trim().toLowerCase()
  if (explicit) return explicit
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

/** workspace.updateSettings `language`: one of the languages calls can be answered in; null: from the country. */
export const workspaceLanguageSchema = z.enum(languageCodes as [Language, ...Language[]])

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
  default: 'nothing else set',
}

/** "Automatic (Germany, from your assistant's number)". */
export const automaticCountryLabel = (country: string, source: WorkspaceCountrySource): string =>
  `Automatic (${phoneCountryName(country)}, ${SOURCE_WORDS[source] || 'set'})`

/** "Automatic (German, from your country)"; `name` names the language another way ("Deutsch · German"). */
export const automaticLanguageLabel = (language: string, name = workspaceLanguageName(language)): string =>
  `Automatic (${name}, from your country)`

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
