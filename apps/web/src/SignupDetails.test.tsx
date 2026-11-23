// The sign-up page's last step (Signup.tsx DetailsStep): only the person's name, the terms
// and Create account; the business's name and country come in the onboarding's Business step. A partner also gives
// its company's name.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { DetailsStep, EmailStep } from './Signup.tsx'
import type { SignupConfig } from './signup.ts'

const terms = {
  termsUrl: 'https://desk.example.com/terms',
  termsVersion: '2026-11-17',
  privacyUrl: 'https://desk.example.com/privacy',
  privacyVersion: '2026-11-10',
}
const page = (partner: boolean, fromApp?: { onBack: () => void }, noTrial = false) =>
  renderToStaticMarkup(
    <DetailsStep
      interval="year"
      partner={partner}
      terms={terms}
      noTrial={noTrial}
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

test('a partner sets up first and pays when it activates: Create account, no payment step yet (2026-11-18)', () => {
  const html = page(true)
  expect(html).toContain('>Create account<')
  expect(html).toContain('By clicking Create account')
  expect(html).toContain('You pay when you activate White-label Cloud')
  expect(html).not.toContain('Continue to payment')
})

test('New workspace from the app: the same single field, then Create workspace; the Business step names it', () => {
  const html = page(false, { onBack: () => {} })
  expect(fields(html)).toBe(1)
  expect(html).toContain('New workspace')
  expect(html).toContain('>Create workspace<')
  expect(html).not.toContain('Country')
  expect(html).not.toContain('autoComplete="organization"')
})

test('a partner account from the app: Create partner account, not Create workspace (it gets no workspace)', () => {
  const html = page(true, { onBack: () => {} })
  expect(html).toContain('>Create partner account<')
  expect(html).toContain('By clicking Create partner account')
  expect(html).not.toContain('Create workspace')
})

test('no free trial for this account: nothing is charged here, no price, the plan comes at the end of the setup', () => {
  const html = page(false, undefined, true)
  expect(html).toContain('Nothing is charged now. You pay when you start your plan, at the end of the setup.')
  expect(html).not.toContain('$')
  expect(html).not.toContain('Starts today')
  expect(page(false)).not.toContain('Nothing is charged now')
})

const config = (partnerPlan: SignupConfig['partnerPlan']): SignupConfig => ({
  open: true,
  turnstileSiteKey: null,
  plan: { monthlyCents: 1100, yearlyCents: 10_800, trialDays: 14 },
  partnerPlan,
  terms,
  trial: true,
})
const emailPage = (partner: boolean, partnerPlan: SignupConfig['partnerPlan']) =>
  renderToStaticMarkup(<EmailStep config={config(partnerPlan)} partner={partner} onSent={() => {}} />)
const partnerPlan = { monthlyCents: 1900, yearlyCents: 16_800 }

test('the first step of a partner sign-up names White-label Cloud, promises no free trial and shows no price', () => {
  const html = emailPage(true, partnerPlan)
  expect(html).toContain('Set up White-label Cloud')
  expect(html).toContain('Run many client workspaces under your name.')
  expect(html).not.toMatch(/free|trial/i)
  expect(html).not.toContain('$')
})

test('a business keeps its own first step with its free trial', () => {
  const business = emailPage(false, partnerPlan)
  expect(business).toContain('Start your free trial')
  expect(business).not.toContain('White-label')
})
