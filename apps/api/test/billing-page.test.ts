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
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PASSKEY_STEP_UP_REQUIRED } from '../src/admin-step-up.ts'
import {
  BILLING_PAGE_CODES,
  billingPageHandlers,
  EXTRA_CALLS_CHANGES_PER_HOUR,
  resetExtraCallsLimit,
} from '../src/billing-page.ts'
import { liveCallLimit } from '../src/handlers.ts'
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
  /**
   * The extra-calls quantities Stripe was asked to set; `refuseExtraCalls`: Stripe answers an error; `cardRefused`: the
   * card is declined for the charged part.
   */
  extraCalls: [] as {
    subscriptionId: string
    priceId: string
    quantity: number
    paidUpTo: number
    charge: boolean
    idempotencyKey: string
  }[],
  refuseExtraCalls: false,
  cardRefused: false,
  /** Runs while Stripe "answers" an extra-calls change. */
  onExtraCalls: null as null | (() => Promise<void>),
  /** The price ids the last catalog sync stored. */
  prices: { extra_calls_monthly: 'price_xc_month', extra_calls_yearly: 'price_xc_year' } as Record<string, string>,
}))
vi.mock('../src/billing-catalog.ts', async original => ({
  ...(await original<typeof import('../src/billing-catalog.ts')>()),
  syncedPrices: async () => cloud.prices,
  syncBillingCatalog: async () => ({ synced: 'skipped' }),
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
    setExtraCallsQuantity: async (input: (typeof cloud.extraCalls)[number]) => {
      await cloud.onExtraCalls?.()
      if (cloud.refuseExtraCalls) throw new Error('Stripe: this subscription is canceled')
      if (cloud.cardRefused && input.charge && input.quantity > input.paidUpTo) return 'payment_failed'
      cloud.extraCalls.push(input)
      return 'updated'
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
  cloud.extraCalls.length = 0
  cloud.refuseExtraCalls = false
  cloud.cardRefused = false
  resetExtraCallsLimit()
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
      autoRecharge: { on: true, thresholdCents: 500, amountCents: 2500 },
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

describe('what the customer reads about the bill (billing tour, G3)', () => {
  test('a recharge on its way, a bill held for review, and the price of an extra number', async () => {
    const b = await billed()
    expect((await overview(b.owner)).bill).toMatchObject({
      rechargePending: null,
      heldForReview: false,
      extraNumberCents: 300,
    })
    await db.insert(billing_recharges).values({ id: rid('rc'), billing_account_id: b.billId, amount_cents: 3000 })
    await db
      .update(billing_accounts)
      .set({ held_for_review_at: at(Date.now()) })
      .where(eq(billing_accounts.id, b.billId))
    expect((await overview(b.owner)).bill).toMatchObject({
      rechargePending: { amountCents: 3000 },
      heldForReview: true,
    })
    const state = await act(b.owner, 'billing.state', {})
    expect(state.body.data.bill.heldForReview).toBe(true)
  })

  test('a comped bill: its numbers are free', async () => {
    const b = await billed({ status: 'comped' })
    expect((await overview(b.owner)).bill.extraNumberCents).toBe(0)
  })
})

describe('billing.workspaceUsage', () => {
  const read = async (who: Caller) => {
    const res = await act(who, 'billing.workspaceUsage', {})
    expect(res.status).toBe(200)
    return res.body.data
  }

  test("a workspace admin reads this workspace's usage only, never another workspace's on the same bill", async () => {
    const b = await billed()
    const other = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, other.id))
    await usage(b, b.ws.id, 'standard', 600, 50)
    await usage(b, other.id, 'premium', 300, 50)
    await db.insert(usage_counters).values([
      { billing_account_id: b.billId, period_id: b.periodId, workspace_id: b.ws.id, included_seconds_used: 600 },
      { billing_account_id: b.billId, period_id: b.periodId, workspace_id: other.id, included_seconds_used: 900 },
    ])
    const admin = await addMember(b.ws.id, 'admin')
    const data = await read({ headers: { ...admin.headers, 'x-workspace-id': b.ws.id } })
    expect(data.usage.period).toMatchObject({ kind: 'month' })
    expect(data.usage.row).toEqual({
      workspaceId: b.ws.id,
      name: 'Brightwater Plumbing & Heating',
      allowanceUsedSeconds: 600,
      allowanceSeconds: 3000,
      levels: { standard: { seconds: 600, micros: 500_000 } },
    })
    // Nothing of the bill itself: no balance, plan or invoices.
    expect(Object.keys(data.usage).sort()).toEqual(['period', 'row'])
  })

  test('no key reads it, like the overview (review of #1098, L-2); an impersonating admin may, read-only', async () => {
    const b = await billed()
    const admin: Actor = {
      actorId: rid('user'),
      role: 'admin',
      workspaceId: b.ws.id,
      permissions: ['settings:write'],
    }
    for (const extra of [
      { apiKeyId: 'key_x' },
      { personalKeyId: 'pk_x' },
      { setupKeyId: 'sk_x', setupWorkspaceId: b.ws.id, setupWorkspaceRole: 'admin' as const },
    ]) {
      const res = await runAction('billing.workspaceUsage', {}, { ...admin, ...extra })
      expect(res.status, Object.keys(extra)[0]).toBe(403)
    }
    // The handler refuses on its own too, whatever the guard in front of it lets through.
    for (const extra of [{ apiKeyId: 'key_x' }, { setupKeyId: 'sk_x' }, { personalKeyId: 'pk_x' }])
      await expect(
        db.transaction(tx =>
          billingPageHandlers['billing.workspaceUsage']!(
            { tx, actor: { ...admin, ...extra }, now: new Date().toISOString() } as unknown as HandlerCtx,
            {},
          ),
        ),
      ).rejects.toThrow(/in the app/)
    const impersonation = { by: rid('user'), sessionId: 'sess', expiresAt: new Date(Date.now() + 60_000) }
    const res = await runAction('billing.workspaceUsage', {}, { ...admin, impersonation })
    expect(res.status).toBe(200)
  })

  test('members are refused; off billing, or a workspace on no bill, there is no usage to show', async () => {
    const b = await billed()
    const memberCaller = await addMember(b.ws.id, 'member')
    expect(
      (await act({ headers: { ...memberCaller.headers, 'x-workspace-id': b.ws.id } }, 'billing.workspaceUsage', {}))
        .status,
    ).toBe(403)
    const unbilled = await createWorkspace('Brightwater South')
    expect(await read(unbilled.owner)).toEqual({ usage: null })
    cloud.on = false
    expect(await read(b.owner)).toEqual({ usage: null })
  })
})

describe('billing.setExtraCalls (LIN-450)', () => {
  const extraOf = async (workspaceId: string) =>
    (await db.select().from(organization).where(eq(organization.id, workspaceId)))[0]!.extraCalls
  const limitOf = (workspaceId: string) => db.transaction(tx => liveCallLimit(tx, workspaceId))
  const set = (who: Caller, workspaceId: string, extraCalls: number) =>
    act(who, 'billing.setExtraCalls', { workspaceId, extraCalls })

  test('the owner buys 5 more: Stripe charges the sum now, the call gate lets 10 in; fewer at once, never refunded', async () => {
    const b = await billed()
    expect(await limitOf(b.ws.id)).toBe(5)
    expect((await overview(b.owner)).bill.calls).toMatchObject({
      includedPerWorkspace: 5,
      extraCallCents: 100,
      step: 5,
      maxExtra: 45,
      canAdd: true,
      paidExtra: 0,
      workspaces: [{ workspaceId: b.ws.id, extraCalls: 0, limit: 5 }],
    })
    const res = await set(b.owner, b.ws.id, 5)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ workspaceId: b.ws.id, extraCalls: 5, limit: 10 })
    expect(cloud.extraCalls).toEqual([
      expect.objectContaining({
        subscriptionId: (await billNow(b.billId)).stripe_subscription_id,
        priceId: 'price_xc_month',
        quantity: 5,
        paidUpTo: 0,
        charge: true,
      }),
    ])
    expect(await extraOf(b.ws.id)).toBe(5)
    expect(await limitOf(b.ws.id)).toBe(10)
    expect(await billNow(b.billId)).toMatchObject({ extra_calls_paid: 5 })
    // Fewer: stored at once, Stripe follows after the commit and is never charged or refunded.
    expect((await set(b.owner, b.ws.id, 0)).status).toBe(200)
    expect(cloud.extraCalls[1]).toMatchObject({ quantity: 0, charge: false })
    expect(await limitOf(b.ws.id)).toBe(5)
  })

  test('lowering then raising again in the same period is not charged twice (review of #1103, M-1)', async () => {
    const b = await billed()
    expect((await set(b.owner, b.ws.id, 20)).status).toBe(200)
    expect((await set(b.owner, b.ws.id, 0)).status).toBe(200)
    expect((await overview(b.owner)).bill.calls.paidExtra).toBe(20)
    // Back up: Stripe is told 20 are paid, so only what is above them is charged.
    expect((await set(b.owner, b.ws.id, 25)).status).toBe(200)
    expect(cloud.extraCalls.at(-1)).toMatchObject({ quantity: 25, paidUpTo: 20, charge: true })
    expect(await billNow(b.billId)).toMatchObject({ extra_calls_paid: 25 })
    // A new period (the renewal moved the period end and charged what was on the bill) starts from that.
    expect((await set(b.owner, b.ws.id, 10)).status).toBe(200)
    await db
      .update(billing_accounts)
      .set({ current_period_end: at(Date.now() + 50 * DAY) })
      .where(eq(billing_accounts.id, b.billId))
    expect((await set(b.owner, b.ws.id, 15)).status).toBe(200)
    expect(cloud.extraCalls.at(-1)).toMatchObject({ quantity: 15, paidUpTo: 10 })
  })

  test('while the renewal has not reached us, nothing counts as paid and raises wait (review of #1103, V-1)', async () => {
    const b = await billed()
    expect((await set(b.owner, b.ws.id, 20)).status).toBe(200)
    expect((await set(b.owner, b.ws.id, 0)).status).toBe(200)
    // Stripe started the new period (and renewed the item at 0); our period end is still the old one.
    await db
      .update(billing_accounts)
      .set({ current_period_end: at(Date.now() - 60_000) })
      .where(eq(billing_accounts.id, b.billId))
    const raise = await set(b.owner, b.ws.id, 20)
    expect(raise.body.code).toBe(BILLING_PAGE_CODES.extraCallsRenewing)
    expect(await extraOf(b.ws.id)).toBe(0)
    expect((await overview(b.owner)).bill.calls.paidExtra).toBe(0)
    // Lowering still works.
    await db.update(organization).set({ extraCalls: 10 }).where(eq(organization.id, b.ws.id))
    expect((await set(b.owner, b.ws.id, 5)).status).toBe(200)
    // Once invoice.paid moved the period end, raises work again and start from what the renewal charged.
    await db
      .update(billing_accounts)
      .set({ current_period_end: at(Date.now() + 30 * DAY) })
      .where(eq(billing_accounts.id, b.billId))
    expect((await set(b.owner, b.ws.id, 20)).status).toBe(200)
    expect(cloud.extraCalls.at(-1)).toMatchObject({ quantity: 20, paidUpTo: 5, charge: true })
  })

  test('a refused card adds nothing; a plan that ends at the period end adds nothing (review of #1103, L-1)', async () => {
    const b = await billed()
    cloud.cardRefused = true
    const refused = await set(b.owner, b.ws.id, 5)
    expect(refused.body.code).toBe(BILLING_PAGE_CODES.extraCallsPaymentFailed)
    expect(await extraOf(b.ws.id)).toBe(0)
    expect(await billNow(b.billId)).toMatchObject({ extra_calls_paid: 0 })
    cloud.cardRefused = false
    await db.update(billing_accounts).set({ cancel_at_period_end: true }).where(eq(billing_accounts.id, b.billId))
    expect((await set(b.owner, b.ws.id, 5)).body.code).toBe(BILLING_PAGE_CODES.extraCallsCanceling)
    expect((await overview(b.owner)).bill.calls.canAdd).toBe(false)
    expect(cloud.extraCalls).toEqual([])
  })

  test('raising needs a recent sign-in; lowering does not; changes are limited per hour (review of #1103, M-1)', async () => {
    const b = await billed({}, 1000)
    await db.update(organization).set({ extraCalls: 10 }).where(eq(organization.id, b.ws.id))
    await ageSession(b.ws.owner.userId)
    expect(await set(b.owner, b.ws.id, 15)).toMatchObject({ status: 409, body: { code: 'SIGN_IN_AGAIN' } })
    expect((await set(b.owner, b.ws.id, 5)).status).toBe(200)
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, b.ws.owner.userId))
    for (let i = 1; i < EXTRA_CALLS_CHANGES_PER_HOUR; i++)
      expect((await set(b.owner, b.ws.id, i % 2 ? 10 : 5)).status, `change ${i + 1}`).toBe(200)
    expect((await set(b.owner, b.ws.id, 15)).body.code).toBe(BILLING_PAGE_CODES.extraCallsTooOften)
  })

  test('a yearly bill pays at its price; a second workspace on the bill adds to the same item', async () => {
    const b = await billed({ interval: 'year' })
    const second = await createWorkspace('Brightwater North')
    await db
      .update(organization)
      .set({ billingAccountId: b.billId, billingState: 'active', extraCalls: 10 })
      .where(eq(organization.id, second.id))
    expect((await set(b.owner, b.ws.id, 5)).status).toBe(200)
    // The 10 already on the bill were paid when they were bought.
    expect(cloud.extraCalls[0]).toMatchObject({ priceId: 'price_xc_year', quantity: 15, paidUpTo: 10, charge: true })
  })

  test('refused: more in the trial, above the most per workspace, off steps of 5, another bill, not the bill owner', async () => {
    const trial = await billed({ status: 'trialing' })
    const inTrial = await set(trial.owner, trial.ws.id, 5)
    expect(inTrial.body.code).toBe(BILLING_PAGE_CODES.extraCallsPaidPlan)
    expect((await overview(trial.owner)).bill.calls.canAdd).toBe(false)
    const b = await billed()
    const tooMany = await set(b.owner, b.ws.id, 50)
    expect(tooMany.body.code).toBe(BILLING_PAGE_CODES.extraCallsAboveMax)
    expect((await set(b.owner, b.ws.id, 7)).status).toBe(422)
    const other = await billed()
    const foreign = await set(b.owner, other.ws.id, 5)
    expect(foreign.body.code).toBe(BILLING_PAGE_CODES.notOnBill)
    const member = await addMember(b.ws.id, 'admin')
    expect((await set(member, b.ws.id, 5)).status).toBe(403)
    expect(cloud.extraCalls).toEqual([])
    expect(await extraOf(b.ws.id)).toBe(0)
  })

  test('Stripe refuses a raise: nothing changes here', async () => {
    const b = await billed()
    cloud.refuseExtraCalls = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await set(b.owner, b.ws.id, 5)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await extraOf(b.ws.id)).toBe(0)
  })

  test('the bill is not locked while Stripe answers: a call can reserve meanwhile (review of #1103, L-2)', async () => {
    const b = await billed()
    let reserved = false
    const answer = cloud.onExtraCalls
    cloud.onExtraCalls = async () => {
      // Another connection takes the bill's balance lock, as a starting call does; it would wait on the old lock.
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '2s'`)
        await lockBalance(tx, b.billId)
        reserved = true
      })
    }
    try {
      expect((await set(b.owner, b.ws.id, 5)).status).toBe(200)
    } finally {
      cloud.onExtraCalls = answer
    }
    expect(reserved).toBe(true)
  })

  test("an instance admin's cap for the bill is the workspace's limit too", async () => {
    const b = await billed({ concurrent_calls_cap: 12 })
    expect(await limitOf(b.ws.id)).toBe(12)
    expect((await overview(b.owner)).bill.calls.workspaces[0].limit).toBe(12)
  })
})
