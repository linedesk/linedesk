// A store's own Shopify app set up on request (LIN-719): the member's request and who may make it, the alert to the
// instance admins, the admin's ready (keys stored as the workspace's own app, the install link checked, the email to
// the member) and failed, Server admin's list, Connect refused until the store has its app (or the public app is
// approved), the signed open route the installed app comes back through, and the request marked connected.
// Instance-wide file (vitest.config.ts): it stores provider keys and makes an instance admin.
import { createHmac } from 'node:crypto'
import { actions, REDACTED, rolePermissions } from '@linedesk/actions'
import { AppError, type AppOAuth } from '@linedesk/connectors'
import { app_setup_requests, commands, provider_settings, type Tx, user } from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { type AppServices, workspaceAppKeys } from '../src/app-connections.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { runHandler } from '../src/handlers.ts'
import { SHOPIFY_OPEN_PATH, shopifyOpenTarget } from '../src/shopify-setup.ts'
import { act, addMember, appRequest, createWorkspace, signUp, type User, type Workspace } from './helpers.ts'

const SHOP = 'brightwater.myshopify.com'
const CLIENT_ID = 'a1b2c3d4e5f6a7b8c9d0'
const SECRET = 'shpss_test_secret_0123456789'
const INSTALL = `https://admin.shopify.com/store/brightwater/oauth/install_custom_app?client_id=${CLIENT_ID}&no_redirect=true&signature=abc`
const WEB = 'http://localhost:5173'

let ws: Workspace
let member: User
let admin: User
let adminEmail: string

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  member = await addMember(ws.id, 'member')
  admin = await signUp()
  await db.update(user).set({ instanceAdmin: true, emailVerified: true }).where(eq(user.id, admin.userId))
  adminEmail = (await db.select({ email: user.email }).from(user).where(eq(user.id, admin.userId)))[0]!.email
})

afterEach(() => vi.restoreAllMocks())

const sent = () => vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
const openRows = (workspaceId: string) =>
  db.select().from(app_setup_requests).where(eq(app_setup_requests.workspace_id, workspaceId))

/** Shopify's signature over a query: hex HMAC-SHA256 with the app's secret over the sorted `key=value` pairs. */
function signed(params: Record<string, string>, secret = SECRET) {
  const message = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
  return new URLSearchParams({ ...params, hmac: createHmac('sha256', secret).update(message).digest('hex') })
}

describe('asking for the store’s own app', () => {
  test('a new workspace is asked for its store; members read the status, only owners and admins ask', async () => {
    const status = await act(member, 'shopify.setupStatus', {})
    expect(status.status).toBe(200)
    expect(status.body.data).toEqual({ way: 'request', request: null })
    expect((await act(member, 'shopify.requestSetup', { shop: 'brightwater' })).status).toBe(403)
  })

  test('Connect is refused until the store has its own app, with a code the page words', async () => {
    const res = await act(ws.owner, 'app.connectStart', { app: 'shopify', shop: 'brightwater' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('setup_needed')
  })

  test('a store address that is not one is refused; the request names the myshopify.com domain', async () => {
    const bad = await act(ws.owner, 'shopify.requestSetup', { shop: 'shop.example.com' })
    expect(bad.status).toBe(409)
    expect(bad.body.code).toBe('shop')
    const send = sent()
    const res = await act(ws.owner, 'shopify.requestSetup', { shop: 'https://Brightwater.myshopify.com/admin' })
    expect(res.status).toBe(200)
    expect(res.body.data.way).toBe('request')
    expect(res.body.data.request).toMatchObject({ shop: SHOP, status: 'requested', installUrl: null })
    // Every instance admin hears of it, with the store and the workspace.
    const alert = send.mock.calls.map(([email]) => email).find(email => email.to === adminEmail)
    expect(alert?.subject).toContain(SHOP)
    expect(alert?.text).toContain('Brightwater Plumbing & Heating')
    expect(alert?.text).toContain('/#admin/overview')
  })

  test('asking again: the same store is no new request and no second alert; another store only after 10 minutes', async () => {
    const send = sent()
    const same = await act(ws.owner, 'shopify.requestSetup', { shop: 'brightwater' })
    expect(same.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
    const other = await act(ws.owner, 'shopify.requestSetup', { shop: 'other-store' })
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('too_soon')
    const rows = await openRows(ws.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ shop: SHOP, status: 'requested', requested_by: ws.owner.userId })
    expect((await act(member, 'shopify.setupStatus', {})).body.data.request.shop).toBe(SHOP)
  })
})

describe('Server admin', () => {
  const requestId = async () => (await openRows(ws.id))[0]!.id

  test('the list is for instance admins only and names the workspace and who asked', async () => {
    expect((await act(ws.owner, 'shopifySetup.list', {})).status).toBe(403)
    const res = await act(admin, 'shopifySetup.list', { status: 'requested' })
    expect(res.status).toBe(200)
    const mine = res.body.data.requests.find((r: { workspaceId: string }) => r.workspaceId === ws.id)
    expect(mine).toMatchObject({ shop: SHOP, status: 'requested', workspaceName: 'Brightwater Plumbing & Heating' })
    expect(mine.requestedBy).toMatch(/@linedesk\.test$/)
  })

  test.each([
    ['another store', INSTALL.replace('/store/brightwater/', '/store/other/')],
    ['another app', INSTALL.replace(CLIENT_ID, 'zzzzzzzzzzzz')],
    ['plain http', INSTALL.replace('https://', 'http://')],
    ['another host', INSTALL.replace('admin.shopify.com', 'admin.shopify.com.evil.test')],
    ['another path', INSTALL.replace('install_custom_app', 'authorize')],
    ['not a URL', 'admin.shopify.com/store/brightwater'],
  ])('an install link for %s is refused and stores nothing', async (_what, installUrl) => {
    const res = await act(admin, 'shopifySetup.ready', {
      requestId: await requestId(),
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      installUrl,
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('install_url')
    expect(await workspaceAppKeys(db, 'shopify', ws.id)).toBeNull()
  })

  test('only an instance admin marks it ready', async () => {
    const input = { requestId: await requestId(), clientId: CLIENT_ID, clientSecret: SECRET, installUrl: INSTALL }
    expect((await act(ws.owner, 'shopifySetup.ready', input)).status).toBe(403)
  })

  test('ready: the keys become the workspace’s own app, the member who asked gets the link, the log has no secret', async () => {
    const send = sent()
    const key = crypto.randomUUID()
    const res = await act(
      admin,
      'shopifySetup.ready',
      { requestId: await requestId(), clientId: CLIENT_ID, clientSecret: SECRET, installUrl: INSTALL },
      key,
    )
    expect(res.status).toBe(200)
    expect(res.body.data.request).toMatchObject({ status: 'ready', installUrl: INSTALL })
    expect(res.body.data.openUrl).toBe(`${WEB}${SHOPIFY_OPEN_PATH}`)
    expect(await workspaceAppKeys(db, 'shopify', ws.id)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET })
    // Never as the install's own app.
    const install = await db
      .select()
      .from(provider_settings)
      .where(and(isNull(provider_settings.workspace_id), eq(provider_settings.provider, 'shopify')))
    expect(install).toEqual([])
    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(command?.input).toMatchObject({ clientSecret: REDACTED, clientId: CLIENT_ID })
    expect(JSON.stringify(command)).not.toContain(SECRET)
    const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, ws.owner.userId))
    const email = send.mock.calls.map(([e]) => e).find(e => e.to === owner!.email)
    expect(email?.html).toContain(INSTALL.replaceAll('&', '&amp;'))
    expect(email?.text).toContain(SHOP)
  })

  test('the page shows it ready, and Connect now opens the store’s consent page with its own app', async () => {
    const status = (await act(member, 'shopify.setupStatus', {})).body.data
    expect(status.way).toBe('connect')
    expect(status.request).toMatchObject({ status: 'ready', installUrl: INSTALL })
    const res = await act(ws.owner, 'app.connectStart', { app: 'shopify', shop: SHOP })
    expect(res.status).toBe(200)
    const url = new URL(res.body.data.url)
    expect(url.host).toBe(SHOP)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
  })
})

describe('the installed app opens Linedesk (GET /v1/apps/open/shopify)', () => {
  const params = () => ({
    shop: SHOP,
    host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYnJpZ2h0d2F0ZXI',
    timestamp: '1795300000',
  })

  test('signed by the store’s own app: to its workspace’s Shopify page, which connects the store', async () => {
    const res = await appRequest(`${SHOPIFY_OPEN_PATH}?${signed(params())}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${WEB}/#integrations/shopify?connect=${encodeURIComponent(SHOP)}&ws=${encodeURIComponent(ws.id)}`,
    )
  })

  test('a wrong signature, no signature or another store: only the Shopify page, nothing to connect', async () => {
    const plain = `${WEB}/#integrations/shopify`
    expect(await shopifyOpenTarget(signed(params(), 'wrong-secret'), WEB)).toBe(plain)
    expect(await shopifyOpenTarget(new URLSearchParams(params()), WEB)).toBe(plain)
    expect(await shopifyOpenTarget(signed({ ...params(), shop: 'other.myshopify.com' }), WEB)).toBe(plain)
    expect(await shopifyOpenTarget(signed({ ...params(), shop: 'not a shop' }), WEB)).toBe(plain)
    const changed = signed(params())
    changed.set('timestamp', '1795300001')
    expect(await shopifyOpenTarget(changed, WEB)).toBe(plain)
  })
})

describe('connected and failed', () => {
  class Rollback extends Error {}
  const inRollback = (body: (tx: Tx) => Promise<void>) =>
    db
      .transaction(async tx => {
        await body(tx)
        throw new Rollback()
      })
      .catch(e => {
        if (!(e instanceof Rollback)) throw e
      })

  /** Shopify's OAuth for the store, in memory: the code is exchanged for a token of this store. */
  const fakeShopify = (): AppServices => {
    const oauth = {
      id: 'shopify' as const,
      scopes: [],
      authorizeUrl: ({ state }: { state: string }) => `https://${SHOP}/admin/oauth/authorize?state=${state}`,
      exchangeCode: async ({ code }: { code: string }) => {
        if (code !== 'good-code') throw new AppError('shopify', 'auth', 'bad code')
        return {
          accessToken: 'shpat_1',
          refreshToken: 'shpat_1',
          expiresAt: null,
          scope: 'write_customers,write_orders,read_products',
          account: { id: SHOP, name: SHOP },
        }
      },
      refresh: async () => {
        throw new AppError('shopify', 'auth', 'no refresh')
      },
      revoke: async () => true,
      account: async () => ({ id: SHOP, name: SHOP }),
    } satisfies AppOAuth
    return { oauth: async () => oauth, connector: () => ({ id: 'shopify', crm: true, pushCall: vi.fn() }) }
  }

  test('connecting the store marks its request connected: the page stops showing it', async () => {
    const owner: Actor = {
      actorId: ws.owner.userId,
      role: 'owner',
      workspaceId: ws.id,
      permissions: rolePermissions.owner,
    }
    await inRollback(async tx => {
      const run = (name: string, input: unknown) =>
        runHandler(
          { tx, actor: owner, now: new Date().toISOString(), apps: fakeShopify() },
          actions.get(name)!,
          actions.get(name)!.input.parse(input),
        )
      const started = await run('app.connectStart', { app: 'shopify', shop: SHOP })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await run('app.connectFinish', { app: 'shopify', state, code: 'good-code' })
      const [row] = await tx.select().from(app_setup_requests).where(eq(app_setup_requests.workspace_id, ws.id))
      expect(row?.status).toBe('connected')
      expect((await run('shopify.setupStatus', {})).data).toEqual({ way: 'connect', request: null })
      // A connected store keeps its app: a new request would replace the keys its webhooks are signed with.
      await expect(run('shopify.requestSetup', { shop: 'another-store' })).rejects.toMatchObject({
        code: 'already_connected',
      })
    })
  })

  test('failed: the request shows as failed with the code; a new request is possible', async () => {
    const other = await createWorkspace('Other Business')
    await act(other.owner, 'shopify.requestSetup', { shop: 'other-business' })
    const [row] = await openRows(other.id)
    expect((await act(other.owner, 'shopifySetup.failed', { requestId: row!.id, failure: 'no_access' })).status).toBe(
      403,
    )
    expect((await act(admin, 'shopifySetup.failed', { requestId: row!.id, failure: 'No Access!' })).status).toBe(422)
    const res = await act(admin, 'shopifySetup.failed', { requestId: row!.id, failure: 'store_not_found' })
    expect(res.status).toBe(200)
    expect((await act(other.owner, 'shopify.setupStatus', {})).body.data.request).toMatchObject({
      status: 'failed',
      failure: 'store_not_found',
    })
    const again = await act(other.owner, 'shopify.requestSetup', { shop: 'other-business-2' })
    expect(again.body.data.request).toMatchObject({ status: 'requested', shop: 'other-business-2.myshopify.com' })
    expect(await openRows(other.id)).toHaveLength(1)
  })

  test('with the public app approved, every store connects with the install’s app', async () => {
    const other = await createWorkspace('Approved Business')
    expect((await act(other.owner, 'shopify.setupStatus', {})).body.data.way).toBe('request')
    const set = await act(admin, 'provider.setKeys', { provider: 'shopify', values: { public_app_approved: 'true' } })
    expect(set.status).toBe(200)
    try {
      expect((await act(other.owner, 'shopify.setupStatus', {})).body.data.way).toBe('connect')
    } finally {
      await act(admin, 'provider.clearKeys', { provider: 'shopify' })
    }
    expect((await act(other.owner, 'shopify.setupStatus', {})).body.data.way).toBe('request')
  })
})
