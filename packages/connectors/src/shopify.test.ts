import { describe, expect, it } from 'vitest'
import {
  createShopifyOAuth,
  plainText,
  prependNote,
  samePhone,
  shopDomain,
  splitShop,
  verifyShopifyQuery,
  verifyShopifyWebhook,
  withShop,
} from './shopify.ts'

const SECRET = 'shpss_test_secret'
async function hmac(message: string, encoding: 'hex' | 'base64') {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return encoding === 'hex'
    ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
    : btoa(String.fromCharCode(...bytes))
}
const sign = (params: Record<string, string>) =>
  hmac(
    Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&'),
    'hex',
  )

describe('shopDomain', () => {
  it('reads what a member types', () => {
    expect(shopDomain('brightwater')).toBe('brightwater.myshopify.com')
    expect(shopDomain(' Brightwater.myshopify.com ')).toBe('brightwater.myshopify.com')
    expect(shopDomain('https://brightwater.myshopify.com/admin/orders')).toBe('brightwater.myshopify.com')
  })
  it('refuses other domains', () => {
    expect(shopDomain('shop.brightwater.com')).toBeNull()
    expect(shopDomain('evil.com/brightwater.myshopify.com')).toBeNull()
    expect(shopDomain('')).toBeNull()
  })
})

describe('tokens carry the shop', () => {
  it('splits what it joined', () => {
    expect(splitShop(withShop('a.myshopify.com', 'shpat_x|y'))).toEqual({ shop: 'a.myshopify.com', token: 'shpat_x|y' })
  })
  it('refuses a token without a shop', () => {
    expect(() => splitShop('shpat_x')).toThrow()
  })
})

describe('signatures', () => {
  const params = {
    code: 'c0de',
    shop: 'brightwater.myshopify.com',
    state: 'st',
    timestamp: '1700000000',
    host: 'aG9zdA',
  }
  it('accepts a callback Shopify signed', async () => {
    expect(await verifyShopifyQuery({ ...params, hmac: await sign(params) }, SECRET)).toBe(true)
  })
  it('refuses a changed shop or a missing signature', async () => {
    expect(await verifyShopifyQuery({ ...params, hmac: await sign(params), shop: 'other.myshopify.com' }, SECRET)).toBe(
      false,
    )
    expect(await verifyShopifyQuery(params, SECRET)).toBe(false)
    expect(await verifyShopifyQuery({ ...params, hmac: await sign(params) }, 'wrong')).toBe(false)
  })
  it('checks a webhook body', async () => {
    const body = '{"shop_domain":"brightwater.myshopify.com"}'
    const signature = await hmac(body, 'base64')
    expect(await verifyShopifyWebhook(body, signature, SECRET)).toBe(true)
    expect(await verifyShopifyWebhook(`${body} `, signature, SECRET)).toBe(false)
    expect(await verifyShopifyWebhook(body, null, SECRET)).toBe(false)
  })
})

describe('OAuth', () => {
  const oauth = (fetch: typeof globalThis.fetch) =>
    createShopifyOAuth({ clientId: 'id123', clientSecret: SECRET }, { fetch })
  it('sends the member to the shop’s own consent page', () => {
    const url = new URL(
      oauth(fetch).authorizeUrl({ redirectUri: 'https://app.example/cb', state: 's', shop: 'brightwater' }),
    )
    expect(url.host).toBe('brightwater.myshopify.com')
    expect(url.pathname).toBe('/admin/oauth/authorize')
    expect(url.searchParams.get('scope')).toContain('write_orders')
    expect(url.searchParams.has('grant_options[]')).toBe(false)
  })
  it('exchanges a signed code for expiring tokens bound to the shop', async () => {
    const calls: string[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${init.body}`)
      if (String(url).endsWith('/access_token'))
        return new Response(
          JSON.stringify({
            access_token: 'shpat_1',
            refresh_token: 'shprt_1',
            expires_in: 3600,
            scope: 'write_orders',
          }),
        )
      return new Response(
        JSON.stringify({
          data: {
            shop: { id: 'gid://shopify/Shop/1', name: 'Brightwater', myshopifyDomain: 'brightwater.myshopify.com' },
          },
        }),
      )
    }) as unknown as typeof fetch
    const params = { code: 'c', shop: 'brightwater.myshopify.com', state: 's', timestamp: '1' }
    const tokens = await oauth(fake).exchangeCode({
      code: 'c',
      redirectUri: 'https://app.example/v1/apps/callback/shopify',
      params: { ...params, hmac: await sign(params) },
    })
    expect(tokens.accessToken).toBe('brightwater.myshopify.com|shpat_1')
    expect(tokens.refreshToken).toBe('brightwater.myshopify.com|shprt_1')
    expect(tokens.account).toEqual({ id: 'brightwater.myshopify.com', name: 'Brightwater' })
    expect(calls[0]).toContain('"expiring":1')
    // The shop's own uninstall webhook, to the origin the callback came back to.
    expect(
      calls.some(
        c => c.includes('webhookSubscriptionCreate') && c.includes('https://app.example/v1/apps/webhook/shopify'),
      ),
    ).toBe(true)
  })
  it('refuses an unsigned callback without asking Shopify', async () => {
    const fake = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    await expect(
      oauth(fake).exchangeCode({ code: 'c', redirectUri: 'x', params: { shop: 'evil.myshopify.com', code: 'c' } }),
    ).rejects.toThrow(/not signed/)
  })
})

describe('notes and text', () => {
  it('keeps the newest calls on top and stays short', () => {
    expect(prependNote('new', 'old')).toBe('new\n\n---\n\nold')
    expect(prependNote('new', null)).toBe('new')
    expect(prependNote('n', 'x'.repeat(6000)).length).toBeLessThanOrEqual(4500)
  })
  it('turns policy HTML into text', () => {
    expect(
      plainText('<p>Returns within <b>30 days</b>.</p><ul><li>Unused</li><li>With receipt &amp; tags</li></ul>'),
    ).toBe('Returns within 30 days.\n- Unused\n- With receipt & tags')
  })
  it('compares phone numbers however they are written', () => {
    expect(samePhone('+15035550142', '(503) 555-0142')).toBe(true)
    expect(samePhone('+15035550142', '+1 503 555 0199')).toBe(false)
    expect(samePhone('+15035550142', null)).toBe(false)
  })
})

describe('phone numbers of two countries', () => {
  it('never match on the national digits alone', () => {
    expect(samePhone('+15035550142', '+445035550142')).toBe(false)
  })
})
