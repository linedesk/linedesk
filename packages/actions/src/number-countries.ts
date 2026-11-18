// Countries where a new number needs documents first (KYC; docs/numbers-kyc.md): per country the number types, what
// the business has to give (fields of its regulatory profile and documents) and the cities a number can be asked for,
// with the national prefix (the area code without the trunk 0); Germany takes any of its Ortsnetze (the BNetzA's list,
// apps/api/src/number-areas.ts), the cities are only its popular ones. Data only: which of them are open on a server is the
// server's flag (NUMBER_KYC_COUNTRIES, apps/api/src/number-requests.ts), empty by default, so nothing changes for
// anyone until a country is switched on. These countries are not in NUMBER_BUY_COUNTRIES (area-codes.ts): a number
// there is never bought at once, only requested and bought once the carrier approved the documents.

/** Countries a number can be requested in with documents (ISO 3166-1 alpha-2; the UK is GB). */
export const KYC_COUNTRIES = ['DE', 'GB', 'IE'] as const
export type KycCountry = (typeof KYC_COUNTRIES)[number]
export const isKycCountry = (country: string): country is KycCountry =>
  (KYC_COUNTRIES as readonly string[]).includes(country)

/** Who holds the number. `individual`: a person, not a business (Ireland asks for the end user's type). */
export const regulatoryEntityTypes = ['business', 'sole_trader', 'individual'] as const
export type RegulatoryEntityType = (typeof regulatoryEntityTypes)[number]

/** Fields of the workspace's regulatory profile a country can require. */
export const regulatoryFields = [
  'legal_name',
  'entity_type',
  'registration_number',
  /** The court that keeps the register (Germany: "Amtsgericht Mannheim"); optional, sent with the number. */
  'register_court',
  'website',
  'use_case',
  'address',
  'contact',
] as const
export type RegulatoryField = (typeof regulatoryFields)[number]

/**
 * Documents a country can require: `id_or_registration` an ID card or passport of the holder, or the company's
 * registration certificate (Handelsregisterauszug, Companies House, CRO); `proof_of_address` a recent bill or
 * statement at the address (Germany: also showing local activity); `bnetza_form` Telnyx's form for the German
 * Bundesnetzagentur, signed.
 */
export const regulatoryDocumentKinds = ['id_or_registration', 'proof_of_address', 'bnetza_form'] as const
export type RegulatoryDocumentKind = (typeof regulatoryDocumentKinds)[number]

/** The files a document can be: what the carrier takes and a phone camera or scanner makes. */
export const regulatoryDocumentTypes = ['application/pdf', 'image/png', 'image/jpeg'] as const
export type RegulatoryDocumentType = (typeof regulatoryDocumentTypes)[number]
/** Largest document, in bytes: base64 in one action request stays under the API's 4 MB body limit. */
export const REGULATORY_DOCUMENT_MAX_BYTES = 2_500_000
/** Documents one workspace keeps at most (old ones are replaced, not piled up). */
export const REGULATORY_DOCUMENTS_PER_WORKSPACE = 10

/**
 * A city a number can be asked for. `id`: a stable slug (stored with the request; the app shows its name from the
 * catalogs). `prefix`: national prefix without the trunk 0 (Berlin 030: `30`). `names`: how an address may spell the
 * city, lower case, to tell whether the address is in the number's area (cityMatches).
 */
export type NumberCity = { id: string; prefix: string; names: readonly string[] }

export type NumberCountryConfig = {
  country: KycCountry
  /** Without the +: 49, 44, 353. */
  callingCode: string
  numberTypes: readonly ['local']
  fields: readonly RegulatoryField[]
  documents: readonly RegulatoryDocumentKind[]
  /** The address has to be in the number's area-code region (the carrier checks; a city that does not match is flagged). */
  addressInArea: boolean
  /**
   * Major cities first; more can be added without a migration. With `anyArea` only the popular suggestions: a number
   * can be asked for in any area code of the country (Germany: every Ortsnetz).
   */
  cities: readonly NumberCity[]
  /** Any of the country's area codes can be asked for, not only `cities` (numberRequest.areas searches them). */
  anyArea: boolean
}

export const NUMBER_COUNTRIES: Record<KycCountry, NumberCountryConfig> = {
  // Telnyx DE local: contact (name, business, phone), proof of address with local activity, German ID/passport or
  // company registration certificate, BNetzA form, address in the area code's region, company registration number.
  DE: {
    country: 'DE',
    callingCode: '49',
    numberTypes: ['local'],
    fields: ['legal_name', 'entity_type', 'registration_number', 'address', 'contact'],
    documents: ['id_or_registration', 'proof_of_address', 'bnetza_form'],
    addressInArea: true,
    anyArea: true,
    cities: [
      { id: 'berlin', prefix: '30', names: ['berlin'] },
      { id: 'hamburg', prefix: '40', names: ['hamburg'] },
      { id: 'munich', prefix: '89', names: ['münchen', 'munich', 'muenchen'] },
      { id: 'cologne', prefix: '221', names: ['köln', 'cologne', 'koeln'] },
      { id: 'frankfurt', prefix: '69', names: ['frankfurt am main', 'frankfurt'] },
      { id: 'stuttgart', prefix: '711', names: ['stuttgart'] },
      { id: 'duesseldorf', prefix: '211', names: ['düsseldorf', 'duesseldorf'] },
    ],
  },
  // Telnyx GB local (020 …): company website, ID or business registration, contact, proof of address (recent bill),
  // a use case that says the number is sub-allocated to the business; the address can be anywhere.
  GB: {
    country: 'GB',
    callingCode: '44',
    numberTypes: ['local'],
    fields: ['legal_name', 'entity_type', 'registration_number', 'website', 'use_case', 'address', 'contact'],
    documents: ['id_or_registration', 'proof_of_address'],
    addressInArea: false,
    anyArea: false,
    cities: [
      { id: 'london', prefix: '20', names: ['london'] },
      { id: 'manchester', prefix: '161', names: ['manchester'] },
      { id: 'birmingham', prefix: '121', names: ['birmingham'] },
      { id: 'glasgow', prefix: '141', names: ['glasgow'] },
      { id: 'edinburgh', prefix: '131', names: ['edinburgh'] },
    ],
  },
  // Telnyx IE local (01 …): end user's name and type, usage description, ID or registration, address in the area
  // code's region, proof of address, contact email.
  IE: {
    country: 'IE',
    callingCode: '353',
    numberTypes: ['local'],
    fields: ['legal_name', 'entity_type', 'use_case', 'address', 'contact'],
    documents: ['id_or_registration', 'proof_of_address'],
    addressInArea: true,
    anyArea: false,
    cities: [
      { id: 'dublin', prefix: '1', names: ['dublin', 'baile átha cliath'] },
      { id: 'cork', prefix: '21', names: ['cork'] },
      { id: 'galway', prefix: '91', names: ['galway'] },
      { id: 'limerick', prefix: '61', names: ['limerick'] },
    ],
  },
}

/**
 * The countries a server opens for number requests: its setting (comma-separated, `DE,GB`), only countries of
 * KYC_COUNTRIES, each once. Empty or unset: none.
 */
export function parseKycCountries(setting: string | undefined): KycCountry[] {
  const out: KycCountry[] = []
  for (const part of (setting ?? '').split(',')) {
    const code = part.trim().toUpperCase()
    if (isKycCountry(code) && !out.includes(code)) out.push(code)
  }
  return out
}

/**
 * The KYC country a number is in, by its calling code (+49 Germany, +44 the UK, +353 Ireland), or undefined. A number
 * there was only ever requested with documents (these countries are never in NUMBER_BUY_COUNTRIES).
 */
export function kycCountryOfE164(e164: string): KycCountry | undefined {
  return KYC_COUNTRIES.find(country => e164.startsWith(`+${NUMBER_COUNTRIES[country].callingCode}`))
}

/** The city of `prefix` in a country, or undefined. A leading trunk 0 is ignored (`030` is `30`). */
export function numberCity(country: KycCountry, prefix: string): NumberCity | undefined {
  const bare = prefix.replace(/^0+/, '')
  return NUMBER_COUNTRIES[country].cities.find(c => c.prefix === bare)
}

const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase().trim()

/** Whether an address's city is the city of the number (or one of its other names). Carrier review decides in the end. */
export function cityMatches(city: NumberCity, addressCity: string): boolean {
  const wanted = plain(addressCity)
  return city.names.some(name => plain(name) === wanted || wanted.startsWith(`${plain(name)} `))
}

/**
 * Where the value of one carrier requirement comes from: a field of the profile (`contact` split into its parts), the
 * address (the carrier's own address object) or a document kind. Read from the carrier's name for it, so a country
 * needs no mapping of its own; null: Linedesk has no value for it (the request is refused, the operator alerted).
 */
export type RequirementSource =
  | { field: Exclude<RegulatoryField, 'contact' | 'address'> }
  | { field: 'contact'; part: 'name' | 'email' | 'phone' }
  | { address: true }
  | { document: RegulatoryDocumentKind }

export function requirementSource(requirement: {
  name: string
  kind: 'textual' | 'address' | 'document' | 'action'
  description?: string
}): RequirementSource | null {
  if (requirement.kind === 'address') return { address: true }
  // The name says what is asked; the description only when the name says nothing we know (a description often
  // mentions other things: "a utility bill or ID showing the address").
  return (
    sourceFromText(requirement.kind, plain(requirement.name)) ??
    (requirement.description ? sourceFromText(requirement.kind, plain(requirement.description)) : null)
  )
}

function sourceFromText(kind: 'textual' | 'address' | 'document' | 'action', text: string): RequirementSource | null {
  if (kind === 'document') {
    if (/bnetza|bundesnetzagentur|registration form/.test(text)) return { document: 'bnetza_form' }
    if (/address|utility|bill|residence|local activity/.test(text)) return { document: 'proof_of_address' }
    if (/\bid\b|passport|identity|registration|certificate|incorporation|excerpt|register/.test(text))
      return { document: 'id_or_registration' }
    return null
  }
  if (kind !== 'textual') return null
  // Before the registration number: "Commercial register court" names the court, not the number.
  if (/register court|registry court|registration court|court of regist|registergericht|amtsgericht/.test(text))
    return { field: 'register_court' }
  if (/registration number|company number|commercial register|handelsregister|\bcrn\b/.test(text))
    return { field: 'registration_number' }
  if (/website|\burl\b|web site/.test(text)) return { field: 'website' }
  if (/use case|usage|description|purpose|sub-?allocat/.test(text)) return { field: 'use_case' }
  if (/e-?mail/.test(text)) return { field: 'contact', part: 'email' }
  if (/phone|telephone|contact number/.test(text)) return { field: 'contact', part: 'phone' }
  if (/\btype\b/.test(text)) return { field: 'entity_type' }
  if (/business|company|legal|entity|end user|organi[sz]ation/.test(text)) return { field: 'legal_name' }
  if (/name/.test(text)) return { field: 'contact', part: 'name' }
  return null
}
