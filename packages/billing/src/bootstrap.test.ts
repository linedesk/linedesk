// The bootstrap script's logic against an in-memory Stripe (no network): the first run creates everything, a second
// run changes nothing, a changed amount makes a new price, live keys need both flags, the webhook endpoint is pinned.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WEBHOOK_EVENTS } from './provider.ts'
import { type BootstrapOptions, bootstrapStripe, type Catalog, CHECKOUT_PMC_NAME } from './stripe/bootstrap.ts'
import { STRIPE_API_VERSION } from './stripe/index.ts'

/** Made-up keys, put together at run time so the secret scan never sees a key-shaped string in the repo. */
const fakeStripeKey = (kind: 'sk' | 'rk', mode: 'test' | 'live') => [kind, mode, '51AbCdEfGhIjKlMn'].join('_')
const TEST_KEY = fakeStripeKey('sk', 'test')
const LIVE_KEY = fakeStripeKey('rk', 'live')
const WEBHOOK_URL = 'https://desk.example.com/v1/billing/stripe/webhook'

const catalog: Catalog = {
  products: { workspace: 'Linedesk workspace', partner: 'Linedesk Partner' },
  prices: [
    { lookupKey: 'ws_monthly', product: 'workspace', cents: 1100, interval: 'month' },
    { lookupKey: 'ws_yearly', product: 'workspace', cents: 10_800, interval: 'year' },
    { lookupKey: 'partner_yearly', product: 'partner', cents: 16_800, interval: 'year' },
  ],
  taxCode: 'txcd_10103001',
}
const options: BootstrapOptions = {
  mode: 'test',
  webhookUrl: WEBHOOK_URL,
  termsUrl: 'https://desk.example.com/terms',
  privacyUrl: 'https://desk.example.com/privacy',
  returnUrl: 'https://desk.example.com/settings/billing',
}

type Obj = Record<string, unknown>

/** Stripe's form encoding (`a[b][0]=x`) back into an object. */
function parseForm(body: string): Obj {
  const out: Obj = {}
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replace(/\]/g, '').split('[')
    let node: Obj = out
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value
        return
      }
      node[part] ??= /^\d+$/.test(path[i + 1]!) ? [] : {}
      node = node[part] as Obj
    })
  }
  return out
}
const merge = (target: Obj, patch: Obj) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object')
      merge(target[k] as Obj, v as Obj)
    else target[k] = v
  }
  return target
}

/** The few Stripe endpoints the bootstrap uses, in memory. */
function fakeStripe() {
  let n = 0
  const id = (prefix: string) => `${prefix}_${++n}`
  const state = {
    products: new Map<string, Obj>(),
    prices: new Map<string, Obj>(),
    portals: new Map<string, Obj>(),
    pmcs: new Map<string, Obj>(),
    endpoints: new Map<string, Obj>(),
    tax: { defaults: { tax_behavior: 'inferred_by_currency', tax_code: 'txcd_10000000', provider: 'stripe' } } as Obj,
    writes: [] as string[],
    requests: 0,
  }
  const methodOff = { available: true, display_preference: { overridable: null, preference: 'none', value: 'off' } }
  const methodOn = { available: true, display_preference: { overridable: null, preference: 'none', value: 'on' } }
  state.pmcs.set('pmc_default', {
    id: 'pmc_default',
    object: 'payment_method_configuration',
    name: 'Default',
    is_default: true,
    parent: null,
    active: true,
    card: structuredClone(methodOn),
    link: structuredClone(methodOn),
    apple_pay: structuredClone(methodOn),
    klarna: structuredClone(methodOff),
  })
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_t' },
    })
  const missing = () =>
    reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } })
  const list = (data: unknown[]) => reply(200, { object: 'list', data, has_more: false, url: '/v1/x' })
  const setPreferences = (pmc: Obj, form: Obj) => {
    for (const [method, value] of Object.entries(form)) {
      const pref = (value as { display_preference?: { preference?: string } }).display_preference?.preference
      if (!pref) continue
      pmc[method] = { available: true, display_preference: { overridable: null, preference: pref, value: pref } }
    }
  }

  const doFetch: typeof fetch = async (input, init) => {
    state.requests++
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const form = parseForm(typeof init?.body === 'string' ? init.body : '')
    if (method !== 'GET') state.writes.push(`${method} ${url.pathname}`)
    const parts = url.pathname.split('/').slice(2)
    const [kind, sub, third] = parts
    if (kind === 'account') return reply(200, { id: 'acct_1Test', object: 'account' })

    if (kind === 'products') {
      if (method === 'POST' && !sub) {
        const product = { object: 'product', active: true, ...form }
        state.products.set(form.id as string, product)
        return reply(200, product)
      }
      const product = state.products.get(sub!)
      if (!product) return missing()
      if (method === 'POST')
        merge(product, { ...form, active: form.active === undefined ? product.active : form.active === 'true' })
      return reply(200, product)
    }

    if (kind === 'prices') {
      if (method === 'GET') {
        const keys = url.searchParams
          .getAll('lookup_keys[]')
          .concat([...url.searchParams].filter(([k]) => /^lookup_keys\[\d+\]$/.test(k)).map(([, v]) => v))
        return list([...state.prices.values()].filter(p => keys.includes(p.lookup_key as string)))
      }
      if (!sub) {
        if (form.transfer_lookup_key === 'true')
          for (const p of state.prices.values()) if (p.lookup_key === form.lookup_key) p.lookup_key = null
        const recurring = form.recurring as Obj
        const price = {
          id: id('price'),
          object: 'price',
          active: true,
          product: form.product,
          currency: form.currency,
          unit_amount: Number(form.unit_amount),
          tax_behavior: form.tax_behavior,
          lookup_key: form.lookup_key,
          recurring: { interval: recurring.interval, interval_count: 1, usage_type: recurring.usage_type },
        }
        state.prices.set(price.id, price)
        return reply(200, price)
      }
      const price = state.prices.get(sub)!
      if (form.active !== undefined) price.active = form.active === 'true'
      return reply(200, price)
    }

    if (kind === 'tax' && sub === 'settings') {
      if (method === 'POST') merge(state.tax, form)
      return reply(200, { object: 'tax.settings', ...state.tax })
    }

    if (kind === 'payment_method_configurations') {
      if (method === 'GET') return list([...state.pmcs.values()])
      if (!sub) {
        const pmc: Obj = {
          id: id('pmc'),
          object: 'payment_method_configuration',
          name: form.name,
          is_default: false,
          parent: null,
          active: true,
        }
        for (const m of ['card', 'link', 'apple_pay', 'klarna']) pmc[m] = structuredClone(methodOn)
        setPreferences(pmc, form)
        state.pmcs.set(pmc.id as string, pmc)
        return reply(200, pmc)
      }
      const pmc = state.pmcs.get(sub)!
      setPreferences(pmc, form)
      return reply(200, pmc)
    }

    if (kind === 'billing_portal' && sub === 'configurations') {
      if (method === 'GET') return list([...state.portals.values()])
      const portal: Obj = third
        ? state.portals.get(third)!
        : { id: id('bpc'), object: 'billing_portal.configuration', active: true, is_default: state.portals.size === 0 }
      const features = form.features as Record<string, Obj>
      merge(portal, { ...form, features: {} })
      portal.features = {
        customer_update: {
          enabled: features.customer_update!.enabled === 'true',
          allowed_updates: features.customer_update!.allowed_updates,
        },
        invoice_history: { enabled: features.invoice_history!.enabled === 'true' },
        payment_method_update: { enabled: features.payment_method_update!.enabled === 'true' },
        subscription_cancel: {
          ...(features.subscription_cancel as Obj),
          enabled: features.subscription_cancel!.enabled === 'true',
          cancellation_reason: {
            enabled: (features.subscription_cancel!.cancellation_reason as Obj).enabled === 'true',
            options: (features.subscription_cancel!.cancellation_reason as Obj).options,
          },
        },
        subscription_update: { enabled: features.subscription_update!.enabled === 'true' },
      }
      state.portals.set(portal.id as string, portal)
      return reply(200, portal)
    }

    if (kind === 'webhook_endpoints') {
      if (method === 'GET') return list([...state.endpoints.values()])
      if (method === 'DELETE') {
        state.endpoints.delete(sub!)
        return reply(200, { id: sub, object: 'webhook_endpoint', deleted: true })
      }
      if (!sub) {
        const endpoint = {
          id: id('we'),
          object: 'webhook_endpoint',
          url: form.url,
          api_version: form.api_version ?? null,
          enabled_events: form.enabled_events,
          status: 'enabled',
          metadata: form.metadata ?? {},
        }
        state.endpoints.set(endpoint.id, endpoint)
        return reply(200, { ...endpoint, secret: ['whsec', 'MadeUpCreatedSecret'].join('_') })
      }
      const endpoint = state.endpoints.get(sub)!
      merge(endpoint, form)
      if (form.disabled === 'false') endpoint.status = 'enabled'
      return reply(200, endpoint)
    }
    return missing()
  }
  return { state, doFetch }
}

let stripe: ReturnType<typeof fakeStripe>
beforeEach(() => {
  stripe = fakeStripe()
})
const run = (over: Partial<BootstrapOptions> = {}, key = TEST_KEY) =>
  bootstrapStripe(key, catalog, { ...options, ...over }, stripe.doFetch)

describe('bootstrap', () => {
  test('the first run creates everything; a second run writes nothing and finds the same ids', async () => {
    const first = await run()
    expect(first.products).toEqual({ workspace: 'linedesk_workspace', partner: 'linedesk_partner' })
    expect(Object.keys(first.prices)).toEqual(['ws_monthly', 'ws_yearly', 'partner_yearly'])
    expect(first.webhookSecret).toMatch(/^whsec_/)
    expect(first.changes).toContain('set the account default tax code')

    const price = [...stripe.state.prices.values()].find(p => p.lookup_key === 'ws_yearly')!
    expect(price).toMatchObject({
      unit_amount: 10_800,
      currency: 'usd',
      tax_behavior: 'exclusive',
      product: 'linedesk_workspace',
      recurring: { interval: 'year', usage_type: 'licensed' },
    })
    expect(stripe.state.products.get('linedesk_partner')).toMatchObject({
      name: 'Linedesk Partner',
      tax_code: 'txcd_10103001',
    })
    expect(stripe.state.tax.defaults).toMatchObject({ tax_code: 'txcd_10103001', tax_behavior: 'exclusive' })

    const endpoint = [...stripe.state.endpoints.values()][0]!
    expect(endpoint).toMatchObject({ url: WEBHOOK_URL, api_version: STRIPE_API_VERSION })
    expect([...(endpoint.enabled_events as string[])].sort()).toEqual([...WEBHOOK_EVENTS].sort())

    const pmc = [...stripe.state.pmcs.values()].find(c => c.name === CHECKOUT_PMC_NAME)!
    const on = Object.entries(pmc).filter(
      ([, v]) => (v as Obj)?.display_preference && ((v as Obj).display_preference as Obj).value === 'on',
    )
    expect(on.map(([k]) => k)).toEqual(['card'])

    const portal = [...stripe.state.portals.values()][0]!
    expect(portal).toMatchObject({
      metadata: { linedesk: 'portal' },
      default_return_url: options.returnUrl,
      features: {
        subscription_update: { enabled: false },
        subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      },
    })

    const writes = stripe.state.writes.length
    const second = await run()
    expect(second.changes).toEqual([])
    expect(stripe.state.writes).toHaveLength(writes)
    expect(second.webhookSecret).toBeNull()
    const { changes: _a, webhookSecret: _b, ...firstIds } = first
    const { changes: _c, webhookSecret: _d, ...secondIds } = second
    expect(secondIds).toEqual(firstIds)
  })

  test('a dry run lists the changes and writes nothing', async () => {
    const result = await run({ dryRun: true })
    expect(result.changes).toContain('create price ws_monthly')
    expect(stripe.state.writes).toEqual([])
  })

  test('a changed amount makes a new price that takes the lookup key over; the old one is archived', async () => {
    const first = await run()
    const raised: Catalog = {
      ...catalog,
      prices: catalog.prices.map(p => (p.lookupKey === 'ws_monthly' ? { ...p, cents: 1200 } : p)),
    }
    // Not without --replace-prices (security review of #866, L3): a dry run says so, a real run refuses.
    const dry = await bootstrapStripe(TEST_KEY, raised, { ...options, dryRun: true }, stripe.doFetch)
    expect(dry.changes).toEqual(['replace price ws_monthly (needs --replace-prices)'])
    const writes = stripe.state.writes.length
    await expect(bootstrapStripe(TEST_KEY, raised, options, stripe.doFetch)).rejects.toThrow(/--replace-prices/)
    expect(stripe.state.writes).toHaveLength(writes)
    const second = await bootstrapStripe(TEST_KEY, raised, { ...options, replacePrices: true }, stripe.doFetch)
    expect(second.changes).toEqual(['replace price ws_monthly', 'archive old price ws_monthly'])
    expect(second.prices.ws_monthly).not.toBe(first.prices.ws_monthly)
    expect(stripe.state.prices.get(first.prices.ws_monthly!)).toMatchObject({ active: false, lookup_key: null })
    expect(stripe.state.prices.get(second.prices.ws_monthly!)).toMatchObject({
      unit_amount: 1200,
      lookup_key: 'ws_monthly',
    })
  })

  test('a method switched on in the Dashboard is switched off again', async () => {
    await run()
    const pmc = [...stripe.state.pmcs.values()].find(c => c.name === CHECKOUT_PMC_NAME)!
    pmc.link = { available: true, display_preference: { overridable: null, preference: 'on', value: 'on' } }
    expect((await run()).changes).toEqual(['payment method configuration: link'])
    expect((pmc.link as Obj).display_preference).toMatchObject({ preference: 'off' })
  })

  test('live keys need both flags; a key of the other mode than asked is refused; no request either way', async () => {
    await expect(run({ mode: 'live' }, LIVE_KEY)).rejects.toThrow(/--live --i-know/)
    await expect(run({ mode: 'test' }, LIVE_KEY)).rejects.toThrow(/live key/)
    await expect(run({ mode: 'live', allowLive: true }, TEST_KEY)).rejects.toThrow(/test key/)
    await expect(run({}, 'pk_test_notasecret')).rejects.toThrow(/not a Stripe secret/)
    expect(stripe.state.requests).toBe(0)
    expect((await run({ mode: 'live', allowLive: true }, LIVE_KEY)).mode).toBe('live')
  })

  test('an endpoint at the URL in another API version is refused, and made again only when asked', async () => {
    stripe.state.endpoints.set('we_old', {
      id: 'we_old',
      object: 'webhook_endpoint',
      url: WEBHOOK_URL,
      api_version: null,
      enabled_events: ['invoice.paid'],
      status: 'enabled',
      metadata: {},
    })
    await expect(run()).rejects.toThrow(/--recreate-webhook/)
    // The new endpoint is made beside the old one, which keeps delivering until the new secret is stored (#866, L2).
    const again = await run({ recreateWebhook: true, deleteOldWebhooks: true })
    expect(stripe.state.endpoints.has('we_old')).toBe(true)
    expect(again.oldWebhookEndpoints).toEqual(['we_old'])
    expect(again.webhookEndpoint).not.toBe('we_old')
    expect(again.webhookSecret).toMatch(/^whsec_/)
    expect(stripe.state.endpoints.get(again.webhookEndpoint!)).toMatchObject({ api_version: STRIPE_API_VERSION })
    expect(stripe.state.writes.filter(w => w.startsWith('DELETE'))).toEqual([])
    // A later run finds the pinned one and keeps it; the old one goes only when asked.
    expect((await run()).oldWebhookEndpoints).toEqual(['we_old'])
    const cleaned = await run({ deleteOldWebhooks: true })
    expect(cleaned.changes).toEqual(['delete the old webhook endpoint we_old (API version default)'])
    expect(cleaned.webhookEndpoint).toBe(again.webhookEndpoint)
    expect(cleaned.webhookSecret).toBeNull()
    expect(stripe.state.endpoints.has('we_old')).toBe(false)
  })

  test('without --return-url the portal keeps the return link Stripe has (review of #866, N1)', async () => {
    await run()
    const again = await run({ returnUrl: undefined })
    expect(again.changes).toEqual([])
    expect([...stripe.state.portals.values()][0]).toMatchObject({ default_return_url: options.returnUrl })
  })

  test('an endpoint in the right version with other events is updated, keeping its secret', async () => {
    stripe.state.endpoints.set('we_pinned', {
      id: 'we_pinned',
      object: 'webhook_endpoint',
      url: WEBHOOK_URL,
      api_version: STRIPE_API_VERSION,
      enabled_events: ['invoice.paid'],
      status: 'disabled',
      metadata: {},
    })
    const result = await run()
    expect(result.webhookEndpoint).toBe('we_pinned')
    expect(result.webhookSecret).toBeNull()
    expect(result.changes).toContain('update the webhook endpoint events')
    expect(stripe.state.endpoints.get('we_pinned')).toMatchObject({ status: 'enabled' })
    expect((stripe.state.endpoints.get('we_pinned')!.enabled_events as string[]).length).toBe(WEBHOOK_EVENTS.length)
  })
})

describe('the script', () => {
  const script = fileURLToPath(new URL('../scripts/bootstrap.ts', import.meta.url))
  const runScript = (args: string[]) =>
    spawnSync(process.execPath, [script, '--sandbox', '--webhook-url', WEBHOOK_URL, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, STRIPE_SECRET_KEY: TEST_KEY },
      timeout: 30_000,
    })
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bootstrap-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Review of #866, L1: refused before Stripe is asked (the made-up key never reaches it).
  test('refuses an existing secret file or a symlink where the secret would go', () => {
    const existing = join(dir, 'secret.txt')
    writeFileSync(existing, '')
    const one = runScript(['--secret-out', existing])
    expect(one.status).toBe(1)
    expect(one.stderr).toMatch(/exists/)
    const link = join(dir, 'link.txt')
    symlinkSync(join(dir, 'elsewhere.txt'), link)
    const two = runScript(['--secret-out', link])
    expect(two.status).toBe(1)
    expect(two.stderr).toMatch(/exists/)
    expect(existsSync(join(dir, 'elsewhere.txt'))).toBe(false)
  })

  test('the default output files are git-ignored in the package folder', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const ignored = spawnSync(
      'git',
      ['check-ignore', join(root, 'stripe-webhook-secret.test.txt'), join(root, 'stripe-ids.test.json')],
      { encoding: 'utf8' },
    )
    expect(ignored.stdout.trim().split('\n')).toHaveLength(2)
  })
})
