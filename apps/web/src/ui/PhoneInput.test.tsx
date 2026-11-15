import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { FormField } from './form.tsx'
import { PhoneInput } from './PhoneInput.tsx'

const html = (value: string, defaultCountry = 'US') =>
  renderToStaticMarkup(
    <FormField id="ph" label="Phone" error={null}>
      <PhoneInput id="ph" value={value} defaultCountry={defaultCountry} onChange={() => {}} />
    </FormField>,
  )

test('a saved number shows in its own country: flag and calling code on the button, the number formatted', () => {
  const out = html('+4930123456')
  expect(out).toContain('aria-label="Country code: Germany +49"')
  expect(out).toContain('🇩🇪')
  expect(out).toContain('value="030 123456"')
})

test('an empty field starts in the default country, with an example number of it', () => {
  const out = html('', 'GB')
  expect(out).toContain('aria-label="Country code: United Kingdom +44"')
  expect(out).toMatch(/placeholder="0\d{4} \d{6}"/)
})

test('the label points at the number field, a phone keyboard and the list behind the button', () => {
  const out = html('+15035550142')
  expect(out).toContain('<label for="ph">Phone</label>')
  expect(out).toMatch(/<input[^>]*id="ph"[^>]*type="tel"[^>]*inputMode="tel"/)
  expect(out).toContain('value="(503) 555-0142"')
  expect(out).toContain('aria-haspopup="listbox"')
  expect(out).toContain('aria-expanded="false"')
})

test('a list of suggestions under the field makes the number field its combobox', () => {
  const out = renderToStaticMarkup(
    <PhoneInput
      id="cn"
      value=""
      defaultCountry="US"
      onChange={() => {}}
      combobox={{ role: 'combobox', 'aria-expanded': true, 'aria-controls': 'list', 'aria-autocomplete': 'list' }}
    />,
  )
  expect(out).toMatch(/<input[^>]*role="combobox"[^>]*aria-expanded="true"[^>]*aria-controls="list"/)
  expect(out).toMatch(/<input[^>]*id="cn"[^>]*type="tel"/)
})
