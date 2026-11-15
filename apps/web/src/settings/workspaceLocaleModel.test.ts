import { expect, test } from 'vitest'
import { searchOptions } from '../ui/SearchSelect.tsx'
import { AUTOMATIC, countryOptions, languageOptions, searchCountries } from './workspaceLocaleModel.ts'
import { draftOf } from './assistantDraft.ts'
import type { Assistant } from '@linedesk/db/types'

test('the country list starts with Automatic and where it came from, then every country with its flag', () => {
  const options = countryOptions('US', 'assistant_number')
  expect(options[0]).toEqual({ value: AUTOMATIC, label: "Automatic (United States, from your assistant's number)" })
  expect(options[1]).toMatchObject({ value: 'US', label: 'United States', icon: '🇺🇸' })
  expect(options.length).toBeGreaterThan(200)
  expect(searchCountries(options, 'kor').map(o => o.value)).toContain('KR')
  expect(searchCountries(options, 'ca')[0]?.value).toBe('CA')
  expect(searchCountries(options, 'auto')[0]?.value).toBe(AUTOMATIC)
})

test('the language list: Automatic from the country, then the languages calls can be answered in', () => {
  expect(languageOptions('US', 'en')[0]?.label).toBe('Automatic (English, from your country)')
  expect(languageOptions('MX', 'en')[0]?.label).toBe('Automatic (Español · Spanish, from your country)')
  // Korean calls can be answered since LIN-268 (Nova-3); Hebrew still not.
  expect(languageOptions('KR', 'en')[0]?.label).toBe('Automatic (한국어 · Korean, from your country)')
  expect(languageOptions('IL', 'en')[0]?.label).toBe('Automatic (Hebrew summaries; calls in English)')
  const codes = languageOptions('US', 'en').map(o => o.value)
  expect(codes).toContain('es')
  expect(codes).toContain('ko')
  expect(codes).not.toContain('he')
  expect(searchOptions(languageOptions('US', 'en'), 'span').map(o => o.value)).toEqual(['es'])
})

test('each language in its own name and in the UI language, in the same order for every UI language', () => {
  const en = languageOptions('US', 'en')
  const de = languageOptions('US', 'de')
  expect(en.find(o => o.value === 'es')).toMatchObject({ label: 'Español · Spanish', meta: 'es' })
  expect(de.find(o => o.value === 'es')?.label).toBe('Español · Spanisch')
  expect(de.find(o => o.value === 'de')?.label).toBe('Deutsch')
  expect(en.find(o => o.value === 'pt')?.label).toBe('Português · Portuguese')
  expect(de.map(o => o.value)).toEqual(en.map(o => o.value))
  expect(searchOptions(de, 'spanisch').map(o => o.value)).toEqual(['es'])
  expect(searchOptions(de, 'espa').map(o => o.value)).toEqual(['es'])
})

test('an assistant without a main language shows the workspace language, its default greeting in it', () => {
  const base = {
    id: 'a',
    name: 'Maya',
    greeting: '',
    languages: { mode: 'english', allowed: [] },
    business_profile: {},
    voice: { provider: 'elevenlabs', voice_id: 'x' },
    transfers: [],
  } as unknown as Assistant
  expect(draftOf(base).languages.main).toBe('en')
  expect(draftOf(base, 'en').languages.main).toBe('en')
  expect(draftOf(base, 'es').languages.main).toBe('es')
  expect(draftOf(base, 'ko').languages.main).toBe('ko')
  expect(draftOf(base, 'he').languages.main).toBe('en')
  expect(draftOf({ ...base, languages: { main: 'en', mode: 'english', allowed: [] } }, 'es').languages.main).toBe('en')
})

test('Automatic says where a hinted country came from: sign-up location, time zone or browser language', () => {
  expect(countryOptions('DE', 'sign_up_location')[0]?.label).toBe('Automatic (Germany, from where the workspace was created)')
  expect(countryOptions('ES', 'time_zone')[0]?.label).toBe('Automatic (Spain, from the time zone it was created in)')
  expect(countryOptions('AT', 'browser_language')[0]?.label).toBe('Automatic (Austria, from the browser language it was created in)')
})
