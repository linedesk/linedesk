// Stripe's webhook (docs/billing.md §5.1; stripe-webhook.ts, stripe-events.ts, billing-reconcile.ts): the route checks
// Stripe's signature scheme over the raw body (built here at run time with HMAC-SHA256, both secrets, the tolerance,
// the key's mode), stores the event once and answers; the processor fetches the invoice from a fake Stripe before it
// acts, credits a recharge once and only for a real payment of its amount, makes a paid plan's bill active, and never
// trusts the payload's amounts; failures are retried and alerted; the nightly reconciliation stores missed events,
// settles stuck recharges and reports drift. Instance-wide (Stripe keys, the billing switch): its own database.
import { createHmac } from 'node:crypto'
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_invoices,
  billing_periods,
  billing_recharges,
  commands,
  ledger_entries,
  organization,
  provider_settings,
  stripe_events,
  user,
} from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { reconcileBilling } from '../src/billing-reconcile.ts'
import { forgetWebhookBillingProvider, setBillingFetch } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { checkLedgerGuards } from '../src/ledger-guards.ts'
import {
  processStripeEventJob,
  pruneStripeEvents,
  sweepStripeEvents,
  UNHANDLED_PLAN,
  UNHANDLED_TYPE,
} from '../src/stripe-events.ts'
import { resetStripeWebhookLimits, STRIPE_WEBHOOK_PATH } from '../src/stripe-webhook.ts'
import { act, appRequest, createWorkspace, FROM, randomIp, type User } from './helpers.ts'

/** Made-up keys, put together at run time so the secret scan never sees a key-shaped string in the repo. */
const madeUp = (...parts: string[]) => parts.join('_')
const TEST_KEY = madeUp('sk', 'test', '51MadeUpWebhookKey0123456789')
const SECRET = madeUp('whsec', 'MadeUpSigningSecret0123456789')
const STRANGER = madeUp('whsec', 'SomeoneElsesSecret0123456789')

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const nowSec = () => Math.floor(Date.now() / 1000)

/** Stripe's signature scheme: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the signing secret>`. */
function sign(body: string, secret = SECRET, at = nowSec()) {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`, 'utf8').digest('hex')
  return `t=${at},v1=${v1}`
}

// ---- A fake Stripe API: the objects billing fetches, and every request it made ----

type Json = Record<string, unknown>
const stripe = {
  invoices: new Map<string, Json>(),
  payments: new Map<string, Json[]>(),
  subscriptions: new Map<string, Json>(),
  customers: new Map<string, Json>(),
  events: [] as Json[],
  requests: [] as string[],
  failWith: null as number | null,
}
const list = (data: unknown[], url: string) => ({ object: 'list', data, has_more: false, url })
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_t' } })
const notFound = () =>
  reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } })

const fakeStripe: typeof fetch = async input => {
  const url = new URL(String(input))
  stripe.requests.push(`${url.pathname}${url.search}`)
  if (url.pathname === '/v1/account') return reply(200, { id: 'acct_1Brightwater', object: 'account', country: 'US' })
  if (stripe.failWith) return reply(stripe.failWith, { error: { type: 'api_error', message: 'Stripe is down' } })
  const [, , kind, id] = url.pathname.split('/')
  if (kind === 'invoices' && id) return stripe.invoices.has(id) ? reply(200, stripe.invoices.get(id)) : notFound()
  if (kind === 'invoice_payments')
    return reply(200, list(stripe.payments.get(url.searchParams.get('invoice') ?? '') ?? [], url.pathname))
  if (kind === 'subscriptions' && id)
    return stripe.subscriptions.has(id) ? reply(200, stripe.subscriptions.get(id)) : notFound()
  if (kind === 'customers' && id) return stripe.customers.has(id) ? reply(200, stripe.customers.get(id)) : notFound()
  if (kind === 'events') return reply(200, list(stripe.events, url.pathname))
  return notFound()
}

/** An invoice as Stripe's API returns it (the fields billing reads). */
function invoice(id: string, customer: string, over: Partial<Json> & { lines?: Json[] } = {}): Json {
  const { lines = [], ...rest } = over
  return {
    id,
    object: 'invoice',
    livemode: false,
    customer,
    parent: null,
    status: 'paid',
    billing_reason: 'manual',
    currency: 'usd',
    total: 2000,
    total_taxes: [],
    amount_paid: 2000,
    amount_paid_off_stripe: 0,
    metadata: {},
    lines: list(lines, `/v1/invoices/${id}/lines`),
    number: 'LD-0001',
    period_start: nowSec(),
    period_end: nowSec(),
    hosted_invoice_url: 'https://invoice.stripe.test/i/1',
    invoice_pdf: 'https://invoice.stripe.test/i/1.pdf',
    ...rest,
  }
}
const rechargeLine = (rechargeId: string, amount = 2000): Json => ({
  id: rid('il'),
  object: 'line_item',
  amount,
  currency: 'usd',
  parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: rid('ii') } },
  metadata: { billing_recharge_id: rechargeId },
})
const paidBy = (invoiceId: string, amount: number, type: 'payment_intent' | 'charge' = 'payment_intent') =>
  stripe.payments.set(invoiceId, [
    {
      id: rid('inpay'),
      object: 'invoice_payment',
      amount_paid: amount,
      status: 'paid',
      payment: { type, [type]: rid(type === 'charge' ? 'ch' : 'pi') },
    },
  ])

/** A payment of the invoice that failed: its payment intent says why (3DS: `requires_action`). */
const failedBy = (invoiceId: string, error: Json | null, status = 'requires_payment_method') =>
  stripe.payments.set(invoiceId, [
    {
      id: rid('inpay'),
      object: 'invoice_payment',
      amount_paid: 0,
      status: 'open',
      created: nowSec(),
      payment: {
        type: 'payment_intent',
        payment_intent: { id: rid('pi'), object: 'payment_intent', status, last_payment_error: error },
      },
    },
  ])

/** An event as Stripe sends it, about `object`. */
const event = (type: string, object: Json, over: Partial<Json> = {}): Json => ({
  id: rid('evt'),
  object: 'event',
  type,
  livemode: false,
  created: nowSec(),
  api_version: '2026-05-27.dahlia',
  data: { object },
  ...over,
})

// ---- The install: an instance admin, Stripe connected and billing on, bills ----

let operator: User
const mails: { subject: string }[] = []

async function billWith(over: Partial<typeof billing_accounts.$inferInsert> = {}) {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [bill] = await db
    .insert(billing_accounts)
    .values({
      id: rid('bill'),
      kind: 'cloud',
      owner_user_id: ws.owner.userId,
      status: 'active',
      stripe_customer_id: rid('cus'),
      ...over,
    })
    .returning()
  const [period] = await db
    .insert(billing_periods)
    .values({
      id: rid('bp'),
      billing_account_id: bill!.id,
      starts_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      ends_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      kind: 'month',
    })
    .returning()
  await db
    .update(organization)
    .set({ billingAccountId: bill!.id, billingState: 'active' })
    .where(eq(organization.id, ws.id))
  return { ws, bill: bill!, period: period! }
}

async function pendingRecharge(
  billId: string,
  invoiceId: string | null,
  amount = 2000,
  created = new Date().toISOString(),
) {
  const [row] = await db
    .insert(billing_recharges)
    .values({
      id: rid('rc'),
      billing_account_id: billId,
      amount_cents: amount,
      stripe_invoice_id: invoiceId,
      created_at: created,
    })
    .returning()
  return row!
}

const balanceOf = async (billId: string) =>
  (await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId)))[0]
    ?.balance_micros ?? 0
const rechargeEntries = (rechargeId: string) =>
  db
    .select()
    .from(ledger_entries)
    .where(and(eq(ledger_entries.source_type, 'billing_recharge'), eq(ledger_entries.source_id, rechargeId)))
const storedEvent = async (id: string) => (await db.select().from(stripe_events).where(eq(stripe_events.id, id)))[0]

function deliver(body: string, signature: string | null = sign(body), from = randomIp()) {
  return appRequest(STRIPE_WEBHOOK_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [FROM]: from,
      ...(signature ? { 'stripe-signature': signature } : {}),
    },
    body,
  })
}
/** Delivers an event signed with the current secret and processes it like the job does. */
async function deliverAndProcess(evt: Json) {
  const res = await deliver(JSON.stringify(evt))
  expect(res.status).toBe(200)
  return processStripeEventJob(evt.id as string)
}

beforeAll(async () => {
  const home = await createWorkspace('Linedesk Operations')
  operator = home.owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  setBillingFetch(fakeStripe)
  expect(await checkLedgerGuards(db)).toBe(true)
  expect(
    (
      await act(operator, 'provider.setKeys', {
        provider: 'stripe',
        values: { secret_key: TEST_KEY, webhook_secret: SECRET },
      })
    ).status,
  ).toBe(200)
  expect((await act(operator, 'billingEnabled.set', { on: true })).status).toBe(200)
})
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e))
  mails.length = 0
  stripe.requests.length = 0
  stripe.events.length = 0
  stripe.failWith = null
  resetStripeWebhookLimits()
  forgetWebhookBillingProvider()
})
afterAll(() => setBillingFetch(null))

describe('the route', () => {
  test('stores a signed event once and answers 200; a redelivery stores nothing new', async () => {
    const customer = rid('cus')
    const evt = event('customer.updated', {
      id: customer,
      object: 'customer',
      name: 'Mike Brennan',
      email: 'mike@brightwater.example',
      address: { line1: '1 Main St', city: 'Portland' },
    })
    const body = JSON.stringify(evt)
    expect((await deliver(body)).status).toBe(200)
    const row = await storedEvent(evt.id as string)
    expect(row).toMatchObject({ type: 'customer.updated', livemode: false, processed_at: null, attempts: 0 })
    // Only what processing reads is kept: no name, email or address (security review of #865, L4).
    expect(row!.payload).toEqual({
      id: evt.id,
      type: 'customer.updated',
      created: evt.created,
      livemode: false,
      data: { object: { id: customer, object: 'customer', customer } },
    })
    // Stripe retries with a new timestamp and signature: the same event id, still one row.
    expect((await deliver(body, sign(body, SECRET, nowSec() + 5))).status).toBe(200)
    expect(
      await db
        .select()
        .from(stripe_events)
        .where(eq(stripe_events.id, evt.id as string)),
    ).toHaveLength(1)
    // The route itself never called Stripe.
    expect(stripe.requests.filter(r => r !== '/v1/account')).toEqual([])
  })

  test('refuses a missing, wrong or foreign signature, a changed body and an old timestamp; stores nothing', async () => {
    const evt = event('invoice.paid', invoice(rid('in'), rid('cus')))
    const body = JSON.stringify(evt)
    expect((await deliver(body, null)).status).toBe(400)
    expect((await deliver(body, sign(body, STRANGER))).status).toBe(400)
    expect((await deliver(body, 't=1,v1=00')).status).toBe(400)
    // Signed, then changed on the way (an amount raised): the signature no longer matches.
    expect((await deliver(body.replace('"amount_paid":2000', '"amount_paid":900000'), sign(body))).status).toBe(400)
    // A replay of a captured delivery after the 300 s tolerance.
    expect((await deliver(body, sign(body, SECRET, nowSec() - 301))).status).toBe(400)
    expect(await storedEvent(evt.id as string)).toBeUndefined()
  })

  test('refuses an event of the other mode than the key (a live event on a test key)', async () => {
    const evt = event('customer.updated', { id: rid('cus'), object: 'customer' }, { livemode: true })
    const res = await deliver(JSON.stringify(evt))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'wrong mode' })
    expect(await storedEvent(evt.id as string)).toBeUndefined()
  })

  test('refuses an event in another API version than the pinned one, without blocking the sender', async () => {
    const from = randomIp()
    for (let i = 0; i < 21; i++) {
      const evt = event(
        'customer.updated',
        { id: rid('cus'), object: 'customer' },
        { api_version: '2026-10-28.endive' },
      )
      const res = await deliver(JSON.stringify(evt), undefined, from)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'wrong api version' })
      expect(await storedEvent(evt.id as string)).toBeUndefined()
    }
    const ok = JSON.stringify(event('customer.updated', { id: rid('cus'), object: 'customer' }))
    expect((await deliver(ok, undefined, from)).status).toBe(200)
  })

  test('refuses a body over 512 KB before reading it', async () => {
    const big = JSON.stringify(event('customer.updated', { id: rid('cus'), note: 'x'.repeat(520 * 1024) }))
    expect((await deliver(big)).status).toBe(413)
  })

  test('a flood of foreign signatures from Stripe’s own address never blocks a valid delivery (review of #865, H1)', async () => {
    // Stripe sends every account's webhooks from the same addresses: another account's endpoint pointed at ours.
    const stripeAddress = randomIp()
    const foreign = JSON.stringify(event('customer.updated', { id: rid('cus') }))
    for (let i = 0; i < 50; i++)
      expect((await deliver(foreign, sign(foreign, STRANGER), stripeAddress)).status).toBe(400)
    // Malformed headers too, refused before anything is read.
    for (let i = 0; i < 50; i++) expect((await deliver(foreign, 'garbage', stripeAddress)).status).toBe(400)
    const evt = event('customer.updated', { id: rid('cus') })
    expect((await deliver(JSON.stringify(evt), undefined, stripeAddress)).status).toBe(200)
    expect(await storedEvent(evt.id as string)).toBeDefined()
  })

  test('rotation: the previous secret works beside the new one for 7 days, then not; set while billing stays on', async () => {
    const newSecret = madeUp('whsec', 'NewSigningSecret0123456789')
    const rotated = await act(operator, 'provider.setKeys', {
      provider: 'stripe',
      values: { webhook_secret: newSecret, webhook_secret_previous: SECRET },
    })
    expect(rotated.status).toBe(200)
    const one = JSON.stringify(event('customer.updated', { id: rid('cus') }))
    expect((await deliver(one, sign(one, newSecret))).status).toBe(200)
    expect((await deliver(one, sign(one, SECRET))).status).toBe(200)
    // Eight days later the old secret is no longer accepted.
    await db
      .update(provider_settings)
      .set({ updated_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .where(and(eq(provider_settings.provider, 'stripe'), eq(provider_settings.field, 'webhook_secret_previous')))
    // The route keeps its provider for 30 s; this test moved the clock under it.
    forgetWebhookBillingProvider()
    const two = JSON.stringify(event('customer.updated', { id: rid('cus') }))
    expect((await deliver(two, sign(two, SECRET))).status).toBe(400)
    expect((await deliver(two, sign(two, newSecret))).status).toBe(200)
    // Back to the first secret for the other tests.
    await db.delete(provider_settings).where(eq(provider_settings.field, 'webhook_secret_previous'))
    expect(
      (await act(operator, 'provider.setKeys', { provider: 'stripe', values: { webhook_secret: SECRET } })).status,
    ).toBe(200)
    // The secret key itself is still refused while billing is on.
    expect(
      (await act(operator, 'provider.setKeys', { provider: 'stripe', values: { secret_key: TEST_KEY } })).status,
    ).toBe(409)
  })

  test('404 while billing is off: nothing is stored', async () => {
    expect((await act(operator, 'billingEnabled.set', { on: false })).status).toBe(200)
    try {
      const evt = event('customer.updated', { id: rid('cus') })
      expect((await deliver(JSON.stringify(evt))).status).toBe(404)
      expect(await storedEvent(evt.id as string)).toBeUndefined()
    } finally {
      expect((await act(operator, 'billingEnabled.set', { on: true })).status).toBe(200)
    }
  })
})

describe('invoice.paid for a recharge', () => {
  test('credits the pre-tax amount of the fetched invoice once, however often the event comes', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    await db
      .update(billing_accounts)
      .set({ recharge_failed_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, bill.id))
    // Stripe charged $20 + $1.70 tax; the event's copy claims far more: it is never read for amounts.
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        total: 2170,
        amount_paid: 2170,
        total_taxes: [{ amount: 170 }],
        lines: [rechargeLine(recharge.id)],
      }),
    )
    paidBy(invoiceId, 2170)
    const evt = event('invoice.paid', {
      ...invoice(invoiceId, bill.stripe_customer_id!),
      amount_paid: 50_000_00,
      total: 50_000_00,
    })
    expect(await deliverAndProcess(evt)).toMatchObject({
      outcome: 'applied',
      credited: { recharge: recharge.id, micros: 20_000_000, posted: true },
    })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, recharge.id)))[0]).toMatchObject({
      status: 'paid',
    })
    expect(
      (await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id)))[0]!.recharge_failed_at,
    ).toBeNull()
    expect(
      (await db.select().from(billing_invoices).where(eq(billing_invoices.stripe_invoice_id, invoiceId)))[0],
    ).toMatchObject({
      kind: 'recharge',
      status: 'paid',
      total_cents: 2170,
      tax_cents: 170,
    })
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()

    // The same event again (a redelivery after processing), the job run twice, an admin's reprocess, and a second
    // event for the same invoice: still one credit.
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(await processStripeEventJob(evt.id as string)).toEqual({ skipped: 'processed' })
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(200)
    expect(await processStripeEventJob(evt.id as string)).toMatchObject({ credited: { posted: false } })
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      credited: { posted: false },
    })
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test.each([
    ['marked paid out of band', { amount_paid_off_stripe: 2000, amount_paid: 0 }, 0, 'out_of_band'],
    ['paid from the customer credit balance', { amount_paid: 0 }, 0, 'not_charged'],
    // The total counts, not the recharge's line (security review of #865, L1).
    ['a coupon took 10 % off the recharge', { total: 1800, amount_paid: 1800, lineDiscount: 200 }, 1800, 'discounted'],
    ['$3 of it came from the customer credit balance', { starting_balance: -300 }, 1700, 'not_charged'],
    ['the card paid less than the total with tax', { total: 2170, amount_paid: 2170 }, 2000, 'not_charged'],
    ['a line of another amount than the attempt', { line: 5000 }, 5000, 'amount_mismatch'],
    ['not in US dollars', { currency: 'eur' }, 2000, 'currency'],
  ] as const)('credits nothing when %s, and alerts the instance admins', async (_what, change, charged, reason) => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    const { line, lineDiscount, ...fields } = change as { line?: number; lineDiscount?: number } & Json
    const recharged = rechargeLine(recharge.id, line ?? 2000)
    if (lineDiscount) recharged.discount_amounts = [{ amount: lineDiscount, discount: rid('di') }]
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { ...fields, lines: [recharged] }))
    if (charged) paidBy(invoiceId, charged)
    else stripe.payments.delete(invoiceId)
    const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toMatchObject({ notCredited: { recharge: recharge.id, reason } })
    expect(await rechargeEntries(recharge.id)).toHaveLength(0)
    expect(await balanceOf(bill.id)).toBe(0)
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, recharge.id)))[0]!.status).toBe(
      'pending',
    )
    expect(mails.some(m => /was not credited/.test(m.subject))).toBe(true)
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
  })

  test('a coupon on the plan line of the same invoice does not block the recharge (recheck of #865, L-A)', async () => {
    // The trial conversion invoice: the plan (with a promotion code) and the first recharge, paid in full by card.
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    const plan: Json = {
      id: rid('il'),
      object: 'line_item',
      amount: 1100,
      currency: 'usd',
      parent: { type: 'subscription_item_details' },
      metadata: {},
      discount_amounts: [{ amount: 550, discount: rid('di') }],
    }
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        total: 2550,
        amount_paid: 2550,
        total_discount_amounts: [{ amount: 550, discount: rid('di') }],
        lines: [plan, rechargeLine(recharge.id)],
      }),
    )
    paidBy(invoiceId, 2550)
    const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toMatchObject({ credited: { recharge: recharge.id, posted: true } })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  /** An invoice with the recharge line and other invoice-item lines of the given amounts, its total paid by card. */
  async function rechargeBeside(others: number[], tax = 0) {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    const extra = others.map(
      (amount): Json => ({
        id: rid('il'),
        object: 'line_item',
        amount,
        currency: 'usd',
        parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: rid('ii') } },
        metadata: {},
      }),
    )
    const total = 2000 + others.reduce((a, b) => a + b, 0) + tax
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        total,
        amount_paid: total,
        total_taxes: tax ? [{ amount: tax }] : [],
        lines: [rechargeLine(recharge.id), ...extra],
      }),
    )
    paidBy(invoiceId, total)
    const outcome = await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))
    return { bill, recharge, outcome }
  }

  test('a negative line beside the recharge credits nothing: $20 line, −$15 line, $5 paid (delta review of #866)', async () => {
    const { bill, recharge, outcome } = await rechargeBeside([-1500])
    expect(outcome).toMatchObject({ notCredited: { recharge: recharge.id, reason: 'not_covered' } })
    expect(await rechargeEntries(recharge.id)).toHaveLength(0)
    expect(await balanceOf(bill.id)).toBe(0)
    expect(mails.some(m => /was not credited/.test(m.subject))).toBe(true)
  })

  test('another positive line beside the recharge, all paid by card with tax: credited once (positive control)', async () => {
    const { bill, recharge, outcome } = await rechargeBeside([500], 213)
    expect(outcome).toMatchObject({ credited: { recharge: recharge.id, micros: 20_000_000, posted: true } })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test('paid before the recharge job stored the invoice id: found through the fetched invoice, credited once', async () => {
    // Stripe sends invoice.paid as soon as the job's pay call succeeds, before the job writes stripe_invoice_id.
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, null)
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        metadata: { billing_recharge_id: recharge.id },
        lines: [rechargeLine(recharge.id)],
      }),
    )
    paidBy(invoiceId, 2000)
    // The event's copy names no attempt: only the invoice fetched from Stripe is read.
    const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toMatchObject({ credited: { recharge: recharge.id, posted: true } })
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, recharge.id)))[0]).toMatchObject({
      status: 'paid',
      stripe_invoice_id: invoiceId,
    })
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      credited: { posted: false },
    })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test('an invoice naming an attempt of another bill, or one that has its own invoice, claims nothing', async () => {
    const { bill } = await billWith()
    const other = await billWith()
    const foreign = await pendingRecharge(other.bill.id, null)
    const settled = await pendingRecharge(bill.id, rid('in'))
    for (const named of [foreign, settled]) {
      const invoiceId = rid('in')
      stripe.invoices.set(
        invoiceId,
        invoice(invoiceId, bill.stripe_customer_id!, {
          metadata: { billing_recharge_id: named.id },
          lines: [rechargeLine(named.id)],
        }),
      )
      paidBy(invoiceId, 2000)
      const result = await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))
      expect(result).toMatchObject({ outcome: 'applied', bill: bill.id })
      expect(result).not.toHaveProperty('credited')
      expect(await rechargeEntries(named.id)).toHaveLength(0)
      expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, named.id)))[0]).toMatchObject({
        stripe_invoice_id: named.stripe_invoice_id,
      })
    }
    expect(await balanceOf(other.bill.id)).toBe(0)
  })

  test('an invoice of another Stripe customer than the bill credits nothing', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, rid('cus'), { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toMatchObject({ notCredited: { reason: 'customer_mismatch' } })
    expect(await balanceOf(bill.id)).toBe(0)
  })
})

describe('invoice.paid for a plan', () => {
  test('a past-due bill is active again with Stripe’s period, its workspaces too', async () => {
    const subscriptionId = rid('sub')
    const { bill, ws } = await billWith({
      status: 'past_due',
      stripe_subscription_id: subscriptionId,
      past_due_since: new Date().toISOString(),
      interval: 'month',
    })
    await db.update(organization).set({ billingState: 'suspended' }).where(eq(organization.id, ws.id))
    const start = nowSec()
    const end = start + 365 * 86_400
    stripe.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: bill.stripe_customer_id,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      default_payment_method: rid('pm'),
      items: list(
        [
          {
            id: rid('si'),
            object: 'subscription_item',
            quantity: 1,
            current_period_start: start,
            current_period_end: end,
            price: { id: rid('price'), object: 'price', lookup_key: 'ws_yearly', recurring: { interval: 'year' } },
          },
        ],
        '/v1/subscription_items',
      ),
    })
    const invoiceId = rid('in')
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        total: 10800,
        amount_paid: 10800,
        billing_reason: 'subscription_cycle',
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    paidBy(invoiceId, 10800)
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      outcome: 'applied',
      plan: 'active',
    })
    const [after] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))
    expect(after).toMatchObject({ status: 'active', past_due_since: null, interval: 'year' })
    expect(new Date(after!.current_period_end!).getTime()).toBe(end * 1000)
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('active')
    // The plan fee is not balance.
    expect(await balanceOf(bill.id)).toBe(0)
  })

  test('a canceled bill stays canceled', async () => {
    const subscriptionId = rid('sub')
    const { bill } = await billWith({ status: 'canceled', stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: bill.stripe_customer_id,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      default_payment_method: null,
      items: list([], '/v1/subscription_items'),
    })
    const invoiceId = rid('in')
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      plan: 'unchanged',
    })
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id)))[0]!.status).toBe(
      'canceled',
    )
  })

  test('a payment does not lift a suspension an instance admin made (review of #865, N1; PR 13)', async () => {
    const subscriptionId = rid('sub')
    const { bill, ws } = await billWith({
      status: 'suspended',
      suspend_reason: 'admin',
      suspended_at: new Date().toISOString(),
      stripe_subscription_id: subscriptionId,
    })
    await db.update(organization).set({ billingState: 'suspended' }).where(eq(organization.id, ws.id))
    stripe.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: bill.stripe_customer_id,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      default_payment_method: null,
      items: list([], '/v1/subscription_items'),
    })
    const invoiceId = rid('in')
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    paidBy(invoiceId, 2000)
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      plan: 'unchanged',
    })
    const [after] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))
    expect(after).toMatchObject({ status: 'suspended', suspend_reason: 'admin' })
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('suspended')
  })
})

/** A subscription as Stripe returns it: one item per lookup key, a month from now. */
function planSubscription(id: string, customer: string, over: { status?: string; lookupKeys?: string[] } = {}): Json {
  return {
    id,
    object: 'subscription',
    customer,
    status: over.status ?? 'active',
    cancel_at_period_end: false,
    trial_end: null,
    default_payment_method: rid('pm'),
    items: list(
      (over.lookupKeys ?? ['ws_monthly']).map(lookupKey => ({
        id: rid('si'),
        object: 'subscription_item',
        quantity: 1,
        current_period_start: nowSec(),
        current_period_end: nowSec() + 30 * 86_400,
        price: { id: rid('price'), object: 'price', lookup_key: lookupKey, recurring: { interval: 'month' } },
      })),
      '/v1/subscription_items',
    ),
  }
}

describe('invoice.paid of Checkout’s first invoice, before the bill has its subscription (billing review B4)', () => {
  /** A bill as Checkout leaves it: the customer stored, the subscription not yet; its first plan invoice paid. */
  async function paidBeforeLinked(sub: { status?: string; lookupKeys?: string[]; customer?: string } = {}) {
    const { bill, ws } = await billWith({ status: 'trialing' })
    await db.update(organization).set({ billingState: 'pending_payment' }).where(eq(organization.id, ws.id))
    const subscriptionId = rid('sub')
    stripe.subscriptions.set(
      subscriptionId,
      planSubscription(subscriptionId, sub.customer ?? bill.stripe_customer_id!, sub),
    )
    const invoiceId = rid('in')
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        total: 1100,
        amount_paid: 1100,
        billing_reason: 'subscription_create',
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    paidBy(invoiceId, 1100)
    return { bill, ws, subscriptionId, evt: event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)) }
  }
  const billRow = async (id: string) =>
    (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!

  test('the subscription is linked from the fetched objects and the bill becomes active, once', async () => {
    const { bill, ws, subscriptionId, evt } = await paidBeforeLinked()
    expect(await deliverAndProcess(evt)).toMatchObject({ outcome: 'applied', plan: 'active', linked: subscriptionId })
    expect(await billRow(bill.id)).toMatchObject({ status: 'active', stripe_subscription_id: subscriptionId })
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('active')
    expect(
      await db.select().from(billing_invoices).where(eq(billing_invoices.billing_account_id, bill.id)),
    ).toMatchObject([{ kind: 'subscription', total_cents: 1100 }])
    // Processed with its effect; an admin's reprocess applies it as the bill's own subscription, linking nothing again.
    expect(await storedEvent(evt.id as string)).toMatchObject({ last_error: null })
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(200)
    const again = await processStripeEventJob(evt.id as string)
    expect(again).toMatchObject({ outcome: 'applied', plan: 'active' })
    expect(again).not.toHaveProperty('linked')
    expect(await billRow(bill.id)).toMatchObject({ status: 'active', stripe_subscription_id: subscriptionId })
  })

  test('a bill waiting for Checkout is only linked, never activated: plan unchanged, still pending_payment (M1)', async () => {
    const { bill, ws, subscriptionId, evt } = await paidBeforeLinked()
    await db.update(billing_accounts).set({ status: 'pending_payment' }).where(eq(billing_accounts.id, bill.id))
    expect(await deliverAndProcess(evt)).toMatchObject({
      outcome: 'applied',
      plan: 'unchanged',
      linked: subscriptionId,
    })
    // Only the Checkout confirmation (billing-checkout.ts, with the card checks) takes it out of pending_payment.
    expect(await billRow(bill.id)).toMatchObject({
      status: 'pending_payment',
      stripe_subscription_id: subscriptionId,
      checkout_confirmed_at: null,
    })
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe(
      'pending_payment',
    )
  })

  test("a refused trial's subscription is never linked afterwards (security review of #961, G4)", async () => {
    // The trial's $0 invoice.paid fetched the subscription while it still trialed; the refusal committed first.
    const { bill, evt } = await paidBeforeLinked({ status: 'trialing' })
    await db
      .update(billing_accounts)
      .set({ status: 'pending_payment', trial_refused: 'card_used' })
      .where(eq(billing_accounts.id, bill.id))
    expect(await deliverAndProcess(evt)).not.toHaveProperty('linked')
    expect(await billRow(bill.id)).toMatchObject({ status: 'pending_payment', stripe_subscription_id: null })
  })

  test('a subscription that is not a Linedesk plan, or of another customer, is never linked', async () => {
    const foreign = await paidBeforeLinked({ lookupKeys: ['ws_monthly', 'someone_elses_price'] })
    expect(await deliverAndProcess(foreign.evt)).not.toHaveProperty('linked')
    expect(await billRow(foreign.bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: null })
    const stranger = await paidBeforeLinked({ customer: rid('cus') })
    expect(await deliverAndProcess(stranger.evt)).not.toHaveProperty('linked')
    expect(await billRow(stranger.bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: null })
    const ended = await paidBeforeLinked({ status: 'canceled' })
    expect(await deliverAndProcess(ended.evt)).not.toHaveProperty('linked')
    expect(await billRow(ended.bill.id)).toMatchObject({ stripe_subscription_id: null })
  })

  test('a bill that has a subscription keeps it: another subscription’s invoice changes nothing', async () => {
    const { bill, evt } = await paidBeforeLinked()
    const own = rid('sub')
    await db.update(billing_accounts).set({ stripe_subscription_id: own }).where(eq(billing_accounts.id, bill.id))
    expect(await deliverAndProcess(evt)).not.toHaveProperty('linked')
    expect(await billRow(bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: own })
  })
})

describe('a new card after a failed recharge (docs/billing.md §3.4)', () => {
  const failedAt = new Date(Date.now() - 3_600_000).toISOString()
  /** A bill waiting after a failed recharge; its Stripe customer's invoice default made at `cardMade` (Unix s). */
  async function waitingWithCard(cardMade: number | null) {
    const { bill } = await billWith({ recharge_failed_at: failedAt })
    stripe.customers.set(bill.stripe_customer_id!, {
      id: bill.stripe_customer_id,
      object: 'customer',
      default_source: null,
      invoice_settings: {
        default_payment_method:
          cardMade === null ? null : { id: rid('pm'), object: 'payment_method', type: 'card', created: cardMade },
      },
    })
    return bill
  }
  const waiting = async (id: string) =>
    (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!.recharge_failed_at

  test('a card made the default since the failure ends the wait (customer.updated, payment_method.attached)', async () => {
    const bill = await waitingWithCard(nowSec())
    const evt = event('customer.updated', { id: bill.stripe_customer_id, object: 'customer' })
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'card_changed', bill: bill.id, cleared: true })
    expect(await waiting(bill.id)).toBeNull()
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
    const other = await waitingWithCard(nowSec())
    const attached = event('payment_method.attached', {
      id: rid('pm'),
      object: 'payment_method',
      customer: other.stripe_customer_id,
    })
    expect(await deliverAndProcess(attached)).toMatchObject({ outcome: 'card_changed', cleared: true })
    expect(await waiting(other.id)).toBeNull()
  })

  test('the card that failed, or no card, keeps the wait; a bill that is not waiting asks Stripe nothing', async () => {
    const old = await waitingWithCard(nowSec() - 2 * 86_400)
    expect(
      await deliverAndProcess(event('customer.updated', { id: old.stripe_customer_id, object: 'customer' })),
    ).toEqual({ outcome: 'card_changed', bill: old.id, cleared: false })
    expect(await waiting(old.id)).not.toBeNull()
    const none = await waitingWithCard(null)
    expect(
      await deliverAndProcess(event('customer.updated', { id: none.stripe_customer_id, object: 'customer' })),
    ).toMatchObject({ cleared: false })
    expect(await waiting(none.id)).not.toBeNull()
    const { bill: fine } = await billWith()
    stripe.requests.length = 0
    expect(
      await deliverAndProcess(event('customer.updated', { id: fine.stripe_customer_id, object: 'customer' })),
    ).toEqual({ outcome: 'applied', bill: fine.id })
    expect(stripe.requests.filter(r => r.startsWith('/v1/customers'))).toEqual([])
  })

  test('a customer no bill has is retried for an hour, like every event, then processed', async () => {
    expect(await deliverAndProcess(event('customer.updated', { id: rid('cus'), object: 'customer' }))).toEqual({
      outcome: 'unknown_retry',
    })
  })
})

describe('invoice.payment_failed and invoice.voided for a recharge (PR 4’s failed-recharge rules; review of #865, M1)', () => {
  const attempt = async (id: string) =>
    (await db.select().from(billing_recharges).where(eq(billing_recharges.id, id)))[0]!
  const failedAt = async (billId: string) =>
    (await db.select().from(billing_accounts).where(eq(billing_accounts.id, billId)))[0]!.recharge_failed_at
  const alertsOf = (billId: string) =>
    db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, billId))

  test('a decline: collection off and voided, the attempt canceled, the bill waits, one owner alert', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    failedBy(invoiceId, { code: 'card_declined', decline_code: 'insufficient_funds' })
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!, { status: 'open' }))
    expect(await deliverAndProcess(evt)).toEqual({
      outcome: 'recharge_failed',
      bill: bill.id,
      recharge: recharge.id,
      code: 'insufficient_funds',
    })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'canceled', failure_code: 'insufficient_funds' })
    expect(stripe.requests).toContain(`/v1/invoices/${invoiceId}/void`)
    expect(await failedAt(bill.id)).not.toBeNull()
    expect(await alertsOf(bill.id)).toMatchObject([{ kind: 'recharge_failed', ref: invoiceId }])
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
    // Again (a redelivery, a reprocess): nothing more.
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(200)
    expect(await processStripeEventJob(evt.id as string)).toEqual({ outcome: 'applied', bill: bill.id })
    expect(await alertsOf(bill.id)).toHaveLength(1)
  })

  test('3DS: the invoice stays open for the owner to confirm; the attempt is failed, not voided', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    failedBy(invoiceId, null, 'requires_action')
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!, { status: 'open' }))
    expect(await deliverAndProcess(evt)).toMatchObject({ code: 'authentication_required' })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'failed', failure_code: 'authentication_required' })
    expect(stripe.requests).not.toContain(`/v1/invoices/${invoiceId}/void`)
    // The owner never confirms, and the invoice is voided: the attempt no longer counts in the cap.
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'void', amount_paid: 0 }))
    const voided = event('invoice.voided', invoice(invoiceId, bill.stripe_customer_id!, { status: 'void' }))
    expect(await deliverAndProcess(voided)).toMatchObject({ outcome: 'recharge_failed', code: 'invoice_voided' })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'canceled' })
  })

  test('failed before the job stored the invoice id: found through the fetched invoice', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, null)
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        status: 'open',
        amount_paid: 0,
        metadata: { billing_recharge_id: recharge.id },
      }),
    )
    failedBy(invoiceId, { code: 'card_declined', decline_code: 'generic_decline' })
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toMatchObject({ outcome: 'recharge_failed', recharge: recharge.id })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'canceled', stripe_invoice_id: invoiceId })
  })

  test('a payment that failed and was then paid, or an attempt already settled, changes nothing', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!, { status: 'open' }))
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'applied', bill: bill.id })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'pending' })
    expect(stripe.requests.some(r => r.endsWith('/void'))).toBe(false)
    expect(await failedAt(bill.id)).toBeNull()
  })

  test('a voided recharge invoice: the attempt is canceled through the same rules', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'void', amount_paid: 0 }))
    const evt = event('invoice.voided', invoice(invoiceId, bill.stripe_customer_id!, { status: 'void' }))
    expect(await deliverAndProcess(evt)).toMatchObject({ outcome: 'recharge_failed', code: 'invoice_voided' })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'canceled', failure_code: 'invoice_voided' })
  })

  test('a plan invoice’s failure waits, unprocessed, for dunning (a later PR)', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'unhandled', marker: UNHANDLED_PLAN })
    expect(await storedEvent(evt.id as string)).toMatchObject({ processed_at: null, last_error: UNHANDLED_PLAN })
    // The sweeper does not re-arm it: the type is handled, this invoice is not yet.
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    await sweepStripeEvents()
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 5, last_error: UNHANDLED_PLAN })
  })
})

describe('the processor', () => {
  test('an event of a customer no bill has: retried for an hour without asking Stripe, then marked processed', async () => {
    const evt = event('invoice.paid', invoice(rid('in'), rid('cus')))
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'unknown_retry' })
    expect(stripe.requests.filter(r => r.startsWith('/v1/invoices'))).toEqual([])
    expect(await storedEvent(evt.id as string)).toMatchObject({ processed_at: null, attempts: 0 })
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 61 * 60_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    expect(await processStripeEventJob(evt.id as string)).toEqual({ outcome: 'unknown' })
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
  })

  test('the bill is stored after its first event came: the retry finds it and credits (review of #865, L2)', async () => {
    // Stripe does not order events: invoice.paid may come before the event that stores the customer on the bill.
    const customer = rid('cus')
    const invoiceId = rid('in')
    const evt = event('invoice.paid', invoice(invoiceId, customer))
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'unknown_retry' })
    const { bill } = await billWith({ stripe_customer_id: customer })
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, customer, { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    expect(await processStripeEventJob(evt.id as string)).toMatchObject({ credited: { posted: true } })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test('a type this release does not act on stays unprocessed with its marker; no retry, no alert (M1)', async () => {
    const evt = event('charge.dispute.created', { id: rid('dp'), object: 'dispute' })
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'unhandled', marker: UNHANDLED_TYPE })
    expect(await storedEvent(evt.id as string)).toMatchObject({
      processed_at: null,
      attempts: 5,
      last_error: UNHANDLED_TYPE,
    })
    // Not swept, not requeued on a redelivery, not counted as failing, no email.
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    await sweepStripeEvents()
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 5, last_error: UNHANDLED_TYPE })
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(mails).toEqual([])
  })

  test('a release that handles a type arms its stored unhandled events again (M1)', async () => {
    // As a release before this one left it: invoice.payment_failed was not handled then.
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!, { status: 'open' }))
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ attempts: 5, last_error: UNHANDLED_TYPE, received_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    expect((await sweepStripeEvents()).requeued).toBeGreaterThanOrEqual(1)
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 0, last_error: null })
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    failedBy(invoiceId, { code: 'card_declined', decline_code: 'insufficient_funds' })
    expect(await processStripeEventJob(evt.id as string)).toMatchObject({
      outcome: 'recharge_failed',
      recharge: recharge.id,
      code: 'insufficient_funds',
    })
  })

  test('a failure is recorded and retried; the fifth alerts the instance admins; reprocess starts over', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    stripe.failWith = 500
    const error = console.error
    console.error = () => {}
    try {
      for (let attempt = 1; attempt <= 5; attempt++)
        await expect(processStripeEventJob(evt.id as string)).rejects.toThrow()
    } finally {
      console.error = error
    }
    const failed = await storedEvent(evt.id as string)
    expect(failed).toMatchObject({ attempts: 5, processed_at: null })
    expect(failed!.last_error).toBeTruthy()
    expect(mails.filter(m => /could not be processed/.test(m.subject))).toHaveLength(1)
    // Not swept again after five attempts: only an admin's reprocess tries again.
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    expect(await sweepStripeEvents()).toEqual({ requeued: 0 })

    stripe.failWith = null
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(200)
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 0, last_error: null })
    expect(await processStripeEventJob(evt.id as string)).toMatchObject({ credited: { posted: true } })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test('the sweeper queues events unprocessed for more than 5 minutes, not newer ones', async () => {
    const old = event('customer.updated', { id: rid('cus') })
    const fresh = event('customer.updated', { id: rid('cus') })
    for (const e of [old, fresh]) expect((await deliver(JSON.stringify(e))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .where(eq(stripe_events.id, old.id as string))
    const { requeued } = await sweepStripeEvents()
    expect(requeued).toBeGreaterThanOrEqual(1)
    const stale = await db
      .select({ id: stripe_events.id })
      .from(stripe_events)
      .where(
        and(
          sql`${stripe_events.processed_at} is null`,
          sql`${stripe_events.received_at} < now() - interval '5 minutes'`,
          sql`${stripe_events.attempts} < 5`,
        ),
      )
    expect(stale.map(r => r.id)).toContain(old.id)
    expect(stale.map(r => r.id)).not.toContain(fresh.id)
  })

  test('stored events go after 90 days', async () => {
    const evt = event('customer.updated', { id: rid('cus') })
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 91 * 86_400_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    expect(await db.transaction(tx => pruneStripeEvents(tx))).toBeGreaterThanOrEqual(1)
    expect(await storedEvent(evt.id as string)).toBeUndefined()
  })
})

describe('who runs what', () => {
  test('nobody signed in processes or settles events: billing:system belongs to no role', async () => {
    const { ws } = await billWith()
    for (const who of [operator, ws.owner]) {
      expect(await act(who, 'billing.processStripeEvent', { eventId: 'evt_123' })).toMatchObject({
        status: 403,
        body: { error: 'missing permission billing:system' },
      })
      expect((await act(who, 'billing.settleInvoice', { invoiceId: 'in_123' })).status).toBe(403)
    }
  })

  test('reprocess is for instance admins, audited, and refuses an unknown event', async () => {
    const { ws } = await billWith()
    const evt = event('customer.updated', { id: rid('cus') })
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(
      (await act(ws.owner, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(403)
    expect(
      (
        await act(operator, 'billing.reprocessEvent', {
          eventId: 'evt_unknown123',
          reason: 'Stripe was down for an hour',
        })
      ).status,
    ).toBe(409)
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: evt.id, reason: 'Stripe was down for an hour' }))
        .status,
    ).toBe(200)
    const logged = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'billing.reprocessEvent'), eq(commands.actor_id, operator.userId)))
    expect(logged.length).toBeGreaterThanOrEqual(1)
  })
})

describe('the nightly reconciliation', () => {
  test('stores missed events, settles a stuck paid recharge, reports drift and alerts', async () => {
    const subscriptionId = rid('sub')
    const { bill } = await billWith({ stripe_subscription_id: subscriptionId, status: 'active' })
    // A subscription Stripe has as past due with two seats; the bill is active with one workspace and no card.
    stripe.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      object: 'subscription',
      customer: bill.stripe_customer_id,
      status: 'past_due',
      cancel_at_period_end: false,
      trial_end: null,
      default_payment_method: null,
      items: list(
        [
          {
            id: rid('si'),
            object: 'subscription_item',
            quantity: 2,
            current_period_start: nowSec(),
            current_period_end: nowSec() + 30 * 86_400,
            price: { id: rid('price'), object: 'price', lookup_key: 'ws_monthly', recurring: { interval: 'month' } },
          },
        ],
        '/v1/subscription_items',
      ),
    })
    // A recharge pending for two days whose invoice was paid (the webhook never came).
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(
      bill.id,
      invoiceId,
      2000,
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    )
    stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    // An event Stripe sent that never arrived.
    const missed = event('customer.updated', { id: bill.stripe_customer_id, object: 'customer' })
    stripe.events.push(missed)

    const result = await reconcileBilling()
    expect(await storedEvent(missed.id as string)).toBeTruthy()
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    const mine = result.findings.filter(f => 'bill' in f && f.bill === bill.id).map(f => f.kind)
    expect(mine).toEqual(expect.arrayContaining(['status', 'quantity', 'payment_method']))
    expect(result.settled).toBeGreaterThanOrEqual(1)
    expect(result.findings).toContainEqual({ kind: 'missed_events', count: 1 })
    expect(mails.some(m => /differs from Stripe/.test(m.subject))).toBe(true)
    // A second run finds the event stored and the recharge settled: neither again.
    const again = await reconcileBilling()
    expect(again.findings.some(f => f.kind === 'missed_events')).toBe(false)
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
  })

  test('a recharge pending over a day: voided or declined gets PR 4’s failed-recharge rules; still open stays', async () => {
    // One stuck story (review of #865, M1): PR 4 alerts at 2 hours, this run settles after a day and reports nothing.
    // One pending attempt per bill: three bills.
    const [a, b, c] = [(await billWith()).bill, (await billWith()).bill, (await billWith()).bill] as const
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const voided = rid('in')
    const declined = rid('in')
    const open = rid('in')
    const first = await pendingRecharge(a.id, voided, 2000, twoDaysAgo)
    const second = await pendingRecharge(b.id, declined, 2000, twoDaysAgo)
    const third = await pendingRecharge(c.id, open, 2000, twoDaysAgo)
    stripe.invoices.set(voided, invoice(voided, a.stripe_customer_id!, { status: 'void', amount_paid: 0 }))
    stripe.invoices.set(declined, invoice(declined, b.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    failedBy(declined, { code: 'card_declined', decline_code: 'expired_card' })
    stripe.invoices.set(open, invoice(open, c.stripe_customer_id!, { status: 'open', amount_paid: 0 }))
    const result = await reconcileBilling()
    const attempt = async (id: string) =>
      (await db.select().from(billing_recharges).where(eq(billing_recharges.id, id)))[0]
    expect(await attempt(first.id)).toMatchObject({ status: 'canceled', failure_code: 'invoice_voided' })
    expect(await attempt(second.id)).toMatchObject({ status: 'canceled', failure_code: 'expired_card' })
    expect(await attempt(third.id)).toMatchObject({ status: 'pending' })
    expect(stripe.requests).toContain(`/v1/invoices/${declined}/void`)
    expect(
      (await db.select().from(billing_accounts).where(eq(billing_accounts.id, b.id)))[0]!.recharge_failed_at,
    ).not.toBeNull()
    expect(result.findings.some(f => 'bill' in f && [a.id, b.id, c.id].includes(f.bill))).toBe(false)
  })

  test('the card check follows what a recharge charges: the customer’s default, else the subscription’s (billing review B2)', async () => {
    const findingsOf = async (billId: string) =>
      (await reconcileBilling()).findings.filter(f => 'bill' in f && f.bill === billId).map(f => f.kind)
    const subscribed = async (subscriptionCard: string | null, customerCard: string | null) => {
      const subscriptionId = rid('sub')
      const { bill } = await billWith({ stripe_subscription_id: subscriptionId })
      stripe.subscriptions.set(subscriptionId, {
        ...planSubscription(subscriptionId, bill.stripe_customer_id!),
        default_payment_method: subscriptionCard,
      })
      stripe.customers.set(bill.stripe_customer_id!, {
        id: bill.stripe_customer_id,
        object: 'customer',
        default_source: null,
        invoice_settings: { default_payment_method: customerCard },
      })
      return bill
    }
    // The portal's card on the customer, none on the subscription: recharges work, nothing to report.
    expect(await findingsOf((await subscribed(null, rid('pm'))).id)).not.toContain('payment_method')
    // Checkout's card on the subscription only: the recharge makes it the default, nothing to report.
    expect(await findingsOf((await subscribed(rid('pm'), null)).id)).not.toContain('payment_method')
    // Neither: every recharge would fail.
    expect(await findingsOf((await subscribed(null, null)).id)).toContain('payment_method')
  })

  test('more events than the run reads: reported, never dropped silently (review of #865, L5)', async () => {
    stripe.events.push(
      event('customer.updated', { id: rid('cus'), object: 'customer' }, { created: nowSec() - 20 }),
      event('customer.updated', { id: rid('cus'), object: 'customer' }, { created: nowSec() - 10 }),
    )
    const result = await reconcileBilling(new Date(), { eventLimit: 1 })
    expect(result.findings).toContainEqual({ kind: 'events_truncated', count: 1 })
    expect(mails.some(m => /differs from Stripe/.test(m.subject))).toBe(true)
  })

  test('while billing is off it compares nothing, but still removes events older than 90 days (L4)', async () => {
    const evt = event('customer.updated', { id: rid('cus') })
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ received_at: new Date(Date.now() - 91 * 86_400_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    expect((await act(operator, 'billingEnabled.set', { on: false })).status).toBe(200)
    try {
      stripe.requests.length = 0
      const result = await reconcileBilling()
      expect(result).toMatchObject({ findings: [], billing: 'off' })
      expect(result.pruned).toBeGreaterThanOrEqual(1)
      expect(await storedEvent(evt.id as string)).toBeUndefined()
      expect(stripe.requests).toEqual([])
    } finally {
      expect((await act(operator, 'billingEnabled.set', { on: true })).status).toBe(200)
    }
  })

  test('an event given up on is not retried by the nightly run, only by an admin (review of #865, N2)', async () => {
    const evt = event('invoice.paid', invoice(rid('in'), rid('cus')))
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ attempts: 5, last_error: 'Stripe is down' })
      .where(eq(stripe_events.id, evt.id as string))
    stripe.events.push(evt)
    const result = await reconcileBilling()
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 5, processed_at: null })
    expect(result.findings.some(f => f.kind === 'failed_events')).toBe(true)
  })
})

// The credit is posted in the bill's current period, and a bill without one cannot lose a credit silently.
test('a recharge on a bill without any period fails and is retried, never credited to nowhere', async () => {
  const { bill, period } = await billWith()
  await db.delete(billing_periods).where(eq(billing_periods.id, period.id))
  const invoiceId = rid('in')
  const recharge = await pendingRecharge(bill.id, invoiceId)
  stripe.invoices.set(invoiceId, invoice(invoiceId, bill.stripe_customer_id!, { lines: [rechargeLine(recharge.id)] }))
  paidBy(invoiceId, 2000)
  const evt = event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!))
  expect((await deliver(JSON.stringify(evt))).status).toBe(200)
  const error = console.error
  console.error = () => {}
  try {
    await expect(processStripeEventJob(evt.id as string)).rejects.toThrow(/no period/)
  } finally {
    console.error = error
  }
  expect(await rechargeEntries(recharge.id)).toHaveLength(0)
  expect((await storedEvent(evt.id as string))!.processed_at).toBeNull()
})
