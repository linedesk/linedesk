import { createIntl } from '@formatjs/intl'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFormatters,
  createTranslator,
  enMessages,
  intlConfig,
  languageLabel,
  type MessageKey,
  matchLocale,
  parseAcceptLanguage,
} from './index.ts'
import { pseudoMessage } from './pseudo.ts'
import { localeForUser } from './server.ts'

describe('matchLocale', () => {
  it.each([
    [['pt-PT'], 'pt-BR'],
    [['pt'], 'pt-BR'],
    [['es-419'], 'es'],
    [['es-MX', 'en'], 'es'],
    [['fr-CA'], 'fr'],
    [['ja-JP'], 'ja'],
    [['zh'], 'en'],
    [['zh-CN', 'fr'], 'fr'],
    [['en-GB'], 'en'],
    [[], 'en'],
    [['not a tag'], 'en'],
  ])('%j gives %s', (requested, expected) => {
    expect(matchLocale(requested)).toBe(expected)
  })
})

describe('parseAcceptLanguage', () => {
  it('orders by quality, keeps the order of equals, drops * and q=0', () => {
    expect(parseAcceptLanguage('en;q=0.5, fr-CA, fr;q=0.9, *;q=0.1, de;q=0')).toEqual(['fr-CA', 'fr', 'en'])
    expect(parseAcceptLanguage(null)).toEqual([])
  })
})

describe('localeForUser', () => {
  it('takes the choice, then Automatic, then the request, then English', () => {
    expect(localeForUser({ locale: 'ja', localeAuto: 'es' }, 'fr')).toBe('ja')
    expect(localeForUser({ locale: null, localeAuto: 'es' }, 'fr')).toBe('es')
    expect(localeForUser({ locale: 'xx' }, 'pt-PT,en;q=0.5')).toBe('pt-BR')
    expect(localeForUser(null, undefined)).toBe('en')
  })
})

describe('translator', () => {
  afterEach(() => {
    delete enMessages['test.greeting']
  })

  it('falls back to English for a key the language does not have', () => {
    enMessages['test.greeting'] = 'Hello {name}'
    const es = createTranslator('es', {})
    expect(es.t('test.greeting' as MessageKey, { name: 'Maya' })).toBe('Hello Maya')
    const withKey = createTranslator('es', { 'test.greeting': 'Hola {name}' })
    expect(withKey.t('test.greeting' as MessageKey, { name: 'Maya' })).toBe('Hola Maya')
  })

  it('uses each language’s plural rules: Japanese has only other, French counts 0 as one', () => {
    const calls = (locale: 'ja' | 'fr', message: string, n: number) =>
      createIntl(intlConfig(locale, { calls: message })).formatMessage({ id: 'calls' }, { n })
    expect(calls('ja', '{n, plural, other {#件の通話}}', 1)).toBe('1件の通話')
    expect(calls('fr', '{n, plural, one {# appel} other {# appels}}', 0)).toBe('0 appel')
    expect(calls('fr', '{n, plural, one {# appel} other {# appels}}', 2)).toBe('2 appels')
  })
})

describe('formatters', () => {
  it('format with the active locale, never en-US', () => {
    const date = new Date(Date.UTC(2026, 10, 14, 15, 5))
    expect(createFormatters('en').dateTime(date, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })).toBe(
      '3:05 PM',
    )
    expect(createFormatters('de').dateTime(date, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })).toBe('15:05')
    expect(createFormatters('es').list(['A', 'B', 'C'])).toBe('A, B y C')
    expect(createFormatters('fr').number(1234.5)).toBe('1 234,5')
    expect(createFormatters('en-XA').number(1234.5)).toBe('1,234.5')
    expect(createFormatters('en').duration(80)).toMatch(/1 min,? 20 sec/)
    expect(createFormatters('de').duration(181, 'digital')).toBe('03:01')
    expect(createFormatters('en').duration(3781, 'digital')).toBe('1:03:01')
  })

  it('rates are dollar amounts with decimals, never the cent sign', () => {
    const en = createFormatters('en')
    expect(en.rate(0.05, 'USD')).toBe('$0.05')
    expect(en.rate(0.1, 'USD')).toBe('$0.10')
    expect(en.rate(0.2, 'USD')).toBe('$0.20')
    expect(en.rate(0.75, 'USD')).toBe('$0.75')
    expect(en.rate(0.0085, 'USD')).toBe('$0.0085')
    expect(en.rate(0.005, 'USD')).toBe('$0.005')
    expect(en.rate(1, 'USD')).toBe('$1.00')
    expect(en.rate(0.05, 'USD')).not.toContain('¢')
    expect(createFormatters('de').rate(0.05, 'USD')).toMatch(/^0,05\s\$$/)
  })

  it("the funnel's price a minute: whole US cents in English with the cent sign, everything else as a rate", () => {
    const en = createFormatters('en')
    expect(en.centRate(0.05, 'USD')).toBe('5¢')
    expect(en.centRate(0.1, 'USD')).toBe('10¢')
    expect(en.centRate(0.2, 'USD')).toBe('20¢')
    // Sub-cent, a dollar or more, nothing: dollars.
    expect(en.centRate(0.0085, 'USD')).toBe('$0.0085')
    expect(en.centRate(1, 'USD')).toBe('$1.00')
    expect(en.centRate(0, 'USD')).toBe('$0.00')
    // Another currency, or another language: the rate as it was.
    expect(en.centRate(0.05, 'EUR')).toBe('€0.05')
    expect(createFormatters('de').centRate(0.05, 'USD')).toMatch(/^0,05\s\$$/)
    expect(createFormatters('en-XA').centRate(0.05, 'USD')).toBe('5¢')
  })
})

describe('pseudo-locale', () => {
  it('accents text and keeps arguments, tags and plurals', () => {
    const intl = createIntl(
      intlConfig('en-XA', { m: pseudoMessage('Call <b>{name}</b>: {n, plural, one {# call} other {# calls}}') }),
    )
    const text = intl.formatMessage({ id: 'm' }, { name: 'Maya', n: 2, b: chunks => `[${chunks.join('')}]` })
    expect(text).toMatch(/^⟦Çá+ļļ \[Maya\]: 2 çá+ļļš⟧$/)
  })
})

describe('languageLabel', () => {
  it('names a language in its own words, then in the UI language', () => {
    expect(languageLabel('es', 'en')).toBe('Español · Spanish')
    expect(languageLabel('es', 'de')).toBe('Español · Spanisch')
    expect(languageLabel('es', 'ja')).toBe('Español · スペイン語')
    expect(languageLabel('ja', 'de')).toBe('日本語 · Japanisch')
  })
  it('shows a name once when both are the same', () => {
    expect(languageLabel('en', 'en')).toBe('English')
    expect(languageLabel('de', 'de')).toBe('Deutsch')
    expect(languageLabel('ja', 'ja')).toBe('日本語')
    expect(languageLabel('en', 'en-XA')).toBe('English')
  })
  it('names Portuguese without the region, for the UI language (pt-BR) as for the voice language (pt)', () => {
    expect(languageLabel('pt-BR', 'en')).toBe('Português · Portuguese')
    expect(languageLabel('pt-BR', 'de')).toBe('Português · Portugiesisch')
    expect(languageLabel('pt-BR', 'pt-BR')).toBe('Português')
    expect(languageLabel('pt', 'en')).toBe('Português · Portuguese')
    expect(languageLabel('pt', 'de')).toBe('Português · Portugiesisch')
  })
  it('capitalizes names that are lowercase in the language', () => {
    expect(languageLabel('it', 'fr')).toBe('Italiano · Italien')
    expect(languageLabel('fr', 'es')).toBe('Français · Francés')
  })
  it('falls back to the code for an unknown language', () => {
    expect(languageLabel('zz', 'en')).toBe('zz')
  })
})
