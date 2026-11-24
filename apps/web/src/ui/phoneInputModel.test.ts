import { defaultPhoneCountry } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import { optionGroups } from './controls.tsx'
import {
  allCountriesGroup,
  browserLocale,
  caretAfterDigits,
  digitsBefore,
  flagOf,
  commonPhoneCountries,
  meantEdit,
  phoneCountryOptions,
  phoneCountrySearchPlaceholder,
  searchPhoneCountries,
} from './phoneInputModel.ts'

const options = phoneCountryOptions()
const search = (query: string) => searchPhoneCountries(options, query).map(o => o.value)

describe('the country list', () => {
  test('common countries first, then every other one A-Z under "All countries"', () => {
    expect(options.slice(0, 4).map(o => o.value)).toEqual(['US', 'CA', 'GB', 'AU'])
    const runs = optionGroups(options)
    expect(runs.map(r => r.group)).toEqual([undefined, allCountriesGroup()])
    const names = runs[1]!.options.map(o => o.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    // Each country once.
    expect(new Set(options.map(o => o.value)).size).toBe(options.length)
    expect(runs[1]!.options.some(o => o.value === 'US')).toBe(false)
    expect(runs[1]!.options.some(o => o.value === 'DE')).toBe(true)
  })

  test('each country with its flag and calling code', () => {
    expect(options.find(o => o.value === 'DE')).toMatchObject({ name: 'Germany', callingCode: '49', flag: '🇩🇪' })
    expect(flagOf('us')).toBe('🇺🇸')
  })
})

describe("the viewer's country", () => {
  // The viewer's country as PhoneInput gets it: the workspace's, else the browser locale's (useDefaultPhoneCountry).
  const browser = (locale: string | null) => defaultPhoneCountry({ locale })

  test('the search placeholder shows its calling code', () => {
    expect(phoneCountrySearchPlaceholder(browser('en-US'))).toBe('Search a country or +1')
    expect(phoneCountrySearchPlaceholder(browser('en-GB'))).toBe('Search a country or +44')
    expect(phoneCountrySearchPlaceholder(browser('ja-JP'))).toBe('Search a country or +81')
    expect(phoneCountrySearchPlaceholder(browser('pt-BR'))).toBe('Search a country or +55')
    expect(phoneCountrySearchPlaceholder(browser('ja'))).toBe('Search a country or +81') // the likely region
    expect(phoneCountrySearchPlaceholder('de')).toBe('Search a country or +49')
  })

  test('the workspace country wins over the browser', () => {
    const viewer = defaultPhoneCountry({ country: 'AU', locale: 'pt-BR' })
    expect(phoneCountrySearchPlaceholder(viewer)).toBe('Search a country or +61')
    expect(commonPhoneCountries(viewer)).toEqual(['US', 'CA', 'GB', 'AU'])
  })

  test('without a country, or an unknown one, the US example stays', () => {
    expect(phoneCountrySearchPlaceholder()).toBe('Search a country or +1')
    expect(phoneCountrySearchPlaceholder(null)).toBe('Search a country or +1')
    expect(phoneCountrySearchPlaceholder('XX')).toBe('Search a country or +1')
    expect(phoneCountrySearchPlaceholder(browser(null))).toBe('Search a country or +1')
    expect(phoneCountrySearchPlaceholder(browser('not a locale'))).toBe('Search a country or +1')
  })

  test('goes first among the common countries when it is not one of them, without duplicates', () => {
    expect(commonPhoneCountries(browser('en-US'))).toEqual(['US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries(browser('en-GB'))).toEqual(['US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries(browser('ja-JP'))).toEqual(['JP', 'US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries(browser('pt-BR'))).toEqual(['BR', 'US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries('ca')).toEqual(['US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries()).toEqual(['US', 'CA', 'GB', 'AU'])
    expect(commonPhoneCountries('XX')).toEqual(['US', 'CA', 'GB', 'AU'])
  })

  test("the browser's locale: its first preferred language, null without a browser", () => {
    expect(browserLocale({ languages: ['en-GB', 'en'], language: 'en-US' })).toBe('en-GB')
    expect(browserLocale({ languages: [], language: 'ja-JP' })).toBe('ja-JP')
    expect(browserLocale({ languages: [], language: '' })).toBeNull()
    expect(browserLocale(null)).toBeNull()
    const throwing = {
      get languages(): readonly string[] {
        throw new Error('blocked')
      },
      language: 'pt-BR',
    }
    expect(browserLocale(throwing)).toBeNull()
  })

  test('the list has it in the common group, not again under "All countries"', () => {
    const list = phoneCountryOptions('BR')
    const runs = optionGroups(list)
    expect(runs[0]!.options.map(o => o.value)).toEqual(['BR', 'US', 'CA', 'GB', 'AU'])
    expect(runs[1]!.options.some(o => o.value === 'BR')).toBe(false)
    expect(new Set(list.map(o => o.value)).size).toBe(list.length)
    expect(list).toHaveLength(options.length)
    expect(phoneCountryOptions('BR')).toBe(list) // built once per viewer country
    expect(phoneCountryOptions('US')).toBe(options)
  })
})

describe('search', () => {
  test('by name', () => {
    expect(search('ger')[0]).toBe('DE')
    expect(search('GERMANY')).toEqual(['DE'])
    expect(search('kingdom')).toContain('GB')
    expect(search('cote')).toContain('CI') // accents ignored: Côte d’Ivoire
  })

  test('by ISO code', () => {
    expect(search('DE')[0]).toBe('DE')
    expect(search('gb')[0]).toBe('GB')
  })

  test('by calling code, with or without +; the exact code first', () => {
    expect(search('+49')[0]).toBe('DE')
    expect(search('49')[0]).toBe('DE')
    expect(search('+44')[0]).toBe('GB')
    const plusOne = search('1')
    expect(plusOne.slice(0, 2)).toEqual(['US', 'CA'])
    expect(search('+1').slice(0, 2)).toEqual(['US', 'CA'])
    expect(plusOne).toContain('JM')
    expect(search('+4')).toEqual(expect.arrayContaining(['DE', 'GB', 'AT', 'CH']))
  })

  test('no match: empty; nothing typed: every country as listed', () => {
    expect(search('zzzz')).toEqual([])
    expect(search('  ')).toHaveLength(options.length)
  })
})

describe('the caret while the number is formatted', () => {
  test('stays after the same digit', () => {
    expect(digitsBefore('(503) 555-0', 8)).toBe(5)
    expect(caretAfterDigits('(503) 555-0', 5)).toBe(8)
    expect(caretAfterDigits('(503) 555-0', 0)).toBe(1)
    expect(caretAfterDigits('503', 9)).toBe(3)
  })

  test('Backspace on a space or dash removes the digit before it, Delete the one after it', () => {
    // "(503) 555-0142", caret after "-": Backspace took the dash
    expect(meantEdit('(503) 555-0142', '(503) 5550142', 9, 'backward')).toEqual({ text: '(503) 550142', caret: 8 })
    expect(meantEdit('(503) 555-0142', '(503) 5550142', 9, 'forward')).toEqual({ text: '(503) 555142', caret: 9 })
    // A digit removed: as typed
    expect(meantEdit('(503) 555-0142', '(503) 555-014', 13, 'backward')).toEqual({ text: '(503) 555-014', caret: 13 })
    // Typing: as typed
    expect(meantEdit('(503) 5', '(503) 55', 8, null)).toEqual({ text: '(503) 55', caret: 8 })
  })
})
