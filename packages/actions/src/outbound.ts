// Where Linedesk may call out to: warm transfers (transfer contacts, the owner's mobile) and the forwarding check
// (the business's own number). Every outbound call costs the install's operator or the business money, and a hostile
// or mistyped setting is the classic way to run up a phone bill (toll fraud: premium-rate and far-away numbers). So:
// - only countries the call's route may reach. A call from a number in the install's carrier account (and every
//   forwarding check) goes out on the operator's bill: the countries of the workspace's install-account numbers plus the
//   countries the server admin allows for the whole install (Server admin › System, `outboundCountries`). A call from a
//   number in the workspace's own carrier account goes out on its bill: the countries of those numbers only;
// - in every country only landlines and mobiles (and VoIP lines, which many businesses have), never premium rate,
//   shared cost, toll-free, personal, UAN, pager or voicemail numbers, nor emergency, short or service numbers.
// One function (outboundNumberProblem) decides it for the settings, the voice agent's dial (call.transfer `dialing`,
// checked again when it dials) and the forwarding check. docs/decisions.md, "Outbound calls by destination policy".
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { z } from 'zod'
import { defineAction } from './define.ts'
import { countryOfCallingCode, isPhoneCountry, nameInSentence } from './phone-input.ts'

/**
 * The countries a number may be in: a list of ISO 3166-1 alpha-2 codes (empty: none), or `any`, which skips the
 * country rule and checks only the kind of number (a workspace without a Linedesk number yet: the dial is checked again).
 */
export type OutboundCountries = readonly string[] | 'any'

/** Why a number cannot be called. `country`: the number's own country, when it is known. */
export type OutboundReason =
  | 'format'
  | 'emergency'
  | 'short'
  | 'service'
  | 'premium'
  | 'shared_cost'
  | 'toll_free'
  | 'personal'
  | 'non_geographic'
  | 'invalid'
  | 'not_callable'
  | 'country'
  | 'no_country'
export type OutboundProblem = { reason: OutboundReason; message: string; country: string | null }

/** What the call is for, which the messages name: a transfer, or the forwarding check calling the business number. */
export type OutboundUse = 'transfer' | 'check'

/**
 * libphonenumber's number types Linedesk calls. VoIP too: many business lines are VoIP-typed numbers in their country
 * (Korea's 070, the UK's 056) and are priced like landlines; the country rule still applies to them.
 */
const CALLABLE_TYPES = new Set(['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE', 'VOIP'])

/**
 * Emergency and well-known service numbers, as dialled within a country, so "+44 999" or "+1 911" is never called
 * whatever its length: 112 (EU, worldwide on mobiles), 911 (North America), 999 (UK), 000 (Australia), 110/119 (Japan,
 * Korea, Germany), 100-102/108 (India), 113, 15/17/18 (France), and their neighbours.
 */
const EMERGENCY = new Set([
  '000',
  '08',
  '06',
  '061',
  '100',
  '101',
  '102',
  '103',
  '108',
  '110',
  '111',
  '112',
  '113',
  '115',
  '116',
  '117',
  '118',
  '119',
  '122',
  '123',
  '133',
  '140',
  '144',
  '15',
  '17',
  '18',
  '190',
  '192',
  '193',
  '194',
  '197',
  '911',
  '999',
])
/** A national number shorter than this is a short code or a service number, never a person's phone. */
const SHORT_NATIONAL = 6

const NANP = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/
/**
 * NANP area codes that are no place for a call: premium rate, personal and carrier services, and Canada's
 * non-geographic service codes (600, 622, 633), listed here so the rule does not depend on how libphonenumber types
 * them (it calls 600 VoIP).
 */
const BLOCKED_AREA_CODES = new Set([
  '900',
  '976',
  '500',
  '533',
  '544',
  '566',
  '577',
  '588',
  '700',
  '600',
  '622',
  '633',
])
/** Directory assistance behind any NANP area code (NXX-555-1212, 555-4334): billed per call. */
const DIRECTORY_LINES = new Set(['1212', '4334'])

/** The calling code and the national part of digits in E.164 (without "+"); null when no country has the code. */
function splitCallingCode(digits: string): { code: string; national: string } | null {
  for (const length of [1, 2, 3]) {
    const code = digits.slice(0, length)
    if (countryOfCallingCode(code)) return { code, national: digits.slice(length) }
  }
  return null
}

/** "the United States", "Canada and Mexico", "Canada, Mexico and the United States". */
export function countryList(countries: readonly string[]): string {
  const names = countries.map(nameInSentence)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const can = (use: OutboundUse) => (use === 'transfer' ? 'can take transferred calls' : 'can be checked')
const cannot = (use: OutboundUse) => (use === 'transfer' ? 'cannot take transferred calls' : 'cannot be checked')

/**
 * Why Linedesk may not call this number, with a message for the owner that names the country; null when it may.
 * The rules, in order: E.164; never emergency, short or service numbers (in any country, also as "+<code> 112");
 * NANP: never N11, 976 or 555-1212/555-4334 (behind any area code) or premium, personal and
 * non-geographic area codes; the number must be valid and have a
 * country (not +800, satellite or other numbers without one); only landlines, mobiles and VoIP lines; and the country
 * must be in `allowed` (unless `any`). North American regions are countries of their own: Canada, Puerto Rico and
 * the Caribbean are not the US.
 */
export function outboundNumberProblem(
  e164: string,
  allowed: OutboundCountries,
  use: OutboundUse = 'transfer',
): OutboundProblem | null {
  const problem = (reason: OutboundReason, message: string, country: string | null = null): OutboundProblem => ({
    reason,
    message,
    country,
  })
  const value = e164.trim()
  if (!/^\+\d+$/.test(value)) return problem('format', 'Enter the number with its country code, like +1 503 555 0100.')
  const digits = value.slice(1)
  const split = splitCallingCode(digits)
  if (EMERGENCY.has(digits) || (split && EMERGENCY.has(split.national)))
    return problem('emergency', `Emergency numbers ${cannot(use)}.`)
  if (!split) {
    const parsed = parsePhoneNumberFromString(value)
    if (parsed?.isValid() && !parsed.country)
      return problem('non_geographic', `Numbers without a country (like +800 or satellite phones) ${cannot(use)}.`)
    return problem('invalid', "This doesn't look like a phone number.")
  }
  if (split.national.length < SHORT_NATIONAL)
    return problem('short', `Short and service numbers ${cannot(use)}. Enter a mobile or landline with its area code.`)
  if (split.code === '1') {
    const m = NANP.exec(value)
    if (!m) return problem('format', 'Enter the number with its area code, like +1 503 555 0100.')
    const [, area, exchange, line] = m as unknown as [string, string, string, string]
    if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(exchange) || (exchange === '555' && DIRECTORY_LINES.has(line)))
      return problem('service', `Service numbers (like 411) ${cannot(use)}.`)
    // 976 is premium rate behind any area code (212-976-…)
    if (BLOCKED_AREA_CODES.has(area) || exchange === '976')
      return problem('premium', `Premium-rate and personal numbers (900, 976, 500, 700) ${cannot(use)}.`)
  }
  const parsed = parsePhoneNumberFromString(value)
  const country = parsed?.country ?? null
  if (!parsed?.isValid() || !country) {
    const where = country ?? countryOfCallingCode(split.code)
    // A number of a country that may not be called says so first: that is what the owner can change.
    if (where && allowed !== 'any' && allowed.length && !allowed.includes(where)) return countryProblem(where)
    return problem(
      'invalid',
      `This doesn't look like a phone number${where ? ` in ${nameInSentence(where)}` : ''}.`,
      where,
    )
  }
  const type = parsed.getType()
  if (type === 'PREMIUM_RATE') return problem('premium', `Premium-rate numbers ${cannot(use)}.`, country)
  if (type === 'SHARED_COST')
    return problem('shared_cost', `Shared-cost service numbers ${cannot(use)}. Enter a mobile or landline.`, country)
  if (type === 'TOLL_FREE')
    return problem('toll_free', `Toll-free numbers ${cannot(use)}. Enter a mobile or landline.`, country)
  if (type === 'PERSONAL_NUMBER')
    return problem('personal', `Personal (follow-me) numbers ${cannot(use)}. Enter a mobile or landline.`, country)
  if (!type || !CALLABLE_TYPES.has(type))
    return problem('not_callable', `Only mobiles and landlines ${can(use)}. Enter a mobile or landline.`, country)
  if (allowed === 'any' || allowed.includes(country)) return null
  if (!allowed.length)
    return problem(
      'no_country',
      `No number ${can(use)} yet: connect a phone number first, or ask your server admin to allow countries.`,
      country,
    )
  return countryProblem(country)

  function countryProblem(where: string) {
    const list = allowed === 'any' ? '' : countryList(allowed)
    return problem(
      'country',
      `Only numbers in ${list} ${can(use)}. Ask your server admin to allow other countries.`,
      where,
    )
  }
}

/** The message alone (outboundNumberProblem), or null. */
export const onCallNumberProblem = (
  e164: string,
  allowed: OutboundCountries,
  use: OutboundUse = 'transfer',
): string | null => outboundNumberProblem(e164, allowed, use)?.message ?? null

/**
 * A list of countries as the admin or `OUTBOUND_COUNTRIES` gives it ("de, AT  ch"): upper case, known countries only,
 * each once, sorted. Unknown entries are dropped, never widened to anything.
 */
export function parseCountryList(value: string | readonly string[] | null | undefined): string[] {
  const items = typeof value === 'string' ? value.split(/[\s,;]+/) : (value ?? [])
  return [...new Set(items.map(c => c.trim().toUpperCase()).filter(c => isPhoneCountry(c)))].sort()
}

/** The countries of these numbers (a NANP 555 test number counts as US), each once, sorted. */
export function countriesOfNumbers(numbers: readonly string[]): string[] {
  const countries = new Set<string>()
  for (const e164 of numbers) {
    const parsed = parsePhoneNumberFromString(e164)
    const country = parsed?.country ?? (/^\+1\d{10}$/.test(e164) ? 'US' : null)
    if (country) countries.add(country)
  }
  return [...countries].sort()
}

/** Which carrier account a call goes out through: the install's (the operator pays) or the workspace's own. */
export type OutboundRoute = 'install' | 'workspace'

/**
 * The countries a call on this route may reach. `install`: the countries of the workspace's install-account numbers
 * plus the install's list. `workspace`: the countries of its own-account numbers only; the install's list never widens
 * an account the business pays for.
 */
export function routeCountries(
  route: OutboundRoute,
  numbers: { install: readonly string[]; workspace: readonly string[] },
  install: readonly string[],
): string[] {
  if (route === 'workspace') return countriesOfNumbers(numbers.workspace)
  return [...new Set([...countriesOfNumbers(numbers.install), ...parseCountryList(install)])].sort()
}

/**
 * The countries a saved transfer contact may be in: any route the workspace has (a contact is used from every number).
 * `any` while it has no number yet: then only the kind of number is checked when it is saved, and the dial checks the
 * country of its route.
 */
export function allowedOutboundCountries(
  numbers: { install: readonly string[]; workspace: readonly string[] },
  install: readonly string[],
): OutboundCountries {
  if (!numbers.install.length && !numbers.workspace.length) return 'any'
  return [
    ...new Set([
      ...(numbers.install.length ? routeCountries('install', numbers, install) : []),
      ...routeCountries('workspace', numbers, install),
    ]),
  ].sort()
}

/**
 * Countries that are frequent toll-fraud destinations (international revenue share fraud: numbers there are rented
 * out to fraudsters, mobile and landline ranges included). Allowing one for the install needs a second confirmation
 * in Server admin. Not a complete list; the minute limits stay the main guard.
 */
export const HIGH_RISK_COUNTRIES: readonly string[] = [
  'AL',
  'BA',
  'BY',
  'CK',
  'CU',
  'EE',
  'ER',
  'FK',
  'GM',
  'GN',
  'IO',
  'KI',
  'KM',
  'LR',
  'LT',
  'LV',
  'ME',
  'MR',
  'MV',
  'NR',
  'NU',
  'PG',
  'RS',
  'SB',
  'SH',
  'SL',
  'SO',
  'ST',
  'TD',
  'TK',
  'TO',
  'TV',
  'VU',
  'WS',
  'ZW',
]
export const isHighRiskCountry = (country: string) => HIGH_RISK_COUNTRIES.includes(country.toUpperCase())

// ─── Cost limits ─────────────────────────────────────────────────────────────────────────────────────────────

/** Minutes of transferred calls a workspace may have in 24 hours, unless `OUTBOUND_MINUTES_PER_WORKSPACE_DAY` says otherwise. */
export const OUTBOUND_MINUTES_PER_WORKSPACE_DAY = 120
/** The longest one transferred call lasts on the on-call side, unless `TRANSFER_MAX_MINUTES` says otherwise. */
export const TRANSFER_MAX_MINUTES = 30
/** A transfer needs at least this much of the day's minutes left; with less it is not started. */
export const TRANSFER_MIN_MINUTES = 2
/**
 * Minutes of transferred calls on the install's carrier account in 24 hours, all workspaces together, unless
 * `OUTBOUND_MINUTES_INSTALL_DAY` says otherwise: the operator's ceiling. Each limit set to 0 turns transfers off.
 */
export const OUTBOUND_MINUTES_INSTALL_DAY = 2000

// ─── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────

export const outboundCountriesView = defineAction({
  name: 'outbound.countries',
  description:
    "The countries this workspace's transfer contacts may be in: those of its own Linedesk numbers plus the ones the server admin allows (for calls through the install's carrier account; a number in the workspace's own carrier account calls its own numbers' countries only). `countries` is null while the workspace has no number (then any country passes when saved, and the call is checked when it is dialled).",
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})
/** `data` of `outbound.countries`. */
export type OutboundCountriesView = { countries: string[] | null }

export const outboundCountriesGet = defineAction({
  name: 'outboundCountries.get',
  description:
    "Server admin: the countries every workspace of this install may call besides its own numbers' countries (`countries`; `fromEnv`: set by OUTBOUND_COUNTRIES, read-only here), today's outbound use, the countries the install's Twilio account blocks (null: not Twilio or not known), and the Telnyx voice profiles whose spend limits are not confirmed (`spendCapsUnconfirmed`).",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const outboundCountriesSet = defineAction({
  name: 'outboundCountries.set',
  description:
    'Server admin: the countries every workspace may call through the install\'s carrier account besides its own numbers\' countries, as ISO codes ("CA", "MX"); empty: domestic calls only. A frequent toll-fraud destination (HIGH_RISK_COUNTRIES) is refused unless it is also in `confirmHighRisk`. Refused while OUTBOUND_COUNTRIES is set.',
  input: z.object({
    countries: z.array(z.string().trim().length(2)).max(250),
    /** The high-risk countries the admin confirmed a second time (each must be named). */
    confirmHighRisk: z.array(z.string().trim().length(2)).max(250).optional(),
  }),
  permission: 'instance:admin',
})
/** `data` of `outboundCountries.get` and `outboundCountries.set`. */
export type OutboundCountriesData = {
  countries: string[]
  fromEnv: boolean
  /** Over the last 24 hours, across the install; `installTransferMinutes`: through the install's carrier account. */
  usage: { transferMinutes: number; installTransferMinutes: number; transfers: number; forwardingChecks: number }
  /** 0: transfers are off. */
  limits: { minutesPerWorkspaceDay: number; minutesInstallDay: number; transferMaxMinutes: number }
  /** The frequent toll-fraud destinations, which need a second confirmation to be allowed. */
  highRisk: readonly string[]
  /** Countries Linedesk may call that the install's Twilio account's Geo permissions block; null when not Twilio or unknown. */
  twilioBlocked: string[] | null
  /**
   * Linedesk's Telnyx voice profiles whose spend limits (TELNYX_MAX_DESTINATION_RATE, TELNYX_DAILY_SPEND_LIMIT) are not
   * confirmed: the startup sync or a set-up failed for them (the reason is in the server log). Empty when all are.
   */
  spendCapsUnconfirmed: { profile: string; at: string }[]
}
