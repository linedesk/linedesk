import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { TimeZoneOptionBody } from '../settings/TimeZonePicker.tsx'
import { PhoneCountryOptionBody } from './PhoneInput.tsx'
import type { PhoneCountryOption } from './phoneInputModel.ts'
import { SearchOptionBody } from './SearchSelect.tsx'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const controls = read('./controls.css')
const searchSelect = read('./search-select.css')
const phone = read('./phone-input.css')
const timeZone = read('../settings/assistant.css')
/** The body of the first rule with exactly this selector. */
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}
/** The option's text part may shrink in its row, so a long label wraps there instead of being cut. */
const shrinksWithoutClipping = (body: string) => {
  expect(body).toMatch(/min-width:\s*0/)
  expect(body).not.toMatch(/overflow:\s*hidden/)
  expect(body).not.toMatch(/text-overflow:\s*ellipsis/)
}
const checkColumn = '<span class="k-select-opt-check" aria-hidden="true">'

test('the wrapping label rule shows the whole label', () => {
  const label = rule(controls, '.k-select-opt-t > .k-select-opt-l')
  expect(label).toMatch(/white-space:\s*normal/)
  expect(label).toMatch(/overflow:\s*visible/)
  expect(label).not.toMatch(/text-overflow:\s*ellipsis/)
})

test('a country (SearchSelect) shows its whole name in a wrapping label, with its code and the check mark column', () => {
  const long = { value: 'IO', label: 'British Indian Ocean Territory', icon: '🇮🇴', meta: 'IO' }
  const picked = renderToStaticMarkup(<SearchOptionBody option={long} selected />)
  const other = renderToStaticMarkup(<SearchOptionBody option={{ value: 'DE', label: 'Germany' }} selected={false} />)
  expect(picked).toContain(`<span class="k-select-opt-l">${long.label}</span>`)
  expect(picked).toContain('<span class="k-ssel-meta">IO</span>')
  expect(picked).toMatch(/k-select-opt-check[^>]*><svg/)
  expect(other).toContain(`${checkColumn}</span>`)
  shrinksWithoutClipping(rule(searchSelect, '.k-ssel-options .k-select-opt-t'))
})

test('a time zone shows its whole name in a wrapping label, with its offset, time and the check mark column', () => {
  const zone = { value: 'America/Indiana/Indianapolis', label: 'Indianapolis · Eastern Time (Indiana)' }
  const out = renderToStaticMarkup(
    <TimeZoneOptionBody option={zone} selected={false} now={Date.UTC(2026, 0, 15, 12)} />,
  )
  expect(out).toContain(`<span class="k-select-opt-l">${zone.label}</span>`)
  expect(out).toMatch(/<span class="tz-meta">GMT-5 · /)
  expect(out).toContain(`${checkColumn}</span>`)
  shrinksWithoutClipping(rule(timeZone, '.tz-options .k-select-opt-t'))
})

test("a phone field's country shows its whole name, which wraps, with its calling code and the check mark column", () => {
  const country: PhoneCountryOption = {
    value: 'IO',
    name: 'British Indian Ocean Territory',
    flag: '🇮🇴',
    callingCode: '246',
  }
  const out = renderToStaticMarkup(<PhoneCountryOptionBody option={country} selected />)
  expect(out).toContain(`<span class="k-phone-opt-name">${country.name}</span>`)
  expect(out).toContain('<span class="k-phone-opt-code">+246</span>')
  expect(out).toMatch(/k-select-opt-check[^>]*><svg/)
  const name = rule(phone, '.k-phone-opt-name')
  shrinksWithoutClipping(name)
  expect(name).toMatch(/white-space:\s*normal/)
})
