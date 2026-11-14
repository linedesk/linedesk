import { expect, test } from 'vitest'
import { areaCodeLabel, phoneNumberSetup, searchAreaCodes, US_AREA_CODES, US_STATE_NAMES, usAreaCode } from './index.ts'
import { inputErrorText } from './input-errors.ts'

const codes = US_AREA_CODES.map(a => a.code)

test('the list holds only geographic US area codes, each once, sorted', () => {
  expect(codes.length).toBeGreaterThan(350)
  expect(new Set(codes).size).toBe(codes.length)
  expect([...codes].sort()).toEqual(codes)
  for (const code of codes) {
    expect(code).toMatch(/^[2-9]\d\d$/)
    // N11 service codes (211, 411, 911), N9X and 37X/96X are never area codes.
    expect(code.slice(1)).not.toBe('11')
    expect(code[1]).not.toBe('9')
  }
  for (const tollFree of ['800', '833', '844', '855', '866', '877', '888'])
    expect(codes, tollFree).not.toContain(tollFree)
  // 555 (directory), 5XX personal and 9XX premium codes, 710 (government), and the territories (787 Puerto Rico).
  for (const other of ['555', '500', '533', '900', '976', '710', '787', '671'])
    expect(codes, other).not.toContain(other)
})

test('every area code has a city and a state', () => {
  for (const a of US_AREA_CODES) {
    expect(a.city.trim(), a.code).not.toBe('')
    expect(US_STATE_NAMES[a.state], a.code).toBeDefined()
  }
  expect(usAreaCode('503')).toEqual({ code: '503', city: 'Portland', state: 'OR' })
  expect(areaCodeLabel(usAreaCode('503')!)).toBe('503 · Portland, OR')
  expect(usAreaCode('800')).toBeUndefined()
})

test('a search matches the code, the city and the state', () => {
  const search = (q: string) => searchAreaCodes(US_AREA_CODES, q).map(a => a.code)
  expect(search('')).toEqual(codes)
  expect(search('503')).toEqual(['503'])
  expect(search('50')).toEqual(codes.filter(c => c.startsWith('50')))
  expect(search('portland')).toEqual(['207', '503', '971'])
  expect(search('Portland, OR')).toEqual(['503', '971'])
  expect(search(areaCodeLabel(usAreaCode('971')!))).toEqual(['971'])
  expect(search('OR')).toEqual(expect.arrayContaining(['458', '503', '541', '971']))
  expect(search('oregon')).toEqual(['458', '503', '541', '971'])
  expect(search('new york')).toContain('212')
  expect(search('san fr')).toEqual(['415', '628'])
  expect(search('nowhere')).toEqual([])
})

test('the server refuses an area code that is not in the list, in a plain sentence', () => {
  const sent = { areaCode: '555', purchase: true }
  const parsed = phoneNumberSetup.input.safeParse(sent)
  expect(parsed.success).toBe(false)
  expect(inputErrorText(parsed.error!, sent)).toBe('Area code: not a US area code a number can be bought in.')
})
