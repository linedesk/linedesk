import { expect, test } from 'vitest'
import { codeErrorMessage, normalizeCode } from './sign-in-code.ts'

test('the code field keeps digits only, at most six, so a pasted code works', () => {
  expect(normalizeCode('123456')).toBe('123456')
  expect(normalizeCode('123 456')).toBe('123456')
  expect(normalizeCode('Code: 123-456 ')).toBe('123456')
  expect(normalizeCode('1234567')).toBe('123456')
  expect(normalizeCode('abc')).toBe('')
})

test('server errors become short messages', () => {
  expect(codeErrorMessage({ code: 'INVALID_OTP', message: 'Invalid OTP' })).toMatch(/not right/)
  expect(codeErrorMessage({ code: 'OTP_EXPIRED' })).toMatch(/expired/)
  expect(codeErrorMessage({ code: 'TOO_MANY_ATTEMPTS' })).toMatch(/Too many tries/)
  expect(codeErrorMessage({ message: 'Sign-up is closed on this server.' })).toBe('Sign-up is closed on this server.')
  expect(codeErrorMessage({})).toMatch(/did not work/)
})
