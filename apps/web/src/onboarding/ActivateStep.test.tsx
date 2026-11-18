// The activation step (ActivateStep.tsx, docs/billing.md §3.2): what the owner reads above "Start free trial": the
// plan's price a month (a yearly plan's total in the grey note under it, and at the first charge) and its price a
// minute in cents, the dated timeline with the reminder emails and the first charge, no auto-recharge, and no terms:
// they were accepted once, at sign-up (decision of 2026-11-18).
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Activation, Me } from '../auth.ts'

vi.mock('../store.tsx', () => ({ useAssistantName: () => 'Maya' }))
vi.mock('../checkout.ts', () => ({ goToCheckout: vi.fn() }))
vi.mock('../shell/TermsUpdate.tsx', () => ({ askTermsAgain: vi.fn() }))
const { ActivateStep, useStartTrial } = await import('./ActivateStep.tsx')
const { goToCheckout } = await import('../checkout.ts')
const { askTermsAgain } = await import('../shell/TermsUpdate.tsx')

const activation: Activation = {
  planCents: 1100,
  interval: 'month',
  trialDays: 14,
  firstChargeAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  reminderDays: [7, 1],
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

test('the price a minute in cents, the plan and the timeline next to Start free trial; no terms again', () => {
  const page = text(activation)
  expect(page).toContain('50 call minutes included, then 5¢ a minute.')
  expect(page).not.toContain('$0.05')
  // Billed monthly: the price a month alone, no note (ui/price.tsx).
  expect(page).toContain('$11 a month per workspace Plus tax where it applies.')
  expect(page).not.toContain('billed')
  expect(page).toContain('The first 14 days are free.')
  // One line for both reminder emails; today is day 1, so the first charge is on day 15 (as the website says).
  expect(page.match(/Reminder email/g)).toHaveLength(1)
  expect(page).toContain('Reminder emails 7 days and 1 day before')
  expect(page).toMatch(/Day 15, \w{3} \d{1,2} First charge \$11\. Cancel any time before/)
  // Activation never turns auto-recharge on (2026-11-17): nothing about it, nor a call credit charge.
  expect(page).not.toMatch(/recharge|call balance|\$25/i)
  expect(page).not.toContain('We email you')
  // The terms were accepted at sign-up: no clickwrap and no terms links here.
  expect(page).not.toMatch(/By clicking|Terms of Service|Privacy Policy/)
  expect(
    renderToStaticMarkup(<ActivateStep me={me(activation)} onBack={() => {}} onTermsChanged={() => {}} />),
  ).not.toContain('example.test/terms')
  expect(page).toContain('Start free trial')
})

test('after a refused trial, Start my plan asks no terms either', () => {
  const page = text({ ...activation, trialDays: null, firstChargeAt: null, reminderDays: [] })
  expect(page).toContain('Start my plan')
  expect(page).not.toMatch(/By clicking|Terms of Service|Privacy Policy/)
})

/** Renders the hook once (no DOM here) and hands its start out: what it calls is what counts. */
function Probe({
  m,
  onTermsChanged,
  got,
}: {
  m: Me
  onTermsChanged: () => void
  got: (s: () => Promise<void>) => void
}) {
  got(useStartTrial(m, activation, onTermsChanged, { byHand: false }).start)
  return null
}

describe('starting', () => {
  function starter(m: Me, onTermsChanged = () => {}) {
    let start: (() => Promise<void>) | null = null
    renderToStaticMarkup(<Probe m={m} onTermsChanged={onTermsChanged} got={s => (start = s)} />)
    return start!
  }
  beforeEach(() => vi.mocked(goToCheckout).mockReset())

  test('goes to Checkout without any terms (accepted at sign-up)', async () => {
    vi.mocked(goToCheckout).mockResolvedValue(undefined)
    await starter(me(activation))()
    expect(goToCheckout).toHaveBeenCalledWith(null, 0)
  })

  test('terms changed since sign-up and not accepted yet: the app’s terms dialog asks first, no Checkout', async () => {
    vi.mocked(askTermsAgain).mockClear()
    const waiting = { ...me(activation), termsUpdate: activation.terms } as Me
    await starter(waiting)()
    expect(goToCheckout).not.toHaveBeenCalled()
    expect(askTermsAgain).toHaveBeenCalledOnce()
  })

  test('refused with terms_changed (changed since the page loaded): /v1/me is read again and the dialog asks', async () => {
    vi.mocked(askTermsAgain).mockClear()
    vi.mocked(goToCheckout).mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'terms_changed' }))
    const reload = vi.fn()
    await starter(me(activation), reload)()
    expect(reload).toHaveBeenCalledOnce()
    expect(askTermsAgain).toHaveBeenCalledOnce()
  })
})

test('a Premium-priced plan says 10¢; a sub-cent price stays in dollars', () => {
  expect(text({ ...activation, standardMicrosPerMinute: 100_000 })).toContain('then 10¢ a minute')
  expect(text({ ...activation, standardMicrosPerMinute: 8_500 })).toContain('then $0.0085 a minute')
})

test('a yearly plan leads with the price a month, its total in the grey note under it and at the first charge', () => {
  const html = renderToStaticMarkup(
    <ActivateStep
      me={me({ ...activation, interval: 'year', planCents: 10800 })}
      onBack={() => {}}
      onTermsChanged={() => {}}
    />,
  )
  expect(html).toContain('<b>$9 a month per workspace</b><span class="help">$108 billed yearly</span>')
  const page = text({ ...activation, interval: 'year', planCents: 10800 })
  expect(page.match(/\$108/g)).toHaveLength(2)
  expect(page).toMatch(/First charge \$108\. Cancel any time before/)
})

test('calls at the same time (LIN-450): picked on the pick-up step; here one quiet line only when more were picked', () => {
  const calls = { included: 5, step: 5, maxExtra: 45, extraCallCents: 100 }
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
    removeItem: (k: string) => stored.delete(k),
  })
  try {
    // None picked: nothing about calls at the same time, and no picker on this step.
    expect(text({ ...activation, calls })).not.toContain('calls at the same time')
    stored.set('linedesk.activation.extraCalls.ws_1', '5')
    const page = text({ ...activation, calls })
    expect(page).toContain('10 calls at the same time: $5 a month more.')
    expect(page).toContain('First charge $16.')
    expect(page).not.toContain('5 $')
    // A choice the offer no longer allows is not sold.
    stored.set('linedesk.activation.extraCalls.ws_1', '7')
    expect(text({ ...activation, calls })).not.toContain('calls at the same time')
    expect(text({ ...activation, calls: { ...calls, maxExtra: 0 } })).not.toContain('calls at the same time')
  } finally {
    vi.unstubAllGlobals()
  }
})
