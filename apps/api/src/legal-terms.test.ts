import { describe, expect, test } from 'vitest'
import { legalTerms } from './legal-terms.ts'

const ALL = {
  TERMS_URL: 'https://desk.example.com/terms',
  TERMS_VERSION: '2026-11-17',
  PRIVACY_URL: 'https://desk.example.com/privacy',
  PRIVACY_VERSION: 'v1.2',
}

describe('legalTerms (A9)', () => {
  test('all four set: the terms to show and record', () => {
    expect(legalTerms(ALL)).toEqual({
      terms: {
        termsUrl: ALL.TERMS_URL,
        termsVersion: '2026-11-17',
        privacyUrl: ALL.PRIVACY_URL,
        privacyVersion: 'v1.2',
      },
      missing: [],
    })
  })

  test('nothing set: none, and every variable is named', () => {
    expect(legalTerms({})).toEqual({
      terms: null,
      missing: ['TERMS_URL', 'TERMS_VERSION', 'PRIVACY_URL', 'PRIVACY_VERSION'],
    })
  })

  test('a link without its version, or a version that is not a short label, counts as missing', () => {
    expect(legalTerms({ ...ALL, PRIVACY_VERSION: ' ' }).missing).toEqual(['PRIVACY_VERSION'])
    expect(legalTerms({ ...ALL, TERMS_VERSION: 'the one on the website' }).missing).toEqual(['TERMS_VERSION'])
    expect(legalTerms({ ...ALL, TERMS_VERSION: 'x'.repeat(41) }).missing).toEqual(['TERMS_VERSION'])
    expect(legalTerms({ ...ALL, TERMS_URL: '' }).missing).toEqual(['TERMS_URL'])
  })

  test('a malformed link stops the server, as under sign-in', () => {
    expect(() => legalTerms({ ...ALL, TERMS_URL: 'javascript:alert(1)' })).toThrow(/http/)
  })
})
