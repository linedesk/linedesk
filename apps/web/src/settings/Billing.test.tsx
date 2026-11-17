// Workspace settings › Billing (Billing.tsx, docs/billing.md §11 PR 9): what the bill owner sees for each state of the
// bill. The trial with its countdown, the plan and its one primary button, a failed recharge with Retry (then the
// primary), past due and suspended in plain words, cancel and resume, and the page for someone who does not pay.
import type { BillingOverviewBill, BillingOverviewData, BillingStateBill } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, onTestFinished, test, vi } from 'vitest'

const queries = vi.hoisted(() => ({
  overview: undefined as unknown,
  state: undefined as unknown,
  usage: undefined as unknown,
  links: { supportEmail: 'support@linedesk.test', terms: null, privacy: null } as unknown,
}))
vi.mock('../cachedQuery.ts', () => ({
  useQuery: (key: string) => ({
    data:
      key === 'billing.overview'
        ? queries.overview
        : key === 'billing.workspaceUsage'
          ? queries.usage
          : key === 'auth-methods'
            ? { links: queries.links }
            : queries.state,
    error: null,
    reload: async () => {},
  }),
  refreshQuery: async () => {},
  setQueryData: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), callAction: vi.fn() }))

const { Billing, CancelDialog } = await import('./Billing.tsx')

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
  calls: {
    includedPerWorkspace: 5,
    extraCallCents: 100,
    step: 5,
    maxExtra: 45,
    canAdd: true,
    paidExtra: 0,
    workspaces: [{ workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5 }],
  },
  cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 2000, ownerMaxBaseCents: 100_000 },
  rechargeFailure: null,
  rechargePending: null,
  heldForReview: false,
  extraNumberCents: 300,
  canBuyMinutes: true,
  hasPortal: true,
  taxed: false,
  taxAddressMissing: false,
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
      taxCents: 0,
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
  heldForReview: false,
  rechargeNeedsAction: false,
  lowBalance: null,
  unpaidNumbers: [],
  trialMinutes: null,
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

test('with Stripe Tax on: prices are before tax, auto-recharge says tax is added, an invoice shows its tax (LIN-459)', () => {
  const taxed = render({
    billingOn: true,
    bill: bill({
      taxed: true,
      invoices: [{ ...bill().invoices[0]!, totalCents: 1188, taxCents: 88 }],
    }),
  })
  expect(taxed).toContain('Prices are before tax. Tax is added where it applies, based on your billing address.')
  expect(taxed).toContain('your card is charged $20 plus tax where it applies. Your balance gets $20.')
  expect(taxed).toContain('$11.88')
  expect(taxed).toContain('incl. $0.88 tax')
  // The monthly cap is counted before tax (security review of #1105, L-2).
  expect(taxed).toContain('a calendar month, plus tax where it applies')
  expect(taxed).not.toContain('Add your billing address')
  const noAddress = render({ billingOn: true, bill: bill({ taxed: true, taxAddressMissing: true }) })
  expect(noAddress).toContain('Until then, recharges are charged without tax.')
  const untaxed = render({ billingOn: true, bill: bill() })
  expect(untaxed).not.toContain('Prices are before tax')
  expect(untaxed).not.toContain('plus tax')
  expect(untaxed).not.toContain('tax</')
})

test('a recharge refused for a missing billing address says so, not "declined" (LIN-459)', () => {
  const html = render({
    billingOn: true,
    bill: bill({
      rechargeFailure: {
        at: new Date().toISOString(),
        code: 'stripe_customer_tax_location_invalid',
        needsAction: false,
        retriesLeft: 2,
      },
    }),
  })
  expect(html).toContain('Your card was not charged: tax needs your billing address.')
  expect(html).not.toContain('Your card was declined')
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

const invoice = (id: string, over: Partial<BillingOverviewBill['invoices'][number]> = {}) => ({
  id,
  kind: 'subscription' as const,
  number: `LD-${id}`,
  status: 'open' as const,
  totalCents: 1100,
  taxCents: 0,
  createdAt: new Date(Date.now() - DAY).toISOString(),
  url: `https://invoice.stripe.com/i/acct_1/${id}`,
  ...over,
})
const paused = state({ status: 'suspended', suspendedReason: 'payment', cancelsAt: null })
/** The plan card alone (the warning), cut off before the next card: the Invoices card has its own Pay links. */
const planCard = (html: string) => html.slice(html.indexOf('id="billing-plan"'), html.indexOf('</section>'))
const payLinks = (html: string) => planCard(html).match(/<a class="k-btn[^"]*" href="[^"]*"[^>]*>[^<]*<\/a>/g) ?? []

test('calls paused for a missed payment: a pay link per open invoice in the warning, to Stripe in a new tab', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({
        status: 'suspended',
        invoices: [invoice('in_a'), invoice('in_b', { totalCents: 2050, kind: 'recharge' })],
      }),
    },
    paused,
  )
  const links = payLinks(html)
  expect(links).toEqual([
    '<a class="k-btn k-btn-sm k-btn-primary" href="https://invoice.stripe.com/i/acct_1/in_a" target="_blank" rel="noopener noreferrer">Pay $11.00 invoice</a>',
    '<a class="k-btn k-btn-sm k-btn-secondary" href="https://invoice.stripe.com/i/acct_1/in_b" target="_blank" rel="noopener noreferrer">Pay $20.50 invoice</a>',
  ])
  expect(planCard(html)).toContain('Calls are paused')
  expect(planCard(html)).not.toContain('See all open invoices')
  // One primary button on the page: the first pay link.
  expect(primaries(html)).toBe(1)
})

test('past due: the open invoice to pay in the warning, and Buy minutes no longer the primary button', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({
        status: 'past_due',
        invoices: [invoice('in_a', { url: 'https://pay.stripe.com/invoice/acct_1/in_a' })],
      }),
    },
    state({ status: 'past_due', suspendsAt: new Date(Date.now() + 3 * DAY).toISOString() }),
  )
  expect(payLinks(html)).toHaveLength(1)
  expect(payLinks(html)[0]).toContain('href="https://pay.stripe.com/invoice/acct_1/in_a"')
  expect(primaries(html)).toBe(1)
  const buy = html.match(/<button[^>]*class="([^"]*)"[^>]*>(?:(?!<\/button>).)*Buy minutes/)
  expect(buy?.[1]).toBe('k-btn k-btn-secondary k-btn-md')
})

test('no pay links for paid, voided or draft invoices, for one without a page, or for a page not on Stripe', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({
        status: 'suspended',
        invoices: [
          invoice('in_paid', { status: 'paid' }),
          invoice('in_void', { status: 'void' }),
          invoice('in_draft', { status: 'draft' }),
          invoice('in_nopage', { url: null }),
          invoice('in_http', { url: 'http://invoice.stripe.com/i/acct_1/in_http' }),
          invoice('in_other', { url: 'https://invoice.stripe.com.evil.test/i/in_other' }),
          invoice('in_js', { url: 'javascript:alert(1)' }),
        ],
      }),
    },
    paused,
  )
  expect(planCard(html)).toContain('Calls are paused')
  expect(payLinks(html)).toEqual([])
  expect(planCard(html)).not.toContain('evil.test')
  expect(planCard(html)).not.toContain('javascript:')
})

test('more than two open invoices: the first two to pay, and See all open invoices', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({ status: 'suspended', invoices: [invoice('in_a'), invoice('in_b'), invoice('in_c')] }),
    },
    paused,
  )
  const links = payLinks(html)
  expect(links).toHaveLength(2)
  expect(links[0]).toContain('in_a')
  expect(links[1]).toContain('in_b')
  expect(planCard(html)).not.toContain('in_c')
  expect(planCard(html)).toContain('See all open invoices')
})

test('no pay links in a running plan, nor for someone who does not pay for the workspace', () => {
  const running = render({ billingOn: true, bill: bill({ invoices: [invoice('in_a')] }) })
  expect(payLinks(running)).toEqual([])
  expect(running).not.toContain('Pay $11.00 invoice')
  queries.overview = { billingOn: true, bill: bill({ status: 'suspended', invoices: [invoice('in_a')] }) }
  queries.state = { bill: paused }
  queries.usage = { usage: null }
  const notOwner = renderToStaticMarkup(<Billing toast={() => {}} owner={false} />)
  expect(notOwner).not.toContain('Pay $11.00 invoice')
  expect(notOwner).not.toContain('invoice.stripe.com')
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

test('a bill held for review: "Under review", what it means and whom to write, never "Active"', () => {
  const html = render({ billingOn: true, bill: bill({ heldForReview: true }) })
  expect(html).toContain('Under review')
  expect(html).not.toContain('>Active<')
  expect(html).toContain('We are checking your card')
  expect(html).toContain('you cannot get a phone number')
  expect(html).toContain('support@linedesk.test')
})

test('a comped bill: free of charge, no price, no balance to top up and no auto-recharge', () => {
  const html = render({
    billingOn: true,
    bill: bill({ status: 'comped', balanceMicros: 0, availableMicros: 0, extraNumberCents: 0, invoices: [] }),
  })
  expect(html).toContain('Free of charge · 1 workspace')
  expect(html).not.toContain('$11.00')
  expect(html).not.toContain('Recharge automatically')
  expect(html).not.toContain('Buy minutes')
  expect(html).not.toContain('Extra numbers are')
  expect(html).toContain('Usage this period')
})

test('the price of an extra number, and a recharge on its way', () => {
  const html = render({ billingOn: true, bill: bill({ rechargePending: { amountCents: 2000 } }) })
  expect(html).toContain('Extra numbers are $3 a month each, paid from your balance.')
  expect(html).toContain('A recharge of $20.00 is being charged to your card.')
})

test('a workspace admin: the usage of this workspace, read-only, and no payment controls', () => {
  queries.usage = {
    usage: {
      period: bill().period,
      row: { ...bill().usage[0]!, name: 'Brightwater Plumbing & Heating' },
    },
  }
  const html = renderToStaticMarkup(<Billing toast={() => {}} owner={false} />)
  expect(html).toContain('handled by the person who pays for it')
  expect(html).toContain('Usage this period')
  expect(html).toContain('20 of 50 included minutes used')
  expect(html).not.toContain('Buy minutes')
  expect(html).not.toContain('Cancel plan')
  expect(html).not.toContain('Card and invoices')
  expect(primaries(html)).toBe(0)
})

test('the cancel dialog: the yearly refund within 14 days and the balance refund, and whom to ask', () => {
  // The dialog remembers the focused element (no DOM here): rendered in place, without a portal.
  vi.stubGlobal('document', { activeElement: null })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const recent = renderToStaticMarkup(
    <CancelDialog
      bill={bill({
        interval: 'year',
        invoices: [
          { ...bill().invoices[0]!, totalCents: 10_800, createdAt: new Date(Date.now() - 3 * DAY).toISOString() },
        ],
      })}
      onClose={() => {}}
      toast={() => {}}
    />,
  )
  expect(recent).toContain('you can get a full refund if you ask by')
  expect(recent).toContain('Your unused balance of $12.34 is refunded if you ask')
  expect(recent).toContain('To ask for a refund, write to support@linedesk.test.')
  const late = renderToStaticMarkup(
    <CancelDialog
      bill={bill({
        interval: 'year',
        availableMicros: 0,
        balanceMicros: 0,
        invoices: [{ ...bill().invoices[0]!, createdAt: new Date(Date.now() - 40 * DAY).toISOString() }],
      })}
      onClose={() => {}}
      toast={() => {}}
    />,
  )
  expect(late).toContain('The rest of the year is not refunded.')
  expect(late).not.toContain('write to')
  const monthly = renderToStaticMarkup(<CancelDialog bill={bill()} onClose={() => {}} toast={() => {}} />)
  expect(monthly).not.toContain('refunded if you ask by')
  expect(monthly).toContain('Your unused balance of $12.34')
})

test('calls at the same time: 5 included per workspace, 5 more for $5 a month, no extra primary button', () => {
  const html = render({ billingOn: true, bill: bill() })
  expect(html).toContain('Calls at the same time')
  expect(html).toContain('5 calls at the same time are included in each workspace; 5 more cost $5.00 a month.')
  expect(html).toContain('Up to 5 calls at the same time, included in your plan')
  // A custom list, never the browser's select.
  expect(html).not.toContain('<select')
  expect(primaries(html)).toBe(1)
  const bought = bill({
    calls: {
      ...bill().calls,
      workspaces: [{ workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 10, limit: 15 }],
    },
  })
  expect(render({ billingOn: true, bill: bought })).toContain(
    'Up to 15 calls at the same time, $10.00 a month for the extra ones',
  )
})

test('calls at the same time in the trial: more only once the plan is paid; several workspaces by name', () => {
  const trial = bill({
    status: 'trialing',
    calls: {
      ...bill().calls,
      canAdd: false,
      workspaces: [
        { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5 },
        { workspaceId: 'ws_2', name: 'Brightwater North', extraCalls: 0, limit: 5 },
      ],
    },
  })
  const html = render({ billingOn: true, bill: trial })
  expect(html).toContain('More calls at the same time can be added once your plan is paid, after the trial.')
  expect(html).toContain('Brightwater North')
})
