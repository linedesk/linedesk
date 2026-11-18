import { expect, test } from 'vitest'
import { NUMBER_BUY_COUNTRIES } from './area-codes.ts'
import {
  cityMatches,
  KYC_COUNTRIES,
  NUMBER_COUNTRIES,
  numberCity,
  parseKycCountries,
  regulatoryDocumentKinds,
  requirementSource,
} from './number-countries.ts'
import { numberRequestCreate, numberRequestUploadDocument, regulatoryProfileInput } from './number-requests.ts'

test('the flag opens only known countries, each once; empty or unset opens none', () => {
  expect(parseKycCountries(undefined)).toEqual([])
  expect(parseKycCountries('')).toEqual([])
  expect(parseKycCountries(' de, GB ,xx,DE,us')).toEqual(['DE', 'GB'])
})

test('KYC countries are never countries numbers are bought in at once', () => {
  for (const country of KYC_COUNTRIES) expect(NUMBER_BUY_COUNTRIES as readonly string[]).not.toContain(country)
})

test('every country has local numbers, documents and cities with plain national prefixes', () => {
  for (const country of KYC_COUNTRIES) {
    const config = NUMBER_COUNTRIES[country]
    expect(config.country).toBe(country)
    expect(config.numberTypes).toEqual(['local'])
    expect(config.documents.length).toBeGreaterThan(0)
    for (const kind of config.documents) expect(regulatoryDocumentKinds).toContain(kind)
    for (const city of config.cities) {
      expect(city.prefix).toMatch(/^[1-9]\d{0,4}$/)
      expect(city.id).toMatch(/^[a-z]+$/)
      expect(city.names.length).toBeGreaterThan(0)
      for (const name of city.names) expect(name).toBe(name.toLowerCase())
    }
    expect(new Set(config.cities.map(c => c.prefix)).size).toBe(config.cities.length)
  }
  expect(NUMBER_COUNTRIES.DE.documents).toContain('bnetza_form')
  expect(NUMBER_COUNTRIES.GB.fields).toEqual(expect.arrayContaining(['website', 'use_case']))
  expect(NUMBER_COUNTRIES.GB.addressInArea).toBe(false)
})

test('a city by its prefix, with or without the trunk 0', () => {
  expect(numberCity('DE', '030')?.id).toBe('berlin')
  expect(numberCity('DE', '89')?.id).toBe('munich')
  expect(numberCity('GB', '020')?.id).toBe('london')
  expect(numberCity('IE', '01')?.id).toBe('dublin')
  expect(numberCity('DE', '999')).toBeUndefined()
})

test('an address city matches the number city by any of its names, accents and ß aside', () => {
  const munich = numberCity('DE', '89')!
  expect(cityMatches(munich, 'Munich')).toBe(true)
  expect(cityMatches(munich, 'Muenchen')).toBe(true)
  expect(cityMatches(munich, 'münchen')).toBe(true)
  expect(cityMatches(munich, 'Berlin')).toBe(false)
  expect(cityMatches(numberCity('DE', '69')!, 'Frankfurt')).toBe(true)
})

test("the carrier's requirement names map to a profile field, the address or a document kind", () => {
  const map = (name: string, kind: 'textual' | 'address' | 'document') => requirementSource({ name, kind })
  // Germany
  expect(map('Contact name', 'textual')).toEqual({ field: 'contact', part: 'name' })
  expect(map('Business name', 'textual')).toEqual({ field: 'legal_name' })
  expect(map('Contact phone number', 'textual')).toEqual({ field: 'contact', part: 'phone' })
  expect(map('Company registration number', 'textual')).toEqual({ field: 'registration_number' })
  expect(map('Address in the area code region', 'address')).toEqual({ address: true })
  expect(map('Proof of address with evidence of local activity', 'document')).toEqual({ document: 'proof_of_address' })
  expect(map('German ID, passport or company registration certificate', 'document')).toEqual({
    document: 'id_or_registration',
  })
  expect(map('BNetzA registration form', 'document')).toEqual({ document: 'bnetza_form' })
  // UK
  expect(map('Company website', 'textual')).toEqual({ field: 'website' })
  expect(map('Use case description (disclose sub-allocation)', 'textual')).toEqual({ field: 'use_case' })
  expect(map('Contact email', 'textual')).toEqual({ field: 'contact', part: 'email' })
  expect(map('Proof of address (recent utility bill)', 'document')).toEqual({ document: 'proof_of_address' })
  // Ireland
  expect(map('End user name', 'textual')).toEqual({ field: 'legal_name' })
  expect(map('End user type', 'textual')).toEqual({ field: 'entity_type' })
  expect(map('Usage description', 'textual')).toEqual({ field: 'use_case' })
  // Nothing Linedesk has a value for.
  expect(map('Signed letter of authorization', 'document')).toBeNull()
  expect(requirementSource({ name: 'Call Telnyx', kind: 'action' })).toBeNull()
})

test('requirements: the name decides, the description only when the name says nothing known', () => {
  // The description mentions an address, but the name asks for ID.
  expect(
    requirementSource({
      name: 'Passport',
      kind: 'document',
      description: 'A passport or ID card; the address on it need not match',
    }),
  ).toEqual({ document: 'id_or_registration' })
  // The description mentions a website, but the name asks for an email.
  expect(
    requirementSource({ name: 'Contact email', kind: 'textual', description: 'as shown on the company website' }),
  ).toEqual({ field: 'contact', part: 'email' })
  // A name that says nothing known: the description is read.
  expect(requirementSource({ name: 'Item 7', kind: 'document', description: 'A recent utility bill' })).toEqual({
    document: 'proof_of_address',
  })
  expect(requirementSource({ name: 'Item 8', kind: 'document', description: 'Something else' })).toBeNull()
})

test('inputs: a profile with a contact in E.164, a prefix of digits, a document as plain base64', () => {
  const profile = {
    legal_name: 'Brightwater GmbH',
    entity_type: 'business',
    address: { street: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
    contact: { first_name: 'Mike', last_name: 'Brennan', email: 'mike@example.com', phone: '+4930555000' },
  }
  expect(regulatoryProfileInput.safeParse(profile).success).toBe(true)
  expect(
    regulatoryProfileInput.safeParse({ ...profile, contact: { ...profile.contact, phone: '030 555' } }).success,
  ).toBe(false)
  expect(regulatoryProfileInput.safeParse({ ...profile, extra: 1 }).success).toBe(false)
  expect(numberRequestCreate.input.safeParse({ country: 'DE', prefix: '030' }).success).toBe(true)
  expect(numberRequestCreate.input.safeParse({ country: 'US', prefix: '503' }).success).toBe(false)
  expect(numberRequestCreate.input.safeParse({ country: 'DE', prefix: '30a' }).success).toBe(false)
  const doc = { kind: 'proof_of_address', filename: 'bill.pdf', contentType: 'application/pdf', content: 'JVBERi0=' }
  expect(numberRequestUploadDocument.input.safeParse(doc).success).toBe(true)
  expect(numberRequestUploadDocument.input.safeParse({ ...doc, filename: '../x.pdf' }).success).toBe(false)
  expect(numberRequestUploadDocument.input.safeParse({ ...doc, contentType: 'text/html' }).success).toBe(false)
  expect(numberRequestUploadDocument.sensitive).toEqual(['content'])
})
