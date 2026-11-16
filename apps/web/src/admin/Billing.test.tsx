// Server admin › Billing: a bill's page shows what was paid from the ledger's money (never seconds), links its
// invoices to the Stripe Dashboard, and offers only the actions that can run.
import type { AdminBillDetail } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const data: Record<string, unknown> = {}
const useQuery = vi.fn((key: string | null) => ({
  data: key ? data[key] : undefined,
  error: null,
  reload: async () => {},
}))
vi.mock('../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))

const { Billing } = await import('./Billing.tsx')

const bill: AdminBillDetail = {
  id: 'bill_1',
  kind: 'cloud',
  status: 'comped',
  interval: 'month',
  owner: { id: 'u1', email: 'mike@brightwater.example', name: 'Mike Brennan' },
  workspaces: [{ id: 'ws1', name: 'Brightwater Plumbing & Heating' }],
  balanceMicros: 12_500_000,
  reservedMicros: 0,
  heldForReviewAt: null,
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
  renderToStaticMarkup(<Billing id="bill_1" onOpen={() => {}} notify={() => {}} keysRef={{ current: null }} />)

test("a bill's page: paid from the ledger, invoices in the Stripe Dashboard, only the actions that can run", () => {
  data['admin.billing.bill.bill_1'] = bill
  const html = render()
  expect(html).toContain('$0.00')
  expect(html).toContain('href="https://dashboard.stripe.com/test/invoices/in_1"')
  expect(html).toContain('href="https://dashboard.stripe.com/test/customers/cus_1"')
  expect(html).toContain('href="#admin/workspaces/ws1"')
  // Comped: Resume and Suspend, no Comp again.
  expect(html).toContain('Resume…')
  expect(html).toContain('Suspend…')
  expect(html).not.toContain('Comp…')
  // Nothing paid is left to refund, and nobody else to give the bill to: both say why.
  expect(html).toContain('No payment has anything left to refund.')
  expect(html).toContain('No other member to give it to.')
})

test('without Stripe in effect a refund says it needs Stripe, and the bill links nowhere outside', () => {
  data['admin.billing.bill.bill_1'] = { ...bill, dashboardUrl: null }
  const html = render()
  expect(html).toContain('Refunds need billing through Stripe.')
  expect(html).not.toContain('dashboard.stripe.com')
  expect(html).toContain('LD-0001')
})
