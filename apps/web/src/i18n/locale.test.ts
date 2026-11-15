import { describe, expect, it } from 'vitest'
import { missingBrowserLanguage, queryLocale, resolveLocale } from './locale.ts'

describe('resolveLocale', () => {
  const base = { query: null, choice: undefined, stored: null, languages: ['en-US'] } as const

  it('follows the browser when nothing else is set (Automatic)', () => {
    expect(resolveLocale({ ...base, languages: ['fr-CA', 'en'] })).toEqual({ locale: 'fr', auto: 'fr' })
    expect(resolveLocale({ ...base, languages: ['pt-PT'] }).locale).toBe('pt-BR')
    expect(resolveLocale({ ...base, languages: ['it-IT'] }).locale).toBe('en')
  })

  it('puts ?lang= first, then the member, then this browser', () => {
    expect(resolveLocale({ ...base, query: 'ja', choice: 'es', stored: 'fr' }).locale).toBe('ja')
    expect(resolveLocale({ ...base, choice: 'es', stored: 'fr' }).locale).toBe('es')
    expect(resolveLocale({ ...base, stored: 'fr' }).locale).toBe('fr')
  })

  it('ignores what this browser last used once a member chose Automatic', () => {
    expect(resolveLocale({ ...base, choice: null, stored: 'fr', languages: ['es-MX'] })).toEqual({
      locale: 'es',
      auto: 'es',
    })
  })
})

describe('queryLocale', () => {
  it('takes UI languages and the pseudo-locale only', () => {
    expect(queryLocale('?lang=ja')).toBe('ja')
    expect(queryLocale('?lang=en-XA')).toBe('en-XA')
    expect(queryLocale('?lang=xx')).toBeNull()
    expect(queryLocale('')).toBeNull()
  })
})

describe('missingBrowserLanguage', () => {
  it('names a first language Linedesk lacks, never English or a covered one', () => {
    expect(missingBrowserLanguage(['it-IT', 'en'])).toBe('it-IT')
    expect(missingBrowserLanguage(['en-GB'])).toBeNull()
    expect(missingBrowserLanguage(['es-419'])).toBeNull()
    expect(missingBrowserLanguage([])).toBeNull()
  })
})
