// Server admin › Billing: a bill's page shows what was paid from the ledger's money (never seconds), links its
// invoices to the Stripe Dashboard, and offers only the actions that can run.
import type { AdminBillDetail, SelfServeData } from '@linedesk/actions'
import { SIGNUP_DEFAULTS } from '@linedesk/db/types'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const data: Record<string, unknown> = {}
const useQuery = vi.fn((key: string | null) => ({
  data: key ? data[key] : undefined,
  error: null,
  reload: async () => {},
}))
vi.mock('../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))

const { Billing, SelfServeCard, SignupRulesCard } = await import('./Billing.tsx')

const bill: AdminBillDetail = {
  id: 'bill_1',
  kind: 'cloud',
  status: 'comped',
  interval: 'month',
  owner: { id: 'u1', email: 'mike@brightwater.example', name: 'Mike Brennan' },
  workspaces: [{ id: 'ws1', name: 'Brightwater Plumbing & Heating', extraCalls: 10, busyCallers: 0 }],
  balanceMicros: 12_500_000,
  reservedMicros: 0,
  heldForReviewAt: null,
  cardRiskLevel: 'elevated',
  createdAt: '2026-11-01T10:00:00.000Z',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  dashboardUrl: 'https://dashboard.stripe.com/test',
  trialEndsAt: null,
  currentPeriodStart: '2026-11-01T00:00:00.000Z',
  currentPeriodEnd: '2026-12-01T00:00:00.000Z',
  autoRecharge: true,
  rechargeThresholdCents: 500,
  rechargeAmountCents: 2000,
  rechargeCapBaseCents: 5000,
  rechargeCapCents: 5000,
  concurrentCallsCap: null,
  rulesConcurrentCalls: 4,
  suspendReason: null,
  rechargeFailedAt: null,
  // A comped bill's calls record their seconds at $0: paid shows $0.00, not the seconds' price.
  usage: [{ workspaceId: 'ws1', workspaceName: 'Brightwater Plumbing & Heating', seconds: 600, paidMicros: 0 }],
  ledger: [],
  recharges: [],
  invoices: [
    {
      invoiceId: 'in_1',
      kind: 'recharge',
      number: 'LD-0001',
      status: 'paid',
      totalCents: 2000,
      taxCents: 0,
      createdAt: '2026-11-02T10:00:00.000Z',
    },
  ],
  refundable: [],
  members: [{ id: 'u1', email: 'mike@brightwater.example', name: 'Mike Brennan' }],
  otherBills: [],
}

const render = () =>
  renderToStaticMarkup(
    <Billing id="bill_1" onOpen={() => {}} notify={() => {}} keysRef={{ current: null }} data={null} />,
  )

test("a bill's page: paid from the ledger, invoices in the Stripe Dashboard, only the actions that can run", () => {
  data['admin.billing.bill.bill_1'] = bill
  const html = render()
  expect(html).toContain('$0.00')
  expect(html).toContain('href="https://dashboard.stripe.com/test/invoices/in_1"')
  expect(html).toContain('href="https://dashboard.stripe.com/test/customers/cus_1"')
  expect(html).toContain('href="#admin/workspaces/ws1"')
  // The extra calls at the same time the owner bought (LIN-450): on the bill and per workspace.
  expect(html).toContain('10 extra calls bought')
  expect(html).toContain('+10')
  // Comped: Resume and Suspend, no Comp again.
  expect(html).toContain('Resume…')
  expect(html).toContain('Suspend…')
  expect(html).not.toContain('Comp…')
  // Nothing paid is left to refund, and nobody else to give the bill to: both say why.
  expect(html).toContain('No payment has anything left to refund.')
  expect(html).toContain('No other member to give it to.')
  // Radar's risk of the trial's card check is shown, not only stored.
  expect(html).toContain('Radar risk')
  expect(html).toContain('Elevated')
})

test('without Stripe in effect a refund says it needs Stripe, and the bill links nowhere outside', () => {
  data['admin.billing.bill.bill_1'] = { ...bill, dashboardUrl: null }
  const html = render()
  expect(html).toContain('Refunds need billing through Stripe.')
  expect(html).not.toContain('dashboard.stripe.com')
  expect(html).toContain('LD-0001')
})

const selfServe = (over: Partial<SelfServeData>): SelfServeData => ({
  on: true,
  billingInEffect: true,
  open: true,
  closedBecause: null,
  turnstileReady: true,
  rules: SIGNUP_DEFAULTS,
  defaults: SIGNUP_DEFAULTS,
  problems: [],
  termsMissing: [],
  ...over,
})
const renderList = (tab: string | null) =>
  renderToStaticMarkup(<Billing id={tab} onOpen={() => {}} notify={() => {}} keysRef={{ current: null }} data={null} />)
/** Self-serve sign-up and its limits: on Server admin › Settings › Sign-up since LIN-693. */
const renderSignup = () =>
  renderToStaticMarkup(
    <>
      <SelfServeCard notify={() => {}} />
      <SignupRulesCard notify={() => {}} />
    </>,
  )

test('sign-up switched on without Turnstile keys says plainly that it is closed, and why', () => {
  data['admin.billing.selfServe'] = selfServe({
    open: false,
    closedBecause: 'bot_check_missing',
    turnstileReady: false,
  })
  const html = renderSignup()
  expect(html).toContain('Closed')
  expect(html).toContain('Sign-up is switched on but closed: the bot check (Cloudflare Turnstile) has no keys.')
  // The bot check's keys are connected under Providers, like every service's (LIN-693).
  expect(html).toContain('href="#admin/providers/bot_check"')
  // Adding the keys is the fix; the page never points to switching the bot check off.
  expect(html).not.toContain('turn the bot check off')
  expect(html).not.toContain('The bot check is off.')
})

test('sign-up switched on without the terms in the environment is closed and names the variables (A9)', () => {
  data['admin.billing.selfServe'] = selfServe({
    open: false,
    closedBecause: 'terms_missing',
    termsMissing: ['TERMS_VERSION', 'PRIVACY_URL'],
  })
  const html = renderSignup()
  expect(html).toContain('Closed')
  expect(html).toContain('Sign-up is switched on but closed: set TERMS_VERSION, PRIVACY_URL in the server')
})

test('with the bot check off, the sign-up limits warn that only the limits protect the server', () => {
  data['admin.billing.selfServe'] = selfServe({ rules: { ...SIGNUP_DEFAULTS, turnstile: false } })
  const html = renderSignup()
  expect(html).toContain('The bot check is off. Anyone, bots included, can ask for sign-up codes')
})

test('open sign-up says so, and its limits are editable with plain labels', () => {
  data['admin.billing.selfServe'] = selfServe({})
  const html = renderSignup()
  expect(html).toContain('Open')
  expect(html).toContain('Anyone can sign up and start a trial now.')
  expect(html).not.toContain('switched on but closed')
  expect(html).toContain('Sign-up limits')
  expect(html).toContain('Sign-up codes per email address, per hour')
  expect(html).toContain('Blocked email domains')
  expect(html).toContain('Hold for review at Radar risk')
})

test('the bills list filters by status with counted chips and colour badges', () => {
  data['admin.billing.bills'] = [{ ...bill, status: 'trialing' }]
  const html = renderList('bills')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('k-badge-info')
  // Only statuses that have bills get a chip, each with its count.
  expect(html).toContain('Trial<span class="n">1</span>')
  expect(html).not.toContain('Past due<span')
})

test("Billing's own page is one card of part rows, each with its state and the page it opens; no tab strip", () => {
  data['admin.billing.summary'] = {
    billing: { stripeConnected: false },
    selfServe: { on: false, open: false, closedBecause: null, termsMissing: [] },
    bills: { pending_payment: 0, trialing: 1, active: 3, past_due: 1, suspended: 1, canceled: 0, comped: 0 },
    held: 1,
    newTrials: 1,
    events: { waiting: 1, failed: 1, unhandled: 1 },
    automaticTax: false,
  }
  const html = renderList(null)
  expect(html).toContain('Not connected')
  expect(html).toContain('href="#admin/billing/stripe"')
  expect(html).toContain('1 held')
  expect(html).toContain('href="#admin/billing/review"')
  expect(html).toContain('2 owe money')
  expect(html).toContain('href="#admin/billing/bills?status=')
  expect(html).toContain('2 need a look')
  expect(html).toContain('href="#admin/billing/events')
  expect(html).toContain('href="#admin/settings/signup"')
  // Prices and rules has no state, but a row like the others.
  expect(html).toContain('href="#admin/billing/rules"')
  expect(html).toContain('adm-status-nomark')
  // The parts are rows of one list, as on Overview: no second strip of facts, no tabs, no "Bills by status" card.
  expect(html.match(/adm-status-row-link/g)).toHaveLength(6)
  expect(html).not.toContain('ib-tab')
  expect(html).not.toContain('Bills by status')
})

test('a part of Billing shows only that part: no status line, no tabs above it', () => {
  data['admin.billing.bills'] = [{ ...bill, status: 'trialing' }]
  const html = renderList('bills')
  expect(html).not.toContain('ib-tab')
  expect(html).not.toContain('Not connected')
})

test('turning Stripe Tax on: the count of customers without an address shows once asked, "counting" meanwhile (review #1105, N-1)', async () => {
  const { taxChange } = await import('./Billing.tsx')
  const { i18n } = await import('../i18n/index.tsx')
  const t = i18n().t as Parameters<typeof taxChange>[3]
  const note = (missing: number | null | undefined) =>
    renderToStaticMarkup(taxChange({ automaticTax: 'on' }, { automaticTax: 'off' }, missing, t))
  expect(note(undefined)).toContain('Counting paying customers without a billing address')
  expect(note(2)).toContain('2 paying customers have no billing address')
  expect(note(2)).not.toContain('Counting')
  // Not known (billing off, Stripe not answering): only what the switch does.
  expect(note(null)).toContain('Running subscriptions are taxed from their next invoice.')
  expect(note(null)).not.toMatch(/Counting|no billing address/)
  // Turning it off asks nothing.
  expect(renderToStaticMarkup(taxChange({ automaticTax: 'off' }, { automaticTax: 'on' }, undefined, t))).not.toContain(
    'Counting',
  )
})
