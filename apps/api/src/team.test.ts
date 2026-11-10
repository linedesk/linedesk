import { describe, expect, test } from 'vitest'
import { emailSafeName } from './team.ts'

describe('emailSafeName', () => {
  test('keeps ordinary names', () => {
    expect(emailSafeName('Brightwater Plumbing & Heating', 'x')).toBe('Brightwater Plumbing & Heating')
    expect(emailSafeName('Mike B.', 'x')).toBe('Mike B.')
    expect(emailSafeName('St. Johns Heating', 'x')).toBe('St. Johns Heating')
  })

  test('leaves out names a mail program would turn into a link', () => {
    for (const name of ['https://evil.example', 'Pay at evil.example now', 'www.evil', 'mike@evil.example', 'paypal.com-login'])
      expect(emailSafeName(name, 'their workspace')).toBe('their workspace')
  })

  test('one line, at most 60 characters, fallback when empty', () => {
    expect(emailSafeName('A\nB', 'x')).toBe('A B')
    expect(emailSafeName('a'.repeat(80), 'x')).toHaveLength(60)
    expect(emailSafeName('  ', 'A teammate')).toBe('A teammate')
    expect(emailSafeName(null, 'A teammate')).toBe('A teammate')
  })
})
