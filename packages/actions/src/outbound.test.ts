import { describe, expect, test } from 'vitest'
import {
  allowedOutboundCountries,
  countriesOfNumbers,
  isCheckableBusinessNumber,
  onCallNumberProblem,
  outboundNumberProblem,
  isHighRiskCountry,
  parseCountryList,
  routeCountries,
} from './index.ts'

const reason = (e164: string, allowed: readonly string[] | 'any') =>
  outboundNumberProblem(e164, allowed)?.reason ?? null

describe('destination policy', () => {
  test('a country is allowed only when it is in the list', () => {
    expect(reason('+4930123456789', ['DE'])).toBeNull()
    expect(reason('+4930123456789', ['US'])).toBe('country')
    expect(onCallNumberProblem('+4930123456789', ['US'])).toBe(
      'Only numbers in the United States can take transferred calls. Ask your server admin to allow other countries.',
    )
    expect(onCallNumberProblem('+12125550123', ['DE'])).toBe(
      'Only numbers in Germany can take transferred calls. Ask your server admin to allow other countries.',
    )
    expect(onCallNumberProblem('+442071234567', ['AT', 'CH', 'DE'])).toMatch(
      /Only numbers in Austria, Switzerland and Germany/,
    )
    expect(reason('+4930123456789', [])).toBe('no_country')
    expect(reason('+4930123456789', 'any')).toBeNull()
  })

  test('real German business numbers when Germany is allowed: Berlin landline, mobile, 032 national number', () => {
    for (const ok of ['+4930123456789', '+493012345678', '+4915123456789', '+4917012345678', '+4932212345678'])
      expect(reason(ok, ['DE'])).toBeNull()
  })

  test('real Korean business numbers when Korea is allowed: Seoul landline, mobile, 070 VoIP line', () => {
    for (const ok of ['+82212345678', '+821012345678', '+827012345678']) expect(reason(ok, ['KR'])).toBeNull()
    expect(reason('+827012345678', ['US'])).toBe('country') // VoIP only in an allowed country
  })

  test('UK: landlines and mobiles; premium, toll-free and personal refused', () => {
    expect(reason('+442071234567', ['GB'])).toBeNull()
    expect(reason('+447400123456', ['GB'])).toBeNull()
    expect(reason('+449012345678', ['GB'])).toBe('premium')
    expect(reason('+448431234567', ['GB'])).toBe('premium')
    expect(reason('+448001234567', ['GB'])).toBe('toll_free')
    expect(reason('+447012345678', ['GB'])).toBe('personal')
  })

  test('premium, shared cost, toll-free and personal numbers are refused in every country, allowed or not', () => {
    expect(reason('+4990012345678', ['DE'])).toBe('invalid') // 0900 with a wrong length
    expect(reason('+499001234567', ['DE'])).toBe('premium')
    expect(reason('+4918012345678', ['DE'])).toBe('shared_cost')
    expect(reason('+491371234567', ['DE'])).toBe('shared_cost')
    expect(reason('+4980012345678', ['DE'])).toBe('toll_free')
    expect(reason('+4970012345678', ['DE'])).toBe('personal')
    expect(reason('+82801234567', ['KR'])).toBe('toll_free')
    expect(reason('+825012345678', ['KR'])).toBe('personal')
    expect(reason('+19005550199', 'any')).toBe('premium')
    expect(reason('+18005550199', 'any')).toBe('toll_free')
  })

  test('emergency and short numbers are refused, also behind a country code', () => {
    for (const emergency of [
      '+112',
      '+911',
      '+999',
      '+49112',
      '+49110',
      '+1911',
      '+44999',
      '+61000',
      '+82119',
      '+81110',
      '+91100',
      '+91108',
      '+3315',
      '+3317',
      '+3318',
      '+49113',
    ])
      expect(reason(emergency, 'any')).toBe('emergency')
    for (const short of ['+4911833', '+441179', '+4912345', '+82114'])
      expect(['short', 'emergency']).toContain(reason(short, 'any'))
    expect(onCallNumberProblem('+49112', ['DE'])).toBe('Emergency numbers cannot take transferred calls.')
  })

  test('numbers without a country, invalid numbers and bad formats are refused', () => {
    expect(reason('+80012345678', 'any')).toBe('non_geographic')
    expect(reason('+87012345678', 'any')).toBe('invalid')
    expect(reason('+493221234567', ['DE'])).toBe('invalid')
    expect(reason('030 1234567', ['DE'])).toBe('format')
    expect(reason('', ['DE'])).toBe('format')
  })

  test('the forwarding check says "checked"', () => {
    expect(onCallNumberProblem('+4930123456789', ['US'], 'check')).toMatch(/can be checked/)
    expect(isCheckableBusinessNumber('+4930123456789')).toBe(true)
    expect(isCheckableBusinessNumber('+4918012345678')).toBe(false)
  })
})

describe('allowed countries', () => {
  test("the workspace's numbers' countries plus the install's", () => {
    const install = (...numbers: string[]) => ({ install: numbers, workspace: [] })
    expect(allowedOutboundCountries(install('+15035550142'), [])).toEqual(['US'])
    expect(allowedOutboundCountries(install('+4930123456789'), ['at', 'XX'])).toEqual(['AT', 'DE'])
    expect(allowedOutboundCountries(install('+15035550142', '+16135550123'), [])).toEqual(['CA', 'US'])
    expect(allowedOutboundCountries({ install: [], workspace: [] }, ['DE'])).toBe('any')
    // Only own-account numbers: the install's list does not apply (it is for calls on the install's account).
    expect(allowedOutboundCountries({ install: [], workspace: ['+4930123456789'] }, ['CA'])).toEqual(['DE'])
    expect(allowedOutboundCountries({ install: ['+15035550142'], workspace: ['+4930123456789'] }, ['CA'])).toEqual([
      'CA',
      'DE',
      'US',
    ])
  })

  test('per route: the install route never gets the countries of own-account numbers, nor the reverse', () => {
    const numbers = { install: ['+15035550142'], workspace: ['+4930123456789'] }
    expect(routeCountries('install', numbers, ['MX'])).toEqual(['MX', 'US'])
    expect(routeCountries('workspace', numbers, ['MX'])).toEqual(['DE'])
  })

  test('high-risk countries are flagged, case-insensitive', () => {
    expect(isHighRiskCountry('cu')).toBe(true)
    expect(isHighRiskCountry('LV')).toBe(true)
    expect(isHighRiskCountry('US')).toBe(false)
    expect(isHighRiskCountry('CA')).toBe(false)
  })

  test('a 555 test number counts as US', () => {
    expect(countriesOfNumbers(['+15555550100'])).toEqual(['US'])
  })

  test('country lists: upper case, known countries, each once, sorted', () => {
    expect(parseCountryList('de, AT  ch;de')).toEqual(['AT', 'CH', 'DE'])
    expect(parseCountryList(['zz', 'us'])).toEqual(['US'])
    expect(parseCountryList(undefined)).toEqual([])
    expect(parseCountryList('*')).toEqual([])
  })
})
