// Workspace settings › Billing (Billing.tsx, docs/billing.md §11 PR 9): what the bill owner sees for each state of the
// bill. The trial with its countdown, the plan and its one primary button, a failed recharge with Retry (then the
// primary), past due and suspended in plain words, cancel and resume, the page for someone who does not manage the
// bill, and the workspace on no bill.
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
vi.mock('./settings-api.ts', () => ({
  readAction: vi.fn(),
  callAction: vi.fn(),
  useWorkspaceSettings: () => ({ data: undefined }),
  useWriteAction: () => vi.fn(),
  patchWorkspaceSettings: vi.fn(),
}))

const { Billing, CancelDialog } = await import('./Billing.tsx')

const DAY = 86_400_000
const bill = (over: Partial<BillingOverviewBill> = {}): BillingOverviewBill => ({
  status: 'active',
  interval: 'month',
  kind: 'cloud',
  seatCents: 1100,
  clientSeatCents: null,
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
    workspaces: [
      { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 0 },
    ],
  },
  cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 2000, ownerMaxBaseCents: 100_000 },
  rechargeFailure: null,
  rechargePending: null,
  heldForReview: false,
  extraNumberCents: 300,
  prices: {
    includedNumbers: 1,
    includedMinutes: 50,
    includedCalls: 5,
    standardMicrosPerMinute: 50_000,
    premiumMicrosPerMinute: 100_000,
    ultraMicrosPerMinute: 200_000,
    extraNumberCents: 300,
  },
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
  busyLine: null,
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
  // The shared plan card (ui/PlanCard.tsx): the price a month, its unit, the included rows (one workspace: no label),
  // then the bill's own facts.
  expect(html).toContain(
    '<b><span class="plan-card-price">$11 a month</span> <span class="plan-card-unit">per workspace</span></b>',
  )
  expect(html).toContain('50 call minutes each month, then $0.05 a minute')
  expect(html).toContain('A phone number')
  expect(html).toContain('5 calls at the same time')
  expect(html).not.toContain('Each workspace includes:')
  expect(html).not.toContain('days free')
  expect(html).toContain('1 workspace on this plan')
  expect(html).toMatch(/<details class="plan-card-all"><summary>/)
  // Billed monthly: no yearly note.
  expect(html).not.toContain('billed yearly')
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

test('several workspaces: "Each workspace includes:" once above the included rows; auto-recharge as the bill has it', () => {
  const one = render({ billingOn: true, bill: bill() })
  expect(one).not.toContain('Each workspace includes:')
  const three = render({ billingOn: true, bill: bill({ workspaces: 3 }) })
  expect(three.match(/Each workspace includes:/g)).toHaveLength(1)
  expect(three).toContain('3 workspaces on this plan')
  // The details say what the bill does: auto-recharge on, or off until turned on.
  const on = render({ billingOn: true, bill: bill({ autoRecharge: { ...bill().autoRecharge, on: true } }) })
  expect(on).toContain('Extra minutes and numbers are paid from your balance. Auto-recharge is on.')
  const off = render({ billingOn: true, bill: bill({ autoRecharge: { ...bill().autoRecharge, on: false } }) })
  expect(off).toContain('Auto-recharge is off until you turn it on.')
})

test('with Stripe Tax on: prices are before tax, auto-recharge says tax is added, an invoice shows its tax (LIN-459)', () => {
  const taxed = render({
    billingOn: true,
    bill: bill({
      taxed: true,
      invoices: [{ ...bill().invoices[0]!, totalCents: 1188, taxCents: 88 }],
    }),
  })
  expect(planCard(taxed)).toContain('Plus tax where it applies.')
  expect(taxed).toContain('your card is charged $20 plus tax where it applies. Your balance gets $20.')
  expect(taxed).toContain('$11.88')
  expect(taxed).toContain('incl. $0.88 tax')
  // The monthly cap is counted before tax (security review of #1105, L-2).
  expect(taxed).toContain('a calendar month, plus tax where it applies')
  expect(taxed).not.toContain('Add your billing address')
  const noAddress = render({ billingOn: true, bill: bill({ taxed: true, taxAddressMissing: true }) })
  expect(noAddress).toContain('Until then, recharges are charged without tax.')
  const untaxed = render({ billingOn: true, bill: bill() })
  expect(untaxed).not.toContain('Plus tax where it applies')
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
  const notOwner = renderToStaticMarkup(<Billing toast={() => {}} view="usage" />)
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
  expect(render({ billingOn: true, bill: null })).toContain('The person who pays this bill handles the plan')
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
  expect(html).not.toContain('$11')
  expect(html).not.toContain('Recharge automatically')
  expect(html).not.toContain('Buy minutes')
  expect(html).not.toContain('Extra phone numbers')
  expect(html).toContain('Usage this period')
})

test('the price of an extra number once, in "See all details", and a recharge on its way', () => {
  const html = render({ billingOn: true, bill: bill({ rechargePending: { amountCents: 2000 } }) })
  // The included number is the card's row; what more cost is in "See all details", not again under the card.
  expect(html.match(/\$3 a month/g)).toHaveLength(1)
  expect(html).toContain('Extra phone numbers')
  expect(html).not.toContain('includes one phone number')
  expect(html).toContain('A recharge of $20.00 is being charged to your card.')
})

test('a workspace admin: the usage of this workspace, read-only, and no payment controls', () => {
  queries.usage = {
    usage: {
      period: bill().period,
      row: { ...bill().usage[0]!, name: 'Brightwater Plumbing & Heating' },
    },
  }
  const html = renderToStaticMarkup(<Billing toast={() => {}} view="usage" />)
  expect(html).toContain('The person who pays this bill handles the plan')
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

test("a partner bill: the partner plan's base fee, then its client workspaces on their own line, never per workspace", () => {
  const partner = (over: Partial<BillingOverviewBill>) => bill({ kind: 'partner', clientSeatCents: 1100, ...over })
  const yearly = render({
    billingOn: true,
    bill: partner({ status: 'pending_payment', interval: 'year', seatCents: 16_800, clientSeatCents: 10_800 }),
  })
  // The shared plan card, as on the partner's Activate step: the base fee a month, its client workspaces next to it,
  // the yearly total as the grey note, the minutes per client workspace.
  expect(yearly).toContain(
    '<b><span class="plan-card-price">$14 a month</span> <span class="plan-card-unit">+ $9 a month × 1 client workspace</span></b><span class="help">$276 billed yearly</span>',
  )
  expect(yearly).toContain('Each client workspace includes:')
  expect(yearly).toContain('50 call minutes each month, then $0.05 a minute')
  // Before the first Checkout: no status badge ("Waiting for a card"), UI audit P3.
  expect(yearly).not.toContain('Waiting for a card')
  expect(yearly).not.toContain('per workspace each')
  const monthly = render({ billingOn: true, bill: partner({ seatCents: 1900, workspaces: 0 }) })
  expect(monthly).toContain('$19 a month</span> <span class="plan-card-unit">+ $11 a month per client workspace</span>')
  expect(monthly).not.toContain('billed yearly')
  expect(render({ billingOn: true, bill: partner({ seatCents: 1900, workspaces: 3 }) })).toContain(
    '+ $11 a month × 3 client workspaces',
  )
  // A Cloud bill: per workspace, no client workspaces.
  expect(render({ billingOn: true, bill: bill() })).not.toContain('client workspace')
})

test('a partner bill speaks of client workspaces: numbers, calls at the same time, a stopped plan, never one business', () => {
  const partner = (over: Partial<BillingOverviewBill> = {}) =>
    bill({ kind: 'partner', seatCents: 1900, clientSeatCents: 1100, ...over })
  // One client workspace: its row is named, never "Your assistant answers".
  const html = render({ billingOn: true, bill: partner() })
  expect(html).toContain('Each client workspace includes:')
  expect(html).not.toContain('Each workspace includes')
  expect(html).toContain('5 calls at the same time are included in each client workspace; 5 more cost $5 a month.')
  expect(html).toContain('the next caller hears that the business will call back, and the call is filed as missed.')
  // Adding calls waits for a paid plan; a partner plan has no trial.
  const pastDue = render({
    billingOn: true,
    bill: partner({ status: 'past_due', calls: { ...bill().calls, canAdd: false } }),
  })
  expect(pastDue).toContain('Each 5 more cost $5 a month; you can add them once your plan is paid.')
  expect(pastDue).not.toContain('after the trial')
  expect(html).not.toContain('Your assistant answers')
  expect(html).toContain('<b>Brightwater Plumbing &amp; Heating</b>')
  expect(html).toContain('Calls at the same time in Brightwater Plumbing &amp; Heating')
  // Free of charge: counted in client workspaces.
  const comped = render({ billingOn: true, bill: partner({ status: 'comped', workspaces: 2 }) })
  expect(comped).toContain('Free of charge · 2 client workspaces')
  // Unpaid, then canceled: the callers, numbers and calls are the client workspaces'.
  const unpaid = render(
    { billingOn: true, bill: partner({ status: 'suspended' }) },
    state({ status: 'suspended', suspendedReason: 'payment', cancelsAt: new Date(Date.now() + 5 * DAY).toISOString() }),
  )
  expect(unpaid).toContain('Callers of your client workspaces hear that the business will call back')
  expect(unpaid).not.toContain('Callers hear that you will call back')
  const canceled = render(
    { billingOn: true, bill: partner({ status: 'canceled' }) },
    state({
      status: 'canceled',
      numbersReleaseAt: new Date(Date.now() + 30 * DAY).toISOString(),
      dataUntil: new Date(Date.now() + 90 * DAY).toISOString(),
    }),
  )
  expect(canceled).toContain('numbers are kept until')
  expect(canceled).toContain('Their calls can be read and exported until')
  expect(canceled).not.toContain('Your numbers')
  // The cancel dialog.
  vi.stubGlobal('document', { activeElement: null })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const cancel = renderToStaticMarkup(<CancelDialog bill={partner()} onClose={() => {}} toast={() => {}} />)
  expect(cancel).toContain('numbers are kept for 30 days, so they can be moved to another carrier.')
  expect(cancel).toContain('Calls in your client workspaces stay readable and exportable for 90 days.')
  expect(cancel).not.toContain('Your numbers')
  // A Cloud bill keeps its own words.
  const cloud = render({ billingOn: true, bill: bill() })
  expect(cloud).toContain('A phone number')
  expect(cloud).toContain('Your assistant answers')
  expect(cloud).toContain('included in each workspace;')
  expect(renderToStaticMarkup(<CancelDialog bill={bill()} onClose={() => {}} toast={() => {}} />)).toContain(
    'Your numbers are kept for 30 days',
  )
})

test('the partner\'s team in a client workspace: on their own partner plan, never "your partner handles billing"', () => {
  queries.usage = { usage: { period: bill().period, row: null, minutesOnly: true } }
  const team = renderToStaticMarkup(<Billing toast={() => {}} view="usage" viaPartner />)
  expect(team).toContain('This client workspace is on your partner plan; here are the minutes it used.')
  expect(team).not.toContain('Your partner handles billing')
  // An admin of the team holds billing:manage there (an admin's right) but manages no bill: the same line.
  queries.overview = { billingOn: true, bill: null }
  expect(renderToStaticMarkup(<Billing toast={() => {}} viaPartner />)).toContain(
    'This client workspace is on your partner plan',
  )
  // The client's own people keep the partner line.
  const client = renderToStaticMarkup(<Billing toast={() => {}} view="usage" />)
  expect(client).toContain('Your partner handles billing')
  expect(client).not.toContain('your partner plan')
})

test('calls at the same time: 5 included per workspace, 5 more for $5 a month, no extra primary button', () => {
  const html = render({ billingOn: true, bill: bill() })
  expect(html).toContain('Calls at the same time')
  expect(html).toContain('5 calls at the same time are included in each workspace; 5 more cost $5 a month.')
  expect(html).toContain('Up to 5 calls at the same time, included in your plan')
  // A custom list, never the browser's select.
  expect(html).not.toContain('<select')
  expect(primaries(html)).toBe(1)
  const bought = bill({
    calls: {
      ...bill().calls,
      workspaces: [
        { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 10, limit: 15, busyCallers: 0 },
      ],
    },
  })
  expect(render({ billingOn: true, bill: bought })).toContain(
    'Up to 15 calls at the same time, $10 a month for the extra ones',
  )
})

test('calls at the same time come last: plan, balance, auto-recharge, usage, invoices, then calls (2026-11-18)', () => {
  const order = (html: string) =>
    ['plan', 'balance', 'auto', 'usage', 'invoices', 'calls'].map(id => html.indexOf(`id="billing-${id}"`))
  const inOrder = (at: number[]) => at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!))
  expect(inOrder(order(render({ billingOn: true, bill: bill() })))).toBe(true)
  expect(inOrder(order(render({ billingOn: true, bill: bill({ interval: 'year' }) })))).toBe(true)
  expect(inOrder(order(render({ billingOn: true, bill: bill({ kind: 'partner', clientSeatCents: 1100 }) })))).toBe(true)
  expect(inOrder(order(render({ billingOn: true, bill: bill({ status: 'trialing' }) })))).toBe(true)
})

test('calls at the same time: callers who got a busy line show next to the workspace, none when there were none', () => {
  expect(render({ billingOn: true, bill: bill() })).not.toContain('busy line')
  const busy = bill({
    calls: {
      ...bill().calls,
      workspaces: [
        { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 3 },
      ],
    },
  })
  expect(render({ billingOn: true, bill: busy })).toContain('3 callers got a busy line in the last 30 days')
  const once = bill({
    calls: {
      ...bill().calls,
      workspaces: [
        { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 1 },
      ],
    },
  })
  expect(render({ billingOn: true, bill: once })).toContain('1 caller got a busy line in the last 30 days')
})

test('calls at the same time in the trial: more only once the plan is paid; several workspaces by name', () => {
  const trial = bill({
    status: 'trialing',
    calls: {
      ...bill().calls,
      canAdd: false,
      workspaces: [
        { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating', extraCalls: 0, limit: 5, busyCallers: 0 },
        { workspaceId: 'ws_2', name: 'Brightwater North', extraCalls: 0, limit: 5, busyCallers: 0 },
      ],
    },
  })
  const html = render({ billingOn: true, bill: trial })
  expect(html).toContain('Each 5 more cost $5 a month; you can add them once your plan is paid, after the trial.')
  expect(html).toContain('Brightwater North')
  // The numbers once each: the rows say what is included, the note what more cost; the card's line only the busy line.
  expect(html).not.toContain('are included in each workspace')
  // Once in the calls section, once in the plan card's "See all details" (5 more calls at the same time).
  expect(html.match(/\$5 a month/g)).toHaveLength(2)
  expect(html).toContain('When all lines are busy, the next caller hears')
})

test('the trial: its $0.00 plan invoice says "Trial (no charge)", and auto-recharge off is said once in the plan', () => {
  const trial = bill({
    status: 'trialing',
    autoRecharge: { ...bill().autoRecharge, on: false },
    invoices: [{ ...bill().invoices[0]!, kind: 'subscription', totalCents: 0, taxCents: 0, status: 'paid' }],
  })
  const html = render({ billingOn: true, bill: trial })
  expect(html).toContain('Trial (no charge)')
  expect(html).not.toContain('$0.00')
  expect(html).toContain('Auto-recharge is off until you turn it on below.')
  expect(html).not.toContain('Auto-recharge starts once the plan does')
})

test('the bill page has no Voices and models card: picking Premium or Ultra on an assistant is the consent', () => {
  queries.overview = { billingOn: true, bill: bill() }
  queries.state = { bill: state() }
  const html = renderToStaticMarkup(<Billing toast={() => {}} />)
  expect(html).toContain('Buy minutes')
  expect(html).not.toContain('Voices and models')
  expect(html).not.toContain('Allow Premium')
  expect(html).not.toContain('Allow Ultra')
})

test('no bill on an install that bills: one calm line, no plan, no payment controls', () => {
  const html = renderToStaticMarkup(<Billing toast={() => {}} view="none" />)
  expect(html).toContain('No plan: calls in this workspace are not charged.')
  expect(html).toContain('Your server admin can put it on a plan.')
  expect(html).not.toContain('Buy minutes')
  expect(html).not.toContain('Cancel plan')
  expect(html).not.toContain('Voices and models')
  expect(primaries(html)).toBe(0)
})
