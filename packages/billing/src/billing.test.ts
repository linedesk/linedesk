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
