// Parts adapted from LiveKit Agents (Apache-2.0, Copyright LiveKit, Inc.); changed. See NOTICE.
// What each collection step asks for, how it checks what the caller said and how it reads it back.
// Ported from LiveKit's Python ready-made tasks (beta/workflows: GetPhoneNumberTask, GetNameTask,
// GetEmailTask, GetAddressTask): the same prompts and checks, but the
// normalizing of spoken input is done in code (spoken.ts), so it is the same on every model.
import { callingCodeOf, isPhoneCountry, phoneCountryName, phoneFromDigits, phoneGroups, phonePlaceholder } from '@linedesk/actions'
import { z } from 'zod'
import { capitalizeName, readDigits, readLetters, spokenDigits, spokenEmail, spokenLetters } from './spoken.ts'

/** Not ok: `problem` says what to do; `ask` marks a question back to the caller (which of two days), not a wrong value. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string; ask?: boolean }

export interface Collector<Args extends Record<string, unknown>, T> {
  /** Used in tool names: record_<kind>, confirm_<kind>. */
  kind: string
  /** What is collected, in words: "callback number". */
  label: string
  /** The record tool's arguments. */
  parameters: z.ZodType<Args>
  parse(args: Args): Parsed<T>
  /** The value as the assistant and the team get it ("+15035550142"). */
  display(value: T): string
  /** How the assistant reads it back to the caller. */
  readBack(value: T): string
  /**
   * How to read it back when the step may speak another language than English (collectLanguageRule): `readBack` has
   * English words in it ("last name spelled"), which the model then said as they were. Missing: `readBack` exactly.
   */
  readBackInLanguage?(value: T): string
  /** Task-specific rules for the collecting model. */
  instructions: string
  /** The first question. */
  ask: string
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const problem = (text: string): Parsed<never> => ({ ok: false, problem: text })

// ---------- phone number (E.164, in the workspace's country by default) ----------

/** Countries of the North American plan (+1: the US, Canada, …): their numbers are read as before, 10 digits. */
const isNorthAmerican = (country: string) => isPhoneCountry(country) && callingCodeOf(country) === '1'

/** A US number in E.164 from what was said: 10 digits, 11 with a leading 1, or + and a country code. */
function northAmericanE164(digits: string): Parsed<string> {
  const plain = digits.replace('+', '')
  if (digits.startsWith('+') && !plain.startsWith('1')) {
    return plain.length >= 8 && plain.length <= 15 ? ok(`+${plain}`) : problem('That number is too short or too long. Ask again, area code first.')
  }
  const national = plain.length === 11 && plain.startsWith('1') ? plain.slice(1) : plain
  if (national.length < 10) return problem(`Only ${national.length} digits heard. Ask for the full number with the area code.`)
  if (national.length > 10) return problem('Too many digits heard. Ask for the number again, area code first.')
  if (!/^[2-9]\d{2}[2-9]/.test(national)) return problem('That is not a valid US number (area code or exchange). Ask again.')
  return ok(`+1${national}`)
}

/**
 * A phone number in E.164 from what was said, read as numbers are written in `country` (the workspace's): in the US
 * (and the rest of +1) 10 digits, 11 with a leading 1; elsewhere a national number with its leading 0 ("0151 2345
 * 6789" in Germany, "010-1234-5678" in Korea), checked with libphonenumber. A number with + and a country code is
 * taken from any country.
 */
export function toE164(said: string, country = 'US'): Parsed<string> {
  const digits = spokenDigits(said)
  if (isNorthAmerican(country) || !isPhoneCountry(country)) return northAmericanE164(digits)
  if (!digits.replace('+', '')) return problem('No digits heard. Ask for the number again.')
  const found = phoneFromDigits(digits, country)
  if (found.ok) return ok(found.e164)
  if (found.problem === 'too_short') return problem(`Only ${found.digits} digits heard. Ask for the full number with the area code.`)
  if (found.problem === 'too_long') return problem('Too many digits heard. Ask for the number again, area code first.')
  return problem(`That is not a valid number in ${phoneCountryName(country)}. Ask again; a number from another country needs its country code.`)
}

/** Whether what was said or typed is a whole phone number (see toE164). */
export const isWholePhoneNumber = (said: string, country = 'US') => toE164(said, country).ok

/** A phone number in a text that is not whole ("call back on 503-551-42"), or null. Short numbers (a ZIP, a time) do not count. */
export function partialPhoneNumberIn(text: string, country = 'US'): string | null {
  for (const [found] of text.matchAll(/\+?\d[\d\s().-]{4,}\d/g)) {
    const digits = found.replace(/\D/g, '').length
    if (digits >= 7 && !isWholePhoneNumber(found, country)) return found.trim()
  }
  return null
}

/**
 * How the number is read back: in the US as before ("5 0 3, 5 5 5, 0 1 4 2", "plus 4 4 …"); elsewhere in the groups the
 * country writes it in ("0 1 5 1, 2 3 4 5, 6 7 8 9"), a number from another country with its country code first
 * ("+ 4 4, 2 0, 7 9 4 6, 0 9 5 8"), so it can be said in any language.
 */
export function readBackPhone(e164: string, country = 'US'): string {
  if (isNorthAmerican(country) || !isPhoneCountry(country)) {
    return e164.startsWith('+1') ? readDigits(e164.slice(2), [3, 3]) : `plus ${readDigits(e164.slice(1))}`
  }
  return phoneGroups(e164, country)
    .map(group => (group.startsWith('+') ? `+ ${readDigits(group)}` : readDigits(group)))
    .join(', ')
}

const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/**
 * A read-back in English words, digit by digit, the groups kept ("5 0 3, 5 5 5" → "five zero three, five five five"):
 * the step says it exactly, so no model or voice reads "503" as "five hundred three" (LIN-386).
 */
export const digitsInWords = (readBack: string) =>
  readBack.replace(/\+\s*/g, 'plus ').replace(/\d/g, d => DIGIT_NAMES[Number(d)]!)

/** What every phone step adds: a correction of one part keeps the rest (LIN-386). */
const PHONE_CORRECTION =
  'If the caller corrects only part of the number ("no, it ends in 0 1 2 4"), record the whole number with that part changed.'

const US_PHONE_INSTRUCTIONS = (what: string) =>
  `You collect the caller's ${what}. Callers say numbers as words ("five oh three"), in groups, or "area code …". Pass what they said; the tool checks it. If it is unclear after a try, ask for the area code first, then the rest. Never read it back as one block: read it in groups. ${PHONE_CORRECTION}`

export function phoneCollector(what = 'callback number', country = 'US'): Collector<{ phone_number: string }, string> {
  const home = !isNorthAmerican(country) && isPhoneCountry(country)
  const example = home ? phonePlaceholder(country) : ''
  return {
    kind: 'phone_number',
    label: what,
    parameters: z.object({ phone_number: z.string().describe('The number as the caller said or typed it, digits or words.') }),
    parse: ({ phone_number }) => toE164(phone_number, country),
    display: e164 => e164,
    readBack: e164 => digitsInWords(readBackPhone(e164, country)),
    readBackInLanguage: e164 =>
      `Read the number back to the caller in the language you are speaking, digit by digit in these groups: "${readBackPhone(e164, country)}", and ask if it is right.`,
    instructions: home
      ? `You collect the caller's ${what}. The owner is in ${phoneCountryName(country)}: callers give numbers the way they are written there${example ? `, like ${example}` : ''}, with the leading 0, or a number from another country with + or 00 and its country code. Callers say digits as words in their language, in groups, or with "double". Pass the digits as numerals (0-9), with a leading + when they gave a country code; the tool checks it. If it is unclear after a try, ask for the area code first, then the rest. Never read it back as one block: read it in groups. ${PHONE_CORRECTION}`
      : US_PHONE_INSTRUCTIONS(what),
    ask: `Ask for the ${what}.`,
  }
}

// ---------- name, last name spelled ----------

/** `checkSpelling`: the spelling differs from the last name as heard, so the read-back spells it (LIN-386). */
export type FullName = { first: string; last: string; checkSpelling?: true }
const hasLetters = (s: string) => /\p{L}/u.test(s)
const clean = (s: string | null | undefined) => {
  const v = s?.trim().replace(/^["']|["']$/g, '')
  return v && !/^(null|none|n\/a|unknown)$/i.test(v) ? v : ''
}

/** Whether two spellings have the same letters, case, spaces, dashes and apostrophes aside ("O'Brien", "obrien"). */
const sameLetters = (a: string, b: string) => {
  const letters = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}]/gu, '')
  return letters(a) !== '' && letters(a) === letters(b)
}

export const nameCollector: Collector<{ first_name: string; last_name: string; last_name_spelled?: string | null }, FullName> = {
  kind: 'name',
  label: 'name',
  parameters: z.object({
    first_name: z.string().describe('First name as the caller said it.'),
    last_name: z.string().describe('Last name as the caller said it.'),
    last_name_spelled: z
      .string()
      .nullish()
      .describe('The last name exactly as the caller spelled it, letter by letter or with words like "R as in Romeo"; omit until they spelled it.'),
  }),
  parse(args) {
    const first = clean(args.first_name)
    const said = clean(args.last_name)
    const spelled = args.last_name_spelled ? spokenLetters(args.last_name_spelled) : null
    if (!first) return problem('The first name is missing. Ask for it.')
    if (!said && !spelled) return problem('The last name is missing. Ask for it.')
    if (!hasLetters(first) || (!spelled && !hasLetters(said))) return problem('That does not sound like a name. Ask again.')
    if (!spelled) return problem(`Got "${capitalizeName(first)} ${capitalizeName(said)}". Now ask the caller to spell the last name, letter by letter.`)
    const name = { first: capitalizeName(first), last: capitalizeName(spelled) }
    return ok(sameLetters(said, spelled) ? name : { ...name, checkSpelling: true })
  },
  display: n => `${n.first} ${n.last}`,
  // The caller just spelled it: the letters are read back only when they differ from the name as heard (LIN-386).
  readBack: n =>
    n.checkSpelling ? `${n.first} ${n.last}, last name spelled ${readLetters(n.last)}` : `${n.first} ${n.last}`,
  readBackInLanguage: n =>
    n.checkSpelling
      ? `Read it back to the caller in the language you are speaking, in that language's words: the name "${n.first} ${n.last}", then the last name letter by letter, "${readLetters(n.last)}", and ask if it is right.`
      : `Read the name "${n.first} ${n.last}" back to the caller in the language you are speaking, and ask if it is right.`,
  instructions:
    'You collect the caller\'s first and last name. Then ask them to spell the last name. Callers spell letter by letter ("R U I Z"), with the phonetic alphabet ("Romeo Uniform India Zulu") or "R as in Robert"; pass the spelling as they said it in last_name_spelled. Names may have dashes or apostrophes (Mary-Jane, O\'Brien). Only a name the caller said about themselves counts: the assistant\'s own name from the greeting, the owner\'s or a staff member\'s name is never the caller\'s; if you only have their last name, ask for the first name.',
  ask: 'Ask for their first and last name (if they already said it, ask them to spell the last name).',
}

// ---------- name, not spelled (Japanese, Chinese, Korean, Hindi) ----------

/**
 * Languages whose names are not spelled letter by letter on the phone: Japanese, Chinese and Korean names are written in
 * characters or syllable blocks, Hindi ones in Devanagari, where callers don't spell. The step takes the name as heard
 * and reads it back. Other non-Latin alphabets (Russian, Ukrainian, Greek, Arabic) are spelled in their own letters.
 */
const NAME_NOT_SPELLED = new Set(['ja', 'zh', 'ko', 'hi'])
/** Languages that say the family name first. */
const FAMILY_NAME_FIRST = new Set(['ja', 'zh', 'ko'])
/** Japanese: the name is taken in katakana, so a wrong kanji (佐藤 heard as 砂糖) is never read back or saved. */
const IN_KATAKANA = new Set(['ja'])

export function unspelledNameCollector(language: string): Collector<{ first_name: string; last_name: string }, FullName> {
  const familyFirst = FAMILY_NAME_FIRST.has(language)
  const full = (n: FullName) => (familyFirst ? `${n.last} ${n.first}` : `${n.first} ${n.last}`)
  const katakana = IN_KATAKANA.has(language)
  const written = katakana ? ', written in katakana (never guess the kanji)' : ''
  const inRecord = katakana ? ' In the record tool write it in katakana, never guessing the kanji; the caller just says their name, so never ask them for katakana.' : ''
  return {
    kind: 'name',
    label: 'name',
    parameters: z.object({
      first_name: z.string().describe(`Given name as the caller said it${written}.`),
      last_name: z.string().describe(`Family name as the caller said it${written}.`),
    }),
    parse(args) {
      const first = clean(args.first_name)
      const last = clean(args.last_name)
      if (!first) return problem('The given name is missing. Ask for it.')
      if (!last) return problem('The family name is missing. Ask for it.')
      if (!hasLetters(first) || !hasLetters(last)) return problem('That does not sound like a name. Ask again.')
      return ok({ first: capitalizeName(first), last: capitalizeName(last) })
    },
    display: full,
    readBack: full,
    instructions: `You collect the caller's family name and given name. Names in this language are not spelled letter by letter: never ask the caller to spell their name. Pass the name as you heard it; the tool reads it back.${inRecord} If you are not sure you heard it right, ask the caller to say it again slowly. Only a name the caller said about themselves counts: the assistant's own name from the greeting, the owner's or a staff member's name is never the caller's; if you only have their family name, ask for the given name.`,
    ask: 'Ask for their full name.',
  }
}

/** The name step for the language spoken: spelled (nameCollector), or as heard where names are not spelled. */
export const nameCollectorFor = (language: string | null | undefined): Collector<Record<string, unknown>, FullName> =>
  (language && NAME_NOT_SPELLED.has(language) ? unspelledNameCollector(language) : nameCollector) as Collector<Record<string, unknown>, FullName>

// ---------- email ----------

const EMAIL = /^[a-z0-9][a-z0-9._%+-]*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

export const emailCollector: Collector<{ email: string }, string> = {
  kind: 'email',
  label: 'email address',
  parameters: z.object({ email: z.string().describe('The email address as the caller said or spelled it ("dana dot ruiz at gmail dot com" is fine).') }),
  parse({ email }) {
    const address = spokenEmail(email)
    if (!address.includes('@')) return problem(`Heard "${address}" but no "at" and domain. Ask for the part after the at sign.`)
    if (!EMAIL.test(address)) return problem(`"${address}" is not a valid email address. Ask the caller to spell it.`)
    return ok(address)
  },
  display: e => e,
  readBack: e => {
    const [user, domain] = e.split('@') as [string, string]
    return `${readLetters(user)}, at, ${domain.replace(/\./g, ' dot ')}`
  },
  instructions:
    'You collect the caller\'s email address. Callers say it aloud: "dot", "at", "underscore", "dash", and spell parts letter by letter. Pass what they said; the tool turns it into an address. If it is unclear, ask for the part before the "at" sign first (spelled), then the domain.',
  ask: 'Ask for their email address.',
}

// ---------- address (US) ----------

export type UsAddress = { street: string; unit: string; city: string; state: string; zip: string }

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}
const STATE_CODES = new Set(Object.values(STATES))
const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([name, code]) => [code, capitalizeName(name)]))

/** "Oregon", "OR", "or" → "OR"; null for anything else. */
export function stateCode(said: string): string | null {
  const s = said.trim().toLowerCase().replace(/\./g, '')
  if (STATES[s]) return STATES[s]!
  const code = s.replace(/\s+/g, '').toUpperCase()
  return code.length === 2 && STATE_CODES.has(code) ? code : null
}

export const addressCollector: Collector<
  { street: string; unit?: string | null; city: string; state: string; zip?: string | null },
  UsAddress
> = {
  kind: 'address',
  label: 'address',
  parameters: z.object({
    street: z.string().describe('House number and street, numbers as digits: "1450 Southeast Division Street".'),
    unit: z.string().nullish().describe('Apartment, suite or unit, if any.'),
    city: z.string().describe('City.'),
    state: z.string().describe('State, name or two-letter code.'),
    zip: z.string().nullish().describe('ZIP code as the caller said it.'),
  }),
  parse(args) {
    const street = args.street.trim().replace(/\s+/g, ' ')
    if (!/^\d+[a-z]?\s+\S/i.test(street)) return problem('The street needs a house number and a street name. Ask for it.')
    const city = capitalizeName(args.city.trim())
    if (!hasLetters(city)) return problem('The city is missing. Ask for it.')
    const state = stateCode(args.state)
    if (!state) return problem(`"${args.state}" is not a US state. Ask which state.`)
    const zip = args.zip ? spokenDigits(args.zip).replace('+', '') : ''
    if (zip && !/^\d{5}(\d{4})?$/.test(zip)) return problem(`The ZIP code "${zip}" should have 5 digits. Ask for it again.`)
    return ok({ street, unit: args.unit?.trim() ?? '', city, state, zip: zip.slice(0, 5) })
  },
  display: a => `${a.street}${a.unit ? `, ${a.unit}` : ''}, ${a.city}, ${a.state}${a.zip ? ` ${a.zip}` : ''}`,
  readBack: a =>
    `${a.street}${a.unit ? `, ${a.unit}` : ''}, ${a.city}, ${STATE_NAMES[a.state] ?? a.state}${a.zip ? `, ZIP ${readDigits(a.zip)}` : ''}`,
  instructions:
    'You collect a street address (US format: number and street, unit if any, city, state, ZIP). Pass numbers as digits. If something is unclear, ask for the parts in order: street, unit, city and state, ZIP. Read ordinal street names in words ("Twenty-Third Avenue"). If a street name sounds unusual, ask the caller to spell it. Only an address the caller said counts: never fill in an example or placeholder (like 123 Main Street); if you have none, ask for it.',
  ask: 'Ask for the address, including the ZIP code.',
}

// ---------- date ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "2026-11-14", "11/14/2026", "November 14th 2026", "Nov 14" (year from today) → "2026-11-14"; null when not a real date. */
export function parseDate(said: string, today: string): string | null {
  const s = said.trim().toLowerCase().replace(/,/g, ' ')
  const thisYear = Number(today.slice(0, 4))
  let y: number | undefined
  let m: number | undefined
  let d: number | undefined
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  const words = s.match(/^(?:the\s+)?(?:([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+))(?:\s+(\d{2,4}))?$/)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (us) [m, d, y] = [Number(us[1]), Number(us[2]), us[3] ? Number(us[3]) : thisYear]
  else if (words) {
    const month = (words[1] ?? words[4])!
    const index = MONTHS.findIndex(name => name.startsWith(month.slice(0, 3)) && month.length >= 3)
    if (index < 0) return null
    m = index + 1
    d = Number(words[2] ?? words[3])
    y = words[5] ? Number(words[5]) : thisYear
  } else return null
  if (y! < 100) y = y! + (y! > (thisYear % 100) + 1 ? 1900 : 2000)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  if (date.getUTCMonth() !== m! - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Today, for a step's facts: "Today's date, only for when the caller asks: Thursday, November 12, 2026." Worded as a
 * fact to answer from, not a line to say: "Today is …" made the assistant tell callers the date unasked. No list of the
 * days after it: a step takes days in the caller's words and code works out the date (resolveDay), like the booking tools.
 */
export function todayFact(today: string): string {
  return `Today's date, only for when the caller asks: ${new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`
}
