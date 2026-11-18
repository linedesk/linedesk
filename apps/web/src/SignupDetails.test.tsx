// The sign-up page's last step (Signup.tsx DetailsStep, docs/billing.md §3.2): only the person's name, the terms
// and Create account; the business's name and country come in the onboarding's Business step. A partner also gives
// its company's name.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { DetailsStep } from './Signup.tsx'

const terms = {
  termsUrl: 'https://desk.example.com/terms',
  termsVersion: '2026-11-17',
  privacyUrl: 'https://desk.example.com/privacy',
  privacyVersion: '2026-11-10',
}
const page = (partner: boolean, fromApp?: { onBack: () => void }) =>
  renderToStaticMarkup(
    <DetailsStep
      interval="year"
      partner={partner}
      terms={terms}
      planNow={null}
      fromApp={fromApp}
      onTermsChanged={() => {}}
      onDone={() => {}}
    />,
  )
const fields = (html: string) => html.match(/<input/g)?.length ?? 0

test('a business: the name, the terms and Create account; no business name, no country', () => {
  const html = page(false)
  expect(fields(html)).toBe(1)
  expect(html).toContain('Your name')
  expect(html).toContain('By clicking Create account')
  expect(html).toContain('>Create account<')
  expect(html).not.toContain('Country')
  expect(html).not.toContain('autoComplete="organization"')
  expect(html).not.toContain('k-ssel')
})

test("a partner: its company's name too, still no country", () => {
  const html = page(true)
  expect(fields(html)).toBe(2)
  expect(html).toContain('Company name')
  expect(html).toContain('autoComplete="organization"')
  expect(html).not.toContain('Country')
})

test('New workspace from the app: the same single field, then Create workspace; the Business step names it', () => {
  const html = page(false, { onBack: () => {} })
  expect(fields(html)).toBe(1)
  expect(html).toContain('New workspace')
  expect(html).toContain('>Create workspace<')
  expect(html).not.toContain('Country')
  expect(html).not.toContain('autoComplete="organization"')
})
