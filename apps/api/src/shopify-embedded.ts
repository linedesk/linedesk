// The install's own Shopify app in Shopify's App Store (docs/crm-sync.md "Shopify"): its embedded page in the store's
// admin, the store's access, and linking the store to a Linedesk workspace.
//
// 1. Shopify installs the app (Shopify-managed install: Shopify asks for the scopes, never this server) and opens its
//    App URL, GET SHOPIFY_EMBEDDED_PATH?shop=…, in an iframe of the store's admin. The page loads App Bridge first, may
//    be framed only by that store's admin (CSP frame-ancestors), sets no cookie and stores nothing in the browser.
// 2. The page asks POST SHOPIFY_SESSION_PATH with App Bridge's session token as a Bearer token. Not an action: it is
//    Shopify's sign-in, like the OAuth callback. The token is checked (verifyShopifySessionToken: HS256 with the
//    install's client secret, the app's client ID, a minute's validity, the store's own admin as issuer) and, while
//    the store is not linked, exchanged for the store's offline access (Shopify's token exchange), kept in
//    shopify_installs encrypted with SECRETS_KEY. The answer: the store, the workspace it is linked to, and a
//    single-use link (15 minutes, stored as its SHA-256) to `#shopify/link?t=…` in the web app.
// 3. There a member signs in, picks a workspace where they are an owner or admin and confirms: shopify.linkInstall
//    makes the workspace's Shopify connection from the stored access, as Connect does (app-connections.ts
//    storeConnection), so the assistant's tools, the pushes and the webhooks work as for any connected store; the
//    install row then keeps only the workspace. The embedded page asks again and shows the store linked.
// 4. `app/uninstalled` (shopify-webhook.ts) removes the connections as before and marks the install uninstalled
//    (markShopifyUninstalled). A new install of the same store starts again at 1 with the same row.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AppConnectError,
  SHOPIFY_LINK_HASH,
  type ShopifyEmbeddedStatus,
  type ShopifyLinkData,
  type ShopifyLinkError,
  type ShopifyLinkInfo,
} from '@linedesk/actions'
import { AppError, type OAuthTokens, shopDomain, verifyShopifySessionToken } from '@linedesk/connectors'
import { app_connections, organization, shopify_installs, shopify_link_tokens, type Tx } from '@linedesk/db'
import { matchLocale, msg } from '@linedesk/i18n'
import { localeForUser } from '@linedesk/i18n/server'
import { and, asc, eq, lt, or } from 'drizzle-orm'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  type AppServices,
  appServicesOf,
  defaultAppServices,
  lockAccount,
  lockConnection,
  storeConnection,
  workspaceAppKeys,
  workspaceScope,
} from './app-connections.ts'
import { addressBucket, clientIpOf } from './client-ip.ts'
import { db } from './db.ts'
import { createRateLimiter } from './rate-limit.ts'
import { shopifyEmbeddedPage } from './emails/shopify-app.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { resolveProvider } from './provider-settings.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'
import { markShopifySetupConnected } from './shopify-setup.ts'

/** The app's URL in Shopify (`application_url`), where Shopify opens the embedded page: stable. */
export const SHOPIFY_EMBEDDED_PATH = '/shopify/app'
/** Where the embedded page asks with its session token. */
export const SHOPIFY_SESSION_PATH = '/v1/shopify/embedded/session'
/** A link from the embedded page to the web app is good for this long, and once. */
export const SHOPIFY_LINK_TTL_MS = 15 * 60_000
/**
 * While a store is not linked, its stored access is exchanged again when older than this: an unused refresh token runs
 * out, and a link made later must find access that still works.
 */
const EXCHANGE_AGAIN_MS = 24 * 60 * 60_000
/** Scopes the store must have granted before a link (as app-connections.ts REQUIRED_SCOPES for a connect). */
const REQUIRED_SCOPES = ['write_customers', 'write_orders', 'read_products'] as const

/** The slot (secrets.ts) of a store's stored access: bound to the store and the kind. */
export const shopifyInstallSlot = (shop: string, kind: 'access' | 'refresh') => `shopify-install.${shop}.${kind}`

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const newId = () => `shi_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

type Install = typeof shopify_installs.$inferSelect

/** The install's own Shopify app (Server admin › Providers › Shopify), or null when it is not set up. */
async function installApp(tx: Tx): Promise<{ clientId: string; clientSecret: string } | null> {
  const config = await resolveProvider(tx, 'shopify')
  const clientId = config.client_id?.value
  const clientSecret = config.client_secret?.value
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

async function installOf(tx: Tx, shop: string): Promise<Install | undefined> {
  const [row] = await tx.select().from(shopify_installs).where(eq(shopify_installs.shop, shop))
  return row
}

/**
 * The workspace the store is linked to: one with a connection to the store made with the install's app (a workspace
 * with its own custom app is another app's install). The install's own workspace first, else the oldest such
 * connection (a store connected with Connect before it was installed from the App Store).
 */
async function linkedWorkspace(tx: Tx, shop: string, preferred: string | null) {
  const rows = await tx
    .select({ id: organization.id, name: organization.name })
    .from(app_connections)
    .innerJoin(organization, eq(organization.id, app_connections.workspace_id))
    .where(
      and(
        eq(app_connections.provider, 'shopify'),
        eq(app_connections.account_id, shop),
        workspaceScope('shopify', 'install'),
      ),
    )
    .orderBy(asc(app_connections.created_at))
  return rows.find(row => row.id === preferred) ?? rows[0] ?? null
}

/** Whether a required scope is missing; no scope named at all counts as missing (closed, unlike a connect's check). */
function missingScope(scope: string | null) {
  if (!scope) return true
  const granted = scope.split(/[\s,]+/)
  return REQUIRED_SCOPES.some(required => !granted.includes(required))
}

/** The stored access of an install as tokens, or null when it has none (linked, uninstalled). */
function storedTokens(row: Install): (OAuthTokens & { refreshToken: string }) | null {
  if (!row.access_token_encrypted || !row.refresh_token_encrypted || row.uninstalled_at) return null
  return {
    accessToken: decryptSecret(row.access_token_encrypted, shopifyInstallSlot(row.shop, 'access')),
    refreshToken: decryptSecret(row.refresh_token_encrypted, shopifyInstallSlot(row.shop, 'refresh')),
    expiresAt: row.expires_at,
    scope: row.scope,
  }
}

/** Saves a fresh exchange: the row is made, or its access replaced (a new install after an uninstall, a renewal). */
async function saveExchange(tx: Tx, shop: string, tokens: OAuthTokens, now: string) {
  const refresh = tokens.refreshToken ?? tokens.accessToken
  const values = {
    shop_name: tokens.account?.name ?? null,
    access_token_encrypted: encryptSecret(tokens.accessToken, shopifyInstallSlot(shop, 'access')),
    refresh_token_encrypted: encryptSecret(refresh, shopifyInstallSlot(shop, 'refresh')),
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    exchanged_at: now,
    uninstalled_at: null,
    updated_at: now,
  }
  const before = await installOf(tx, shop)
  await tx
    .insert(shopify_installs)
    .values({ id: newId(), shop, installed_at: now, ...values })
    .onConflictDoUpdate({
      target: shopify_installs.shop,
      // Installed again after an uninstall: a new install date, and linked to nothing yet.
      set: before?.uninstalled_at ? { ...values, installed_at: now, workspace_id: null } : values,
    })
}

/**
 * A new single-use link to the web app's link page, naming the owner who started it. One live link per store: the
 * store's earlier ones go, and expired links of every store with them.
 */
async function newLink(tx: Tx, shop: string, startedBy: string | null, now: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await tx
    .delete(shopify_link_tokens)
    .where(or(eq(shopify_link_tokens.shop, shop), lt(shopify_link_tokens.expires_at, now)))
  await tx.insert(shopify_link_tokens).values({
    token_hash: hashToken(token),
    shop,
    started_by: startedBy,
    expires_at: new Date(Date.parse(now) + SHOPIFY_LINK_TTL_MS).toISOString(),
  })
  return `${new URL('/', WEB_ORIGIN)}${SHOPIFY_LINK_HASH}?t=${token}`
}

const openUrl = (workspaceId: string) =>
  `${new URL('/', WEB_ORIGIN)}#integrations/shopify?ws=${encodeURIComponent(workspaceId)}`

/**
 * How often the embedded page may ask (it polls every 4 seconds while not linked, and on focus): per store, after the
 * token is checked, and per address before (the route).
 */
export const SESSIONS_PER_SHOP_PER_MINUTE = 60
const limiters = () => ({
  perShop: createRateLimiter({ max: SESSIONS_PER_SHOP_PER_MINUTE, windowMs: 60_000 }),
  perAddress: createRateLimiter({ max: 120, windowMs: 60_000 }),
})
let limits = limiters()

/** Forgets the limits (tests). */
export function resetShopifyEmbeddedLimits() {
  limits = limiters()
}

export type EmbeddedAnswer =
  | { status: 200; body: { ok: true; data: ShopifyEmbeddedStatus } }
  | { status: 401 | 404 | 429 | 502 | 503; body: { ok: false; error: string; code: string } }

/** A refusal the page words by its status; the code is the error too (no text: the page writes its own). */
const refused = (status: 401 | 404 | 429 | 502 | 503, code: string): EmbeddedAnswer => ({
  status,
  body: { ok: false, error: code, code },
})

/**
 * What the embedded page shows, for its session token (step 2 above). `link`: a new single-use link when the store is
 * not linked (the page asks for one when it opens and before an old one runs out, never on every poll).
 */
export async function embeddedSession(
  sessionToken: string,
  { link }: { link: boolean },
  services: AppServices = defaultAppServices,
  now: string = new Date().toISOString(),
): Promise<EmbeddedAnswer> {
  let keys: { clientId: string; clientSecret: string } | null
  try {
    keys = await installApp(db)
  } catch (error) {
    if (!(error instanceof SecretsKeyError)) throw error
    return refused(503, 'not_set_up')
  }
  if (!keys) return refused(404, 'not_set_up')
  const claims = await verifyShopifySessionToken(sessionToken, keys, Date.parse(now))
  if (!claims) return refused(401, 'session')
  if (!hasSecretsKey()) return refused(503, 'no_secrets_key')
  const { shop } = claims
  if (!limits.perShop(shop, Date.parse(now))) return refused(429, 'too_many')
  const row = await installOf(db, shop)
  const linked = await linkedWorkspace(db, shop, row?.workspace_id ?? null)
  if (!linked) {
    const fresh =
      row &&
      !row.uninstalled_at &&
      row.refresh_token_encrypted &&
      row.exchanged_at &&
      Date.parse(now) - Date.parse(row.exchanged_at) < EXCHANGE_AGAIN_MS
    if (!fresh) {
      const oauth = await services.oauth(db, 'shopify')
      if (!oauth?.tokenExchange) return refused(404, 'not_set_up')
      let tokens: OAuthTokens
      try {
        tokens = await oauth.tokenExchange({ shop, sessionToken })
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        console.warn(`shopify embedded: the token exchange for ${shop} failed (${error.kind}): ${error.message}`)
        return refused(502, 'exchange')
      }
      await db.transaction(tx => saveExchange(tx, shop, tokens, now))
    }
  }
  // A link only for the store's owner (any staff member with access to the app could otherwise hand the whole store
  // to a workspace), naming their address: who the online token is for, the token itself dropped at once.
  let owner: { email: string | null } | null = null
  let ownerOnly = false
  if (!linked && link) {
    const oauth = await services.oauth(db, 'shopify')
    if (!oauth?.sessionUser) return refused(404, 'not_set_up')
    try {
      const user = await oauth.sessionUser({ shop, sessionToken })
      if (user.accountOwner) owner = { email: user.email }
      else ownerOnly = true
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      console.warn(`shopify embedded: reading the staff member of ${shop} failed (${error.kind}): ${error.message}`)
      return refused(502, 'exchange')
    }
  }
  return db.transaction(async tx => {
    const install = await installOf(tx, shop)
    if (linked && (install?.workspace_id !== linked.id || install.access_token_encrypted || install.uninstalled_at)) {
      // Linked (also a store connected with Connect before): the connection holds the access, this row the workspace.
      await tx
        .insert(shopify_installs)
        .values({ id: newId(), shop, workspace_id: linked.id, installed_at: now, updated_at: now })
        .onConflictDoUpdate({
          target: shopify_installs.shop,
          set: {
            workspace_id: linked.id,
            access_token_encrypted: null,
            refresh_token_encrypted: null,
            expires_at: null,
            uninstalled_at: null,
            updated_at: now,
          },
        })
    }
    const name = install?.shop_name ?? shop
    const data: ShopifyEmbeddedStatus = {
      shop,
      shopName: name,
      workspace: linked,
      linkUrl: owner ? await newLink(tx, shop, owner.email, now) : null,
      openUrl: linked ? openUrl(linked.id) : null,
      ownerOnly,
    }
    return { status: 200 as const, body: { ok: true as const, data } }
  })
}

/**
 * The app's uninstall (shopify-webhook.ts, `app/uninstalled` or `shop/redact` signed by the install's app): the store's
 * stored access and open links go, and it is linked to nothing. An install made after the event stays.
 */
export async function markShopifyUninstalled(tx: Tx, shop: string, grantedBefore: string | null, now: string) {
  // The lock a link takes for the store (shopify.linkInstall): an uninstall and a link never interleave.
  await lockAccount(tx, 'shopify', shop)
  // Every open link goes, whatever comes next: a link made before the uninstall must not outlive it.
  await tx.delete(shopify_link_tokens).where(eq(shopify_link_tokens.shop, shop))
  const install = await installOf(tx, shop)
  if (!install) return
  // Access granted again after the event (a new exchange, or a link: a late or replayed delivery): it stays.
  if (grantedBefore && install.exchanged_at && Date.parse(install.exchanged_at) >= Date.parse(grantedBefore)) return
  await tx
    .update(shopify_installs)
    .set({
      workspace_id: null,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      expires_at: null,
      uninstalled_at: install.uninstalled_at ?? now,
      updated_at: now,
    })
    .where(eq(shopify_installs.shop, shop))
}

/** A refusal of the link page, with the code it words. */
const linkRefused = (key: Parameters<typeof Reject.t>[0], code: ShopifyLinkError | AppConnectError) =>
  Reject.t(key, undefined, code)

/** The link a token names, still good; refused otherwise. `take`: used up (shopify.linkInstall). */
async function linkOf(tx: Tx, token: string, now: string, take: boolean) {
  const where = eq(shopify_link_tokens.token_hash, hashToken(token))
  const [found] = take
    ? await tx.delete(shopify_link_tokens).where(where).returning()
    : await tx.select().from(shopify_link_tokens).where(where)
  if (!found) throw linkRefused(msg('server.api.shopifyApp.linkInvalid'), 'link_invalid')
  if (Date.parse(found.expires_at) < Date.parse(now))
    throw linkRefused(msg('server.api.shopifyApp.linkExpired'), 'link_expired')
  const install = await installOf(tx, found.shop)
  if (!install || install.uninstalled_at) throw linkRefused(msg('server.api.shopifyApp.notInstalled'), 'not_installed')
  return { link: found, install }
}

async function connectedShop(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select()
    .from(app_connections)
    .where(and(eq(app_connections.workspace_id, workspaceId), eq(app_connections.provider, 'shopify')))
  return row
}

export const shopifyEmbeddedHandlers: Record<string, Handler> = {
  'shopify.describeLink': async ({ tx, actor, now }, input: { token: string }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const { link, install } = await linkOf(tx, input.token, now, false)
    const data: ShopifyLinkInfo = {
      shop: install.shop,
      shopName: install.shop_name ?? install.shop,
      expiresAt: link.expires_at,
      connectedShop: (await connectedShop(tx, actor.workspaceId))?.account_id ?? null,
      startedBy: link.started_by,
    }
    return { rows: {}, data }
  },

  'shopify.linkInstall': async ({ tx, actor, now, onCommit, ...ctx }, input: { token: string }) => {
    const workspaceId = actor.workspaceId
    if (!workspaceId) throw Reject.t('server.api.noWorkspace')
    // The store's access would go into the user's workspace on an admin's word.
    if (actor.impersonation) throw Forbidden.t('server.api.shopifySetup.impersonating')
    if (!hasSecretsKey()) throw linkRefused(msg('server.api.shopifySetup.noSecretsKey'), 'no_secrets_key')
    const { install } = await linkOf(tx, input.token, now, true)
    const shop = install.shop
    // One store per workspace, one workspace per store (the grant is the store's: grantPerAccount).
    await lockAccount(tx, 'shopify', shop)
    const existing = await connectedShop(tx, workspaceId)
    if (existing && existing.account_id !== shop)
      throw linkRefused(msg('server.api.shopifyApp.otherStore'), 'other_store')
    const elsewhere = await linkedWorkspace(tx, shop, null)
    if (elsewhere && elsewhere.id !== workspaceId)
      throw linkRefused(msg('server.api.shopifyApp.linkedElsewhere'), 'linked_elsewhere')
    if (await workspaceAppKeys(tx, 'shopify', workspaceId))
      throw linkRefused(msg('server.api.shopifyApp.ownApp'), 'own_app')
    const tokens = storedTokens(install)
    if (!tokens) throw linkRefused(msg('server.api.shopifyApp.notInstalled'), 'not_installed')
    if (missingScope(tokens.scope)) throw linkRefused(msg('server.api.shopifyApp.scope'), 'scope')
    const oauth = await appServicesOf(ctx).oauth(tx, 'shopify', workspaceId)
    if (!oauth) throw linkRefused(msg('server.api.shopifyApp.notInstalled'), 'not_installed')
    if (existing) await lockConnection(tx, existing.id)
    const connection = await storeConnection(tx, {
      workspaceId,
      app: 'shopify',
      account: { id: shop, name: install.shop_name ?? shop },
      tokens,
      grant: tokens.refreshToken,
      oauth,
      actorId: actor.actorId,
      onCommit,
    })
    // The connection holds the access now; the install keeps the workspace only.
    await tx
      .update(shopify_installs)
      .set({
        workspace_id: workspaceId,
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        expires_at: null,
        exchanged_at: now,
        updated_at: now,
      })
      .where(eq(shopify_installs.shop, shop))
    await tx.delete(shopify_link_tokens).where(eq(shopify_link_tokens.shop, shop))
    await markShopifySetupConnected(tx, workspaceId, shop, now)
    const data: ShopifyLinkData = { shop, connectionId: connection.id }
    return { rows: { app_connections: [connection] }, data }
  },
}

/** The embedded page's language: the one Shopify's admin is in (`locale`), else the browser's. */
function pageLocale(shopifyLocale: string | undefined, acceptLanguage: string | undefined) {
  return shopifyLocale ? matchLocale([shopifyLocale]) : localeForUser(null, acceptLanguage)
}

/**
 * The CSP of the embedded page: framed only by this store's admin (App Store rule: per store, from the `shop` the
 * request names); scripts only App Bridge's (and what it loads from Shopify's CDN) and the page's own. Styles and
 * requests are left to App Bridge.
 */
export function embeddedCsp(shop: string | null, nonce: string) {
  const ancestors = shop ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com'
  return `frame-ancestors ${ancestors}; script-src https://cdn.shopify.com 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'`
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not these routes' concern
export function registerShopifyEmbeddedRoutes(app: Hono<any>) {
  app.get(SHOPIFY_EMBEDDED_PATH, async c => {
    const shop = shopDomain(c.req.query('shop') ?? '')
    const named = shop && c.req.query('shop') === shop ? shop : null
    const nonce = randomBytes(16).toString('base64')
    c.header('content-security-policy', embeddedCsp(named, nonce))
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'strict-origin-when-cross-origin')
    let clientId: string | null = null
    try {
      clientId = (await installApp(db))?.clientId ?? null
    } catch (error) {
      if (!(error instanceof SecretsKeyError)) throw error
    }
    const locale = pageLocale(c.req.query('locale'), c.req.header('accept-language'))
    if (!clientId || !named) return c.html(shopifyEmbeddedPage({ locale, nonce, clientId: null }), 404)
    return c.html(shopifyEmbeddedPage({ locale, nonce, clientId, sessionPath: SHOPIFY_SESSION_PATH }))
  })

  app.post(
    SHOPIFY_SESSION_PATH,
    bodyLimit({ maxSize: 4096, onError: c => c.json({ ok: false, error: 'too_large', code: 'too_large' }, 413) }),
    async c => {
      c.header('cache-control', 'no-store')
      if (!limits.perAddress(addressBucket(clientIpOf(c))))
        return c.json({ ok: false, error: 'too_many', code: 'too_many' }, 429)
      const bearer = /^Bearer\s+([A-Za-z0-9_.-]+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
      if (!bearer) return c.json({ ok: false, error: 'session', code: 'session' }, 401)
      const body = (await c.req.json().catch(() => null)) as { link?: unknown } | null
      const answer = await embeddedSession(bearer, { link: body?.link === true })
      return c.json(answer.body, answer.status)
    },
  )
}
