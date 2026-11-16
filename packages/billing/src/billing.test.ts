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
  const calls: { route: string; body: URLSearchParams; key: string | null }[] = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const route = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    calls.push({ route, body, key: header(init, 'idempotency-key') })
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
/** A card as Stripe expands it (`created` in Unix seconds). */
const card = (id: string, created = 1_800_000_000) => ({ id, object: 'payment_method', type: 'card', created })
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
  test('one invoice with one item, automatic tax, finalized and paid, each request with its own idempotency key', async () => {
    const { doFetch, calls } = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [200, invoice('open')],
      'GET /v1/customers/cus_1': () => [200, customer(card('pm_own'))],
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('paid')],
    })
    expect(await (await stripeWith(doFetch)).chargeRecharge(recharge)).toEqual({ status: 'paid', invoiceId: 'in_1Rc' })
    expect(calls.map(c => [c.route, c.key])).toEqual([
      ['POST /v1/invoices', 'rc_abc:invoice'],
      ['POST /v1/invoiceitems', 'rc_abc:item'],
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
    expect(Object.fromEntries(calls[1]!.body)).toMatchObject({
      invoice: 'in_1Rc',
      amount: '2000',
      currency: 'usd',
      tax_behavior: 'exclusive',
    })
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
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
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
        'GET /v1/invoices/in_1Rc': () => [200, invoice(route.endsWith('finalize') ? 'draft' : 'open', 2000)],
        [route]: () => [status, error],
      })
      const input = route === 'POST /v1/invoices' ? recharge : { ...recharge, invoiceId: 'in_1Rc' }
      const refused = (await stripeWith(doFetch)).chargeRecharge(input)
      await expect(refused).rejects.toBeInstanceOf(BillingSetupError)
      await expect(refused).rejects.toMatchObject({ code })
    },
  )

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
    ).toEqual({ id: 'pm_portal', createdAt: new Date(1_800_000_100_000).toISOString(), on: 'customer' })
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
    ).toEqual({ id: 'pm_checkout', createdAt: new Date(1_800_000_000_000).toISOString(), on: 'subscription' })
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

  test('a live event on a test key and an event of another API version are refused, and `none` refuses everything', async () => {
    const live = body(true)
    try {
      ;(await stripeWith()).webhookEvent(new TextEncoder().encode(live), sign(live, SECRET))
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ reason: 'livemode' })
    }
    // Signed, but in the account's default version: the endpoint is not pinned to the adapter's.
    const other = body(false, '2026-10-28.endive')
    try {
      ;(await stripeWith()).webhookEvent(new TextEncoder().encode(other), sign(other, SECRET))
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ reason: 'api_version', apiVersion: '2026-10-28.endive' })
    }
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
