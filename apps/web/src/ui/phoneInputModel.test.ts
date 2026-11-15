import { describe, expect, test } from 'vitest'
import { optionGroups } from './controls.tsx'
import {
  ALL_COUNTRIES_GROUP,
  caretAfterDigits,
  digitsBefore,
  flagOf,
  meantEdit,
  phoneCountryOptions,
  searchPhoneCountries,
} from './phoneInputModel.ts'

const options = phoneCountryOptions()
const search = (query: string) => searchPhoneCountries(options, query).map(o => o.value)

describe('the country list', () => {
  test('common countries first, then every other one A-Z under "All countries"', () => {
    expect(options.slice(0, 5).map(o => o.value)).toEqual(['US', 'CA', 'GB', 'AU', 'DE'])
    const runs = optionGroups(options)
    expect(runs.map(r => r.group)).toEqual([undefined, ALL_COUNTRIES_GROUP])
    const names = runs[1]!.options.map(o => o.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    // Each country once.
    expect(new Set(options.map(o => o.value)).size).toBe(options.length)
    expect(runs[1]!.options.some(o => o.value === 'DE')).toBe(false)
  })

  test('each country with its flag and calling code', () => {
    expect(options.find(o => o.value === 'DE')).toMatchObject({ name: 'Germany', callingCode: '49', flag: '🇩🇪' })
    expect(flagOf('us')).toBe('🇺🇸')
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
