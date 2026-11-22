// A store's own Shopify app, set up on request (LIN-719, docs/crm-sync.md "Shopify"). The install's public app connects
// any store only once Shopify approved it in its App Store (Server admin › Providers › Shopify, "Public app approved").
// Until then each store connects through a custom app made for it alone (Shopify lets one store install a custom app):
// 1. A member asks with the store's address (shopify.requestSetup): an app_setup_requests row, and every instance admin
//    gets an email.
// 2. The install's team (or its setup agent, with an instance admin's personal key) makes the app in Shopify's Dev
//    Dashboard, with its app URL at OPEN_PATH below and its redirect URL at /v1/apps/callback/shopify, and hands over its
//    keys and Shopify's install link (shopifySetup.ready): stored as the workspace's own app (provider_settings with its
//    workspace_id, app-connections.ts workspaceAppKeys), and the member who asked gets the link by email. Or it could
//    not (shopifySetup.failed): the page says the team will be in touch.
// 3. The member installs the app on the store with the link; Shopify opens the app's URL (GET OPEN_PATH, signed with the
//    app's secret), which sends the browser to Integrations › Shopify with `connect=<shop>`; the page starts
//    app.connectStart for that store, Shopify answers at once (the app is installed), and app.connectFinish marks the
//    request connected (markShopifySetupConnected).
import {
  isShopifyInstallUrl,
  shopifyPublicAppApproved,
  type ShopifySetupListData,
  type ShopifySetupListItem,
  type ShopifySetupRequest,
  type ShopifySetupStatusData,
} from '@linedesk/actions'
import { shopDomain, verifyShopifyQuery } from '@linedesk/connectors'
import {
  app_connections,
  app_setup_requests,
  member,
  organization,
  provider_settings,
  type Tx,
  user,
} from '@linedesk/db'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Hono } from 'hono'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { workspaceAppKeys, workspaceAppSlot } from './app-connections.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { shopifySetupReadyEmail, shopifySetupRequestedAlert } from './emails/shopify-setup.ts'
import { emailSafeName, WEB_ORIGIN } from './emails/templates.ts'
import { Forbidden, type Handler, NotFound, Reject } from './handler-context.ts'
import { resolveProvider } from './provider-settings.ts'
import { encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'

/** The custom app's URL (its "App URL" in Shopify's Dev Dashboard): <install address>/v1/apps/open/shopify. Stable. */
export const SHOPIFY_OPEN_PATH = '/v1/apps/open/shopify'

/** The custom app's URL at this install: what the agent sets as the app's URL. */
export const shopifyOpenUrl = (
  base = process.env.BETTER_AUTH_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173',
) => new URL(SHOPIFY_OPEN_PATH, base).toString()

type Row = typeof app_setup_requests.$inferSelect

/** A workspace may ask for another store at most this often: each request alerts every instance admin and makes an app. */
export const REQUEST_EVERY_MS = 10 * 60_000

const newId = () => `asr_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const OPEN = ne(app_setup_requests.status, 'connected')

function workspaceOf(actor: { workspaceId: string | null }) {
  if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
  return actor.workspaceId
}

const shown = (row: Row): ShopifySetupRequest => ({
  id: row.id,
  shop: row.shop,
  status: row.status,
  installUrl: row.install_url,
  failure: row.failure,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

async function openRequest(tx: Tx, workspaceId: string): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(app_setup_requests)
    .where(and(eq(app_setup_requests.workspace_id, workspaceId), eq(app_setup_requests.provider, 'shopify'), OPEN))
  return row
}

/** Whether the install's Shopify app is marked approved: then any store connects with it. */
async function publicAppApproved(tx: Tx): Promise<boolean> {
  return shopifyPublicAppApproved((await resolveProvider(tx, 'shopify')).public_app_approved?.value)
}

/** Whether the workspace has its own Shopify app stored (a key that no longer decrypts counts: Connect says why). */
async function hasOwnApp(tx: Tx, workspaceId: string): Promise<boolean> {
  try {
    return (await workspaceAppKeys(tx, 'shopify', workspaceId)) !== null
  } catch (error) {
    if (error instanceof SecretsKeyError) return true
    throw error
  }
}

/**
 * Whether Connect opens Shopify's consent page for this workspace: it has its own app, or the install's public app is
 * approved. Otherwise the store's own app is set up on request first (app.connectStart refuses with `setup_needed`).
 */
export async function shopifyConnectOpen(tx: Tx, workspaceId: string): Promise<boolean> {
  return (await hasOwnApp(tx, workspaceId)) || (await publicAppApproved(tx))
}

async function statusData(tx: Tx, workspaceId: string): Promise<ShopifySetupStatusData> {
  const row = await openRequest(tx, workspaceId)
  return {
    way: (await shopifyConnectOpen(tx, workspaceId)) ? 'connect' : 'request',
    request: row ? shown(row) : null,
  }
}

/** The connect of this store finished: the workspace's open request for it is done (app.connectFinish). */
export async function markShopifySetupConnected(tx: Tx, workspaceId: string, shop: string, now: string) {
  await tx
    .update(app_setup_requests)
    .set({ status: 'connected', updated_at: now })
    .where(
      and(
        eq(app_setup_requests.workspace_id, workspaceId),
        eq(app_setup_requests.provider, 'shopify'),
        eq(app_setup_requests.shop, shop),
        OPEN,
      ),
    )
}

async function workspaceName(tx: Tx, workspaceId: string): Promise<string> {
  const [row] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, workspaceId))
  return row?.name ?? ''
}

/** Who gets the "ready" email: the member who asked while they are still in the workspace, else its owner. */
async function readyRecipient(tx: Tx, row: Row): Promise<{ userId: string; email: string } | null> {
  const people = await tx
    .select({ userId: member.userId, role: member.role, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, row.workspace_id))
  const asker = people.find(p => p.userId === row.requested_by)
  const owner = people.find(p => p.role === 'owner')
  const to = asker ?? owner
  return to ? { userId: to.userId, email: to.email } : null
}

async function requestById(tx: Tx, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(app_setup_requests)
    .where(and(eq(app_setup_requests.id, id), eq(app_setup_requests.provider, 'shopify')))
  if (!row) throw NotFound.t('server.api.shopifySetup.notFound')
  if (row.status === 'connected') throw Reject.t('server.api.shopifySetup.connected', undefined, 'connected')
  return row
}

async function storeOwnApp(
  tx: Tx,
  workspaceId: string,
  keys: { client_id: string; client_secret: string },
  actorId: string,
  now: string,
) {
  for (const [field, value] of Object.entries(keys)) {
    await tx
      .delete(provider_settings)
      .where(
        and(
          eq(provider_settings.workspace_id, workspaceId),
          eq(provider_settings.provider, 'shopify'),
          eq(provider_settings.field, field),
        ),
      )
    await tx.insert(provider_settings).values({
      id: `ps_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      workspace_id: workspaceId,
      provider: 'shopify',
      field,
      value_encrypted: encryptSecret(value, workspaceAppSlot(workspaceId, 'shopify', field)),
      last4: field === 'client_secret' && value.length >= 12 ? value.slice(-4) : null,
      updated_at: now,
      updated_by: actorId,
    })
  }
}

export const shopifySetupHandlers: Record<string, Handler> = {
  'shopify.setupStatus': async ({ tx, actor }) => ({ rows: {}, data: await statusData(tx, workspaceOf(actor)) }),

  'shopify.requestSetup': async ({ tx, actor, now, onCommit }, input: { shop: string }) => {
    const workspaceId = workspaceOf(actor)
    // The request names the store the install's team sets up for this workspace: the member's own, never an admin's.
    if (actor.impersonation) throw Forbidden.t('server.api.shopifySetup.impersonating')
    const shop = shopDomain(input.shop)
    if (!shop) throw Reject.t('server.api.shopifySetup.shop', undefined, 'shop')
    // A connected store keeps its app's keys: a new app's keys would make its webhooks (uninstall, redact) fail.
    const [connected] = await tx
      .select({ id: app_connections.id })
      .from(app_connections)
      .where(and(eq(app_connections.workspace_id, workspaceId), eq(app_connections.provider, 'shopify')))
    if (connected) throw Reject.t('server.api.shopifySetup.alreadyConnected', undefined, 'already_connected')
    const open = await openRequest(tx, workspaceId)
    // The same store asked again while it is being set up: nothing new, no second alert.
    if (open && open.shop === shop && open.status !== 'failed')
      return { rows: {}, data: { ...(await statusData(tx, workspaceId)), request: shown(open) } }
    // Another store while one is still being set up: not again within minutes (a failed one may be replaced at once).
    if (open && open.status !== 'failed' && Date.parse(now) - Date.parse(open.created_at) < REQUEST_EVERY_MS)
      throw Reject.t('server.api.shopifySetup.tooSoon', undefined, 'too_soon')
    // One open request per workspace: a new one replaces it (another store, or asked again after a failure). Keys a
    // ready request stored stay until the next ready replaces them.
    await tx
      .delete(app_setup_requests)
      .where(and(eq(app_setup_requests.workspace_id, workspaceId), eq(app_setup_requests.provider, 'shopify'), OPEN))
    const [row] = await tx
      .insert(app_setup_requests)
      .values({
        id: newId(),
        workspace_id: workspaceId,
        provider: 'shopify',
        shop,
        requested_by: actor.actorId,
        created_at: now,
        updated_at: now,
      })
      .returning()
    const name = emailSafeName(await workspaceName(tx, workspaceId), workspaceId)
    const [asker] = await tx.select({ email: user.email }).from(user).where(eq(user.id, actor.actorId))
    onCommit?.(() =>
      alertInstanceAdmins(
        shopifySetupRequestedAlert({
          workspace: name,
          workspaceId,
          shop,
          by: asker?.email ?? null,
          reviewUrl: `${WEB_ORIGIN}/#admin/overview`,
        }),
      ),
    )
    const data: ShopifySetupStatusData = { ...(await statusData(tx, workspaceId)), request: shown(row!) }
    return { rows: {}, data }
  },

  'shopifySetup.list': async ({ tx }, input: { status?: 'requested' | 'ready' | 'failed' }) => {
    const rows = await tx
      .select({
        request: app_setup_requests,
        workspaceName: organization.name,
        email: user.email,
      })
      .from(app_setup_requests)
      .leftJoin(organization, eq(organization.id, app_setup_requests.workspace_id))
      .leftJoin(user, eq(user.id, app_setup_requests.requested_by))
      .where(
        and(
          eq(app_setup_requests.provider, 'shopify'),
          input.status ? eq(app_setup_requests.status, input.status) : OPEN,
        ),
      )
      .orderBy(asc(app_setup_requests.created_at))
    const requests: ShopifySetupListItem[] = rows.map(({ request, workspaceName, email }) => ({
      id: request.id,
      workspaceId: request.workspace_id,
      workspaceName: workspaceName ?? '',
      shop: request.shop,
      status: request.status,
      requestedBy: email,
      failure: request.failure,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
    }))
    const data: ShopifySetupListData = { requests }
    return { rows: {}, data }
  },

  'shopifySetup.ready': async (
    { tx, actor, now, onCommit },
    input: { requestId: string; clientId: string; clientSecret: string; installUrl: string },
  ) => {
    if (!hasSecretsKey()) throw Reject.t('server.api.shopifySetup.noSecretsKey', undefined, 'no_secrets_key')
    const row = await requestById(tx, input.requestId)
    if (!isShopifyInstallUrl(input.installUrl, row.shop, input.clientId))
      throw Reject.t('server.api.shopifySetup.installUrl', { shop: row.shop }, 'install_url')
    await storeOwnApp(
      tx,
      row.workspace_id,
      { client_id: input.clientId, client_secret: input.clientSecret },
      actor.actorId,
      now,
    )
    const [ready] = await tx
      .update(app_setup_requests)
      .set({ status: 'ready', install_url: input.installUrl, failure: null, updated_at: now })
      .where(and(eq(app_setup_requests.id, row.id), OPEN))
      .returning()
    // Replaced or connected meanwhile: the keys are not stored either (the transaction rolls back).
    if (!ready) throw NotFound.t('server.api.shopifySetup.notFound')
    const to = await readyRecipient(tx, row)
    if (to) {
      const locale = await localeForUserId(tx, to.userId)
      onCommit?.(async () =>
        sendNotice(
          {
            to: to.email,
            ...shopifySetupReadyEmail(
              { workspaceId: row.workspace_id, shop: row.shop, installUrl: input.installUrl },
              undefined,
              locale,
            ),
          },
          'shopify setup ready email',
        ),
      )
    }
    return { rows: {}, data: { request: shown(ready), emailed: to !== null, openUrl: shopifyOpenUrl() } }
  },

  'shopifySetup.failed': async ({ tx, now }, input: { requestId: string; failure: string }) => {
    const row = await requestById(tx, input.requestId)
    const [failed] = await tx
      .update(app_setup_requests)
      .set({ status: 'failed', failure: input.failure, updated_at: now })
      .where(and(eq(app_setup_requests.id, row.id), OPEN))
      .returning()
    if (!failed) throw NotFound.t('server.api.shopifySetup.notFound')
    return { rows: {}, data: { request: shown(failed) } }
  },
}

/** The workspaces a signed open request for this store may come from: its ready or connected requests, newest first. */
async function candidates(shop: string) {
  return db
    .select({ workspaceId: app_setup_requests.workspace_id })
    .from(app_setup_requests)
    .where(
      and(
        eq(app_setup_requests.provider, 'shopify'),
        eq(app_setup_requests.shop, shop),
        inArray(app_setup_requests.status, ['ready', 'connected']),
      ),
    )
    .orderBy(desc(app_setup_requests.updated_at))
}

/**
 * Where GET SHOPIFY_OPEN_PATH sends the browser: Integrations › Shopify of the workspace whose own app signed the query
 * (`hmac` with that app's client secret, verifyShopifyQuery), with `connect=<shop>` and `ws=<workspace>`; the page then
 * connects that store. Anything else (no store, no such request, a wrong signature): Integrations › Shopify alone. Only
 * a redirect: it changes nothing, so a replayed link does no more than the page's own Connect.
 */
export async function shopifyOpenTarget(query: URLSearchParams, webOrigin: string): Promise<string> {
  const page = (params?: Record<string, string>) =>
    `${new URL('/', webOrigin)}#integrations/shopify${params ? `?${new URLSearchParams(params)}` : ''}`
  const shop = shopDomain(query.get('shop') ?? '')
  if (!shop || !query.get('hmac')) return page()
  const params = Object.fromEntries(query)
  const seen = new Set<string>()
  for (const { workspaceId } of await candidates(shop)) {
    if (seen.has(workspaceId)) continue
    seen.add(workspaceId)
    let keys: { clientSecret: string } | null
    try {
      keys = await workspaceAppKeys(db, 'shopify', workspaceId)
    } catch (error) {
      if (!(error instanceof SecretsKeyError)) throw error
      continue
    }
    if (keys && (await verifyShopifyQuery(params, keys.clientSecret))) return page({ connect: shop, ws: workspaceId })
  }
  return page()
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerShopifyOpenRoute(app: Hono<any>, webOrigin: string) {
  app.get(SHOPIFY_OPEN_PATH, async c => c.redirect(await shopifyOpenTarget(new URL(c.req.url).searchParams, webOrigin)))
}
