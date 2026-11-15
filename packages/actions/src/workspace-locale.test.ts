import { describe, expect, test } from 'vitest'
import { mainLanguageOf, otherLanguagesOf } from './languages.ts'
import { defaultPhoneCountry, phoneFromDigits, phoneGroups } from './phone-input.ts'
import { callRules, EMERGENCY_RULE, emergencyRule } from './assistant-prompt.ts'
import { workspaceUpdateSettings } from './settings.ts'
import {
  automaticCountryLabel,
  COUNTRY_LANGUAGES,
  currencyOfCountry,
  emergencyNumberOf,
  isVoiceLanguage,
  resolveWorkspaceCountry,
  resolveWorkspaceLanguage,
  voiceLanguageOf,
  workspaceCountryOf,
} from './workspace-locale.ts'
import { jobValueCurrencies } from './insights.ts'

describe('resolveWorkspaceCountry', () => {
  test('the country set wins, then the assistant number, the business phone, the holidays, else US', () => {
    const all = {
      country: 'ca',
      assistantNumbers: ['+442079460958', '+15035550142'],
      businessPhone: '+821012345678',
      holidayCountry: 'FR',
    }
    expect(resolveWorkspaceCountry(all)).toBe('CA')
    expect(resolveWorkspaceCountry({ ...all, country: null })).toBe('GB')
    expect(resolveWorkspaceCountry({ ...all, country: null, assistantNumbers: [] })).toBe('KR')
    expect(resolveWorkspaceCountry({ businessPhone: '(503) 555-0142', holidayCountry: 'gb' })).toBe('GB')
    expect(resolveWorkspaceCountry({})).toBe('US')
    expect(workspaceCountryOf({})).toEqual({ country: 'US', source: 'default' })
    expect(workspaceCountryOf({ assistantNumbers: ['+15035550142'] })).toEqual({
      country: 'US',
      source: 'assistant_number',
    })
    // An unknown code is not a country.
    expect(resolveWorkspaceCountry({ country: 'XX' })).toBe('US')
  })

  test('an existing US workspace stays US and English', () => {
    const country = resolveWorkspaceCountry({ assistantNumbers: ['+15035550142'] })
    expect(country).toBe('US')
    expect(resolveWorkspaceLanguage({ country })).toBe('en')
    expect(currencyOfCountry(country)).toBe('USD')
  })
})

describe('resolveWorkspaceLanguage', () => {
  test('the language set, else the country main language, else English', () => {
    expect(resolveWorkspaceLanguage({ language: 'fr', country: 'MX' })).toBe('fr')
    const table: Record<string, string> = {
      US: 'en',
      GB: 'en',
      CA: 'en',
      AU: 'en',
      NZ: 'en',
      IE: 'en',
      IN: 'en',
      SG: 'en',
      ZA: 'en',
      PH: 'en',
      DE: 'de',
      AT: 'de',
      CH: 'de',
      FR: 'fr',
      BE: 'fr',
      LU: 'fr',
      ES: 'es',
      MX: 'es',
      AR: 'es',
      CL: 'es',
      CO: 'es',
      IT: 'it',
      PT: 'pt',
      BR: 'pt',
      NL: 'nl',
      SE: 'sv',
      NO: 'no',
      PR: 'es',
      DK: 'da',
      FI: 'fi',
      PL: 'pl',
      JP: 'ja',
      KR: 'ko',
      AE: 'ar',
      IL: 'he',
    }
    for (const [country, language] of Object.entries(table)) {
      expect(resolveWorkspaceLanguage({ country }), country).toBe(language)
    }
    expect(resolveWorkspaceLanguage({ country: 'TH' })).toBe('en')
  })

  test("every country's main language is one calls are answered in, or English stands in for it", () => {
    // Norway was 'nb', which the voice pipeline does not know: Norwegian workspaces got English calls.
    expect(voiceLanguageOf(resolveWorkspaceLanguage({ country: 'NO' }))).toBe('no')
    expect(voiceLanguageOf(resolveWorkspaceLanguage({ country: 'PR' }))).toBe('es')
    expect(voiceLanguageOf(resolveWorkspaceLanguage({ country: 'CA' }))).toBe('en')
    // Only Hebrew is not spoken yet (Israel gets English calls, on purpose); a typo like 'nb' would show up here.
    const unspoken = Object.entries(COUNTRY_LANGUAGES).filter(([, language]) => !isVoiceLanguage(language))
    expect(unspoken).toEqual([['IL', 'he']])
  })

  test('Canada and Puerto Rico are worked out from their numbers: Puerto Rico is not the US', () => {
    expect(workspaceCountryOf({ assistantNumbers: ['+17875550100'] })).toEqual({ country: 'PR', source: 'assistant_number' })
    expect(workspaceCountryOf({ assistantNumbers: ['+19395550100'] })).toEqual({ country: 'PR', source: 'assistant_number' })
    expect(workspaceCountryOf({ assistantNumbers: ['+14165550100'] })).toEqual({ country: 'CA', source: 'assistant_number' })
    expect(currencyOfCountry('CA')).toBe('CAD')
  })

  test('calls are answered in it when the voice pipeline speaks it, else in English', () => {
    expect(voiceLanguageOf('de')).toBe('de')
    expect(voiceLanguageOf('ko')).toBe('ko') // Nova-3, since LIN-268
    expect(voiceLanguageOf('he')).toBe('en')
    expect(voiceLanguageOf(null)).toBe('en')
  })

  test('an assistant without a main language follows the workspace language', () => {
    expect(mainLanguageOf({ mode: 'english', allowed: [] }, 'de')).toBe('de')
    expect(mainLanguageOf({ mode: 'english', allowed: [] }, 'ko')).toBe('ko')
    expect(mainLanguageOf({ mode: 'english', allowed: [] }, 'he')).toBe('en')
    expect(mainLanguageOf({ main: 'en', mode: 'english', allowed: [] }, 'de')).toBe('en')
    expect(mainLanguageOf({ mode: 'english', allowed: [] })).toBe('en')
    expect(otherLanguagesOf({ mode: 'allowed', allowed: ['de', 'es'] }, 'de')).toEqual(['es'])
  })
})

test('the currency of a country, for every offered currency', () => {
  expect(currencyOfCountry('DE')).toBe('EUR')
  expect(currencyOfCountry('kr')).toBe('KRW')
  expect(currencyOfCountry('GB')).toBe('GBP')
  expect(currencyOfCountry('VN')).toBeNull()
  const covered = new Set(
    ['US', 'AE', 'AR', 'AU', 'BR', 'CA', 'CH', 'CL', 'CN', 'CO', 'CZ', 'DK', 'EG', 'DE', 'GB', 'HK', 'HU', 'ID', 'IL']
      .concat(['IN', 'JP', 'KE', 'KR', 'MX', 'MY', 'NG', 'NO', 'NZ', 'PE', 'PH', 'PL', 'RO', 'SA', 'SE', 'SG', 'TH'])
      .concat(['TR', 'TW', 'ZA'])
      .map(currencyOfCountry),
  )
  expect([...covered].sort()).toEqual([...jobValueCurrencies].sort())
})

test('workspace.updateSettings takes a country code and a supported language, or null', () => {
  const parse = (input: object) => workspaceUpdateSettings.input.safeParse(input)
  expect(parse({ country: 'de' }).data).toEqual({ country: 'DE' })
  expect(parse({ country: null, language: null }).success).toBe(true)
  expect(parse({ language: 'de' }).success).toBe(true)
  expect(parse({ country: 'XX' }).success).toBe(false)
  expect(parse({ country: 'Germany' }).success).toBe(false)
  expect(parse({ language: 'ko' }).success).toBe(true)
  // Hebrew is not a language calls can be answered in yet.
  expect(parse({ language: 'he' }).success).toBe(false)
  expect(parse({ language: 'de-DE' }).success).toBe(false)
})

test('the label of the automatic country says where it came from', () => {
  expect(automaticCountryLabel('US', 'assistant_number')).toBe(
    "Automatic (United States, from your assistant's number)",
  )
  expect(automaticCountryLabel('US', 'default')).toBe('Automatic (United States, nothing else set)')
})

test('the phone field starts with the country set first', () => {
  expect(defaultPhoneCountry({ country: 'gb', assistantNumber: '+15035550142' })).toBe('GB')
  expect(defaultPhoneCountry({ assistantNumber: '+15035550142', workspaceCountry: 'GB' })).toBe('US')
})

describe('phone numbers from spoken digits', () => {
  test('national numbers in the workspace country, + numbers from anywhere', () => {
    expect(phoneFromDigits('5512345678', 'MX')).toEqual({ ok: true, e164: '+525512345678' })
    expect(phoneFromDigits('0312345678', 'JP')).toEqual({ ok: true, e164: '+81312345678' })
    expect(phoneFromDigits('01012345678', 'KR')).toEqual({ ok: true, e164: '+821012345678' })
    expect(phoneFromDigits('07400123456', 'GB')).toEqual({ ok: true, e164: '+447400123456' })
    expect(phoneFromDigits('+15035550142', 'GB')).toEqual({ ok: true, e164: '+15035550142' })
    expect(phoneFromDigits('00525512345678', 'GB')).toEqual({ ok: true, e164: '+525512345678' })
    expect(phoneFromDigits('0740', 'GB')).toMatchObject({ ok: false, problem: 'too_short' })
  })

  test('read back in the groups the country writes', () => {
    expect(phoneGroups('+447400123456', 'GB')).toEqual(['07400', '123', '456'])
    expect(phoneGroups('+15035550142', 'US')).toEqual(['(503)', '555', '0142'].map(g => g.replace(/[()]/g, '')))
    expect(phoneGroups('+821012345678', 'KR')).toEqual(['010', '1234', '5678'])
    expect(phoneGroups('+442079460958', 'MX')).toEqual(['+44', '20', '7946', '0958'])
    // No group is longer than five digits.
    for (const e164 of ['+447400123456', '+525512345678', '+33612345678']) {
      expect(phoneGroups(e164, 'JP').every(g => g.replace('+', '').length <= 5)).toBe(true)
    }
  })
})

describe('the emergency number of the workspace country', () => {
  test('911 in North America, 112 in the EU, 999 in the UK, 000 in Australia, the local number elsewhere', () => {
    expect(['US', 'CA', 'MX', 'FR', 'IE', 'CH', 'GB', 'AU', 'NZ'].map(emergencyNumberOf)).toEqual([
      '911', '911', '911', '112', '112', '112', '999', '000', '111',
    ])
    expect(emergencyNumberOf('JP')).toBe('110 for the police or 119 for fire and an ambulance')
    expect(emergencyNumberOf('KR')).toBe('112 for the police or 119 for fire and an ambulance')
    expect(emergencyNumberOf('PR')).toBe('911')
    expect(emergencyNumberOf('BR')).toBe('the local emergency number')
    expect(emergencyNumberOf(null)).toBe('the local emergency number')
  })

  test("a US workspace's rule is unchanged; others name their own number", () => {
    expect(EMERGENCY_RULE).toBe(
      'Only when someone is in danger (a person hurt or at risk, a fire, a break-in, a gas smell): tell the caller to hang up and call 911 right away, before anything else. Never send anything else to 911, even when the caller says it is an emergency: damage to a home, a car or equipment is urgent, not a call for 911, so flag the call as urgent and take a message.',
    )
    expect(emergencyRule()).toBe(EMERGENCY_RULE)
    expect(callRules()).toContain(EMERGENCY_RULE)
    expect(callRules({ country: 'GB' })).toContain('hang up and call 999 right away')
    expect(callRules({ country: 'GB' })).not.toContain('911')
    expect(callRules({ country: 'AU' })).toContain('call 000 right away')
    expect(callRules({ country: 'BR' })).toContain('call the local emergency number right away')
  })
})
