// The billing line above every page (BillingBanner.tsx): the trial prompt is one line with its one button, "Keep calls
// answered", whose tooltip has the full terms; every other state is the plain line leading to Billing.
import type { BillingStateBill, BusyLinePrompt, TrialMinutesPrompt } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const queries = vi.hoisted(() => ({ state: undefined as unknown }))
vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: queries.state, error: null, reload: async () => {} }),
  refreshQuery: async () => {},
  setQueryData: () => {},
}))
vi.mock('../settings/settings-api.ts', () => ({ readAction: vi.fn(), callAction: vi.fn() }))

const { BillingBanner } = await import('./BillingBanner.tsx')

const prompt = (over: Partial<TrialMinutesPrompt> = {}): TrialMinutesPrompt => ({
  stage: 'low',
  paid: false,
  usedMinutes: 40,
  includedMinutes: 50,
  amountCents: 2500,
  thresholdCents: 500,
  capCents: 5000,
  freeUntil: '2026-12-01T12:00:00.000Z',
  standardMicrosPerMinute: 50_000,
  card: { id: 'pm_1', brand: 'visa', last4: '4242' },
  ...over,
})
const bill = (over: Partial<BillingStateBill> = {}): BillingStateBill => ({
  status: 'trialing',
  suspendedReason: null,
  pastDueSince: null,
  suspendsAt: null,
  cancelsAt: null,
  canceledAt: null,
  numbersReleaseAt: null,
  dataUntil: null,
  rechargeFailed: false,
  heldForReview: false,
  rechargeNeedsAction: false,
  lowBalance: null,
  unpaidNumbers: [],
  trialMinutes: null,
  busyLine: null,
  ...over,
})
const render = (state: BillingStateBill | null) => {
  queries.state = { bill: state }
  return renderToStaticMarkup(<BillingBanner toast={() => {}} />)
}

test('the trial prompt: one line naming the card, and "Keep calls answered" with the terms in its tooltip', () => {
  const html = render(bill({ trialMinutes: prompt() }))
  expect(html).toContain('is-warning')
  expect(html).toContain(
    'You used 40 of your 50 trial minutes. Add $25 with Visa ending in 4242 and we top up automatically below $5.',
  )
  expect(html).toContain('>Keep calls answered<')
  expect(html).toContain('Charges $25 to Visa ending in 4242 now and turns on auto-recharge')
  expect(html).toContain('at most $50 a month')
  expect(html).toContain('Your plan stays free until December 1, 2026.')
  expect(html).not.toContain('#workspace/billing')
})

test('a paid plan with auto-recharge off gets the same prompt once a month: its included minutes, no trial date', () => {
  const html = render(bill({ status: 'active', trialMinutes: prompt({ paid: true, freeUntil: null }) }))
  expect(html).toContain('is-warning')
  expect(html).toContain(
    'You used 40 of your 50 included minutes this month. Add $25 with Visa ending in 4242 and we top up automatically below $5.',
  )
  expect(html).toContain('>Keep calls answered<')
  expect(html).toContain('Charges $25 to Visa ending in 4242 now and turns on auto-recharge')
  expect(html).not.toContain('trial')
  expect(html).not.toContain('stays free')
})

test('used up: answered for a short time, then paused in red; the button stays', () => {
  const grace = render(bill({ trialMinutes: prompt({ stage: 'grace', usedMinutes: 50 }) }))
  expect(grace).toContain('Your trial minutes are used up; calls are answered for a short time.')
  expect(grace).toContain('>Keep calls answered<')
  const paused = render(bill({ trialMinutes: prompt({ stage: 'paused', usedMinutes: 50, card: null }) }))
  expect(paused).toContain('is-danger')
  expect(paused).toContain('callers hear that you will call back')
  expect(paused).toContain('your saved card')
  expect(paused).toContain('>Keep calls answered<')
})

test('other states keep the plain line to Billing; nothing without a bill or a prompt', () => {
  const failed = render(bill({ rechargeFailed: true, trialMinutes: prompt() }))
  expect(failed).toContain('#workspace/billing')
  expect(failed).not.toContain('Keep calls answered')
  expect(render(bill())).toBe('')
  expect(render(null)).toBe('')
})

const busyLine = (over: Partial<BusyLinePrompt> = {}): BusyLinePrompt => ({
  workspaceId: 'ws_1',
  callers: 3,
  limit: 5,
  extraCalls: 0,
  step: 5,
  stepCents: 500,
  canAdd: true,
  ...over,
})

test('busy callers today (LIN-450): one line, one button for 5 more lines at their price, Billing for other amounts', () => {
  const html = render(bill({ status: 'active', busyLine: busyLine() }))
  expect(html).toContain('is-warning')
  expect(html).toContain('3 callers got a busy line today: all 5 calls at the same time were in use.')
  expect(html).toContain('>Add 5 more lines for $5 a month<')
  expect(html).toContain('#workspace/billing')
  expect(html).toContain('>Other amounts<')
})

test('busy callers without the button: the trial, an instance cap or the most reached lead to Billing only', () => {
  const html = render(bill({ busyLine: busyLine({ callers: 1, canAdd: false }) }))
  expect(html).toContain('A caller got a busy line today')
  expect(html).not.toContain('more lines for')
  expect(html).toContain('#workspace/billing')
})
