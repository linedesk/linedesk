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
  expect(languageOptions('US')[0]?.label).toBe('Automatic (English, from your country)')
  expect(languageOptions('MX')[0]?.label).toBe('Automatic (Spanish, from your country)')
  expect(languageOptions('KR')[0]?.label).toBe('Automatic (Korean summaries; calls in English)')
  const codes = languageOptions('US').map(o => o.value)
  expect(codes).toContain('es')
  expect(codes).not.toContain('ko')
  expect(searchOptions(languageOptions('US'), 'span').map(o => o.value)).toEqual(['es'])
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
  expect(draftOf(base, 'ko').languages.main).toBe('en')
  expect(draftOf({ ...base, languages: { main: 'en', mode: 'english', allowed: [] } }, 'es').languages.main).toBe('en')
})
