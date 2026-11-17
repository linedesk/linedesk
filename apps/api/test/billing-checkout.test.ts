// Trial Checkout on Linedesk Cloud (src/billing-checkout.ts, docs/billing.md §3.2, §2.2, §2.4; billing PR 8): the
// owner starts Checkout with the card-only configuration and never `payment_method_types`, or nothing starts (I2);
// only a confirmed Checkout takes a bill out of pending_payment, with the card checks on every confirmation (M1); a
// session that is not the caller's is a 404; a card that had a trial, or a prepaid one, gets no trial and its
// subscription is canceled at once; the plan without a trial, Radar's review hold, numbers on a billed workspace,
// cancel and resume, Buy minutes, and the webhook paths (the same confirmation, the trial's end email, the first
// recharge on the conversion invoice). Stripe is a fake behind the real provider. Instance-wide (Stripe keys, the
// billing switch): its own database.
import {
  billing_accounts,
  billing_alerts,
  CARD_FINGERPRINT_RETENTION_MONTHS,
  billing_balances,
  billing_periods,
  billing_recharges,
  card_fingerprints,
  commands,
  instance_settings,
  ledger_entries,
  member,
  organization,
  partner_members,
  partners,
  phone_numbers,
  session,
  stripe_events,
  usage_counters,
  user,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { BILLING_CATALOG_KEY } from '../src/billing-catalog.ts'
import {
  billingNumberRefusal,
  CHECKOUT_STARTS_PER_MINUTE,
  CHECKOUT_TOO_OFTEN,
  CHECKOUT_UNAVAILABLE,
  NUMBER_HELD_FOR_REVIEW,
  NUMBER_NEEDS_CHECKOUT,
  plainName,
  resetCheckoutLimit,
  TRIAL_NUMBER_LIMIT,
} from '../src/billing-checkout.ts'
import { sendBillingAlert } from '../src/billing-recharge.ts'
import { setBillingFetch } from '../src/billing-settings.ts'
import { db } from '../src/db.ts'
import { sayIn } from '../src/handler-context.ts'
import { emailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { checkLedgerGuards } from '../src/ledger-guards.ts'
import { processStripeEventJob } from '../src/stripe-events.ts'
import { act, addMember, type Caller, createWorkspace, request, type User } from './helpers.ts'
// After the app (helpers.ts loads it): the sweep's module reaches the handler registry.
const { sweepSignUps } = await import('../src/signup-handlers.ts')

const madeUp = (...parts: string[]) => parts.join('_')
const TEST_KEY = madeUp('sk', 'test', '51MadeUpCheckoutKey0123456789')
const SECRET = madeUp('whsec', 'MadeUpCheckoutSecret0123456789')

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const nowSec = () => Math.floor(Date.now() / 1000)
const DAY_S = 86_400

// ---- A fake Stripe API ----

type Json = Record<string, unknown>
const stripe = {
  sessions: new Map<string, Json>(),
  subscriptions: new Map<string, Json>(),
  invoices: new Map<string, Json>(),
  payments: new Map<string, Json[]>(),
  /** The card-only configuration; null: none in the account; a number: the list answers that status. */
  configuration: 'pmc_own' as string | number | null,
  /** The customers deleted (the sign-up sweep, G2). */
  deletedCustomers: [] as string[],
  /** The install's catalog as the app made it in the account (products by id, prices in order). */
  products: new Map<string, Json>(),
  prices: [] as Json[],
  /** false: the key may only read Products and Prices (every write to them is a 403, review of #1040 M-1). */
  catalogWritable: true,
  /** How paying an invoice ends (Buy minutes with the saved card): paid, 3D Secure asked, or declined. */
  payOutcome: 'paid' as 'paid' | '3ds' | 'declined',
  /** Every request: method, path and the form body. */
  requests: [] as { method: string; path: string; body: URLSearchParams; idempotencyKey: string | null }[],
}
const list = (data: unknown[], url: string, hasMore = false) => ({ object: 'list', data, has_more: hasMore, url })
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_t' } })
const notFound = () =>
  reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } })

const fakeStripe: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const method = init?.method ?? 'GET'
  const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
  const headers = new Headers(init?.headers)
  stripe.requests.push({ method, path: url.pathname, body, idempotencyKey: headers.get('idempotency-key') })
  const [, , kind, id, sub] = url.pathname.split('/')
  if (kind === 'account') return reply(200, { id: 'acct_1Brightwater', object: 'account', country: 'US' })
  if (kind === 'payment_method_configurations') {
    if (typeof stripe.configuration === 'number')
      return reply(stripe.configuration, { error: { type: 'invalid_request_error', message: 'not allowed' } })
    const configs = stripe.configuration
      ? [
          {
            id: stripe.configuration,
            object: 'payment_method_configuration',
            name: 'Linedesk Checkout',
            parent: null,
            active: true,
          },
        ]
      : []
    return reply(200, list(configs, url.pathname))
  }
  if (kind === 'customers' && method === 'POST') return reply(200, { id: rid('cus'), object: 'customer' })
  if (kind === 'customers' && id && method === 'DELETE') {
    // Deleting a customer cancels its subscriptions at once (Stripe's documented behaviour).
    for (const s of stripe.subscriptions.values()) if (s.customer === id) s.status = 'canceled'
    stripe.deletedCustomers.push(id)
    return reply(200, { id, object: 'customer', deleted: true })
  }
  if ((kind === 'products' || kind === 'prices') && method === 'POST' && !stripe.catalogWritable)
    return reply(403, {
      error: { type: 'invalid_request_error', code: 'secret_key_required', message: 'restricted key lacks write' },
    })
  if (kind === 'products' && id && method === 'GET')
    return stripe.products.get(id) ? reply(200, stripe.products.get(id)) : notFound()
  if (kind === 'products' && method === 'POST') {
    const productId = id ?? body.get('id')!
    const product = { ...(stripe.products.get(productId) ?? { id: productId, object: 'product', active: true }) }
    if (body.has('name')) product.name = body.get('name')
    stripe.products.set(productId, product)
    return reply(200, product)
  }
  if (kind === 'prices' && method === 'GET') {
    const keys = [...url.searchParams.entries()].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v)
    return reply(
      200,
      list(
        stripe.prices.filter(p => keys.includes(p.lookup_key as string)),
        url.pathname,
      ),
    )
  }
  if (kind === 'prices' && method === 'POST') {
    const lookupKey = body.get('lookup_key')!
    for (const p of stripe.prices) if (p.lookup_key === lookupKey) p.lookup_key = null
    // The first price of a lookup key is `price_<key>`; a later one (a changed amount) names its amount too.
    const first = !stripe.prices.some(p => p.id === `price_${lookupKey}`)
    const price = {
      id: first ? `price_${lookupKey}` : `price_${lookupKey}_${body.get('unit_amount')}`,
      object: 'price',
      active: true,
      lookup_key: lookupKey,
      unit_amount: Number(body.get('unit_amount')),
      currency: body.get('currency'),
      tax_behavior: body.get('tax_behavior'),
      product: body.get('product'),
      recurring: { interval: body.get('recurring[interval]'), interval_count: 1, usage_type: 'licensed' },
      metadata: { linedesk: lookupKey },
    }
    stripe.prices.push(price)
    return reply(200, price)
  }
  if (kind === 'checkout' && id === 'sessions' && !sub && method === 'POST') {
    const session = {
      id: rid('cs_test'),
      object: 'checkout.session',
      url: 'https://checkout.stripe.test/c/pay',
      livemode: false,
      mode: body.get('mode'),
      status: 'open',
      payment_status: 'unpaid',
      customer: body.get('customer'),
      client_reference_id: body.get('client_reference_id'),
      metadata: { linedesk_checkout: body.get('metadata[linedesk_checkout]') },
      subscription: null,
      payment_intent: null,
      amount_subtotal: Number(body.get('line_items[0][price_data][unit_amount]') ?? 0) || null,
      currency: 'usd',
      expires_at: Number(body.get('expires_at')) || nowSec() + DAY_S,
    }
    stripe.sessions.set(session.id, session)
    return reply(200, session)
  }
  if (kind === 'checkout' && id === 'sessions' && !sub && method === 'GET') {
    const customer = url.searchParams.get('customer')
    const status = url.searchParams.get('status')
    const found = [...stripe.sessions.values()].filter(
      s => (!customer || s.customer === customer) && (!status || s.status === status),
    )
    return reply(200, list(found, url.pathname))
  }
  if (kind === 'checkout' && id === 'sessions' && sub && url.pathname.endsWith('/expire') && method === 'POST') {
    const session = stripe.sessions.get(sub)
    if (!session) return notFound()
    if (session.status !== 'open')
      return reply(400, { error: { type: 'invalid_request_error', message: 'Only open sessions can be expired.' } })
    session.status = 'expired'
    return reply(200, session)
  }
  if (kind === 'checkout' && id === 'sessions' && sub)
    return stripe.sessions.has(sub) ? reply(200, stripe.sessions.get(sub)) : notFound()
  if (kind === 'subscriptions' && !id && method === 'GET') {
    const customer = url.searchParams.get('customer')
    const status = url.searchParams.get('status')
    const found = [...stripe.subscriptions.values()].filter(
      s =>
        (!customer || s.customer === customer) &&
        (status === 'all' || (status ? s.status === status : s.status !== 'canceled')),
    )
    return reply(200, list(found, url.pathname))
  }
  if (kind === 'subscriptions' && id) {
    const found = stripe.subscriptions.get(id)
    if (!found) return notFound()
    if (method === 'DELETE') found.status = 'canceled'
    if (method === 'POST' && body.has('cancel_at_period_end'))
      found.cancel_at_period_end = body.get('cancel_at_period_end') === 'true'
    return reply(200, found)
  }
  if (kind === 'customers' && id && method === 'GET')
    return reply(200, {
      id,
      object: 'customer',
      invoice_settings: { default_payment_method: null },
      default_source: null,
    })
  // A recharge invoice (Buy minutes with the saved card): made, given its item, finalized, paid or voided.
  if (kind === 'invoices' && !id && method === 'POST') {
    const invoiceId = rid('in')
    stripe.invoices.set(invoiceId, {
      id: invoiceId,
      object: 'invoice',
      livemode: false,
      customer: body.get('customer'),
      parent: null,
      status: 'draft',
      billing_reason: 'manual',
      currency: 'usd',
      total: 0,
      total_taxes: [],
      amount_paid: 0,
      amount_paid_off_stripe: 0,
      starting_balance: 0,
      description: null,
      metadata: { billing_recharge_id: body.get('metadata[billing_recharge_id]') },
      lines: list([], `/v1/invoices/${invoiceId}/lines`),
      number: 'LD-0002',
      period_start: nowSec(),
      period_end: nowSec(),
    })
    return reply(200, stripe.invoices.get(invoiceId))
  }
  if (kind === 'invoices' && id && sub && method === 'POST') {
    const invoice = stripe.invoices.get(id)
    if (!invoice) return notFound()
    if (sub === 'finalize') invoice.status = 'open'
    if (sub === 'void') invoice.status = 'void'
    if (sub === 'pay') {
      if (stripe.payOutcome === '3ds')
        return reply(402, {
          error: { type: 'card_error', code: 'authentication_required', message: 'Authentication required.' },
        })
      if (stripe.payOutcome === 'declined')
        return reply(402, {
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'insufficient_funds',
            message: 'Declined.',
          },
        })
      Object.assign(invoice, { status: 'paid', amount_paid: invoice.total })
      stripe.payments.set(id, [
        {
          id: rid('inpay'),
          object: 'invoice_payment',
          amount_paid: invoice.total,
          status: 'paid',
          payment: { type: 'payment_intent', payment_intent: rid('pi') },
        },
      ])
    }
    return reply(200, invoice)
  }
  if (kind === 'invoices' && id && method === 'POST' && stripe.invoices.has(id)) {
    const invoice = stripe.invoices.get(id)!
    if (body.has('description')) invoice.description = body.get('description')
    return reply(200, invoice)
  }
  if (kind === 'invoices' && id) return stripe.invoices.has(id) ? reply(200, stripe.invoices.get(id)) : notFound()
  if (kind === 'invoiceitems' && method === 'POST' && !id && body.get('invoice')) {
    const invoice = stripe.invoices.get(body.get('invoice')!)
    const amount = Number(body.get('amount'))
    if (invoice && invoice.status === 'draft')
      Object.assign(invoice, {
        total: amount,
        lines: list(
          [
            {
              id: rid('il'),
              object: 'line_item',
              amount,
              currency: 'usd',
              parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: rid('ii') } },
              metadata: { billing_recharge_id: body.get('metadata[billing_recharge_id]') },
            },
          ],
          `/v1/invoices/${invoice.id}/lines`,
        ),
      })
    return reply(200, { id: rid('ii'), object: 'invoiceitem' })
  }
  if (kind === 'invoiceitems' && method === 'POST') return reply(200, { id: rid('ii'), object: 'invoiceitem' })
  if (kind === 'invoice_payments')
    return reply(200, list(stripe.payments.get(url.searchParams.get('invoice') ?? '') ?? [], url.pathname))
  return notFound()
}

const card = (fingerprint: string, funding = 'credit') => ({
  id: rid('pm'),
  object: 'payment_method',
  card: { fingerprint, funding, country: 'US', brand: 'visa', last4: '4242' },
})

/** A Linedesk plan subscription as Stripe has it after Checkout. */
function subscription(customer: string, over: { status?: string; card?: Json; interval?: 'month' | 'year' } = {}) {
  const id = rid('sub')
  const trialing = (over.status ?? 'trialing') === 'trialing'
  const sub: Json = {
    id,
    object: 'subscription',
    customer,
    status: over.status ?? 'trialing',
    cancel_at_period_end: false,
    trial_end: trialing ? nowSec() + 14 * DAY_S : null,
    default_payment_method: over.card ?? card(rid('fp')),
    latest_invoice: rid('in'),
    items: list(
      [
        {
          id: rid('si'),
          object: 'subscription_item',
          quantity: 1,
          current_period_start: nowSec(),
          current_period_end: nowSec() + (trialing ? 14 : 30) * DAY_S,
          price: {
            id: 'price_ws',
            object: 'price',
            product: 'linedesk_workspace',
            lookup_key: over.interval === 'year' ? 'ws_yearly' : 'ws_monthly',
            recurring: { interval: over.interval ?? 'month' },
          },
        },
      ],
      '/v1/subscription_items',
    ),
  }
  stripe.subscriptions.set(id, sub)
  return sub
}

/** The owner finishes Checkout in Stripe: the session complete with its subscription (and the card on it). */
function complete(sessionId: string, sub: Json) {
  const session = stripe.sessions.get(sessionId)!
  Object.assign(session, { status: 'complete', payment_status: 'no_payment_required', subscription: sub })
  return session
}

// ---- The install and its bills ----

let operator: User
const mails: { to: string; subject: string; html?: string; text?: string }[] = []

/** A sign-up waiting for Checkout: its bill (no Stripe customer yet), its workspace pending_payment, the owner. */
async function pendingSignUp(over: Partial<typeof billing_accounts.$inferInsert> = {}) {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [bill] = await db
    .insert(billing_accounts)
    .values({ id: rid('bill'), kind: 'cloud', owner_user_id: ws.owner.userId, status: 'pending_payment', ...over })
    .returning()
  await db
    .update(organization)
    .set({ billingAccountId: bill!.id, billingState: 'pending_payment' })
    .where(eq(organization.id, ws.id))
  const owner: Caller = { headers: { ...ws.owner.headers, 'x-workspace-id': ws.id } }
  return { ws, bill: bill!, owner }
}
const billRow = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
const workspaceState = async (id: string) =>
  (await db.select().from(organization).where(eq(organization.id, id)))[0]!.billingState
const checkoutsMade = () => stripe.requests.filter(r => r.method === 'POST' && r.path === '/v1/checkout/sessions')

/** Starts Checkout as the owner; answers the session made at the fake Stripe. */
async function startCheckout(owner: Caller) {
  const res = await act(owner, 'billing.startCheckout', {})
  expect(res.status).toBe(200)
  expect(res.body.data.url).toBe('https://checkout.stripe.test/c/pay')
  return checkoutsMade().at(-1)!
}
/** Starts Checkout, completes it in the fake with a trial subscription on `fingerprint`, and confirms it. */
async function trialWith(fingerprint: string, funding = 'credit') {
  const signedUp = await pendingSignUp()
  await startCheckout(signedUp.owner)
  const sessionId = [...stripe.sessions.keys()].at(-1)!
  const customer = (await billRow(signedUp.bill.id)).stripe_customer_id!
  const sub = subscription(customer, { card: card(fingerprint, funding) })
  complete(sessionId, sub)
  const confirmed = await act(signedUp.owner, 'billing.confirmCheckout', { sessionId })
  return { ...signedUp, sessionId, sub, confirmed }
}

/** A stored Stripe event (as the webhook route keeps it), processed like the job does. */
async function processEvent(type: string, object: Json) {
  const id = rid('evt')
  await db.insert(stripe_events).values({
    id,
    type,
    livemode: false,
    created: new Date().toISOString(),
    payload: { id, type, created: nowSec(), livemode: false, data: { object } },
  })
  return processStripeEventJob(id)
}

beforeAll(async () => {
  const home = await createWorkspace('Linedesk Operations')
  operator = home.owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
  setBillingFetch(fakeStripe)
  expect(await checkLedgerGuards(db)).toBe(true)
  const keys = await act(operator, 'provider.setKeys', {
    provider: 'stripe',
    values: { secret_key: TEST_KEY, webhook_secret: SECRET },
  })
  expect(keys.status).toBe(200)
  expect((await act(operator, 'billingEnabled.set', { on: true })).status).toBe(200)
})
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e as (typeof mails)[number]))
  mails.length = 0
  stripe.requests.length = 0
  stripe.configuration = 'pmc_own'
  stripe.catalogWritable = true
  stripe.payOutcome = 'paid'
  resetCheckoutLimit()
})
afterAll(() => setBillingFetch(null))

describe('billing.startCheckout (docs/billing.md §3.2 step 3)', () => {
  test('with Stripe Tax off, Checkout has no automatic tax, no required address and no tax ID', async () => {
    const reason = 'no stripe tax'
    expect((await act(operator, 'billingRules.set', { rules: { automaticTax: false }, reason })).status).toBe(200)
    try {
      const { owner } = await pendingSignUp()
      const params = Object.fromEntries((await startCheckout(owner)).body)
      expect(params).toMatchObject({
        'automatic_tax[enabled]': 'false',
        billing_address_collection: 'auto',
        'tax_id_collection[enabled]': 'false',
      })
    } finally {
      await act(operator, 'billingRules.set', { rules: { automaticTax: null }, reason })
    }
  })

  test('the owner gets a Checkout with the trial, the card-only configuration and never payment_method_types', async () => {
    const { bill, owner } = await pendingSignUp()
    const made = await startCheckout(owner)
    const customer = (await billRow(bill.id)).stripe_customer_id
    expect(customer).toMatch(/^cus_/)
    const params = Object.fromEntries(made.body)
    expect(params).toMatchObject({
      mode: 'subscription',
      customer,
      client_reference_id: bill.id,
      payment_method_configuration: 'pmc_own',
      payment_method_collection: 'always',
      'subscription_data[trial_period_days]': '14',
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
      'line_items[0][price]': 'price_ws_monthly',
      'line_items[0][quantity]': '1',
      // Stripe Tax is on by default (docs/billing.md §5.2): the address is required, a business gives its tax ID.
      'automatic_tax[enabled]': 'true',
      billing_address_collection: 'required',
      'customer_update[address]': 'auto',
      'tax_id_collection[enabled]': 'true',
      'consent_collection[terms_of_service]': 'required',
      success_url: 'http://localhost:5173/billing/return?session_id={CHECKOUT_SESSION_ID}',
    })
    expect([...made.body.keys()].filter(k => k.startsWith('payment_method_types'))).toEqual([])
    expect([...made.body.keys()].filter(k => k.includes('setup_future_usage'))).toEqual([])
    // The customer is made once per bill: the bill id is its idempotency key, and a second start reuses it.
    expect(stripe.requests.find(r => r.path === '/v1/customers')?.idempotencyKey).toBe(`${bill.id}:customer`)
    await startCheckout(owner)
    expect(stripe.requests.filter(r => r.path === '/v1/customers')).toHaveLength(1)
  })

  test('only the bill owner, signed in, and only while the bill waits for Checkout', async () => {
    const { ws, bill, owner } = await pendingSignUp()
    const admin = await addMember(ws.id, 'admin')
    const res = await act({ headers: { ...admin.headers, 'x-workspace-id': ws.id } }, 'billing.startCheckout', {})
    expect(res.status).toBe(403)
    await db.update(billing_accounts).set({ status: 'comped' }).where(eq(billing_accounts.id, bill.id))
    expect((await act(owner, 'billing.startCheckout', {})).status).toBe(409)
    expect(checkoutsMade()).toEqual([])
  })

  test('no card-only configuration, or a key that may not read it: no Checkout, the admins are told (I2)', async () => {
    const { owner } = await pendingSignUp()
    for (const missing of [null, 403] as const) {
      stripe.configuration = missing
      mails.length = 0
      const res = await act(owner, 'billing.startCheckout', {})
      expect(res).toMatchObject({ status: 409, body: { ok: false, error: sayIn(CHECKOUT_UNAVAILABLE) } })
      await vi.waitFor(() => expect(mails.some(m => /Checkout on .* could not start/.test(m.subject))).toBe(true))
    }
    expect(checkoutsMade()).toEqual([])
  })
})

describe('billing.confirmCheckout (docs/billing.md §3.2 step 4; security review M1)', () => {
  test('a new card starts the trial: the bill trialing, Checkout confirmed, the workspace open, its first period', async () => {
    const { ws, bill, sub, sessionId, owner, confirmed } = await trialWith(rid('fp'))
    expect(confirmed).toMatchObject({ status: 200, body: { data: { status: 'trialing', heldForReview: false } } })
    const row = await billRow(bill.id)
    expect(row).toMatchObject({ status: 'trialing', stripe_subscription_id: sub.id, trial_refused: null })
    expect(row.checkout_confirmed_at).not.toBeNull()
    expect(Date.parse(row.trial_ends_at!)).toBe((sub.trial_end as number) * 1000)
    expect(await workspaceState(ws.id)).toBe('active')
    const periods = await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, bill.id))
    expect(periods).toMatchObject([{ kind: 'trial', ends_at: row.trial_ends_at }])
    expect(await db.select().from(usage_counters).where(eq(usage_counters.billing_account_id, bill.id))).toMatchObject([
      { workspace_id: ws.id, period_id: periods[0]!.id },
    ])
    // The return page loaded again: the same answer, nothing runs twice.
    expect((await act(owner, 'billing.confirmCheckout', { sessionId })).body.data).toEqual({
      status: 'trialing',
      heldForReview: false,
    })
    expect(await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, bill.id))).toHaveLength(
      1,
    )
  })

  test("another bill's session, or one Stripe does not know, is a 404 that names nothing", async () => {
    const mine = await trialWith(rid('fp'))
    const other = await pendingSignUp()
    await startCheckout(other.owner)
    const res = await act(other.owner, 'billing.confirmCheckout', { sessionId: mine.sessionId })
    expect(res).toMatchObject({ status: 404, body: { ok: false, code: 'not_found' } })
    const unknown = await act(other.owner, 'billing.confirmCheckout', { sessionId: 'cs_test_unknown' })
    expect(unknown).toMatchObject({ status: 404, body: { code: 'not_found' } })
    expect((await billRow(other.bill.id)).status).toBe('pending_payment')
  })

  test('a card that had a trial gets none: its subscription canceled at once, the bill keeps waiting', async () => {
    const fingerprint = rid('fp')
    await trialWith(fingerprint)
    stripe.requests.length = 0
    const again = await trialWith(fingerprint)
    expect(again.confirmed.body.data).toEqual({ status: 'trial_refused', reason: 'card_used' })
    const cancel = stripe.requests.find(r => r.method === 'DELETE' && r.path === `/v1/subscriptions/${again.sub.id}`)
    expect(cancel).toBeDefined()
    expect(stripe.subscriptions.get(again.sub.id as string)!.status).toBe('canceled')
    // Not active, the subscription let go of, nothing confirmed (M1): a later invoice.paid cannot activate it.
    const row = await billRow(again.bill.id)
    expect(row).toMatchObject({
      status: 'pending_payment',
      trial_refused: 'card_used',
      stripe_subscription_id: null,
      checkout_confirmed_at: null,
    })
    expect(await workspaceState(again.ws.id)).toBe('pending_payment')
    // The next Checkout is the plan without a trial.
    const plan = await startCheckout(again.owner)
    expect(plan.body.get('subscription_data[trial_period_days]')).toBeNull()
    expect(plan.body.get('payment_method_configuration')).toBe('pmc_own')
  })

  test('a prepaid card gets no trial either', async () => {
    const prepaid = await trialWith(rid('fp'), 'prepaid')
    expect(prepaid.confirmed.body.data).toEqual({ status: 'trial_refused', reason: 'prepaid' })
    expect(await billRow(prepaid.bill.id)).toMatchObject({ status: 'pending_payment', trial_refused: 'prepaid' })
    expect(stripe.subscriptions.get(prepaid.sub.id as string)!.status).toBe('canceled')
    // A prepaid card is never stored as having had a trial.
    const fp = ((prepaid.sub.default_payment_method as Json).card as Json).fingerprint as string
    expect(await db.select().from(card_fingerprints).where(eq(card_fingerprints.fingerprint, fp))).toEqual([])
  })

  test('the plan paid without a trial: active at once; an elevated Radar risk holds numbers for review', async () => {
    const fingerprint = rid('fp')
    await trialWith(fingerprint)
    const refused = await trialWith(fingerprint)
    await startCheckout(refused.owner)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const sub = subscription(refused.bill.id && (await billRow(refused.bill.id)).stripe_customer_id!, {
      status: 'active',
      card: card(fingerprint),
    })
    stripe.payments.set(sub.latest_invoice as string, [
      {
        id: rid('inpay'),
        object: 'invoice_payment',
        status: 'paid',
        amount_paid: 1100,
        payment: {
          type: 'payment_intent',
          payment_intent: {
            id: rid('pi'),
            object: 'payment_intent',
            status: 'succeeded',
            payment_method: card(fingerprint),
            latest_charge: { id: rid('ch'), object: 'charge', paid: true, outcome: { risk_level: 'elevated' } },
          },
        },
      },
    ])
    complete(sessionId, sub)
    const res = await act(refused.owner, 'billing.confirmCheckout', { sessionId })
    expect(res.body.data).toEqual({ status: 'active', heldForReview: true })
    const row = await billRow(refused.bill.id)
    expect(row).toMatchObject({ status: 'active', stripe_subscription_id: sub.id, card_risk_level: 'elevated' })
    expect(row.held_for_review_at).not.toBeNull()
    expect(await workspaceState(refused.ws.id)).toBe('active')
    expect(
      await db.transaction(tx =>
        billingNumberRefusal(tx, { actorId: refused.ws.owner.userId, permissions: [] } as never, refused.ws.id),
      ),
    ).toBe(NUMBER_HELD_FOR_REVIEW)
  })
})

describe('the webhook confirms like the return page (checkout.session.completed)', () => {
  test('an owner who closed the tab: the trial starts from the event, with the same card checks', async () => {
    const fingerprint = rid('fp')
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const customer = (await billRow(bill.id)).stripe_customer_id!
    complete(sessionId, subscription(customer, { card: card(fingerprint) }))
    const done = await processEvent('checkout.session.completed', {
      id: sessionId,
      object: 'checkout.session',
      customer,
    })
    expect(done).toMatchObject({ outcome: 'applied', bill: bill.id, detail: 'trialing' })
    expect((await billRow(bill.id)).status).toBe('trialing')

    // The same card on another sign-up, confirmed only by the webhook: refused there too.
    const other = await pendingSignUp()
    await startCheckout(other.owner)
    const otherSession = [...stripe.sessions.keys()].at(-1)!
    const otherCustomer = (await billRow(other.bill.id)).stripe_customer_id!
    const otherSub = complete(otherSession, subscription(otherCustomer, { card: card(fingerprint) }))
      .subscription as Json
    const refused = await processEvent('checkout.session.completed', {
      id: otherSession,
      object: 'checkout.session',
      customer: otherCustomer,
    })
    expect(refused).toMatchObject({ outcome: 'applied', detail: 'trial_refused' })
    expect(await billRow(other.bill.id)).toMatchObject({ status: 'pending_payment', trial_refused: 'card_used' })
    expect(stripe.subscriptions.get(otherSub.id as string)!.status).toBe('canceled')
  })

  test("a session naming another bill than its customer's changes nothing", async () => {
    const a = await pendingSignUp()
    const b = await pendingSignUp()
    await startCheckout(a.owner)
    await startCheckout(b.owner)
    const [sessionA] = [...stripe.sessions.entries()].filter(([, s]) => s.client_reference_id === a.bill.id).at(-1)!
    const customerB = (await billRow(b.bill.id)).stripe_customer_id!
    complete(sessionA, subscription((await billRow(a.bill.id)).stripe_customer_id!))
    const done = await processEvent('checkout.session.completed', {
      id: sessionA,
      object: 'checkout.session',
      customer: customerB,
    })
    expect(done).toMatchObject({ outcome: 'applied', bill: b.bill.id, detail: 'not_complete_or_other' })
    expect((await billRow(a.bill.id)).status).toBe('pending_payment')
    expect((await billRow(b.bill.id)).status).toBe('pending_payment')
  })
})

describe('numbers on a billed workspace (docs/billing.md §3.2 step 6)', () => {
  const ownerOf = (userId: string) => ({ actorId: userId, permissions: [] }) as never

  test('none before Checkout, one in the trial, none while held', async () => {
    const pending = await pendingSignUp()
    const refusal = (userId: string, ws: string) => db.transaction(tx => billingNumberRefusal(tx, ownerOf(userId), ws))
    expect(await refusal(pending.ws.owner.userId, pending.ws.id)).toBe(NUMBER_NEEDS_CHECKOUT)
    // A bill set to trialing by anything but the confirmation (no checkout_confirmed_at) still gets no number.
    await db.update(billing_accounts).set({ status: 'trialing' }).where(eq(billing_accounts.id, pending.bill.id))
    expect(await refusal(pending.ws.owner.userId, pending.ws.id)).toBe(NUMBER_NEEDS_CHECKOUT)

    const { ws } = await trialWith(rid('fp'))
    expect(await refusal(ws.owner.userId, ws.id)).toBeNull()
    await db
      .update(phone_numbers)
      .set({ purchased: true, carrier_account: 'install' })
      .where(eq(phone_numbers.workspace_id, ws.id))
    expect(await refusal(ws.owner.userId, ws.id)).toBe(TRIAL_NUMBER_LIMIT)
    // An instance admin provisions by hand.
    expect(
      await db.transaction(tx =>
        billingNumberRefusal(tx, { actorId: operator.userId, permissions: ['instance:admin'] } as never, ws.id),
      ),
    ).toBeNull()
  })

  test('phoneNumber.setup refuses a purchase before Checkout is confirmed', async () => {
    const { ws, bill, owner } = await pendingSignUp()
    await db.update(billing_accounts).set({ status: 'trialing' }).where(eq(billing_accounts.id, bill.id))
    await db.update(organization).set({ billingState: 'active' }).where(eq(organization.id, ws.id))
    const res = await act(owner, 'phoneNumber.setup', { areaCode: '503', purchase: true })
    expect(res).toMatchObject({ status: 409, body: { ok: false, error: sayIn(NUMBER_NEEDS_CHECKOUT) } })
  })
})

describe('billing.cancel and billing.resume (docs/billing.md §3.2 step 10)', () => {
  test('cancel at the end of the trial, then resume; the bill mirrors Stripe', async () => {
    const { bill, sub, owner } = await trialWith(rid('fp'))
    const cancel = await act(owner, 'billing.cancel', {})
    expect(cancel.body.data).toMatchObject({ cancelAtPeriodEnd: true })
    const update = stripe.requests.find(r => r.method === 'POST' && r.path === `/v1/subscriptions/${sub.id}`)
    expect(update?.body.get('cancel_at_period_end')).toBe('true')
    expect((await billRow(bill.id)).cancel_at_period_end).toBe(true)
    expect((await act(owner, 'billing.resume', {})).body.data).toMatchObject({ cancelAtPeriodEnd: false })
    expect((await billRow(bill.id)).cancel_at_period_end).toBe(false)
    // Still trialing: cancelling ends nothing before the trial's end.
    expect((await billRow(bill.id)).status).toBe('trialing')
  })

  test('a bill without a running plan cannot cancel', async () => {
    const { owner } = await pendingSignUp()
    expect((await act(owner, 'billing.cancel', {})).status).toBe(409)
  })

  test('a suspended plan can be canceled in the app, the one place to cancel (security review of #1007, L-5)', async () => {
    const { bill, sub, owner } = await trialWith(rid('fp'))
    await db
      .update(billing_accounts)
      .set({ status: 'suspended', suspend_reason: 'payment' })
      .where(eq(billing_accounts.id, bill.id))
    expect((await act(owner, 'billing.cancel', {})).body.data).toMatchObject({ cancelAtPeriodEnd: true })
    const update = stripe.requests.find(r => r.method === 'POST' && r.path === `/v1/subscriptions/${sub.id}`)
    expect(update?.body.get('cancel_at_period_end')).toBe('true')
    expect(await billRow(bill.id)).toMatchObject({ status: 'suspended', cancel_at_period_end: true })
    // Canceled for good: nothing to cancel any more.
    await db.update(billing_accounts).set({ status: 'canceled' }).where(eq(billing_accounts.id, bill.id))
    expect((await act(owner, 'billing.cancel', {})).status).toBe(409)
  })
})

describe('billing.startTopUp (docs/billing.md §2.2)', () => {
  test('Buy minutes: a payment Checkout of our product and amount, credited once with the pre-tax amount', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    expect((await act(owner, 'billing.startTopUp', { amountCents: 499 })).status).toBe(422)
    const res = await act(owner, 'billing.startTopUp', { amountCents: 2500 })
    expect(res.status).toBe(200)
    const made = checkoutsMade().at(-1)!
    expect(Object.fromEntries(made.body)).toMatchObject({
      mode: 'payment',
      payment_method_configuration: 'pmc_own',
      'line_items[0][price_data][product]': 'linedesk_balance_topup',
      'line_items[0][price_data][unit_amount]': '2500',
      'line_items[0][price_data][tax_behavior]': 'exclusive',
    })
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    Object.assign(stripe.sessions.get(sessionId)!, {
      status: 'complete',
      payment_status: 'paid',
      amount_subtotal: 2500,
      payment_intent: {
        id: rid('pi'),
        object: 'payment_intent',
        status: 'succeeded',
        payment_method: card(rid('fp')),
        latest_charge: { id: rid('ch'), object: 'charge', paid: true, outcome: { risk_level: 'normal' } },
      },
    })
    expect((await act(owner, 'billing.confirmCheckout', { sessionId })).body.data).toEqual({
      status: 'topup',
      credited: true,
      amountCents: 2500,
    })
    expect((await act(owner, 'billing.confirmCheckout', { sessionId })).body.data).toMatchObject({ credited: false })
    const entries = await db
      .select()
      .from(ledger_entries)
      .where(and(eq(ledger_entries.billing_account_id, bill.id), eq(ledger_entries.kind, 'topup')))
    expect(entries).toMatchObject([{ amount_micros: 25_000_000, source_type: 'stripe_checkout', source_id: sessionId }])
    const [balance] = await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, bill.id))
    expect(balance!.balance_micros).toBe(25_000_000)
  })

  test('not before the plan has started', async () => {
    const { owner } = await pendingSignUp()
    expect((await act(owner, 'billing.startTopUp', { amountCents: 2500 })).status).toBe(409)
  })
})

describe('Buy minutes with the saved card (docs/billing.md §2.2; billing tour G1, security review of #1102)', () => {
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
  const attempts = (billId: string) =>
    db.select().from(billing_recharges).where(eq(billing_recharges.billing_account_id, billId))
  const pays = () => stripe.requests.filter(r => r.method === 'POST' && r.path.endsWith('/pay'))
  /** The first press: which card would be charged; nothing is charged yet. */
  async function shownCard(owner: Caller, amountCents: number) {
    const res = await act(owner, 'billing.startTopUp', { amountCents, savedCard: true })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ kind: 'confirm', card: { brand: 'visa', last4: '4242' } })
    return res.body.data.card.id as string
  }

  test('first the card (brand, last four), nothing charged; confirmed: charged on-session, credited at once, once', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    const confirmCard = await shownCard(owner, 1000)
    expect(pays()).toEqual([])
    expect(await attempts(bill.id)).toEqual([])
    const res = await act(owner, 'billing.startTopUp', { amountCents: 1000, savedCard: true, confirmCard })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ kind: 'paid', amountCents: 1000, credited: true })
    expect(checkoutsMade()).toHaveLength(1) // the trial's Checkout only
    expect(Object.fromEntries(pays()[0]!.body)).toEqual({ off_session: 'false' })
    // A manual attempt below the auto-recharge minimum, paid, and its credit a `recharge` entry of the attempt.
    const [attempt] = await attempts(bill.id)
    expect(attempt).toMatchObject({ manual: true, amount_cents: 1000, status: 'paid' })
    const entries = await db
      .select()
      .from(ledger_entries)
      .where(and(eq(ledger_entries.billing_account_id, bill.id), eq(ledger_entries.kind, 'recharge')))
    expect(entries).toMatchObject([
      { amount_micros: 10_000_000, source_type: 'billing_recharge', source_id: attempt!.id },
    ])
    // invoice.paid later credits nothing again.
    await processEvent('invoice.paid', {
      id: attempt!.stripe_invoice_id!,
      object: 'invoice',
      customer: bill.stripe_customer_id,
    })
    const [balance] = await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, bill.id))
    expect(balance!.balance_micros).toBe(10_000_000)
  })

  test('a card changed since it was shown is shown again, not charged', async () => {
    const { owner } = await trialWith(rid('fp'))
    await shownCard(owner, 1000)
    const res = await act(owner, 'billing.startTopUp', { amountCents: 1000, savedCard: true, confirmCard: 'pm_other' })
    expect(res.body.data).toMatchObject({ kind: 'confirm' })
    expect(pays()).toEqual([])
  })

  test('the owner proves it is them first: a sign-in older than 10 minutes is refused before anything is charged (M-1)', async () => {
    const { bill, ws, owner } = await trialWith(rid('fp'))
    const confirmCard = await shownCard(owner, 1000)
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(session.userId, ws.owner.userId))
    const res = await act(owner, 'billing.startTopUp', { amountCents: 1000, savedCard: true, confirmCard })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'SIGN_IN_AGAIN' })
    expect(pays()).toEqual([])
    expect(await attempts(bill.id)).toEqual([])
  })

  test('at most $500 in 24 hours on the saved card; beyond it, Checkout (M-1)', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    const confirmCard = await shownCard(owner, 40_000)
    expect(
      (await act(owner, 'billing.startTopUp', { amountCents: 40_000, savedCard: true, confirmCard })).body.data,
    ).toMatchObject({ kind: 'paid' })
    const over = await act(owner, 'billing.startTopUp', { amountCents: 20_000, savedCard: true, confirmCard })
    expect(over.body.data).toEqual({
      kind: 'checkout',
      url: 'https://checkout.stripe.test/c/pay',
      fallback: 'daily_limit',
    })
    expect(pays()).toHaveLength(1)
    // A day later the card may be charged again.
    await db
      .update(billing_recharges)
      .set({ created_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .where(eq(billing_recharges.billing_account_id, bill.id))
    expect(
      (await act(owner, 'billing.startTopUp', { amountCents: 20_000, savedCard: true, confirmCard })).body.data,
    ).toMatchObject({ kind: 'paid' })
  })

  test('the same command sent again after its answer was lost finds its purchase: never charged twice (L-1)', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    const confirmCard = await shownCard(owner, 2500)
    const key = crypto.randomUUID()
    const input = { amountCents: 2500, savedCard: true, confirmCard }
    expect((await act(owner, 'billing.startTopUp', input, key)).body.data).toMatchObject({ kind: 'paid' })
    // As if the handler's transaction had not committed: the command is not stored, so the retry runs again.
    await db.delete(commands).where(eq(commands.id, key))
    const again = await act(owner, 'billing.startTopUp', input, key)
    expect(again.body.data).toEqual({ kind: 'paid', amountCents: 2500, credited: true })
    expect(pays()).toHaveLength(1)
    expect(await attempts(bill.id)).toHaveLength(1)
    const [balance] = await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, bill.id))
    expect(balance!.balance_micros).toBe(25_000_000)
  })

  test('3D Secure asked or a decline: the invoice voided, no wait and no email; the owner goes on in Checkout', async () => {
    for (const outcome of ['3ds', 'declined'] as const) {
      const { bill, owner } = await trialWith(rid('fp'))
      const confirmCard = await shownCard(owner, 2500)
      stripe.payOutcome = outcome
      mails.length = 0
      const res = await act(owner, 'billing.startTopUp', { amountCents: 2500, savedCard: true, confirmCard })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({
        kind: 'checkout',
        url: 'https://checkout.stripe.test/c/pay',
        fallback: outcome === '3ds' ? 'authentication_required' : 'declined',
      })
      const [attempt] = await attempts(bill.id)
      expect(attempt).toMatchObject({ manual: true, status: 'canceled' })
      expect(stripe.invoices.get(attempt!.stripe_invoice_id!)!.status).toBe('void')
      expect(await billRow(bill.id)).toMatchObject({ recharge_failed_at: null })
      expect(mails).toEqual([])
    }
  })

  test('no saved card: Checkout at once; without savedCard: Checkout as before', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    stripe.subscriptions.get((await billRow(bill.id)).stripe_subscription_id!)!.default_payment_method = null
    const res = await act(owner, 'billing.startTopUp', { amountCents: 2500, savedCard: true })
    expect(res.body.data).toEqual({ kind: 'checkout', url: 'https://checkout.stripe.test/c/pay', fallback: 'no_card' })
    expect(await attempts(bill.id)).toEqual([])
    const other = await act(owner, 'billing.startTopUp', { amountCents: 2500 })
    expect(other.body.data).toEqual({ kind: 'checkout', url: 'https://checkout.stripe.test/c/pay' })
  })

  test('the install name on Stripe pages is plain text: no Markdown links or emphasis (L-4)', () => {
    expect(plainName('[Free money](https://evil.test) **now**\nDesk')).toBe('Free money https://evil.test now Desk')
    expect(plainName('Brightwater Plumbing & Heating')).toBe('Brightwater Plumbing & Heating')
  })

  test('one payment at a time: a pending payment refuses the saved card and Checkout alike (L-2)', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    const confirmCard = await shownCard(owner, 2500)
    await db
      .insert(billing_recharges)
      .values({ id: rid('rc'), billing_account_id: bill.id, amount_cents: 2000, created_at: new Date().toISOString() })
    expect((await act(owner, 'billing.startTopUp', { amountCents: 2500, savedCard: true, confirmCard })).status).toBe(
      409,
    )
    expect((await act(owner, 'billing.startTopUp', { amountCents: 2500 })).status).toBe(409)
    expect(checkoutsMade()).toHaveLength(1) // the trial's Checkout only
  })
})

describe('security review of #961', () => {
  /** A paid top-up session of the bill as Stripe has it after the payment. */
  async function paidTopUp(owner: Caller, cents: number) {
    expect((await act(owner, 'billing.startTopUp', { amountCents: cents })).status).toBe(200)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    Object.assign(stripe.sessions.get(sessionId)!, {
      status: 'complete',
      payment_status: 'paid',
      amount_subtotal: cents,
      payment_intent: {
        id: rid('pi'),
        object: 'payment_intent',
        status: 'succeeded',
        payment_method: card(rid('fp')),
        latest_charge: { id: rid('ch'), object: 'charge', paid: true, outcome: { risk_level: 'normal' } },
      },
    })
    return sessionId
  }

  test('G1: a new Checkout expires the open one; every session expires within the hour', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const first = [...stripe.sessions.keys()].at(-1)!
    const made = await startCheckout(owner)
    const second = [...stripe.sessions.keys()].at(-1)!
    expect(second).not.toBe(first)
    expect(stripe.sessions.get(first)!.status).toBe('expired')
    expect(stripe.sessions.get(second)!.status).toBe('open')
    expect(stripe.requests.some(r => r.method === 'POST' && r.path === `/v1/checkout/sessions/${first}/expire`)).toBe(
      true,
    )
    const expiresAt = Number(made.body.get('expires_at'))
    expect(expiresAt).toBeGreaterThan(nowSec() + 30 * 60)
    expect(expiresAt).toBeLessThanOrEqual(nowSec() + 61 * 60)
    expect((await billRow(bill.id)).status).toBe('pending_payment')
  })

  test('G1: a second completed session, confirmed after the first, has its subscription canceled (return page)', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const first = [...stripe.sessions.keys()].at(-1)!
    await startCheckout(owner)
    const second = [...stripe.sessions.keys()].at(-1)!
    const customer = (await billRow(bill.id)).stripe_customer_id!
    // Both finished in Stripe (the first one before its expiry landed).
    const sub1 = subscription(customer)
    const sub2 = subscription(customer)
    complete(first, sub1)
    complete(second, sub2)
    expect((await act(owner, 'billing.confirmCheckout', { sessionId: first })).body.data).toMatchObject({
      status: 'trialing',
    })
    expect((await act(owner, 'billing.confirmCheckout', { sessionId: second })).body.data).toMatchObject({
      status: 'trialing',
    })
    expect(stripe.subscriptions.get(sub2.id as string)!.status).toBe('canceled')
    expect(stripe.subscriptions.get(sub1.id as string)!.status).toBe('trialing')
    expect((await billRow(bill.id)).stripe_subscription_id).toBe(sub1.id)
  })

  test('G1: the same through the webhook; a paid extra plan is canceled and the admins are told to refund', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const first = [...stripe.sessions.keys()].at(-1)!
    await startCheckout(owner)
    const second = [...stripe.sessions.keys()].at(-1)!
    const customer = (await billRow(bill.id)).stripe_customer_id!
    const sub1 = subscription(customer)
    const paid = subscription(customer, { status: 'active' })
    complete(first, sub1)
    complete(second, paid)
    const object = (id: string) => ({ id, object: 'checkout.session', customer })
    expect(await processEvent('checkout.session.completed', object(first))).toMatchObject({ detail: 'trialing' })
    expect(await processEvent('checkout.session.completed', object(second))).toMatchObject({ detail: 'trialing' })
    expect(stripe.subscriptions.get(paid.id as string)!.status).toBe('canceled')
    expect(stripe.subscriptions.get(sub1.id as string)!.status).toBe('trialing')
    await vi.waitFor(() =>
      expect(
        mails.some(m => /extra Checkout/i.test(m.subject) && (m.text ?? m.html ?? '').includes(paid.id as string)),
      ).toBe(true),
    )
  })

  test('G5: a refusal after Stripe made a subscription cancels it and tells the admins', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const customer = (await billRow(bill.id)).stripe_customer_id!
    // Linked since by someone else's path: this session's subscription is another one.
    await db
      .update(billing_accounts)
      .set({ stripe_subscription_id: rid('sub') })
      .where(eq(billing_accounts.id, bill.id))
    const sub = subscription(customer)
    complete(sessionId, sub)
    const done = await processEvent('checkout.session.completed', {
      id: sessionId,
      object: 'checkout.session',
      customer,
    })
    expect(done).toMatchObject({ outcome: 'applied', detail: expect.stringMatching(/^refused: /) })
    expect(stripe.subscriptions.get(sub.id as string)!.status).toBe('canceled')
    await vi.waitFor(() => expect(mails.some(m => /Checkout .* refused/i.test(m.subject))).toBe(true))
  })

  test('G3: a top-up after the trial period ended (no current period) is credited in the latest period', async () => {
    const { bill, owner } = await trialWith(rid('fp'))
    // The trial ended and converted; the next period is PR 10's: none contains now.
    const past = new Date(Date.now() - 2 * DAY_S * 1000).toISOString()
    await db
      .update(billing_periods)
      .set({ starts_at: new Date(Date.now() - 16 * DAY_S * 1000).toISOString(), ends_at: past })
      .where(eq(billing_periods.billing_account_id, bill.id))
    await db.update(billing_accounts).set({ status: 'active' }).where(eq(billing_accounts.id, bill.id))
    const sessionId = await paidTopUp(owner, 2000)
    expect((await act(owner, 'billing.confirmCheckout', { sessionId })).body.data).toEqual({
      status: 'topup',
      credited: true,
      amountCents: 2000,
    })
    const [period] = await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, bill.id))
    const entries = await db
      .select()
      .from(ledger_entries)
      .where(and(eq(ledger_entries.billing_account_id, bill.id), eq(ledger_entries.kind, 'topup')))
    expect(entries).toMatchObject([{ amount_micros: 20_000_000, period_id: period!.id, source_id: sessionId }])
  })

  test('G2: the sweep expires the open Checkout and deletes the Stripe customer before it deletes the bill', async () => {
    const { bill, owner, ws } = await pendingSignUp()
    await startCheckout(owner)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const customer = (await billRow(bill.id)).stripe_customer_id!
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 8 * DAY_S * 1000).toISOString() })
      .where(eq(billing_accounts.id, bill.id))
    await sweepSignUps(db)
    expect(stripe.sessions.get(sessionId)!.status).toBe('expired')
    expect(stripe.deletedCustomers).toContain(customer)
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toEqual([])
    expect(await db.select().from(organization).where(eq(organization.id, ws.id))).toEqual([])
  })

  test('G2: when Stripe cannot be asked, the bill is kept for the next run', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    await db
      .update(billing_accounts)
      .set({ created_at: new Date(Date.now() - 8 * DAY_S * 1000).toISOString() })
      .where(eq(billing_accounts.id, bill.id))
    setBillingFetch((async () => reply(500, { error: { type: 'api_error', message: 'down' } })) as typeof fetch)
    try {
      await sweepSignUps(db)
    } finally {
      setBillingFetch(fakeStripe)
    }
    expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toHaveLength(1)
  })

  describe('V-1: Stripe is asked before a waiting bill is deleted (security verification of #961)', () => {
    /** The jobs queued in a transaction (a fake queue: nothing runs). */
    let queued: { name: string; data: Record<string, unknown> }[] = []
    beforeEach(() => {
      queued = []
      setJobQueue({
        send: async (name: string, data: Record<string, unknown>) => {
          queued.push({ name, data })
          return 'job'
        },
        insert: async () => [],
      } as never)
    })
    afterEach(() => setJobQueue(null))
    const keptAlerts = (bill: string) =>
      queued.filter(j => j.name === 'billing.alert' && j.data.kind === 'signup_kept' && j.data.bill === bill)
    const age = (billId: string) =>
      db
        .update(billing_accounts)
        .set({ created_at: new Date(Date.now() - 8 * DAY_S * 1000).toISOString() })
        .where(eq(billing_accounts.id, billId))

    test('the plan paid in Stripe, its webhook not applied yet: kept, nothing canceled, the admins told', async () => {
      const fingerprint = rid('fp')
      await trialWith(fingerprint)
      // The card had a trial: this sign-up's trial is refused, so its owner pays the plan at once.
      const refused = await trialWith(fingerprint)
      expect(await billRow(refused.bill.id)).toMatchObject({ status: 'pending_payment', trial_refused: 'card_used' })
      await startCheckout(refused.owner)
      const sessionId = [...stripe.sessions.keys()].at(-1)!
      const customer = (await billRow(refused.bill.id)).stripe_customer_id!
      const sub = subscription(customer, { status: 'active', card: card(fingerprint) })
      stripe.payments.set(sub.latest_invoice as string, [
        {
          id: rid('inpay'),
          object: 'invoice_payment',
          status: 'paid',
          amount_paid: 1100,
          payment: {
            type: 'payment_intent',
            payment_intent: {
              id: rid('pi'),
              object: 'payment_intent',
              status: 'succeeded',
              payment_method: card(fingerprint),
              latest_charge: { id: rid('ch'), object: 'charge', paid: true, outcome: { risk_level: 'normal' } },
            },
          },
        },
      ])
      // Paid in Stripe; the owner closed the tab and the webhook is late: our database still shows nothing.
      complete(sessionId, sub)
      await age(refused.bill.id)
      await sweepSignUps(db)

      expect(stripe.deletedCustomers).not.toContain(customer)
      expect(stripe.subscriptions.get(sub.id as string)!.status).toBe('active')
      expect(await billRow(refused.bill.id)).toMatchObject({ status: 'pending_payment' })
      expect(await db.select().from(organization).where(eq(organization.id, refused.ws.id))).toHaveLength(1)
      expect(await db.select().from(user).where(eq(user.id, refused.ws.owner.userId))).toHaveLength(1)
      expect(keptAlerts(refused.bill.id).map(a => a.data)).toEqual([
        {
          kind: 'signup_kept',
          bill: refused.bill.id,
          subscription: sub.id,
          reason: 'in_stripe',
          customer,
          session: null,
        },
      ])

      // The late webhook still finds the bill and applies the Checkout.
      const done = await processEvent('checkout.session.completed', {
        id: sessionId,
        object: 'checkout.session',
        customer,
      })
      expect(done).toMatchObject({ outcome: 'applied', bill: refused.bill.id })
      expect(await billRow(refused.bill.id)).toMatchObject({ status: 'active', stripe_subscription_id: sub.id })
    })

    test('a trial started in Stripe, its webhook not applied yet: kept', async () => {
      const { bill, owner, ws } = await pendingSignUp()
      await startCheckout(owner)
      const sessionId = [...stripe.sessions.keys()].at(-1)!
      const customer = (await billRow(bill.id)).stripe_customer_id!
      const sub = complete(sessionId, subscription(customer)).subscription as Json
      await age(bill.id)
      await sweepSignUps(db)
      expect(stripe.deletedCustomers).not.toContain(customer)
      expect(stripe.subscriptions.get(sub.id as string)!.status).toBe('trialing')
      expect(await db.select().from(organization).where(eq(organization.id, ws.id))).toHaveLength(1)
      expect(keptAlerts(bill.id)).toMatchObject([
        { data: { subscription: sub.id, reason: 'in_stripe', customer, session: null } },
      ])
    })

    test('a refused trial left alone (its Checkout complete, its subscription canceled) is still swept', async () => {
      const fingerprint = rid('fp')
      await trialWith(fingerprint)
      const refused = await trialWith(fingerprint)
      expect(stripe.subscriptions.get(refused.sub.id as string)!.status).toBe('canceled')
      expect(stripe.sessions.get(refused.sessionId)!.status).toBe('complete')
      const customer = (await billRow(refused.bill.id)).stripe_customer_id!
      await age(refused.bill.id)
      await sweepSignUps(db)
      expect(stripe.deletedCustomers).toContain(customer)
      expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, refused.bill.id))).toEqual([])
      expect(keptAlerts(refused.bill.id)).toEqual([])
    })

    test('a completed payment Checkout keeps the bill whatever its subscriptions', async () => {
      const { bill, owner } = await pendingSignUp()
      await startCheckout(owner)
      const sessionId = [...stripe.sessions.keys()].at(-1)!
      const customer = (await billRow(bill.id)).stripe_customer_id!
      Object.assign(stripe.sessions.get(sessionId)!, { status: 'complete', mode: 'payment', payment_status: 'paid' })
      await age(bill.id)
      await sweepSignUps(db)
      expect(stripe.deletedCustomers).not.toContain(customer)
      expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toHaveLength(1)
      expect(keptAlerts(bill.id)).toMatchObject([
        { data: { subscription: null, reason: 'in_stripe', customer, session: sessionId } },
      ])
    })

    test('when Stripe cannot say what the customer bought: nothing deleted this run, the admins told', async () => {
      const { bill, owner, ws } = await pendingSignUp()
      await startCheckout(owner)
      const customer = (await billRow(bill.id)).stripe_customer_id!
      await age(bill.id)
      // Only the subscription list fails: the open session is expired, the customer never deleted.
      setBillingFetch((async (input, init) =>
        new URL(String(input)).pathname === '/v1/subscriptions'
          ? reply(500, { error: { type: 'api_error', message: 'down' } })
          : fakeStripe(input, init)) as typeof fetch)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await sweepSignUps(db)
      } finally {
        setBillingFetch(fakeStripe)
      }
      expect(error.mock.calls.some(c => String(c[0]).includes(bill.id))).toBe(true)
      expect(stripe.requests.some(r => r.method === 'DELETE')).toBe(false)
      expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toHaveLength(1)
      expect(await db.select().from(organization).where(eq(organization.id, ws.id))).toHaveLength(1)
      expect(keptAlerts(bill.id).map(a => a.data)).toEqual([
        { kind: 'signup_kept', bill: bill.id, subscription: null, reason: 'stripe_error', customer },
      ])

      // Stripe answers again: the next run deletes it.
      await sweepSignUps(db)
      expect(stripe.deletedCustomers).toContain(customer)
      expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toEqual([])
    })

    test('when Stripe is down altogether (a 401, a 500): kept and the admins told', async () => {
      for (const status of [401, 500]) {
        const { bill, owner } = await pendingSignUp()
        await startCheckout(owner)
        await age(bill.id)
        setBillingFetch((async () => reply(status, { error: { type: 'api_error', message: 'down' } })) as typeof fetch)
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          await sweepSignUps(db)
        } finally {
          setBillingFetch(fakeStripe)
          error.mockRestore()
        }
        expect(await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id))).toHaveLength(1)
        expect(keptAlerts(bill.id)).toMatchObject([{ data: { reason: 'stripe_error' } }])
      }
    })

    test('the alerts tell the instance admins what was kept and why', async () => {
      await sendBillingAlert(db, emailSender, {
        kind: 'signup_kept',
        bill: 'bill_v1',
        subscription: 'sub_v1',
        reason: 'in_stripe',
        customer: 'cus_v1',
        session: null,
      })
      const kept = mails.find(m => m.subject.includes('waits for Checkout'))!
      expect(kept.text).toContain('in Stripe its customer has a running subscription or a completed Checkout')
      for (const id of ['bill_v1', 'cus_v1', 'sub_v1']) expect(kept.text).toContain(id)
      mails.length = 0
      await sendBillingAlert(db, emailSender, {
        kind: 'signup_kept',
        bill: 'bill_v1',
        subscription: null,
        reason: 'stripe_error',
        customer: 'cus_v1',
      })
      const failed = mails.find(m => m.subject.includes('could not ask Stripe'))!
      expect(failed.text).toContain('Nothing was deleted')
      expect(failed.text).toContain('cus_v1')
    })
  })

  test(`card fingerprints go ${CARD_FINGERPRINT_RETENTION_MONTHS} months after their bill was canceled; others stay`, async () => {
    const old = await trialWith(rid('fp'))
    const recent = await trialWith(rid('fp'))
    const running = await trialWith(rid('fp'))
    const months = (n: number) => {
      const d = new Date()
      d.setUTCMonth(d.getUTCMonth() - n)
      return d.toISOString()
    }
    await db
      .update(billing_accounts)
      .set({ status: 'canceled', canceled_at: months(CARD_FINGERPRINT_RETENTION_MONTHS + 1) })
      .where(eq(billing_accounts.id, old.bill.id))
    await db
      .update(billing_accounts)
      .set({ status: 'canceled', canceled_at: months(CARD_FINGERPRINT_RETENTION_MONTHS - 1) })
      .where(eq(billing_accounts.id, recent.bill.id))
    const result = await sweepSignUps(db)
    expect(result.fingerprints).toBeGreaterThanOrEqual(1)
    const left = async (b: { bill: { id: string } }) =>
      db.select().from(card_fingerprints).where(eq(card_fingerprints.first_billing_account_id, b.bill.id))
    expect(await left(old)).toEqual([])
    expect(await left(recent)).toHaveLength(1)
    expect(await left(running)).toHaveLength(1)
  })
})

describe('the trial ends (customer.subscription.trial_will_end, invoice.created)', () => {
  test('three days before: one alert per trial, an email with the charge, the date and how to cancel', async () => {
    const { bill, sub, ws } = await trialWith(rid('fp'))
    const customer = sub.customer as string
    const object = { id: sub.id, object: 'subscription', customer }
    expect(await processEvent('customer.subscription.trial_will_end', object)).toMatchObject({ detail: 'emailed' })
    expect(await processEvent('customer.subscription.trial_will_end', object)).toMatchObject({
      detail: 'already_emailed',
    })
    const alerts = await db
      .select()
      .from(billing_alerts)
      .where(and(eq(billing_alerts.billing_account_id, bill.id), eq(billing_alerts.kind, 'trial_will_end')))
    expect(alerts).toHaveLength(1)
    const trialEnd = (await billRow(bill.id)).trial_ends_at!
    await sendBillingAlert(db, emailSender, { kind: 'trial_will_end', bill: bill.id, ref: trialEnd })
    const mail = mails.at(-1)!
    expect(mail.subject).toMatch(/trial ends on/)
    expect(mail.text).toContain('$11.00')
    expect(mail.text).toContain('adds $25.00')
    expect(mail.text).toContain('Cancel in Settings › Billing')
    // The cancel link: the bill's workspace's Settings › Billing.
    expect(mail.html).toContain(`#workspace/billing?ws=${encodeURIComponent(ws.id)}`)
  })

  test('the conversion invoice gets the first recharge as an invoice item, once', async () => {
    const { bill, sub } = await trialWith(rid('fp'))
    const invoiceId = rid('in')
    stripe.invoices.set(invoiceId, {
      id: invoiceId,
      object: 'invoice',
      livemode: false,
      customer: sub.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
      status: 'draft',
      billing_reason: 'subscription_cycle',
      currency: 'usd',
      total: 10_800,
      total_taxes: [],
      amount_paid: 0,
      amount_paid_off_stripe: 0,
      metadata: {},
      lines: list([], `/v1/invoices/${invoiceId}/lines`),
      number: null,
      period_start: nowSec(),
      period_end: nowSec(),
    })
    const object = { id: invoiceId, object: 'invoice', customer: sub.customer }
    expect(await processEvent('invoice.created', object)).toMatchObject({ detail: 'recharge_added' })
    const [recharge] = await db
      .select()
      .from(billing_recharges)
      .where(eq(billing_recharges.billing_account_id, bill.id))
    expect(recharge).toMatchObject({ status: 'pending', stripe_invoice_id: invoiceId, amount_cents: 2500 })
    const item = stripe.requests.find(r => r.method === 'POST' && r.path === '/v1/invoiceitems')!
    expect(Object.fromEntries(item.body)).toMatchObject({
      invoice: invoiceId,
      amount: '2500',
      currency: 'usd',
      'metadata[billing_recharge_id]': recharge!.id,
    })
    expect(item.idempotencyKey).toBe(`${recharge!.id}:item`)

    // A failed conversion invoice is dunning's (PR 11): the bill goes past_due after a failed first payment, the
    // invoice is never voided here, and the recharge stays pending.
    Object.assign(stripe.invoices.get(invoiceId)!, { status: 'open' })
    stripe.subscriptions.get(sub.id as string)!.status = 'past_due'
    stripe.requests.length = 0
    expect(await processEvent('invoice.payment_failed', object)).toMatchObject({
      outcome: 'lifecycle',
      change: 'past_due',
    })
    expect((await db.select().from(billing_accounts).where(eq(billing_accounts.id, bill.id)))[0]).toMatchObject({
      status: 'past_due',
      past_due_first_payment: true,
    })
    expect(stripe.requests.filter(r => r.method === 'POST' && r.path.startsWith('/v1/invoices/'))).toEqual([])
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, recharge!.id)))[0]!.status).toBe(
      'pending',
    )
    // Voided: the recharge is canceled with it.
    Object.assign(stripe.invoices.get(invoiceId)!, { status: 'void' })
    await processEvent('invoice.voided', object)
    expect((await db.select().from(billing_recharges).where(eq(billing_recharges.id, recharge!.id)))[0]!.status).toBe(
      'canceled',
    )
  })

  test('auto-recharge off, or not the conversion invoice: no recharge added', async () => {
    const { bill, sub } = await trialWith(rid('fp'))
    await db.update(billing_accounts).set({ auto_recharge: false }).where(eq(billing_accounts.id, bill.id))
    const invoiceId = rid('in')
    stripe.invoices.set(invoiceId, {
      id: invoiceId,
      object: 'invoice',
      livemode: false,
      customer: sub.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
      status: 'draft',
      billing_reason: 'subscription_cycle',
      currency: 'usd',
      total: 10_800,
      total_taxes: [],
      amount_paid: 0,
      amount_paid_off_stripe: 0,
      metadata: {},
      lines: list([], `/v1/invoices/${invoiceId}/lines`),
    })
    const object = { id: invoiceId, object: 'invoice', customer: sub.customer }
    expect(await processEvent('invoice.created', object)).toMatchObject({ detail: 'no_recharge' })
    expect(stripe.requests.filter(r => r.path === '/v1/invoiceitems')).toEqual([])
  })

  test('a trial ended early: the trial period cut, the first month open, the first recharge decided (billing tour G1)', async () => {
    const queued: { name: string; data: Record<string, unknown> }[] = []
    setJobQueue({
      send: async (name: string, data: Record<string, unknown>) => {
        queued.push({ name, data })
        return 'job'
      },
      insert: async () => [],
    } as never)
    try {
      const { bill, sub } = await trialWith(rid('fp'))
      expect(Date.parse((await billRow(bill.id)).trial_ends_at!)).toBeGreaterThan(Date.now() + 13 * DAY_S * 1000)
      // "Start my plan now": Stripe ends the trial and charges the plan at once; no draft hour, no invoice.created.
      const ended = nowSec() - 60
      const item = (sub.items as { data: Json[] }).data[0]!
      Object.assign(item, { current_period_start: ended, current_period_end: ended + 30 * DAY_S })
      Object.assign(sub, { status: 'active', trial_end: ended })
      const invoiceId = rid('in')
      stripe.invoices.set(invoiceId, {
        id: invoiceId,
        object: 'invoice',
        livemode: false,
        customer: sub.customer,
        parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
        status: 'paid',
        billing_reason: 'subscription_update',
        currency: 'usd',
        total: 1100,
        total_taxes: [],
        amount_paid: 1100,
        amount_paid_off_stripe: 0,
        starting_balance: 0,
        metadata: {},
        lines: list([], `/v1/invoices/${invoiceId}/lines`),
        number: 'LD-0003',
        period_start: ended,
        period_end: ended + 30 * DAY_S,
      })
      await processEvent('invoice.paid', { id: invoiceId, object: 'invoice', customer: sub.customer })
      const after = await billRow(bill.id)
      expect(after.status).toBe('active')
      expect(Date.parse(after.trial_ends_at!)).toBe(ended * 1000)
      const periods = await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, bill.id))
      const trial = periods.find(p => p.kind === 'trial')!
      expect(Date.parse(trial.ends_at)).toBeLessThanOrEqual(Date.now())
      expect(periods.some(p => p.kind === 'month' && Date.parse(p.ends_at) > Date.now())).toBe(true)
      // No draft to add it to: the first recharge (the bill's amount) is charged now with its own invoice, once.
      const recharges = await db
        .select()
        .from(billing_recharges)
        .where(eq(billing_recharges.billing_account_id, bill.id))
      expect(recharges).toMatchObject([
        { status: 'pending', amount_cents: 2500, manual: false, stripe_invoice_id: null },
      ])
      expect(queued.filter(j => j.data.rechargeId === recharges[0]!.id)).toHaveLength(1)
      await processEvent('invoice.paid', { id: invoiceId, object: 'invoice', customer: sub.customer })
      expect(
        await db.select().from(billing_recharges).where(eq(billing_recharges.billing_account_id, bill.id)),
      ).toHaveLength(1)
    } finally {
      setJobQueue(null)
    }
  })
})

// Last in the file: it moves the plan price's lookup key in the fake account to a new price.
describe("the install's own prices, trial and name (docs/billing.md §7b)", () => {
  const reason = 'our own prices'
  afterAll(async () => {
    await act(operator, 'billingRules.set', { rules: { workspaceMonthlyCents: null, trialDays: null }, reason })
    await act(operator, 'branding.set', { name: 'Linedesk', color: null, starPrompt: true })
  })

  test('Checkout sells what Server admin › Billing set, named after the install, in its own Stripe account', async () => {
    const rules = await act(operator, 'billingRules.set', {
      rules: { workspaceMonthlyCents: 900, trialDays: 7 },
      reason,
    })
    expect(rules.status).toBe(200)
    expect(rules.body.data.effective).toMatchObject({ workspaceMonthlyCents: 900, trialDays: 7 })
    expect((await act(operator, 'branding.set', { name: 'Front Desk', color: null, starPrompt: true })).status).toBe(
      200,
    )
    const { owner } = await pendingSignUp()
    // The page waiting for a card says the price and the trial Checkout will use (billing tour, G3).
    expect((await request(owner, 'GET', '/v1/me')).body.workspace).toMatchObject({
      trialDays: 7,
      plan: { interval: 'month', cents: 900 },
      extraNumberCents: 300,
    })
    const made = Object.fromEntries((await startCheckout(owner)).body)
    expect(made).toMatchObject({
      'subscription_data[trial_period_days]': '7',
      'line_items[0][price]': 'price_ws_monthly_900',
    })
    expect(made['custom_text[submit][message]']).toMatch(/^Your 7-day free trial starts today\./)
    // The price was made in the account with the lookup key taken over; the seat product carries the install's name.
    const price = stripe.requests.find(r => r.method === 'POST' && r.path === '/v1/prices')!
    expect(Object.fromEntries(price.body)).toMatchObject({
      unit_amount: '900',
      currency: 'usd',
      lookup_key: 'ws_monthly',
      transfer_lookup_key: 'true',
      product: 'linedesk_workspace',
      'metadata[linedesk]': 'ws_monthly',
    })
    expect(stripe.products.get('linedesk_workspace')).toMatchObject({ name: 'Front Desk workspace' })
    // The old price stays for the subscriptions on it, still known as a seat by its metadata.
    expect(stripe.prices.find(p => p.id === 'price_ws_monthly')).toMatchObject({ active: true, lookup_key: null })
  })

  test('Buy minutes names the install too; out-of-range prices and trials are refused whole', async () => {
    const { owner } = await trialWith(`fp_own_${Date.now()}`)
    const res = await act(owner, 'billing.startTopUp', { amountCents: 2500 })
    expect(res.status).toBe(200)
    const topup = stripe.requests.filter(r => r.method === 'POST' && r.path === '/v1/checkout/sessions').at(-1)!
    // Stripe Tax is on by default: the amount is before tax, and Checkout says so.
    expect(topup.body.get('custom_text[submit][message]')).toBe(
      'Prepaid call minutes for your Front Desk balance. Amounts are before tax; tax is added where it applies.',
    )
    expect(topup.body.get('line_items[0][price_data][product]')).toBe('linedesk_balance_topup')
    for (const rules of [
      { workspaceMonthlyCents: 10 },
      { trialDays: 0 },
      { trialDays: 91 },
      { partnerYearlyCents: 'x' },
    ])
      expect((await act(operator, 'billingRules.set', { rules, reason })).status, JSON.stringify(rules)).toBe(409)
    expect((await act(operator, 'billingRules.get', {})).body.data.effective).toMatchObject({
      workspaceMonthlyCents: 900,
      trialDays: 7,
    })
  })
})

// After the install's own prices: the catalog is synced on an admin's save, never at a customer's Checkout.
describe('the catalog sync and Checkout (security review of #1040)', () => {
  const reason = 'catalog sync review'
  const syncAlerts = () => mails.filter(m => /Stripe products and prices on .* could not be updated/.test(m.subject))
  const pricesWritten = () =>
    stripe.requests.filter(r => r.method === 'POST' && /^\/v1\/(prices|products)/.test(r.path))
  afterAll(async () => {
    stripe.catalogWritable = true
    await act(operator, 'billingRules.set', { rules: { workspaceMonthlyCents: null }, reason })
  })

  test('turning billing on synced the catalog: Checkout sells the stored price ids and writes nothing in Stripe (M-1)', async () => {
    const [row] = await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY))
    expect(JSON.parse(row!.value)).toMatchObject({
      account: 'acct_1Brightwater:test',
      prices: { ws_monthly: expect.any(String) },
    })
    const { owner } = await pendingSignUp()
    stripe.requests.length = 0
    await startCheckout(owner)
    expect(pricesWritten()).toEqual([])
    expect(stripe.requests.some(r => r.path.startsWith('/v1/prices') || r.path.startsWith('/v1/products'))).toBe(false)
  })

  test('a key that may not write Products and Prices: the save stands, the admins hear at once, Checkout and Buy minutes go on (M-1)', async () => {
    const { owner } = await trialWith(`fp_sync_${Date.now()}`)
    const before = JSON.parse(
      (await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY)))[0]!.value,
    )
    stripe.catalogWritable = false
    const saved = await act(operator, 'billingRules.set', { rules: { workspaceMonthlyCents: 1300 }, reason })
    expect(saved.status).toBe(200)
    await vi.waitFor(() => expect(syncAlerts()).toHaveLength(1))
    expect(syncAlerts()[0]!.text).toMatch(/keep selling the prices of the last update that worked/)
    // The last sync that worked is kept.
    const after = JSON.parse(
      (await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY)))[0]!.value,
    )
    expect(after.prices).toEqual(before.prices)
    // A new sign-up gets the last synced price; Buy minutes needs only its own product.
    const signUp = await pendingSignUp()
    stripe.requests.length = 0
    const made = await startCheckout(signUp.owner)
    expect(made.body.get('line_items[0][price]')).toBe(before.prices.ws_monthly)
    expect((await act(owner, 'billing.startTopUp', { amountCents: 2500 })).status).toBe(200)
    expect(pricesWritten()).toEqual([])
  })

  test('never synced for this account and Stripe refuses: no Checkout, the admins are told; once it can, Checkout syncs (M-1)', async () => {
    await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY))
    stripe.catalogWritable = false
    const { owner } = await pendingSignUp()
    const refused = await act(owner, 'billing.startCheckout', {})
    expect(refused).toMatchObject({ status: 409, body: { error: sayIn(CHECKOUT_UNAVAILABLE) } })
    await vi.waitFor(() => expect(mails.some(m => /Checkout on .* could not start/.test(m.subject))).toBe(true))
    expect(syncAlerts()[0]!.text).toMatch(/nobody can start a trial or a plan/)
    stripe.catalogWritable = true
    const made = await startCheckout(owner)
    expect(made.body.get('line_items[0][price]')).toBe('price_ws_monthly_1300')
  })

  test('a Checkout whose subscription is on another product is not a Linedesk plan, whatever its lookup key (L-1)', async () => {
    const { bill, owner } = await pendingSignUp()
    await startCheckout(owner)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const sub = subscription((await billRow(bill.id)).stripe_customer_id!)
    const items = (sub.items as { data: { price: Json }[] }).data
    items[0]!.price.product = 'prod_OtherIntegration'
    complete(sessionId, sub)
    const res = await act(owner, 'billing.confirmCheckout', { sessionId })
    expect(res.status).toBe(409)
    expect(await billRow(bill.id)).toMatchObject({ status: 'pending_payment', stripe_subscription_id: null })
  })

  test('at most a few Checkout starts a minute per bill (L-3)', async () => {
    const { owner } = await pendingSignUp()
    for (let i = 0; i < CHECKOUT_STARTS_PER_MINUTE; i++) await startCheckout(owner)
    const made = checkoutsMade().length
    expect(await act(owner, 'billing.startCheckout', {})).toMatchObject({
      status: 409,
      body: { error: sayIn(CHECKOUT_TOO_OFTEN) },
    })
    expect(checkoutsMade()).toHaveLength(made)
  })
})

describe('the partner bill (white-label S2, docs/white-label.md)', () => {
  /** A partner sign-up waiting for Checkout: its owner (no workspace), the partner, the partner bill. */
  async function pendingPartner() {
    const { owner } = await createWorkspace('Owner Home')
    const partnerId = rid('ptn')
    const [bill] = await db
      .insert(billing_accounts)
      .values({ id: rid('bill'), kind: 'partner', owner_user_id: owner.userId, status: 'pending_payment' })
      .returning()
    await db
      .insert(partners)
      .values({ id: partnerId, name: 'Cascade IT', billing_account_id: bill!.id, created_by: owner.userId })
    await db.insert(partner_members).values({ partner_id: partnerId, user_id: owner.userId, role: 'owner' })
    return { owner, partnerId, bill: bill! }
  }

  test('Checkout sells the partner base fee alone; the first client workspace adds its seat to the subscription', async () => {
    const { owner, partnerId, bill } = await pendingPartner()
    const res = await act(owner, 'billing.startCheckout', { partnerId })
    expect(res.status).toBe(200)
    const made = Object.fromEntries(checkoutsMade().at(-1)!.body)
    expect(made).toMatchObject({
      client_reference_id: bill.id,
      'line_items[0][price]': 'price_partner_monthly',
      'line_items[0][quantity]': '1',
      success_url: `http://localhost:5173/billing/return?session_id={CHECKOUT_SESSION_ID}&partner=${partnerId}`,
      cancel_url: 'http://localhost:5173/#partner',
    })
    expect(made['line_items[1][price]']).toBeUndefined()
    // Stripe made the subscription with the base fee; the owner confirms for the partner.
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const sub = subscription((await billRow(bill.id)).stripe_customer_id!)
    const item = (sub.items as { data: Json[] }).data[0]!
    item.price = { ...(item.price as Json), id: 'price_partner_monthly', lookup_key: 'partner_monthly' }
    complete(sessionId, sub)
    expect(await act(owner, 'billing.confirmCheckout', { sessionId })).toMatchObject({ status: 409 })
    expect(await act(owner, 'billing.confirmCheckout', { sessionId, partnerId })).toMatchObject({
      status: 200,
      body: { data: { status: 'trialing' } },
    })
    expect(await billRow(bill.id)).toMatchObject({ status: 'trialing', stripe_subscription_id: sub.id })
    stripe.requests.length = 0
    const client = await act(owner, 'workspace.createForClient', { partnerId, name: 'First Client' })
    expect(client).toMatchObject({ status: 200, body: { data: { billId: bill.id } } })
    await vi.waitFor(() =>
      expect(stripe.requests.filter(r => r.method === 'POST' && r.path === `/v1/subscriptions/${sub.id}`)).toHaveLength(
        1,
      ),
    )
    const update = stripe.requests.find(r => r.method === 'POST' && r.path === `/v1/subscriptions/${sub.id}`)!
    expect(Object.fromEntries(update.body)).toMatchObject({
      // The install's seat price as the catalog has it (an earlier test may have changed the price).
      'items[0][price]': expect.stringMatching(/^price_ws_monthly/),
      'items[0][quantity]': '1',
      proration_behavior: 'create_prorations',
    })
    expect(update.idempotencyKey).toBe(`seats_client_${client.body.data.workspace.id}_${bill.id}_1`)
  })

  test("a released client leaves its extra calls behind; the partner bill's extra-calls item drops (review of #1109, M-2)", async () => {
    const { owner, partnerId, bill } = await pendingPartner()
    expect((await act(owner, 'billing.startCheckout', { partnerId })).status).toBe(200)
    const sessionId = [...stripe.sessions.keys()].at(-1)!
    const sub = subscription((await billRow(bill.id)).stripe_customer_id!)
    const items = (sub.items as { data: Json[] }).data
    items[0]!.price = { ...(items[0]!.price as Json), id: 'price_partner_monthly', lookup_key: 'partner_monthly' }
    complete(sessionId, sub)
    expect((await act(owner, 'billing.confirmCheckout', { sessionId, partnerId })).status).toBe(200)
    const made = await act(owner, 'workspace.createForClient', { partnerId, name: 'Leaving Client' })
    expect(made.status).toBe(200)
    const ws: string = made.body.data.workspace.id
    // The client's own owner, and 5 extra calls the partner bought for it (the item on the partner's subscription).
    const clientOwner = await addMember(ws, 'member')
    await db.update(member).set({ role: 'owner' }).where(eq(member.userId, clientOwner.userId))
    await db.update(organization).set({ extraCalls: 5 }).where(eq(organization.id, ws))
    items.push({
      id: 'si_xc_release',
      object: 'subscription_item',
      quantity: 5,
      price: { id: 'price_xc', object: 'price', lookup_key: 'extra_calls_monthly', recurring: { interval: 'month' } },
    })
    // The extra-calls price as the catalog sync stored it.
    const [catalog] = await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY))
    const stored = JSON.parse(catalog!.value)
    stored.prices.extra_calls_monthly ??= 'price_xc'
    await db
      .update(instance_settings)
      .set({ value: JSON.stringify(stored) })
      .where(eq(instance_settings.key, BILLING_CATALOG_KEY))
    stripe.requests.length = 0
    const res = await act(owner, 'partner.releaseClient', { partnerId, workspaceId: ws, confirmName: 'Leaving Client' })
    expect(res.status).toBe(200)
    const [left] = await db.select().from(organization).where(eq(organization.id, ws))
    expect(left).toMatchObject({ extraCalls: 0, billingState: 'pending_payment' })
    expect(left!.billingAccountId).not.toBe(bill.id)
    // After the commit: the partner's extra-calls item goes to 0, never charged.
    await vi.waitFor(() =>
      expect(
        stripe.requests.filter(
          r =>
            r.method === 'POST' &&
            r.path === `/v1/subscriptions/${sub.id}` &&
            r.body.get('items[0][id]') === 'si_xc_release',
        ),
      ).toHaveLength(1),
    )
    const update = stripe.requests.find(r => r.body.get('items[0][id]') === 'si_xc_release')!
    expect(Object.fromEntries(update.body)).toMatchObject({ 'items[0][quantity]': '0', proration_behavior: 'none' })
  })

  test("another partner's owner, or a partner admin, never starts or confirms Checkout for the partner bill", async () => {
    const { partnerId } = await pendingPartner()
    const other = await pendingPartner()
    const admin = await createWorkspace('Admin Home')
    await db.insert(partner_members).values({ partner_id: partnerId, user_id: admin.owner.userId, role: 'admin' })
    for (const who of [other.owner, admin.owner]) {
      expect((await act(who, 'billing.startCheckout', { partnerId })).status).toBe(403)
      expect((await act(who, 'billing.confirmCheckout', { partnerId, sessionId: 'cs_test_x' })).status).toBe(403)
    }
    expect(checkoutsMade()).toEqual([])
  })
})
