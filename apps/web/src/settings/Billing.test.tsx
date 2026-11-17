// Workspace settings › Billing (Billing.tsx, docs/billing.md §11 PR 9): what the bill owner sees for each state of the
// bill. The trial with its countdown, the plan and its one primary button, a failed recharge with Retry (then the
// primary), past due and suspended in plain words, cancel and resume, and the page for someone who does not pay.
import type { BillingOverviewBill, BillingOverviewData, BillingStateBill } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const queries = vi.hoisted(() => ({ overview: undefined as unknown, state: undefined as unknown }))
vi.mock('../cachedQuery.ts', () => ({
  useQuery: (key: string) => ({
    data: key === 'billing.overview' ? queries.overview : queries.state,
    error: null,
    reload: async () => {},
  }),
  refreshQuery: async () => {},
  setQueryData: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), callAction: vi.fn() }))

const { Billing } = await import('./Billing.tsx')

const DAY = 86_400_000
const bill = (over: Partial<BillingOverviewBill> = {}): BillingOverviewBill => ({
  status: 'active',
  interval: 'month',
  seatCents: 1100,
  workspaces: 1,
  trialEndsAt: null,
  currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
  cancelAtPeriodEnd: false,
  balanceMicros: 12_340_000,
  availableMicros: 12_340_000,
  autoRecharge: { on: true, thresholdCents: 500, amountCents: 2000 },
  cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 2000, ownerMaxBaseCents: 100_000 },
  rechargeFailure: null,
  canBuyMinutes: true,
  hasPortal: true,
  period: {
    startsAt: new Date(Date.now() - 10 * DAY).toISOString(),
    endsAt: new Date(Date.now() + 20 * DAY).toISOString(),
    kind: 'month',
  },
  usage: [
    {
      workspaceId: 'ws_1',
      name: 'Brightwater Plumbing & Heating',
      allowanceUsedSeconds: 1200,
      allowanceSeconds: 3000,
      levels: { standard: { seconds: 600, micros: 500_000 }, premium: { seconds: 120, micros: 200_000 } },
    },
  ],
  invoices: [
    {
      id: 'in_1',
      kind: 'subscription',
      number: 'LD-0001',
      status: 'paid',
      totalCents: 1100,
      createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
      url: 'https://invoice.stripe.test/i/1',
    },
  ],
  ...over,
})
const state = (over: Partial<BillingStateBill> = {}): BillingStateBill => ({
  status: 'active',
  suspendedReason: null,
  pastDueSince: null,
  suspendsAt: null,
  cancelsAt: null,
  canceledAt: null,
  numbersReleaseAt: null,
  dataUntil: null,
  rechargeFailed: false,
  rechargeNeedsAction: false,
  lowBalance: null,
  unpaidNumbers: [],
  ...over,
})
const render = (overview: BillingOverviewData, s: BillingStateBill | null = state()) => {
  queries.overview = overview
  queries.state = { bill: s }
  return renderToStaticMarkup(<Billing toast={() => {}} />)
}
const primaries = (html: string) => (html.match(/k-btn-primary/g) ?? []).length

test('a running plan: price, renewal, balance, usage, invoices, Buy minutes as the one primary button, Cancel plan', () => {
  const html = render({ billingOn: true, bill: bill() })
  expect(html).toContain('$11.00 a month per workspace · 1 workspace')
  expect(html).toContain('Renews on')
  expect(html).toContain('$12.34')
  expect(html).toContain('20 of 50 included minutes used')
  expect(html).toContain('10 Standard minutes')
  expect(html).toContain('2 Premium minutes')
  expect(html).toContain('href="https://invoice.stripe.test/i/1"')
  expect(html).toContain('Buy minutes')
  expect(html).toContain('Cancel plan')
  expect(html).toContain('Card and invoices')
  expect(primaries(html)).toBe(1)
})

test('the trial: its end and the days left, said in plain words', () => {
  const html = render({
    billingOn: true,
    bill: bill({ status: 'trialing', trialEndsAt: new Date(Date.now() + 5 * DAY - 60_000).toISOString() }),
  })
  expect(html).toContain('Free trial')
  expect(html).toContain('5 days left')
})

test('a failed recharge: the reason, Retry as the primary button, Buy minutes no longer primary', () => {
  const html = render({
    billingOn: true,
    bill: bill({
      rechargeFailure: { at: new Date().toISOString(), code: 'card_declined', needsAction: false, retriesLeft: 2 },
    }),
  })
  expect(html).toContain('Your last auto-recharge failed')
  expect(html).toContain('2 tries left today')
  expect(html).toContain('Try again')
  expect(primaries(html)).toBe(1)
  const confirm = render({
    billingOn: true,
    bill: bill({
      rechargeFailure: {
        at: new Date().toISOString(),
        code: 'authentication_required',
        needsAction: true,
        retriesLeft: 3,
      },
    }),
  })
  expect(confirm).toContain('Confirm payment')
})

test('suspended for a missed payment, and past due: what happens and by when', () => {
  const suspended = render(
    { billingOn: true, bill: bill({ status: 'suspended' }) },
    state({
      status: 'suspended',
      suspendedReason: 'payment',
      cancelsAt: new Date(Date.now() + 20 * DAY).toISOString(),
    }),
  )
  expect(suspended).toContain('Calls are paused')
  expect(suspended).toContain('Your plan was not paid.')
  // The app is the one place to cancel (the portal has none), also while calls are paused (review of #1007, L-5).
  expect(suspended).toContain('Cancel plan')
  const pastDue = render(
    { billingOn: true, bill: bill({ status: 'past_due' }) },
    state({ status: 'past_due', suspendsAt: new Date(Date.now() + 3 * DAY).toISOString() }),
  )
  expect(pastDue).toContain('Your last payment failed')
  expect(pastDue).toContain('Calls are still answered.')
})

test('canceled at the period end: the end date and Keep my plan instead of Cancel plan', () => {
  const html = render({ billingOn: true, bill: bill({ cancelAtPeriodEnd: true }) })
  expect(html).toContain('You canceled.')
  expect(html).toContain('Keep my plan')
  expect(html).not.toContain('Cancel plan')
})

test('someone who does not pay for the workspace, or billing off: nothing about the bill', () => {
  expect(render({ billingOn: true, bill: null })).toContain('handled by the person who pays for it')
  const off = render({ billingOn: false, bill: null })
  expect(off).toContain('Billing is off on this server.')
  expect(off).not.toContain('Buy minutes')
})
