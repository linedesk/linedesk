// The activation step (ActivateStep.tsx, docs/billing.md §3.2): what the owner reads above "Start free trial": the
// plan and its price a minute in cents, the dated timeline with the reminder emails and the first charge, the promise
// of the reminders and the terms next to the button.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { Activation, Me } from '../auth.ts'

vi.mock('../store.tsx', () => ({ useAssistantName: () => 'Maya' }))
vi.mock('../checkout.ts', () => ({ goToCheckout: vi.fn() }))
const { ActivateStep } = await import('./ActivateStep.tsx')

const activation: Activation = {
  planCents: 1100,
  interval: 'month',
  trialDays: 14,
  firstChargeAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  reminderDays: [7, 1],
  recharge: { amountCents: 2500, thresholdCents: 500, capCents: 10000 },
  includedMinutes: 50,
  standardMicrosPerMinute: 50_000,
  terms: {
    termsUrl: 'https://example.test/terms',
    termsVersion: 't1',
    privacyUrl: 'https://example.test/privacy',
    privacyVersion: 'p1',
  },
}
const me = (a: Activation) =>
  ({ workspace: { id: 'ws_1', name: 'Brightwater Plumbing', activation: a } }) as unknown as Me
const text = (a: Activation) =>
  renderToStaticMarkup(<ActivateStep me={me(a)} onBack={() => {}} onTermsChanged={() => {}} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')

test('the price a minute in cents, the plan, the timeline and the terms next to Start free trial', () => {
  const page = text(activation)
  expect(page).toContain('50 call minutes included, then 5¢ a minute.')
  expect(page).not.toContain('$0.05')
  expect(page).toContain('$11 a month per workspace')
  expect(page).toContain('The first 14 days are free.')
  expect(page.match(/Reminder email/g)).toHaveLength(2)
  expect(page).toContain('First charge: $11')
  expect(page).toContain('We email you 2 times before your first charge')
  expect(page).toContain('By clicking Start free trial')
  expect(page).toContain('Start free trial')
})

test('a Premium-priced plan says 10¢; a sub-cent price stays in dollars', () => {
  expect(text({ ...activation, standardMicrosPerMinute: 100_000 })).toContain('then 10¢ a minute')
  expect(text({ ...activation, standardMicrosPerMinute: 8_500 })).toContain('then $0.0085 a minute')
})
