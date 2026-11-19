// Server admin › Billing (docs/billing.md §11, PR 13; billing-admin.ts): instance admins only; every write refuses a
// setup link, an API key, an impersonation and a session without the passkey; every write is audited with its reason;
// ledger entries post once per request id; a refund asks a fake Stripe with the request id as its idempotency key,
// refunds at most the available balance from the newest payment, never one with a dispute; a comped bill's usage reads
// as $0 paid (amount_micros, not billable seconds); the billing rules editor refuses anything out of range and emails
// every instance admin; self-serve sign-up needs billing in effect. Instance-wide (instance settings, Stripe keys,
// instance admins): its own database (vitest.config.ts).
import type {
  BillingInvoice,
  BillingProvider,
  ExtraCallsQuantityInput,
  InvoiceRefund,
  InvoiceRefundInput,
  SeatQuantityInput,
} from '@linedesk/billing'
import { PLAN_PRICE_FLOOR } from '@linedesk/actions'
import {
  BILLING_DEFAULTS,
  SIGNUP_DEFAULTS,
  assistant_versions,
  billing_accounts,
  billing_balances,
  billing_periods,
  billing_recharges,
  billing_refunds,
  call_reservations,
  calls,
  commands,
  createDb,
  instance_settings,
  ledger_entries,
  organization,
  personal_keys,
  provider_settings,
  stripe_events,
  user,
} from '@linedesk/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest'
import {
  billingAdminHandlers,
  REFUND_SETTLE_AFTER_MS,
  SELF_SERVE_KEY,
  setBillingAdminProvider,
  settlePendingRefunds,
} from '../src/billing-admin.ts'
import { BILLING_RULES_KEY, billingRules } from '../src/billing-rules.ts'
import { setBillingFetch } from '../src/billing-settings.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { lockBalance, reserveCall } from '../src/ledger.ts'
import { checkLedgerGuards } from '../src/ledger-guards.ts'
import { STRIPE_EVENT_ATTEMPTS, stripeEventHandlers, UNHANDLED_TYPE } from '../src/stripe-events.ts'
import {
  act,
  addMember,
  createWorkspace,
  FROM,
  KEPT_PREMIUM_AND_ULTRA,
  premiumAndUltraOf,
  randomIp,
  request,
  type User,
  type Workspace,
  withPremiumAndUltra,
} from './helpers.ts'

/** Price ids a test pretends the catalog sync stored; null reads the real stored ones. */
const catalog = vi.hoisted(() => ({ prices: null as Record<string, string> | null }))
vi.mock('../src/billing-catalog.ts', async original => {
  const real = await original<typeof import('../src/billing-catalog.ts')>()
  return {
    ...real,
    syncedPrices: async (tx: Parameters<typeof real.syncedPrices>[0]) => catalog.prices ?? real.syncedPrices(tx),
  }
})

/** Usage levels billed (call quality on Linedesk Cloud) for the tests that turn it on; the stored billing otherwise. */
const cloud = vi.hoisted(() => ({ on: false }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
  }
})

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const day = 86_400_000
const envBefore = { ...process.env }

let operator: User
let other: Workspace

/** A made-up Stripe key, put together at run time so the secret scan never sees a key-shaped string. */
const TEST_KEY = ['sk', 'test', '51MadeUpAdminKey0123456789'].join('_')
const WEBHOOK = ['whsec', 'MadeUpAdminSecret0123456789'].join('_')

beforeAll(async () => {
  operator = (await createWorkspace('Linedesk Operations')).owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  other = await createWorkspace('Harbor Dental')
  expect(await checkLedgerGuards(db)).toBe(true)
})
afterEach(async () => {
  process.env = { ...envBefore }
  vi.restoreAllMocks()
  setBillingAdminProvider(null)
  setBillingFetch(null)
  await db.delete(instance_settings)
  await db.delete(provider_settings)
  catalog.prices = null
})
afterAll(() => {
  process.env = { ...envBefore }
})

/** A bill in service with one workspace and its current period. */
async function billWith(over: Partial<typeof billing_accounts.$inferInsert> = {}) {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const billId = rid('bill')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: ws.owner.userId,
    status: 'active',
    stripe_customer_id: rid('cus'),
    ...over,
  })
  const [period] = await db
    .insert(billing_periods)
    .values({
      id: rid('per'),
      billing_account_id: billId,
      starts_at: new Date(Date.now() - day).toISOString(),
      ends_at: new Date(Date.now() + 29 * day).toISOString(),
      kind: 'month',
    })
    .returning()
  await db
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'active' })
    .where(eq(organization.id, ws.id))
  return { ws, billId, periodId: period!.id }
}

const balance = async (billId: string) => {
  const [row] = await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId))
  return Number(row?.balance_micros ?? 0)
}
const billRow = async (billId: string) =>
  (await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId)))[0]!
const lastCommand = async (action: string) =>
  (await db.select().from(commands).where(eq(commands.action, action)).orderBy(desc(commands.created_at)).limit(1))[0]
const mailbox = () => {
  const mails: { to: string; subject: string; text: string }[] = []
  vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e))
  return mails
}

/** A paid recharge attempt and its credit: the payment a refund comes from. */
async function paidRecharge(billId: string, periodId: string, cents = 2000) {
  const attempt = rid('rch')
  const invoiceId = rid('in')
  await db.insert(billing_recharges).values({
    id: attempt,
    billing_account_id: billId,
    amount_cents: cents,
    status: 'paid',
    stripe_invoice_id: invoiceId,
    resolved_at: new Date().toISOString(),
  })
  await db.insert(ledger_entries).values({
    id: rid('le'),
    billing_account_id: billId,
    period_id: periodId,
    kind: 'recharge',
    amount_micros: cents * 10_000,
    source_type: 'billing_recharge',
    source_id: attempt,
  })
  return { attempt, invoiceId }
}

/**
 * A fake Stripe adapter for the money actions: knows the invoices given, records every refund, seat change and
 * stopped invoice, and keeps the credit notes it made (found again by their key, like Stripe's `metadata`).
 * `seatFails`: the subscriptions whose seat change Stripe refuses.
 */
function fakeStripe(invoices: Map<string, BillingInvoice>, blockers: string[] = [], seatFails: string[] = []) {
  const refunds: InvoiceRefundInput[] = []
  const seats: SeatQuantityInput[] = []
  const extraCalls: ExtraCallsQuantityInput[] = []
  const stopped: { invoiceId: string; void: boolean }[] = []
  const notes = new Map<string, InvoiceRefund & { invoiceId: string }>()
  const provider: BillingProvider = {
    name: 'stripe',
    account: async () => null,
    chargeRecharge: () => Promise.reject(new Error('not used')),
    findRechargeInvoice: async () => null,
    stopRechargeInvoice: async (invoiceId, options) => {
      stopped.push({ invoiceId, void: options.void })
      return 'stopped'
    },
    rechargeInvoicePage: async () => null,
    // Settings › Billing's portal (PR 9) is not used here.
    portalSession: () => Promise.reject(new Error('not used')),
    webhookEvent: () => {
      throw new Error('not used')
    },
    invoice: async id => invoices.get(id) ?? null,
    subscription: async () => null,
    recentEvents: async () => ({ events: [], truncated: false }),
    rechargeCard: async () => null,
    checkoutPaymentMethodConfiguration: async () => null,
    // The lifecycle side (PR 10/11) is not used here.
    dispute: async () => null,
    earlyFraudWarning: async () => null,
    charge: async () => null,
    refundBlockers: async () => blockers as never,
    refundInvoice: async input => {
      refunds.push(input)
      // Stripe's idempotency: the same key answers the same refund.
      const refundId = rid('re')
      const made = notes.get(input.idempotencyKey) ?? {
        creditNoteId: `cn_${refundId}`,
        refundId,
        refundedCents: input.amountCents,
        invoiceId: input.invoiceId,
      }
      notes.set(input.idempotencyKey, made)
      return { creditNoteId: made.creditNoteId, refundId: made.refundId, refundedCents: made.refundedCents }
    },
    findRefund: async (invoiceId, key) => {
      const made = notes.get(key)
      return made && made.invoiceId === invoiceId
        ? { creditNoteId: made.creditNoteId, refundId: made.refundId, refundedCents: made.refundedCents }
        : null
    },
    checkoutInvoice: async () => null,
    // Trial Checkout (PR 8) is not used here.
    createCustomer: async () => {
      throw new Error('not used')
    },
    startCheckout: async () => {
      throw new Error('not used')
    },
    syncCatalog: async () => {
      throw new Error('not used')
    },
    catalogWriteAccess: async () => ({ products: null, prices: null }),
    portalWriteAccess: async () => null,
    taxSetup: async () => null,
    customerTaxReady: async () => true,
    customersWithoutTaxAddress: async () => 0,
    syncSubscriptionTax: async () => 'unchanged',
    syncPortal: async () => ({ configuration: 'bpc_test', changed: false }),
    expireOpenCheckouts: async () => {
      throw new Error('not used')
    },
    customerPurchases: async () => {
      throw new Error('not used')
    },
    deleteCustomer: async () => {
      throw new Error('not used')
    },
    checkoutSession: async () => null,
    cancelSubscription: async () => null,
    resumeSubscription: async () => null,
    addInvoiceItem: async () => {
      throw new Error('not used')
    },
    setSeatQuantity: async input => {
      seats.push(input)
      if (seatFails.includes(input.subscriptionId)) throw new Error('Stripe: this subscription is canceled')
      return 'updated'
    },
    setExtraCallsQuantity: async input => {
      extraCalls.push(input)
      return 'updated'
    },
    setPlanInterval: async () => 'unchanged',
  }
  return { provider, refunds, seats, extraCalls, stopped, notes }
}

function paidInvoice(id: string, customerId: string, rechargeId: string, cents = 2000): BillingInvoice {
  return {
    id,
    livemode: false,
    customerId,
    subscriptionId: null,
    status: 'paid',
    billingReason: 'manual',
    currency: 'usd',
    totalCents: cents,
    taxCents: 0,
    amountPaidCents: cents,
    amountPaidOffStripeCents: 0,
    chargedCents: cents,
    startingBalanceCents: 0,
    paymentFailureCode: null,
    rechargeId,
    lines: [{ id: rid('il'), amountCents: cents, currency: 'usd', kind: 'invoice_item', rechargeId, discountCents: 0 }],
    number: 'LD-0001',
    periodStart: null,
    periodEnd: null,
    hostedInvoiceUrl: null,
    pdfUrl: null,
  }
}

const reason = 'Customer asked on support ticket 4411'

describe('who may', () => {
  test('a workspace owner who is not an instance admin runs none of it', async () => {
    const { billId, ws } = await billWith()
    const reads = [
      'billing.adminBills',
      'billing.adminReview',
      'billing.adminSummary',
      'billingRules.get',
      'billing.adminTaxAddressMissing',
      'signup.getSelfServe',
    ]
    for (const name of reads) expect((await act(ws.owner, name, {})).status).toBe(403)
    expect((await act(ws.owner, 'billing.adminBill', { billingAccountId: billId })).status).toBe(403)
    const writes: [string, unknown][] = [
      ['billing.credit', { billingAccountId: billId, kind: 'credit', amountCents: 500, reason, requestId: rid('req') }],
      ['billing.refund', { billingAccountId: billId, amountCents: 500, reason, requestId: rid('req') }],
      ['billing.adminSetStatus', { billingAccountId: billId, status: 'comped', reason }],
      ['billing.setCap', { billingAccountId: billId, capBaseCents: 900_00, reason }],
      ['billing.setConcurrency', { billingAccountId: billId, concurrentCalls: 50, reason }],
      ['billing.transferOwner', { billingAccountId: billId, userId: ws.owner.userId, reason }],
      ['billing.reviewHold', { billingAccountId: billId, decision: 'approve', reason }],
      ['billingRules.set', { rules: {}, reason }],
      ['signup.setSelfServe', { on: false, reason }],
      ['signup.setRules', { rules: { turnstile: false }, reason }],
    ]
    for (const [name, input] of writes) {
      const answer = await act(ws.owner, name, input)
      expect(answer.status, name).toBe(403)
    }
    expect(await balance(billId)).toBe(0)
    expect((await billRow(billId)).status).toBe('active')
  })

  test('every write needs the admin as themselves with the passkey: no setup link, API key, personal key or impersonation', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const { billId } = await billWith()
    const me: Actor = {
      actorId: operator.userId,
      role: 'owner',
      workspaceId: null,
      permissions: ['instance:admin'],
      passkeyConfirmed: true,
    }
    const now = new Date().toISOString()
    const writes: [string, unknown][] = [
      ['billing.credit', { billingAccountId: billId, kind: 'credit', amountCents: 500, reason, requestId: rid('req') }],
      ['billing.refund', { billingAccountId: billId, amountCents: 500, reason, requestId: rid('req') }],
      ['billing.adminSetStatus', { billingAccountId: billId, status: 'comped', reason }],
      ['billing.setCap', { billingAccountId: billId, capBaseCents: 900_00, reason }],
      ['billing.setConcurrency', { billingAccountId: billId, concurrentCalls: 50, reason }],
      ['billing.moveWorkspace', { workspaceId: other.id, toBillingAccountId: billId, reason, requestId: rid('req') }],
      ['billing.transferOwner', { billingAccountId: billId, userId: operator.userId, reason }],
      ['billing.reviewHold', { billingAccountId: billId, decision: 'approve', reason }],
      ['billingRules.set', { rules: {}, reason }],
      ['signup.setSelfServe', { on: true, reason }],
      ['signup.setRules', { rules: { turnstile: false }, reason }],
      ['billing.reprocessEvent', { eventId: rid('evt'), reason }],
    ]
    const handlers = { ...billingAdminHandlers, ...stripeEventHandlers }
    const refused = [
      { ...me, setupKeyId: 'ask_1' },
      { ...me, apiKeyId: 'key_1' },
      // A personal key made after the passkey check carries it until revoked (security review of #919, H1).
      { ...me, personalKeyId: 'pkey_1' },
      { ...me, impersonation: { by: 'admin_1', sessionId: 's0', expiresAt: new Date(Date.now() + 60_000) } },
      { ...me, passkeyConfirmed: undefined },
    ] as Actor[]
    for (const [name, input] of writes)
      for (const actor of refused)
        await expect(
          db.transaction(tx => handlers[name]!({ tx, actor, now }, input)),
          name,
        ).rejects.toThrow(/signed in as themselves|confirm with your passkey/)
    expect(await balance(billId)).toBe(0)
    // Through the API, a session without the passkey check does not reach Server admin at all.
    const answer = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 500,
      reason,
      requestId: rid('req'),
    })
    expect(answer.status).toBe(403)
    expect(await balance(billId)).toBe(0)
  })

  test("a server admin's personal key made after the passkey check moves no money (security review of #919, H1)", async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    const made = await act(operator, 'personalKey.create', { name: 'Billing script' })
    expect(made.status).toBe(200)
    const key = made.body.data.key as string
    await db
      .update(personal_keys)
      .set({ passkey_confirmed: true })
      .where(eq(personal_keys.prefix, key.slice(0, 12)))
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const { billId } = await billWith()
    const asKey = { headers: { authorization: `Bearer ${key}`, [FROM]: randomIp() } }
    // The key reaches Server admin (reads), but none of the writes.
    expect((await act(asKey, 'billing.adminBills', {})).status).toBe(200)
    const writes: [string, unknown][] = [
      [
        'billing.credit',
        { billingAccountId: billId, kind: 'credit', amountCents: 10_000_000, reason, requestId: rid('req') },
      ],
      ['billing.refund', { billingAccountId: billId, amountCents: 500, reason, requestId: rid('req') }],
      ['billing.adminSetStatus', { billingAccountId: billId, status: 'comped', reason }],
      ['billing.setCap', { billingAccountId: billId, capBaseCents: 900_00, reason }],
      ['billing.setConcurrency', { billingAccountId: billId, concurrentCalls: 50, reason }],
      ['billing.moveWorkspace', { workspaceId: other.id, toBillingAccountId: billId, reason, requestId: rid('req') }],
      ['billing.transferOwner', { billingAccountId: billId, userId: operator.userId, reason }],
      ['billingRules.set', { rules: { includedStandardSeconds: 1_000_000 }, reason }],
      ['signup.setSelfServe', { on: true, reason }],
      ['signup.setRules', { rules: { turnstile: false }, reason }],
      ['billing.reprocessEvent', { eventId: rid('evt'), reason }],
    ]
    for (const [name, input] of writes) expect((await act(asKey, name, input)).status, name).toBe(403)
    expect(await balance(billId)).toBe(0)
    expect(await billRow(billId)).toMatchObject({ status: 'active', recharge_cap_base_cents: expect.any(Number) })
    expect((await billRow(billId)).concurrent_calls_cap).toBeNull()
    expect(await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))).toEqual([])
  })

  test('every write needs a reason', async () => {
    const { billId } = await billWith()
    const answer = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 500,
      requestId: rid('req'),
    })
    expect(answer.status).toBe(422)
    expect(await balance(billId)).toBe(0)
  })
})

describe('credits, write-offs and adjustments', () => {
  test('a credit posts once per request id, with the admin as actor, and is audited with its reason', async () => {
    const { billId } = await billWith()
    const requestId = rid('req')
    const input = { billingAccountId: billId, kind: 'credit', amountCents: 1500, reason, requestId }
    const first = await act(operator, 'billing.credit', input)
    expect(first.status).toBe(200)
    expect(first.body.data).toMatchObject({ posted: true, amountMicros: 15_000_000 })
    const again = await act(operator, 'billing.credit', input)
    expect(again.body.data).toMatchObject({ posted: false, entryId: first.body.data.entryId })
    expect(await balance(billId)).toBe(15_000_000)
    const [entry] = await db.select().from(ledger_entries).where(eq(ledger_entries.id, first.body.data.entryId))
    expect(entry).toMatchObject({
      kind: 'credit',
      source_type: 'admin',
      source_id: requestId,
      actor_id: operator.userId,
      note: reason,
    })
    const audited = await lastCommand('billing.credit')
    expect(audited?.input).toMatchObject({ reason, amountCents: 1500 })
  })

  test('a write-off forgives at most what is below zero; an adjustment goes either way', async () => {
    const { billId } = await billWith()
    const minus = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'adjustment',
      amountCents: -300,
      reason,
      requestId: rid('req'),
    })
    expect(minus.status).toBe(200)
    expect(await balance(billId)).toBe(-3_000_000)
    const tooMuch = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'writeoff',
      amountCents: 400,
      reason,
      requestId: rid('req'),
    })
    expect(tooMuch.status).toBe(409)
    expect(
      (
        await act(operator, 'billing.credit', {
          billingAccountId: billId,
          kind: 'writeoff',
          amountCents: 300,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(200)
    expect(await balance(billId)).toBe(0)
    // A credit never takes away; only an adjustment may.
    expect(
      (
        await act(operator, 'billing.credit', {
          billingAccountId: billId,
          kind: 'credit',
          amountCents: -100,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(422)
  })

  test('an adjustment corrects only an entry of the same bill', async () => {
    const a = await billWith()
    const b = await billWith()
    const credited = await act(operator, 'billing.credit', {
      billingAccountId: a.billId,
      kind: 'credit',
      amountCents: 100,
      reason,
      requestId: rid('req'),
    })
    const wrong = await act(operator, 'billing.credit', {
      billingAccountId: b.billId,
      kind: 'adjustment',
      amountCents: -100,
      reason,
      requestId: rid('req'),
      reversesEntryId: credited.body.data.entryId,
    })
    expect(wrong.status).toBe(409)
    expect(await balance(b.billId)).toBe(0)
  })

  test('a hand credit for a recharge attempt posts under its own key and marks it paid, so it is never credited twice', async () => {
    const { billId } = await billWith()
    const attempt = rid('rch')
    await db.insert(billing_recharges).values({
      id: attempt,
      billing_account_id: billId,
      amount_cents: 2000,
      status: 'failed',
      failure_code: 'card_declined',
      resolved_at: new Date().toISOString(),
    })
    const wrongAmount = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2500,
      reason,
      requestId: rid('req'),
      rechargeId: attempt,
    })
    expect(wrongAmount.status).toBe(409)
    const done = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2000,
      reason,
      requestId: rid('req'),
      rechargeId: attempt,
    })
    expect(done.status).toBe(200)
    const [entry] = await db.select().from(ledger_entries).where(eq(ledger_entries.id, done.body.data.entryId))
    expect(entry).toMatchObject({
      kind: 'recharge',
      source_type: 'billing_recharge',
      source_id: attempt,
      amount_micros: 20_000_000,
    })
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, attempt)))[0]?.status).toBe('paid')
    // A second hand credit with another request id (or the automatic one) finds the same key: nothing more.
    const twice = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2000,
      reason,
      requestId: rid('req'),
      rechargeId: attempt,
    })
    expect(twice.body.data.posted).toBe(false)
    expect(await balance(billId)).toBe(20_000_000)
  })

  test('crediting a pending recharge by hand voids its Stripe invoice first, so it cannot be paid twice (L6)', async () => {
    const { billId } = await billWith()
    const attempt = rid('rch')
    const invoiceId = rid('in')
    await db.insert(billing_recharges).values({
      id: attempt,
      billing_account_id: billId,
      amount_cents: 2000,
      status: 'pending',
      stripe_invoice_id: invoiceId,
    })
    const open = { ...paidInvoice(invoiceId, (await billRow(billId)).stripe_customer_id!, attempt), status: 'open' }
    const stripe = fakeStripe(new Map([[invoiceId, open as BillingInvoice]]))
    setBillingAdminProvider(stripe.provider)
    const done = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2000,
      reason,
      requestId: rid('req'),
      rechargeId: attempt,
    })
    expect(done.status).toBe(200)
    expect(stripe.stopped).toEqual([{ invoiceId, void: true }])
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, attempt)))[0]?.status).toBe('paid')
    expect(await balance(billId)).toBe(20_000_000)
    // Without Stripe in effect, an attempt with an invoice there is not credited by hand: void it in Stripe first.
    setBillingAdminProvider(null)
    const second = rid('rch')
    await db.insert(billing_recharges).values({
      id: second,
      billing_account_id: billId,
      amount_cents: 2000,
      status: 'failed',
      failure_code: 'authentication_required',
      stripe_invoice_id: rid('in'),
      resolved_at: new Date().toISOString(),
    })
    const refused = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2000,
      reason,
      requestId: rid('req'),
      rechargeId: second,
    })
    expect(refused.status).toBe(409)
    expect(await balance(billId)).toBe(20_000_000)
  })

  test('crediting a failed recharge whose invoice Stripe marked uncollectible voids it too (re-review of #919, R4)', async () => {
    const { billId } = await billWith()
    const attempt = rid('rch')
    const invoiceId = rid('in')
    await db.insert(billing_recharges).values({
      id: attempt,
      billing_account_id: billId,
      amount_cents: 2000,
      status: 'failed',
      failure_code: 'card_declined',
      stripe_invoice_id: invoiceId,
      resolved_at: new Date().toISOString(),
    })
    const uncollectible = {
      ...paidInvoice(invoiceId, (await billRow(billId)).stripe_customer_id!, attempt),
      status: 'uncollectible',
    }
    const stripe = fakeStripe(new Map([[invoiceId, uncollectible as BillingInvoice]]))
    setBillingAdminProvider(stripe.provider)
    const done = await act(operator, 'billing.credit', {
      billingAccountId: billId,
      kind: 'credit',
      amountCents: 2000,
      reason,
      requestId: rid('req'),
      rechargeId: attempt,
    })
    expect(done.status).toBe(200)
    expect(stripe.stopped).toEqual([{ invoiceId, void: true }])
    expect(await balance(billId)).toBe(20_000_000)
  })
})

describe('refunds', () => {
  test('refunds the newest payment through a credit note, once per request id, and takes it off the balance', async () => {
    const { billId, periodId } = await billWith()
    const bill = await billRow(billId)
    await paidRecharge(billId, periodId)
    const newest = await paidRecharge(billId, periodId)
    const invoices = new Map([
      [newest.invoiceId, paidInvoice(newest.invoiceId, bill.stripe_customer_id!, newest.attempt)],
    ])
    const stripe = fakeStripe(invoices)
    setBillingAdminProvider(stripe.provider)
    const requestId = rid('req')
    const input = { billingAccountId: billId, amountCents: 500, reason, requestId }
    const first = await act(operator, 'billing.refund', input)
    expect(first.status).toBe(200)
    expect(stripe.refunds).toHaveLength(1)
    // Stripe's idempotency key is the refund's own row, written and committed before Stripe was asked (M2).
    const [row] = await db.select().from(billing_refunds).where(eq(billing_refunds.request_id, requestId))
    expect(row).toMatchObject({ status: 'posted', amount_cents: 500, ledger_entry_id: first.body.data.entryId })
    expect(stripe.refunds[0]).toMatchObject({
      invoiceId: newest.invoiceId,
      amountCents: 500,
      idempotencyKey: `refund_${row!.id}`,
    })
    expect(await balance(billId)).toBe(40_000_000 - 5_000_000)
    const [entry] = await db.select().from(ledger_entries).where(eq(ledger_entries.id, first.body.data.entryId))
    expect(entry).toMatchObject({
      kind: 'refund',
      source_type: 'stripe_refund',
      amount_micros: -5_000_000,
      actor_id: operator.userId,
    })
    expect(entry!.note).toMatch(/^refund_of=le_/)
    // Sent again (a double click, a retry): Stripe answers the same refund and the ledger keeps one entry.
    const again = await act(operator, 'billing.refund', input)
    expect(again.body.data).toMatchObject({
      posted: false,
      entryId: first.body.data.entryId,
      creditNoteId: first.body.data.creditNoteId,
    })
    expect(stripe.refunds).toHaveLength(1)
    expect(await balance(billId)).toBe(35_000_000)
    expect((await lastCommand('billing.refund'))?.input).toMatchObject({ reason, amountCents: 500 })
  })

  test('never more than the available balance, nor more than is left of the newest payment', async () => {
    const { billId, periodId, ws } = await billWith()
    const bill = await billRow(billId)
    const older = await paidRecharge(billId, periodId)
    const newest = await paidRecharge(billId, periodId, 2500)
    const stripe = fakeStripe(
      new Map([
        [older.invoiceId, paidInvoice(older.invoiceId, bill.stripe_customer_id!, older.attempt)],
        [newest.invoiceId, paidInvoice(newest.invoiceId, bill.stripe_customer_id!, newest.attempt, 2500)],
      ]),
    )
    setBillingAdminProvider(stripe.provider)
    // A running call holds $40: only $5 is available.
    await db
      .insert(call_reservations)
      .values({ call_id: ws.call.id, billing_account_id: billId, reserved_micros: 40_000_000 })
    const over = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 600,
      reason,
      requestId: rid('req'),
    })
    expect(over.status).toBe(409)
    expect(stripe.refunds).toHaveLength(0)
    await db.delete(call_reservations).where(eq(call_reservations.call_id, ws.call.id))
    // $30 is more than is left of the newest payment ($25): one payment at a time.
    const across = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 3000,
      reason,
      requestId: rid('req'),
    })
    expect(across.status).toBe(409)
    expect(stripe.refunds).toHaveLength(0)
    expect(
      (
        await act(operator, 'billing.refund', {
          billingAccountId: billId,
          amountCents: 2500,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(200)
    // The newest is used up: the next refund comes from the older one.
    expect(
      (
        await act(operator, 'billing.refund', {
          billingAccountId: billId,
          amountCents: 1000,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(200)
    expect(stripe.refunds.map(r => r.invoiceId)).toEqual([newest.invoiceId, older.invoiceId])
    expect(await balance(billId)).toBe(45_000_000 - 35_000_000)
  })

  test('refuses a payment with a dispute or an early fraud warning, and an invoice of another customer', async () => {
    const { billId, periodId } = await billWith()
    const bill = await billRow(billId)
    const paid = await paidRecharge(billId, periodId)
    const disputed = fakeStripe(
      new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, bill.stripe_customer_id!, paid.attempt)]]),
      ['dispute'],
    )
    setBillingAdminProvider(disputed.provider)
    const refused = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 500,
      reason,
      requestId: rid('req'),
    })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/dispute/)
    expect(disputed.refunds).toHaveLength(0)
    const foreign = fakeStripe(new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, rid('cus'), paid.attempt)]]))
    setBillingAdminProvider(foreign.provider)
    expect(
      (
        await act(operator, 'billing.refund', {
          billingAccountId: billId,
          amountCents: 500,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(409)
    expect(foreign.refunds).toHaveLength(0)
    expect(await balance(billId)).toBe(20_000_000)
  })

  test('after the last period ended, the refund posts in the latest period instead of paying out unposted (M1)', async () => {
    const { billId, periodId } = await billWith({ status: 'canceled' })
    const bill = await billRow(billId)
    const paid = await paidRecharge(billId, periodId)
    // The period ended ten days ago: no period covers now.
    await db
      .update(billing_periods)
      .set({
        starts_at: new Date(Date.now() - 40 * day).toISOString(),
        ends_at: new Date(Date.now() - 10 * day).toISOString(),
      })
      .where(eq(billing_periods.id, periodId))
    const stripe = fakeStripe(
      new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, bill.stripe_customer_id!, paid.attempt)]]),
    )
    setBillingAdminProvider(stripe.provider)
    const first = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 1000,
      reason,
      requestId: rid('req'),
    })
    expect(first.status).toBe(200)
    const [entry] = await db.select().from(ledger_entries).where(eq(ledger_entries.id, first.body.data.entryId))
    expect(entry).toMatchObject({ kind: 'refund', period_id: periodId, amount_micros: -10_000_000 })
    expect(await balance(billId)).toBe(10_000_000)
    expect(stripe.refunds).toHaveLength(1)
    // (A bill without any period has no payment to refund either: a ledger entry needs a period.)
  })

  test('a refund Stripe made whose transaction failed stays on record, is never made twice, and is posted later (M2)', async () => {
    const { billId, periodId } = await billWith()
    const bill = await billRow(billId)
    const paid = await paidRecharge(billId, periodId)
    const stripe = fakeStripe(
      new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, bill.stripe_customer_id!, paid.attempt)]]),
    )
    setBillingAdminProvider(stripe.provider)
    const me: Actor = { actorId: operator.userId, role: 'owner', workspaceId: null, permissions: ['instance:admin'] }
    const requestId = rid('req')
    const input = { billingAccountId: billId, amountCents: 800, reason, requestId }
    // Stripe refunds, then the transaction fails (a lost connection, the commit): no entry, but the row is committed.
    await expect(
      db.transaction(async tx => {
        await billingAdminHandlers['billing.refund']!({ tx, actor: me, now: new Date().toISOString() }, input)
        throw new Error('the connection dropped')
      }),
    ).rejects.toThrow('the connection dropped')
    expect(stripe.refunds).toHaveLength(1)
    expect(await balance(billId)).toBe(20_000_000)
    const [row] = await db.select().from(billing_refunds).where(eq(billing_refunds.request_id, requestId))
    expect(row).toMatchObject({ status: 'pending', amount_cents: 800 })
    // A new dialog right away: refused while that refund may still be waiting on Stripe, and Stripe is not asked.
    const waiting = await act(operator, 'billing.refund', { ...input, requestId: rid('req') })
    expect(waiting.status).toBe(409)
    expect(JSON.stringify(waiting.body)).toMatch(/waiting on Stripe/)
    expect(stripe.refunds).toHaveLength(1)
    // Minutes later the settlement (the next refund of the bill, the nightly reconciliation) finds the credit note by
    // the row's key and posts it, once.
    await db
      .update(billing_refunds)
      .set({ created_at: new Date(Date.now() - REFUND_SETTLE_AFTER_MS - 60_000).toISOString() })
      .where(eq(billing_refunds.id, row!.id))
    const settled = await db.transaction(async tx => {
      await lockBalance(tx, billId)
      return settlePendingRefunds(tx, stripe.provider, billId, new Date().toISOString())
    })
    expect(settled).toEqual({
      posted: [{ refundId: row!.id, creditNoteId: expect.stringMatching(/^cn_/) }],
      waiting: false,
    })
    expect(await balance(billId)).toBe(20_000_000 - 8_000_000)
    expect((await db.select().from(billing_refunds).where(eq(billing_refunds.id, row!.id)))[0]).toMatchObject({
      status: 'posted',
    })
    // The same dialog sent again answers the posted refund; Stripe is asked nothing more.
    const again = await act(operator, 'billing.refund', input)
    expect(again.status).toBe(200)
    expect(again.body.data.posted).toBe(false)
    expect(stripe.refunds).toHaveLength(1)
    expect(await balance(billId)).toBe(12_000_000)
  })

  test('a pending refund Stripe never made is voided, and the next refund goes ahead (M2)', async () => {
    const { billId, periodId } = await billWith()
    const bill = await billRow(billId)
    const paid = await paidRecharge(billId, periodId)
    const stripe = fakeStripe(
      new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, bill.stripe_customer_id!, paid.attempt)]]),
    )
    setBillingAdminProvider(stripe.provider)
    const [entry] = await db.select().from(ledger_entries).where(eq(ledger_entries.billing_account_id, billId))
    const lost = rid('rf')
    await db.insert(billing_refunds).values({
      id: lost,
      billing_account_id: billId,
      request_id: rid('req'),
      payment_entry_id: entry!.id,
      stripe_invoice_id: paid.invoiceId,
      stripe_line_id: rid('il'),
      amount_cents: 500,
      period_id: periodId,
      reason,
      created_at: new Date(Date.now() - REFUND_SETTLE_AFTER_MS - 60_000).toISOString(),
    })
    const next = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 500,
      reason,
      requestId: rid('req'),
    })
    expect(next.status).toBe(200)
    expect((await db.select().from(billing_refunds).where(eq(billing_refunds.id, lost)))[0]?.status).toBe('void')
    expect(stripe.refunds).toHaveLength(1)
    expect(await balance(billId)).toBe(15_000_000)
  })

  test('nothing is asked of Stripe while billing is not in effect', async () => {
    const { billId, periodId } = await billWith()
    await paidRecharge(billId, periodId)
    const answer = await act(operator, 'billing.refund', {
      billingAccountId: billId,
      amountCents: 500,
      reason,
      requestId: rid('req'),
    })
    expect(answer.status).toBe(409)
    expect(JSON.stringify(answer.body)).toMatch(/not in effect/)
  })
})

describe('status, cap, concurrency, owner and review', () => {
  test('suspend and resume follow on the workspaces; comp; a canceled bill stays canceled', async () => {
    const { billId, ws } = await billWith()
    const suspended = await act(operator, 'billing.adminSetStatus', {
      billingAccountId: billId,
      status: 'suspended',
      reason,
    })
    expect(suspended.status).toBe(200)
    expect(await billRow(billId)).toMatchObject({ status: 'suspended', suspend_reason: 'admin' })
    const [org] = await db.select().from(organization).where(eq(organization.id, ws.id))
    expect(org?.billingState).toBe('suspended')
    await act(operator, 'billing.adminSetStatus', { billingAccountId: billId, status: 'active', reason })
    expect(await billRow(billId)).toMatchObject({ status: 'active', suspend_reason: null, suspended_at: null })
    await act(operator, 'billing.adminSetStatus', { billingAccountId: billId, status: 'comped', reason })
    expect((await billRow(billId)).status).toBe('comped')
    expect((await lastCommand('billing.adminSetStatus'))?.input).toMatchObject({ status: 'comped', reason })
    const canceled = await billWith({ status: 'canceled' })
    expect(
      (await act(operator, 'billing.adminSetStatus', { billingAccountId: canceled.billId, status: 'active', reason }))
        .status,
    ).toBe(409)
  })

  test('resume is only for a suspended or comped bill: never past Checkout or dunning (L2)', async () => {
    const pending = await billWith({ status: 'pending_payment' })
    const pastDue = await billWith({ status: 'past_due', past_due_since: new Date().toISOString() })
    for (const { billId } of [pending, pastDue])
      expect(
        (await act(operator, 'billing.adminSetStatus', { billingAccountId: billId, status: 'active', reason })).status,
      ).toBe(409)
    expect((await billRow(pending.billId)).status).toBe('pending_payment')
    expect(await billRow(pastDue.billId)).toMatchObject({ status: 'past_due', past_due_since: expect.any(String) })
  })

  test('suspend then resume goes back to where the bill was: never past Checkout or dunning (re-review of #919, R3)', async () => {
    const since = '2026-11-01T00:00:00.000Z'
    const pending = await billWith({ status: 'pending_payment' })
    const pastDue = await billWith({ status: 'past_due', past_due_since: since })
    const setStatus = (billId: string, status: string) =>
      act(operator, 'billing.adminSetStatus', { billingAccountId: billId, status, reason })
    for (const { billId } of [pending, pastDue]) {
      expect((await setStatus(billId, 'suspended')).status).toBe(200)
      expect((await setStatus(billId, 'active')).status).toBe(200)
    }
    expect(await billRow(pending.billId)).toMatchObject({ status: 'pending_payment', suspended_from: null })
    expect(Date.parse((await billRow(pastDue.billId)).past_due_since!)).toBe(Date.parse(since))
    expect(await billRow(pastDue.billId)).toMatchObject({ status: 'past_due', suspend_reason: null })
    const [org] = await db.select().from(organization).where(eq(organization.id, pending.ws.id))
    expect(org?.billingState).toBe('pending_payment')
    // The same through a review deny: a held bill waiting for Checkout is denied, then resumed, and still waits.
    const held = await billWith({ status: 'pending_payment', held_for_review_at: new Date().toISOString() })
    await act(operator, 'billing.reviewHold', { billingAccountId: held.billId, decision: 'deny', reason })
    expect(await billRow(held.billId)).toMatchObject({ status: 'suspended', suspended_from: 'pending_payment' })
    expect((await setStatus(held.billId, 'active')).status).toBe(200)
    expect((await billRow(held.billId)).status).toBe('pending_payment')
    // An active bill suspended and resumed is active again, as before.
    const active = await billWith()
    await setStatus(active.billId, 'suspended')
    await setStatus(active.billId, 'active')
    expect((await billRow(active.billId)).status).toBe('active')
  })

  test("the concurrency cap per bill is the gate's cap", async () => {
    const { billId, ws } = await billWith()
    expect(
      (await act(operator, 'billing.setConcurrency', { billingAccountId: billId, concurrentCalls: 1, reason })).status,
    ).toBe(200)
    await db.insert(billing_balances).values({ billing_account_id: billId }).onConflictDoNothing()
    await db.insert(ledger_entries).values({
      id: rid('le'),
      billing_account_id: billId,
      period_id: (await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, billId)))[0]!.id,
      kind: 'credit',
      amount_micros: 100_000_000,
      source_type: 'admin',
      source_id: rid('req'),
    })
    const now = new Date().toISOString()
    const reserve = (callId: string) =>
      db.transaction(tx =>
        reserveCall(tx, {
          callId,
          billId,
          workspaceId: ws.id,
          level: 'standard',
          ownKeys: false,
          limitSeconds: 600,
          now,
        }),
      )
    expect(await reserve(ws.call.id)).toMatchObject({ allow: true })
    const [second] = await db
      .insert(calls)
      .values({ id: rid('call'), workspace_id: ws.id, from_number: '+15035550111', to_number: ws.number })
      .returning()
    expect(await reserve(second!.id)).toMatchObject({ allow: false, reason: 'too_many_calls' })
    await act(operator, 'billing.setConcurrency', { billingAccountId: billId, concurrentCalls: null, reason })
    expect(await reserve(second!.id)).toMatchObject({ allow: true })
  })

  test('the cap base can be set above the owner limit', async () => {
    const { billId } = await billWith()
    expect(
      (await act(operator, 'billing.setCap', { billingAccountId: billId, capBaseCents: 250_000, reason })).status,
    ).toBe(200)
    expect((await billRow(billId)).recharge_cap_base_cents).toBe(250_000)
  })

  test('the bill goes only to a member of one of its workspaces', async () => {
    const { billId, ws } = await billWith()
    expect(
      (await act(operator, 'billing.transferOwner', { billingAccountId: billId, userId: other.owner.userId, reason }))
        .status,
    ).toBe(409)
    const teammate = await addMember(ws.id, 'admin')
    expect(
      (await act(operator, 'billing.transferOwner', { billingAccountId: billId, userId: teammate.userId, reason }))
        .status,
    ).toBe(200)
    expect((await billRow(billId)).owner_user_id).toBe(teammate.userId)
  })

  test('review: approve lifts the hold, deny suspends; listed while held', async () => {
    const held = await billWith({
      held_for_review_at: new Date().toISOString(),
      status: 'trialing',
      card_risk_level: 'elevated',
    })
    const list = await act(operator, 'billing.adminReview', {})
    // Radar's risk of the card check is shown with the hold, on the list and the bill.
    expect(list.body.data.held).toContainEqual(
      expect.objectContaining({ billId: held.billId, cardRiskLevel: 'elevated' }),
    )
    const detail = await act(operator, 'billing.adminBill', { billingAccountId: held.billId })
    expect(detail.body.data.cardRiskLevel).toBe('elevated')
    expect(
      (await act(operator, 'billing.reviewHold', { billingAccountId: held.billId, decision: 'approve', reason }))
        .status,
    ).toBe(200)
    expect((await billRow(held.billId)).held_for_review_at).toBeNull()
    expect(
      (await act(operator, 'billing.reviewHold', { billingAccountId: held.billId, decision: 'approve', reason }))
        .status,
    ).toBe(409)
    const denied = await billWith({ held_for_review_at: new Date().toISOString(), status: 'trialing' })
    await act(operator, 'billing.reviewHold', { billingAccountId: denied.billId, decision: 'deny', reason })
    expect(await billRow(denied.billId)).toMatchObject({ status: 'suspended', suspend_reason: 'admin' })
    // A canceled bill stays canceled (L2): a deny would make it suspended, and a resume would then revive it.
    const canceled = await billWith({ held_for_review_at: new Date().toISOString(), status: 'canceled' })
    expect(
      (await act(operator, 'billing.reviewHold', { billingAccountId: canceled.billId, decision: 'deny', reason }))
        .status,
    ).toBe(409)
    expect((await billRow(canceled.billId)).status).toBe('canceled')
  })

  test('a suspended bill always says why: the database refuses one without a reason (L1)', async () => {
    const { billId } = await billWith()
    await expect(
      db.update(billing_accounts).set({ status: 'suspended' }).where(eq(billing_accounts.id, billId)),
    ).rejects.toThrow()
    expect((await billRow(billId)).status).toBe('active')
  })
})

describe('moving a workspace', () => {
  test('onto a bill in its trial: refused once it holds the trial workspace limit (L-3)', async () => {
    const from = await billWith({})
    const to = await billWith({ status: 'trialing' })
    setBillingAdminProvider(fakeStripe(new Map()).provider)
    const input = () => ({ workspaceId: from.ws.id, toBillingAccountId: to.billId, reason, requestId: rid('req') })
    // The default cloud limit is one workspace, and the trial bill holds one already.
    const refused = await act(operator, 'billing.moveWorkspace', input())
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/trialWorkspaceLimit|in its trial/)
    expect((await act(operator, 'signup.setRules', { rules: { trialWorkspacesCloud: 2 }, reason })).status).toBe(200)
    try {
      expect((await act(operator, 'billing.moveWorkspace', input())).status).toBe(200)
    } finally {
      await act(operator, 'signup.setRules', { rules: { trialWorkspacesCloud: null }, reason })
    }
  })

  test('refused while it has calls running; then moved, and both seat quantities follow in Stripe', async () => {
    const from = await billWith({ stripe_subscription_id: rid('sub'), interval: 'year' })
    const to = await billWith({ stripe_subscription_id: rid('sub'), interval: 'year' })
    const stripe = fakeStripe(new Map())
    setBillingAdminProvider(stripe.provider)
    await db
      .insert(call_reservations)
      .values({ call_id: from.ws.call.id, billing_account_id: from.billId, reserved_micros: 0 })
    const requestId = rid('req')
    const input = { workspaceId: from.ws.id, toBillingAccountId: to.billId, reason, requestId }
    expect((await act(operator, 'billing.moveWorkspace', input)).status).toBe(409)
    expect(stripe.seats).toHaveLength(0)
    await db.delete(call_reservations).where(eq(call_reservations.call_id, from.ws.call.id))
    expect((await act(operator, 'billing.moveWorkspace', input)).status).toBe(200)
    const [org] = await db.select().from(organization).where(eq(organization.id, from.ws.id))
    expect(org?.billingAccountId).toBe(to.billId)
    // The source shrinks first, then the target grows (M2).
    expect(stripe.seats).toEqual([
      {
        subscriptionId: (await billRow(from.billId)).stripe_subscription_id,
        quantity: 0,
        prorationBehavior: 'none',
        idempotencyKey: `move_${requestId}_${from.billId}`,
      },
      {
        subscriptionId: (await billRow(to.billId)).stripe_subscription_id,
        quantity: 2,
        prorationBehavior: 'always_invoice',
        idempotencyKey: `move_${requestId}_${to.billId}`,
      },
    ])
  })

  test('extra calls at the same time follow the workspace (LIN-450); onto a comped bill (no subscription) they stay behind', async () => {
    catalog.prices = { extra_calls_monthly: 'price_xc_month', extra_calls_yearly: 'price_xc_year' }
    const from = await billWith({ stripe_subscription_id: rid('sub'), interval: 'month' })
    const to = await billWith({ stripe_subscription_id: rid('sub'), interval: 'year' })
    await db.update(organization).set({ extraCalls: 10 }).where(eq(organization.id, from.ws.id))
    const stripe = fakeStripe(new Map())
    setBillingAdminProvider(stripe.provider)
    const requestId = rid('req')
    const input = { workspaceId: from.ws.id, toBillingAccountId: to.billId, reason, requestId }
    expect((await act(operator, 'billing.moveWorkspace', input)).status).toBe(200)
    // Each bill under its own lock, as summed then: the source is never refunded, the target pays for the growth.
    expect(stripe.extraCalls).toEqual([
      {
        subscriptionId: (await billRow(from.billId)).stripe_subscription_id,
        priceId: 'price_xc_month',
        quantity: 0,
        paidUpTo: 0,
        charge: false,
        idempotencyKey: `move_extra_calls_${requestId}:${from.billId}`,
      },
      {
        subscriptionId: (await billRow(to.billId)).stripe_subscription_id,
        priceId: 'price_xc_year',
        quantity: 10,
        paidUpTo: 0,
        charge: true,
        idempotencyKey: `move_extra_calls_${requestId}:${to.billId}`,
      },
    ])
    expect(await billRow(to.billId)).toMatchObject({ extra_calls_paid: 10 })
    const comped = await billWith({ status: 'comped', stripe_subscription_id: null })
    const back = { workspaceId: from.ws.id, toBillingAccountId: comped.billId, reason, requestId: rid('req') }
    expect((await act(operator, 'billing.moveWorkspace', back)).status).toBe(200)
    const [org] = await db.select().from(organization).where(eq(organization.id, from.ws.id))
    expect(org?.extraCalls).toBe(0)
    expect(stripe.extraCalls.at(-1)).toMatchObject({ quantity: 0, charge: false })
  })

  test('extra calls Stripe could not take after a move: logged and the admins are told (review of #1103, L-3)', async () => {
    const from = await billWith({ stripe_subscription_id: rid('sub'), interval: 'month' })
    const to = await billWith({ stripe_subscription_id: rid('sub'), interval: 'month' })
    await db.update(organization).set({ extraCalls: 5 }).where(eq(organization.id, from.ws.id))
    const stripe = fakeStripe(new Map())
    stripe.provider.setExtraCallsQuantity = async () => 'payment_failed'
    setBillingAdminProvider(stripe.provider)
    catalog.prices = { extra_calls_monthly: 'price_xc_month', extra_calls_yearly: 'price_xc_year' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const input = { workspaceId: from.ws.id, toBillingAccountId: to.billId, reason, requestId: rid('req') }
    expect((await act(operator, 'billing.moveWorkspace', input)).status).toBe(200)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`ALERT billing extra calls: bill ${to.billId}`),
      expect.anything(),
    )
    // The target paid nothing, so nothing counts as paid.
    expect(await billRow(to.billId)).toMatchObject({ extra_calls_paid: 0 })
  })

  test('seats change only after the move committed: a refused seat change never leaves a charge for no move (M2)', async () => {
    const from = await billWith({ stripe_subscription_id: rid('sub'), interval: 'year' })
    const to = await billWith({ stripe_subscription_id: rid('sub'), interval: 'year' })
    // Stripe refuses the source's change (its subscription was canceled there).
    const stripe = fakeStripe(new Map(), [], [(await billRow(from.billId)).stripe_subscription_id!])
    const seen: (string | null)[] = []
    const setSeats = stripe.provider.setSeatQuantity
    stripe.provider.setSeatQuantity = async input => {
      // What another connection sees when Stripe is asked: the move is committed already.
      const [org] = await db.select().from(organization).where(eq(organization.id, from.ws.id))
      seen.push(org?.billingAccountId ?? null)
      return setSeats(input)
    }
    setBillingAdminProvider(stripe.provider)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await act(operator, 'billing.moveWorkspace', {
      workspaceId: from.ws.id,
      toBillingAccountId: to.billId,
      reason,
      requestId: rid('req'),
    })
    expect(answer.status).toBe(200)
    expect(seen).toEqual([to.billId, to.billId])
    // The target pays for the workspace it now has; the source's refused change is logged for the reconciliation.
    expect(stripe.seats.map(s => s.quantity)).toEqual([0, 2])
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ALERT billing seats/), expect.anything())
  })

  test('a second move of the same workspace acts on where it is now, not where it was (L3)', async () => {
    const from = await billWith({ stripe_customer_id: null })
    const a = await billWith({ stripe_customer_id: null })
    const b = await billWith({ stripe_customer_id: null })
    const me: Actor = { actorId: operator.userId, role: 'owner', workspaceId: null, permissions: ['instance:admin'] }
    const move = (to: string) => (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
      billingAdminHandlers['billing.moveWorkspace']!(
        { tx, actor: me, now: new Date().toISOString(), onCommit: () => {} },
        { workspaceId: from.ws.id, toBillingAccountId: to, reason, requestId: rid('req') },
      )
    // The first move has taken the locks and moved the workspace, not yet committed.
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let moved!: () => void
    const firstMoved = new Promise<void>(resolve => {
      moved = resolve
    })
    const first = db.transaction(async tx => {
      const result = await move(a.billId)(tx)
      moved()
      await held
      return result
    })
    await firstMoved
    // The second reads the workspace's bill (still the old one for it) and then waits for the first's locks.
    const second = db.transaction(tx => move(b.billId)(tx))
    const waitingOnLock = async () =>
      (
        await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        )
      ).rows[0]?.n as number
    for (let i = 0; i < 600 && !(await waitingOnLock()); i++) await new Promise(r => setTimeout(r, 50))
    release()
    expect(await first).toMatchObject({ data: { from: from.billId, to: a.billId } })
    await expect(second).rejects.toThrow(/moved to another bill meanwhile/)
    const [org] = await db.select().from(organization).where(eq(organization.id, from.ws.id))
    expect(org?.billingAccountId).toBe(a.billId)
  })

  test('bills without a subscription move without Stripe; not onto a canceled bill', async () => {
    const from = await billWith({ stripe_customer_id: null })
    const to = await billWith({ stripe_customer_id: null })
    expect(
      (
        await act(operator, 'billing.moveWorkspace', {
          workspaceId: from.ws.id,
          toBillingAccountId: to.billId,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(200)
    const gone = await billWith({ status: 'canceled' })
    expect(
      (
        await act(operator, 'billing.moveWorkspace', {
          workspaceId: from.ws.id,
          toBillingAccountId: gone.billId,
          reason,
          requestId: rid('req'),
        })
      ).status,
    ).toBe(409)
  })
})

describe("a new bill owner keeps the assistants' levels (LIN-589, replaces LIN-438)", () => {
  const move = (workspaceId: string, toBillingAccountId: string) =>
    act(operator, 'billing.moveWorkspace', { workspaceId, toBillingAccountId, reason, requestId: rid('req') })

  test("moved onto someone else's bill: the assistant keeps Premium and its models", async () => {
    const from = await billWith({ stripe_customer_id: null })
    const to = await billWith({ stripe_customer_id: null })
    await withPremiumAndUltra(from.ws)
    const moved = await move(from.ws.id, to.billId)
    expect(moved.status).toBe(200)
    expect(moved.body.data).toEqual({ from: from.billId, to: to.billId })
    expect(await premiumAndUltraOf(from.ws)).toEqual(KEPT_PREMIUM_AND_ULTRA)
    const versions = await db
      .select()
      .from(assistant_versions)
      .where(
        and(
          eq(assistant_versions.assistant_id, from.ws.assistant.id),
          eq(assistant_versions.changed_by, operator.userId),
        ),
      )
    expect(versions).toEqual([])
  })

  test("after a move onto someone else's bill the workspace's owner raises again: who pays is not asked (decisions.md 2026-11-18)", async () => {
    cloud.on = true
    onTestFinished(() => {
      cloud.on = false
    })
    const from = await billWith({ stripe_customer_id: null })
    const to = await billWith({ stripe_customer_id: null })
    // The bill lock of #1050 is gone with "only who pays raises": the move and the raise need no order between them.
    await db.update(organization).set({ billingAccountId: to.billId }).where(eq(organization.id, from.ws.id))
    const raised = await act(from.ws.owner, 'assistant.update', {
      assistantId: from.ws.assistant.id,
      call_quality: 'premium',
    })
    expect(raised.status).toBe(200)
    expect((await premiumAndUltraOf(from.ws)).level).toBe('premium')
  })

  test("an instance admin's transfer keeps them on every workspace of the bill", async () => {
    const { billId, ws } = await billWith({ stripe_customer_id: null })
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: billId }).where(eq(organization.id, second.id))
    await withPremiumAndUltra(ws)
    await withPremiumAndUltra(second)
    const teammate = await addMember(ws.id, 'admin')
    const done = await act(operator, 'billing.transferOwner', {
      billingAccountId: billId,
      userId: teammate.userId,
      reason,
    })
    expect(done.status).toBe(200)
    expect(done.body.data).toEqual({ previous: ws.owner.userId, owner: teammate.userId })
    for (const w of [ws, second]) expect(await premiumAndUltraOf(w)).toEqual(KEPT_PREMIUM_AND_ULTRA)
  })
})

describe('reports', () => {
  test("paid usage is the sum of amounts: a comped call's billable seconds count $0", async () => {
    const { billId, periodId, ws } = await billWith({ status: 'comped' })
    await db.insert(ledger_entries).values({
      id: rid('le'),
      billing_account_id: billId,
      workspace_id: ws.id,
      period_id: periodId,
      kind: 'usage',
      amount_micros: 0,
      seconds: 120,
      included_seconds: 0,
      billable_seconds: 120,
      price_basis: 'standard',
      source_type: 'call',
      source_id: ws.call.id,
    })
    const detail = await act(operator, 'billing.adminBill', { billingAccountId: billId })
    expect(detail.status).toBe(200)
    expect(detail.body.data.usage).toEqual([
      { workspaceId: ws.id, workspaceName: 'Brightwater Plumbing & Heating', seconds: 120, paidMicros: 0 },
    ])
    expect(detail.body.data.ledger[0]).toMatchObject({ kind: 'usage', amountMicros: 0 })
    const bills = await act(operator, 'billing.adminBills', {})
    expect(bills.body.data.bills.some((b: { id: string }) => b.id === billId)).toBe(true)
  })
})

describe('Stripe events', () => {
  test('lists the inbox by state, and reprocess queues a failed one again', async () => {
    const at = new Date().toISOString()
    const event = (over: Partial<typeof stripe_events.$inferInsert>) => ({
      id: rid('evt'),
      type: 'invoice.paid',
      livemode: false,
      created: at,
      received_at: at,
      payload: { data: { object: { id: rid('in'), object: 'invoice', customer: null } } },
      ...over,
    })
    const done = event({ processed_at: at })
    const failed = event({ attempts: STRIPE_EVENT_ATTEMPTS, last_error: 'Stripe is down' })
    const later = event({
      // A type no release acts on (customer.subscription.updated is handled since #1007).
      type: 'customer.subscription.created',
      attempts: STRIPE_EVENT_ATTEMPTS,
      last_error: UNHANDLED_TYPE,
    })
    await db.insert(stripe_events).values([done, failed, later])
    const states = async (filter: string) =>
      Object.fromEntries(
        (await act(operator, 'billing.adminEvents', { filter })).body.data.events.map(
          (e: { id: string; state: string }) => [e.id, e.state],
        ),
      )
    expect(await states('all')).toMatchObject({
      [done.id]: 'processed',
      [failed.id]: 'failed',
      [later.id]: 'unhandled',
    })
    expect(Object.keys(await states('failed'))).toEqual([failed.id])
    expect(Object.keys(await states('unhandled'))).toEqual([later.id])
    // Like every billing write it asks why (I3).
    expect((await act(operator, 'billing.reprocessEvent', { eventId: failed.id })).status).toBe(422)
    expect((await act(operator, 'billing.reprocessEvent', { eventId: failed.id, reason })).status).toBe(200)
    expect(await states('all')).toMatchObject({ [failed.id]: 'waiting' })
    expect((await lastCommand('billing.reprocessEvent'))?.input).toMatchObject({ eventId: failed.id, reason })
  })
})

describe('the summary', () => {
  test('counts bills by status, holds, new trials and open events as the lists do, in one read', async () => {
    const read = async () => (await act(operator, 'billing.adminSummary', {})).body.data
    const before = await read()
    expect(before.billing).toMatchObject({ on: false, inEffect: 'none' })
    expect(before.selfServe).toMatchObject({ on: false, open: false, closedBecause: 'switched_off' })
    expect(before.automaticTax).toBe(BILLING_DEFAULTS.automaticTax)
    await billWith({ status: 'past_due' })
    await billWith({ status: 'trialing' })
    await billWith({ status: 'trialing', held_for_review_at: new Date().toISOString() })
    await billWith({ status: 'trialing', created_at: new Date(Date.now() - 30 * day).toISOString() })
    const at = new Date().toISOString()
    const event = (over: Partial<typeof stripe_events.$inferInsert>) => ({
      id: rid('evt'),
      type: 'invoice.paid',
      livemode: false,
      created: at,
      received_at: at,
      payload: { data: { object: { id: rid('in'), object: 'invoice', customer: null } } },
      ...over,
    })
    await db
      .insert(stripe_events)
      .values([
        event({ processed_at: at }),
        event({ attempts: 1 }),
        event({ attempts: STRIPE_EVENT_ATTEMPTS, last_error: 'Stripe is down' }),
        event({ attempts: STRIPE_EVENT_ATTEMPTS, last_error: UNHANDLED_TYPE }),
      ])
    const after = await read()
    expect(after.bills.past_due - before.bills.past_due).toBe(1)
    expect(after.bills.trialing - before.bills.trialing).toBe(3)
    expect(after.held - before.held).toBe(1)
    // The review list's second part: started in the last 7 days and not held.
    expect(after.newTrials - before.newTrials).toBe(1)
    expect({
      waiting: after.events.waiting - before.events.waiting,
      failed: after.events.failed - before.events.failed,
      unhandled: after.events.unhandled - before.events.unhandled,
    }).toEqual({ waiting: 1, failed: 1, unhandled: 1 })
  })
})

describe('the billing rules editor', () => {
  test('refuses anything out of range or unknown, stores the rest, emails every instance admin, is audited', async () => {
    const mails = mailbox()
    const bad = await act(operator, 'billingRules.set', {
      rules: { includedStandardSeconds: -1, levels: { standard: { microsPerMinute: 50_000, allowanceFactor: 1 } } },
      reason,
    })
    expect(bad.status).toBe(409)
    expect(JSON.stringify(bad.body)).toMatch(/includedStandardSeconds/)
    expect(await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))).toEqual([])
    expect((await act(operator, 'billingRules.set', { rules: { madeUp: 1 }, reason })).status).toBe(409)
    const good = await act(operator, 'billingRules.set', {
      rules: { includedStandardSeconds: 1800, levels: { premium: { microsPerMinute: 120_000, allowanceFactor: 2 } } },
      reason,
    })
    expect(good.status).toBe(200)
    expect(good.body.data.changed).toEqual(['includedStandardSeconds', 'levels'])
    const rules = await billingRules(db)
    expect(rules.includedStandardSeconds).toBe(1800)
    expect(rules.levels.premium.microsPerMinute).toBe(120_000)
    expect(rules.levels.standard.microsPerMinute).toBe(50_000)
    await vi.waitFor(() => expect(mails.some(m => m.subject === 'The billing rules were changed')).toBe(true))
    const mail = mails.find(m => m.subject === 'The billing rules were changed')!
    expect(mail.text).toMatch(/includedStandardSeconds, levels/)
    expect(mail.text).toContain(reason)
    expect((await lastCommand('billingRules.set'))?.input).toMatchObject({ reason })
  })

  test("the server's minimum price per minute holds (Linedesk Cloud); without it 0 is allowed", async () => {
    const free = { levels: { standard: { microsPerMinute: 0, allowanceFactor: 1 } } }
    expect((await act(operator, 'billingRules.set', { rules: free, reason })).status).toBe(200)
    process.env.BILLING_MIN_MICROS_PER_MINUTE = '10000'
    const refused = await act(operator, 'billingRules.set', { rules: free, reason })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/levels.standard.microsPerMinute/)
    expect((await act(operator, 'billingRules.get', {})).body.data.minMicrosPerMinute).toBe(10_000)
  })

  test('a read of the rules never asks Stripe; the confirm dialog asks for the tax-address count on its own (review #1105, N-1)', async () => {
    expect((await act(operator, 'billingRules.get', {})).body.data).not.toHaveProperty('taxAddressMissing')
    // Billing through Stripe is not in effect here: not known.
    expect((await act(operator, 'billing.adminTaxAddressMissing', {})).body).toMatchObject({
      ok: true,
      data: { taxAddressMissing: null },
    })
  })
  test('a save merges over the stored rules: a field left out keeps its value, null resets it (review of #1040, I-6)', async () => {
    const set = (rules: Record<string, unknown>) => act(operator, 'billingRules.set', { rules, reason })
    expect(
      (
        await set({
          workspaceMonthlyCents: 1300,
          levels: { ultra: { microsPerMinute: 250_000, allowanceFactor: null } },
        })
      ).status,
    ).toBe(200)
    // An older admin tab, an MCP or API client that sends only some fields: the plan price stays.
    const partial = await set({ trialDays: 7 })
    expect(partial.status).toBe(200)
    expect(partial.body.data.changed).toEqual(['trialDays'])
    expect(await billingRules(db)).toMatchObject({
      workspaceMonthlyCents: 1300,
      trialDays: 7,
      levels: { ultra: { microsPerMinute: 250_000 } },
    })
    // null: back to the default, for a field and for one level.
    expect((await set({ workspaceMonthlyCents: null, trialDays: null, levels: { ultra: null } })).status).toBe(200)
    const back = await billingRules(db)
    expect(back.workspaceMonthlyCents).toBe(BILLING_DEFAULTS.workspaceMonthlyCents)
    expect(back.trialDays).toBe(BILLING_DEFAULTS.trialDays)
    expect(back.levels.ultra).toEqual(BILLING_DEFAULTS.levels.ultra)
    const stored = JSON.parse(
      (await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY)))[0]!.value,
    )
    expect(stored).not.toHaveProperty('workspaceMonthlyCents')
    expect(stored.levels ?? {}).not.toHaveProperty('ultra')
  })

  test('plan prices have a floor (a seat covers its included minutes) and yearly is at most 12 monthly (review of #1040, L-6)', async () => {
    const set = (rules: Record<string, unknown>) => act(operator, 'billingRules.set', { rules, reason })
    // The defaults where the floor comes from: 50 included minutes at $0.05 = $2.50 a month.
    expect((await set({ includedStandardSeconds: null, levels: { standard: null, premium: null } })).status).toBe(200)
    expect((await act(operator, 'billingRules.get', {})).body.data).toMatchObject({ minPlanCents: 250 })
    const tooLow = await set({ workspaceMonthlyCents: 249 })
    expect(tooLow).toMatchObject({ status: 409, body: { code: PLAN_PRICE_FLOOR } })
    expect(JSON.stringify(tooLow.body)).toMatch(/\$2\.50 a month.*workspaceMonthlyCents/)
    expect((await set({ workspaceMonthlyCents: 250, workspaceYearlyCents: 3000 })).status).toBe(200)
    expect((await set({ workspaceYearlyCents: 2999 })).status).toBe(409)
    // Yearly at most 12 monthly fees.
    const yearly = await set({ partnerYearlyCents: 12 * BILLING_DEFAULTS.partnerMonthlyCents + 1 })
    expect(yearly.status).toBe(409)
    expect(JSON.stringify(yearly.body)).toMatch(/partnerYearlyCents/)
    // Raising the included minutes raises the floor: a save that would leave a fee under it is refused.
    expect((await set({ includedStandardSeconds: 60 * 60 })).status).toBe(409)
    // The server's own floor (Linedesk Cloud).
    process.env.BILLING_MIN_PLAN_CENTS = '900'
    try {
      expect((await set({ workspaceMonthlyCents: 899, workspaceYearlyCents: 10_800 })).status).toBe(409)
      expect((await set({ workspaceMonthlyCents: 900, workspaceYearlyCents: 10_800 })).status).toBe(200)
    } finally {
      delete process.env.BILLING_MIN_PLAN_CENTS
    }
    // Nothing refused was stored.
    expect(await billingRules(db)).toMatchObject({ workspaceMonthlyCents: 900, workspaceYearlyCents: 10_800 })
    expect((await set({ workspaceMonthlyCents: null, workspaceYearlyCents: null })).status).toBe(200)
  })
})

describe('self-serve sign-up', () => {
  test('off by default; on only with billing in effect and the terms set; audited and emailed', async () => {
    for (const name of ['TERMS_URL', 'TERMS_VERSION', 'PRIVACY_URL', 'PRIVACY_VERSION']) vi.stubEnv(name, '')
    const allMissing = ['TERMS_URL', 'TERMS_VERSION', 'PRIVACY_URL', 'PRIVACY_VERSION']
    expect((await act(operator, 'signup.getSelfServe', {})).body.data).toMatchObject({
      on: false,
      billingInEffect: false,
      open: false,
      closedBecause: 'switched_off',
      rules: SIGNUP_DEFAULTS,
      defaults: SIGNUP_DEFAULTS,
      problems: [],
      termsMissing: allMissing,
    })
    const refused = await act(operator, 'signup.setSelfServe', { on: true, reason })
    expect(refused.status).toBe(409)
    expect(await db.select().from(instance_settings).where(eq(instance_settings.key, SELF_SERVE_KEY))).toEqual([])
    // Billing in effect: Stripe keys stored and the switch on (a fake Stripe confirms the account).
    setBillingFetch(
      async () =>
        new Response(JSON.stringify({ id: 'acct_1Brightwater', object: 'account', country: 'US' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'request-id': 'req_t' },
        }),
    )
    expect(
      (
        await act(operator, 'provider.setKeys', {
          provider: 'stripe',
          values: { secret_key: TEST_KEY, webhook_secret: WEBHOOK },
        })
      ).status,
    ).toBe(200)
    expect((await act(operator, 'billingEnabled.set', { on: true })).status).toBe(200)
    // No terms in the environment (A9): refused, and the answer names what to set.
    const noTerms = await act(operator, 'signup.setSelfServe', { on: true, reason })
    expect(noTerms.status).toBe(409)
    expect(noTerms.body.error).toContain('TERMS_URL, TERMS_VERSION, PRIVACY_URL, PRIVACY_VERSION')
    vi.stubEnv('TERMS_URL', 'https://desk.example.com/terms')
    vi.stubEnv('TERMS_VERSION', '2026-11-17')
    vi.stubEnv('PRIVACY_URL', 'https://desk.example.com/privacy')
    vi.stubEnv('PRIVACY_VERSION', '2026-11-17')
    const mails = mailbox()
    const on = await act(operator, 'signup.setSelfServe', { on: true, reason })
    expect(on.status).toBe(200)
    // Switched on, but closed until Turnstile has keys: the page says so instead of showing only the switch.
    expect(on.body.data).toMatchObject({
      on: true,
      billingInEffect: true,
      open: false,
      closedBecause: 'bot_check_missing',
      turnstileReady: false,
      termsMissing: [],
    })
    await vi.waitFor(() => expect(mails.some(m => m.subject === 'Self-serve sign-up was turned on')).toBe(true))
    expect((await lastCommand('signup.setSelfServe'))?.input).toMatchObject({ on: true, reason })
    // Without the bot check it is open.
    const rules = await act(operator, 'signup.setRules', { rules: { turnstile: false }, reason })
    expect(rules.status).toBe(200)
    expect(rules.body.data).toMatchObject({
      on: true,
      open: true,
      closedBecause: null,
      changed: ['turnstile'],
      ruleChanges: [{ field: 'turnstile', from: true, to: false }],
    })
    // That opened sign-up: the email says so in its subject, and names the bot check as off (L-1).
    await vi.waitFor(() =>
      expect(mails.some(m => m.subject === 'Sign-up is now open: the sign-up rules were changed')).toBe(true),
    )
    const opened = mails.find(m => m.subject === 'Sign-up is now open: the sign-up rules were changed')!
    expect(opened.text).toContain('Sign-up is now open')
    expect(opened.text).toContain('The bot check is now OFF')
    expect(opened.text).toContain('Bot check (Cloudflare Turnstile): on → off')
    // The audit log keeps the value before, not only the input.
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=admin&limit=50')).body as {
      entries: { what: string; ruleChanges?: unknown }[]
    }
    expect(entries.find(e => e.what === 'signup.setRules')?.ruleChanges).toEqual([
      { field: 'turnstile', from: true, to: false },
    ])
    expect((await act(operator, 'signup.setRules', { rules: { turnstile: null }, reason })).status).toBe(200)
    expect((await act(operator, 'signup.setSelfServe', { on: false, reason })).body.data.on).toBe(false)
    vi.unstubAllEnvs()
  })

  test('the sign-up limits: checked, merged over the stored ones, null resets, audited and emailed', async () => {
    const mails = mailbox()
    const set = (rules: Record<string, unknown>) => act(operator, 'signup.setRules', { rules, reason })
    const saved = await set({
      pendingDays: 3,
      blockedDomains: [' Spam.Example ', 'spam.example'],
      reviewRiskLevels: ['highest'],
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data.rules).toMatchObject({
      pendingDays: 3,
      blockedDomains: ['spam.example'],
      reviewRiskLevels: ['highest'],
      codesPerAddressHour: SIGNUP_DEFAULTS.codesPerAddressHour,
    })
    await vi.waitFor(() => expect(mails.some(m => m.subject === 'The sign-up rules were changed')).toBe(true))
    expect((await lastCommand('signup.setRules'))?.input).toMatchObject({ reason })
    // The email says what each field was and is now.
    const mail = mails.find(m => m.subject === 'The sign-up rules were changed')!
    expect(mail.text).toContain(`Days to finish Checkout: ${SIGNUP_DEFAULTS.pendingDays} → 3`)
    expect(mail.text).toContain('Blocked email domains: 1 added, 0 removed')
    expect(mail.text).toContain('Hold for review at Radar risk: elevated, highest → highest')
    expect(mail.text).not.toContain('Sign-up is now open')
    // Emptying the review levels is named as a safeguard going off.
    mails.length = 0
    await set({ reviewRiskLevels: [] })
    await vi.waitFor(() => expect(mails.some(m => m.text.includes('No Radar risk level holds a trial'))).toBe(true))
    await set({ reviewRiskLevels: null })
    // A field left out keeps its value; null resets one.
    expect((await set({ codesPerAddressHour: 5 })).body.data.rules).toMatchObject({
      pendingDays: 3,
      codesPerAddressHour: 5,
    })
    expect((await set({ pendingDays: null })).body.data.rules.pendingDays).toBe(SIGNUP_DEFAULTS.pendingDays)
    // Out of range, not a domain, not a Radar level or unknown: nothing is changed.
    for (const rules of [
      { pendingDays: 91 },
      { codesPerAddressHour: 1.5 },
      { blockedDomains: ['not a domain'] },
      { reviewRiskLevels: ['scary'] },
      { turnstile: 'yes' },
      { somethingElse: 1 },
    ]) {
      const refused = await set({ ...rules, trialWorkspacesCloud: 7 })
      expect(refused.status, JSON.stringify(rules)).toBe(409)
    }
    expect((await act(operator, 'signup.getSelfServe', {})).body.data.rules).toMatchObject({
      codesPerAddressHour: 5,
      trialWorkspacesCloud: SIGNUP_DEFAULTS.trialWorkspacesCloud,
    })
    // Every field back to its default.
    const reset = Object.fromEntries(Object.keys(SIGNUP_DEFAULTS).map(k => [k, null]))
    expect((await set(reset)).body.data.rules).toEqual(SIGNUP_DEFAULTS)
  })
})

// Server admin › Usage: besides minutes and calls, the dollars the month's calls and numbers took from the balance.
test('the usage page shows what was charged per workspace and month', async () => {
  const { ws, billId, periodId } = await billWith()
  await db.insert(ledger_entries).values({
    id: rid('le'),
    billing_account_id: billId,
    period_id: periodId,
    workspace_id: ws.id,
    kind: 'usage',
    amount_micros: -1_250_000,
    seconds: 1500,
    included_seconds: 0,
    billable_seconds: 1500,
    price_basis: 'standard',
    source_type: 'call',
    source_id: ws.call.id,
  })
  const { usage } = (await request(operator, 'GET', '/v1/admin/usage')).body
  expect(usage.find((u: { workspace_id: string }) => u.workspace_id === ws.id)).toMatchObject({
    month: new Date().toISOString().slice(0, 7),
    charged_micros: 1_250_000,
  })
})

// The bill's lookup by an unknown id answers a refusal, never someone else's data.
test('an unknown bill is refused', async () => {
  const answer = await act(operator, 'billing.adminBill', { billingAccountId: 'bill_nope' })
  expect(answer.status).toBe(409)
})

// The refund writes its pending row while its transaction holds the bill's balance lock. Everything else on the bill
// (reservations, usage, webhooks, recharges) queues on that lock in the main pool; if the row needed a main-pool
// connection too, a burst of them would fill the pool and hang the whole API (security re-review of #919, R2).
test('a refund finishes while more transactions than the pool holds wait on its bill (re-review of #919, R2)', async () => {
  const { billId, periodId } = await billWith()
  const bill = await billRow(billId)
  const paid = await paidRecharge(billId, periodId)
  const stripe = fakeStripe(
    new Map([[paid.invoiceId, paidInvoice(paid.invoiceId, bill.stripe_customer_id!, paid.attempt)]]),
  )
  let reached!: () => void
  const asked = new Promise<void>(resolve => {
    reached = resolve
  })
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  // Stripe answers the dispute check only once the waiters are queued: the refund holds the lock meanwhile.
  setBillingAdminProvider({
    ...stripe.provider,
    refundBlockers: async () => {
      reached()
      await gate
      return []
    },
  })
  const me: Actor = { actorId: operator.userId, role: 'owner', workspaceId: null, permissions: ['instance:admin'] }
  const done = db.transaction(tx =>
    billingAdminHandlers['billing.refund']!(
      { tx, actor: me, now: new Date().toISOString(), onCommit: () => {} },
      { billingAccountId: billId, amountCents: 500, reason, requestId: rid('req') },
    ),
  )
  await asked
  // Twelve transactions on the same bill: more than the main pool's ten connections.
  const waiters = Array.from({ length: 12 }, () => db.transaction(tx => lockBalance(tx, billId)))
  // A probe of its own, so watching (and, if it hangs, ending) them never waits on the full main pool.
  const probe = createDb(process.env.DATABASE_URL!, { max: 1 })
  try {
    const lockWaits = async () =>
      (
        await probe.db.execute(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        )
      ).rows[0]?.n as number
    for (let i = 0; i < 600 && (await lockWaits()) < 9; i++) await new Promise(r => setTimeout(r, 50))
    expect(await lockWaits()).toBeGreaterThanOrEqual(9)
    release()
    const outcome = await Promise.race([
      Promise.all([done, ...waiters]).then(() => 'finished'),
      new Promise(r => setTimeout(() => r('hung'), 15_000)),
    ])
    if (outcome === 'hung')
      // Frees the pool for the tests after this one: the hung transactions are ended from outside.
      await probe.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`,
      )
    expect(outcome).toBe('finished')
    expect(stripe.refunds).toHaveLength(1)
    const [row] = await db.select().from(billing_refunds).where(eq(billing_refunds.billing_account_id, billId))
    expect(row?.status).toBe('posted')
  } finally {
    await probe.pool.end()
    setBillingAdminProvider(null)
  }
})
