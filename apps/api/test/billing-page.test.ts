// Settings › Billing (src/billing-page.ts; docs/billing.md §8, §11 PR 9): the bill owner's overview (plan, balance,
// auto-recharge, cap, usage per workspace and level, a failed recharge, invoices), read through the bill only; the
// owner's changes to auto-recharge and the cap (raising it needs the owner step-up and stays at most $1,000 in
// effect); the Stripe portal; Retry after a failed recharge (3 attempts in 24 hours, a 3D Secure payment confirmed on
// its invoice page instead). Billing is switched on by replacing billingState, and Stripe is a fake provider: this
// file is instance-wide.
import type { BillingProvider } from '@linedesk/billing'
import {
  billing_accounts,
  billing_invoices,
  billing_periods,
  billing_recharges,
  organization,
  passkey,
  session,
  usage_counters,
} from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PASSKEY_STEP_UP_REQUIRED } from '../src/admin-step-up.ts'
import { BILLING_PAGE_CODES, billingPageHandlers } from '../src/billing-page.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import type { HandlerCtx } from '../src/handler-context.ts'
import { BILLING_RECHARGE, setJobQueue } from '../src/jobs.ts'
import { lockBalance, postEntry } from '../src/ledger.ts'
import { runAction } from '../src/run-action.ts'
import { act, addMember, type Caller, createWorkspace, type Workspace } from './helpers.ts'

const cloud = vi.hoisted(() => ({
  on: true,
  portal: [] as { customerId: string; returnUrl: string }[],
  invoicePages: [] as string[],
  /** Runs while the invoice page is fetched, before the handler's transaction (a change in between). */
  onInvoicePage: null as null | (() => Promise<void>),
  /** Stripe has no payment page for the invoice right now. */
  noInvoicePage: false,
  /** What each subscription charges a seat, as Stripe has it (by subscription id); one not here is not known. */
  seats: new Map<string, { lookupKey: string; cents: number }>(),
  subscriptionReads: 0,
}))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  const provider = {
    name: 'stripe',
    portalSession: async (input: { customerId: string; returnUrl: string }) => {
      cloud.portal.push(input)
      return 'https://billing.stripe.test/p/session/test_1'
    },
    subscription: async (id: string) => {
      cloud.subscriptionReads++
      const seat = cloud.seats.get(id)
      if (!seat) return null
      return {
        id,
        items: [
          { lookupKey: seat.lookupKey, quantity: 1, unitAmountCents: seat.cents, productId: 'linedesk_workspace' },
        ],
      }
    },
    rechargeInvoicePage: async (id: string) => {
      cloud.invoicePages.push(id)
      await cloud.onInvoicePage?.()
      return cloud.noInvoicePage ? null : `https://invoice.stripe.test/i/${id}`
    },
  } as unknown as BillingProvider
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
    billingProvider: async () => provider,
  }
})

let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  cloud.on = true
  cloud.portal.length = 0
  cloud.invoicePages.length = 0
  cloud.onInvoicePage = null
  cloud.noInvoicePage = false
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
    insert: async () => [],
  } as never)
})
afterEach(() => setJobQueue(null))

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const DAY = 86_400_000
const at = (ms: number) => new Date(ms).toISOString()
const rechargesQueued = () => queued.filter(j => j.name === BILLING_RECHARGE)

type Billed = { ws: Workspace; owner: Caller; billId: string; periodId: string }

/** `ws` on an active bill with a Stripe customer, a current period and `balanceCents` credited. */
async function billed(over: Partial<typeof billing_accounts.$inferInsert> = {}, balanceCents = 1000): Promise<Billed> {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const billId = rid('bill')
  const periodId = rid('bp')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: ws.owner.userId,
    status: 'active',
    stripe_customer_id: rid('cus'),
    stripe_subscription_id: rid('sub'),
    current_period_end: at(Date.now() + 20 * DAY),
    ...over,
  })
  await db.insert(billing_periods).values({
    id: periodId,
    billing_account_id: billId,
    starts_at: at(Date.now() - 10 * DAY),
    ends_at: at(Date.now() + 20 * DAY),
    kind: 'month',
  })
  await db
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'active' })
    .where(eq(organization.id, ws.id))
  if (balanceCents)
    await db.transaction(async tx => {
      await lockBalance(tx, billId)
      await postEntry(tx, {
        billing_account_id: billId,
        period_id: periodId,
        kind: 'credit',
        amount_micros: balanceCents * 10_000,
        source_type: 'admin',
        source_id: rid('credit'),
      })
    })
  return { ws, owner: ws.owner, billId, periodId }
}

/** A usage entry of `seconds` at `level` for `workspaceId`, costing `cents`. */
async function usage(
  b: Billed,
  workspaceId: string,
  level: 'standard' | 'premium' | 'ultra',
  seconds: number,
  cents: number,
) {
  await db.transaction(async tx => {
    await lockBalance(tx, b.billId)
    await postEntry(tx, {
      billing_account_id: b.billId,
      workspace_id: workspaceId,
      period_id: b.periodId,
      kind: 'usage',
      amount_micros: -cents * 10_000,
      seconds,
      included_seconds: 0,
      billable_seconds: seconds,
      price_basis: level,
      source_type: 'call',
      source_id: rid('call'),
    })
  })
}

const billNow = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
const overview = async (who: Caller) => {
  const res = await act(who, 'billing.overview', {})
  expect(res.status).toBe(200)
  return res.body.data
}
/** A session left open for two days: the owner step-up applies. */
const ageSession = (userId: string) =>
  db
    .update(session)
    .set({ createdAt: new Date(Date.now() - 2 * DAY) })
    .where(eq(session.userId, userId))

describe('billing.overview', () => {
  test("the seat price is what the bill's subscription charges, not the install's price now (review of #1040, L-4)", async () => {
    // Subscribed at $9 a month before the admin raised the price to the default $11.
    const subscriptionId = rid('sub')
    cloud.seats.set(subscriptionId, { lookupKey: 'ws_monthly', cents: 900 })
    const b = await billed({ stripe_subscription_id: subscriptionId })
    expect((await overview(b.owner)).bill.seatCents).toBe(900)
    // Read from Stripe once, then reused for the page.
    const reads = cloud.subscriptionReads
    expect((await overview(b.owner)).bill.seatCents).toBe(900)
    expect(cloud.subscriptionReads).toBe(reads)
    // A subscription Stripe does not answer for, or a bill without one: the install's price.
    expect((await overview((await billed({ stripe_subscription_id: rid('sub') })).owner)).bill.seatCents).toBe(1100)
    const pending = await billed({ status: 'pending_payment', stripe_subscription_id: null })
    expect((await overview(pending.owner)).bill.seatCents).toBe(1100)
  })

  test('the bill owner sees the plan, balance, recharge settings, usage per level and invoices', async () => {
    const b = await billed({ interval: 'year' }, 2500)
    await usage(b, b.ws.id, 'standard', 600, 50)
    await usage(b, b.ws.id, 'premium', 120, 20)
    await usage(b, b.ws.id, 'premium', 60, 10)
    await db.insert(usage_counters).values({
      billing_account_id: b.billId,
      period_id: b.periodId,
      workspace_id: b.ws.id,
      included_seconds_used: 1200,
    })
    await db.insert(billing_invoices).values([
      {
        stripe_invoice_id: rid('in'),
        billing_account_id: b.billId,
        kind: 'subscription',
        number: 'LD-0001',
        status: 'paid',
        total_cents: 10_800,
        hosted_invoice_url: 'https://invoice.stripe.test/i/1',
        pdf_url: 'https://pay.stripe.test/1.pdf',
      },
      // A draft is not the owner's yet: not listed.
      {
        stripe_invoice_id: rid('in'),
        billing_account_id: b.billId,
        kind: 'recharge',
        status: 'draft',
        total_cents: 2000,
      },
    ])
    const data = await overview(b.owner)
    expect(data.billingOn).toBe(true)
    expect(data.bill).toMatchObject({
      status: 'active',
      interval: 'year',
      seatCents: 10_800,
      workspaces: 1,
      cancelAtPeriodEnd: false,
      balanceMicros: (2500 - 80) * 10_000,
      availableMicros: (2500 - 80) * 10_000,
      autoRecharge: { on: true, thresholdCents: 500, amountCents: 2000 },
      cap: { baseCents: 5000, effectiveCents: 5000, usedThisMonthCents: 0, ownerMaxBaseCents: 100_000 },
      rechargeFailure: null,
      canBuyMinutes: true,
      hasPortal: true,
      period: { kind: 'month' },
    })
    expect(data.bill.usage).toEqual([
      {
        workspaceId: b.ws.id,
        name: 'Brightwater Plumbing & Heating',
        allowanceUsedSeconds: 1200,
        allowanceSeconds: 3000,
        levels: {
          standard: { seconds: 600, micros: 500_000 },
          premium: { seconds: 180, micros: 300_000 },
        },
      },
    ])
    expect(data.bill.invoices).toEqual([
      expect.objectContaining({
        number: 'LD-0001',
        status: 'paid',
        totalCents: 10_800,
        url: 'https://invoice.stripe.test/i/1',
      }),
    ])
  })

  test('only through the bill: another bill, its usage and invoices never show (tenancy)', async () => {
    const mine = await billed()
    const other = await billed()
    await usage(other, other.ws.id, 'standard', 60, 5)
    await db.insert(billing_invoices).values({
      stripe_invoice_id: rid('in'),
      billing_account_id: other.billId,
      kind: 'subscription',
      status: 'paid',
      total_cents: 1100,
    })
    const data = await overview(mine.owner)
    expect(data.bill.invoices).toEqual([])
    expect(data.bill.usage.map((u: { workspaceId: string }) => u.workspaceId)).toEqual([mine.ws.id])
  })

  test('nobody but the bill owner: an admin is refused, a workspace owner who does not pay gets no bill', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    expect(
      (await act({ headers: { ...admin.headers, 'x-workspace-id': b.ws.id } }, 'billing.overview', {})).status,
    ).toBe(403)
    // The bill is someone else's (handed over): the workspace owner sees none of it.
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    expect(await overview(b.owner)).toEqual({ billingOn: true, bill: null })
  })

  test('never to an impersonation, an API key, a personal key or a setup link: the invoice links work without a login (review of #1007, M-1)', async () => {
    const b = await billed()
    await db.insert(billing_invoices).values({
      stripe_invoice_id: rid('in'),
      billing_account_id: b.billId,
      kind: 'recharge',
      status: 'open',
      total_cents: 2000,
      hosted_invoice_url: 'https://invoice.stripe.test/i/open',
      pdf_url: 'https://pay.stripe.test/open.pdf',
    })
    const owner: Actor = {
      actorId: b.ws.owner.userId,
      role: 'owner',
      workspaceId: b.ws.id,
      permissions: ['billing:manage'],
    }
    const impersonation = { by: rid('user'), sessionId: 'sess', expiresAt: new Date(Date.now() + 60_000) }
    for (const extra of [
      { impersonation },
      { apiKeyId: 'key_x' },
      { personalKeyId: 'pk_x' },
      { setupKeyId: 'sk_x', setupWorkspaceId: b.ws.id, setupWorkspaceRole: 'owner' as const },
    ]) {
      const res = await runAction('billing.overview', {}, { ...owner, ...extra })
      expect(res.status, Object.keys(extra)[0]).toBe(403)
      expect(JSON.stringify(res.body)).not.toContain('stripe.test')
    }
    // The handler refuses on its own too, whatever the guard in front of it lets through.
    for (const extra of [{ impersonation }, { apiKeyId: 'key_x' }, { setupKeyId: 'sk_x' }, { personalKeyId: 'pk_x' }])
      await expect(
        db.transaction(tx =>
          billingPageHandlers['billing.overview']!(
            {
              tx,
              actor: { ...owner, ...extra },
              now: new Date().toISOString(),
            } as unknown as HandlerCtx,
            {},
          ),
        ),
      ).rejects.toThrow(/signed in|owner/)
    // The owner, signed in as themselves: the invoice's page, and no PDF link of our own (I-1).
    const [invoice] = (await overview(b.owner)).bill.invoices
    expect(invoice).toMatchObject({ url: 'https://invoice.stripe.test/i/open' })
    expect(invoice).not.toHaveProperty('pdfUrl')
  })

  test('billing off on the server: no bill, whatever the workspace was', async () => {
    const b = await billed()
    cloud.on = false
    expect(await overview(b.owner)).toEqual({ billingOn: false, bill: null })
  })
})

describe('billing.setAutoRecharge', () => {
  test('the owner turns it off and on; on with a low balance starts a recharge at once', async () => {
    const b = await billed({}, 300)
    const off = await act(b.owner, 'billing.setAutoRecharge', { on: false, thresholdCents: 1000, amountCents: 3000 })
    expect(off.body.data).toEqual({ on: false, thresholdCents: 1000, amountCents: 3000, recharging: false })
    expect(await billNow(b.billId)).toMatchObject({
      auto_recharge: false,
      recharge_threshold_cents: 1000,
      recharge_amount_cents: 3000,
    })
    expect(rechargesQueued()).toEqual([])
    const on = await act(b.owner, 'billing.setAutoRecharge', { on: true, thresholdCents: 1000, amountCents: 3000 })
    expect(on.body.data.recharging).toBe(true)
    const [attempt] = await db
      .select()
      .from(billing_recharges)
      .where(eq(billing_recharges.billing_account_id, b.billId))
    expect(attempt).toMatchObject({ status: 'pending', amount_cents: 3000 })
    expect(rechargesQueued()).toEqual([expect.objectContaining({ data: { rechargeId: attempt!.id } })])
  })

  test('the amount must clear the threshold by $5, and limits hold', async () => {
    const b = await billed()
    expect(
      (await act(b.owner, 'billing.setAutoRecharge', { on: true, thresholdCents: 2000, amountCents: 2000 })).status,
    ).toBe(422)
    expect(
      (await act(b.owner, 'billing.setAutoRecharge', { on: true, thresholdCents: 500, amountCents: 60_000 })).status,
    ).toBe(422)
  })

  test('not while the bill is suspended (a disputed or fraud-warned card is not turned back on)', async () => {
    const b = await billed({ status: 'suspended', suspend_reason: 'early_fraud_warning', auto_recharge: false })
    const res = await act(b.owner, 'billing.setAutoRecharge', { on: true, thresholdCents: 500, amountCents: 2000 })
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.notRunning } })
    expect((await billNow(b.billId)).auto_recharge).toBe(false)
  })

  test('only the bill owner', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    const res = await act(b.owner, 'billing.setAutoRecharge', { on: false, thresholdCents: 500, amountCents: 2000 })
    expect(res.status).toBe(403)
  })
})

describe('billing.setRechargeCap', () => {
  test('lowering needs no step-up; raising does, and a fresh sign-in passes', async () => {
    const b = await billed()
    await ageSession(b.ws.owner.userId)
    expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 3000 })).body.data).toEqual({
      baseCents: 3000,
      effectiveCents: 3000,
      recharging: false,
    })
    const raise = await act(b.owner, 'billing.setRechargeCap', { baseCents: 20_000 })
    expect(raise).toMatchObject({ status: 409, body: { code: 'SIGN_IN_AGAIN' } })
    expect((await billNow(b.billId)).recharge_cap_base_cents).toBe(3000)
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, b.ws.owner.userId))
    expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 20_000 })).status).toBe(200)
    expect((await billNow(b.billId)).recharge_cap_base_cents).toBe(20_000)
  })

  test('raising with a passkey on the account needs a passkey sign-in, a fresh password sign-in is not enough', async () => {
    const b = await billed()
    await db.insert(passkey).values({
      id: rid('pk'),
      userId: b.ws.owner.userId,
      publicKey: 'cHVibGlj',
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
    // An install on https, where passkeys work (a local-only install drops the passkey step).
    const secondFactor = process.env.ADMIN_SECOND_FACTOR
    process.env.ADMIN_SECOND_FACTOR = 'on'
    try {
      const raise = await act(b.owner, 'billing.setRechargeCap', { baseCents: 20_000 })
      expect(raise).toMatchObject({ status: 409, body: { code: PASSKEY_STEP_UP_REQUIRED } })
      expect((await billNow(b.billId)).recharge_cap_base_cents).toBe(5000)
      // Lowering still needs none.
      expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 3000 })).status).toBe(200)
      await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, b.ws.owner.userId))
      expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 20_000 })).status).toBe(200)
    } finally {
      if (secondFactor === undefined) delete process.env.ADMIN_SECOND_FACTOR
      else process.env.ADMIN_SECOND_FACTOR = secondFactor
    }
  })

  test('only the bill owner, and not while suspended', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 3000 })).status).toBe(403)
    const held = await billed({ status: 'suspended', suspend_reason: 'dispute' })
    const res = await act(held.owner, 'billing.setRechargeCap', { baseCents: 3000 })
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.notRunning } })
    expect((await billNow(held.billId)).recharge_cap_base_cents).toBe(5000)
  })

  test('at most $1,000 in effect: each further workspace takes $25 off the base the owner may set', async () => {
    const b = await billed()
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    expect((await overview(b.owner)).bill.cap.ownerMaxBaseCents).toBe(97_500)
    const res = await act(b.owner, 'billing.setRechargeCap', { baseCents: 98_000 })
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.capAboveOwnerMax } })
    expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 97_500 })).body.data.effectiveCents).toBe(100_000)
  })
})

describe('billing.openPortal', () => {
  test("the owner gets a portal session for the bill's customer that returns to Settings › Billing", async () => {
    const b = await billed()
    const res = await act(b.owner, 'billing.openPortal', {})
    expect(res.body.data).toEqual({ url: 'https://billing.stripe.test/p/session/test_1' })
    const { stripe_customer_id } = await billNow(b.billId)
    expect(cloud.portal).toEqual([
      { customerId: stripe_customer_id, returnUrl: `http://localhost:5173/#workspace/billing?ws=${b.ws.id}` },
    ])
  })

  test('only the bill owner: nobody else gets a portal session for the bill', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    expect((await act(b.owner, 'billing.openPortal', {})).status).toBe(403)
    expect(cloud.portal).toEqual([])
  })

  test('no Stripe customer yet: no portal', async () => {
    const b = await billed({ stripe_customer_id: null })
    const res = await act(b.owner, 'billing.openPortal', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.noCustomer } })
    expect(cloud.portal).toEqual([])
  })
})

describe('billing.retryRecharge (docs/billing.md §3.4)', () => {
  async function failedRecharge(b: Billed, status: 'failed' | 'canceled', ago = DAY * 2) {
    const id = rid('rc')
    await db.insert(billing_recharges).values({
      id,
      billing_account_id: b.billId,
      amount_cents: 2000,
      status,
      failure_code: status === 'failed' ? 'authentication_required' : 'card_declined',
      stripe_invoice_id: rid('in'),
      created_at: at(Date.now() - ago),
      resolved_at: at(Date.now() - ago),
    })
    await db
      .update(billing_accounts)
      .set({ recharge_failed_at: at(Date.now() - ago) })
      .where(eq(billing_accounts.id, b.billId))
    return id
  }

  test('a declined card: Retry clears the wait and charges a new attempt', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'canceled')
    const before = (await overview(b.owner)).bill.rechargeFailure
    expect(before).toMatchObject({ code: 'card_declined', needsAction: false, retriesLeft: 3 })
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res.body.data).toEqual({ kind: 'retrying' })
    expect((await billNow(b.billId)).recharge_failed_at).toBeNull()
    expect(rechargesQueued()).toHaveLength(1)
  })

  test('3D Secure: the invoice page to confirm on, no second charge', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'failed')
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res.body.data).toEqual({
      kind: 'confirm',
      url: expect.stringMatching(/^https:\/\/invoice\.stripe\.test\/i\/in_/),
    })
    expect(cloud.invoicePages).toHaveLength(1)
    expect((await billNow(b.billId)).recharge_failed_at).not.toBeNull()
    expect(rechargesQueued()).toEqual([])
  })

  test('no payment page from Stripe now: a refusal with its code, never a second charge', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'failed')
    cloud.noInvoicePage = true
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.invoicePageUnavailable } })
    expect(rechargesQueued()).toEqual([])
  })

  test('at most 3 attempts in 24 hours', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'canceled', 3_600_000)
    await failedRecharge(b, 'canceled', 1_800_000)
    await failedRecharge(b, 'canceled', 600_000)
    expect((await overview(b.owner)).bill.rechargeFailure.retriesLeft).toBe(0)
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.retryLimit } })
    expect(rechargesQueued()).toEqual([])
  })

  test('nothing failed: nothing to retry', async () => {
    const b = await billed()
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.noFailure } })
  })

  test('only the bill owner', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'canceled')
    const admin = await addMember(b.ws.id, 'admin')
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    expect((await act(b.owner, 'billing.retryRecharge', {})).status).toBe(403)
    expect((await billNow(b.billId)).recharge_failed_at).not.toBeNull()
    expect(rechargesQueued()).toEqual([])
  })

  test('not on a bill held for a fraud warning, a dispute or by an admin, nor a canceled one: no payment page, no charge (L-1)', async () => {
    for (const over of [
      { status: 'suspended' as const, suspend_reason: 'early_fraud_warning' as const },
      { status: 'suspended' as const, suspend_reason: 'dispute' as const },
      { status: 'suspended' as const, suspend_reason: 'admin' as const },
      { status: 'canceled' as const },
    ]) {
      for (const kind of ['failed', 'canceled'] as const) {
        const b = await billed(over, 100)
        await failedRecharge(b, kind)
        const res = await act(b.owner, 'billing.retryRecharge', {})
        expect(res, `${over.status} ${kind}`).toMatchObject({
          status: 409,
          body: { code: BILLING_PAGE_CODES.notRunning },
        })
        expect((await billNow(b.billId)).recharge_failed_at).not.toBeNull()
      }
    }
    expect(cloud.invoicePages).toEqual([])
    expect(rechargesQueued()).toEqual([])
  })

  test('suspended for a missed payment: the 3D Secure page still opens, but no new charge is made', async () => {
    const confirm = await billed({ status: 'suspended', suspend_reason: 'payment' }, 100)
    await failedRecharge(confirm, 'failed')
    expect((await act(confirm.owner, 'billing.retryRecharge', {})).body.data).toMatchObject({ kind: 'confirm' })
    const declined = await billed({ status: 'suspended', suspend_reason: 'payment' }, 100)
    await failedRecharge(declined, 'canceled')
    const res = await act(declined.owner, 'billing.retryRecharge', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.notRunning } })
    expect(rechargesQueued()).toEqual([])
  })

  test('the 3D Secure attempt changed while its page was fetched: refused, never a stale page (L-1)', async () => {
    const b = await billed({}, 100)
    const id = await failedRecharge(b, 'failed')
    cloud.onInvoicePage = async () => {
      await db.update(billing_recharges).set({ status: 'paid' }).where(eq(billing_recharges.id, id))
    }
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res.status).toBe(409)
    expect(res.body.data).toBeUndefined()
    expect(rechargesQueued()).toEqual([])
    // And the bill suspended in between: refused under the lock as well.
    const held = await billed({}, 100)
    await failedRecharge(held, 'failed')
    cloud.onInvoicePage = async () => {
      await db
        .update(billing_accounts)
        .set({ status: 'suspended', suspend_reason: 'early_fraud_warning' })
        .where(eq(billing_accounts.id, held.billId))
    }
    const late = await act(held.owner, 'billing.retryRecharge', {})
    expect(late).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.notRunning } })
  })

  test('auto-recharge off: refused, and the failure stays recorded so turning it on waits for a new card (L-2)', async () => {
    const b = await billed({ auto_recharge: false }, 100)
    await failedRecharge(b, 'canceled')
    const failedAt = (await billNow(b.billId)).recharge_failed_at
    const res = await act(b.owner, 'billing.retryRecharge', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.autoRechargeOff } })
    expect((await billNow(b.billId)).recharge_failed_at).toBe(failedAt)
    // Turned on again: the declined card is not charged at once.
    const on = await act(b.owner, 'billing.setAutoRecharge', { on: true, thresholdCents: 500, amountCents: 2000 })
    expect(on.body.data.recharging).toBe(false)
    expect(rechargesQueued()).toEqual([])
  })

  test('pressed four times at once: one new attempt, the others find nothing to retry', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'canceled')
    const results = await Promise.all([1, 2, 3, 4].map(() => act(b.owner, 'billing.retryRecharge', {})))
    expect(results.filter(r => r.status === 200).map(r => r.body.data)).toEqual([{ kind: 'retrying' }])
    expect(results.filter(r => r.status === 409).map(r => r.body.code)).toEqual([
      BILLING_PAGE_CODES.noFailure,
      BILLING_PAGE_CODES.noFailure,
      BILLING_PAGE_CODES.noFailure,
    ])
    const pending = await db.select().from(billing_recharges).where(eq(billing_recharges.billing_account_id, b.billId))
    expect(pending.filter(r => r.status === 'pending')).toHaveLength(1)
    expect(rechargesQueued()).toHaveLength(1)
  })
})

describe('billing.state: the banner flags (review of #1007, I-4)', () => {
  const stateOf = async (who: Caller) => (await act(who, 'billing.state', {})).body.data.bill

  test('a recharge to confirm, a low balance with auto-recharge off, the cap reached; nothing while it runs normally', async () => {
    const fine = await billed({}, 1000)
    expect(await stateOf(fine.owner)).toMatchObject({ rechargeNeedsAction: false, lowBalance: null })
    const off = await billed({ auto_recharge: false }, 100)
    expect((await stateOf(off.owner)).lowBalance).toBe('auto_recharge_off')
    const capped = await billed({}, 100)
    await db.insert(billing_recharges).values({
      id: rid('rc'),
      billing_account_id: capped.billId,
      amount_cents: 4000,
      status: 'paid',
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    })
    expect((await stateOf(capped.owner)).lowBalance).toBe('cap_reached')
    // Auto-recharge on with room under the cap: a recharge lifts it, no banner.
    expect((await stateOf((await billed({}, 100)).owner)).lowBalance).toBeNull()
    const confirm = await billed({}, 100)
    await db.insert(billing_recharges).values({
      id: rid('rc'),
      billing_account_id: confirm.billId,
      amount_cents: 2000,
      status: 'failed',
      failure_code: 'authentication_required',
      stripe_invoice_id: rid('in'),
      created_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    })
    await db
      .update(billing_accounts)
      .set({ recharge_failed_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, confirm.billId))
    expect(await stateOf(confirm.owner)).toMatchObject({ rechargeFailed: true, rechargeNeedsAction: true })
  })
})
