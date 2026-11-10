import { expect, test } from 'vitest'
import { authErrorMessage, codeErrorMessage, normalizeCode } from './sign-in-code.ts'

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

test('password and sign-up errors use the app wording, never the library wording', () => {
  expect(authErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })).toBe("That email and password don't match.")
  expect(authErrorMessage({ code: 'USER_ALREADY_EXISTS' })).toMatch(/Sign in instead/)
  expect(authErrorMessage({ status: 429, message: 'Too many requests' })).toMatch(/Wait a minute/)
  expect(authErrorMessage({ message: 'Something odd' })).toBe('Something odd.')
})
