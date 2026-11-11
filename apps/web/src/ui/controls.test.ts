import { expect, test } from 'vitest'
import { typeaheadIndex } from './controls.tsx'

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
