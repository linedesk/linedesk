import { describe, expect, test } from 'vitest'
import { mainLanguageOf, otherLanguagesOf } from './languages.ts'
import { phoneFromDigits, phoneGroups } from './phone-input.ts'
import { callRules, EMERGENCY_RULE, fixedRules } from './assistant-prompt.ts'
import { workspaceUpdateSettings } from './settings.ts'
import { TIME_ZONES_BY_COUNTRY } from './time-zone-countries.ts'
import {
  automaticCountryLabel,
  COUNTRY_LANGUAGES,
  countryHintOf,
  countryNamed,
  countryOfTimeZone,
  defaultPhoneCountry,
  currencyOfCountry,
  emergencyNumberOf,
  isVoiceLanguage,
  MAIN_TIME_ZONES,
  mainTimeZoneOf,
  resolveWorkspaceCountry,
  resolveWorkspaceLanguage,
  timeZoneInCountry,
  voiceLanguageOf,
  workspaceCountryOf,
  workspaceTimeZoneFor,
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

  test('after the holidays: the hint saved when the workspace was made, then US', () => {
    const hint = { country: 'DE', source: 'sign_up_location' }
    // A German business made in Madrid's time zone: Germany, from where it was made.
    expect(workspaceCountryOf({ hint })).toEqual({
      country: 'DE',
      source: 'sign_up_location',
    })
    expect(workspaceCountryOf({ holidayCountry: 'AT', hint })).toEqual({
      country: 'AT',
      source: 'holidays',
    })
    expect(workspaceCountryOf({ hint: { country: 'FR', source: 'browser_language' } })).toEqual({
      country: 'FR',
      source: 'browser_language',
    })
    expect(workspaceCountryOf({ hint: null })).toEqual({ country: 'US', source: 'default' })
    // A hint with an unknown source or country counts for nothing.
    expect(workspaceCountryOf({ hint: { country: 'DE', source: 'guess' } })).toEqual({
      country: 'US',
      source: 'default',
    })
    expect(workspaceCountryOf({ hint: { country: 'XX', source: 'time_zone' } }).source).toBe('default')
  })

  test('an existing US workspace stays US and English', () => {
    const country = resolveWorkspaceCountry({ assistantNumbers: ['+15035550142'] })
    expect(country).toBe('US')
    expect(resolveWorkspaceLanguage({ country })).toBe('en')
    expect(currencyOfCountry(country)).toBe('USD')
  })
})

describe('resolveWorkspaceLanguage', () => {
  test("the country's main language, else English", () => {
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
    expect(workspaceCountryOf({ assistantNumbers: ['+17875550100'] })).toEqual({
      country: 'PR',
      source: 'assistant_number',
    })
    expect(workspaceCountryOf({ assistantNumbers: ['+19395550100'] })).toEqual({
      country: 'PR',
      source: 'assistant_number',
    })
    expect(workspaceCountryOf({ assistantNumbers: ['+14165550100'] })).toEqual({
      country: 'CA',
      source: 'assistant_number',
    })
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
    expect(mainLanguageOf({ mode: 'english', allowed: [] }, 'pl')).toBe('pl')
    // Korean is hidden (HIDDEN_LANGUAGES): never a default until its test calls pass.
    expect(mainLanguageOf({ mode: 'english', allowed: [] }, 'ko')).toBe('en')
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

test('workspace.updateSettings takes a country code, or null; the removed language is not taken', () => {
  const parse = (input: object) => workspaceUpdateSettings.input.safeParse(input)
  expect(parse({ country: 'de' }).data).toEqual({ country: 'DE' })
  expect(parse({ country: null }).data).toEqual({ country: null })
  expect(parse({ country: 'XX' }).success).toBe(false)
  expect(parse({ country: 'Germany' }).success).toBe(false)
  // The workspace "Call language" is gone (2026-11-16): a `language` sent anyway is dropped, never saved.
  expect(parse({ country: 'de', language: 'fr' }).data).toEqual({ country: 'DE' })
  expect(parse({ language: 'he' }).data).toEqual({})
})

test('the label of the automatic country says where it came from', () => {
  expect(automaticCountryLabel('US', 'assistant_number')).toBe(
    "Automatic (United States, from your assistant's number)",
  )
  expect(automaticCountryLabel('US', 'default')).toBe('Automatic (United States, nothing else set)')
})

test('the label of a hinted country says where the hint came from', () => {
  expect(automaticCountryLabel('DE', 'sign_up_location')).toBe(
    'Automatic (Germany, from where the workspace was created)',
  )
  expect(automaticCountryLabel('ES', 'time_zone')).toBe('Automatic (Spain, from the time zone it was created in)')
  expect(automaticCountryLabel('AT', 'browser_language')).toBe(
    'Automatic (Austria, from the browser language it was created in)',
  )
})

test('the phone field starts with the country set first', () => {
  expect(defaultPhoneCountry({ country: 'gb', assistantNumbers: ['+15035550142'] })).toBe('GB')
  expect(defaultPhoneCountry({ assistantNumbers: ['+15035550142'], holidayCountry: 'GB' })).toBe('US')
})

test('the phone field follows the workspace order: numbers, business phone, holidays, hint, locale, US', () => {
  expect(defaultPhoneCountry({ assistantNumbers: ['+4930123456'], holidayCountry: 'GB', locale: 'en-US' })).toBe('DE')
  expect(defaultPhoneCountry({ holidayCountry: 'gb', locale: 'de-DE' })).toBe('GB')
  expect(defaultPhoneCountry({ businessPhone: '+61 2 9876 5432', holidayCountry: 'GB', locale: 'de-DE' })).toBe('AU')
  expect(defaultPhoneCountry({ businessPhone: '(503) 555-0142', locale: 'de-DE' })).toBe('DE')
  expect(defaultPhoneCountry({ hint: { country: 'ES', source: 'time_zone' }, locale: 'de-DE' })).toBe('ES')
  expect(defaultPhoneCountry({ hint: { country: 'DE', source: 'sign_up_location' }, locale: 'fr-FR' })).toBe('DE')
  expect(defaultPhoneCountry({ locale: 'de' })).toBe('DE')
  expect(defaultPhoneCountry({ holidayCountry: 'XX', locale: 'nonsense-' })).toBe('US')
  expect(defaultPhoneCountry({})).toBe('US')
})

describe('the country hint', () => {
  test('the time zone names its country, old link names too; UTC and unknown names none', () => {
    expect(countryOfTimeZone('Europe/Madrid')).toBe('ES')
    expect(countryOfTimeZone('Europe/Berlin')).toBe('DE')
    expect(countryOfTimeZone('America/Los_Angeles')).toBe('US')
    expect(countryOfTimeZone('US/Eastern')).toBe('US')
    expect(countryOfTimeZone('Asia/Calcutta')).toBe('IN')
    expect(countryOfTimeZone('Europe/Zurich')).toBe('CH')
    expect(countryOfTimeZone('UTC')).toBeNull()
    expect(countryOfTimeZone('Etc/GMT+2')).toBeNull()
    expect(countryOfTimeZone('Nowhere/Town')).toBeNull()
    expect(countryOfTimeZone(null)).toBeNull()
  })

  test('the sign-up location first, then the time zone, then the browser language', () => {
    const all = { ipCountry: 'de', timeZone: 'Europe/Madrid', locale: 'fr-FR' }
    expect(countryHintOf(all)).toEqual({ country: 'DE', source: 'sign_up_location' })
    expect(countryHintOf({ ...all, ipCountry: null })).toEqual({ country: 'ES', source: 'time_zone' })
    expect(countryHintOf({ ...all, ipCountry: null, timeZone: 'UTC' })).toEqual({
      country: 'FR',
      source: 'browser_language',
    })
    expect(countryHintOf({})).toBeNull()
  })

  test("Cloudflare's unknown (XX) and Tor (T1) are no country", () => {
    expect(countryHintOf({ ipCountry: 'XX', timeZone: 'Europe/Berlin' })?.source).toBe('time_zone')
    expect(countryHintOf({ ipCountry: 'T1' })).toBeNull()
  })
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
      '911',
      '911',
      '911',
      '112',
      '112',
      '112',
      '999',
      '000',
      '111',
    ])
    expect(emergencyNumberOf('JP')).toBe('110 for the police or 119 for fire and an ambulance')
    expect(emergencyNumberOf('KR')).toBe('112 for the police or 119 for fire and an ambulance')
    expect(emergencyNumberOf('PR')).toBe('911')
    expect(emergencyNumberOf('BR')).toBe('the local emergency number')
    expect(emergencyNumberOf(null)).toBe('the local emergency number')
  })

  test('the emergency rule is the same in every country and names no number', () => {
    expect(EMERGENCY_RULE).toBe(
      "A problem that can't wait, even serious damage to property, is urgent: it is for the team, so do not mention the emergency services. Only if the caller says a person is in danger right now (someone hurt, a fire, a break-in happening, a gas smell), tell them at once, before any question, to contact the emergency services now, and keep helping them if they stay on the call.",
    )
    // A fixed rule (A3), not one of the call rules the owner's text wins over.
    expect(fixedRules()).toContain(EMERGENCY_RULE)
    expect(callRules()).not.toContain(EMERGENCY_RULE)
    expect(fixedRules()).not.toMatch(/911|hang up/)
  })
})

describe('countryNamed', () => {
  test('a set country, a number, the business phone or holidays name it; a hint or the US fallback do not', () => {
    for (const source of ['explicit', 'assistant_number', 'business_phone', 'holidays'] as const)
      expect(countryNamed(source)).toBe(true)
    for (const source of ['sign_up_location', 'time_zone', 'browser_language', 'default'] as const)
      expect(countryNamed(source)).toBe(false)
  })
})

describe('the time zone of a new workspace (LIN-433)', () => {
  test('every country with more than one zone has a main zone, and it is one of its own', () => {
    for (const [country, zones] of Object.entries(TIME_ZONES_BY_COUNTRY)) {
      const list = zones.split(' ')
      if (list.length > 1) expect(MAIN_TIME_ZONES[country], country).toBeDefined()
      expect(list, country).toContain(mainTimeZoneOf(country))
    }
    for (const country of Object.keys(MAIN_TIME_ZONES)) expect(TIME_ZONES_BY_COUNTRY[country], country).toBeDefined()
  })

  test('the main zones read as the place most businesses are', () => {
    expect(mainTimeZoneOf('US')).toBe('America/New_York')
    expect(mainTimeZoneOf('ca')).toBe('America/Toronto')
    expect(mainTimeZoneOf('AU')).toBe('Australia/Sydney')
    expect(mainTimeZoneOf('DE')).toBe('Europe/Berlin')
    expect(mainTimeZoneOf('CH')).toBe('Europe/Zurich')
    expect(mainTimeZoneOf('XX')).toBeNull()
    expect(mainTimeZoneOf(null)).toBeNull()
  })

  test('a zone counts for its country, old link names too', () => {
    expect(timeZoneInCountry('America/Chicago', 'US')).toBe(true)
    expect(timeZoneInCountry('US/Pacific', 'us')).toBe(true)
    expect(timeZoneInCountry('Europe/Berlin', 'US')).toBe(false)
    expect(timeZoneInCountry(null, 'US')).toBe(false)
    expect(timeZoneInCountry('Europe/Berlin', null)).toBe(false)
  })

  test("the browser's zone when it is in the country, else the country's main zone", () => {
    expect(workspaceTimeZoneFor('US', 'Europe/Berlin')).toBe('America/New_York')
    expect(workspaceTimeZoneFor('US', 'America/Denver')).toBe('America/Denver')
    expect(workspaceTimeZoneFor('DE', 'America/Chicago')).toBe('Europe/Berlin')
    expect(workspaceTimeZoneFor('CA', 'America/Vancouver')).toBe('America/Vancouver')
    expect(workspaceTimeZoneFor('AU', 'UTC')).toBe('Australia/Sydney')
    expect(workspaceTimeZoneFor('US', null)).toBe('America/New_York')
    // No country, or one the tz database does not know: the zone as given.
    expect(workspaceTimeZoneFor(null, 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(workspaceTimeZoneFor('XX', 'Europe/Berlin')).toBe('Europe/Berlin')
    expect(workspaceTimeZoneFor(null, null)).toBeNull()
  })
})
