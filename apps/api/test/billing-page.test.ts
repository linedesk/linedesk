// Settings › Billing (src/billing-page.ts): the overview of who manages the bill (its
// owner, or an owner or admin of its only workspace: managesBill) (plan, balance,
// auto-recharge, cap, usage per workspace and level, a failed recharge, invoices), read through the bill only; the
// owner's changes to auto-recharge and the cap (raising it needs the owner step-up and stays at most $1,000 in
// effect); the Stripe portal; Retry after a failed recharge (3 attempts in 24 hours, a 3D Secure payment confirmed on
// its invoice page instead). Billing is switched on by replacing billingState, and Stripe is a fake provider: this
// file is instance-wide.
import type { BillingProvider } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_invoices,
  billing_periods,
  billing_recharges,
  organization,
  passkey,
  session,
  terms_acceptances,
  usage_counters,
  workspace_settings,
} from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PASSKEY_STEP_UP_REQUIRED } from '../src/admin-step-up.ts'
import {
  BILLING_PAGE_CODES,
  billingPageHandlers,
  EXTRA_CALLS_CHANGES_PER_HOUR,
  INTERVAL_CHANGES_PER_HOUR,
  resetExtraCallsLimit,
  resetIntervalLimit,
} from '../src/billing-page.ts'
import { BILLING_LIFECYCLE_EMAIL } from '../src/billing-periods.ts'
import { DEFAULT_TIME_ZONE } from '../src/bookings.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import type { HandlerCtx } from '../src/handler-context.ts'
import { liveCallLimit } from '../src/handlers.ts'
import { BILLING_RECHARGE, setJobQueue } from '../src/jobs.ts'
import { lockBalance, postEntry } from '../src/ledger.ts'
import { todayIn } from '../src/public-holidays.ts'
import { runAction } from '../src/run-action.ts'
import { act, addMember, type Caller, createWorkspace, type Workspace } from './helpers.ts'

const cloud = vi.hoisted(() => ({
  on: true,
  portal: [] as { customerId: string; returnUrl: string }[],
  invoicePages: [] as string[],
  /** Runs while the invoice page is fetched, before the handler's transaction (a change in between). */
  onInvoicePage: null as null | (() => Promise<void>),
  /** Runs once when an action takes the provider, after its first read of the bill and before Stripe is asked. */
  onProvider: null as null | (() => Promise<void>),
  /** Stripe has no payment page for the invoice right now. */
  noInvoicePage: false,
  /** What each subscription charges a seat, as Stripe has it (by subscription id); one not here is not known. */
  /** Each subscription's plan items; `productId` defaults to the workspace seat's product. */
  seats: new Map<
    string,
    { lookupKey: string; cents: number; productId?: string }[] | { lookupKey: string; cents: number }
  >(),
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
  /** The interval switches Stripe was asked for; `intervalAnswer`: what Stripe answers (it may have ended the trial). */
  intervals: [] as {
    subscriptionId: string
    interval: string
    priceIds: Record<string, string>
    idempotencyKey: string
  }[],
  intervalAnswer: 'updated' as 'updated' | 'unchanged' | 'not_trialing' | 'unknown_item',
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
        items: [seat].flat().map(item => ({
          lookupKey: item.lookupKey,
          quantity: 1,
          unitAmountCents: item.cents,
          productId: ('productId' in item && item.productId) || 'linedesk_workspace',
        })),
      }
    },
    setExtraCallsQuantity: async (input: (typeof cloud.extraCalls)[number]) => {
      await cloud.onExtraCalls?.()
      if (cloud.refuseExtraCalls) throw new Error('Stripe: this subscription is canceled')
      if (cloud.cardRefused && input.charge && input.quantity > input.paidUpTo) return 'payment_failed'
      cloud.extraCalls.push(input)
      return 'updated'
    },
    setPlanInterval: async (input: (typeof cloud.intervals)[number]) => {
      cloud.intervals.push(input)
      return cloud.intervalAnswer
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
    billingProvider: async () => {
      const hook = cloud.onProvider
      cloud.onProvider = null
      await hook?.()
      return provider
    },
  }
})

let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  cloud.on = true
  cloud.portal.length = 0
  cloud.invoicePages.length = 0
  cloud.onInvoicePage = null
  cloud.onProvider = null
  cloud.noInvoicePage = false
  cloud.extraCalls.length = 0
  cloud.refuseExtraCalls = false
  cloud.cardRefused = false
  cloud.intervals.length = 0
  cloud.intervalAnswer = 'updated'
  resetExtraCallsLimit()
  resetIntervalLimit()
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
    // A bill whose owner turned auto-recharge on (it starts off since 2026-11-17).
    auto_recharge: true,
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

/**
 * The bill pays for a second workspace too, and someone else (an admin of `b.ws`) owns it: neither the workspace's
 * owner nor its admins manage it any more (managesBill: a bill of several workspaces is its owner's alone).
 */
async function shareBill(b: Billed) {
  const second = await createWorkspace('Brightwater North')
  await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
  const payer = await addMember(b.ws.id, 'admin')
  await db.update(billing_accounts).set({ owner_user_id: payer.userId }).where(eq(billing_accounts.id, b.billId))
  return { second, payer }
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

  test("a partner bill: the base fee and each client workspace's price, both as its subscription charges them", async () => {
    // Before Checkout: the install's prices, the yearly partner base fee and a client workspace's seat.
    const pending = await billed({
      kind: 'partner',
      interval: 'year',
      status: 'pending_payment',
      stripe_subscription_id: null,
    })
    expect((await overview(pending.owner)).bill).toMatchObject({
      kind: 'partner',
      seatCents: 16_800,
      clientSeatCents: 10_800,
      workspaces: 1,
    })
    // Subscribed on older prices: each item read from the subscription, the base fee by its own product.
    const subscriptionId = rid('sub')
    cloud.seats.set(subscriptionId, [
      { lookupKey: 'partner_monthly', cents: 1500, productId: 'linedesk_partner' },
      { lookupKey: 'ws_monthly', cents: 900 },
    ])
    const running = await billed({ kind: 'partner', stripe_subscription_id: subscriptionId })
    expect((await overview(running.owner)).bill).toMatchObject({
      kind: 'partner',
      seatCents: 1500,
      clientSeatCents: 900,
    })
    // No client yet: the subscription has the base fee alone, the seat is the install's price.
    const alone = rid('sub')
    cloud.seats.set(alone, [{ lookupKey: 'partner_monthly', cents: 1900, productId: 'linedesk_partner' }])
    const first = await billed({ kind: 'partner', stripe_subscription_id: alone })
    expect((await overview(first.owner)).bill).toMatchObject({ seatCents: 1900, clientSeatCents: 1100 })
    // A Cloud bill has no client price.
    expect((await overview((await billed()).owner)).bill).toMatchObject({ kind: 'cloud', clientSeatCents: null })
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
      // Where new calls stop: the $5 buffer below zero on a paid plan (LIN-780).
      callsStopAtMicros: -5_000_000,
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

  test("a refused trial's $0 plan invoice is not listed; a trial's own $0 invoices are (LIN-647, LIN-632)", async () => {
    const invoice = (billId: string, totalCents: number, number: string) => ({
      stripe_invoice_id: rid('in'),
      billing_account_id: billId,
      kind: 'subscription' as const,
      number,
      status: 'paid' as const,
      total_cents: totalCents,
    })
    // The trial was refused (the card had one): Stripe's $0 invoice of that trial, then the plan paid today.
    const refused = await billed({ trial_refused: 'card_used' })
    await db
      .insert(billing_invoices)
      .values([invoice(refused.billId, 0, 'LD-0101'), invoice(refused.billId, 1100, 'LD-0102')])
    expect((await overview(refused.owner)).bill.invoices.map((i: { number: string }) => i.number)).toEqual(['LD-0102'])
    // A bill that had its trial keeps the $0 invoices (its start, a monthly/yearly switch in it).
    const trial = await billed({ status: 'trialing' })
    await db.insert(billing_invoices).values(invoice(trial.billId, 0, 'LD-0201'))
    expect((await overview(trial.owner)).bill.invoices).toEqual([
      expect.objectContaining({ number: 'LD-0201', totalCents: 0 }),
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

  test('the bill of one workspace: its admins see it like its owner; members are refused (decision of 2026-11-17)', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    const member = await addMember(b.ws.id, 'member')
    expect((await overview(admin)).bill.status).toBe('active')
    expect((await act(member, 'billing.overview', {})).status).toBe(403)
    // Handed over to the admin: the workspace's owner still manages it, its only workspace is theirs.
    await db.update(billing_accounts).set({ owner_user_id: admin.userId }).where(eq(billing_accounts.id, b.billId))
    expect((await overview(b.owner)).bill.status).toBe('active')
  })

  test("a partner's bill stays the partner's: the client workspace's owner and admins never manage it", async () => {
    const b = await billed({ kind: 'partner' })
    const payer = await addMember(b.ws.id, 'admin')
    await db.update(billing_accounts).set({ owner_user_id: payer.userId }).where(eq(billing_accounts.id, b.billId))
    const admin = await addMember(b.ws.id, 'admin')
    expect(await overview(admin)).toEqual({ billingOn: true, bill: null })
    expect(await overview(b.owner)).toEqual({ billingOn: true, bill: null })
    expect((await act(admin, 'billing.openPortal', {})).status).toBe(403)
    expect((await act(b.owner, 'billing.setRechargeCap', { baseCents: 3000 })).status).toBe(403)
  })

  test('a bill of several workspaces: only its owner; an admin or owner of one of them who does not pay gets no bill', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    const { second, payer } = await shareBill(b)
    expect(await overview(admin)).toEqual({ billingOn: true, bill: null })
    expect(await overview(b.owner)).toEqual({ billingOn: true, bill: null })
    expect(await overview(second.owner)).toEqual({ billingOn: true, bill: null })
    expect((await overview(payer)).bill.workspaces).toBe(2)
    // Nor its banner.
    expect((await act(admin, 'billing.state', {})).body.data).toEqual({ bill: null })
    expect((await act(payer, 'billing.state', {})).body.data.bill).not.toBeNull()
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

  test('turning it on is recorded with the line next to the switch, like "Keep calls answered"; off and changes are not', async () => {
    vi.stubEnv('TERMS_URL', 'https://desk.example.com/terms')
    vi.stubEnv('TERMS_VERSION', '2026-11-18')
    vi.stubEnv('PRIVACY_URL', 'https://desk.example.com/privacy')
    vi.stubEnv('PRIVACY_VERSION', '2026-11-10')
    try {
      const b = await billed({ auto_recharge: false, recharge_cap_base_cents: 5000 }, 5000)
      const on = { on: true, thresholdCents: 500, amountCents: 2500 }
      expect((await act(b.owner, 'billing.setAutoRecharge', on)).status).toBe(200)
      // Already on: a new amount, a retry; off: nothing more is recorded.
      expect((await act(b.owner, 'billing.setAutoRecharge', on)).status).toBe(200)
      expect((await act(b.owner, 'billing.setAutoRecharge', { ...on, amountCents: 3000 })).status).toBe(200)
      expect((await act(b.owner, 'billing.setAutoRecharge', { ...on, on: false })).status).toBe(200)
      const rows = await db.select().from(terms_acceptances).where(eq(terms_acceptances.billing_account_id, b.billId))
      expect(rows).toMatchObject([
        {
          user_id: b.ws.owner.userId,
          source: 'auto_recharge',
          terms_url: 'https://desk.example.com/terms',
          terms_version: '2026-11-18',
          privacy_version: '2026-11-10',
          disclosure: {
            kind: 'auto_recharge',
            // The install's default adds tax where it applies, so the page shows the taxed line.
            key: 'settings.billing.auto.offTermsTaxed',
            text: 'Off: buy minutes yourself. Turning it on charges your card $25, plus tax where it applies, whenever your balance falls below $5, at most $50 a month.',
            amountCents: 2500,
            thresholdCents: 500,
            capCents: 5000,
            taxed: true,
          },
        },
      ])
      expect(rows[0]!.accepted_at).toBeTruthy()
      // Turned on again later: a new record.
      expect((await act(b.owner, 'billing.setAutoRecharge', on)).status).toBe(200)
      expect(
        await db.select().from(terms_acceptances).where(eq(terms_acceptances.billing_account_id, b.billId)),
      ).toHaveLength(2)
    } finally {
      vi.unstubAllEnvs()
    }
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

  test('an admin of the only workspace changes it; on a bill of several workspaces only its owner', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    const off = { on: false, thresholdCents: 500, amountCents: 2000 }
    expect((await act(admin, 'billing.setAutoRecharge', off)).status).toBe(200)
    expect((await billNow(b.billId)).auto_recharge).toBe(false)
    expect((await act(await addMember(b.ws.id, 'member'), 'billing.setAutoRecharge', off)).status).toBe(403)
    const { payer } = await shareBill(b)
    const on = { ...off, on: true }
    expect((await act(b.owner, 'billing.setAutoRecharge', on)).status).toBe(403)
    expect((await act(admin, 'billing.setAutoRecharge', on)).status).toBe(403)
    expect((await billNow(b.billId)).auto_recharge).toBe(false)
    expect((await act(payer, 'billing.setAutoRecharge', on)).status).toBe(200)
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

  test('an admin raising it needs the same step-up as the owner (decision of 2026-11-17)', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    await ageSession(admin.userId)
    expect((await act(admin, 'billing.setRechargeCap', { baseCents: 3000 })).status).toBe(200)
    const raise = await act(admin, 'billing.setRechargeCap', { baseCents: 20_000 })
    expect(raise).toMatchObject({ status: 409, body: { code: 'SIGN_IN_AGAIN' } })
    expect((await billNow(b.billId)).recharge_cap_base_cents).toBe(3000)
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, admin.userId))
    expect((await act(admin, 'billing.setRechargeCap', { baseCents: 20_000 })).status).toBe(200)
  })

  test('only who manages the bill, and not while suspended', async () => {
    const b = await billed()
    await shareBill(b)
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

  test('only who manages the bill: an admin of its only workspace, never on a shared bill or a member', async () => {
    const b = await billed()
    const admin = await addMember(b.ws.id, 'admin')
    expect((await act(await addMember(b.ws.id, 'member'), 'billing.openPortal', {})).status).toBe(403)
    expect(cloud.portal).toEqual([])
    expect((await act(admin, 'billing.openPortal', {})).status).toBe(200)
    expect(cloud.portal).toHaveLength(1)
    await shareBill(b)
    expect((await act(b.owner, 'billing.openPortal', {})).status).toBe(403)
    expect((await act(admin, 'billing.openPortal', {})).status).toBe(403)
    expect(cloud.portal).toHaveLength(1)
  })

  test('no Stripe customer yet: no portal', async () => {
    const b = await billed({ stripe_customer_id: null })
    const res = await act(b.owner, 'billing.openPortal', {})
    expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.noCustomer } })
    expect(cloud.portal).toEqual([])
  })
})

describe('billing.retryRecharge', () => {
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

  test('only who manages the bill', async () => {
    const b = await billed({}, 100)
    await failedRecharge(b, 'canceled')
    await shareBill(b)
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
  /** The workspace used `seconds` of its included Standard seconds this period (3000 is all of them). */
  const usedIncluded = (b: Billed, seconds = 3000) =>
    db.insert(usage_counters).values({
      billing_account_id: b.billId,
      period_id: b.periodId,
      workspace_id: b.ws.id,
      included_seconds_used: seconds,
    })

  test('a recharge to confirm, a low balance with auto-recharge off, the cap reached; nothing while it runs normally', async () => {
    const fine = await billed({}, 1000)
    expect(await stateOf(fine.owner)).toMatchObject({ rechargeNeedsAction: false, lowBalance: null })
    const off = await billed({ auto_recharge: false }, 100)
    await usedIncluded(off)
    expect((await stateOf(off.owner)).lowBalance).toBe('auto_recharge_off')
    // A trial's balance is $0 by design: no low-balance line before "Keep calls answered" (auto-recharge starts off).
    const trial = await billed({ status: 'trialing', auto_recharge: false }, 0)
    await usedIncluded(trial)
    expect((await stateOf(trial.owner)).lowBalance).toBeNull()
    await db
      .update(billing_accounts)
      .set({ trial_recharge_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, trial.billId))
    expect((await stateOf(trial.owner)).lowBalance).toBe('auto_recharge_off')
    const capped = await billed({}, 100)
    await usedIncluded(capped)
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
  test('a plan that just started shows no low balance while its included minutes last (LIN-647)', async () => {
    // A plan started without a trial: $0 balance, auto-recharge off, nothing used yet.
    const fresh = await billed({ auto_recharge: false }, 0)
    expect((await stateOf(fresh.owner)).lowBalance).toBeNull()
    // Most of the included minutes used: the next call is still free.
    await usedIncluded(fresh, 2999)
    expect((await stateOf(fresh.owner)).lowBalance).toBeNull()
    // All of them used: calls are paid from the balance now, and it is low.
    await db
      .update(usage_counters)
      .set({ included_seconds_used: 3000 })
      .where(eq(usage_counters.billing_account_id, fresh.billId))
    expect((await stateOf(fresh.owner)).lowBalance).toBe('auto_recharge_off')
  })
})

describe('what the customer reads about the bill (billing tour, G3)', () => {
  test('a recharge on its way, a bill held for review, and the price of an extra number', async () => {
    const b = await billed()
    expect((await overview(b.owner)).bill).toMatchObject({
      rechargePending: null,
      heldForReview: false,
      extraNumberCents: 300,
      // The plan card's prices (ui/PlanCard.tsx), the same facts as on the activation step.
      prices: {
        includedNumbers: 1,
        includedMinutes: 50,
        includedCalls: 5,
        standardMicrosPerMinute: 50_000,
        premiumMicrosPerMinute: 100_000,
        extraNumberCents: 300,
      },
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
    expect((await overview(b.owner)).bill.prices.extraNumberCents).toBe(0)
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
    expect(Object.keys(data.usage).sort()).toEqual(['minutesOnly', 'period', 'row'])
    expect(data.usage.minutesOnly).toBe(false)
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
    const member = await addMember(b.ws.id, 'member')
    expect((await set(member, b.ws.id, 5)).status).toBe(403)
    await shareBill(b)
    expect((await set(b.owner, b.ws.id, 5)).status).toBe(403)
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

  test("a workspace admin's change: one email to the bill owner per change; the owner's own changes send none", async () => {
    const b = await billed()
    const notes = () => queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL).map(j => j.data)
    expect((await set(b.owner, b.ws.id, 5)).status).toBe(200)
    expect(notes()).toEqual([])
    const admin = await addMember(b.ws.id, 'admin')
    const key = crypto.randomUUID()
    const raise = () => act(admin, 'billing.setExtraCalls', { workspaceId: b.ws.id, extraCalls: 10 }, key)
    expect((await raise()).status).toBe(200)
    // A retry of the same command is answered from the command log: no second charge, no second email.
    expect((await raise()).status).toBe(200)
    // The same number again changes nothing: no email.
    expect((await set(admin, b.ws.id, 10)).status).toBe(200)
    expect(notes()).toEqual([
      {
        bill: b.billId,
        email: {
          kind: 'manager_changed',
          change: 'extraCalls',
          actorId: admin.userId,
          at: expect.any(String),
          from: 5,
          to: 10,
        },
      },
    ])
    const member = await addMember(b.ws.id, 'member')
    expect((await set(member, b.ws.id, 0)).status).toBe(403)
    expect(notes()).toHaveLength(1)
  })
})

describe('billing.setInterval: monthly or yearly in the free trial (2026-11-19)', () => {
  const trialEnd = () => at(Date.now() + 10 * DAY)
  const inTrial = (over: Partial<typeof billing_accounts.$inferInsert> = {}) =>
    billed({ status: 'trialing', trial_ends_at: trialEnd(), interval: 'year', ...over }, 0)
  const switchTo = (who: Caller, interval: 'month' | 'year', key?: string) =>
    act(who, 'billing.setInterval', { interval }, key)

  test('in the trial: Stripe moves the plan with the trial end kept, the bill stores it, nothing is charged', async () => {
    const b = await inTrial()
    const before = await billNow(b.billId)
    expect((await overview(b.owner)).bill.intervalSwitch).toEqual({ interval: 'month', seatCents: 1100 })
    const res = await switchTo(b.owner, 'month')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ interval: 'month', trialEndsAt: before.trial_ends_at })
    expect(cloud.intervals).toEqual([
      {
        subscriptionId: before.stripe_subscription_id,
        interval: 'month',
        priceIds: cloud.prices,
        idempotencyKey: expect.stringContaining(`interval:${b.billId}:`),
      },
    ])
    const after = await billNow(b.billId)
    expect(after.interval).toBe('month')
    // The trial keeps its end and its status; no invoice and no charge on the bill.
    expect(after.status).toBe('trialing')
    expect(after.trial_ends_at).toBe(before.trial_ends_at)
    expect(await db.select().from(billing_invoices).where(eq(billing_invoices.billing_account_id, b.billId))).toEqual(
      [],
    )
    expect(rechargesQueued()).toEqual([])
    // The page offers the way back now.
    expect((await overview(b.owner)).bill.intervalSwitch).toEqual({ interval: 'year', seatCents: 10800 })
    // The same interval again asks Stripe nothing.
    expect((await switchTo(b.owner, 'month')).status).toBe(200)
    expect(cloud.intervals).toHaveLength(1)
  })

  test('only in the trial: a paid plan, a pending sign-up or a partner bill is refused and Stripe is not asked', async () => {
    for (const over of [
      { status: 'active' as const, trial_ends_at: null },
      { status: 'pending_payment' as const, stripe_subscription_id: null },
      { status: 'trialing' as const, stripe_subscription_id: null },
      // A partner bill has its own plan (base fee and client seats) and no trial: never switched here.
      { kind: 'partner' as const },
    ]) {
      const b = await inTrial(over)
      const res = await switchTo(b.owner, 'month')
      expect(res).toMatchObject({ status: 409, body: { code: BILLING_PAGE_CODES.intervalTrialOnly } })
      expect((await overview(b.owner)).bill?.intervalSwitch ?? null).toBeNull()
    }
    expect(cloud.intervals).toEqual([])
  })

  test('Stripe ended the trial meanwhile: refused, the bill keeps its interval', async () => {
    const b = await inTrial()
    cloud.intervalAnswer = 'not_trialing'
    expect(await switchTo(b.owner, 'month')).toMatchObject({
      status: 409,
      body: { code: BILLING_PAGE_CODES.intervalTrialOnly },
    })
    expect((await billNow(b.billId)).interval).toBe('year')
  })

  test('who may: the owner and an admin of its only workspace (the owner hears of it); never a member', async () => {
    const b = await inTrial()
    const notes = () => queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL).map(j => j.data)
    const member = await addMember(b.ws.id, 'member')
    expect((await switchTo(member, 'month')).status).toBe(403)
    expect(cloud.intervals).toEqual([])
    const admin = await addMember(b.ws.id, 'admin')
    expect((await switchTo(admin, 'month')).status).toBe(200)
    expect(notes()).toEqual([
      {
        bill: b.billId,
        email: {
          kind: 'manager_changed',
          change: 'interval',
          actorId: admin.userId,
          at: expect.any(String),
          to: 'month',
        },
      },
    ])
    // The owner's own switch sends nothing.
    expect((await switchTo(b.owner, 'year')).status).toBe(200)
    expect(notes()).toHaveLength(1)
    // A bill of several workspaces is its owner's alone.
    const { payer } = await shareBill(b)
    expect((await switchTo(admin, 'month')).status).toBe(403)
    expect((await switchTo(payer, 'month')).status).toBe(200)
  })

  test('at most a few switches an hour per bill', async () => {
    const b = await inTrial()
    for (let i = 0; i < INTERVAL_CHANGES_PER_HOUR; i++)
      expect((await switchTo(b.owner, i % 2 ? 'year' : 'month')).status).toBe(200)
    expect(await switchTo(b.owner, 'month')).toMatchObject({
      status: 409,
      body: { code: BILLING_PAGE_CODES.intervalTooOften },
    })
  })
})

describe('busy lines and the add-on offer (LIN-450)', () => {
  /** The workspace's own day, as the busy-line notice counts it. */
  const today = async (ws: Workspace) => {
    const [row] = await db
      .select({ zone: workspace_settings.timezone })
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, ws.id))
    return todayIn(row?.zone ?? DEFAULT_TIME_ZONE)
  }
  const busy = async (b: Billed, ref: string, count: number, createdAt = new Date()) =>
    db
      .insert(billing_alerts)
      .values({ billing_account_id: b.billId, kind: 'busy_line', ref, count, created_at: createdAt.toISOString() })
  const stateOf = async (who: Caller) => (await act(who, 'billing.state', {})).body.data.bill

  test("the banner: today's busy callers of this workspace, and one step more at its price", async () => {
    const b = await billed()
    expect((await stateOf(b.owner)).busyLine).toBeNull()
    await busy(b, `${b.ws.id}:${await today(b.ws)}`, 3)
    expect((await stateOf(b.owner)).busyLine).toEqual({
      workspaceId: b.ws.id,
      callers: 3,
      limit: 5,
      extraCalls: 0,
      step: 5,
      stepCents: 500,
      canAdd: true,
    })
    // Yesterday's busy line is no line today.
    const other = await billed()
    await busy(other, `${other.ws.id}:2026-01-01`, 9)
    expect((await stateOf(other.owner)).busyLine).toBeNull()
  })

  test('the trial, the most reached or an instance admin cap: the line without the button', async () => {
    const trial = await billed({ status: 'trialing' })
    await busy(trial, `${trial.ws.id}:${await today(trial.ws)}`, 1)
    expect((await stateOf(trial.owner)).busyLine).toMatchObject({ callers: 1, canAdd: false })
    const full = await billed()
    await db.update(organization).set({ extraCalls: 45 }).where(eq(organization.id, full.ws.id))
    await busy(full, `${full.ws.id}:${await today(full.ws)}`, 2)
    expect((await stateOf(full.owner)).busyLine).toMatchObject({ limit: 50, canAdd: false })
    const capped = await billed({ concurrent_calls_cap: 8 })
    await busy(capped, `${capped.ws.id}:${await today(capped.ws)}`, 2)
    expect((await stateOf(capped.owner)).busyLine).toMatchObject({ limit: 8, canAdd: false })
  })

  test('the line and its button for the owners and admins of the only workspace; members never (decision of 2026-11-17)', async () => {
    const b = await billed()
    await busy(b, `${b.ws.id}:${await today(b.ws)}`, 2)
    const admin = await addMember(b.ws.id, 'admin')
    expect((await stateOf(admin)).busyLine).toMatchObject({ callers: 2, canAdd: true })
    expect(
      (await act(admin, 'billing.setExtraCalls', { workspaceId: b.ws.id, extraCalls: 5, from: 'busy_line' })).status,
    ).toBe(200)
    const member = await addMember(b.ws.id, 'member')
    expect((await act(member, 'billing.state', {})).status).toBe(403)
    expect((await act(member, 'billing.setExtraCalls', { workspaceId: b.ws.id, extraCalls: 10 })).status).toBe(403)
  })

  test('Settings › Billing: the busy callers of the last 30 days per workspace', async () => {
    const b = await billed()
    await busy(b, `${b.ws.id}:2026-11-16`, 3, new Date(Date.now() - DAY))
    await busy(b, `${b.ws.id}:2026-11-15`, 4, new Date(Date.now() - 2 * DAY))
    await busy(b, `${b.ws.id}:2026-10-01`, 40, new Date(Date.now() - 40 * DAY))
    expect((await overview(b.owner)).bill.calls.workspaces).toMatchObject([{ workspaceId: b.ws.id, busyCallers: 7 }])
  })

  test('adding from the banner is recorded with what it said, like the other purchases; lowering is not', async () => {
    vi.stubEnv('TERMS_URL', 'https://desk.example.com/terms')
    vi.stubEnv('TERMS_VERSION', '2026-11-17')
    vi.stubEnv('PRIVACY_URL', 'https://desk.example.com/privacy')
    vi.stubEnv('PRIVACY_VERSION', '2026-11-10')
    try {
      const b = await billed()
      const res = await act(b.owner, 'billing.setExtraCalls', {
        workspaceId: b.ws.id,
        extraCalls: 5,
        from: 'busy_line',
      })
      expect(res.status).toBe(200)
      expect((await act(b.owner, 'billing.setExtraCalls', { workspaceId: b.ws.id, extraCalls: 0 })).status).toBe(200)
      const rows = await db.select().from(terms_acceptances).where(eq(terms_acceptances.billing_account_id, b.billId))
      expect(rows).toMatchObject([
        {
          source: 'extra_calls',
          terms_version: '2026-11-17',
          disclosure: {
            kind: 'extra_calls',
            workspaceId: b.ws.id,
            before: 0,
            after: 5,
            monthlyCents: 500,
            chargedNow: true,
            from: 'busy_line',
          },
        },
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('a bill owner who is only a member of the workspace (LIN-400; security review of #1235)', () => {
  /** b's bill owned by a plain member of b.ws (the workspace's owner stays its owner). */
  async function memberOwned(b: Billed) {
    const payer = await addMember(b.ws.id, 'member')
    await db.update(billing_accounts).set({ owner_user_id: payer.userId }).where(eq(billing_accounts.id, b.billId))
    return payer
  }
  /** A failed recharge of the bill: declined (a new attempt on Retry) or waiting for 3D Secure (its invoice page). */
  async function failed(b: Billed, status: 'failed' | 'canceled') {
    await db.insert(billing_recharges).values({
      id: rid('rc'),
      billing_account_id: b.billId,
      amount_cents: 2000,
      status,
      failure_code: status === 'failed' ? 'authentication_required' : 'card_declined',
      stripe_invoice_id: rid('in'),
      created_at: at(Date.now() - 2 * DAY),
      resolved_at: at(Date.now() - 2 * DAY),
    })
    await db
      .update(billing_accounts)
      .set({ recharge_failed_at: at(Date.now() - 2 * DAY) })
      .where(eq(billing_accounts.id, b.billId))
  }

  test('Retry, auto-recharge, the cap, extra calls and the portal, like the owner; another member gets 403', async () => {
    const b = await billed({}, 100)
    await failed(b, 'canceled')
    const payer = await memberOwned(b)
    const other = await addMember(b.ws.id, 'member')
    const changes = [
      ['billing.retryRecharge', {}],
      ['billing.setAutoRecharge', { on: false, thresholdCents: 1000, amountCents: 3000 }],
      ['billing.setRechargeCap', { baseCents: 3000 }],
      ['billing.setExtraCalls', { workspaceId: b.ws.id, extraCalls: 5 }],
      ['billing.openPortal', {}],
    ] as const
    for (const [name, input] of changes) expect((await act(other, name, input)).status, name).toBe(403)
    expect(cloud.portal).toEqual([])
    expect(cloud.extraCalls).toEqual([])
    expect((await billNow(b.billId)).recharge_failed_at).not.toBeNull()
    expect((await act(payer, 'billing.retryRecharge', {})).body.data).toEqual({ kind: 'retrying' })
    const off = await act(payer, 'billing.setAutoRecharge', changes[1][1])
    expect(off.body.data).toMatchObject({ on: false, thresholdCents: 1000, amountCents: 3000 })
    expect((await act(payer, 'billing.setRechargeCap', changes[2][1])).body.data).toMatchObject({ baseCents: 3000 })
    expect((await act(payer, 'billing.setExtraCalls', changes[3][1])).body.data).toMatchObject({ extraCalls: 5 })
    expect(cloud.extraCalls).toHaveLength(1)
    expect((await act(payer, 'billing.openPortal', {})).status).toBe(200)
    expect(cloud.portal).toHaveLength(1)
    expect(await billNow(b.billId)).toMatchObject({
      auto_recharge: false,
      recharge_cap_base_cents: 3000,
      recharge_failed_at: null,
    })
    // Their own changes: no email to the bill owner about them.
    expect(queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL)).toEqual([])
  })

  test('handed over between the first read and Stripe: refused before Stripe is asked (portal, Retry)', async () => {
    const portal = await billed()
    const payer = await memberOwned(portal)
    const handBack = (b: Billed) => async () => {
      await db
        .update(billing_accounts)
        .set({ owner_user_id: b.ws.owner.userId })
        .where(eq(billing_accounts.id, b.billId))
    }
    cloud.onProvider = handBack(portal)
    expect((await act(payer, 'billing.openPortal', {})).status).toBe(403)
    expect(cloud.onProvider).toBeNull()
    expect(cloud.portal).toEqual([])

    const retry = await billed({}, 100)
    await failed(retry, 'failed')
    const second = await memberOwned(retry)
    cloud.onProvider = handBack(retry)
    expect((await act(second, 'billing.retryRecharge', {})).status).toBe(403)
    expect(cloud.onProvider).toBeNull()
    expect(cloud.invoicePages).toEqual([])
  })
})
