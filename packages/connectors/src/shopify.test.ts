import { describe, expect, it } from 'vitest'
import {
  createShopifyOAuth,
  plainText,
  prependNote,
  samePhone,
  shopDomain,
  splitShop,
  verifyShopifyQuery,
  verifyShopifySessionToken,
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
  it('without a store, sends the member to Shopify’s store picker with the same consent page', () => {
    const url = new URL(oauth(fetch).authorizeUrl({ redirectUri: 'https://app.example/cb', state: 's' }))
    expect(url.origin + url.pathname).toBe('https://accounts.shopify.com/store-login')
    const next = new URL(url.searchParams.get('redirect')!, 'https://brightwater.myshopify.com')
    expect(next.pathname).toBe('/admin/oauth/authorize')
    expect(next.searchParams.get('client_id')).toBe('id123')
    expect(next.searchParams.get('redirect_uri')).toBe('https://app.example/cb')
    expect(next.searchParams.get('state')).toBe('s')
  })
  it('refuses a store it cannot read', () => {
    expect(() =>
      oauth(fetch).authorizeUrl({ redirectUri: 'https://app.example/cb', state: 's', shop: 'not a shop!' }),
    ).toThrow()
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

describe('session tokens of the embedded app', () => {
  const NOW = 1_795_300_000_000
  const at = NOW / 1000
  const app = { clientId: 'id123', clientSecret: SECRET }
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  const part = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))
  async function token(
    claims: Record<string, unknown> = {},
    secret = SECRET,
    header: unknown = { alg: 'HS256', typ: 'JWT' },
  ) {
    const body = {
      iss: 'https://brightwater.myshopify.com/admin',
      dest: 'https://brightwater.myshopify.com',
      aud: 'id123',
      sub: '42',
      exp: at + 60,
      nbf: at - 5,
      iat: at - 5,
      jti: 'j',
      sid: 's',
      ...claims,
    }
    const signing = `${part(header)}.${part(body)}`
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    return `${signing}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signing))))}`
  }
  const check = async (value: string) => verifyShopifySessionToken(value, app, NOW)

  it('reads the shop and the staff member of a good token', async () => {
    expect(await check(await token())).toEqual({ shop: 'brightwater.myshopify.com', user: '42' })
  })
  it('allows a few seconds of clock difference', async () => {
    expect(await check(await token({ exp: at - 5, nbf: at + 5 }))).not.toBeNull()
  })
  it.each([
    ['another secret', () => token({}, 'shpss_other')],
    ['another app', () => token({ aud: 'other-app' })],
    ['an expired token', () => token({ exp: at - 30 })],
    ['a token not valid yet', () => token({ nbf: at + 30 })],
    ['no expiry', () => token({ exp: undefined })],
    ['no not-before', () => token({ nbf: undefined })],
    [
      'dest on another domain',
      () => token({ dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' }),
    ],
    ['iss of another shop', () => token({ iss: 'https://other.myshopify.com/admin' })],
    [
      'dest over http',
      () => token({ dest: 'http://brightwater.myshopify.com', iss: 'http://brightwater.myshopify.com/admin' }),
    ],
    [
      'dest with a path',
      () => token({ dest: 'https://brightwater.myshopify.com/x', iss: 'https://brightwater.myshopify.com/x/admin' }),
    ],
    ['another algorithm', () => token({}, SECRET, { alg: 'none' })],
  ])('refuses %s', async (_what, make) => {
    expect(await check(await make())).toBeNull()
  })
  it('refuses what is no token', async () => {
    const good = await token()
    for (const bad of ['', 'abc', 'a.b', `${good}.x`, good.replace(/\.[^.]+$/, '.'), good.replace(/\.[^.]+$/, '.!!!')])
      expect(await check(bad)).toBeNull()
  })

  it('exchanges the token for the shop’s expiring offline access', async () => {
    const bodies: string[] = []
    const fake = (async (url: string, init: RequestInit) => {
      bodies.push(`${url} ${init.body}`)
      if (String(url).endsWith('/access_token'))
        return new Response(
          JSON.stringify({
            access_token: 'shpat_2',
            refresh_token: 'shprt_2',
            expires_in: 3600,
            scope: 'write_orders',
          }),
        )
      return new Response(
        JSON.stringify({ data: { shop: { name: 'Brightwater', myshopifyDomain: 'brightwater.myshopify.com' } } }),
      )
    }) as unknown as typeof fetch
    const oauth = createShopifyOAuth(app, { fetch: fake })
    const tokens = await oauth.tokenExchange!({ shop: 'brightwater.myshopify.com', sessionToken: 'session-token' })
    expect(tokens.accessToken).toBe('brightwater.myshopify.com|shpat_2')
    expect(tokens.refreshToken).toBe('brightwater.myshopify.com|shprt_2')
    expect(tokens.account).toEqual({ id: 'brightwater.myshopify.com', name: 'Brightwater' })
    const sent = JSON.parse(bodies[0]!.slice(bodies[0]!.indexOf(' ') + 1))
    expect(bodies[0]).toMatch(/^https:\/\/brightwater\.myshopify\.com\/admin\/oauth\/access_token /)
    expect(sent).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'session-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: 1,
      client_id: 'id123',
    })
    // No per-shop webhook: the app's configuration subscribes app/uninstalled for every shop.
    expect(bodies.some(b => b.includes('webhookSubscriptionCreate'))).toBe(false)
  })
  it('reads the staff member with an online exchange and keeps no token', async () => {
    const bodies: string[] = []
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return new Response(
        JSON.stringify({
          access_token: 'shpua_online',
          scope: 'write_orders',
          expires_in: 86399,
          associated_user: { id: 1, email: 'mike@brightwater.example', email_verified: true, account_owner: true },
        }),
      )
    }) as unknown as typeof fetch
    const user = await createShopifyOAuth(app, { fetch: fake }).sessionUser!({
      shop: 'brightwater.myshopify.com',
      sessionToken: 'session-token',
    })
    expect(user).toEqual({ email: 'mike@brightwater.example', emailVerified: true, accountOwner: true })
    expect(JSON.stringify(user)).not.toContain('shpua')
    expect(JSON.parse(bodies[0]!).requested_token_type).toBe('urn:shopify:params:oauth:token-type:online-access-token')
    expect(bodies).toHaveLength(1)
  })
  it('a staff member who is not the owner, or no user at all', async () => {
    const answer = (body: unknown) =>
      createShopifyOAuth(app, {
        fetch: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
      }).sessionUser!({ shop: 'brightwater.myshopify.com', sessionToken: 't' })
    expect(await answer({ access_token: 'x', associated_user: { email: 'staff@example.com' } })).toEqual({
      email: 'staff@example.com',
      emailVerified: false,
      accountOwner: false,
    })
    await expect(answer({ access_token: 'x' })).rejects.toThrow(/no staff member/)
  })
  it('refuses a shop that is not one before asking anyone', async () => {
    const fake = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    await expect(
      createShopifyOAuth(app, { fetch: fake }).tokenExchange!({ shop: 'evil.example.com', sessionToken: 't' }),
    ).rejects.toThrow(/no shop/)
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
