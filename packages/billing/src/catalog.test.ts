// The install's catalog in its own Stripe account (stripe/catalog.ts, docs/billing.md §7b): products and plan prices
// made from the install's settings, found again, renamed, replaced when an amount changed; against a fake Stripe.
import Stripe from 'stripe'
import { describe, expect, test } from 'vitest'
import { BillingSetupError } from './provider.ts'
import { catalogWriteAccess, ensureCatalog, PROBE_IDS } from './stripe/catalog.ts'
import { STRIPE_API_VERSION } from './stripe/index.ts'

type Price = {
  id: string
  object: 'price'
  active: boolean
  lookup_key: string | null
  unit_amount: number
  currency: string
  tax_behavior: string
  product: string
  recurring: { interval: string; interval_count: number; usage_type: string }
  metadata: Record<string, string>
}

/**
 * A Stripe account with products and prices in memory; every request is recorded. Like Stripe, a POST with an
 * idempotency key seen before is answered with the first answer and changes nothing (a replay). `readOnly`: a
 * restricted key with read only on Products and Prices (every write to them is a 403).
 */
function fakeAccount({ readOnly = false } = {}) {
  const products = new Map<string, { id: string; object: 'product'; name: string; active: boolean }>()
  const prices: Price[] = []
  const calls: { route: string; body: URLSearchParams; key: string | null }[] = []
  const replays = new Map<string, string>()
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}`
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    const key = new Headers(init?.headers).get('idempotency-key')
    calls.push({ route, body, key })
    const reply = (status: number, json: unknown) =>
      new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && key && replays.has(key)) return reply(200, JSON.parse(replays.get(key)!))
    const answer = (status: number, json: unknown) => {
      if (method === 'POST' && key && status === 200) replays.set(key, JSON.stringify(json))
      return reply(status, json)
    }
    const [, , kind, id] = url.pathname.split('/')
    if (readOnly && method === 'POST' && (kind === 'products' || kind === 'prices'))
      return reply(403, {
        error: { type: 'invalid_request_error', code: 'secret_key_required', message: 'missing permission' },
      })
    if (method === 'POST' && id && (id === PROBE_IDS.product || id === PROBE_IDS.price))
      return reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } })
    if (kind === 'products' && id && method === 'GET') {
      const found = products.get(id)
      return found
        ? reply(200, found)
        : reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } })
    }
    if (kind === 'products' && !id && method === 'POST') {
      const made = { id: body.get('id')!, object: 'product' as const, name: body.get('name')!, active: true }
      products.set(made.id, made)
      return answer(200, made)
    }
    if (kind === 'products' && id && method === 'POST') {
      const found = products.get(id)!
      if (body.has('name')) found.name = body.get('name')!
      if (body.has('active')) found.active = body.get('active') === 'true'
      return reply(200, found)
    }
    if (kind === 'prices' && method === 'GET') {
      const keys = [...url.searchParams.entries()].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v)
      const data = prices.filter(p => p.active && p.lookup_key && keys.includes(p.lookup_key))
      return reply(200, { object: 'list', has_more: false, data })
    }
    if (kind === 'prices' && method === 'POST') {
      const lookupKey = body.get('lookup_key')
      if (body.get('transfer_lookup_key') === 'true')
        for (const p of prices) if (p.lookup_key === lookupKey) p.lookup_key = null
      const made: Price = {
        id: `price_${prices.length + 1}`,
        object: 'price',
        active: true,
        lookup_key: lookupKey,
        unit_amount: Number(body.get('unit_amount')),
        currency: body.get('currency')!,
        tax_behavior: body.get('tax_behavior')!,
        product: body.get('product')!,
        recurring: { interval: body.get('recurring[interval]')!, interval_count: 1, usage_type: 'licensed' },
        metadata: { linedesk: body.get('metadata[linedesk]')! },
      }
      prices.push(made)
      return answer(200, made)
    }
    return reply(404, { error: { type: 'invalid_request_error', message: route } })
  }) as typeof fetch
  const stripe = new Stripe('sk_test_catalog', {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(doFetch),
    maxNetworkRetries: 0,
    telemetry: false,
  })
  const writes = () => calls.filter(c => c.route.startsWith('POST'))
  return { stripe, products, prices, calls, writes }
}

const catalog = (brand: string, monthly: number) => ({
  products: { workspace: `${brand} workspace`, balance_topup: 'Prepaid minutes' },
  prices: [
    { lookupKey: 'ws_monthly', product: 'workspace', cents: monthly, interval: 'month' as const },
    { lookupKey: 'ws_yearly', product: 'workspace', cents: 10_800, interval: 'year' as const },
  ],
  taxCode: 'txcd_10103001',
  currency: 'usd' as const,
})

describe('the install catalog in its own Stripe account', () => {
  test('an empty account gets the products and prices of the settings, with our ids, lookup keys and metadata', async () => {
    const account = fakeAccount()
    const prices = await ensureCatalog(account.stripe, catalog('Front Desk', 900))
    expect([...account.products.values()].map(p => [p.id, p.name])).toEqual([
      ['linedesk_workspace', 'Front Desk workspace'],
      ['linedesk_balance_topup', 'Prepaid minutes'],
    ])
    const made = account.writes().find(c => c.route === 'POST /v1/products')!
    expect(Object.fromEntries(made.body)).toMatchObject({
      tax_code: 'txcd_10103001',
      'metadata[linedesk]': 'workspace',
    })
    const monthly = account.prices.find(p => p.lookup_key === 'ws_monthly')!
    expect(monthly).toMatchObject({
      unit_amount: 900,
      currency: 'usd',
      tax_behavior: 'exclusive',
      product: 'linedesk_workspace',
      recurring: { interval: 'month' },
      metadata: { linedesk: 'ws_monthly' },
    })
    expect(prices.get('ws_monthly')).toBe(monthly.id)
    // Idempotency keys name everything the object is, so a parallel Checkout gets the same price back.
    const keys = account
      .writes()
      .filter(c => c.route === 'POST /v1/prices')
      .map(c => c.key)
    expect(keys).toEqual([
      'catalog:price:ws_monthly:linedesk_workspace:usd:month:900:from:none',
      'catalog:price:ws_yearly:linedesk_workspace:usd:year:10800:from:none',
    ])
  })

  test('a second run finds everything and writes nothing', async () => {
    const account = fakeAccount()
    const first = await ensureCatalog(account.stripe, catalog('Front Desk', 900))
    const before = account.writes().length
    expect(await ensureCatalog(account.stripe, catalog('Front Desk', 900))).toEqual(first)
    expect(account.writes()).toHaveLength(before)
  })

  test('a new product name renames the product; a new amount is a new price that takes the lookup key over', async () => {
    const account = fakeAccount()
    const first = await ensureCatalog(account.stripe, catalog('Linedesk', 1100))
    const old = account.prices.find(p => p.id === first.get('ws_monthly'))!
    const next = await ensureCatalog(account.stripe, catalog('Front Desk', 900))
    expect(account.products.get('linedesk_workspace')?.name).toBe('Front Desk workspace')
    expect(next.get('ws_monthly')).not.toBe(old.id)
    expect(account.prices.find(p => p.id === next.get('ws_monthly'))?.unit_amount).toBe(900)
    // The old price stays active for the subscriptions on it, without the lookup key, still known by its metadata.
    expect(old).toMatchObject({ active: true, lookup_key: null, metadata: { linedesk: 'ws_monthly' } })
    const replace = account
      .writes()
      .filter(c => c.route === 'POST /v1/prices')
      .at(-1)!
    expect(replace.body.get('transfer_lookup_key')).toBe('true')
    // The unchanged yearly price is kept.
    expect(next.get('ws_yearly')).toBe(first.get('ws_yearly'))
  })

  test('A → B → A makes a new price for A that takes the lookup key back, not a replay of the first A (L-2)', async () => {
    const account = fakeAccount()
    const a = await ensureCatalog(account.stripe, catalog('Front Desk', 1100))
    const b = await ensureCatalog(account.stripe, catalog('Front Desk', 900))
    const again = await ensureCatalog(account.stripe, catalog('Front Desk', 1100))
    expect(new Set([a.get('ws_monthly'), b.get('ws_monthly'), again.get('ws_monthly')]).size).toBe(3)
    const holder = account.prices.find(p => p.lookup_key === 'ws_monthly')!
    expect(holder).toMatchObject({ id: again.get('ws_monthly'), unit_amount: 1100 })
    // Settled: the next run finds the key on the $11 price and writes nothing.
    const before = account.writes().length
    expect((await ensureCatalog(account.stripe, catalog('Front Desk', 1100))).get('ws_monthly')).toBe(holder.id)
    expect(account.writes()).toHaveLength(before)
  })

  test("a lookup key held by another product's price is refused, never taken over (L-1)", async () => {
    const account = fakeAccount()
    account.prices.push({
      id: 'price_other_integration',
      object: 'price',
      active: true,
      lookup_key: 'ws_monthly',
      unit_amount: 2500,
      currency: 'usd',
      tax_behavior: 'exclusive',
      product: 'prod_SomeoneElse',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      metadata: {},
    })
    const error = await ensureCatalog(account.stripe, catalog('Front Desk', 900)).catch(e => e)
    expect(error).toBeInstanceOf(BillingSetupError)
    expect(error.code).toBe('stripe_lookup_key_taken:ws_monthly')
    expect(account.prices[0]).toMatchObject({ lookup_key: 'ws_monthly' })
    expect(account.writes().filter(c => c.route === 'POST /v1/prices')).toEqual([])
  })

  test('the write probe tells a key that may write Products and Prices from a read-only one, writing nothing', async () => {
    const writable = fakeAccount()
    expect(await catalogWriteAccess(writable.stripe)).toEqual({ products: true, prices: true })
    expect(writable.products.size + writable.prices.length).toBe(0)
    const readOnly = fakeAccount({ readOnly: true })
    expect(await catalogWriteAccess(readOnly.stripe)).toEqual({ products: false, prices: false })
    expect(readOnly.calls.map(c => c.route)).toEqual([
      `POST /v1/products/${PROBE_IDS.product}`,
      `POST /v1/prices/${PROBE_IDS.price}`,
    ])
  })
})
