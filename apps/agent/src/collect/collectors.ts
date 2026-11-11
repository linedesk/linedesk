// What each collection step asks for, how it checks what the caller said and how it reads it back.
// Ported from LiveKit's Python ready-made tasks (beta/workflows: GetDtmfTask, GetPhoneNumberTask,
// GetNameTask, GetEmailTask, GetAddressTask, GetDOBTask): the same prompts and checks, but the
// normalizing of spoken input is done in code (spoken.ts), so it is the same on every model.
import { z } from 'zod'
import { capitalizeName, readDigits, readLetters, spokenDigits, spokenEmail, spokenLetters } from './spoken.ts'

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string }

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
  /** Task-specific rules for the collecting model. */
  instructions: string
  /** The first question. */
  ask: string
  /** The caller may type it on the keypad (digits only). */
  keypad?: { minDigits: number; maxDigits: number; toArgs(digits: string): Args }
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const problem = (text: string): Parsed<never> => ({ ok: false, problem: text })

// ---------- digits (account, ZIP, policy number) ----------

export type DigitsOptions = { what: string; minDigits: number; maxDigits: number; keypad: boolean }

export function digitsCollector({ what, minDigits, maxDigits, keypad }: DigitsOptions): Collector<{ digits: string }, string> {
  const length = minDigits === maxDigits ? `${minDigits} digits` : `${minDigits} to ${maxDigits} digits`
  return {
    kind: 'digits',
    label: what,
    parameters: z.object({ digits: z.string().describe(`The ${what} as the caller said or typed it (${length}).`) }),
    parse({ digits }) {
      const plain = spokenDigits(digits).replace('+', '')
      if (!plain) return problem(`No digits heard. Ask for the ${what} again.`)
      if (plain.length < minDigits || plain.length > maxDigits) return problem(`That is ${plain.length} digits; the ${what} has ${length}. Ask again.`)
      return ok(plain)
    },
    display: d => d,
    readBack: d => readDigits(d, d.length > 4 ? [3, 3] : []),
    instructions: `You collect the ${what} (${length}). Callers say digits as words ("five oh three"), in groups, or with "double". Pass what they said as it is; the tool turns it into digits.`,
    ask: keypad
      ? `Ask for the ${what}: they can type it on the phone keypad and then press the pound key, or say it.`
      : `Ask for the ${what}.`,
    ...(keypad ? { keypad: { minDigits, maxDigits, toArgs: (digits: string) => ({ digits }) } } : {}),
  }
}

// ---------- phone number (E.164, US by default) ----------

/** A US number in E.164 from what was said: 10 digits, 11 with a leading 1, or + and a country code. */
export function toE164(said: string): Parsed<string> {
  const digits = spokenDigits(said)
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

/** Whether what was said or typed is a whole phone number (see toE164). */
export const isWholePhoneNumber = (said: string) => toE164(said).ok

/** A phone number in a text that is not whole ("call back on 503-551-42"), or null. Short numbers (a ZIP, a time) do not count. */
export function partialPhoneNumberIn(text: string): string | null {
  for (const [found] of text.matchAll(/\+?\d[\d\s().-]{4,}\d/g)) {
    const digits = found.replace(/\D/g, '').length
    if (digits >= 7 && !isWholePhoneNumber(found)) return found.trim()
  }
  return null
}

export function phoneCollector(what = 'callback number', keypad = true): Collector<{ phone_number: string }, string> {
  return {
    kind: 'phone_number',
    label: what,
    parameters: z.object({ phone_number: z.string().describe('The number as the caller said or typed it, digits or words.') }),
    parse: ({ phone_number }) => toE164(phone_number),
    display: e164 => e164,
    readBack: e164 => (e164.startsWith('+1') ? readDigits(e164.slice(2), [3, 3]) : `plus ${readDigits(e164.slice(1))}`),
    instructions: `You collect the caller's ${what}. Callers say numbers as words ("five oh three"), in groups, or "area code …". Pass what they said; the tool checks it. If it is unclear after a try, ask for the area code first, then the rest. Never read it back as one block: read it in groups.`,
    ask: keypad
      ? `Ask for the ${what}: they can say it, or type it on the keypad and press pound.`
      : `Ask for the ${what}.`,
    ...(keypad ? { keypad: { minDigits: 10, maxDigits: 11, toArgs: (digits: string) => ({ phone_number: digits }) } } : {}),
  }
}

// ---------- name, last name spelled ----------

export type FullName = { first: string; last: string }
const hasLetters = (s: string) => /\p{L}/u.test(s)
const clean = (s: string | null | undefined) => {
  const v = s?.trim().replace(/^["']|["']$/g, '')
  return v && !/^(null|none|n\/a|unknown)$/i.test(v) ? v : ''
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
    return ok({ first: capitalizeName(first), last: capitalizeName(spelled) })
  },
  display: n => `${n.first} ${n.last}`,
  readBack: n => `${n.first} ${n.last}, last name spelled ${readLetters(n.last)}`,
  instructions:
    'You collect the caller\'s first and last name. Then ask them to spell the last name. Callers spell letter by letter ("R U I Z"), with the phonetic alphabet ("Romeo Uniform India Zulu") or "R as in Robert"; pass the spelling as they said it in last_name_spelled. Names may have dashes or apostrophes (Mary-Jane, O\'Brien). If the caller gave their name earlier in the call, use it and only ask for the spelling. Only a name the caller said about themselves counts: the assistant\'s own name from the greeting, the business\'s or a staff member\'s name is never the caller\'s; if you only have their last name, ask for the first name.',
  ask: 'Ask for their first and last name (if they already said it, ask them to spell the last name).',
}

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
    'You collect the street address of the visit (US format: number and street, unit if any, city, state, ZIP). Pass numbers as digits. If something is unclear, ask for the parts in order: street, unit, city and state, ZIP. Read ordinal street names in words ("Twenty-Third Avenue"). If a street name sounds unusual, ask the caller to spell it. Only an address the caller said counts: never fill in an example or placeholder (like 123 Main Street); if you have none, ask for it.',
  ask: 'Ask for the address of the visit, including the ZIP code.',
}

// ---------- date ----------

export type DateOptions = { what: string; today: string; notBefore?: string; notAfter?: string }

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

export function dateCollector({ what, today, notBefore, notAfter }: DateOptions): Collector<{ date: string }, string> {
  return {
    kind: 'date',
    label: what,
    parameters: z.object({ date: z.string().describe(`The ${what} as YYYY-MM-DD (today is ${today}); work it out from what the caller said.`) }),
    parse({ date }) {
      const iso = parseDate(date, today)
      if (!iso) return problem(`"${date}" is not a date. Ask for the month, then the day, then the year.`)
      if (notBefore && iso < notBefore) return problem(`${iso} is too early for the ${what}. Ask again.`)
      if (notAfter && iso > notAfter) return problem(`${iso} is too late for the ${what}. Ask again.`)
      return ok(iso)
    },
    display: iso => iso,
    readBack: iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    instructions: `You collect the ${what}. Today is ${today}. Callers say dates many ways ("next Tuesday", "the fifteenth", "1/15/90"); work out the date and pass it as YYYY-MM-DD. Read it back with the weekday, month, day and year in words.`,
    ask: `Ask for the ${what}.`,
  }
}
