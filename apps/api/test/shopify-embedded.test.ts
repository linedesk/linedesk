// A store that installs the app from Shopify's App Store: the embedded page (its CSP, no cookie), the session token
// check and the token exchange, the install row (made, asked again, installed again), the single-use link to a
// workspace and who may use it, the connection it makes (a working Shopify connection), the uninstall, and
// Integrations › Shopify › Connect opening the App Store listing once the public app is approved.
// Instance-wide file (vitest.config.ts): it stores the install's Shopify app keys and makes an instance admin.
import { createHash, createHmac } from 'node:crypto'
import { actions, rolePermissions } from '@linedesk/actions'
import { AppError, type AppOAuth, type OAuthTokens } from '@linedesk/connectors'
import { app_connections, app_credentials, shopify_installs, shopify_link_tokens, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { type AppServices, appSlot, appTokenSource } from '../src/app-connections.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Forbidden } from '../src/handler-context.ts'
import { runHandler } from '../src/handlers.ts'
import { decryptSecret } from '../src/secrets.ts'
import {
  embeddedSession,
  resetShopifyEmbeddedLimits,
  SESSIONS_PER_SHOP_PER_MINUTE,
  SHOPIFY_EMBEDDED_PATH,
  SHOPIFY_SESSION_PATH,
  shopifyInstallSlot,
} from '../src/shopify-embedded.ts'
import { act, addMember, appRequest, createWorkspace, signUp, type User, type Workspace } from './helpers.ts'

const SHOP = 'brightwater.myshopify.com'
const OTHER_SHOP = 'harbor-supply.myshopify.com'
const CLIENT_ID = '0123456789abcdef0123456789abcdef'
const SECRET = 'shpss_install_secret_0123456789'
const WEB = 'http://localhost:5173'
const SCOPE = 'write_customers,write_orders,write_returns,read_products,read_inventory,read_legal_policies'

let admin: User
let ws: Workspace
let member: User

/** A session token as App Bridge gives one: HS256 with the app's secret. */
function sessionToken(shop = SHOP, claims: Record<string, unknown> = {}, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000)
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = {
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: CLIENT_ID,
    sub: '42',
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: crypto.randomUUID(),
    sid: 's',
    ...claims,
  }
  const signing = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(body)}`
  return `${signing}.${createHmac('sha256', secret).update(signing).digest('base64url')}`
}

/** Shopify's token exchange, in memory: every call is counted, the token names the store. */
function fakeShopify(scope: string | null = SCOPE, owner = true) {
  const exchange = vi.fn(
    async ({ shop }: { shop: string; sessionToken: string }): Promise<OAuthTokens> => ({
      accessToken: `${shop}|shpat_${exchange.mock.calls.length}`,
      refreshToken: `${shop}|shprt_${exchange.mock.calls.length}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope,
      account: { id: shop, name: shop === SHOP ? 'Brightwater Plumbing Supply' : 'Harbor Supply' },
    }),
  )
  const oauth = {
    id: 'shopify' as const,
    scopes: [],
    authorizeUrl: () => 'https://example.invalid',
    exchangeCode: async () => {
      throw new AppError('shopify', 'auth', 'not here')
    },
    refresh: async () => {
      throw new AppError('shopify', 'auth', 'no refresh')
    },
    revoke: async () => true,
    account: async () => ({ id: SHOP, name: SHOP }),
    tokenExchange: exchange,
    sessionUser: async () => ({
      email: owner ? 'owner@brightwater.example' : 'staff@brightwater.example',
      emailVerified: true,
      accountOwner: owner,
    }),
    grantPerAccount: true,
  } satisfies AppOAuth
  const services: AppServices = {
    oauth: async () => oauth,
    connector: () => ({ id: 'shopify', crm: true, pushCall: vi.fn() }),
  }
  return { services, exchange }
}

const installOf = async (shop = SHOP) =>
  (await db.select().from(shopify_installs).where(eq(shopify_installs.shop, shop)))[0]
const tokenOf = (linkUrl: string) => new URL(linkUrl.replace('#', '')).searchParams.get('t')!
const linkUrlOf = async (shop = SHOP) => {
  const answer = await embeddedSession(sessionToken(shop), { link: true }, fakeShopify().services)
  if (answer.status !== 200) throw new Error(`session refused: ${answer.status}`)
  return answer.body.data.linkUrl!
}

beforeAll(async () => {
  admin = await signUp()
  await db.update(user).set({ instanceAdmin: true, emailVerified: true }).where(eq(user.id, admin.userId))
  const set = await act(admin, 'provider.setKeys', {
    provider: 'shopify',
    values: { client_id: CLIENT_ID, client_secret: SECRET },
  })
  expect(set.status).toBe(200)
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  member = await addMember(ws.id, 'member')
})

afterAll(async () => {
  await act(admin, 'provider.clearKeys', { provider: 'shopify' })
})

describe('the embedded page (GET /shopify/app)', () => {
  test('framed only by the store’s own admin, App Bridge first, no cookie', async () => {
    const res = await appRequest(`${SHOPIFY_EMBEDDED_PATH}?shop=${SHOP}&host=abc&embedded=1&locale=en`)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`frame-ancestors https://${SHOP} https://admin.shopify.com;`)
    expect(csp).toMatch(/script-src https:\/\/cdn\.shopify\.com 'nonce-[^']+'/)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
    const html = await res.text()
    const firstScript = html.match(/<script[^>]*>/)?.[0] ?? ''
    expect(firstScript).toContain('src="https://cdn.shopify.com/shopifycloud/app-bridge.js"')
    expect(firstScript).toContain(`data-api-key="${CLIENT_ID}"`)
    expect(html.indexOf('app-bridge.js')).toBeLessThan(html.indexOf('<script', html.indexOf('app-bridge.js')))
    // The page's own script runs only with this response's nonce; nothing in it stores anything in the browser.
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/)
    expect(html).toContain(SHOPIFY_SESSION_PATH)
  })

  test('a store that is not one is framed by nobody but Shopify’s admin, and gets no script', async () => {
    for (const shop of ['evil.example.com', 'Brightwater.myshopify.com', '']) {
      const res = await appRequest(`${SHOPIFY_EMBEDDED_PATH}?shop=${encodeURIComponent(shop)}`)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-security-policy')).toContain('frame-ancestors https://admin.shopify.com;')
      expect(await res.text()).not.toContain('<script')
    }
  })
})

describe('the session token (POST /v1/shopify/embedded/session)', () => {
  const post = (authorization?: string) =>
    appRequest(SHOPIFY_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ link: true }),
    })

  test('no token, a token of another app or secret, an expired one: 401, nothing stored', async () => {
    expect((await post()).status).toBe(401)
    expect((await post(`Bearer ${sessionToken(SHOP, {}, 'shpss_wrong')}`)).status).toBe(401)
    expect((await post(`Bearer ${sessionToken(SHOP, { aud: 'another-app' })}`)).status).toBe(401)
    const old = Math.floor(Date.now() / 1000) - 600
    expect((await post(`Bearer ${sessionToken(SHOP, { exp: old, nbf: old - 60 })}`)).status).toBe(401)
    expect((await post(`Bearer ${sessionToken(SHOP, { iss: `https://${OTHER_SHOP}/admin` })}`)).status).toBe(401)
    expect((await post('Bearer not-a-token')).status).toBe(401)
    expect((await post(`Bearer ${sessionToken(SHOP)}`)).headers.get('set-cookie')).toBeNull()
    expect(await installOf()).toBeUndefined()
  })

  test('a good token: the access is exchanged and stored encrypted, with a single-use link', async () => {
    const { services, exchange } = fakeShopify()
    const answer = await embeddedSession(sessionToken(), { link: true }, services)
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(exchange.mock.calls[0]![0].shop).toBe(SHOP)
    expect(answer.body.data).toMatchObject({
      shop: SHOP,
      shopName: 'Brightwater Plumbing Supply',
      workspace: null,
      openUrl: null,
    })
    const linkUrl = answer.body.data.linkUrl!
    expect(linkUrl.startsWith(`${WEB}/#shopify/link?t=`)).toBe(true)
    const install = (await installOf())!
    expect(install).toMatchObject({ workspace_id: null, uninstalled_at: null, scope: SCOPE })
    expect(install.access_token_encrypted).not.toContain('shpat')
    expect(decryptSecret(install.refresh_token_encrypted!, shopifyInstallSlot(SHOP, 'refresh'))).toBe(`${SHOP}|shprt_1`)
    // Only the link's hash is stored.
    const token = tokenOf(linkUrl)
    const [stored] = await db.select().from(shopify_link_tokens).where(eq(shopify_link_tokens.shop, SHOP))
    expect(stored?.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  test('asking again while not linked: no new exchange, and a new link only when asked for', async () => {
    const { services, exchange } = fakeShopify()
    const poll = await embeddedSession(sessionToken(), { link: false }, services)
    expect(poll.status === 200 && poll.body.data.linkUrl).toBeNull()
    expect(exchange).not.toHaveBeenCalled()
  })
})

describe('linking the store to a workspace (shopify.linkInstall)', () => {
  test('describeLink names the store; an unknown token is refused', async () => {
    const token = tokenOf(await linkUrlOf())
    const res = await act(member, 'shopify.describeLink', { token })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ shop: SHOP, shopName: 'Brightwater Plumbing Supply', connectedShop: null })
    const unknown = await act(member, 'shopify.describeLink', { token: 'x'.repeat(43) })
    expect(unknown.status).toBe(409)
    expect(unknown.body.code).toBe('link_invalid')
  })

  test('a member may not link; an owner signed in as someone else neither', async () => {
    const token = tokenOf(await linkUrlOf())
    expect((await act(member, 'shopify.linkInstall', { token })).status).toBe(403)
    const impersonated: Actor = {
      actorId: ws.owner.userId,
      role: 'owner',
      workspaceId: ws.id,
      permissions: rolePermissions.owner,
      impersonation: { by: admin.userId, sessionId: 's', expiresAt: new Date(Date.now() + 60_000) },
    }
    await expect(
      db.transaction(tx =>
        runHandler(
          { tx, actor: impersonated, now: new Date().toISOString(), apps: fakeShopify().services },
          actions.get('shopify.linkInstall')!,
          { token },
        ),
      ),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  test('an expired link is refused', async () => {
    const token = tokenOf(await linkUrlOf())
    await db
      .update(shopify_link_tokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(shopify_link_tokens.token_hash, createHash('sha256').update(token).digest('hex')))
    const res = await act(ws.owner, 'shopify.linkInstall', { token })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('link_expired')
  })

  test('a workspace connected to another store is refused', async () => {
    const other = await createWorkspace('Harbor Plumbing')
    await db.insert(app_connections).values({
      id: `appc_${crypto.randomUUID().slice(0, 8)}`,
      workspace_id: other.id,
      provider: 'shopify',
      account_id: OTHER_SHOP,
      account_name: 'Harbor Supply',
      connected_by: other.owner.userId,
    })
    const token = tokenOf(await linkUrlOf())
    const described = await act(other.owner, 'shopify.describeLink', { token })
    expect(described.body.data.connectedShop).toBe(OTHER_SHOP)
    const res = await act(other.owner, 'shopify.linkInstall', { token })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('other_store')
  })

  test('an owner links it: a working Shopify connection, the install keeps only the workspace, the link is used up', async () => {
    const token = tokenOf(await linkUrlOf())
    const res = await act(ws.owner, 'shopify.linkInstall', { token })
    expect(res.status).toBe(200)
    expect(res.body.data.shop).toBe(SHOP)
    const [connection] = await db
      .select()
      .from(app_connections)
      .where(and(eq(app_connections.workspace_id, ws.id), eq(app_connections.provider, 'shopify')))
    expect(connection).toMatchObject({
      account_id: SHOP,
      account_name: 'Brightwater Plumbing Supply',
      status: 'connected',
    })
    const [credentials] = await db
      .select()
      .from(app_credentials)
      .where(eq(app_credentials.connection_id, connection!.id))
    expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(connection!, 'refresh'))).toMatch(
      new RegExp(`^${SHOP}\\|shprt_`),
    )
    // What the assistant's tools and the pushes use: the stored access, good for an hour.
    const access = await appTokenSource(db, fakeShopify().services, connection!)()
    expect(access).toMatch(new RegExp(`^${SHOP}\\|shpat_`))
    const install = (await installOf())!
    expect(install).toMatchObject({
      workspace_id: ws.id,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
    })
    const again = await act(ws.owner, 'shopify.linkInstall', { token })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('link_invalid')
  })

  test('the embedded page shows it linked, with no exchange; another workspace cannot take the store', async () => {
    const { services, exchange } = fakeShopify()
    const answer = await embeddedSession(sessionToken(), { link: true }, services)
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(answer.body.data.workspace).toEqual({ id: ws.id, name: 'Brightwater Plumbing & Heating' })
    expect(answer.body.data.linkUrl).toBeNull()
    expect(answer.body.data.openUrl).toBe(`${WEB}/#integrations/shopify?ws=${encodeURIComponent(ws.id)}`)
    expect(exchange).not.toHaveBeenCalled()

    // A link minted for the store earlier (a second tab) no longer links it anywhere else.
    const third = await createWorkspace('Third Business')
    await db.insert(shopify_link_tokens).values({
      token_hash: createHash('sha256').update('y'.repeat(43)).digest('hex'),
      shop: SHOP,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await act(third.owner, 'shopify.linkInstall', { token: 'y'.repeat(43) })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('linked_elsewhere')
  })
})

describe('uninstall and install again', () => {
  const webhook = (body: unknown, topic = 'app/uninstalled') => {
    const raw = JSON.stringify(body)
    return appRequest('/v1/apps/webhook/shopify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': SHOP,
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
      },
      body: raw,
    })
  }

  test('app/uninstalled removes the connection and marks the install, its links gone', async () => {
    const before = (await installOf())!
    const res = await webhook({ id: 1, myshopify_domain: SHOP })
    expect(res.status).toBe(200)
    const connections = await db
      .select()
      .from(app_connections)
      .where(and(eq(app_connections.workspace_id, ws.id), eq(app_connections.provider, 'shopify')))
    expect(connections).toEqual([])
    const install = (await installOf())!
    expect(install.id).toBe(before.id)
    expect(install.uninstalled_at).not.toBeNull()
    expect(install).toMatchObject({ workspace_id: null, access_token_encrypted: null, refresh_token_encrypted: null })
    expect(await db.select().from(shopify_link_tokens).where(eq(shopify_link_tokens.shop, SHOP))).toEqual([])
  })

  test('installed again: the same row, a new exchange, not linked', async () => {
    const before = (await installOf())!
    const { services, exchange } = fakeShopify()
    const answer = await embeddedSession(sessionToken(), { link: true }, services)
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(answer.status === 200 && answer.body.data.workspace).toBeNull()
    const install = (await installOf())!
    expect(install.id).toBe(before.id)
    expect(install.uninstalled_at).toBeNull()
    expect(install.refresh_token_encrypted).not.toBeNull()
  })

  test('a store connected with Connect before it was installed shows as linked to that workspace', async () => {
    const answer = await embeddedSession(sessionToken(OTHER_SHOP), { link: true }, fakeShopify().services)
    expect(answer.status === 200 && answer.body.data.workspace?.name).toBe('Harbor Plumbing')
    expect(answer.status === 200 && answer.body.data.linkUrl).toBeNull()
  })

  test('a store that did not grant every scope cannot be linked', async () => {
    // (OTHER_SHOP is connected to a workspace already: the page shows it linked there, with no link to make.)
    const answer = await embeddedSession(
      sessionToken('scope-store.myshopify.com'),
      { link: true },
      fakeShopify('read_products').services,
    )
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    const fresh = await createWorkspace('Scope Business')
    const res = await act(fresh.owner, 'shopify.linkInstall', { token: tokenOf(answer.body.data.linkUrl!) })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('scope')
  })
})

describe('Integrations › Shopify › Connect with the public app', () => {
  test('the listing must be an App Store URL', async () => {
    for (const app_store_url of ['http://apps.shopify.com/linedesk', 'https://evil.example/linedesk', 'not a url']) {
      const res = await act(admin, 'provider.setKeys', { provider: 'shopify', values: { app_store_url } })
      expect(res.status).toBe(422)
    }
  })

  test('approved and listed: Connect opens the listing instead of asking for the store; off: as before', async () => {
    const fresh = await createWorkspace('Listing Business')
    expect((await act(fresh.owner, 'shopify.setupStatus', {})).body.data.way).toBe('request')
    const listing = 'https://apps.shopify.com/linedesk'
    const set = await act(admin, 'provider.setKeys', {
      provider: 'shopify',
      values: { public_app_approved: 'true', app_store_url: listing },
    })
    expect(set.status).toBe(200)
    expect((await act(fresh.owner, 'shopify.setupStatus', {})).body.data).toEqual({
      way: 'app_store',
      request: null,
      appStoreUrl: listing,
    })
    await act(admin, 'provider.setKeys', { provider: 'shopify', values: { public_app_approved: 'false' } })
    expect((await act(fresh.owner, 'shopify.setupStatus', {})).body.data).toEqual({ way: 'request', request: null })
  })
})

describe('review fixes', () => {
  const shop = 'review-store.myshopify.com'
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
  const mint = async (fake = fakeShopify()) => {
    const answer = await embeddedSession(sessionToken(shop), { link: true }, fake.services)
    if (answer.status !== 200) throw new Error(`refused ${answer.status}`)
    return answer.body.data
  }

  test('only the store’s owner gets a link; another staff member reads that only the owner connects it', async () => {
    const staff = await mint(fakeShopify(SCOPE, false))
    expect(staff).toMatchObject({ linkUrl: null, ownerOnly: true, workspace: null })
    expect(await db.select().from(shopify_link_tokens).where(eq(shopify_link_tokens.shop, shop))).toEqual([])
  })

  test('the link names the owner who started it; one live link per store', async () => {
    const first = tokenOf((await mint()).linkUrl!)
    const second = tokenOf((await mint()).linkUrl!)
    const rows = await db.select().from(shopify_link_tokens).where(eq(shopify_link_tokens.shop, shop))
    expect(rows.map(r => r.token_hash)).toEqual([hashOf(second)])
    expect(rows[0]!.started_by).toBe('owner@brightwater.example')
    const fresh = await createWorkspace('Review Business')
    expect((await act(fresh.owner, 'shopify.describeLink', { token: first })).body.code).toBe('link_invalid')
    const described = await act(fresh.owner, 'shopify.describeLink', { token: second })
    expect(described.body.data).toMatchObject({ shop, startedBy: 'owner@brightwater.example' })
  })

  test('an account whose address is not confirmed cannot link; describing stays open', async () => {
    const unconfirmed = await createWorkspace('Unconfirmed Business', false)
    const token = tokenOf((await mint()).linkUrl!)
    expect((await act(unconfirmed.owner, 'shopify.describeLink', { token })).status).toBe(200)
    const res = await act(unconfirmed.owner, 'shopify.linkInstall', { token })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED')
    expect(await db.select().from(app_connections).where(eq(app_connections.workspace_id, unconfirmed.id))).toEqual([])
  })

  test('no scope named by Shopify counts as missing for a link', async () => {
    const other = 'no-scope-store.myshopify.com'
    const answer = await embeddedSession(sessionToken(other), { link: true }, fakeShopify(null).services)
    if (answer.status !== 200) throw new Error('refused')
    const fresh = await createWorkspace('No Scope Business')
    const res = await act(fresh.owner, 'shopify.linkInstall', { token: tokenOf(answer.body.data.linkUrl!) })
    expect(res.body.code).toBe('scope')
  })

  test('an uninstall from before the last exchange leaves the install, but takes its links', async () => {
    await mint()
    const raw = JSON.stringify({ id: 2, myshopify_domain: shop })
    const res = await appRequest('/v1/apps/webhook/shopify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': 'app/uninstalled',
        'x-shopify-triggered-at': new Date(Date.now() - 10 * 60_000).toISOString(),
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
      },
      body: raw,
    })
    expect(res.status).toBe(200)
    const install = (await installOf(shop))!
    expect(install.uninstalled_at).toBeNull()
    expect(install.refresh_token_encrypted).not.toBeNull()
    expect(await db.select().from(shopify_link_tokens).where(eq(shopify_link_tokens.shop, shop))).toEqual([])
  })

  test('a store asks at most a minute’s worth of times', async () => {
    resetShopifyEmbeddedLimits()
    const fake = fakeShopify()
    for (let i = 0; i < SESSIONS_PER_SHOP_PER_MINUTE; i++)
      expect((await embeddedSession(sessionToken(shop), { link: false }, fake.services)).status).toBe(200)
    expect((await embeddedSession(sessionToken(shop), { link: false }, fake.services)).status).toBe(429)
    resetShopifyEmbeddedLimits()
  })
})
