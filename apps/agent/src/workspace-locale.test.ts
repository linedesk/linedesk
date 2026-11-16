// The workspace's country and language on a call: phone numbers read as written there, the greeting and summary in
// its language, and a US workspace exactly as before.
import type { Assistant } from '@linedesk/db/types'
import { describe, expect, test } from 'vitest'
import { withWorkspaceLanguage } from './call-session.ts'
import { phoneNumbersIn } from './callback-number.ts'
import {
  isWholePhoneNumber,
  partialPhoneNumberIn,
  phoneCollector,
  readBackPhone,
  toE164,
} from './collect/collectors.ts'
import { spokenDigits } from './collect/spoken.ts'
import { collectLanguageRule, languageInstructions } from './prompt.ts'
import { summarySystem } from './summary.ts'

const ok = (value: string) => ({ ok: true, value })

describe('phone numbers in the workspace country', () => {
  test('US: unchanged, 10 digits, read back in 3-3-4', () => {
    expect(toE164('five oh three five five five oh one four two', 'US')).toEqual(ok('+15035550142'))
    expect(toE164('(503) 555-0142', 'US')).toEqual(ok('+15035550142'))
    expect(toE164('1 503 555 0142', 'US')).toEqual(ok('+15035550142'))
    expect(toE164('+44 20 7946 0958', 'US')).toEqual(ok('+442079460958'))
    expect(toE164('103 555 0142', 'US')).toEqual({
      ok: false,
      problem: 'That is not a valid US number (area code or exchange). Ask again.',
    })
    expect(toE164('0151 2345 6789', 'US').ok).toBe(false)
    expect(phoneCollector('callback number', 'US').readBack('+15035550142')).toBe('5 0 3, 5 5 5, 0 1 4 2')
    expect(phoneCollector('callback number', 'US').instructions).toBe(phoneCollector().instructions)
    expect(readBackPhone('+442079460958', 'US')).toBe('plus 4 4 2 0 7 9 4 6 0 9 5 8')
  })

  test('German words for digits, and national numbers with the leading 0', () => {
    expect(toE164('0151 2345 6789', 'DE')).toEqual(ok('+4915123456789'))
    expect(toE164('030 1234567', 'DE')).toEqual(ok('+49301234567'))
    expect(toE164('null eins fünf eins, zwei drei vier fünf, sechs sieben acht neun', 'DE')).toEqual(
      ok('+4915123456789'),
    )
    expect(toE164('0049 151 23456789', 'DE')).toEqual(ok('+4915123456789'))
    expect(toE164('+1 503 555 0142', 'DE')).toEqual(ok('+15035550142'))
    expect(toE164('0151', 'DE')).toMatchObject({ ok: false, problem: expect.stringMatching(/Only 4 digits/) })
    expect(readBackPhone('+4915123456789', 'DE')).toBe('0 1 5 1 2, 3 4 5, 6 7 8 9')
    expect(readBackPhone('+15035550142', 'DE')).toBe('+ 1, 5 0 3, 5 5 5, 0 1 4 2')
    expect(phoneCollector('callback number', 'DE').instructions).toMatch(/Germany.*leading 0/)
  })

  test('Mexico: 55 1234 5678, as digits or in Spanish words', () => {
    expect(toE164('55 1234 5678', 'MX')).toEqual(ok('+525512345678'))
    expect(toE164('cinco cinco, uno dos tres cuatro, cinco seis siete ocho', 'MX')).toEqual(ok('+525512345678'))
    expect(toE164('+1 503 555 0142', 'MX')).toEqual(ok('+15035550142'))
    expect(readBackPhone('+525512345678', 'MX')).toBe('5 5, 1 2 3 4, 5 6 7 8')
    expect(readBackPhone('+15035550142', 'MX')).toBe('+ 1, 5 0 3, 5 5 5, 0 1 4 2')
  })

  test('Japan: 03-1234-5678 and 090 mobiles', () => {
    expect(toE164('03-1234-5678', 'JP')).toEqual(ok('+81312345678'))
    expect(toE164('090 1234 5678', 'JP')).toEqual(ok('+819012345678'))
    expect(readBackPhone('+81312345678', 'JP')).toBe('0 3, 1 2 3 4, 5 6 7 8')
  })

  test('Korea: 010-1234-5678, also in Korean digits', () => {
    expect(toE164('010-1234-5678', 'KR')).toEqual(ok('+821012345678'))
    expect(toE164('공일공 일이삼사 오육칠팔', 'KR')).toEqual(ok('+821012345678'))
    expect(spokenDigits('공일공 일이삼사 오육칠팔')).toBe('01012345678')
    expect(readBackPhone('+821012345678', 'KR')).toBe('0 1 0, 1 2 3 4, 5 6 7 8')
  })

  test('United Kingdom: 07400 123456 and 020 7946 0958', () => {
    expect(toE164('07400 123456', 'GB')).toEqual(ok('+447400123456'))
    expect(toE164('oh two oh, seven nine four six, oh nine five eight', 'GB')).toEqual(ok('+442079460958'))
    expect(readBackPhone('+442079460958', 'GB')).toBe('0 2 0, 7 9 4 6, 0 9 5 8')
  })

  test('whole and partial numbers in messages follow the country', () => {
    expect(isWholePhoneNumber('0151 2345 6789', 'DE')).toBe(true)
    expect(isWholePhoneNumber('0151 2345 6789')).toBe(false)
    expect(partialPhoneNumberIn('Rückruf an 0151 2345 6789 bitte', 'DE')).toBeNull()
    expect(partialPhoneNumberIn('Call back on 0151 234', 'DE')).toBe('0151 234')
    expect(phoneNumbersIn('Rückruf an 0151 2345 6789', 'DE')).toEqual(['+4915123456789'])
  })
})

describe('the workspace language on a call', () => {
  const assistant = (languages: Assistant['languages']) =>
    ({ id: 'a', greeting: 'Hi', languages }) as unknown as Assistant

  test('an assistant without a main language speaks the workspace language, when calls can be answered in it', () => {
    expect(withWorkspaceLanguage(assistant({ mode: 'english', allowed: [] }), 'de')?.languages).toEqual({
      mode: 'english',
      allowed: [],
      main: 'de',
    })
    // Its own main language wins; English and a language calls can't be answered in change nothing.
    const own = assistant({ main: 'en', mode: 'english', allowed: [] })
    expect(withWorkspaceLanguage(own, 'de')).toBe(own)
    const plain = assistant({ mode: 'english', allowed: [] })
    expect(withWorkspaceLanguage(plain, 'en')).toBe(plain)
    expect(withWorkspaceLanguage(plain, 'he')).toBe(plain)
    expect(withWorkspaceLanguage(plain, undefined)).toBe(plain)
  })

  test('prompts: US unchanged; the workspace language for messages and summaries otherwise', () => {
    const english = assistant({ mode: 'english', allowed: [] })
    expect(languageInstructions(english)).toBe(languageInstructions(english, 'en'))
    expect(languageInstructions(english)).not.toMatch(/write the messages/)
    expect(collectLanguageRule(english)).toBeNull()
    const german = withWorkspaceLanguage(english, 'de')
    expect(languageInstructions(german, 'de')).toMatch(/^Speak German only\..*in German, so the owner/)
    expect(collectLanguageRule(german)).toMatch(/^Speak German\./)
    // A Hebrew workspace: calls in English, messages in Hebrew.
    expect(languageInstructions(english, 'he')).toMatch(/Speak English only\..*in Hebrew, so the owner/)
  })

  test('the summary is in the workspace language; English as before', () => {
    expect(summarySystem()).toBe(summarySystem('en'))
    expect(summarySystem('en')).toMatch(
      /Write the title, summary and action items in English, also when the call was in another language\. When it was not in English, begin the summary with "Call in <language>\."/,
    )
    expect(summarySystem('de')).toMatch(/action items in German \(language code "de"\)/)
    expect(summarySystem('ko')).toMatch(/in Korean/)
  })
})
