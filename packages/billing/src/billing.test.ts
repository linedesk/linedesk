// Contract tests of the billing adapters: `none` without a network call, `stripe` against recorded responses of
// GET /v1/account (the shape Stripe sends), never the network.
import { describe, expect, test } from 'vitest'
import { isStripeWebhookSecret, liveKeysAllowed, loadBillingProvider, noneBillingProvider, stripeKeyMode } from './index.ts'
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

describe('stripe recharges', () => {
  test('one invoice with one item, automatic tax, finalized and paid, each request with its own idempotency key', async () => {
    const { doFetch, calls } = stripeRoutes({
      'POST /v1/invoices': () => [200, invoice('draft', 0)],
      'POST /v1/invoiceitems': () => [200, { id: 'ii_1', object: 'invoiceitem' }],
      'POST /v1/invoices/in_1Rc/finalize': () => [200, invoice('open')],
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('paid')],
    })
    expect(await (await stripeWith(doFetch)).chargeRecharge(recharge)).toEqual({ status: 'paid', invoiceId: 'in_1Rc' })
    expect(calls.map(c => [c.route, c.key])).toEqual([
      ['POST /v1/invoices', 'rc_abc:invoice'],
      ['POST /v1/invoiceitems', 'rc_abc:item'],
      ['POST /v1/invoices/in_1Rc/finalize', 'rc_abc:finalize'],
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
      'POST /v1/invoices/in_1Rc/pay': () => [200, invoice('open')],
    })
    const stripe = await stripeWith(doFetch)
    expect(await stripe.chargeRecharge({ ...recharge, invoiceId: 'in_1Rc' })).toEqual({
      status: 'open',
      invoiceId: 'in_1Rc',
    })
    expect(calls.map(c => c.route)).toEqual(['GET /v1/invoices/in_1Rc', 'POST /v1/invoices/in_1Rc/pay'])
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

  test('none refuses every charge without a network call', async () => {
    await expect(noneBillingProvider.chargeRecharge(recharge)).rejects.toThrow('billing is off')
  })
})
