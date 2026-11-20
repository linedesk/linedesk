// POST /v1/apps/webhook/shopify (LIN-666): Shopify's webhooks for the app. `app/uninstalled`: a store that removes
// Linedesk has its connections deleted here with their tokens (app-connections.ts dropAppAccount), in every workspace
// connected to that store. The three privacy topics every public Shopify app must answer: `shop/redact` (48 hours
// after an uninstall: whatever is left of the store goes, as for app/uninstalled), `customers/redact` (the links from
// Linedesk contacts to that Shopify customer go; the calls themselves are the business's own records) and
// `customers/data_request` (Linedesk keeps no Shopify customer data beyond those links: answered 200, nothing to send).
//
// No session: Shopify signs the raw body with the app's client secret (Server admin › Providers › Shopify), base64
// HMAC-SHA256 in X-Shopify-Hmac-SHA256; a missing or wrong signature is 401, as Shopify's review checks. The topic and
// the store come from X-Shopify-Topic and X-Shopify-Shop-Domain. Delivery is at least once: a repeat finds nothing.
import { shopDomain, verifyShopifyWebhook } from '@linedesk/connectors'
import { app_connections, crm_links } from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { dropAppAccount } from './app-connections.ts'
import { db } from './db.ts'
import { resolveProvider } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'

export const SHOPIFY_WEBHOOK_PATH = '/v1/apps/webhook/shopify'
const MAX_BYTES = 256 * 1024
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{43}=$/

const REFUSED_LOG_MS = 60_000
const refusedLog = { at: 0, count: 0 }
function logRefused(reason: string, now = Date.now()) {
  refusedLog.count++
  if (now - refusedLog.at < REFUSED_LOG_MS) return
  console.warn(`shopify webhook: ${refusedLog.count} deliveries refused since the last note (latest: ${reason})`)
  refusedLog.at = now
  refusedLog.count = 0
}

async function shopifyClientSecret() {
  try {
    return (await resolveProvider(db, 'shopify')).client_secret?.value ?? null
  } catch (error) {
    if (!(error instanceof SecretsKeyError)) throw error
    logRefused('the stored Shopify client secret cannot be decrypted')
    return null
  }
}

/** The Shopify customer ids of a customers/redact body (`customer.id`, a number), as the gids the links store. */
export function redactedCustomerIds(body: unknown): string[] {
  const id = (body as { customer?: { id?: unknown } } | null)?.customer?.id
  if (typeof id !== 'number' && !(typeof id === 'string' && /^\d+$/.test(id))) return []
  return [`gid://shopify/Customer/${id}`]
}

/** The store a signed body names, as its myshopify.com domain; null when it names none. */
export function shopOf(body: unknown): string | null {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const named = [fields.shop_domain, fields.myshopify_domain].find(v => typeof v === 'string')
  return typeof named === 'string' ? shopDomain(named) : null
}

/** Forgets the log throttle (tests). */
export function resetShopifyWebhookLimits() {
  refusedLog.at = 0
  refusedLog.count = 0
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerShopifyWebhookRoute(app: Hono<any>) {
  app.post(
    SHOPIFY_WEBHOOK_PATH,
    bodyLimit({ maxSize: MAX_BYTES, onError: c => c.json({ ok: false, error: 'request too large' }, 413) }),
    async c => {
      const signature = c.req.header('x-shopify-hmac-sha256')
      if (!signature || !SIGNATURE_SHAPE.test(signature)) {
        logRefused(signature ? 'malformed signature header' : 'missing signature')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      const clientSecret = await shopifyClientSecret()
      if (!clientSecret) return c.notFound()
      const raw = await c.req.text()
      if (!(await verifyShopifyWebhook(raw, signature, clientSecret))) {
        logRefused('bad signature')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      const topic = c.req.header('x-shopify-topic') ?? ''
      let body: unknown = null
      try {
        body = JSON.parse(raw)
      } catch {}
      // The store from the signed body (the shop header is not signed): `shop_domain` for the privacy topics,
      // `myshopify_domain` for app/uninstalled (its body is the shop).
      const shop = shopOf(body)
      if (!shop) return c.json({ ok: true, ignored: true })
      if (topic === 'app/uninstalled' || topic === 'shop/redact') {
        // A grant made after the event stays: a late or replayed delivery never removes a store connected again.
        const at = Date.parse(c.req.header('x-shopify-triggered-at') ?? '')
        const grantedBefore = Number.isFinite(at) ? new Date(at - 60_000).toISOString() : null
        const deleted = await db.transaction(tx => dropAppAccount(tx, 'shopify', [shop], grantedBefore))
        if (deleted.length) console.log(`shopify webhook: ${topic} removed ${deleted.length} connection(s)`)
        return c.json({ ok: true })
      }
      if (topic === 'customers/redact') {
        const customers = redactedCustomerIds(body)
        if (customers.length) {
          const connections = db
            .select({ id: app_connections.id })
            .from(app_connections)
            .where(and(eq(app_connections.provider, 'shopify'), eq(app_connections.account_id, shop)))
          await db
            .delete(crm_links)
            .where(and(inArray(crm_links.connection_id, connections), inArray(crm_links.external_id, customers)))
        }
        return c.json({ ok: true })
      }
      // customers/data_request and anything else: signed, nothing to do.
      return c.json({ ok: true, ignored: true })
    },
  )
}
