import { expect, test } from 'vitest'
import { countryNames, searchLanguages } from './languageSearch.ts'

const options = [
  { value: 'en', label: 'English (country default)' },
  { value: 'de', label: 'Deutsch · German' },
  { value: 'es', label: 'Español · Spanish' },
]
const names = new Intl.DisplayNames(['en'], { type: 'region' })
const countries = countryNames([code => names.of(code)])
const search = (query: string) => searchLanguages(options, query, countries, code => names.of(code) ?? code)

test('a country finds its language, named on the right', () => {
  expect(search('mexi')).toEqual([{ value: 'es', label: 'Español · Spanish', meta: 'Mexico' }])
  expect(search('austria').map(o => o.value)).toEqual(['de'])
})

test('a language name matches first, a country does not repeat it', () => {
  expect(search('germ')).toEqual([{ value: 'de', label: 'Deutsch · German' }])
})

test('a language no country of the list offers, or one letter, gives only name matches', () => {
  expect(search('japan')).toEqual([])
  expect(search('m').map(o => o.value)).not.toContain('es') // not Mexico from one letter
})
