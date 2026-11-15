import { AREA_CODES, BUYABLE_AREA_CODES } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { areaCodeList, areaCodeMatches, areaCodeText, typedAreaCode } from './AreaCodeInput.tsx'

const US = areaCodeList('US')
const codes = (query: string, value = '', list = US) => areaCodeMatches(query, value, list).map(a => a.code)

test('the field shows the picked code with its city and state or province', () => {
  expect(areaCodeText('503')).toBe('503 · Portland, OR')
  expect(areaCodeText('416')).toBe('416 · Toronto, ON')
  expect(areaCodeText('787')).toBe('787 · San Juan, PR')
  expect(areaCodeText('')).toBe('')
})

test("the list is the workspace country's; without a country every country's", () => {
  expect(areaCodeList('US')).toBe(AREA_CODES.US)
  expect(areaCodeList('CA')).toBe(AREA_CODES.CA)
  expect(areaCodeList('PR')).toBe(AREA_CODES.PR)
  expect(areaCodeList(null)).toBe(BUYABLE_AREA_CODES)
  expect(areaCodeList(undefined)).toBe(BUYABLE_AREA_CODES)
})

test('a search matches the code, the city and the state', () => {
  expect(codes('')).toHaveLength(AREA_CODES.US.length)
  expect(codes('503')).toEqual(['503'])
  expect(codes('portland')).toEqual(['207', '503', '971'])
  expect(codes('Portland OR')).toEqual(['503', '971'])
  expect(codes('xyz')).toEqual([])
  // A Canadian code is not in the US list.
  expect(codes('416')).toEqual([])
})

test('in Canada and Puerto Rico the search finds their codes by city and province', () => {
  expect(codes('toronto', '', AREA_CODES.CA)).toEqual(['416', '437', '647', '942'])
  expect(codes('ontario', '', AREA_CODES.CA)).toContain('613')
  expect(codes('', '', AREA_CODES.PR)).toEqual(['787', '939'])
})

test('the picked code shown in the field is no search: the whole list opens', () => {
  expect(codes('503 · Portland, OR', '503')).toHaveLength(AREA_CODES.US.length)
  // Once changed, it searches again.
  expect(codes('503 · Portland, O', '503')).toEqual(['503'])
})

test('a code typed in full is taken only when it is in the list', () => {
  expect(typedAreaCode('503', US)).toBe('503')
  expect(typedAreaCode(' 971 ', US)).toBe('971')
  expect(typedAreaCode('50', US)).toBe('')
  expect(typedAreaCode('800', US)).toBe('')
  expect(typedAreaCode('555', US)).toBe('')
  expect(typedAreaCode('portland', US)).toBe('')
  expect(typedAreaCode('416', US)).toBe('')
  expect(typedAreaCode('416', AREA_CODES.CA)).toBe('416')
  expect(typedAreaCode('939', AREA_CODES.PR)).toBe('939')
  // Jamaica's 876 is in no list.
  expect(typedAreaCode('876')).toBe('')
})
