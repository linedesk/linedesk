import { expect, test } from 'vitest'
import {
  AREA_CODES,
  areaCodeLabel,
  areaCodesIn,
  BUYABLE_AREA_CODES,
  buyableAreaCode,
  canBuyNumbersIn,
  NUMBER_BUY_COUNTRIES,
  phoneNumberSetup,
  REGION_NAMES,
  searchAreaCodes,
} from './index.ts'
import { inputErrorText } from './input-errors.ts'

const US_AREA_CODES = AREA_CODES.US
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
  for (const a of BUYABLE_AREA_CODES) {
    expect(a.city.trim(), a.code).not.toBe('')
    expect(REGION_NAMES[a.state], a.code).toBeDefined()
  }
  expect(buyableAreaCode('503')).toEqual({ code: '503', city: 'Portland', state: 'OR', country: 'US' })
  expect(areaCodeLabel(buyableAreaCode('503')!)).toBe('503 · Portland, OR')
  expect(buyableAreaCode('800')).toBeUndefined()
})

test('a search matches the code, the city and the state', () => {
  const search = (q: string) => searchAreaCodes(US_AREA_CODES, q).map(a => a.code)
  expect(search('')).toEqual(codes)
  expect(search('503')).toEqual(['503'])
  expect(search('50')).toEqual(codes.filter(c => c.startsWith('50')))
  expect(search('portland')).toEqual(['207', '503', '971'])
  expect(search('Portland, OR')).toEqual(['503', '971'])
  expect(search(areaCodeLabel(buyableAreaCode('971')!))).toEqual(['971'])
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
  expect(inputErrorText(parsed.error!, sent)).toBe(
    'Area code: not an area code a number can be bought in (US, Canada, Puerto Rico).',
  )
  // Canada's and Puerto Rico's are taken; a Caribbean one (Jamaica 876, the Dominican Republic 809) is not.
  for (const areaCode of ['416', '604', '787', '939'])
    expect(phoneNumberSetup.input.safeParse({ areaCode, purchase: true }).success, areaCode).toBe(true)
  for (const areaCode of ['876', '809', '242', '671', '340'])
    expect(phoneNumberSetup.input.safeParse({ areaCode, purchase: true }).success, areaCode).toBe(false)
})

test('numbers can be bought in the US, Canada and Puerto Rico (LIN-300), whatever the case', () => {
  expect(NUMBER_BUY_COUNTRIES).toEqual(['US', 'CA', 'PR'])
  for (const country of ['US', ' us ', 'CA', 'ca', 'PR']) expect(canBuyNumbersIn(country), country).toBe(true)
  for (const country of ['DE', 'GB', 'MX', 'JM', 'DO', 'VI', 'GU', ''])
    expect(canBuyNumbersIn(country), country).toBe(false)
})

test("Canada's list: every geographic code in service in each province and territory, nothing else", () => {
  const ca = AREA_CODES.CA.map(a => a.code)
  expect(ca).toHaveLength(55)
  expect(new Set(ca).size).toBe(ca.length)
  expect([...ca].sort()).toEqual(ca)
  for (const code of ['416', '437', '647', '942', '514', '438', '263', '604', '778', '403', '780', '902', '709', '867'])
    expect(ca, code).toContain(code)
  // Non-geographic (600, 622), not in service yet (568 Alberta, 851 Nova Scotia), toll-free.
  for (const code of ['600', '622', '633', '568', '851', '800']) expect(ca, code).not.toContain(code)
  for (const a of AREA_CODES.CA) expect(a.country).toBe('CA')
  expect(new Set(AREA_CODES.CA.map(a => a.state))).toEqual(
    new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'QC', 'SK', 'YT']),
  )
  expect(areaCodeLabel(buyableAreaCode('416')!)).toBe('416 · Toronto, ON')
})

test("Puerto Rico's two codes, 787 and 939; the Caribbean and other territories are in no list", () => {
  expect(AREA_CODES.PR).toEqual([
    { code: '787', city: 'San Juan', state: 'PR', country: 'PR' },
    { code: '939', city: 'San Juan', state: 'PR', country: 'PR' },
  ])
  // Jamaica, the Dominican Republic, the Bahamas, Barbados, Trinidad, the US Virgin Islands, Guam, Bermuda.
  for (const code of ['876', '658', '809', '829', '849', '242', '246', '868', '340', '671', '441'])
    expect(buyableAreaCode(code), code).toBeUndefined()
})

test('the lists do not overlap, so an area code alone names its country', () => {
  const all = BUYABLE_AREA_CODES.map(a => a.code)
  expect(new Set(all).size).toBe(all.length)
  expect(all).toHaveLength(AREA_CODES.US.length + AREA_CODES.CA.length + AREA_CODES.PR.length)
  expect(buyableAreaCode('416')?.country).toBe('CA')
  expect(buyableAreaCode('939')?.country).toBe('PR')
  expect(buyableAreaCode('212')?.country).toBe('US')
})

test("a workspace's area codes are its own country's; none outside the buying countries", () => {
  expect(areaCodesIn('US')).toBe(AREA_CODES.US)
  expect(areaCodesIn(' ca ')).toBe(AREA_CODES.CA)
  expect(areaCodesIn('PR')).toBe(AREA_CODES.PR)
  expect(areaCodesIn('DE')).toEqual([])
})

test('a search finds Canadian codes by city, province code and province name', () => {
  const search = (q: string) => searchAreaCodes(AREA_CODES.CA, q).map(a => a.code)
  expect(search('toronto')).toEqual(['416', '437', '647', '942'])
  expect(search('Toronto, ON')).toEqual(['416', '437', '647', '942'])
  expect(search('british col')).toEqual(['236', '250', '257', '604', '672', '778'])
  expect(search('QC')).toContain('514')
  expect(search("st. john's")).toEqual(['709', '879'])
  expect(searchAreaCodes(AREA_CODES.PR, 'puerto rico').map(a => a.code)).toEqual(['787', '939'])
  expect(searchAreaCodes(AREA_CODES.PR, 'san juan').map(a => a.code)).toEqual(['787', '939'])
})
