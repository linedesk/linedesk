// What the return page from Stripe Checkout says outside a setup (CheckoutReturn.tsx, confirmedCopy).
import { describe, expect, test, vi } from 'vitest'

vi.mock('./checkout.ts', () => ({
  confirmCheckout: () => new Promise(() => {}),
  goToCheckout: async () => {},
  readCheckoutPartner: () => null,
  readCheckoutSession: () => 'cs_test_1',
}))

const { confirmedCopy } = await import('./CheckoutReturn.tsx')
const { i18n } = await import('./i18n/index.tsx')
const copy = (outcome: Parameters<typeof confirmedCopy>[0]) => confirmedCopy(outcome, i18n().t, i18n().format)

describe('the return page after Checkout', () => {
  test('a plan that ended and was started again: active again, no onboarding words, Open inbox (LIN-783)', () => {
    const restarted = copy({ status: 'active', heldForReview: false, restarted: true })
    expect(restarted).toEqual({
      title: 'Your plan is active again',
      text: 'Your assistant answers calls again, and the phone numbers you still had are back.',
      button: 'Open inbox',
    })
    expect(JSON.stringify(restarted)).not.toContain('phone number and your assistant')
  })

  test('a first plan and a trial keep their words', () => {
    expect(copy({ status: 'active', heldForReview: false })).toEqual({
      title: 'Your plan has started',
      text: 'Thanks! Next: your phone number and your assistant.',
      button: 'Continue',
    })
    expect(copy({ status: 'active', heldForReview: true })?.extra).toContain('We are checking your card')
    expect(copy({ status: 'trialing', heldForReview: false })?.title).toBe('Your free trial has started')
    expect(copy({ status: 'failed' })).toBeNull()
  })
})
