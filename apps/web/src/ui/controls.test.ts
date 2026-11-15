import { expect, test } from 'vitest'
import { optionGroups, typeaheadIndex } from './controls.tsx'

const labels = ['New York', 'Chicago', 'Denver', 'Los Angeles', 'Lisbon', 'London']

test('typing jumps to the first label that starts with it, from the top', () => {
  expect(typeaheadIndex(labels, 'd', 0)).toBe(2)
  expect(typeaheadIndex(labels, 'c', 4)).toBe(1)
  expect(typeaheadIndex(labels, 'lo', 3)).toBe(3)
  expect(typeaheadIndex(labels, 'lon', 3)).toBe(5)
  expect(typeaheadIndex(labels, 'x', 0)).toBe(-1)
})

test('the same letter again moves on to the next label with it, wrapping around', () => {
  expect(typeaheadIndex(labels, 'll', 3)).toBe(4)
  expect(typeaheadIndex(labels, 'lll', 4)).toBe(5)
  expect(typeaheadIndex(labels, 'llll', 5)).toBe(3)
})

test('the list shows options without a group first, then each group under its heading, in the given order', () => {
  const options = [
    { value: 'USD', label: 'USD' },
    { value: 'EUR', label: 'EUR' },
    { value: 'AED', label: 'AED', group: 'All currencies' },
    { value: 'BRL', label: 'BRL', group: 'All currencies' },
  ]
  expect(optionGroups(options)).toEqual([
    { group: undefined, start: 0, options: options.slice(0, 2) },
    { group: 'All currencies', start: 2, options: options.slice(2) },
  ])
  expect(optionGroups([])).toEqual([])
  // Headings are not options: typing searches the options alone, the top ones first.
  expect(
    typeaheadIndex(
      options.map(o => o.label),
      'e',
      0,
    ),
  ).toBe(1)
  expect(
    typeaheadIndex(
      options.map(o => o.label),
      'b',
      0,
    ),
  ).toBe(3)
})
