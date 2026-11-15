import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { loadCountryHint, phoneCountryFrom } from './countryHint.ts'
import { i18n } from './i18n/index.tsx'
import { CountrySelect } from './settings/CountrySelect.tsx'
import { AUTOMATIC } from './settings/workspaceLocaleModel.ts'
import { createWorkspace } from './auth.ts'
import { localeToSave } from './onboarding/BusinessStep.tsx'

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

describe('the country New workspace starts with', () => {
  test("the API's hint, with the sign-up location it alone knows", async () => {
    const hint = { country: 'DE', source: 'sign_up_location' }
    expect(await loadCountryHint(answer({ ok: true, hint }))).toEqual(hint)
  })

  test("without the API's answer, the browser's own hint (time zone, language), never an error", async () => {
    const local = await loadCountryHint(answer({ ok: false }, 500))
    const offline = await loadCountryHint((async () => {
      throw new Error('offline')
    }) as typeof fetch)
    expect(offline).toEqual(local)
    expect(local === null || ['time_zone', 'browser_language'].includes(local.source)).toBe(true)
  })

  test('the field has the label and placeholder of Workspace settings › General, and no Automatic', () => {
    const html = renderToStaticMarkup(<CountrySelect id="c" value="" onChange={() => {}} />)
    expect(html).toContain(i18n().t('settings.general.country.label'))
    expect(html).toContain(i18n().t('settings.general.country.choose'))
    expect(html).not.toContain('Automatic')
    const set = renderToStaticMarkup(<CountrySelect id="c" value="DE" onChange={() => {}} />)
    expect(set).toContain('Germany')
  })

  test('Workspace settings keeps Automatic, saying what it stands for', () => {
    const html = renderToStaticMarkup(
      <CountrySelect id="c" value="" automatic={{ country: 'ES', source: 'time_zone' }} onChange={() => {}} />,
    )
    expect(html).toContain('Automatic (Spain, from the time zone it was created in)')
  })
})

describe('the phone field and onboarding start with the country the API works out', () => {
  const local = { assistantNumber: null, businessPhone: null, timeZone: 'Europe/Madrid', locale: 'de-DE' }

  test('once the settings have loaded: their resolved country, whatever the browser says', () => {
    expect(phoneCountryFrom({ resolvedCountry: 'DE' }, local)).toBe('DE')
  })

  test('before: the same order on what the browser has (numbers, business phone, time zone, language)', () => {
    expect(phoneCountryFrom(null, local)).toBe('ES')
    expect(phoneCountryFrom(null, { ...local, businessPhone: '+43 1 234567' })).toBe('AT')
    expect(phoneCountryFrom(null, { ...local, assistantNumber: '+15035550142', businessPhone: '+43 1 234567' })).toBe(
      'US',
    )
    expect(phoneCountryFrom(undefined, { ...local, timeZone: 'UTC' })).toBe('DE')
    expect(phoneCountryFrom(undefined, { ...local, timeZone: null, locale: null })).toBe('US')
  })
})

describe('a prefilled country left as it is is not saved as set (it stays Automatic on the hint)', () => {
  test('New workspace sends the country only when picked; the time zone and language always go along', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    try {
      await createWorkspace('Left As Shown', null)
      await createWorkspace('Picked', 'ES')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(bodies[0]).not.toHaveProperty('country')
    expect(bodies[0]).toHaveProperty('timeZone')
    expect(bodies[1]).toMatchObject({ name: 'Picked', country: 'ES' })
  })

  test("onboarding's Business step saves the country only after Change", () => {
    expect(localeToSave(null, null, null)).toEqual({})
    expect(localeToSave('ES', null, null)).toEqual({ country: 'ES' })
    expect(localeToSave('ES', null, 'ES')).toEqual({})
    expect(localeToSave(null, AUTOMATIC, null)).toEqual({ language: null })
    expect(localeToSave(null, 'de', null)).toEqual({ language: 'de' })
  })

  test("before the settings load, the phone field uses this browser's own hint in the same order", () => {
    const local = { assistantNumber: null, businessPhone: null, timeZone: 'Europe/Madrid', locale: 'de-DE' }
    expect(phoneCountryFrom(undefined, local)).toBe('ES')
    expect(phoneCountryFrom(undefined, { ...local, assistantNumber: '+15035550142' })).toBe('US')
  })
})
