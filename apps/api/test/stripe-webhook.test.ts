// Stripe's webhook (stripe-webhook.ts, stripe-events.ts, billing-reconcile.ts): the route checks
// Stripe's signature scheme over the raw body (built here at run time with HMAC-SHA256, both secrets, the tolerance,
// the key's mode), stores the event once and answers; the processor fetches the invoice from a fake Stripe before it
// acts, credits a recharge once and only for a real payment of its amount, makes a paid plan's bill active, and never
// trusts the payload's amounts; failures are retried and alerted; the nightly reconciliation stores missed events,
// settles stuck recharges and reports drift. Instance-wide (Stripe keys, the billing switch): its own database.
import { createHmac } from 'node:crypto'
import { BillingSetupError, WEBHOOK_EVENTS } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_disputes,
  billing_invoices,
  billing_periods,
  billing_recharges,
  commands,
  instance_settings,
  ledger_entries,
  organization,
  provider_settings,
  stripe_events,
  user,
} from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { BILLING_LIFECYCLE_EMAIL, type LifecycleEmailJob, sendLifecycleEmail } from '../src/billing-periods.ts'
import { rechargeGaveUp, rechargeSetupAlertKey } from '../src/billing-recharge.ts'
import { reconcileBilling } from '../src/billing-reconcile.ts'
import { forgetWebhookBillingProvider, setBillingFetch } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { decideRecharge, postEntry } from '../src/ledger.ts'
import { checkLedgerGuards } from '../src/ledger-guards.ts'
import {
  FOREIGN_EVENT,
  HANDLED_EVENTS,
  NOT_SUBSCRIBED,
  processStripeEventJob,
  pruneStripeEvents,
  sweepStripeEvents,
  UNHANDLED_PLAN,
  UNHANDLED_TYPE,
} from '../src/stripe-events.ts'
import { resetStripeWebhookLimits, STRIPE_WEBHOOK_PATH } from '../src/stripe-webhook.ts'
import { act, addMember, appRequest, createWorkspace, FROM, randomIp, type User } from './helpers.ts'

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
  // Disputes and fraud warnings (PR 11): the objects, their charges, and what each charge's payment intent paid.
  disputes: new Map<string, Json>(),
  warnings: new Map<string, Json>(),
  charges: new Map<string, Json>(),
  intentInvoices: new Map<string, string>(),
  intentSessions: new Map<string, string>(),
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
  if (kind === 'invoice_payments' && url.searchParams.has('payment[payment_intent]')) {
    const invoiceId = stripe.intentInvoices.get(url.searchParams.get('payment[payment_intent]')!)
    return reply(
      200,
      list(invoiceId ? [{ id: rid('inpay'), object: 'invoice_payment', invoice: invoiceId }] : [], url.pathname),
    )
  }
  if (kind === 'invoice_payments')
    return reply(200, list(stripe.payments.get(url.searchParams.get('invoice') ?? '') ?? [], url.pathname))
  if (kind === 'disputes' && id) return stripe.disputes.has(id) ? reply(200, stripe.disputes.get(id)) : notFound()
  if (kind === 'charges' && id) return stripe.charges.has(id) ? reply(200, stripe.charges.get(id)) : notFound()
  if (kind === 'radar') {
    const warningId = url.pathname.split('/')[4]!
    return stripe.warnings.has(warningId) ? reply(200, stripe.warnings.get(warningId)) : notFound()
  }
  if (kind === 'checkout' && url.pathname === '/v1/checkout/sessions') {
    const session = stripe.intentSessions.get(url.searchParams.get('payment_intent') ?? '')
    return reply(200, list(session ? [{ id: session, object: 'checkout.session' }] : [], url.pathname))
  }
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
/** A plan subscription as Stripe's API returns it (monthly, one seat). */
function subscription(id: string, customer: string, status: string): Json {
  const start = nowSec()
  return {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: false,
    trial_end: null,
    default_payment_method: null,
    items: list(
      [
        {
          id: rid('si'),
          object: 'subscription_item',
          quantity: 1,
          current_period_start: start,
          current_period_end: start + 30 * 86_400,
          price: { id: rid('price'), object: 'price', lookup_key: 'ws_monthly', recurring: { interval: 'month' } },
        },
      ],
      '/v1/subscription_items',
    ),
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
      // A bill whose owner turned auto-recharge on (it starts off since 2026-11-17).
      auto_recharge: true,
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
    const { bill } = await billWith()
    const customer = bill.stripe_customer_id!
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
      data: { object: { id: customer, object: 'customer', customer, metadata: {} } },
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

  test('stores an event in another API version than the pinned one: only version-proof fields are read', async () => {
    // A Stripe account's default version moves on (the sandbox sent 2026-10-28.endive); the event's object is
    // fetched again at the pinned version before anything is acted on, so its version does not matter.
    const { bill } = await billWith()
    const evt = event(
      'customer.updated',
      { id: bill.stripe_customer_id, object: 'customer' },
      { api_version: '2026-10-28.endive' },
    )
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(await storedEvent(evt.id as string)).toMatchObject({ processed_at: null, last_error: null })
  })

  test('another install’s event (a customer no bill has, none of our ids) is kept as processed and never queued', async () => {
    const evt = event('invoice.paid', invoice(rid('in'), rid('cus')))
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(await storedEvent(evt.id as string)).toMatchObject({ last_error: FOREIGN_EVENT, attempts: 0 })
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
    expect(stripe.requests.filter(r => r.startsWith('/v1/invoices'))).toEqual([])
    // A redelivery is a duplicate.
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
  })

  test('an event naming one of our bills or attempts is ours, whatever its customer', async () => {
    const { bill } = await billWith()
    const viaBill = event('customer.created', {
      id: rid('cus'),
      object: 'customer',
      metadata: { billing_account_id: bill.id },
    })
    const viaOther = event('customer.created', {
      id: rid('cus'),
      object: 'customer',
      metadata: { billing_account_id: rid('bill') },
    })
    for (const evt of [viaBill, viaOther]) expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    expect(await storedEvent(viaBill.id as string)).toMatchObject({ processed_at: null })
    expect(await storedEvent(viaOther.id as string)).toMatchObject({ last_error: FOREIGN_EVENT })
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
      // The fixed anchor the months are counted from (an hour earlier than this period's start, as after a change).
      billing_cycle_anchor: start - 3600,
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
    // The bill's months are counted from the subscription's anchor, not from current_period_start (#879 review, M1).
    expect(new Date(after!.billing_anchor!).getTime()).toBe((start - 3600) * 1000)
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
function planSubscription(
  id: string,
  customer: string,
  over: { status?: string; lookupKeys?: string[]; product?: string } = {},
): Json {
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
        price: {
          id: rid('price'),
          object: 'price',
          product: over.product ?? 'linedesk_workspace',
          lookup_key: lookupKey,
          recurring: { interval: 'month' },
        },
      })),
      '/v1/subscription_items',
    ),
  }
}

describe('invoice.paid of Checkout’s first invoice, before the bill has its subscription (billing review B4)', () => {
  /** A bill as Checkout leaves it: the customer stored, the subscription not yet; its first plan invoice paid. */
  async function paidBeforeLinked(
    sub: { status?: string; lookupKeys?: string[]; customer?: string; product?: string } = {},
  ) {
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

  test('a plan lookup key on another product (a Stripe account shared with another integration) is never linked (review of #1040, L-1)', async () => {
    const shared = await paidBeforeLinked({ product: 'prod_OtherIntegration' })
    expect(await deliverAndProcess(shared.evt)).not.toHaveProperty('linked')
    expect(await billRow(shared.bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: null })
  })

  test('a bill that has a subscription keeps it: another subscription’s invoice changes nothing', async () => {
    const { bill, evt } = await paidBeforeLinked()
    const own = rid('sub')
    await db.update(billing_accounts).set({ stripe_subscription_id: own }).where(eq(billing_accounts.id, bill.id))
    expect(await deliverAndProcess(evt)).not.toHaveProperty('linked')
    expect(await billRow(bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: own })
  })
})

describe('a new card after a failed recharge', () => {
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

  test('a customer no bill has and none of our ids: another install’s event, done at once without asking Stripe', async () => {
    expect(await deliverAndProcess(event('customer.updated', { id: rid('cus'), object: 'customer' }))).toEqual({
      skipped: 'processed',
    })
    expect(stripe.requests.filter(r => r.startsWith('/v1/customers'))).toEqual([])
  })
})

describe('a new card put on the bill by a workspace admin in the portal (decision of 2026-11-17)', () => {
  const queued: { name: string; data: Record<string, unknown> }[] = []
  beforeEach(() => {
    queued.length = 0
    setJobQueue({
      send: async (name: string, data: Record<string, unknown>) => {
        queued.push({ name, data })
        return 'job'
      },
      insert: async () => [],
    } as never)
  })
  afterEach(() => setJobQueue(null))
  const notes = () => queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL)

  /** A bill of one workspace with an admin; its customer's invoice default is a Visa made at `cardMade` (Unix s). */
  async function adminAndCard(cardMade: number) {
    const { ws, bill } = await billWith()
    const admin = await addMember(ws.id, 'admin')
    await db.update(user).set({ name: 'Dana Lee' }).where(eq(user.id, admin.userId))
    const cardId = rid('pm')
    stripe.customers.set(bill.stripe_customer_id!, {
      id: bill.stripe_customer_id,
      object: 'customer',
      default_source: null,
      invoice_settings: {
        default_payment_method: {
          id: cardId,
          object: 'payment_method',
          type: 'card',
          created: cardMade,
          card: { brand: 'visa', last4: '4242' },
        },
      },
    })
    return { ws, bill, admin, cardId }
  }
  /** `who` opened the Stripe portal `minutesAgo` minutes ago, as the command log keeps it. */
  const openedPortal = (workspaceId: string, who: string, minutesAgo: number) =>
    db.insert(commands).values({
      id: rid('cmd'),
      workspace_id: workspaceId,
      actor_id: who,
      action: 'billing.openPortal',
      input: {},
      result: { ok: true },
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    })
  const cardEvents = (customer: string) => [
    event('payment_method.attached', { id: rid('pm'), object: 'payment_method', customer }),
    event('customer.updated', { id: customer, object: 'customer' }),
  ]

  test('the owner gets one email for the card, whatever events the change sends; to the owner alone', async () => {
    const { ws, bill, admin, cardId } = await adminAndCard(nowSec())
    await openedPortal(ws.id, admin.userId, 5)
    for (const evt of cardEvents(bill.stripe_customer_id!)) await deliverAndProcess(evt)
    // The same change again (Stripe sends another event for it): still one email.
    await deliverAndProcess(event('customer.updated', { id: bill.stripe_customer_id, object: 'customer' }))
    expect(notes()).toHaveLength(1)
    expect(notes()[0]!.data).toMatchObject({
      bill: bill.id,
      email: { kind: 'manager_changed', change: 'paymentMethod', actorId: admin.userId },
    })
    expect(notes()[0]!.data.workspace).toBeUndefined()
    const alerts = await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, bill.id))
    expect(alerts).toMatchObject([{ kind: 'manager_change', ref: `card:${cardId}` }])
    // Sent to the bill owner only: not to the admin who made the change.
    const sent: { to: string; subject: string; text: string }[] = []
    const sender = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) }
    await sendLifecycleEmail(sender as never, notes()[0]!.data as LifecycleEmailJob)
    const [owner] = await db.select().from(user).where(eq(user.id, ws.owner.userId))
    const [adminRow] = await db.select().from(user).where(eq(user.id, admin.userId))
    expect(sent.map(m => m.to)).toEqual([owner!.email])
    expect(sent[0]!.subject).toBe('Dana Lee changed the card for Brightwater Plumbing & Heating')
    expect(sent[0]!.text).toContain(`Dana Lee (${adminRow!.email}) manages the bill of Brightwater Plumbing & Heating`)
    expect(sent[0]!.text).toContain('From now on the bill is charged to the Visa card ending in 4242.')
    expect(sent[0]!.text).toContain(`#workspace/billing?ws=${ws.id}`)
  })

  test('nothing when the owner opened the portal last, the card is older than the portal, or the portal is long gone', async () => {
    const own = await adminAndCard(nowSec())
    await openedPortal(own.ws.id, own.admin.userId, 30)
    await openedPortal(own.ws.id, own.ws.owner.userId, 5)
    for (const evt of cardEvents(own.bill.stripe_customer_id!)) await deliverAndProcess(evt)
    // An address change in the admin's portal: the card was there before.
    const old = await adminAndCard(nowSec() - 86_400)
    await openedPortal(old.ws.id, old.admin.userId, 5)
    for (const evt of cardEvents(old.bill.stripe_customer_id!)) await deliverAndProcess(evt)
    // A portal the admin opened two hours before the card was made.
    const late = await adminAndCard(nowSec())
    await openedPortal(late.ws.id, late.admin.userId, 120)
    for (const evt of cardEvents(late.bill.stripe_customer_id!)) await deliverAndProcess(evt)
    expect(notes()).toEqual([])
  })

  test('a bill without a portal opened by someone else asks Stripe nothing for it', async () => {
    const { ws, bill } = await adminAndCard(nowSec())
    await openedPortal(ws.id, ws.owner.userId, 5)
    stripe.requests.length = 0
    expect(
      await deliverAndProcess(event('customer.updated', { id: bill.stripe_customer_id, object: 'customer' })),
    ).toEqual({ outcome: 'applied', bill: bill.id })
    expect(stripe.requests.filter(r => r.startsWith('/v1/customers'))).toEqual([])
    expect(notes()).toEqual([])
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

  test('a plan invoice’s failure makes the bill past_due (dunning, PR 11); one stored before is armed again', async () => {
    const subscriptionId = rid('sub')
    const { bill, ws } = await billWith({ stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'past_due'))
    const invoiceId = rid('in')
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        status: 'open',
        amount_paid: 0,
        billing_reason: 'subscription_cycle',
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    const evt = event('invoice.payment_failed', invoice(invoiceId, bill.stripe_customer_id!))
    // As the release before dunning left it.
    expect((await deliver(JSON.stringify(evt))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ attempts: 5, last_error: UNHANDLED_PLAN, received_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(stripe_events.id, evt.id as string))
    await sweepStripeEvents()
    expect(await storedEvent(evt.id as string)).toMatchObject({ attempts: 0, last_error: null })
    expect(await processStripeEventJob(evt.id as string)).toEqual({
      outcome: 'lifecycle',
      bill: bill.id,
      change: 'past_due',
    })
    const [after] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))
    expect(after).toMatchObject({ status: 'past_due', past_due_first_payment: false })
    expect(Date.parse(after!.past_due_since!)).toBe((evt.created as number) * 1000)
    // Calls are answered as normal while past_due.
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('active')
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
  })

  test('the first payment after the trial failing is flagged (3 days of grace); a paid-up subscription changes nothing', async () => {
    const subscriptionId = rid('sub')
    const { bill } = await billWith({ status: 'trialing', stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'past_due'))
    const planInvoice = (id: string) =>
      invoice(id, bill.stripe_customer_id!, {
        status: 'open',
        amount_paid: 0,
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      })
    const first = rid('in')
    stripe.invoices.set(first, planInvoice(first))
    await deliverAndProcess(event('invoice.payment_failed', invoice(first, bill.stripe_customer_id!)))
    const [after] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))
    expect(after).toMatchObject({ status: 'past_due', past_due_first_payment: true })

    const paidSub = rid('sub')
    const other = await billWith({ stripe_subscription_id: paidSub })
    stripe.subscriptions.set(paidSub, subscription(paidSub, other.bill.stripe_customer_id!, 'active'))
    const second = rid('in')
    stripe.invoices.set(second, {
      ...invoice(second, other.bill.stripe_customer_id!, { status: 'open', amount_paid: 0 }),
      parent: { type: 'subscription_details', subscription_details: { subscription: paidSub } },
    })
    expect(
      await deliverAndProcess(event('invoice.payment_failed', invoice(second, other.bill.stripe_customer_id!))),
    ).toEqual({ outcome: 'applied', bill: other.bill.id })
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, other.bill.id)))[0]!.status).toBe(
      'active',
    )
  })
})

describe('the recharge job gives up, but Stripe had already paid the invoice (review #1110, V-1)', () => {
  const attempt = async (id: string) =>
    (await db.select().from(billing_recharges).where(eq(billing_recharges.id, id)))[0]!
  const billOf = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
  /** A pending attempt whose invoice Stripe's own collection paid; its invoice.paid not processed yet. */
  async function paidBehindTheJob() {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        metadata: { billing_recharge_id: recharge.id },
        lines: [rechargeLine(recharge.id)],
      }),
    )
    paidBy(invoiceId, 2000)
    return { bill, invoiceId, recharge }
  }
  /** The webhook that comes after the give-up: it credits nothing a second time. */
  async function webhookAfter(bill: typeof billing_accounts.$inferSelect, invoiceId: string) {
    expect(await deliverAndProcess(event('invoice.paid', invoice(invoiceId, bill.stripe_customer_id!)))).toMatchObject({
      credited: { posted: false },
    })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  }

  test('the normal give-up credits the attempt once, voids nothing and emails nobody that it failed', async () => {
    const { bill, invoiceId, recharge } = await paidBehindTheJob()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, recharge.id)
    expect(await attempt(recharge.id)).toMatchObject({ status: 'paid', stripe_invoice_id: invoiceId })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
    expect(stripe.requests).not.toContain(`/v1/invoices/${invoiceId}/void`)
    expect((await billOf(bill.id)).recharge_failed_at).toBeNull()
    expect(await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, bill.id))).toEqual([])
    expect(mails.some(m => /recharge|failed|not credited/i.test(m.subject))).toBe(false)
    await webhookAfter(bill, invoiceId)
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
  })

  test('the setup give-up credits it too: not canceled, no setup alert', async () => {
    const { bill, invoiceId, recharge } = await paidBehindTheJob()
    const code = `stripe_stripe_tax_inactive_${rid('t')}`
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, recharge.id, { setupError: new BillingSetupError(code) })
    expect(await attempt(recharge.id)).toMatchObject({ status: 'paid' })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect(stripe.requests).not.toContain(`/v1/invoices/${invoiceId}/void`)
    expect((await billOf(bill.id)).recharge_failed_at).toBeNull()
    // The once-a-day setup alert was not armed: nothing failed.
    expect(
      await db
        .select()
        .from(instance_settings)
        .where(eq(instance_settings.key, rechargeSetupAlertKey(code))),
    ).toEqual([])
    await webhookAfter(bill, invoiceId)
    expect(await rechargeEntries(recharge.id)).toHaveLength(1)
  })

  test('a paid invoice that does not pass the credit checks is not credited, and not canceled as failed either', async () => {
    const { bill } = await billWith()
    const invoiceId = rid('in')
    const recharge = await pendingRecharge(bill.id, invoiceId)
    // Paid out of band (marked paid in the Dashboard): no money came through Stripe, so nothing is credited.
    stripe.invoices.set(
      invoiceId,
      invoice(invoiceId, bill.stripe_customer_id!, {
        amount_paid: 0,
        amount_paid_off_stripe: 2000,
        lines: [rechargeLine(recharge.id)],
      }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, recharge.id)
    expect(await balanceOf(bill.id)).toBe(0)
    expect(await rechargeEntries(recharge.id)).toEqual([])
    expect((await billOf(bill.id)).recharge_failed_at).toBeNull()
    expect(
      (await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, bill.id))).filter(
        a => a.kind === 'recharge_failed',
      ),
    ).toEqual([])
  })
})

describe('the processor', () => {
  test('an event stored before its owner was known, of a customer no bill has: marked processed at once', async () => {
    // As a release before the owner check left it: stored and queued, though no bill has its customer.
    const evt = event('invoice.paid', invoice(rid('in'), rid('cus')))
    await db.insert(stripe_events).values({
      id: evt.id as string,
      type: 'invoice.paid',
      livemode: false,
      created: new Date().toISOString(),
      received_at: new Date().toISOString(),
      payload: evt,
    })
    expect(await processStripeEventJob(evt.id as string)).toEqual({ outcome: 'unknown' })
    expect(await storedEvent(evt.id as string)).toMatchObject({ last_error: FOREIGN_EVENT })
    expect((await storedEvent(evt.id as string))!.processed_at).not.toBeNull()
    expect(stripe.requests.filter(r => r.startsWith('/v1/invoices'))).toEqual([])
  })

  test('an event without a customer and none of our ids (a dispute) is retried for an hour, then marked processed', async () => {
    const evt = event('charge.dispute.created', { id: rid('dp'), object: 'dispute', charge: rid('ch') })
    const first = await deliverAndProcess(evt)
    expect(first).not.toEqual({ skipped: 'processed' })
    expect((await storedEvent(evt.id as string))!.last_error).not.toBe(FOREIGN_EVENT)
  })

  test('the bill is stored after its first event came: the retry finds it and credits (review of #865, L2)', async () => {
    // Stripe does not order events: invoice.paid may come before the bill has its customer. The invoice names our
    // bill (its subscription's metadata), so the event is ours and waits for the bill instead of being skipped as
    // another install's.
    const customer = rid('cus')
    const invoiceId = rid('in')
    const { bill } = await billWith({ stripe_customer_id: null })
    const evt = event(
      'invoice.paid',
      invoice(invoiceId, customer, {
        parent: { type: 'subscription_details', subscription_details: { metadata: { billing_account_id: bill.id } } },
      }),
    )
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'unknown_retry' })
    await db.update(billing_accounts).set({ stripe_customer_id: customer }).where(eq(billing_accounts.id, bill.id))
    const recharge = await pendingRecharge(bill.id, invoiceId)
    stripe.invoices.set(invoiceId, invoice(invoiceId, customer, { lines: [rechargeLine(recharge.id)] }))
    paidBy(invoiceId, 2000)
    expect(await processStripeEventJob(evt.id as string)).toMatchObject({ credited: { posted: true } })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
  })

  test('a type this release does not act on stays unprocessed with its marker; no retry, no alert (M1)', async () => {
    const { bill } = await billWith()
    const evt = event('invoice.payment_action_required', invoice(rid('in'), bill.stripe_customer_id!))
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

  test('every type a job acts on is subscribed', () => {
    expect(HANDLED_EVENTS.filter(type => !(WEBHOOK_EVENTS as readonly string[]).includes(type))).toEqual([])
  })

  test('a type the endpoint no longer subscribes to is closed at once, and the sweeper closes stored ones', async () => {
    const { bill } = await billWith()
    const evt = event('invoice.finalized', invoice(rid('in'), bill.stripe_customer_id!))
    expect(await deliverAndProcess(evt)).toEqual({ outcome: 'not_subscribed' })
    expect(await storedEvent(evt.id as string)).toMatchObject({ last_error: NOT_SUBSCRIBED })
    expect((await storedEvent(evt.id as string))?.processed_at).not.toBeNull()
    // As a release before this one left it.
    const old = event('setup_intent.succeeded', {
      id: rid('seti'),
      object: 'setup_intent',
      customer: bill.stripe_customer_id,
    })
    expect((await deliver(JSON.stringify(old))).status).toBe(200)
    await db
      .update(stripe_events)
      .set({ attempts: 5, last_error: UNHANDLED_TYPE })
      .where(eq(stripe_events.id, old.id as string))
    await sweepStripeEvents()
    expect(await storedEvent(old.id as string)).toMatchObject({ last_error: NOT_SUBSCRIBED })
    expect((await storedEvent(old.id as string))?.processed_at).not.toBeNull()
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
    const { bill } = await billWith()
    const evt = event('invoice.paid', invoice(rid('in'), bill.stripe_customer_id!))
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

describe('disputes, fraud warnings and cancellations', () => {
  /** A recharge of `cents` paid by invoice `invoiceId` and credited, its charge `ch_…` through a payment intent. */
  async function creditedRecharge(billId: string, periodId: string, cents = 2000) {
    const invoiceId = rid('in')
    const [recharge] = await db
      .insert(billing_recharges)
      .values({
        id: rid('rc'),
        billing_account_id: billId,
        amount_cents: cents,
        stripe_invoice_id: invoiceId,
        status: 'paid',
        resolved_at: new Date().toISOString(),
      })
      .returning()
    await db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: billId,
        period_id: periodId,
        kind: 'recharge',
        amount_micros: cents * 10_000,
        source_type: 'billing_recharge',
        source_id: recharge!.id,
      }),
    )
    const intent = rid('pi')
    const charge = rid('ch')
    stripe.intentInvoices.set(intent, invoiceId)
    return { recharge: recharge!, invoiceId, intent, charge }
  }
  const chargeOf = (id: string, customer: string, intent: string, amount = 2000, refunded = false) =>
    stripe.charges.set(id, { id, object: 'charge', customer, payment_intent: intent, amount, refunded })
  const disputeOf = (id: string, charge: string, status: string, amount = 2000) =>
    stripe.disputes.set(id, { id, object: 'dispute', charge, status, amount, currency: 'usd' })
  const billNow = async (id: string) =>
    (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
  const disputeEntries = (billId: string) =>
    db
      .select()
      .from(ledger_entries)
      .where(and(eq(ledger_entries.billing_account_id, billId), eq(ledger_entries.kind, 'adjustment')))

  test('a dispute suspends at once and takes the disputed credit off the balance, once; won gives it back and lifts', async () => {
    const subscriptionId = rid('sub')
    const { bill, period, ws } = await billWith({ stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'active'))
    const paid = await creditedRecharge(bill.id, period.id)
    chargeOf(paid.charge, bill.stripe_customer_id!, paid.intent)
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response')
    const created = event('charge.dispute.created', { id: disputeId, object: 'dispute', charge: paid.charge })
    expect(await deliverAndProcess(created)).toEqual({ outcome: 'lifecycle', bill: bill.id, change: 'dispute' })
    expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'dispute' })
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('suspended')
    expect(await balanceOf(bill.id)).toBe(0)
    expect(mails.map(m => m.subject).filter(s => /dispute/i.test(s))).toHaveLength(1)
    // The same dispute again (Reprocess): nothing more is taken.
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: created.id, reason: 'Replayed after the dispute' }))
        .status,
    ).toBe(200)
    await processStripeEventJob(created.id as string)
    expect(await disputeEntries(bill.id)).toHaveLength(1)
    expect(await balanceOf(bill.id)).toBe(0)
    // A paid plan invoice does not lift a dispute's suspension (review of #865, N1).
    const planInvoice = rid('in')
    stripe.invoices.set(
      planInvoice,
      invoice(planInvoice, bill.stripe_customer_id!, {
        total: 900,
        amount_paid: 900,
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      }),
    )
    paidBy(planInvoice, 900)
    expect(
      await deliverAndProcess(event('invoice.paid', invoice(planInvoice, bill.stripe_customer_id!))),
    ).toMatchObject({
      plan: 'unchanged',
    })
    expect((await billNow(bill.id)).status).toBe('suspended')
    // Won: the reversing adjustment, the bill active again.
    disputeOf(disputeId, paid.charge, 'won')
    expect(
      await deliverAndProcess(
        event('charge.dispute.closed', { id: disputeId, object: 'dispute', charge: paid.charge }),
      ),
    ).toEqual({ outcome: 'lifecycle', bill: bill.id, change: 'dispute_won' })
    const entries = await disputeEntries(bill.id)
    expect(entries).toHaveLength(2)
    const taken = entries.find(e => e.amount_micros < 0)!
    expect(entries.find(e => e.amount_micros > 0)).toMatchObject({
      amount_micros: 20_000_000,
      reverses_entry_id: taken.id,
    })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect(await billNow(bill.id)).toMatchObject({ status: 'active', suspend_reason: null })
  })

  test('a disputed top-up is taken off too; a dispute of a plan charge only suspends; lost stays suspended', async () => {
    const { bill, period } = await billWith()
    const session = rid('cs')
    await db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: bill.id,
        period_id: period.id,
        kind: 'topup',
        amount_micros: 50_000_000,
        source_type: 'stripe_checkout',
        source_id: session,
      }),
    )
    const intent = rid('pi')
    const charge = rid('ch')
    stripe.intentSessions.set(intent, session)
    chargeOf(charge, bill.stripe_customer_id!, intent)
    const disputeId = rid('du')
    disputeOf(disputeId, charge, 'needs_response', 5000)
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(0)
    disputeOf(disputeId, charge, 'lost', 5000)
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    expect(await disputeEntries(bill.id)).toHaveLength(1)
    expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'dispute' })

    const other = await billWith()
    const planCharge = rid('ch')
    chargeOf(planCharge, other.bill.stripe_customer_id!, rid('pi'))
    const planDispute = rid('du')
    disputeOf(planDispute, planCharge, 'needs_response', 900)
    await deliverAndProcess(event('charge.dispute.created', { id: planDispute, object: 'dispute' }))
    expect(await disputeEntries(other.bill.id)).toEqual([])
    expect((await billNow(other.bill.id)).status).toBe('suspended')
  })

  test('a dispute of a charge whose customer no bill has changes nothing here', async () => {
    const charge = rid('ch')
    chargeOf(charge, rid('cus'), rid('pi'))
    const disputeId = rid('du')
    disputeOf(disputeId, charge, 'needs_response')
    expect(await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))).toEqual({
      outcome: 'unknown_retry',
    })
  })

  test('an early fraud warning suspends and turns auto-recharge off; a won dispute does not lift it', async () => {
    const subscriptionId = rid('sub')
    const { bill, period } = await billWith({ stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'active'))
    const paid = await creditedRecharge(bill.id, period.id)
    chargeOf(paid.charge, bill.stripe_customer_id!, paid.intent)
    const warningId = rid('issfr')
    stripe.warnings.set(warningId, { id: warningId, object: 'radar.early_fraud_warning', charge: paid.charge })
    expect(
      await deliverAndProcess(
        event('radar.early_fraud_warning.created', { id: warningId, object: 'radar.early_fraud_warning' }),
      ),
    ).toEqual({ outcome: 'lifecycle', bill: bill.id, change: 'fraud_warning' })
    expect(await billNow(bill.id)).toMatchObject({
      status: 'suspended',
      suspend_reason: 'early_fraud_warning',
      auto_recharge: false,
    })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    // The dispute that follows takes the credit; won, it gives it back, but the warning still holds the bill.
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response')
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    // The warning stays the reason: only an instance admin lifts it (re-review of #920, N1).
    expect((await billNow(bill.id)).suspend_reason).toBe('early_fraud_warning')
    disputeOf(disputeId, paid.charge, 'won')
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect((await billNow(bill.id)).status).toBe('suspended')
  })

  /** A bill with an active subscription and a credited $20 recharge whose charge is `paid.charge`. */
  async function disputable() {
    const subscriptionId = rid('sub')
    const billed = await billWith({ stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, billed.bill.stripe_customer_id!, 'active'))
    const paid = await creditedRecharge(billed.bill.id, billed.period.id)
    chargeOf(paid.charge, billed.bill.stripe_customer_id!, paid.intent)
    return { ...billed, paid }
  }
  const closedMails = () => mails.map(m => m.subject).filter(s => /is settled|stays suspended/.test(s))

  test('an inquiry closed without a chargeback (warning_closed), or a prevented one: the credit back, lifted, admins told', async () => {
    for (const closedAs of ['warning_closed', 'prevented']) {
      const { bill, paid } = await disputable()
      const disputeId = rid('du')
      disputeOf(disputeId, paid.charge, 'warning_needs_response')
      await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
      expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'dispute' })
      expect(await balanceOf(bill.id)).toBe(0)
      const before = closedMails().length
      disputeOf(disputeId, paid.charge, closedAs)
      expect(await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))).toEqual({
        outcome: 'lifecycle',
        bill: bill.id,
        change: `dispute_${closedAs}`,
      })
      expect(await balanceOf(bill.id)).toBe(20_000_000)
      expect(await billNow(bill.id)).toMatchObject({ status: 'active', suspend_reason: null })
      expect(closedMails().length).toBe(before + 1)
    }
  })

  test('a created event processed after the dispute was won takes nothing again and does not suspend', async () => {
    const { bill, paid } = await disputable()
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response')
    const created = event('charge.dispute.created', { id: disputeId, object: 'dispute' })
    await deliverAndProcess(created)
    disputeOf(disputeId, paid.charge, 'won')
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    expect(await billNow(bill.id)).toMatchObject({ status: 'active' })
    // The created event again (an admin's Reprocess, or a retry after a crash): Stripe says won now.
    expect(
      (await act(operator, 'billing.reprocessEvent', { eventId: created.id, reason: 'Replayed after the dispute' }))
        .status,
    ).toBe(200)
    await processStripeEventJob(created.id as string)
    expect(await billNow(bill.id)).toMatchObject({ status: 'active', suspend_reason: null })
    expect(await disputeEntries(bill.id)).toHaveLength(2)
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    // A dispute whose first event we see is already won: stored, nothing taken, nothing suspended.
    const late = await disputable()
    const wonId = rid('du')
    disputeOf(wonId, late.paid.charge, 'won')
    await deliverAndProcess(event('charge.dispute.created', { id: wonId, object: 'dispute' }))
    expect(await billNow(late.bill.id)).toMatchObject({ status: 'active' })
    expect(await disputeEntries(late.bill.id)).toEqual([])
  })

  test('a partial dispute takes off only the disputed share of the credit (the charge includes tax)', async () => {
    const { bill, paid, period } = await disputable()
    // $20 credited, charged $22 with tax; $11 disputed: half the credit.
    chargeOf(paid.charge, bill.stripe_customer_id!, paid.intent, 2200)
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response', 1100)
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(10_000_000)
    // Never more than the credit, even when the dispute names more than the charge.
    const other = await creditedRecharge(bill.id, period.id)
    chargeOf(other.charge, bill.stripe_customer_id!, other.intent, 2200)
    const bigger = rid('du')
    disputeOf(bigger, other.charge, 'needs_response', 9900)
    await deliverAndProcess(event('charge.dispute.created', { id: bigger, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(10_000_000)
  })

  test('a lost dispute keeps the bill suspended and tells the admins', async () => {
    const { bill, paid } = await disputable()
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response')
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    const before = mails.filter(m => /stays suspended/.test(m.subject)).length
    disputeOf(disputeId, paid.charge, 'lost')
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'dispute' })
    expect(await balanceOf(bill.id)).toBe(0)
    expect(mails.filter(m => /stays suspended/.test(m.subject)).length).toBe(before + 1)
  })

  test('a fraud-warned charge refunded in full: the warning closed, its credit taken off once, the bill still held (re-review of #920, N1)', async () => {
    const { bill, paid } = await disputable()
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    const warningId = rid('issfr')
    stripe.warnings.set(warningId, { id: warningId, object: 'radar.early_fraud_warning', charge: paid.charge })
    await deliverAndProcess(
      event('radar.early_fraud_warning.created', { id: warningId, object: 'radar.early_fraud_warning' }),
    )
    expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'early_fraud_warning' })
    const refundedEvent = () =>
      event('charge.refunded', { id: paid.charge, object: 'charge', customer: bill.stripe_customer_id })
    // Partly refunded: nothing changes.
    expect(await deliverAndProcess(refundedEvent())).toEqual({ outcome: 'applied', bill: bill.id })
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    // The $20 recharge refunded in full (the Dashboard's refund): the card got the money back, so the minutes go.
    chargeOf(paid.charge, bill.stripe_customer_id!, paid.intent, 2000, true)
    expect(await deliverAndProcess(refundedEvent())).toEqual({
      outcome: 'lifecycle',
      bill: bill.id,
      change: 'fraud_warning_refunded',
    })
    expect(await balanceOf(bill.id)).toBe(0)
    const [row] = await db.select().from(billing_disputes).where(eq(billing_disputes.id, warningId))
    expect(row!.status).toBe('refunded')
    // Not opened again on its own: the flagged card is still saved, so an instance admin decides; no recharge.
    expect(await billNow(bill.id)).toMatchObject({
      status: 'suspended',
      suspend_reason: 'early_fraud_warning',
      auto_recharge: false,
    })
    expect(await db.transaction(tx => decideRecharge(tx, bill.id, new Date().toISOString()))).toEqual({ kind: 'none' })
    // The refund event again: nothing more is taken.
    await deliverAndProcess(refundedEvent())
    expect(await balanceOf(bill.id)).toBe(0)
    expect(await disputeEntries(bill.id)).toHaveLength(1)
  })

  test('a warning whose charge was refunded before it came: the credit taken off, the bill held all the same (re-review of #920, N1)', async () => {
    const { bill, paid } = await disputable()
    chargeOf(paid.charge, bill.stripe_customer_id!, paid.intent, 2000, true)
    const warningId = rid('issfr')
    stripe.warnings.set(warningId, { id: warningId, object: 'radar.early_fraud_warning', charge: paid.charge })
    await deliverAndProcess(
      event('radar.early_fraud_warning.created', { id: warningId, object: 'radar.early_fraud_warning' }),
    )
    expect(await balanceOf(bill.id)).toBe(0)
    expect(await billNow(bill.id)).toMatchObject({
      status: 'suspended',
      suspend_reason: 'early_fraud_warning',
      auto_recharge: false,
    })
    const [row] = await db.select().from(billing_disputes).where(eq(billing_disputes.id, warningId))
    expect(row!.status).toBe('refunded')
    // Its refund event after it takes nothing again.
    await deliverAndProcess(
      event('charge.refunded', { id: paid.charge, object: 'charge', customer: bill.stripe_customer_id }),
    )
    expect(await balanceOf(bill.id)).toBe(0)
  })

  test('a stale created that commits after closed (won) never writes its status over the final one (re-review of #920, N3)', async () => {
    const { bill, paid } = await disputable()
    const disputeId = rid('du')
    // closed is processed first and stores won; the created event fetched needs_response before that and commits now.
    disputeOf(disputeId, paid.charge, 'won')
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    disputeOf(disputeId, paid.charge, 'needs_response')
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    const [row] = await db.select().from(billing_disputes).where(eq(billing_disputes.id, disputeId))
    expect(row!.status).toBe('won')
    expect(await disputeEntries(bill.id)).toEqual([])
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect(await billNow(bill.id)).toMatchObject({ status: 'active', suspend_reason: null })
  })

  test("an instance admin's suspension stays: a dispute does not take it over, a won one does not lift it (#919's suspend_reason)", async () => {
    const { bill, paid } = await disputable()
    await db
      .update(billing_accounts)
      .set({
        status: 'suspended',
        suspend_reason: 'admin',
        suspended_from: 'active',
        suspended_at: new Date().toISOString(),
      })
      .where(eq(billing_accounts.id, bill.id))
    const disputeId = rid('du')
    disputeOf(disputeId, paid.charge, 'needs_response')
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    expect(await billNow(bill.id)).toMatchObject({
      status: 'suspended',
      suspend_reason: 'admin',
      suspended_from: 'active',
    })
    expect(await balanceOf(bill.id)).toBe(0)
    disputeOf(disputeId, paid.charge, 'won')
    await deliverAndProcess(event('charge.dispute.closed', { id: disputeId, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(20_000_000)
    expect(await billNow(bill.id)).toMatchObject({ status: 'suspended', suspend_reason: 'admin' })
  })

  test("a disputed top-up whose Checkout made an invoice too (Stripe's invoice_creation): its credit is found and taken off", async () => {
    // Stripe's documented shape for a Checkout payment with invoice_creation: the session's payment intent pays the
    // invoice Checkout made, so invoice_payments lists that invoice for the intent, and the session lists the intent.
    const { bill, period } = await billWith()
    const session = rid('cs')
    await db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: bill.id,
        period_id: period.id,
        kind: 'topup',
        amount_micros: 50_000_000,
        source_type: 'stripe_checkout',
        source_id: session,
      }),
    )
    const intent = rid('pi')
    const charge = rid('ch')
    stripe.intentInvoices.set(intent, rid('in'))
    stripe.intentSessions.set(intent, session)
    chargeOf(charge, bill.stripe_customer_id!, intent, 5000)
    const disputeId = rid('du')
    disputeOf(disputeId, charge, 'needs_response', 5000)
    await deliverAndProcess(event('charge.dispute.created', { id: disputeId, object: 'dispute' }))
    expect(await balanceOf(bill.id)).toBe(0)
    const [row] = await db.select().from(billing_disputes).where(eq(billing_disputes.id, disputeId))
    expect(row!.adjustment_entry_id).not.toBeNull()
  })

  test('cancel at the period end set or undone outside the app is mirrored from the subscription fetched now (review of #1007, M-2)', async () => {
    const subscriptionId = rid('sub')
    const { bill } = await billWith({ stripe_subscription_id: subscriptionId })
    const updated = () =>
      event('customer.subscription.updated', {
        id: subscriptionId,
        object: 'subscription',
        customer: bill.stripe_customer_id,
      })
    // Set to cancel in Stripe's Dashboard: the page no longer says it renews.
    stripe.subscriptions.set(subscriptionId, {
      ...subscription(subscriptionId, bill.stripe_customer_id!, 'active'),
      cancel_at_period_end: true,
    })
    expect(await deliverAndProcess(updated())).toEqual({
      outcome: 'lifecycle',
      bill: bill.id,
      change: 'cancel_at_period_end',
    })
    expect((await billNow(bill.id)).cancel_at_period_end).toBe(true)
    // Renewed again outside the app: the page must not say "nothing more is charged".
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'active'))
    expect(await deliverAndProcess(updated())).toEqual({ outcome: 'lifecycle', bill: bill.id, change: 'renews' })
    expect((await billNow(bill.id)).cancel_at_period_end).toBe(false)
    // Nothing changed: applied, nothing written.
    expect(await deliverAndProcess(updated())).toEqual({ outcome: 'applied', bill: bill.id })
    // A canceled bill is left alone.
    await db.update(billing_accounts).set({ status: 'canceled' }).where(eq(billing_accounts.id, bill.id))
    stripe.subscriptions.set(subscriptionId, {
      ...subscription(subscriptionId, bill.stripe_customer_id!, 'active'),
      cancel_at_period_end: true,
    })
    expect(await deliverAndProcess(updated())).toEqual({ outcome: 'applied', bill: bill.id })
    expect((await billNow(bill.id)).cancel_at_period_end).toBe(false)
  })

  test('a subscription deleted in Stripe cancels the bill, once, with the release date for the owner', async () => {
    const subscriptionId = rid('sub')
    const { bill, ws } = await billWith({ stripe_subscription_id: subscriptionId })
    stripe.subscriptions.set(subscriptionId, subscription(subscriptionId, bill.stripe_customer_id!, 'canceled'))
    const deleted = event('customer.subscription.deleted', {
      id: subscriptionId,
      object: 'subscription',
      customer: bill.stripe_customer_id,
    })
    expect(await deliverAndProcess(deleted)).toEqual({ outcome: 'lifecycle', bill: bill.id, change: 'canceled' })
    const after = await billNow(bill.id)
    expect(after.status).toBe('canceled')
    expect(after.canceled_at).not.toBeNull()
    expect((await db.select().from(organization).where(eq(organization.id, ws.id)))[0]!.billingState).toBe('suspended')
    const alerts = await db
      .select()
      .from(billing_alerts)
      .where(and(eq(billing_alerts.billing_account_id, bill.id), eq(billing_alerts.kind, 'numbers_release')))
    expect(alerts).toHaveLength(1)
    // Still active in Stripe (a stale event): nothing.
    const liveId = rid('sub')
    const live = await billWith({ stripe_subscription_id: liveId })
    stripe.subscriptions.set(liveId, subscription(liveId, live.bill.stripe_customer_id!, 'active'))
    expect(
      await deliverAndProcess(
        event('customer.subscription.deleted', {
          id: liveId,
          object: 'subscription',
          customer: live.bill.stripe_customer_id,
        }),
      ),
    ).toEqual({ outcome: 'applied', bill: live.bill.id })
  })
})
