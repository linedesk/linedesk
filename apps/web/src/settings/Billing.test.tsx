// Workspace settings › Billing (Billing.tsx): what the bill owner sees for each state of the
// bill. The trial with its countdown, the plan and its one primary button, a failed recharge with Retry (then the
// primary), past due and suspended in plain words, cancel and resume, the page for someone who does not manage the
// bill, and the workspace on no bill.
import type { BillingOverviewBill, BillingOverviewData, BillingStateBill } from '@linedesk/actions'
import { createFormatters, inTimeZone } from '@linedesk/i18n'
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

const { Billing, CancelDialog, IntervalDialog } = await import('./Billing.tsx')

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
  callsStopAtMicros: -5_000_000,
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
  // One workspace: "per workspace" says it, no "1 workspace on this plan" (LIN-780).
  expect(html).not.toContain('workspace on this plan')
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

test('the trial says each fact once (LIN-780): the days in the badge, one line with the first charge, Cancel trial', () => {
  const trialEndsAt = new Date(Date.UTC(2026, 11, 3, 12)).toISOString()
  const trial = (over: Partial<BillingOverviewBill> = {}) =>
    render(
      {
        billingOn: true,
        bill: bill({
          status: 'trialing',
          trialEndsAt,
          taxed: true,
          autoRecharge: { ...bill().autoRecharge, on: false },
          intervalSwitch: { interval: 'year', seatCents: 10800 },
          ...over,
        }),
      },
      state({ status: 'trialing' }),
    )
  const html = trial()
  const days = Math.ceil((Date.parse(trialEndsAt) - Date.now()) / DAY)
  expect(html).toContain(`Free trial · ${days} days left`)
  expect(html).toContain('Free until Dec 3, 2026. First charge then: <b>$11.00</b> plus tax where it applies.')
  // Said by the line above or by the Balance and Auto-recharge cards: never again in the plan.
  expect(html).not.toContain('workspace on this plan')
  expect(html).not.toContain('Your free trial ends on')
  expect(html).not.toContain('In the trial, calls beyond')
  expect(html).not.toContain('Auto-recharge is off until you turn it on below')
  expect(html).not.toContain('<span class="plan-card-fine">')
  // Monthly: said plainly; Switch to yearly stays a normal button next to Cancel trial.
  expect(html).toContain('Billed monthly')
  expect(html).toMatch(/k-btn-secondary[^"]*"[^>]*><span>Switch to yearly/)
  expect(html).toContain('Cancel trial')
  expect(html).not.toContain('Cancel plan')
  // Untaxed: the charge alone. Several workspaces: the charge for all of them, and how many.
  const two = trial({ taxed: false, workspaces: 2 })
  expect(two).toContain('First charge then: <b>$22.00</b>.')
  expect(two).toContain('2 workspaces on this plan')
  // Canceled in the trial: nothing will be charged, no amount.
  const canceled = trial({ cancelAtPeriodEnd: true })
  expect(canceled).toContain('Free until Dec 3, 2026. You canceled: nothing will be charged.')
  expect(canceled).not.toContain('First charge')
  // The last day.
  expect(trial({ trialEndsAt: new Date(Date.now() + 60_000).toISOString() })).toContain('Free trial · 1 day left')
})

test('a yearly trial: the first charge is the year, "billed yearly" once, and back to monthly is the small link (LIN-781)', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({
        status: 'trialing',
        interval: 'year',
        seatCents: 10800,
        trialEndsAt: new Date(Date.UTC(2026, 11, 3, 12)).toISOString(),
        intervalSwitch: { interval: 'month', seatCents: 1100 },
      }),
    },
    state({ status: 'trialing' }),
  )
  expect(html).toContain('First charge then: <b>$108.00</b>.')
  expect(html).toMatch(/<span class="help"><button[^>]*>Switch to monthly<\/button><\/span>/)
  // Said once: the grey total under the price, never a second "Billed yearly" line.
  expect(html.match(/billed yearly/gi)).toHaveLength(1)
  expect(html).toContain('$108 billed yearly')
  expect(html).not.toMatch(/k-btn[^"]*"[^>]*><span>Switch to monthly/)
  expect(html).toContain('Cancel trial')
})

test('a failed recharge: the reason, Retry as the primary button, Buy minutes no longer primary', () => {
  const html = render({
    billingOn: true,
    bill: bill({
      rechargeFailure: { at: new Date().toISOString(), code: 'card_declined', needsAction: false, retriesLeft: 2 },
    }),
  })
  expect(html).toContain('Your last auto-recharge failed')
  // The consequence, with where calls stop; Update card (the Stripe portal) right next to Try again (LIN-780).
  expect(html).toContain('Your card was declined. Calls go on until the balance is -$5.00.')
  expect(html).not.toContain('tries left')
  expect(html).toMatch(/Update card<\/span><\/button><button[^>]*k-btn-primary[^>]*><span>Try again/)
  expect(primaries(html)).toBe(1)
  // Auto-recharge off: not tried again, said with the same consequence.
  const off = render({
    billingOn: true,
    bill: bill({
      autoRecharge: { ...bill().autoRecharge, on: false },
      rechargeFailure: { at: new Date().toISOString(), code: 'card_declined', needsAction: false, retriesLeft: 2 },
    }),
  })
  expect(off).toContain('auto-recharge is off, so it is not tried again. Calls go on until the balance is -$5.00.')
  // No Stripe customer: no portal to open.
  expect(
    render({
      billingOn: true,
      bill: bill({
        hasPortal: false,
        rechargeFailure: { at: new Date().toISOString(), code: 'card_declined', needsAction: false, retriesLeft: 2 },
      }),
    }),
  ).not.toContain('Update card')
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
  // The bank wants a confirmation, not a new card.
  expect(confirm).not.toContain('Update card')
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

test('canceled at the period end: "Ends <date>" badge, who answers until when, Keep my plan, no tax line (LIN-781)', () => {
  const currentPeriodEnd = new Date(Date.UTC(2026, 11, 14, 12)).toISOString()
  const html = render({ billingOn: true, bill: bill({ cancelAtPeriodEnd: true, currentPeriodEnd, taxed: true }) })
  expect(html).toContain('Ends Dec 14')
  expect(html).not.toContain('>Active<')
  expect(html).toContain(
    'Assistant answers calls until <b>Dec 14, 2026</b>. Then the plan ends and nothing more is charged.',
  )
  expect(html).not.toContain('Plus tax where it applies')
  expect(html).toContain('Keep my plan')
  expect(html).not.toContain('Cancel plan')
  // The badge is neutral, not the green of a running plan.
  expect(html).toMatch(/k-badge-neutral[^>]*>[^<]*(<[^>]*>)*Ends Dec 14/)
})

test('a plan that ended: since when, Start plan again with its price, the numbers note; no running-plan cards (LIN-781)', () => {
  const endedAt = new Date(Date.UTC(2026, 10, 14, 12)).toISOString()
  const ended = (over: Partial<BillingOverviewBill> = {}, s: Partial<BillingStateBill> = {}) =>
    render(
      {
        billingOn: true,
        bill: bill({
          status: 'canceled',
          endedAt,
          startAgain: { seatCents: 1100 },
          canBuyMinutes: false,
          balanceMicros: 700_000,
          availableMicros: 700_000,
          taxed: true,
          ...over,
        }),
      },
      state({
        status: 'canceled',
        canceledAt: endedAt,
        numbersReleaseAt: new Date(Date.UTC(2026, 11, 14, 12)).toISOString(),
        dataUntil: new Date(Date.UTC(2027, 1, 12, 12)).toISOString(),
        ...s,
      }),
    )
  const html = ended()
  expect(html).toContain('>Ended<')
  expect(html).toContain('Plan ended on Nov 14, 2026')
  expect(html).toContain('no longer answers calls. Callers hear that you’ll call back.')
  expect(html).toContain('Start plan again')
  expect(html).toContain('$11 a month per workspace, plus tax where it applies')
  expect(primaries(html)).toBe(1)
  // The numbers note: amber, the port-out and export places as links, the dates from the server.
  expect(html).toContain('k-note-warning')
  expect(html).toContain('Your numbers are kept until Dec 14, 2026')
  expect(html).toMatch(/href="#workspace\/phone"[^>]*>port them to another carrier/)
  expect(html).toMatch(/href="#workspace\/export"[^>]*>export your calls/)
  expect(html).toContain('until Feb 12, 2027')
  expect(html).not.toContain('Your plan is canceled')
  // No plan: no auto-recharge, no usage of a period, no calls at the same time; the balance is kept.
  expect(html).not.toContain('id="billing-auto"')
  expect(html).not.toContain('id="billing-usage"')
  expect(html).not.toContain('id="billing-calls"')
  expect(html).toContain('Kept for when you start again.')
  expect(html).toContain('$0.70')
  // Yearly: the price a month first, billed yearly.
  expect(ended({ interval: 'year', startAgain: { seatCents: 10800 }, taxed: false })).toContain(
    '$9 a month per workspace, billed yearly',
  )
  // Not offered (an open dispute, a pause by the team): no button, and the note does not say "start again".
  const held = ended({ startAgain: null })
  expect(held).not.toContain('Start plan again')
  expect(held).not.toContain('Start again before then')
  expect(held).not.toContain('Kept for when you start again.')
  // No numbers: only the calls line.
  expect(ended({}, { numbersReleaseAt: null })).toContain('You can read and')
  expect(ended({}, { numbersReleaseAt: null })).not.toContain('numbers are kept')
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
  // Auto-recharge off is the Auto-recharge card's to say, not the plan's (LIN-780).
  expect(html).not.toContain('Auto-recharge is off until you turn it on below.')
  expect(html).toContain('Off: buy minutes yourself.')
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

test('in the trial: Switch to monthly or yearly next to Cancel; not on a paid plan, a canceled trial or a partner bill', () => {
  const trialEndsAt = new Date(Date.now() + 10 * DAY).toISOString()
  const trialing = (over: Partial<BillingOverviewBill> = {}) =>
    render(
      {
        billingOn: true,
        bill: bill({ status: 'trialing', trialEndsAt, interval: 'year', seatCents: 10800, ...over }),
      },
      state({ status: 'trialing' }),
    )
  const toMonthly = trialing({ intervalSwitch: { interval: 'month', seatCents: 1100 } })
  expect(toMonthly).toContain('Switch to monthly')
  expect(toMonthly).toContain('Cancel trial')
  // Not a second primary button: yearly to monthly is the small link under the first charge.
  expect(toMonthly).toMatch(/<span class="help"><button/)
  expect(
    trialing({ interval: 'month', seatCents: 1100, intervalSwitch: { interval: 'year', seatCents: 10800 } }),
  ).toContain('Switch to yearly')
  // The server offers it only in the trial; canceled, nothing will be charged, so nothing to switch.
  expect(trialing({ intervalSwitch: null })).not.toContain('Switch to')
  expect(trialing({ cancelAtPeriodEnd: true, intervalSwitch: { interval: 'month', seatCents: 1100 } })).not.toContain(
    'Switch to',
  )
  expect(render({ billingOn: true, bill: bill({ intervalSwitch: null }) })).not.toContain('Switch to')
})

test('the switch dialog: the new price a month first, a yearly total as the grey note, nothing charged before the trial ends', () => {
  vi.stubGlobal('document', { activeElement: null })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const trialEndsAt = new Date(Date.UTC(2026, 11, 3, 12)).toISOString()
  const dialog = (to: { interval: 'month' | 'year'; seatCents: number }) =>
    renderToStaticMarkup(
      <IntervalDialog bill={bill({ status: 'trialing', trialEndsAt })} to={to} onClose={() => {}} toast={() => {}} />,
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  const yearly = dialog({ interval: 'year', seatCents: 10800 })
  expect(yearly).toContain('Switch to yearly')
  expect(yearly).toContain('$9 a month per workspace $108 billed yearly')
  expect(yearly).toContain('Nothing is charged until your free trial ends on Dec 3, 2026.')
  const monthly = dialog({ interval: 'month', seatCents: 1100 })
  expect(monthly).toContain('$11 a month per workspace Billed monthly')
})

test('a balance that stops calls, in the Balance card (LIN-780): the consequence, the reason, the fix as the one primary', () => {
  const prompt = {
    stage: 'low' as const,
    paid: true,
    usedMinutes: 50,
    includedMinutes: 50,
    amountCents: 2500,
    thresholdCents: 500,
    capCents: 5000,
    freeUntil: null,
    standardMicrosPerMinute: 50_000,
    card: { id: 'pm_1', brand: 'visa', last4: '4242' },
  }
  const low = bill({
    availableMicros: -2_400_000,
    balanceMicros: -2_400_000,
    autoRecharge: { ...bill().autoRecharge, on: false },
  })
  const balanceCard = (html: string) =>
    html.slice(html.indexOf('id="billing-balance"'), html.indexOf('id="billing-auto"'))
  // Minutes used up on a paid plan with auto-recharge off: Keep calls answered.
  const minutes = balanceCard(render({ billingOn: true, bill: low }, state({ trialMinutes: prompt })))
  expect(minutes).toContain('Calls stop at -$5.00')
  expect(minutes).toContain('You used 50 of your 50 included minutes and auto-recharge is off. After about 52 more')
  expect(minutes).toContain('Keep calls answered')
  expect(minutes).toMatch(/k-btn-secondary[^"]*"[^>]*>.*Buy minutes/)
  // Below the threshold with auto-recharge off: turn it on, its terms in the tooltip.
  const autoOff = render({ billingOn: true, bill: low }, state({ lowBalance: 'auto_recharge_off' }))
  expect(balanceCard(autoOff)).toContain('Your balance is low and auto-recharge is off.')
  expect(balanceCard(autoOff)).toMatch(/title="Off: buy minutes yourself[^"]*"[^>]*><span>Turn on auto-recharge/)
  expect(primaries(autoOff)).toBe(1)
  // The cap reached: raise it.
  const cap = render({ billingOn: true, bill: low }, state({ lowBalance: 'cap_reached' }))
  expect(balanceCard(cap)).toMatch(/Auto-recharge reached this month(&#x27;|')s cap of \$50\./)
  expect(balanceCard(cap)).toContain('Raise the cap')
  expect(primaries(cap)).toBe(1)
  // The trial's minutes gone: the minutes left as the title.
  const trial = render(
    {
      billingOn: true,
      bill: bill({
        status: 'trialing',
        trialEndsAt: new Date(Date.now() + 6 * DAY).toISOString(),
        availableMicros: 0,
        balanceMicros: 0,
        callsStopAtMicros: -500_000,
      }),
    },
    state({ status: 'trialing', trialMinutes: { ...prompt, paid: false, stage: 'grace', freeUntil: null } }),
  )
  expect(balanceCard(trial)).toContain('Calls stop after about 10 more minutes')
  expect(balanceCard(trial)).toContain('Your trial minutes are used up.')
  expect(primaries(trial)).toBe(1)
  // Running normally, or a failed recharge that says more: no balance note.
  expect(balanceCard(render({ billingOn: true, bill: bill() }))).not.toContain('Calls stop')
  const failed = render(
    {
      billingOn: true,
      bill: bill({
        ...low,
        rechargeFailure: { at: new Date().toISOString(), code: 'card_declined', needsAction: false, retriesLeft: 2 },
      }),
    },
    state({ lowBalance: 'cap_reached', rechargeFailed: true }),
  )
  expect(failed).not.toContain('Raise the cap')
  expect(primaries(failed)).toBe(1)
})

test('past due: Update card next to the pay link, as the warning asks for a new card too (LIN-780)', () => {
  const html = render(
    {
      billingOn: true,
      bill: bill({
        status: 'past_due',
        invoices: [{ ...bill().invoices[0]!, status: 'open', url: 'https://invoice.stripe.com/i/2' }],
      }),
    },
    state({ status: 'past_due', suspendsAt: new Date(Date.now() + 2 * DAY).toISOString() }),
  )
  expect(html).toMatch(/Pay \$11\.00 invoice<\/a><button[^>]*k-btn-secondary[^>]*><span>Update card/)
  expect(primaries(html)).toBe(1)
})

test("every date is the bill's day in the workspace's zone, as its emails say it, not the browser's (LIN-785)", () => {
  // The browser is in Berlin, the workspace in Los Angeles. Period ends at 03:00 UTC: Dec 7 in Berlin, Dec 6 in LA.
  const browser = process.env.TZ
  process.env.TZ = 'Europe/Berlin'
  onTestFinished(() => {
    process.env.TZ = browser
  })
  const LA = 'America/Los_Angeles'
  const end = '2026-12-07T03:00:00.000Z'
  const sameRule = (iso: string) => createFormatters('en').date(new Date(iso), inTimeZone({ dateStyle: 'medium' }, LA))
  expect(sameRule(end)).toBe('Dec 6, 2026')
  const running = bill({
    timeZone: LA,
    currentPeriodEnd: end,
    period: { startsAt: '2026-11-07T03:00:00.000Z', endsAt: end, kind: 'month' },
    invoices: [{ ...bill().invoices[0]!, createdAt: '2026-11-07T03:00:00.000Z' }],
  })
  const html = render({ billingOn: true, bill: running })
  expect(html).toContain('Renews on Dec 6, 2026')
  expect(html).toContain('Nov 6, 2026 to Dec 6, 2026')
  expect(html).toContain('Nov 6, 2026')
  expect(html).not.toContain('Dec 7, 2026')
  // Said once, small and grey under the plan's title, because the browser's day can differ.
  expect(html.match(/Dates in Los Angeles time/g)).toHaveLength(1)
  // Canceling: the badge and the "answers calls until" line too.
  const canceling = render({ billingOn: true, bill: { ...running, cancelAtPeriodEnd: true } })
  expect(canceling).toContain('Ends Dec 6')
  expect(canceling).toContain('<b>Dec 6, 2026</b>')

  // A plan that ended at 03:00 UTC: "ended on", "numbers kept until" and "calls until" are the email's days.
  const endedAt = '2026-11-24T03:00:00.000Z'
  const ended = render(
    { billingOn: true, bill: bill({ timeZone: LA, status: 'canceled', endedAt, startAgain: { seatCents: 1100 } }) },
    state({
      status: 'canceled',
      canceledAt: endedAt,
      numbersReleaseAt: '2026-12-24T03:00:00.000Z',
      dataUntil: '2027-02-22T03:00:00.000Z',
    }),
  )
  expect(ended).toContain(`Plan ended on ${sameRule(endedAt)}`)
  expect(ended).toContain('Plan ended on Nov 23, 2026')
  expect(ended).toContain('Your numbers are kept until Dec 23, 2026')
  expect(ended).toContain('until Feb 21, 2027')

  // Someone who does not pay: the usage period in the bill's zone too.
  queries.usage = { usage: { period: running.period, row: null, minutesOnly: false, timeZone: LA } }
  expect(renderToStaticMarkup(<Billing toast={() => {}} view="usage" />)).toContain('Nov 6, 2026 to Dec 6, 2026')

  // The cancel dialog: the end of the plan in the bill's zone (rendered in place, no DOM here).
  vi.stubGlobal('document', { activeElement: null })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  expect(renderToStaticMarkup(<CancelDialog bill={running} onClose={() => {}} toast={() => {}} />)).toContain(
    'Dec 6, 2026',
  )
})

test('the zone note only when the browser can see another day: not in the same zone or one with the same offset', () => {
  const browser = process.env.TZ
  onTestFinished(() => {
    process.env.TZ = browser
  })
  const page = (zone: string) => {
    process.env.TZ = zone
    return render({ billingOn: true, bill: bill({ timeZone: 'America/Los_Angeles' }) })
  }
  expect(page('America/Los_Angeles')).not.toContain('Dates in')
  expect(page('America/Tijuana')).not.toContain('Dates in')
  expect(page('America/New_York')).toContain('Dates in Los Angeles time')
  // An older server sends no zone: the browser's dates, as before, and no note.
  process.env.TZ = 'Europe/Berlin'
  expect(render({ billingOn: true, bill: bill() })).not.toContain('Dates in')
})
