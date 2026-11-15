import { describe, expect, test } from 'vitest'
import {
  completePhone,
  countryOfNumber,
  defaultPhoneCountry,
  nanpAreaCode,
  phoneFromValue,
  phoneNumberProblem,
  phonePlaceholder,
  typePhone,
} from './phone-input.ts'

describe('typePhone', () => {
  test('formats the number for the picked country as it is typed, with the value in E.164', () => {
    expect(typePhone('5035550', 'US')).toEqual({ country: 'US', display: '(503) 555-0', e164: '+15035550' })
    expect(typePhone('5035550142', 'US')).toEqual({ country: 'US', display: '(503) 555-0142', e164: '+15035550142' })
    expect(typePhone('030123456', 'DE')).toEqual({ country: 'DE', display: '030 123456', e164: '+4930123456' })
    expect(typePhone('', 'DE')).toEqual({ country: 'DE', display: '', e164: '' })
  })

  test('a pasted number with + or 00 picks its country and shows without the country code', () => {
    expect(typePhone('+49 30 123456', 'US')).toEqual({ country: 'DE', display: '030 123456', e164: '+4930123456' })
    expect(typePhone('0049 30 123456', 'US')).toEqual({ country: 'DE', display: '030 123456', e164: '+4930123456' })
    expect(typePhone('+44 20 7946 0958', 'US')).toMatchObject({ country: 'GB', e164: '+442079460958' })
    expect(typePhone('+1 (503) 555-0142', 'DE')).toEqual({
      country: 'US',
      display: '(503) 555-0142',
      e164: '+15035550142',
    })
  })

  test('typing on after a pasted country code keeps the trunk prefix, so the number formats as at home', () => {
    const first = typePhone('0049 30', 'US')
    expect(first).toMatchObject({ country: 'DE', display: '030', e164: '+4930' })
    expect(typePhone(`${first.display}123456`, first.country)).toEqual({
      country: 'DE',
      display: '030 123456',
      e164: '+4930123456',
    })
  })

  test('a shared calling code keeps the picked country until the number says another', () => {
    expect(typePhone('+1503', 'CA').country).toBe('CA')
    expect(typePhone('+1503', 'DE').country).toBe('US')
    expect(typePhone('+1 416 555 0142', 'US').country).toBe('CA')
  })

  test('a + alone or an unknown code stays as typed', () => {
    expect(typePhone('+', 'US')).toEqual({ country: 'US', display: '+', e164: '' })
    expect(typePhone('+999', 'US')).toMatchObject({ country: 'US', display: '+999' })
  })
})

test('a stored value shows in its own country; a number saved as typed is read in the default country', () => {
  expect(phoneFromValue('+4930123456', 'US')).toMatchObject({ country: 'DE', display: '030 123456' })
  expect(phoneFromValue('(503) 555-0142', 'US')).toMatchObject({ country: 'US', e164: '+15035550142' })
  expect(phoneFromValue('', 'GB')).toEqual({ country: 'GB', display: '', e164: '' })
})

describe('phoneNumberProblem', () => {
  test('nothing typed, or a whole number: no problem', () => {
    expect(phoneNumberProblem('')).toBeNull()
    expect(phoneNumberProblem('+15035550142')).toBeNull()
    expect(phoneNumberProblem('+4930123456')).toBeNull()
    expect(phoneNumberProblem('+4915112345678')).toBeNull()
    // 555 test numbers are North American numbers too
    expect(phoneNumberProblem('+15555550100')).toBeNull()
  })

  test('names the country an unfinished or impossible number was checked for', () => {
    expect(phoneNumberProblem('+4930')).toBe("This number doesn't look complete for Germany.")
    expect(phoneNumberProblem('+1503555')).toBe("This number doesn't look complete for the United States.")
    expect(phoneNumberProblem('+44207946095812345')).toBe('This number is too long for the United Kingdom.')
    expect(phoneNumberProblem('+999123')).toBe('Pick the country of this number.')
    expect(phoneNumberProblem('5035550142')).toMatch(/country code/)
  })

  test('completePhone: the value only when it is a whole number', () => {
    expect(completePhone('+4930123456')).toBe('+4930123456')
    expect(completePhone('+4930')).toBeNull()
    expect(completePhone('')).toBeNull()
  })
})

test('the country of a number; a North American one libphonenumber cannot place is a US one', () => {
  expect(countryOfNumber('+4930123456')).toBe('DE')
  expect(countryOfNumber('+15555550100')).toBe('US')
  expect(countryOfNumber('(503) 555-0142')).toBeNull()
  expect(countryOfNumber(null)).toBeNull()
})

test('the default country: assistant number, workspace, business phone, locale, then the US', () => {
  expect(defaultPhoneCountry({ assistantNumber: '+4930123456', workspaceCountry: 'GB', locale: 'en-US' })).toBe('DE')
  expect(defaultPhoneCountry({ assistantNumber: null, workspaceCountry: 'gb', locale: 'de-DE' })).toBe('GB')
  expect(defaultPhoneCountry({ businessNumber: '+61 2 9876 5432', locale: 'de-DE' })).toBe('AU')
  expect(defaultPhoneCountry({ businessNumber: '(503) 555-0142', locale: 'de-DE' })).toBe('DE')
  expect(defaultPhoneCountry({ locale: 'de' })).toBe('DE')
  expect(defaultPhoneCountry({ workspaceCountry: 'XX', locale: 'nonsense-' })).toBe('US')
  expect(defaultPhoneCountry({})).toBe('US')
})

test('the placeholder is an example number of the country', () => {
  expect(phonePlaceholder('US')).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/)
  expect(phonePlaceholder('XX')).toBe('')
})

test("the area code of a valid North American number only; another country's number has none", () => {
  expect(nanpAreaCode('+15035550142')).toBe('503')
  expect(nanpAreaCode('(206) 555-0100')).toBe('206')
  expect(nanpAreaCode('+14165550100')).toBe('416')
  // Ten digits after the +, but German: no area code 493.
  expect(nanpAreaCode('+4930123456')).toBeNull()
  expect(nanpAreaCode('+442071838750')).toBeNull()
  // Typed without a country code, but not a valid US number.
  expect(nanpAreaCode('4930123456')).toBeNull()
  expect(nanpAreaCode('555-0142')).toBeNull()
  expect(nanpAreaCode('')).toBeNull()
  expect(nanpAreaCode(null)).toBeNull()
})
