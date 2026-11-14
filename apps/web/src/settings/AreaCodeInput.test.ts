import { US_AREA_CODES } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { areaCodeMatches, areaCodeText, typedAreaCode } from './AreaCodeInput.tsx'

const codes = (query: string, value = '') => areaCodeMatches(query, value).map(a => a.code)

test('the field shows the picked code with its city and state', () => {
  expect(areaCodeText('503')).toBe('503 · Portland, OR')
  expect(areaCodeText('')).toBe('')
})

test('a search matches the code, the city and the state', () => {
  expect(codes('')).toHaveLength(US_AREA_CODES.length)
  expect(codes('503')).toEqual(['503'])
  expect(codes('portland')).toEqual(['207', '503', '971'])
  expect(codes('Portland OR')).toEqual(['503', '971'])
  expect(codes('xyz')).toEqual([])
})

test('the picked code shown in the field is no search: the whole list opens', () => {
  expect(codes('503 · Portland, OR', '503')).toHaveLength(US_AREA_CODES.length)
  // Once changed, it searches again.
  expect(codes('503 · Portland, O', '503')).toEqual(['503'])
})

test('a code typed in full is taken only when it is in the list', () => {
  expect(typedAreaCode('503')).toBe('503')
  expect(typedAreaCode(' 971 ')).toBe('971')
  expect(typedAreaCode('50')).toBe('')
  expect(typedAreaCode('800')).toBe('')
  expect(typedAreaCode('555')).toBe('')
  expect(typedAreaCode('portland')).toBe('')
})
