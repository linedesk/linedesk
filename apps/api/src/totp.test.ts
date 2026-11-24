import { expect, test } from 'vitest'
import {
  base32Decode,
  base32Encode,
  cleanCode,
  codeAt,
  matchingStep,
  newTotpSecret,
  otpauthUrl,
  stepAt,
} from './totp.ts'

// RFC 6238 appendix B (SHA1), last 6 of the 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

test('codes match the RFC 6238 test vectors', () => {
  expect(codeAt(RFC_SECRET, stepAt(59_000))).toBe('287082')
  expect(codeAt(RFC_SECRET, stepAt(1_111_111_109_000))).toBe('081804')
  expect(codeAt(RFC_SECRET, stepAt(1_234_567_890_000))).toBe('005924')
  expect(codeAt(RFC_SECRET, stepAt(20_000_000_000_000))).toBe('353130')
})

test('base32 round-trips and ignores spaces and case', () => {
  const bytes = Buffer.from('any bytes at all \x00\xff')
  expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
  expect(base32Decode('mfrg gzdf')).toEqual(base32Decode('MFRGGZDF'))
  expect(() => base32Decode('not-base32!')).toThrow()
})

test('a new secret is 160 bits', () => {
  expect(base32Decode(newTotpSecret())).toHaveLength(20)
  expect(newTotpSecret()).not.toBe(newTotpSecret())
})

test('a code is 6 digits; spaces and dashes are dropped', () => {
  expect(cleanCode('123 456')).toBe('123456')
  expect(cleanCode('123-456')).toBe('123456')
  expect(cleanCode('12345')).toBeNull()
  expect(cleanCode('12345a')).toBeNull()
})

test('the step before and after count, older ones and used ones do not', () => {
  const now = 1_700_000_000_000
  const step = stepAt(now)
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step), now)).toBe(step)
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now)).toBe(step - 1)
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now)).toBe(step + 1)
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now)).toBeNull()
  // Used already (or an older one than the last used): refused.
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step), now, step)).toBeNull()
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now, step)).toBeNull()
  expect(matchingStep(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now, step)).toBe(step + 1)
  expect(matchingStep(RFC_SECRET, 'abcdef', now)).toBeNull()
})

test('the otpauth address carries the secret, issuer and account', () => {
  const url = new URL(otpauthUrl('ABC', 'Linedesk', 'mike@brightwater.example'))
  expect(url.protocol).toBe('otpauth:')
  expect(decodeURIComponent(url.href.split('?')[0]!)).toBe('otpauth://totp/Linedesk:mike@brightwater.example')
  expect(url.searchParams.get('secret')).toBe('ABC')
  expect(url.searchParams.get('issuer')).toBe('Linedesk')
})
