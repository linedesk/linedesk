import { expect, test } from 'vitest'
import { AUTOMATIC, countryOptions, searchCountries } from './workspaceLocaleModel.ts'
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

test("an assistant without a main language shows its workspace country's language, its default greeting in it", () => {
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
  expect(draftOf(base, 'pl').languages.main).toBe('pl')
  // Korean is hidden (HIDDEN_LANGUAGES): not a default either, until its test calls pass.
  expect(draftOf(base, 'ko').languages.main).toBe('en')
  expect(draftOf(base, 'he').languages.main).toBe('en')
  expect(draftOf({ ...base, languages: { main: 'en', mode: 'english', allowed: [] } }, 'es').languages.main).toBe('en')
})

test('Automatic says where a hinted country came from: sign-up location, time zone or browser language', () => {
  expect(countryOptions('DE', 'sign_up_location')[0]?.label).toBe(
    'Automatic (Germany, from where the workspace was created)',
  )
  expect(countryOptions('ES', 'time_zone')[0]?.label).toBe('Automatic (Spain, from the time zone it was created in)')
  expect(countryOptions('AT', 'browser_language')[0]?.label).toBe(
    'Automatic (Austria, from the browser language it was created in)',
  )
})
