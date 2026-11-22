import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js'
import { type CrmContact, type CrmFields, type CrmProvider, pushCallToCrm } from './crm.ts'
import {
  type AppAccount,
  type AppConnector,
  AppError,
  type AppOAuth,
  type FinishedCall,
  type Json,
  type OAuthClient,
  type OAuthTokens,
  type SessionUser,
  type TokenSource,
} from './types.ts'

/**
 * Shopify (docs/crm-sync.md, "Shopify"). OAuth 2 authorization code with the install's Shopify app (Server admin ›
 * Providers), per shop: the consent page and the token endpoint live on the shop's own myshopify.com domain, so the
 * member names the shop when connecting. Offline access tokens that expire (one hour, Shopify's rule for public apps
 * from 2026) with a rotating refresh token. Everything else is the Admin GraphQL API with a dated version in the path.
 *
 * The shop travels with every token: the token source only hands out strings, so this adapter stores
 * `<shop>|<token>` as the access and refresh token, and splits them again before talking to Shopify. Nothing outside
 * this file reads them.
 */
export const SHOPIFY_API_VERSION = '2026-10'
/**
 * The scopes the app asks for in the consent URL: customers to find the caller and add the call note; orders,
 * returns and products for the assistant's tools; the shop's policies for what it knows. Write scopes include read.
 */
export const SHOPIFY_SCOPES = [
  'read_customers',
  'write_customers',
  'read_orders',
  'write_orders',
  'read_returns',
  'write_returns',
  'read_products',
  'read_inventory',
  'read_legal_policies',
] as const

/** A shop's own admin domain: `brightwater.myshopify.com`. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/**
 * The shop's myshopify.com domain from what a member typed ("brightwater", "brightwater.myshopify.com",
 * "https://brightwater.myshopify.com/admin"); null when it is not one. A custom domain (shop.example.com) is not:
 * Shopify's OAuth runs only on the myshopify.com domain.
 */
export function shopDomain(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? ''
  if (!value.includes('.')) value = `${value}.myshopify.com`
  return SHOP_DOMAIN.test(value) ? value : null
}

const SEP = '|'
/** `<shop>|<token>`, what is stored. */
export const withShop = (shop: string, token: string) => `${shop}${SEP}${token}`
/** The shop and the bare token of a stored token. */
export function splitShop(stored: string): { shop: string; token: string } {
  const at = stored.indexOf(SEP)
  const shop = at > 0 ? stored.slice(0, at) : ''
  if (!SHOP_DOMAIN.test(shop))
    throw new AppError('shopify', 'auth', 'the stored access names no shop: connect it again')
  return { shop, token: stored.slice(at + 1) }
}

/** HMAC-SHA256 with Web Crypto (this package runs without Node's own modules). */
async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

/** Same length and same bytes, in time that does not depend on where they differ. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map(byte => Number.parseInt(byte, 16)))
function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), c => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Whether Shopify signed the callback's query (`hmac`: hex SHA-256 HMAC with the app's client secret over the other
 * parameters, sorted, as `key=value` joined by `&`). An unsigned or changed `shop` would let anyone send a member's
 * code to a shop of their choice.
 */
export async function verifyShopifyQuery(
  params: Readonly<Record<string, string>>,
  clientSecret: string,
): Promise<boolean> {
  const hmac = params.hmac
  if (!hmac || !/^[0-9a-f]{64}$/i.test(hmac)) return false
  const message = Object.keys(params)
    .filter(key => key !== 'hmac' && key !== 'signature')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
  return sameBytes(fromHex(hmac.toLowerCase()), await hmacSha256(clientSecret, message))
}

/** Shopify's webhook signature (`X-Shopify-Hmac-SHA256`): base64 SHA-256 HMAC of the raw body with the client secret. */
export async function verifyShopifyWebhook(
  rawBody: string,
  signature: string | null | undefined,
  clientSecret: string,
) {
  const given = signature ? fromBase64(signature) : null
  return !!given && sameBytes(given, await hmacSha256(clientSecret, rawBody))
}

const fromBase64Url = (value: string) =>
  /^[A-Za-z0-9_-]*$/.test(value) ? fromBase64(value.replace(/-/g, '+').replace(/_/g, '/')) : null

function jsonPart(part: string): Record<string, unknown> | null {
  const bytes = fromBase64Url(part)
  if (!bytes) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What a checked session token says: the shop whose admin the embedded page is open in, and the staff member. */
export type ShopifySessionClaims = { shop: string; user: string | null }

/** How far a session token's `exp` and `nbf` may be off the server's clock (Shopify's tokens last one minute). */
export const SESSION_TOKEN_LEEWAY_SEC = 10

/**
 * Checks a session token App Bridge gave the embedded page (a JWT, HS256 with the app's client secret): the signature
 * (compared in constant time), `aud` the app's client ID, `exp` and `nbf` within SESSION_TOKEN_LEEWAY_SEC of `nowMs`,
 * `dest` a shop's own https://<shop>.myshopify.com and `iss` that shop's /admin. Null for anything else: another
 * algorithm, a token of another app, an expired one, a shop that is not one.
 */
export async function verifyShopifySessionToken(
  token: string,
  { clientId, clientSecret }: OAuthClient,
  nowMs: number = Date.now(),
): Promise<ShopifySessionClaims | null> {
  if (!token || token.length > 4096) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = jsonPart(headerPart)
  if (header?.alg !== 'HS256') return null
  const signature = fromBase64Url(signaturePart)
  if (!signature || !sameBytes(signature, await hmacSha256(clientSecret, `${headerPart}.${payloadPart}`))) return null
  const claims = jsonPart(payloadPart)
  if (!claims || claims.aud !== clientId) return null
  const now = nowMs / 1000
  if (typeof claims.exp !== 'number' || claims.exp < now - SESSION_TOKEN_LEEWAY_SEC) return null
  if (typeof claims.nbf !== 'number' || claims.nbf > now + SESSION_TOKEN_LEEWAY_SEC) return null
  if (typeof claims.dest !== 'string' || typeof claims.iss !== 'string') return null
  const match = /^https:\/\/([^/?#]+)$/.exec(claims.dest)
  const shop = match ? shopDomain(match[1]!) : null
  if (!shop || claims.dest !== `https://${shop}` || claims.iss !== `https://${shop}/admin`) return null
  return { shop, user: typeof claims.sub === 'string' && claims.sub ? claims.sub : null }
}

type Options = { fetch?: typeof fetch; timeoutMs?: number }

async function readBody(res: Response): Promise<Json> {
  const text = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Json) : { message: text }
  } catch {
    return { message: text }
  }
}

const reasonOf = (json: Json): string | undefined => {
  const value = json.error_description ?? json.errors ?? json.error ?? json.message
  const text = typeof value === 'string' ? value : value ? JSON.stringify(value) : ''
  return text.trim() ? text.trim().replace(/\s+/g, ' ').slice(0, 300) : undefined
}

function retryAfterOf(res: Response): number | undefined {
  const sec = Number(res.headers.get('retry-after'))
  return Number.isFinite(sec) && sec >= 0 ? Math.max(1, Math.ceil(sec)) : undefined
}

type GraphQL = (token: TokenSource, query: string, variables: Json, what: string) => Promise<Json>

/**
 * One Admin GraphQL request to the token's shop. On HTTP 401 it refreshes the token once and tries again. Shopify
 * answers query errors with HTTP 200 and `errors`: THROTTLED is rate_limited, ACCESS_DENIED auth, anything else
 * invalid.
 */
function graphqlClient({ fetch: doFetch = fetch, timeoutMs = 10_000 }: Options): GraphQL {
  return async (token, query, variables, what) => {
    for (let attempt = 0; ; attempt++) {
      const { shop, token: accessToken } = splitShop(await token(attempt > 0))
      let res: Response
      try {
        res = await doFetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: {
            'x-shopify-access-token': accessToken,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new AppError('shopify', 'unavailable', `${what} could not reach Shopify`)
      }
      if (res.status === 401 && attempt === 0) continue
      const body = await readBody(res)
      const failed = (message: string) => `${what} failed${message ? `: ${message}` : ''}`
      if (res.status === 401 || res.status === 403)
        throw new AppError('shopify', 'auth', failed(reasonOf(body) ?? ''), res.status)
      // 402: the shop is frozen (unpaid), 423: locked; both pass.
      if (res.status === 429) throw new AppError('shopify', 'rate_limited', failed(''), res.status, retryAfterOf(res))
      if (res.status >= 500 || res.status === 402 || res.status === 423)
        throw new AppError('shopify', 'unavailable', failed(''), res.status)
      if (res.status === 404) throw new AppError('shopify', 'not_found', failed('no such shop'), res.status)
      if (!res.ok) throw new AppError('shopify', 'invalid', failed(reasonOf(body) ?? ''), res.status)
      const errors = Array.isArray(body.errors) ? (body.errors as Json[]) : []
      if (errors.length > 0) {
        const codes = errors.map(e => String((e.extensions as Json | undefined)?.code ?? ''))
        const message = errors
          .map(e => String(e.message ?? ''))
          .join('; ')
          .slice(0, 300)
        if (codes.includes('THROTTLED')) throw new AppError('shopify', 'rate_limited', failed('throttled'), 429, 2)
        if (codes.includes('ACCESS_DENIED') || /access denied/i.test(message))
          throw new AppError('shopify', 'auth', failed(message), 403)
        throw new AppError('shopify', 'invalid', failed(message))
      }
      return (body.data ?? {}) as Json
    }
  }
}

/** A mutation's user errors (`userErrors` or another list the mutation names) as one invalid AppError. */
function throwUserErrors(payload: Json | undefined, what: string, key = 'userErrors') {
  const errors = Array.isArray(payload?.[key]) ? (payload[key] as Json[]) : []
  if (errors.length === 0) return
  const message = errors
    .map(e => String(e.message ?? ''))
    .join('; ')
    .slice(0, 300)
  throw new AppError('shopify', 'invalid', `${what} failed: ${message}`)
}

/** Subscribes the shop's `app/uninstalled` to Linedesk's webhook; a subscription that exists already is fine. */
async function subscribeUninstall(graphql: GraphQL, accessToken: string, uri: string): Promise<boolean> {
  try {
    const data = await graphql(
      async () => accessToken,
      'mutation LinedeskUninstallHook($uri: URL!) { webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }',
      { uri },
      'subscribing to uninstalls',
    )
    const payload = data.webhookSubscriptionCreate as Json | undefined
    const errors = Array.isArray(payload?.userErrors) ? (payload.userErrors as Json[]) : []
    return errors.length === 0 || errors.every(e => /already/i.test(String(e.message ?? '')))
  } catch {
    return false
  }
}

const SHOP_QUERY = 'query LinedeskShop { shop { id name myshopifyDomain } }'

async function readAccount(graphql: GraphQL, accessToken: string): Promise<AppAccount> {
  const data = await graphql(async () => accessToken, SHOP_QUERY, {}, 'reading the shop')
  const shop = data.shop as Json | undefined
  const domain = typeof shop?.myshopifyDomain === 'string' ? shop.myshopifyDomain : null
  if (!domain) throw new AppError('shopify', 'invalid', 'reading the shop returned no shop')
  const name = typeof shop?.name === 'string' && shop.name.trim() ? shop.name.trim() : domain
  // The domain, not the gid: it is what the token names, and what the uninstall webhook sends.
  return { id: domain, name }
}

export function createShopifyOAuth({ clientId, clientSecret }: OAuthClient, options: Options = {}): AppOAuth {
  const { fetch: doFetch = fetch, timeoutMs = 8000 } = options
  const graphql = graphqlClient({ ...options, timeoutMs })

  async function tokens(shop: string, fields: Json, what: string): Promise<OAuthTokens> {
    const body = await tokenBody(shop, fields, what)
    const accessToken = body.access_token
    if (typeof accessToken !== 'string' || !accessToken)
      throw new AppError('shopify', 'invalid', `${what} returned no access token`)
    const expiresIn = Number(body.expires_in)
    return {
      accessToken: withShop(shop, accessToken),
      refreshToken: typeof body.refresh_token === 'string' ? withShop(shop, body.refresh_token) : null,
      expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: typeof body.scope === 'string' ? body.scope : null,
    }
  }

  /** The token endpoint's answer, or the AppError for its refusal. */
  async function tokenBody(shop: string, fields: Json, what: string): Promise<Json> {
    let res: Response
    try {
      res = await doFetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...fields, client_id: clientId, client_secret: clientSecret }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError('shopify', 'unavailable', `${what} could not reach Shopify`)
    }
    const body = await readBody(res)
    if (!res.ok) {
      const reason = reasonOf(body)
      const message = `${what} failed${reason ? `: ${reason}` : ''}`
      if (res.status === 429) throw new AppError('shopify', 'rate_limited', message, res.status, retryAfterOf(res))
      if (res.status >= 500) throw new AppError('shopify', 'unavailable', message, res.status)
      // invalid_client: the install's own app keys; anything else (invalid_grant, an uninstalled app) the grant.
      if (/invalid_client|client_id|client credentials/i.test(reason ?? ''))
        throw new AppError('shopify', 'client', message, res.status)
      throw new AppError('shopify', 'auth', message, res.status)
    }
    return body
  }

  return {
    id: 'shopify',
    scopes: SHOPIFY_SCOPES,
    authorizeUrl({ redirectUri, state, shop }) {
      // No grant_options[]=per-user: an offline token, for calls that come in when nobody is signed in.
      const query = new URLSearchParams({
        client_id: clientId,
        scope: SHOPIFY_SCOPES.join(','),
        redirect_uri: redirectUri,
        state,
      }).toString()
      if (shop === undefined) {
        // No store named: Shopify's store picker. The member signs in to Shopify and picks the store (one store is
        // picked for them); Shopify then opens the same consent page on that store's domain. The callback names the
        // store, signed by Shopify (exchangeCode).
        const picker = new URL('https://accounts.shopify.com/store-login')
        picker.searchParams.set('redirect', `/admin/oauth/authorize?${query}`)
        return picker.toString()
      }
      const domain = shopDomain(shop)
      if (!domain) throw new AppError('shopify', 'invalid', 'no shop to connect')
      return `https://${domain}/admin/oauth/authorize?${query}`
    },
    async exchangeCode({ code, redirectUri, params }) {
      // The shop comes from Shopify's signed callback, never from the member's browser alone.
      if (!params || !(await verifyShopifyQuery(params, clientSecret)))
        throw new AppError('shopify', 'invalid', 'the callback is not signed by Shopify')
      const shop = shopDomain(params.shop ?? '')
      if (!shop || params.shop !== shop) throw new AppError('shopify', 'invalid', 'the callback names no shop')
      const granted = await tokens(shop, { code, expiring: 1 }, 'connect')
      const account = await readAccount(graphql, granted.accessToken).catch(() => null)
      // The legacy install flow (authorization code grant) allows no app-wide uninstall webhook: each shop gets its own
      // subscription, to the same origin the callback came back to. Best effort: without it a refresh refused later
      // still marks the connection.
      await subscribeUninstall(
        graphql,
        granted.accessToken,
        new URL('/v1/apps/webhook/shopify', redirectUri).toString(),
      )
      return { ...granted, account }
    },
    async refresh(stored) {
      const { shop, token } = splitShop(stored)
      return tokens(shop, { grant_type: 'refresh_token', refresh_token: token }, 'refresh access')
    },
    /** Uninstalls the app from the shop (its access ends with it): Shopify has no revoke of one grant. */
    async revoke(stored) {
      try {
        const { shop, token } = splitShop(stored)
        const { accessToken } = await tokens(shop, { grant_type: 'refresh_token', refresh_token: token }, 'disconnect')
        const res = await doFetch(`https://${shop}/admin/api_permissions/current.json`, {
          method: 'DELETE',
          headers: { 'x-shopify-access-token': splitShop(accessToken).token },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok
      } catch {
        return false
      }
    },
    // One install per shop: uninstalling ends it for every workspace connected to the shop.
    grantPerAccount: true,
    account: accessToken => readAccount(graphql, accessToken),
    /**
     * The App Store install (Shopify-managed): the embedded page's session token, checked by the caller, is exchanged
     * for the shop's offline access, expiring like a connect's (`expiring: 1`). The shop's uninstall webhook comes from
     * the app's configuration, so nothing is subscribed here.
     */
    async tokenExchange({ shop, sessionToken }) {
      if (shopDomain(shop) !== shop) throw new AppError('shopify', 'invalid', 'no shop for the token exchange')
      const granted = await tokens(
        shop,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: sessionToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
          expiring: 1,
        },
        'token exchange',
      )
      const account = await readAccount(graphql, granted.accessToken).catch(() => null)
      return { ...granted, account }
    },
    /**
     * An online token exchange for the same session token, only to read who it is for (`associated_user`): the token
     * itself is never returned or kept.
     */
    async sessionUser({ shop, sessionToken }): Promise<SessionUser> {
      if (shopDomain(shop) !== shop) throw new AppError('shopify', 'invalid', 'no shop for the token exchange')
      const body = await tokenBody(
        shop,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: sessionToken,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          requested_token_type: 'urn:shopify:params:oauth:token-type:online-access-token',
        },
        'reading the staff member',
      )
      const user = (body.associated_user ?? null) as Json | null
      if (!user || typeof user !== 'object') throw new AppError('shopify', 'invalid', 'the token names no staff member')
      return {
        email: typeof user.email === 'string' && user.email ? user.email : null,
        emailVerified: user.email_verified === true,
        accountOwner: user.account_owner === true,
      }
    },
  }
}

// --- What the assistant reads -----------------------------------------------------------------

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const nodesOf = (value: unknown): Json[] => {
  const nodes = (value as Json | null | undefined)?.nodes
  return Array.isArray(nodes) ? (nodes as Json[]) : []
}
/** A search value inside Shopify's query syntax: quoted, with quotes and backslashes escaped. */
export const quoteTerm = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export type ShopifyAddress = {
  name: string | null
  address1: string | null
  address2: string | null
  city: string | null
  province: string | null
  zip: string | null
  country: string | null
  phone: string | null
}

export type ShopifyCustomer = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  ordersCount: number
  address: ShopifyAddress | null
}

export type ShopifyOrder = {
  id: string
  /** The order number as the shop shows it: "#1001". */
  name: string
  createdAt: string
  cancelledAt: string | null
  financialStatus: string | null
  fulfillmentStatus: string | null
  total: string | null
  customer: { id: string; name: string | null; email: string | null; phone: string | null } | null
  email: string | null
  phone: string | null
  shippingAddress: ShopifyAddress | null
  items: { title: string; quantity: number }[]
  shipments: {
    status: string | null
    carrier: string | null
    tracking: string | null
    trackingUrl: string | null
    estimatedDelivery: string | null
    deliveredAt: string | null
  }[]
}

export type ShopifyProduct = {
  title: string
  variants: { title: string; price: string | null; available: boolean; inStock: number | null; sku: string | null }[]
}

export type ShopifyPolicy = { type: string; title: string; body: string }

const ADDRESS_FIELDS = 'name address1 address2 city province zip country phone'
const CUSTOMER_FIELDS = `id displayName email phone numberOfOrders defaultAddress { ${ADDRESS_FIELDS} }`
const ORDER_FIELDS = `id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus email phone
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { id displayName email phone }
  shippingAddress { ${ADDRESS_FIELDS} }
  lineItems(first: 20) { nodes { title quantity variantTitle } }
  fulfillments(first: 10) { displayStatus estimatedDeliveryAt deliveredAt trackingInfo(first: 1) { company number url } }`

function toAddress(row: Json | null | undefined): ShopifyAddress | null {
  if (!row) return null
  return {
    name: text(row.name),
    address1: text(row.address1),
    address2: text(row.address2),
    city: text(row.city),
    province: text(row.province),
    zip: text(row.zip),
    country: text(row.country),
    phone: text(row.phone),
  }
}

function toCustomer(row: Json): ShopifyCustomer {
  return {
    id: String(row.id),
    name: text(row.displayName),
    email: text(row.email),
    phone: text(row.phone),
    ordersCount: Number(row.numberOfOrders) || 0,
    address: toAddress(row.defaultAddress as Json | null),
  }
}

function toOrder(row: Json): ShopifyOrder {
  const money = (row.totalPriceSet as Json | undefined)?.shopMoney as Json | undefined
  const customer = row.customer as Json | null | undefined
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    createdAt: String(row.createdAt ?? ''),
    cancelledAt: text(row.cancelledAt),
    financialStatus: text(row.displayFinancialStatus),
    fulfillmentStatus: text(row.displayFulfillmentStatus),
    total: money?.amount ? `${money.amount} ${money.currencyCode ?? ''}`.trim() : null,
    customer: customer?.id
      ? {
          id: String(customer.id),
          name: text(customer.displayName),
          email: text(customer.email),
          phone: text(customer.phone),
        }
      : null,
    email: text(row.email),
    phone: text(row.phone),
    shippingAddress: toAddress(row.shippingAddress as Json | null),
    items: nodesOf(row.lineItems).map(item => ({
      title: [text(item.title), text(item.variantTitle)].filter(Boolean).join(' – '),
      quantity: Number(item.quantity) || 0,
    })),
    shipments: (Array.isArray(row.fulfillments) ? (row.fulfillments as Json[]) : []).map(f => {
      const tracking = (Array.isArray(f.trackingInfo) ? (f.trackingInfo as Json[]) : [])[0]
      return {
        status: text(f.displayStatus),
        carrier: text(tracking?.company),
        tracking: text(tracking?.number),
        trackingUrl: text(tracking?.url),
        estimatedDelivery: text(f.estimatedDeliveryAt),
        deliveredAt: text(f.deliveredAt),
      }
    }),
  }
}

/** Shopify's policies are HTML: plain text for the assistant. */
export function plainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

export type ShopifyReturnLine = { fulfillmentLineItemId: string; title: string; quantity: number }

export type ShopifyStore = {
  findCustomers(token: TokenSource, query: string, first?: number): Promise<ShopifyCustomer[]>
  findOrders(token: TokenSource, query: string, first?: number): Promise<ShopifyOrder[]>
  findProducts(token: TokenSource, query: string, first?: number): Promise<ShopifyProduct[]>
  policies(token: TokenSource): Promise<ShopifyPolicy[]>
  returnableLines(token: TokenSource, orderId: string): Promise<ShopifyReturnLine[]>
  requestReturn(
    token: TokenSource,
    orderId: string,
    lines: { fulfillmentLineItemId: string; quantity: number }[],
    note: string,
  ): Promise<string>
  updateShippingAddress(
    token: TokenSource,
    orderId: string,
    change: { address1?: string; address2?: string; city?: string; zip?: string },
  ): Promise<void>
  cancelOrder(token: TokenSource, orderId: string, staffNote: string): Promise<void>
}

export function createShopifyStore(options: Options = {}): ShopifyStore {
  const graphql = graphqlClient(options)
  return {
    async findCustomers(token, query, first = 5) {
      const data = await graphql(
        token,
        `query LinedeskCustomers($q: String!, $first: Int!) { customers(first: $first, query: $q) { nodes { ${CUSTOMER_FIELDS} } } }`,
        { q: query, first },
        'finding the customer',
      )
      return nodesOf(data.customers).map(toCustomer)
    },
    async findOrders(token, query, first = 5) {
      const data = await graphql(
        token,
        `query LinedeskOrders($q: String, $first: Int!) { orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`,
        { q: query || null, first },
        'finding orders',
      )
      return nodesOf(data.orders).map(toOrder)
    },
    async findProducts(token, query, first = 5) {
      const data = await graphql(
        token,
        `query LinedeskProducts($q: String!, $first: Int!) { products(first: $first, query: $q) { nodes { title variants(first: 20) { nodes { title price availableForSale inventoryQuantity sku } } } } }`,
        // Only what the shop sells: no drafts or archived products.
        { q: `${quoteTerm(query)} AND status:active`, first },
        'finding products',
      )
      return nodesOf(data.products).map(row => ({
        title: String(row.title ?? ''),
        variants: nodesOf(row.variants).map(v => ({
          title: String(v.title ?? ''),
          price: text(v.price),
          available: v.availableForSale === true,
          inStock: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null,
          sku: text(v.sku),
        })),
      }))
    },
    async policies(token) {
      const data = await graphql(
        token,
        'query LinedeskPolicies { shop { shopPolicies { type title body } } }',
        {},
        'reading the policies',
      )
      const rows = Array.isArray((data.shop as Json | undefined)?.shopPolicies)
        ? ((data.shop as Json).shopPolicies as Json[])
        : []
      return rows
        .map(row => ({
          type: String(row.type ?? ''),
          title: String(row.title ?? ''),
          body: plainText(String(row.body ?? '')),
        }))
        .filter(policy => policy.body)
    },
    async returnableLines(token, orderId) {
      const data = await graphql(
        token,
        `query LinedeskReturnable($id: ID!) { returnableFulfillments(orderId: $id, first: 10) { nodes { returnableFulfillmentLineItems(first: 50) { nodes { quantity fulfillmentLineItem { id lineItem { title variantTitle } } } } } } }`,
        { id: orderId },
        'reading what can be returned',
      )
      return nodesOf(data.returnableFulfillments).flatMap(f =>
        nodesOf(f.returnableFulfillmentLineItems).map(item => {
          const line = item.fulfillmentLineItem as Json
          const lineItem = line?.lineItem as Json | undefined
          return {
            fulfillmentLineItemId: String(line?.id ?? ''),
            title: [text(lineItem?.title), text(lineItem?.variantTitle)].filter(Boolean).join(' – '),
            quantity: Number(item.quantity) || 0,
          }
        }),
      )
    },
    async requestReturn(token, orderId, lines, note) {
      const data = await graphql(
        token,
        'mutation LinedeskReturn($input: ReturnRequestInput!) { returnRequest(input: $input) { return { id name } userErrors { message } } }',
        {
          input: {
            orderId,
            returnLineItems: lines.map(line => ({
              fulfillmentLineItemId: line.fulfillmentLineItemId,
              quantity: line.quantity,
              returnReason: 'OTHER',
              customerNote: note.slice(0, 300),
            })),
          },
        },
        'requesting the return',
      )
      const payload = data.returnRequest as Json | undefined
      throwUserErrors(payload, 'requesting the return')
      const ret = payload?.return as Json | undefined
      if (!ret?.id) throw new AppError('shopify', 'invalid', 'requesting the return returned no return')
      return String(ret.name ?? ret.id)
    },
    async updateShippingAddress(token, orderId, change) {
      // Shopify replaces the whole address: the fields not changed are sent as they are.
      const read = await graphql(
        token,
        'query LinedeskShipTo($id: ID!) { order(id: $id) { shippingAddress { firstName lastName company address1 address2 city provinceCode zip countryCodeV2 phone } } }',
        { id: orderId },
        'reading the shipping address',
      )
      const current = ((read.order as Json | null | undefined)?.shippingAddress ?? {}) as Json
      const input: Json = {
        firstName: text(current.firstName),
        lastName: text(current.lastName),
        company: text(current.company),
        address1: change.address1 ?? text(current.address1),
        address2: change.address1 ? (change.address2 ?? null) : text(current.address2),
        city: change.city ?? text(current.city),
        provinceCode: text(current.provinceCode),
        zip: change.zip ?? text(current.zip),
        countryCode: text(current.countryCodeV2),
        phone: text(current.phone),
      }
      const data = await graphql(
        token,
        // The order gets a tag the shop sees in its order list: Shopify sends the customer no email for a new address.
        'mutation LinedeskAddress($input: OrderInput!, $id: ID!, $tags: [String!]!) { orderUpdate(input: $input) { order { id } userErrors { message } } tagsAdd(id: $id, tags: $tags) { userErrors { message } } }',
        {
          input: { id: orderId, shippingAddress: Object.fromEntries(Object.entries(input).filter(([, v]) => v)) },
          id: orderId,
          tags: [ADDRESS_CHANGED_TAG],
        },
        'changing the shipping address',
      )
      throwUserErrors(data.orderUpdate as Json | undefined, 'changing the shipping address')
    },
    async cancelOrder(token, orderId, staffNote) {
      const data = await graphql(
        token,
        `mutation LinedeskCancel($id: ID!, $note: String) {
          orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: true, staffNote: $note, refundMethod: { originalPaymentMethodsRefund: true }) {
            job { id } orderCancelUserErrors { message }
          }
        }`,
        { id: orderId, note: staffNote.slice(0, 255) },
        'cancelling the order',
      )
      throwUserErrors(data.orderCancel as Json | undefined, 'cancelling the order', 'orderCancelUserErrors')
    },
  }
}

// --- After the call: the customer and the note -------------------------------------------------

/** The tag an order gets when the assistant changed its shipping address, so the shop can check it. */
export const ADDRESS_CHANGED_TAG = 'Linedesk: address changed by phone'

/** The tag every customer a call was logged on gets, so the shop can filter them. */
export const SHOPIFY_TAG = 'Linedesk'
/** Shopify keeps one note per customer; the newest calls stay, the oldest are cut once it is this long. */
const NOTE_MAX = 4500

function toContact(row: Json): CrmContact {
  return {
    id: String(row.id),
    firstName: text(row.firstName),
    lastName: text(row.lastName),
    email: text(row.email),
    phone: text(row.phone),
    company: text((row.defaultAddress as Json | null)?.company),
  }
}

/** The call as a plain-text entry for the customer's note: the date, the title, the summary, next steps, the link. */
export function callNoteEntry(call: FinishedCall): string {
  const parts = [
    `${call.labels.when}: ${call.urgent ? `${call.title.trim()} (${call.labels.urgent})` : call.title.trim()}`,
  ]
  if (call.summary.trim()) parts.push(call.summary.trim())
  const steps = call.nextSteps.map(s => s.trim()).filter(Boolean)
  if (steps.length > 0) parts.push([`${call.labels.nextSteps}:`, ...steps.map(s => `- ${s}`)].join('\n'))
  parts.push(`${call.labels.openCall}: ${call.callUrl}`)
  return parts.join('\n')
}

/** The new entry on top of the old note, cut at the end so it stays within NOTE_MAX. */
export function prependNote(entry: string, existing: string | null): string {
  const note = existing?.trim() ? `${entry}\n\n---\n\n${existing.trim()}` : entry
  return note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1)}…`
}

const CONTACT_FIELDS = 'id firstName lastName email phone note defaultAddress { company }'

export function createShopifyCrm(options: Options = {}): CrmProvider {
  const graphql = graphqlClient(options)
  async function find(token: TokenSource, query: string, what: string) {
    const data = await graphql(
      token,
      `query LinedeskFindCustomer($q: String!) { customers(first: 1, query: $q) { nodes { ${CONTACT_FIELDS} } } }`,
      { q: query },
      what,
    )
    const row = nodesOf(data.customers)[0]
    return row ? toContact(row) : null
  }
  return {
    app: 'shopify',
    async getContact(token, id) {
      const data = await graphql(
        token,
        `query LinedeskCustomer($id: ID!) { customer(id: $id) { ${CONTACT_FIELDS} } }`,
        { id },
        'reading the customer',
      )
      const row = data.customer as Json | null | undefined
      return row?.id ? toContact(row) : null
    },
    findContactByPhone: (token, e164) => find(token, `phone:${quoteTerm(e164)}`, 'finding the customer by phone'),
    findContactByEmail: (token, email) => find(token, `email:${quoteTerm(email)}`, 'finding the customer by email'),
    async createContact(token, fields) {
      const input: Json = {}
      if (fields.firstName) input.firstName = fields.firstName
      if (fields.lastName) input.lastName = fields.lastName
      if (fields.email) input.email = fields.email
      if (fields.phone) input.phone = fields.phone
      input.tags = [SHOPIFY_TAG]
      const data = await graphql(
        token,
        `mutation LinedeskCreateCustomer($input: CustomerInput!) { customerCreate(input: $input) { customer { ${CONTACT_FIELDS} } userErrors { message } } }`,
        { input },
        'creating the customer',
      )
      const payload = data.customerCreate as Json | undefined
      throwUserErrors(payload, 'creating the customer')
      if (!(payload?.customer as Json | undefined)?.id)
        throw new AppError('shopify', 'invalid', 'creating the customer returned no customer')
      return toContact(payload!.customer as Json)
    },
    async fillContact(token, id, fields: Partial<CrmFields>) {
      const input: Json = { id }
      if (fields.firstName) input.firstName = fields.firstName
      if (fields.lastName) input.lastName = fields.lastName
      if (fields.email) input.email = fields.email
      if (fields.phone) input.phone = fields.phone
      if (Object.keys(input).length === 1) return
      const data = await graphql(
        token,
        'mutation LinedeskFillCustomer($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { message } } }',
        { input },
        'updating the customer',
      )
      throwUserErrors(data.customerUpdate as Json | undefined, 'updating the customer')
    },
    async logCall(token, contactId, call) {
      const read = await graphql(
        token,
        'query LinedeskNote($id: ID!) { customer(id: $id) { id note } }',
        { id: contactId },
        'reading the customer note',
      )
      const existing = text((read.customer as Json | null | undefined)?.note)
      // A retry after a failure further on finds its own entry already there: not written twice.
      if (existing?.includes(call.callUrl)) return `${contactId}#${call.callId}`
      const data = await graphql(
        token,
        'mutation LinedeskLogCall($input: CustomerInput!, $id: ID!, $tags: [String!]!) { customerUpdate(input: $input) { customer { id } userErrors { message } } tagsAdd(id: $id, tags: $tags) { userErrors { message } } }',
        {
          input: { id: contactId, note: prependNote(callNoteEntry(call), existing) },
          id: contactId,
          tags: [SHOPIFY_TAG],
        },
        'adding the call note',
      )
      throwUserErrors(data.customerUpdate as Json | undefined, 'adding the call note')
      throwUserErrors(data.tagsAdd as Json | undefined, 'tagging the customer')
      return `${contactId}#${call.callId}`
    },
  }
}

export function createShopifyConnector(options: Options = {}): AppConnector {
  const crm = createShopifyCrm(options)
  return {
    id: 'shopify',
    crm: true,
    pushCall: (token, call, progress, pushOptions) => pushCallToCrm(crm, token, call, progress, pushOptions),
  }
}

/** Two numbers compared on their national digits (the order's phone may be written any way); `country` reads a local one. */
export function samePhone(a: string | null | undefined, b: string | null | undefined, country?: string): boolean {
  if (!a || !b) return false
  const region = (country ?? parsePhoneNumberFromString(a)?.country ?? 'US') as CountryCode
  const national = (v: string) => {
    const parsed = parsePhoneNumberFromString(v, region)
    return parsed?.nationalNumber ? String(parsed.nationalNumber) : v.replace(/\D/g, '')
  }
  const pa = parsePhoneNumberFromString(a)
  const pb = parsePhoneNumberFromString(b)
  // Both written internationally: the whole number, so +1 207… never matches +44 20 7….
  if (a.trim().startsWith('+') && b.trim().startsWith('+') && pa && pb) return pa.number === pb.number
  const x = national(a)
  return x.length >= 7 && x === national(b)
}
