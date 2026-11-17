// Contract tests of the billing adapters: `none` without a network call, `stripe` against recorded responses of
// GET /v1/account (the shape Stripe sends), never the network.
import { createHmac } from 'node:crypto'
import Stripe from 'stripe'
import { describe, expect, test } from 'vitest'
import {
  BillingSetupError,
  isStripeWebhookSecret,
  liveKeysAllowed,
  loadBillingProvider,
  noneBillingProvider,
  type StripeKeys,
  stripeKeyMode,
  WEBHOOK_EVENTS,
  WebhookRefused,
} from './index.ts'
import { STRIPE_API_VERSION } from './stripe/index.ts'

/** A made-up Stripe key, put together at run time so the secret scan never sees a key-shaped string in the repo. */
const fakeStripeKey = (kind: 'sk' | 'rk', mode: 'test' | 'live', body: string) => [kind, mode, body].join('_')
const TEST_KEY = fakeStripeKey('sk', 'test', '51AbCdEfGhIjKlMn')
const RESTRICTED_LIVE = fakeStripeKey('rk', 'live', '51AbCdEfGhIjKlMn')

/** A recorded GET /v1/account answer, cut to the fields the adapter reads (and one it ignores). */
const accountBody = {
  id: 'acct_1TestAccount',
  object: 'account',
  country: 'DE',
  default_currency: 'eur',
  charges_enabled: false,
  business_profile: { url: 'https://example.com' },
}

function recordingFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { doFetch, calls }
}
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name)

describe('keys', () => {
  test('the mode is read from the key', () => {
    expect(stripeKeyMode(TEST_KEY)).toBe('test')
    expect(stripeKeyMode(fakeStripeKey('rk', 'test', 'abc123'))).toBe('test')
    expect(stripeKeyMode(fakeStripeKey('sk', 'live', 'abc123'))).toBe('live')
    expect(stripeKeyMode(RESTRICTED_LIVE)).toBe('live')
    // Publishable keys, webhook secrets and typos are not secret keys.
    expect(stripeKeyMode('pk_test_abc123')).toBeNull()
    expect(stripeKeyMode('whsec_abc123')).toBeNull()
    expect(stripeKeyMode('sk_prod_abc123')).toBeNull()
    expect(stripeKeyMode('')).toBeNull()
  })

  test('webhook secrets', () => {
    expect(isStripeWebhookSecret('whsec_abc123')).toBe(true)
    expect(isStripeWebhookSecret(fakeStripeKey('sk', 'test', 'abc123'))).toBe(false)
  })

  test('live keys are never allowed in dev mode', () => {
    expect(liveKeysAllowed({})).toBe(false)
    expect(liveKeysAllowed({ LINEDESK_MODE: '' })).toBe(false)
    expect(liveKeysAllowed({ BILLING_LIVE_KEYS: 'true' })).toBe(false)
    expect(liveKeysAllowed({ BILLING_LIVE_KEYS: '1', LINEDESK_MODE: 'dev' })).toBe(false)
    expect(liveKeysAllowed({ BILLING_LIVE_KEYS: '1' })).toBe(true)
  })
})

describe('none', () => {
  test('is what an install without keys gets, and reads no account', async () => {
    const { doFetch, calls } = recordingFetch(500, {})
    const provider = await loadBillingProvider(null, doFetch)
    expect(provider).toBe(noneBillingProvider)
    expect(provider.name).toBe('none')
    expect(await provider.account()).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('stripe', () => {
  test('reads the account with GET /v1/account, the pinned API version and the key as bearer', async () => {
    const { doFetch, calls } = recordingFetch(200, accountBody)
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    expect(provider.name).toBe('stripe')
    expect(await provider.account()).toEqual({
      id: 'acct_1TestAccount',
      mode: 'test',
      country: 'DE',
      defaultCurrency: 'eur',
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toBe('https://api.stripe.com/v1/account')
    expect((call!.init?.method ?? 'GET').toUpperCase()).toBe('GET')
    expect(header(call!.init, 'authorization')).toBe(`Bearer ${TEST_KEY}`)
    expect(header(call!.init, 'stripe-version')).toBe(STRIPE_API_VERSION)
  })

  test('the mode comes from the key, not from the answer', async () => {
    const { doFetch } = recordingFetch(200, accountBody)
    const provider = await loadBillingProvider({ secretKey: RESTRICTED_LIVE, webhookSecret: 'whsec_abc' }, doFetch)
    expect((await provider.account())?.mode).toBe('live')
  })

  test('a rejected key throws an authentication error and is not retried', async () => {
    const { doFetch, calls } = recordingFetch(401, {
      error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_****' },
    })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    await expect(provider.account()).rejects.toMatchObject({ type: 'StripeAuthenticationError', statusCode: 401 })
    expect(calls).toHaveLength(1)
  })

  test('missing fields read as null', async () => {
    const { doFetch } = recordingFetch(200, { id: 'acct_2', object: 'account' })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    expect(await provider.account()).toEqual({ id: 'acct_2', mode: 'test', country: null, defaultCurrency: null })
  })

  test('refuses anything that is not a secret or restricted key', async () => {
    await expect(loadBillingProvider({ secretKey: 'pk_test_abc', webhookSecret: 'whsec_abc' })).rejects.toThrow(
      'not a Stripe secret or restricted key',
    )
  })
})

/**
 * Recorded answers of the recharge requests (shapes from the Stripe sandbox, cut to what the adapter reads), served
 * by method and path, each request recorded with its form body and idempotency key.
 */
function stripeRoutes(routes: Record<string, (body: URLSearchParams) => [number, unknown]>) {
  const calls: { route: string; body: URLSearchParams; key: string | null; url: URL }[] = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const route = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    calls.push({ route, body, key: header(init, 'idempotency-key'), url })
    const answer = routes[route]
    const [status, json] = answer ? answer(body) : [404, { error: { type: 'invalid_request_error', message: route } }]
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { doFetch, calls }
}
const invoice = (status: string, total = 2000, extra: Record<string, unknown> = {}) => ({
  id: 'in_1Rc',
  object: 'invoice',
  status,
  total,
  metadata: { billing_recharge_id: 'rc_abc' },
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_x',
  ...extra,
})
const recharge = {
  customerId: 'cus_1',
  amountCents: 2000,
  rechargeId: 'rc_abc',
  description: 'Linedesk balance recharge',
}
const stripeWith = (doFetch: typeof fetch) =>
  loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
/** An install's catalog (docs/billing.md §7b): its product names and plan prices, made in Stripe before a Checkout. */
const CATALOG = {
  products: { workspace: 'Front Desk workspace', balance_topup: 'Prepaid minutes' },
  prices: [{ lookupKey: 'ws_yearly', product: 'workspace', cents: 10_800, interval: 'year' as const }],
  taxCode: 'txcd_10103001',
  currency: 'usd' as const,
}
/** Stripe already has the catalog: the products by our ids and a fitting price per lookup key. */
const catalogRoutes = (): Record<string, (body: URLSearchParams) => [number, unknown]> => ({
  ...Object.fromEntries(
    Object.entries(CATALOG.products).map(([key, name]) => [
      `GET /v1/products/linedesk_${key}`,
      () => [200, { id: `linedesk_${key}`, object: 'product', name, active: true }],
    ]),
  ),
  'GET /v1/prices': () => [
    200,
    {
      object: 'list',
      has_more: false,
      data: CATALOG.prices.map(p => ({
        id: `price_${p.lookupKey}`,
        object: 'price',
        active: true,
        lookup_key: p.lookupKey,
        unit_amount: p.cents,
        currency: 'usd',
        tax_behavior: 'exclusive',
        product: `linedesk_${p.product}`,
        recurring: { interval: p.interval, interval_count: 1, usage_type: 'licensed' },
      })),
    },
  ],
})
/** A card as Stripe expands it (`created` in Unix seconds). */
const card = (id: string, created = 1_800_000_000) => ({
  id,
  object: 'payment_method',
  type: 'card',
  created,
  card: { brand: 'visa', last4: '4242' },
})
/** A customer as GET /v1/customers/:id answers it, with its invoice default (expanded) or none. */
const customer = (defaultCard: unknown = null, extra: Record<string, unknown> = {}) => ({
  id: 'cus_1',
  object: 'customer',
  invoice_settings: { default_payment_method: defaultCard },
  default_source: null,
  ...extra,
})
/** A subscription of cus_1 whose card Checkout saved (expanded). */
const subscription = (defaultCard: unknown, customerId = 'cus_1') => ({
  id: 'sub_1',
  object: 'subscription',
  customer: customerId,
  default_payment_method: defaultCard,
  items: { object: 'list', data: [], has_more: false },
})

describe('stripe recharges', () => {
  test('Buy minutes with the saved card is paid on-session: 3D Secure fails at once (the app then offers Checkout)', async () => {
    const { doFetch, calls } = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoiceitems/ii_1': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(card('pm_own'))],
      'POST /v1/invoices/in_1Rc/pay': () => [
        402,
        { error: { type: 'card_error', code: 'invoice_payment_intent_requires_action', message: '3DS' } },
      ],
    })
    expect(await (await stripeWith(doFetch)).chargeRecharge({ ...recharge, onSession: true })).toEqual({
      status: 'failed',
      invoiceId: 'in_1Rc',
      failureCode: 'authentication_required',
    })
    expect(Object.fromEntries(calls.find(c => c.route === 'POST /v1/invoices/in_1Rc/pay')!.body)).toEqual({
      off_session: 'false',
    })
  })

  test('one invoice with one item, automatic tax, finalized and paid, each request with its own idempotency key', async () => {
    const { doFetch, calls } = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoiceitems/ii_1': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(card('pm_own'))],
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('paid')],
    })
    expect(await (await stripeWith(doFetch)).chargeRecharge(recharge)).toEqual({ status: 'paid', invoiceId: 'in_1Rc' })
    // An auto-recharge is paid off-session (Stripe's default): nothing on the pay request.
    expect(Object.fromEntries(calls.find(c => c.route === 'POST /v1/invoices/in_1Rc/pay')!.body)).toEqual({})
    expect(calls.map(c => [c.route, c.key])).toEqual([
      ['POST /v1/invoices', 'rc_abc:invoice'],
      // The texts with the install's name: plain updates, outside every idempotent request (review of #1040, L-5).
      ['POST /v1/invoices/in_1Rc', null],
      ['POST /v1/invoiceitems', 'rc_abc:item'],
      ['POST /v1/invoiceitems/ii_1', null],
      ['POST /v1/invoices/in_1Rc/finalize', 'rc_abc:finalize'],
      // The customer already has an invoice default: charged to it, nothing changed on the customer.
      ['GET /v1/customers/cus_1', null],
      ['POST /v1/invoices/in_1Rc/pay', 'rc_abc:pay'],
    ])
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({
      customer: 'cus_1',
      collection_method: 'charge_automatically',
      auto_advance: 'true',
      'automatic_tax[enabled]': 'true',
      pending_invoice_items_behavior: 'exclude',
      currency: 'usd',
      'metadata[billing_recharge_id]': 'rc_abc',
    })
    expect(Object.fromEntries(calls[2]!.body)).toMatchObject({
      invoice: 'in_1Rc',
      amount: '2000',
      currency: 'usd',
      tax_behavior: 'exclusive',
    })
    expect(Object.fromEntries(calls[1]!.body)).toEqual({ description: 'Linedesk balance recharge' })
    expect(Object.fromEntries(calls[3]!.body)).toEqual({ description: 'Linedesk balance recharge' })
  })

  test('a retry after the product was renamed sends the same idempotent requests; only the texts change (L-5)', async () => {
    // Like Stripe: a key seen before with other parameters is an idempotency_error.
    const seen = new Map<string, string>()
    const { doFetch, calls } = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoiceitems/ii_1': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [500, { error: { type: 'api_error', message: 'Try again.' } }],
    })
    const stripe = await stripeWith(doFetch)
    await expect(stripe.chargeRecharge(recharge)).rejects.toMatchObject({ statusCode: 500 })
    await expect(
      stripe.chargeRecharge({ ...recharge, description: 'Front Desk balance recharge' }),
    ).rejects.toMatchObject({
      statusCode: 500,
    })
    for (const c of calls.filter(c => c.key)) {
      const body = c.body.toString()
      if (seen.has(c.key!)) expect(body, c.key!).toBe(seen.get(c.key!))
      seen.set(c.key!, body)
      expect(body).not.toMatch(/description/)
    }
    expect(
      calls
        .filter(c => c.route === 'POST /v1/invoiceitems/ii_1')
        .at(-1)!
        .body.get('description'),
    ).toBe('Front Desk balance recharge')
  })

  test('a known invoice is charged again, never made a second time; one of another recharge is refused', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(card('pm_own'))],
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('open')],
    })
    const stripe = await stripeWith(doFetch)
    expect(await stripe.chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' })).toEqual({
      status: 'open',
      invoiceId: 'in_1Rc',
    })
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/invoices/in_1Rc',
      'GET /v1/customers/cus_1',
      'POST /v1/invoices/in_1Rc/pay',
    ])
    await expect(stripe.chargeRecharge({ ...recharge, rechargeId: 'rc_other', invoiceId: 'in_1Rc' })).rejects.toThrow(
      'is not the one of recharge rc_other',
    )
  })

  test('a decline answers failed with the decline code; 3DS answers authentication_required; a server error throws', async () => {
    const declined = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [
        402,
        {
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'generic_decline',
            message: 'Your card was declined.',
          },
        },
      ],
    })
    expect(await (await stripeWith(declined.doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' })).toEqual({
      status: 'failed',
      invoiceId: 'in_1Rc',
      failureCode: 'generic_decline',
    })
    const needsOwner = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [
        402,
        {
          error: {
            type: 'card_error',
            code: 'authentication_required',
            message: 'This payment requires authentication.',
          },
        },
      ],
    })
    expect(
      await (await stripeWith(needsOwner.doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' }),
    ).toMatchObject({
      status: 'failed',
      failureCode: 'authentication_required',
    })
    const down = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [500, { error: { type: 'api_error', message: 'Something went wrong' } }],
    })
    await expect(
      (await stripeWith(down.doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' }),
    ).rejects.toMatchObject({
      statusCode: 500,
    })
  })

  test('a failed recharge: collection off, then voided when asked; found again by its metadata', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open', 2000, { auto_advance: true })],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('open', 2000, { auto_advance: false })],
      'POST /v1/invoices/in_1Rc/void': () => [200, invoice('void')],
      'GET /v1/invoices/search': () => [200, { object: 'search_result', data: [invoice('paid')], has_more: false }],
    })
    const stripe = await stripeWith(doFetch)
    await stripe.stopRechargeInvoice('in_1Rc', { void: true })
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/invoices/in_1Rc',
      'POST /v1/invoices/in_1Rc',
      'POST /v1/invoices/in_1Rc/void',
    ])
    expect(Object.fromEntries(calls[1]!.body)).toEqual({ auto_advance: 'false' })
    expect(await stripe.findRechargeInvoice('rc_abc')).toBe('in_1Rc')
    await expect(stripe.findRechargeInvoice("rc_x' OR '1")).rejects.toThrow('not a recharge id')
    expect(await stripe.rechargeInvoicePage('in_1Rc')).toBe('https://invoice.stripe.com/i/acct_1/test_x')
  })

  test('a request Stripe refuses for good (a 4xx that is no card error, conflict or rate limit) fails the recharge (review L3)', async () => {
    const noTax = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoiceitems/ii_1': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [
        400,
        {
          error: { type: 'invalid_request_error', code: 'customer_tax_location_invalid', message: 'No tax location.' },
        },
      ],
    })
    expect(await (await stripeWith(noTax.doFetch)).chargeRecharge(recharge)).toEqual({
      status: 'failed',
      invoiceId: 'in_1Rc',
      failureCode: 'stripe_customer_tax_location_invalid',
    })
    const noCard = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [
        400,
        { error: { type: 'invalid_request_error', code: 'invoice_no_payment_method_types', message: 'No card.' } },
      ],
    })
    expect(await (await stripeWith(noCard.doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' })).toMatchObject(
      {
        status: 'failed',
        failureCode: 'stripe_invoice_no_payment_method_types',
      },
    )
    const busy = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [409, { error: { type: 'idempotency_error', message: 'In progress.' } }],
    })
    await expect(
      (await stripeWith(busy.doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  test('3DS is recognised whatever the status: a 400 needing the customer keeps the invoice for the owner (recheck L1)', async () => {
    const { doFetch } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [
        400,
        {
          error: {
            type: 'invalid_request_error',
            code: 'invoice_payment_intent_requires_action',
            message: 'This payment requires additional user action.',
          },
        },
      ],
    })
    expect(await (await stripeWith(doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' })).toEqual({
      status: 'failed',
      invoiceId: 'in_1Rc',
      failureCode: 'authentication_required',
    })
  })

  test.each([
    [401, 'POST /v1/invoices/in_1Rc/pay', 'stripe_401'],
    [403, 'POST /v1/invoices/in_1Rc/pay', 'stripe_secret_key_required'],
    [404, 'POST /v1/invoices/in_1Rc/finalize', 'stripe_resource_missing'],
    [403, 'POST /v1/invoices', 'stripe_secret_key_required'],
  ])(
    'a %i (our keys or account) is a setup error for the admins, never a failed card payment (recheck L2)',
    async (status, route, code) => {
      const error = {
        error: {
          type: 'invalid_request_error',
          ...(status === 401 ? {} : { code: status === 404 ? 'resource_missing' : 'secret_key_required' }),
          message: 'Refused.',
        },
      }
      const { doFetch } = stripeRoutes({
        'POST /v1/invoices': () => (route === 'POST /v1/invoices' ? [status, error] : [200, invoice('draft', 0)]),
        'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
        'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 2000)],
        'GET /v1/invoices/in_1Rc': () => [200, invoice(route.endsWith('finalize') ? 'draft' : 'open', 2000)],
        [route]: () => [status, error],
      })
      const input = route === 'POST /v1/invoices' ? recharge : { ...recharge, invoiceId: 'in_1Rc' }
      const refused = (await stripeWith(doFetch)).chargeRecharge(input)
      await expect(refused).rejects.toBeInstanceOf(BillingSetupError)
      await expect(refused).rejects.toMatchObject({ code })
    },
  )

  test('an uncollectible invoice is voided when asked, so the customer cannot still pay it (re-review of #919, R4)', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('uncollectible', 2000, { auto_advance: false })],
      'POST /v1/invoices/in_1Rc/void': () => [200, invoice('void')],
    })
    const stripe = await stripeWith(doFetch)
    await stripe.stopRechargeInvoice('in_1Rc', { void: true })
    await stripe.stopRechargeInvoice('in_1Rc', { void: false })
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/invoices/in_1Rc',
      'POST /v1/invoices/in_1Rc/void',
      'GET /v1/invoices/in_1Rc',
    ])
  })

  test('a failed draft is deleted, or kept with collection off when it is not voided', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('draft', 2000, { auto_advance: true })],
      'DELETE /v1/invoices/in_1Rc': () => [200, { id: 'in_1Rc', object: 'invoice', deleted: true }],
      'POST /v1/invoices/in_1Rc': () => [200, invoice('draft', 2000, { auto_advance: false })],
    })
    const stripe = await stripeWith(doFetch)
    await stripe.stopRechargeInvoice('in_1Rc', { void: true })
    await stripe.stopRechargeInvoice('in_1Rc', { void: false })
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/invoices/in_1Rc',
      'DELETE /v1/invoices/in_1Rc',
      'GET /v1/invoices/in_1Rc',
      'POST /v1/invoices/in_1Rc',
    ])
  })

  test('first recharge after Checkout: the subscription’s card becomes the customer’s invoice default, then the invoice is paid (billing review B1)', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(null)],
      'GET /v1/subscriptions/sub_1': () => [200, subscription(card('pm_checkout'))],
      'POST /v1/customers/cus_1': () => [200, customer('pm_checkout')],
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('paid')],
    })
    expect(
      await (await stripeWith(doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc', subscriptionId: 'sub_1' }),
    ).toEqual({ status: 'paid', invoiceId: 'in_1Rc' })
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/invoices/in_1Rc',
      'GET /v1/customers/cus_1',
      'GET /v1/subscriptions/sub_1',
      'POST /v1/customers/cus_1',
      'POST /v1/invoices/in_1Rc/pay',
    ])
    expect(Object.fromEntries(calls[3]!.body)).toEqual({ 'invoice_settings[default_payment_method]': 'pm_checkout' })
    // The pay request names no card: Stripe charges the customer's default, so the portal's later changes count.
    expect(Object.fromEntries(calls[4]!.body)).toEqual({})
  })

  test('no card anywhere: the 402 `missing` is a failed recharge with the code `missing`, never an empty one (B3)', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/invoices/in_1Rc': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(null)],
      'GET /v1/subscriptions/sub_1': () => [200, subscription(null)],
      'POST /v1/invoices/in_1Rc/pay': () => [
        402,
        {
          error: {
            type: 'card_error',
            code: 'missing',
            decline_code: '',
            message: 'There is no default_payment_method set on this Customer or Invoice.',
          },
        },
      ],
    })
    expect(
      await (await stripeWith(doFetch)).chargeRecharge({ ...recharge, invoiceId: 'in_1Rc', subscriptionId: 'sub_1' }),
    ).toEqual({ status: 'failed', invoiceId: 'in_1Rc', failureCode: 'missing' })
    expect(calls.map(c => c.route)).not.toContain('POST /v1/customers/cus_1')
  })

  test('the recharge card: the customer’s default first, a legacy source, else the subscription’s; none when gone', async () => {
    const answer = async (routes: Record<string, (body: URLSearchParams) => [number, unknown]>, sub: string | null) =>
      (await stripeWith(stripeRoutes(routes).doFetch)).rechargeCard('cus_1', sub)
    expect(
      await answer(
        {
          'GET /v1/customers/cus_1': () => [200, customer(card('pm_portal', 1_800_000_100))],
          'GET /v1/subscriptions/sub_1': () => [200, subscription(card('pm_checkout'))],
        },
        'sub_1',
      ),
    ).toEqual({
      id: 'pm_portal',
      createdAt: new Date(1_800_000_100_000).toISOString(),
      on: 'customer',
      brand: 'visa',
      last4: '4242',
    })
    expect(
      await answer({ 'GET /v1/customers/cus_1': () => [200, customer(null, { default_source: 'card_legacy' })] }, null),
    ).toEqual({ id: 'card_legacy', createdAt: null, on: 'customer' })
    expect(
      await answer(
        {
          'GET /v1/customers/cus_1': () => [200, customer(null)],
          'GET /v1/subscriptions/sub_1': () => [200, subscription(card('pm_checkout'))],
        },
        'sub_1',
      ),
    ).toEqual({
      id: 'pm_checkout',
      createdAt: new Date(1_800_000_000_000).toISOString(),
      on: 'subscription',
      brand: 'visa',
      last4: '4242',
    })
    // No subscription, a subscription of another customer, one without a card, or a deleted customer: none.
    expect(await answer({ 'GET /v1/customers/cus_1': () => [200, customer(null)] }, null)).toBeNull()
    expect(
      await answer(
        {
          'GET /v1/customers/cus_1': () => [200, customer(null)],
          'GET /v1/subscriptions/sub_1': () => [200, subscription(card('pm_x'), 'cus_other')],
        },
        'sub_1',
      ),
    ).toBeNull()
    expect(await answer({ 'GET /v1/customers/cus_1': () => [200, customer(null)] }, 'sub_1')).toBeNull()
    expect(
      await answer(
        { 'GET /v1/customers/cus_1': () => [200, { id: 'cus_1', object: 'customer', deleted: true }] },
        null,
      ),
    ).toBeNull()
  })

  test('Checkout’s payment method configuration is found by name, active and not a connected account’s copy (B6)', async () => {
    const pmc = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      object: 'payment_method_configuration',
      name: 'Linedesk Checkout',
      active: true,
      parent: null,
      is_default: false,
      ...over,
    })
    const listing = (...data: unknown[]) =>
      stripeRoutes({
        'GET /v1/payment_method_configurations': () => [200, { object: 'list', data, has_more: false }],
      }).doFetch
    expect(
      await (
        await stripeWith(
          listing(
            pmc('pmc_default', { name: 'Default', is_default: true }),
            pmc('pmc_child', { parent: 'pmc_x' }),
            pmc('pmc_own'),
          ),
        )
      ).checkoutPaymentMethodConfiguration(),
    ).toBe('pmc_own')
    expect(
      await (await stripeWith(listing(pmc('pmc_off', { active: false })))).checkoutPaymentMethodConfiguration(),
    ).toBeNull()
    expect(await noneBillingProvider.checkoutPaymentMethodConfiguration()).toBeNull()
    expect(await noneBillingProvider.rechargeCard('cus_1', null)).toBeNull()
  })

  test('none refuses every charge without a network call', async () => {
    await expect(noneBillingProvider.chargeRecharge(recharge)).rejects.toThrow('billing is off')
  })
})

describe('stripe refunds and seats (Server admin › Billing, PR 13)', () => {
  const creditNote = {
    id: 'cn_1',
    object: 'credit_note',
    total: 538,
    refunds: [{ refund: 're_1', amount_refunded: 538 }],
  }
  const refund = {
    invoiceId: 'in_1Rc',
    lineId: 'il_1',
    amountCents: 500,
    idempotencyKey: 'refund_rf0123456789',
    memo: 'Refund',
  }

  test('a refund previews the credit note for its tax, then refunds that total, with the idempotency key', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/credit_notes/preview': () => [200, { ...creditNote, id: 'cn_preview' }],
      'POST /v1/credit_notes': () => [200, creditNote],
    })
    expect(await (await stripeWith(doFetch)).refundInvoice(refund)).toEqual({
      creditNoteId: 'cn_1',
      refundId: 're_1',
      refundedCents: 538,
    })
    expect(calls.map(c => [c.route, c.key])).toEqual([
      ['GET /v1/credit_notes/preview', null],
      ['POST /v1/credit_notes', 'refund_rf0123456789:credit_note'],
    ])
    expect(Object.fromEntries(calls[1]!.body)).toMatchObject({
      invoice: 'in_1Rc',
      'lines[0][type]': 'invoice_line_item',
      'lines[0][invoice_line_item]': 'il_1',
      'lines[0][amount]': '500',
      refund_amount: '538',
      'metadata[linedesk_refund]': 'refund_rf0123456789',
    })
  })

  test('a refund is found again by its idempotency key on the invoice’s credit notes, or not at all', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/credit_notes': () => [
        200,
        {
          object: 'list',
          has_more: false,
          url: '/v1/credit_notes',
          data: [
            { ...creditNote, id: 'cn_other', metadata: { linedesk_refund: 'refund_other' } },
            { ...creditNote, metadata: { linedesk_refund: 'refund_rf0123456789' } },
          ],
        },
      ],
    })
    const stripe = await stripeWith(doFetch)
    expect(await stripe.findRefund('in_1Rc', 'refund_rf0123456789')).toEqual({
      creditNoteId: 'cn_1',
      refundId: 're_1',
      refundedCents: 538,
    })
    expect(await stripe.findRefund('in_1Rc', 'refund_missing')).toBeNull()
    expect(calls[0]!.route).toBe('GET /v1/credit_notes')
    await expect(noneBillingProvider.findRefund('in_1Rc', 'refund_rf0123456789')).rejects.toThrow('billing is off')
  })

  test('a key without the credit note permission is our setup, not a refusal of the card', async () => {
    const { doFetch } = stripeRoutes({
      'GET /v1/credit_notes/preview': () => [
        403,
        { error: { type: 'invalid_request_error', code: 'permission_denied' } },
      ],
    })
    await expect((await stripeWith(doFetch)).refundInvoice(refund)).rejects.toBeInstanceOf(BillingSetupError)
  })

  const payments = (charge: string | null) => ({
    object: 'list',
    has_more: false,
    url: '/v1/invoice_payments',
    data: charge
      ? [
          {
            id: 'inpay_1',
            object: 'invoice_payment',
            status: 'paid',
            amount_paid: 2000,
            payment: { type: 'charge', charge },
          },
        ]
      : [],
  })
  const list = (data: unknown[]) => ({ object: 'list', has_more: false, url: '/v1/x', data })

  test('blockers: an open or lost dispute, an early fraud warning, no card charge; a won dispute is none', async () => {
    const answer = async (disputes: string[], warnings: number, charge: string | null = 'ch_1') => {
      const { doFetch } = stripeRoutes({
        'GET /v1/invoice_payments': () => [200, payments(charge)],
        'GET /v1/disputes': () => [
          200,
          list(disputes.map((status, i) => ({ id: `dp_${i}`, object: 'dispute', status }))),
        ],
        'GET /v1/radar/early_fraud_warnings': () => [
          200,
          list(Array.from({ length: warnings }, (_, i) => ({ id: `issfr_${i}` }))),
        ],
      })
      return (await stripeWith(doFetch)).refundBlockers('in_1Rc')
    }
    expect(await answer([], 0)).toEqual([])
    expect(await answer(['won'], 0)).toEqual([])
    expect(await answer(['needs_response'], 0)).toEqual(['dispute'])
    expect(await answer(['lost'], 1)).toEqual(['dispute', 'early_fraud_warning'])
    expect(await answer([], 0, null)).toEqual(['no_charge'])
  })

  test('seats: the ws_ item gets the quantity with the proration and the idempotency key; unchanged asks nothing', async () => {
    const sub = (quantity: number) => ({
      id: 'sub_1',
      object: 'subscription',
      items: list([
        { id: 'si_base', object: 'subscription_item', quantity: 1, price: { lookup_key: 'partner_yearly' } },
        { id: 'si_seat', object: 'subscription_item', quantity, price: { lookup_key: 'ws_yearly' } },
      ]),
    })
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/subscriptions/sub_1': () => [200, sub(2)],
      'POST /v1/subscriptions/sub_1': () => [200, sub(3)],
    })
    const stripe = await stripeWith(doFetch)
    const input = {
      subscriptionId: 'sub_1',
      quantity: 3,
      prorationBehavior: 'always_invoice' as const,
      idempotencyKey: 'move_r_b',
    }
    expect(await stripe.setSeatQuantity(input)).toBe('updated')
    expect(calls[1]!.key).toBe('move_r_b')
    expect(Object.fromEntries(calls[1]!.body)).toMatchObject({
      'items[0][id]': 'si_seat',
      'items[0][quantity]': '3',
      proration_behavior: 'always_invoice',
    })
    expect(await stripe.setSeatQuantity({ ...input, quantity: 2 })).toBe('unchanged')
    expect(calls).toHaveLength(3)
  })

  test('none refuses them without a network call', async () => {
    await expect(noneBillingProvider.refundInvoice(refund)).rejects.toThrow('billing is off')
    await expect(
      noneBillingProvider.setSeatQuantity({
        subscriptionId: 's',
        quantity: 1,
        prorationBehavior: 'none',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('billing is off')
  })
})

describe('stripe trial Checkout (docs/billing.md §3.2, §2.4)', () => {
  const pmcList = (data: unknown[], has_more = false) => [200, { object: 'list', data, has_more }] as [number, unknown]
  const pmc = (id: string, name = 'Linedesk Checkout') => ({
    id,
    object: 'payment_method_configuration',
    name,
    active: true,
    parent: null,
    is_default: false,
  })

  test('the card-only configuration is found on a later page (review of #876, I2)', async () => {
    let page = 0
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/payment_method_configurations': () =>
        ++page === 1
          ? pmcList(
              Array.from({ length: 100 }, (_, i) => pmc(`pmc_other${i}`, `Other ${i}`)),
              true,
            )
          : pmcList([pmc('pmc_own')]),
    })
    expect(await (await stripeWith(doFetch)).checkoutPaymentMethodConfiguration()).toBe('pmc_own')
    expect(calls.filter(c => c.route === 'GET /v1/payment_method_configurations')).toHaveLength(2)
  })

  test('a key that may not read the configurations is our setup, not the owner’s problem (I2)', async () => {
    const { doFetch } = stripeRoutes({
      'GET /v1/payment_method_configurations': () => [
        403,
        { error: { type: 'invalid_request_error', code: 'secret_key_required', message: 'restricted key' } },
      ],
    })
    const error = await (await stripeWith(doFetch)).checkoutPaymentMethodConfiguration().catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
  })

  const session = { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }
  const base = {
    billId: 'bill_1',
    customerId: 'cus_1',
    paymentMethodConfiguration: 'pmc_own',
    catalog: CATALOG,
    // What the last catalog sync stored (an admin's save): Checkout uses these ids and never makes prices.
    prices: { ws_yearly: 'price_ws_yearly' },
    submitText: 'Cancel before day 14 and you pay nothing.',
    successUrl: 'https://app.example.com/billing/return?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.example.com/',
    idempotencyKey: 'bill_1:checkout:1',
    expiresAt: 1_900_000_000,
  }

  test('a trial: the card-only configuration, never payment_method_types or setup_future_usage; tax, address, terms', async () => {
    const { doFetch, calls } = stripeRoutes({
      ...catalogRoutes(),
      'POST /v1/checkout/sessions': () => [200, session],
    })
    const started = await (await stripeWith(doFetch)).startCheckout({
      ...base,
      kind: 'trial',
      items: [{ lookupKey: 'ws_yearly', quantity: 1 }],
      trialDays: 14,
    })
    expect(started).toEqual({ id: 'cs_test_1', url: session.url })
    const create = calls.find(c => c.route === 'POST /v1/checkout/sessions')!
    expect(create.key).toBe('bill_1:checkout:1')
    const body = Object.fromEntries(create.body)
    expect(body).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: 'bill_1',
      payment_method_configuration: 'pmc_own',
      payment_method_collection: 'always',
      'line_items[0][price]': 'price_ws_yearly',
      'line_items[0][quantity]': '1',
      'subscription_data[trial_period_days]': '14',
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
      'automatic_tax[enabled]': 'true',
      billing_address_collection: 'required',
      'customer_update[address]': 'auto',
      'customer_update[name]': 'auto',
      'tax_id_collection[enabled]': 'true',
      'consent_collection[terms_of_service]': 'required',
      'metadata[linedesk_checkout]': 'trial',
      expires_at: '1900000000',
    })
    expect(Object.keys(body).some(k => k.startsWith('payment_method_types'))).toBe(false)
    expect(Object.keys(body).some(k => k.includes('setup_future_usage'))).toBe(false)
    // The synced price ids only: no product or price is read or written at Checkout (review of #1040, M-1).
    expect(calls.map(c => c.route)).toEqual(['POST /v1/checkout/sessions'])
  })

  test('the install’s name and color at the top of Checkout (branding_settings); the stated text; no logo', async () => {
    const { doFetch, calls } = stripeRoutes({ ...catalogRoutes(), 'POST /v1/checkout/sessions': () => [200, session] })
    await (await stripeWith(doFetch)).startCheckout({
      ...base,
      kind: 'plan',
      items: [{ lookupKey: 'ws_yearly', quantity: 1 }],
      branding: { displayName: 'Front Desk', buttonColor: '#112233' },
    })
    const body = Object.fromEntries(calls.find(c => c.route === 'POST /v1/checkout/sessions')!.body)
    expect(body).toMatchObject({
      'branding_settings[display_name]': 'Front Desk',
      'branding_settings[button_color]': '#112233',
      'custom_text[submit][message]': base.submitText,
      'consent_collection[terms_of_service]': 'required',
    })
    expect(Object.keys(body).some(k => k.startsWith('branding_settings[logo]'))).toBe(false)
    // A color that is not a hex color is left out, never sent for Stripe to refuse the session.
    const odd = stripeRoutes({ ...catalogRoutes(), 'POST /v1/checkout/sessions': () => [200, session] })
    await (await stripeWith(odd.doFetch)).startCheckout({
      ...base,
      kind: 'plan',
      items: [{ lookupKey: 'ws_yearly', quantity: 1 }],
      branding: { displayName: 'Front Desk', buttonColor: 'red' },
    })
    const oddBody = Object.fromEntries(odd.calls.find(c => c.route === 'POST /v1/checkout/sessions')!.body)
    expect(oddBody['branding_settings[button_color]']).toBeUndefined()
  })

  test("expireOpenCheckouts expires the customer's open sessions; one completed meanwhile (400) is skipped", async () => {
    const open = (id: string) => ({ id, object: 'checkout.session', status: 'open' })
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/checkout/sessions': () => [200, { object: 'list', has_more: false, data: [open('cs_a'), open('cs_b')] }],
      'POST /v1/checkout/sessions/cs_a/expire': () => [200, { ...open('cs_a'), status: 'expired' }],
      'POST /v1/checkout/sessions/cs_b/expire': () => [
        400,
        { error: { type: 'invalid_request_error', message: 'This session is complete.' } },
      ],
    })
    expect(await (await stripeWith(doFetch)).expireOpenCheckouts('cus_1')).toBe(1)
    expect(calls.map(c => c.route)).toEqual([
      'GET /v1/checkout/sessions',
      'POST /v1/checkout/sessions/cs_a/expire',
      'POST /v1/checkout/sessions/cs_b/expire',
    ])
  })

  test("customerPurchases finds the customer's running subscription and a completed payment, as Stripe has them (V-1)", async () => {
    const sub = (id: string, status: string) => ({ id, object: 'subscription', status })
    const done = (id: string, mode: string) => ({ id, object: 'checkout.session', status: 'complete', mode })
    const lists = (subs: unknown[], sessions: unknown[]) =>
      stripeRoutes({
        'GET /v1/subscriptions': () => [200, { object: 'list', has_more: false, data: subs }],
        'GET /v1/checkout/sessions': () => [200, { object: 'list', has_more: false, data: sessions }],
      })
    const running = lists(
      [sub('sub_gone', 'canceled'), sub('sub_expired', 'incomplete_expired'), sub('sub_run', 'active')],
      [done('cs_trial', 'subscription'), done('cs_topup', 'payment')],
    )
    expect(await (await stripeWith(running.doFetch)).customerPurchases('cus_1')).toEqual({
      subscriptionId: 'sub_run',
      checkoutSessionId: 'cs_topup',
    })
    const query = running.calls.map(c => [c.route, Object.fromEntries(c.url.searchParams)])
    expect(query).toEqual([
      ['GET /v1/subscriptions', { customer: 'cus_1', status: 'all', limit: '100' }],
      ['GET /v1/checkout/sessions', { customer: 'cus_1', status: 'complete', limit: '100' }],
    ])
    for (const status of ['trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
      const one = lists([sub('sub_x', status)], [])
      expect((await (await stripeWith(one.doFetch)).customerPurchases('cus_1')).subscriptionId).toBe('sub_x')
    }
    // A refused trial: its Checkout completed, its subscription canceled. Nothing to keep.
    const refused = lists([sub('sub_gone', 'canceled')], [done('cs_trial', 'subscription')])
    expect(await (await stripeWith(refused.doFetch)).customerPurchases('cus_1')).toEqual({
      subscriptionId: null,
      checkoutSessionId: null,
    })
  })

  test('customerPurchases: every error throws, a customer Stripe does not know (404) too; never "nothing"', async () => {
    const missing = stripeRoutes({})
    await expect((await stripeWith(missing.doFetch)).customerPurchases('cus_1')).rejects.toBeInstanceOf(
      BillingSetupError,
    )
    const down = stripeRoutes({ 'GET /v1/subscriptions': () => [500, { error: { type: 'api_error' } }] })
    await expect((await stripeWith(down.doFetch)).customerPurchases('cus_1')).rejects.toThrow()
    const refused = stripeRoutes({
      'GET /v1/subscriptions': () => [200, { object: 'list', has_more: false, data: [] }],
      'GET /v1/checkout/sessions': () => [403, { error: { type: 'invalid_request_error', message: 'no permission' } }],
    })
    await expect((await stripeWith(refused.doFetch)).customerPurchases('cus_1')).rejects.toBeInstanceOf(
      BillingSetupError,
    )
  })

  test('deleteCustomer deletes the customer; one already gone (404) is fine, any other error throws', async () => {
    const gone = stripeRoutes({
      'DELETE /v1/customers/cus_1': () => [200, { id: 'cus_1', object: 'customer', deleted: true }],
    })
    await (await stripeWith(gone.doFetch)).deleteCustomer('cus_1')
    expect(gone.calls.map(c => c.route)).toEqual(['DELETE /v1/customers/cus_1'])
    const missing = stripeRoutes({})
    await expect((await stripeWith(missing.doFetch)).deleteCustomer('cus_1')).resolves.toBeUndefined()
    const down = stripeRoutes({ 'DELETE /v1/customers/cus_1': () => [500, { error: { type: 'api_error' } }] })
    await expect((await stripeWith(down.doFetch)).deleteCustomer('cus_1')).rejects.toThrow()
  })

  test('a top-up: a payment built on the server with our product and the pre-tax amount', async () => {
    const { doFetch, calls } = stripeRoutes({ ...catalogRoutes(), 'POST /v1/checkout/sessions': () => [200, session] })
    await (await stripeWith(doFetch)).startCheckout({ ...base, kind: 'topup', amountCents: 2000 })
    // The catalog was found as it is: nothing in Stripe was made or changed.
    expect(calls.filter(c => c.route.startsWith('POST') && !c.route.includes('checkout'))).toEqual([])
    const body = Object.fromEntries(calls.find(c => c.route === 'POST /v1/checkout/sessions')!.body)
    expect(body).toMatchObject({
      mode: 'payment',
      payment_method_configuration: 'pmc_own',
      'line_items[0][price_data][product]': 'linedesk_balance_topup',
      'line_items[0][price_data][unit_amount]': '2000',
      'line_items[0][price_data][tax_behavior]': 'exclusive',
      'metadata[linedesk_checkout]': 'topup',
    })
    expect(Object.keys(body).some(k => k.startsWith('payment_method_types'))).toBe(false)
  })

  test('a top-up with a key that may only read Products and Prices: only its own product is read, Checkout starts (M-1)', async () => {
    const readOnly = { error: { type: 'invalid_request_error', code: 'secret_key_required', message: 'restricted' } }
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/products/linedesk_balance_topup': () => [
        200,
        { id: 'linedesk_balance_topup', object: 'product', name: 'Old name', active: true },
      ],
      'POST /v1/products/linedesk_balance_topup': () => [403, readOnly],
      'POST /v1/prices': () => [403, readOnly],
      'POST /v1/checkout/sessions': () => [200, session],
    })
    const started = await (await stripeWith(doFetch)).startCheckout({
      ...base,
      prices: undefined,
      kind: 'topup',
      amountCents: 2000,
    })
    expect(started.id).toBe('cs_test_1')
    expect(calls.map(c => c.route)).toEqual(['GET /v1/products/linedesk_balance_topup', 'POST /v1/checkout/sessions'])
    // Missing in the account: made once, by our id.
    const fresh = stripeRoutes({
      'POST /v1/products': () => [200, { id: 'linedesk_balance_topup', object: 'product' }],
      'POST /v1/checkout/sessions': () => [200, session],
    })
    await (await stripeWith(fresh.doFetch)).startCheckout({ ...base, kind: 'topup', amountCents: 2000 })
    expect(fresh.calls.map(c => [c.route, c.key])).toEqual([
      ['GET /v1/products/linedesk_balance_topup', null],
      ['POST /v1/products', 'catalog:product:linedesk_balance_topup'],
      ['POST /v1/checkout/sessions', 'bill_1:checkout:1'],
    ])
  })

  test('syncCatalog answers the price ids; a key that may not write Products or Prices is our setup (M-1)', async () => {
    const synced = stripeRoutes(catalogRoutes())
    expect(await (await stripeWith(synced.doFetch)).syncCatalog(CATALOG)).toEqual({ ws_yearly: 'price_ws_yearly' })
    const noPrice = stripeRoutes({
      ...catalogRoutes(),
      'GET /v1/prices': () => [200, { object: 'list', has_more: false, data: [] }],
      'POST /v1/prices': () => [403, { error: { type: 'invalid_request_error', message: 'restricted key' } }],
    })
    const error = await (await stripeWith(noPrice.doFetch)).syncCatalog(CATALOG).catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
    expect(error.code).toBe('stripe_403')
  })

  test('a plan never synced, a lookup key outside the synced prices, or a 400, is our setup', async () => {
    const never = stripeRoutes({ 'POST /v1/checkout/sessions': () => [200, session] })
    const error = await (await stripeWith(never.doFetch))
      .startCheckout({ ...base, prices: undefined, kind: 'plan', items: [{ lookupKey: 'ws_yearly', quantity: 1 }] })
      .catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
    expect(error.code).toBe('stripe_catalog_not_synced')
    expect(never.calls).toEqual([])
    const unknown = stripeRoutes({ ...catalogRoutes(), 'POST /v1/checkout/sessions': () => [200, session] })
    const notSold = await (await stripeWith(unknown.doFetch))
      .startCheckout({ ...base, kind: 'plan', items: [{ lookupKey: 'ws_monthly', quantity: 1 }] })
      .catch(e => e)
    expect(notSold).toBeInstanceOf(BillingSetupError)
    expect(unknown.calls.some(c => c.route === 'POST /v1/checkout/sessions')).toBe(false)
    const refused = stripeRoutes({
      ...catalogRoutes(),
      'POST /v1/checkout/sessions': () => [
        400,
        { error: { type: 'invalid_request_error', code: 'parameter_invalid' } },
      ],
    })
    const second = await (await stripeWith(refused.doFetch))
      .startCheckout({ ...base, kind: 'topup', amountCents: 500 })
      .catch(e => e)
    expect(second).toBeInstanceOf(BillingSetupError)
  })

  test('a session reads the trial card’s fingerprint and funding; a plan’s charge gives Radar’s risk level', async () => {
    const trialing = {
      id: 'cs_test_1',
      object: 'checkout.session',
      livemode: false,
      mode: 'subscription',
      status: 'complete',
      payment_status: 'no_payment_required',
      customer: 'cus_1',
      client_reference_id: 'bill_1',
      metadata: { linedesk_checkout: 'trial' },
      amount_subtotal: 0,
      currency: 'usd',
      payment_intent: null,
      subscription: {
        ...subscription({
          id: 'pm_1',
          object: 'payment_method',
          type: 'card',
          card: { fingerprint: 'fp_1', funding: 'prepaid', country: 'US' },
        }),
        status: 'trialing',
        cancel_at_period_end: false,
        trial_end: 1_800_000_000,
        latest_invoice: 'in_0',
      },
    }
    const { doFetch } = stripeRoutes({ 'GET /v1/checkout/sessions/cs_test_1': () => [200, trialing] })
    const read = await (await stripeWith(doFetch)).checkoutSession('cs_test_1')
    expect(read).toMatchObject({
      mode: 'subscription',
      status: 'complete',
      customerId: 'cus_1',
      clientReferenceId: 'bill_1',
      kind: 'trial',
      card: { fingerprint: 'fp_1', funding: 'prepaid', country: 'US' },
      riskLevel: null,
      subscription: { id: 'sub_1', status: 'trialing' },
    })
    const paid = stripeRoutes({
      'GET /v1/checkout/sessions/cs_test_1': () => [
        200,
        {
          ...trialing,
          metadata: { linedesk_checkout: 'plan' },
          subscription: { ...trialing.subscription, status: 'active' },
        },
      ],
      'GET /v1/invoice_payments': () => [
        200,
        {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'inpay_1',
              object: 'invoice_payment',
              status: 'paid',
              payment: {
                type: 'payment_intent',
                payment_intent: {
                  id: 'pi_1',
                  object: 'payment_intent',
                  latest_charge: { id: 'ch_1', object: 'charge', paid: true, outcome: { risk_level: 'elevated' } },
                  payment_method: null,
                },
              },
            },
          ],
        },
      ],
    })
    expect(await (await stripeWith(paid.doFetch)).checkoutSession('cs_test_1')).toMatchObject({ riskLevel: 'elevated' })
    // A session Stripe does not know.
    expect(await (await stripeWith(stripeRoutes({}).doFetch)).checkoutSession('cs_test_x')).toBeNull()
  })

  test('cancel now refuses nothing twice; at the period end and resume flip cancel_at_period_end', async () => {
    const sub = (over: Record<string, unknown>) => ({
      ...subscription(null),
      status: 'trialing',
      cancel_at_period_end: false,
      trial_end: null,
      ...over,
    })
    const now = stripeRoutes({
      'GET /v1/subscriptions/sub_1': () => [200, sub({})],
      'DELETE /v1/subscriptions/sub_1': () => [200, sub({ status: 'canceled' })],
    })
    // DELETE sends its parameters in the query string.
    const urls: string[] = []
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      return now.doFetch(input, init)
    }) as typeof fetch
    expect(await (await stripeWith(recording)).cancelSubscription('sub_1', { now: true })).toMatchObject({
      status: 'canceled',
    })
    const cancel = new URL(urls.find(u => u.includes('/v1/subscriptions/sub_1?'))!)
    expect(Object.fromEntries(cancel.searchParams)).toMatchObject({ invoice_now: 'false', prorate: 'false' })
    const already = stripeRoutes({ 'GET /v1/subscriptions/sub_1': () => [200, sub({ status: 'canceled' })] })
    await (await stripeWith(already.doFetch)).cancelSubscription('sub_1', { now: true })
    expect(already.calls.map(c => c.route)).toEqual(['GET /v1/subscriptions/sub_1'])
    const later = stripeRoutes({
      'GET /v1/subscriptions/sub_1': () => [200, sub({})],
      'POST /v1/subscriptions/sub_1': body => [
        200,
        sub({ cancel_at_period_end: body.get('cancel_at_period_end') === 'true' }),
      ],
    })
    expect(await (await stripeWith(later.doFetch)).cancelSubscription('sub_1', { now: false })).toMatchObject({
      cancelAtPeriodEnd: true,
    })
    const resumed = stripeRoutes({
      'GET /v1/subscriptions/sub_1': () => [200, sub({ cancel_at_period_end: true })],
      'POST /v1/subscriptions/sub_1': body => [
        200,
        sub({ cancel_at_period_end: body.get('cancel_at_period_end') === 'true' }),
      ],
    })
    expect(await (await stripeWith(resumed.doFetch)).resumeSubscription('sub_1')).toMatchObject({
      cancelAtPeriodEnd: false,
    })
  })

  test('none starts nothing', async () => {
    await expect(noneBillingProvider.startCheckout({ ...base, kind: 'topup', amountCents: 500 })).rejects.toThrow(
      'billing is off',
    )
    expect(await noneBillingProvider.checkoutSession('cs_test_1')).toBeNull()
  })
})

describe('stripe customer portal (Settings › Billing, docs/billing.md §2.4)', () => {
  const configs = (data: unknown[]) => ({
    object: 'list',
    data,
    has_more: false,
    url: '/v1/billing_portal/configurations',
  })
  const DESIGN_FEATURES = {
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  }
  const config = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    object: 'billing_portal.configuration',
    active: true,
    metadata: { linedesk: 'portal' },
    business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
    default_return_url: null,
    features: DESIGN_FEATURES,
    ...extra,
  })
  const withCancel = { features: { ...DESIGN_FEATURES, subscription_cancel: { enabled: true } } }

  test('a portal that offers cancel (switched on in the Dashboard) is switched back before the session; a key that may not: no session', async () => {
    const fixed = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [200, configs([config('bpc_own', withCancel)])],
      'POST /v1/billing_portal/configurations/bpc_own': () => [200, config('bpc_own')],
      'POST /v1/billing_portal/sessions': () => [
        200,
        { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' },
      ],
    })
    await (await stripeWith(fixed.doFetch)).portalSession({ customerId: 'cus_1', returnUrl: 'https://app.test/' })
    const update = fixed.calls.find(c => c.route === 'POST /v1/billing_portal/configurations/bpc_own')!
    expect(Object.fromEntries(update.body)).toEqual({
      'features[subscription_cancel][enabled]': 'false',
      'features[subscription_update][enabled]': 'false',
    })
    const refused = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [200, configs([config('bpc_own', withCancel)])],
      'POST /v1/billing_portal/configurations/bpc_own': () => [
        403,
        { error: { type: 'invalid_request_error', message: 'restricted key' } },
      ],
    })
    const error = await (await stripeWith(refused.doFetch))
      .portalSession({ customerId: 'cus_1', returnUrl: 'https://app.test/' })
      .catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
    expect(error.code).toBe('portal_allows_cancel')
    expect(refused.calls.some(c => c.route === 'POST /v1/billing_portal/sessions')).toBe(false)
  })

  test('syncPortal keeps the design: cancel off, the install’s headline and links; nothing written when it fits', async () => {
    const design = { headline: 'Front Desk', termsUrl: 'https://fd.test/terms', privacyUrl: 'https://fd.test/privacy' }
    const drift = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [200, configs([config('bpc_own', withCancel)])],
      'POST /v1/billing_portal/configurations/bpc_own': () => [200, config('bpc_own')],
    })
    expect(await (await stripeWith(drift.doFetch)).syncPortal(design)).toEqual({
      configuration: 'bpc_own',
      changed: true,
    })
    const body = Object.fromEntries(
      drift.calls.find(c => c.route === 'POST /v1/billing_portal/configurations/bpc_own')!.body,
    )
    expect(body).toMatchObject({
      'features[subscription_cancel][enabled]': 'false',
      'features[subscription_update][enabled]': 'false',
      'business_profile[headline]': 'Front Desk',
      'business_profile[terms_of_service_url]': 'https://fd.test/terms',
    })
    const fits = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [
        200,
        configs([
          config('bpc_own', {
            business_profile: {
              headline: 'Front Desk',
              terms_of_service_url: 'https://fd.test/terms',
              privacy_policy_url: 'https://fd.test/privacy',
            },
          }),
        ]),
      ],
    })
    expect(await (await stripeWith(fits.doFetch)).syncPortal(design)).toEqual({
      configuration: 'bpc_own',
      changed: false,
    })
    expect(fits.calls.filter(c => c.route.startsWith('POST'))).toEqual([])
    // A Stripe account shared by installs: another install's headline and links are kept, only the features fixed.
    const shared = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [
        200,
        configs([
          config('bpc_own', {
            ...withCancel,
            business_profile: {
              headline: 'Other Desk',
              terms_of_service_url: 'https://other.test/terms',
              privacy_policy_url: 'https://other.test/privacy',
            },
          }),
        ]),
      ],
      'POST /v1/billing_portal/configurations/bpc_own': () => [200, config('bpc_own')],
    })
    expect(await (await stripeWith(shared.doFetch)).syncPortal(design)).toMatchObject({ changed: true })
    const sharedBody = Object.fromEntries(
      shared.calls.find(c => c.route === 'POST /v1/billing_portal/configurations/bpc_own')!.body,
    )
    expect(sharedBody).toMatchObject({ 'features[subscription_cancel][enabled]': 'false' })
    expect(Object.keys(sharedBody).filter(k => k.startsWith('business_profile'))).toEqual([])
    const denied = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [200, configs([config('bpc_own', withCancel)])],
      'POST /v1/billing_portal/configurations/bpc_own': () => [403, { error: { type: 'invalid_request_error' } }],
    })
    const error = await (await stripeWith(denied.doFetch)).syncPortal(design).catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
  })

  test('the provider test’s checks: terms URL (a setup session made and expired) and portal write access', async () => {
    const noTerms = stripeRoutes({
      'POST /v1/checkout/sessions': () => [
        400,
        {
          error: {
            type: 'invalid_request_error',
            message: 'You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard.',
          },
        },
      ],
    })
    expect(await (await stripeWith(noTerms.doFetch)).checkoutTermsReady('https://app.linedesk.test')).toBe(false)
    const ready = stripeRoutes({
      'POST /v1/checkout/sessions': () => [200, { id: 'cs_test_probe', object: 'checkout.session' }],
      'POST /v1/checkout/sessions/cs_test_probe/expire': () => [200, { id: 'cs_test_probe' }],
    })
    expect(await (await stripeWith(ready.doFetch)).checkoutTermsReady('https://app.linedesk.test')).toBe(true)
    const made = Object.fromEntries(ready.calls.find(c => c.route === 'POST /v1/checkout/sessions')!.body)
    expect(made).toMatchObject({
      mode: 'setup',
      'consent_collection[terms_of_service]': 'required',
      success_url: 'https://app.linedesk.test',
    })
    expect(ready.calls.some(c => c.route === 'POST /v1/checkout/sessions/cs_test_probe/expire')).toBe(true)
    const noWrite = stripeRoutes({
      'POST /v1/billing_portal/configurations/bpc_linedesk_permission_check': () => [
        403,
        { error: { type: 'invalid_request_error' } },
      ],
    })
    expect(await (await stripeWith(noWrite.doFetch)).portalWriteAccess()).toBe(false)
    const canWrite = stripeRoutes({
      'POST /v1/billing_portal/configurations/bpc_linedesk_permission_check': () => [
        404,
        { error: { type: 'invalid_request_error', code: 'resource_missing' } },
      ],
    })
    expect(await (await stripeWith(canWrite.doFetch)).portalWriteAccess()).toBe(true)
  })

  test('a session uses the configuration the bootstrap made (found by its metadata) and returns to the page', async () => {
    const { doFetch, calls } = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [
        200,
        configs([config('bpc_other', { metadata: {} }), config('bpc_off', { active: false }), config('bpc_own')]),
      ],
      'POST /v1/billing_portal/sessions': () => [
        200,
        { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' },
      ],
    })
    const url = await (await stripeWith(doFetch)).portalSession({
      customerId: 'cus_1',
      returnUrl: 'https://app.linedesk.test/#workspace/billing?ws=ws_1',
    })
    expect(url).toBe('https://billing.stripe.com/p/session/test_1')
    const made = calls.find(c => c.route === 'POST /v1/billing_portal/sessions')!
    expect(Object.fromEntries(made.body)).toEqual({
      customer: 'cus_1',
      configuration: 'bpc_own',
      return_url: 'https://app.linedesk.test/#workspace/billing?ws=ws_1',
    })
  })

  test('no configuration (the bootstrap did not run) or a key that may not make sessions: our setup, no session', async () => {
    const none = stripeRoutes({ 'GET /v1/billing_portal/configurations': () => [200, configs([])] })
    const missing = await (await stripeWith(none.doFetch))
      .portalSession({ customerId: 'cus_1', returnUrl: 'https://app.linedesk.test/' })
      .catch(e => e)
    expect(missing).toBeInstanceOf(BillingSetupError)
    expect(missing.code).toBe('portal_configuration_missing')
    expect(none.calls.some(c => c.route === 'POST /v1/billing_portal/sessions')).toBe(false)
    const refused = stripeRoutes({
      'GET /v1/billing_portal/configurations': () => [200, configs([config('bpc_own')])],
      'POST /v1/billing_portal/sessions': () => [
        403,
        { error: { type: 'invalid_request_error', code: 'secret_key_required', message: 'restricted key' } },
      ],
    })
    const error = await (await stripeWith(refused.doFetch))
      .portalSession({ customerId: 'cus_1', returnUrl: 'https://app.linedesk.test/' })
      .catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
  })

  test('none opens no portal', async () => {
    await expect(noneBillingProvider.portalSession({ customerId: 'cus_1', returnUrl: 'x' })).rejects.toThrow(
      'billing is off',
    )
  })
})

describe('webhooks', () => {
  const SECRET = ['whsec', 'MadeUpSigningSecret0123'].join('_')
  const OLD = ['whsec', 'MadeUpOldSecret0123'].join('_')
  const body = (livemode = false, apiVersion: string = STRIPE_API_VERSION) =>
    JSON.stringify({
      id: 'evt_1Test',
      object: 'event',
      type: 'invoice.paid',
      livemode,
      api_version: apiVersion,
      created: 1_800_000_000,
      data: { object: { id: 'in_1Test', object: 'invoice', customer: 'cus_1Test' } },
    })
  const now = () => Math.floor(Date.now() / 1000)
  /** Stripe's scheme, built here independently of the SDK: HMAC-SHA256 over "<t>.<body>". */
  const sign = (payload: string, secret: string, at = now()) =>
    `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`
  const stripeWith = (keys: Partial<StripeKeys> = {}) =>
    loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: SECRET, ...keys }, recordingFetch(200, {}).doFetch)

  test('an event carries our own ids as hints (metadata, client_reference_id, a subscription invoice’s parent)', async () => {
    const signed = (object: Record<string, unknown>) => {
      const payload = JSON.stringify({ ...JSON.parse(body()), data: { object } })
      return [new TextEncoder().encode(payload), sign(payload, SECRET)] as const
    }
    const provider = await stripeWith()
    expect(
      provider.webhookEvent(...signed({ id: 'cus_X', object: 'customer', metadata: { billing_account_id: 'bill_1' } })),
    ).toMatchObject({ customerId: 'cus_X', billHint: 'bill_1', rechargeHint: null })
    expect(
      provider.webhookEvent(...signed({ id: 'cs_X', object: 'checkout.session', client_reference_id: 'bill_2' })),
    ).toMatchObject({ billHint: 'bill_2' })
    expect(
      provider.webhookEvent(
        ...signed({
          id: 'in_X',
          object: 'invoice',
          customer: 'cus_X',
          metadata: { billing_recharge_id: 'rc_1' },
          parent: { subscription_details: { metadata: { billing_account_id: 'bill_3' } } },
        }),
      ),
    ).toMatchObject({ billHint: 'bill_3', rechargeHint: 'rc_1' })
    // Another integration's customer: no hints.
    expect(provider.webhookEvent(...signed({ id: 'ch_X', object: 'charge', customer: 'cus_Z' }))).toMatchObject({
      customerId: 'cus_Z',
      billHint: null,
      rechargeHint: null,
    })
  })

  test('our signature matches the SDK’s own test header, and the event reads its object and customer', async () => {
    const payload = body()
    const at = now()
    expect(sign(payload, SECRET, at)).toBe(
      Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: at }),
    )
    const event = (await stripeWith()).webhookEvent(new TextEncoder().encode(payload), sign(payload, SECRET))
    expect(event).toMatchObject({
      id: 'evt_1Test',
      type: 'invoice.paid',
      livemode: false,
      objectId: 'in_1Test',
      customerId: 'cus_1Test',
    })
  })

  test('the previous secret is accepted only when given; a stranger’s, an old or a changed one never', async () => {
    const payload = new TextEncoder().encode(body())
    const plain = await stripeWith()
    expect(() => plain.webhookEvent(payload, sign(body(), OLD))).toThrow(WebhookRefused)
    expect((await stripeWith({ webhookSecretPrevious: OLD })).webhookEvent(payload, sign(body(), OLD)).id).toBe(
      'evt_1Test',
    )
    expect(() => plain.webhookEvent(payload, sign(body(), SECRET, now() - 301))).toThrow(WebhookRefused)
    expect(() => plain.webhookEvent(new TextEncoder().encode(`${body()} `), sign(body(), SECRET))).toThrow(
      WebhookRefused,
    )
  })

  test('a live event on a test key is refused, an event of another API version is taken, `none` refuses everything', async () => {
    const live = body(true)
    try {
      ;(await stripeWith()).webhookEvent(new TextEncoder().encode(live), sign(live, SECRET))
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ reason: 'livemode' })
    }
    // Signed, in the account's default version (`stripe listen`, an endpoint made by hand): taken, with what every
    // version has; the objects are fetched again at the adapter's version.
    const other = body(false, '2026-10-28.endive')
    expect((await stripeWith()).webhookEvent(new TextEncoder().encode(other), sign(other, SECRET))).toMatchObject({
      id: 'evt_1Test',
      objectId: 'in_1Test',
      customerId: 'cus_1Test',
      apiVersion: '2026-10-28.endive',
    })
    expect(() => noneBillingProvider.webhookEvent(new TextEncoder().encode(body()), sign(body(), SECRET))).toThrow(
      WebhookRefused,
    )
  })
})

describe('fetching', () => {
  /** A recorded Stripe API: answers by path. */
  function routes(table: Record<string, unknown>) {
    const calls: string[] = []
    const doFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      calls.push(`${url.pathname}${url.search}`)
      const body = table[url.pathname]
      return new Response(
        JSON.stringify(
          body ?? { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such' } },
        ),
        { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    return { doFetch, calls }
  }
  const list = (data: unknown[], hasMore = false) => ({ object: 'list', data, has_more: hasMore, url: '/v1/x' })
  const line = (id: string, amount: number, kind: string, rechargeId?: string) => ({
    id,
    object: 'line_item',
    amount,
    currency: 'usd',
    parent: { type: kind },
    metadata: rechargeId ? { billing_recharge_id: rechargeId } : {},
  })

  test('an invoice with all its lines, its real payments, tax and subscription', async () => {
    const { doFetch, calls } = routes({
      '/v1/invoices/in_1': {
        id: 'in_1',
        object: 'invoice',
        livemode: false,
        customer: 'cus_1',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
        status: 'paid',
        billing_reason: 'subscription_cycle',
        currency: 'usd',
        total: 13_000,
        total_taxes: [{ amount: 100 }, { amount: 100 }],
        starting_balance: -500,
        amount_paid: 13_000,
        amount_paid_off_stripe: 0,
        metadata: {},
        lines: list([line('il_1', 10_800, 'subscription_item_details')], true),
        number: 'LD-1',
        period_start: 1_800_000_000,
        period_end: 1_800_000_000,
        hosted_invoice_url: null,
        invoice_pdf: null,
      },
      '/v1/invoices/in_1/lines': list([
        { ...line('il_1', 10_800, 'subscription_item_details'), discount_amounts: [{ amount: 300, discount: 'di_1' }] },
        {
          ...line('il_2', 2000, 'invoice_item_details', 'rc_1'),
          pretax_credit_amounts: [{ amount: 50, type: 'credit_balance_transaction' }],
        },
      ]),
      '/v1/invoice_payments': list([
        {
          id: 'inpay_1',
          object: 'invoice_payment',
          amount_paid: 12_000,
          status: 'paid',
          created: 10,
          payment: {
            type: 'payment_intent',
            payment_intent: { id: 'pi_1', object: 'payment_intent', status: 'succeeded' },
          },
        },
        {
          id: 'inpay_2',
          object: 'invoice_payment',
          amount_paid: 1000,
          status: 'paid',
          created: 20,
          payment: { type: 'payment_record', payment_record: 'pr_1' },
        },
        {
          id: 'inpay_3',
          object: 'invoice_payment',
          amount_paid: 0,
          status: 'failed',
          created: 5,
          payment: {
            type: 'payment_intent',
            payment_intent: { id: 'pi_0', object: 'payment_intent', status: 'requires_payment_method' },
          },
        },
      ]),
    })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    expect(await provider.invoice('in_1')).toMatchObject({
      id: 'in_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'paid',
      taxCents: 200,
      amountPaidCents: 13_000,
      // Only charges and payment intents are money that came in through Stripe.
      chargedCents: 12_000,
      startingBalanceCents: -500,
      paymentFailureCode: null,
      lines: [
        // Discounts and credits per line: a plan coupon is not the recharge's (recheck of #865, L-A).
        { id: 'il_1', amountCents: 10_800, kind: 'subscription', rechargeId: null, discountCents: 300 },
        { id: 'il_2', amountCents: 2000, kind: 'invoice_item', rechargeId: 'rc_1', discountCents: 50 },
      ],
      periodStart: new Date(1_800_000_000_000).toISOString(),
    })
    expect(calls.some(c => c.startsWith('/v1/invoice_payments?') && c.includes('invoice=in_1'))).toBe(true)
    expect(await provider.invoice('in_missing')).toBeNull()
  })

  test('a subscription: status, period from its items, interval, seats', async () => {
    const { doFetch } = routes({
      '/v1/subscriptions/sub_1': {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        trial_end: null,
        default_payment_method: 'pm_1',
        items: list([
          {
            id: 'si_1',
            object: 'subscription_item',
            quantity: 3,
            current_period_start: 1_800_000_000,
            current_period_end: 1_831_536_000,
            price: { id: 'price_1', object: 'price', lookup_key: 'ws_yearly', recurring: { interval: 'year' } },
          },
        ]),
      },
    })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    expect(await provider.subscription('sub_1')).toMatchObject({
      status: 'active',
      interval: 'year',
      defaultPaymentMethod: 'pm_1',
      currentPeriodEnd: new Date(1_831_536_000_000).toISOString(),
      items: [{ lookupKey: 'ws_yearly', quantity: 3 }],
    })
    expect(await provider.subscription('sub_missing')).toBeNull()
  })

  test('recent events: at most 20 types a request, merged oldest first', async () => {
    const { doFetch, calls } = routes({
      '/v1/events': list([
        {
          id: 'evt_2',
          object: 'event',
          type: 'invoice.paid',
          livemode: false,
          created: 20,
          data: { object: { id: 'in_2' } },
        },
        {
          id: 'evt_1',
          object: 'event',
          type: 'invoice.paid',
          livemode: false,
          created: 10,
          data: { object: { id: 'in_1' } },
        },
      ]),
    })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, doFetch)
    const { events, truncated } = await provider.recentEvents(5, WEBHOOK_EVENTS)
    expect(events.map(e => e.id)).toEqual(['evt_1', 'evt_2'])
    expect(events[0]).toMatchObject({ objectId: 'in_1', objectType: null })
    expect(events[0]).not.toHaveProperty('payload')
    expect(truncated).toBe(false)
    expect(calls).toHaveLength(Math.ceil(WEBHOOK_EVENTS.length / 20))
    // More than the limit: the newest are kept and the answer says so (security review of #865, L5).
    const capped = await provider.recentEvents(5, WEBHOOK_EVENTS, 1)
    expect(capped.events.map(e => e.id)).toEqual(['evt_2'])
    expect(capped.truncated).toBe(true)
  })

  test('a failed payment says why: the decline code, or authentication_required for 3DS', async () => {
    const invoice = (id: string) => ({
      id,
      object: 'invoice',
      livemode: false,
      customer: 'cus_1',
      parent: null,
      status: 'open',
      billing_reason: 'manual',
      currency: 'usd',
      total: 2000,
      total_taxes: [],
      amount_paid: 0,
      amount_paid_off_stripe: 0,
      metadata: { billing_recharge_id: 'rc_1' },
      lines: list([]),
      number: null,
      period_start: 1_800_000_000,
      period_end: 1_800_000_000,
    })
    const failed = (intent: Record<string, unknown>) =>
      list([
        {
          id: 'inpay_1',
          object: 'invoice_payment',
          amount_paid: 0,
          status: 'open',
          created: 10,
          payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', object: 'payment_intent', ...intent } },
        },
      ])
    const declined = routes({
      '/v1/invoices/in_1': invoice('in_1'),
      '/v1/invoice_payments': failed({
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
      }),
    })
    const provider = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, declined.doFetch)
    expect((await provider.invoice('in_1'))?.paymentFailureCode).toBe('insufficient_funds')
    const threeDs = routes({
      '/v1/invoices/in_1': invoice('in_1'),
      '/v1/invoice_payments': failed({ status: 'requires_action', last_payment_error: null }),
    })
    const provider3ds = await loadBillingProvider({ secretKey: TEST_KEY, webhookSecret: 'whsec_abc' }, threeDs.doFetch)
    expect((await provider3ds.invoice('in_1'))?.paymentFailureCode).toBe('authentication_required')
    // Stripe sends an empty decline code with some errors: the code is used then, never "" (billing review B3).
    const emptyDecline = routes({
      '/v1/invoices/in_1': invoice('in_1'),
      '/v1/invoice_payments': failed({
        status: 'requires_payment_method',
        last_payment_error: { code: 'missing', decline_code: '' },
      }),
    })
    const providerEmpty = await loadBillingProvider(
      { secretKey: TEST_KEY, webhookSecret: 'whsec_abc' },
      emptyDecline.doFetch,
    )
    expect((await providerEmpty.invoice('in_1'))?.paymentFailureCode).toBe('missing')
  })
})
