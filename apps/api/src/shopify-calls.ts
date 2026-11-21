// The assistant and the business's Shopify store during a call (LIN-666, docs/crm-sync.md "Shopify"): the caller's
// customer and last orders at call start, order and product search, and the changes the business allows (a return,
// a new shipping address, a cancellation). Reading needs no check (Tim, 2026-11-20: be as helpful as possible); a
// change runs only after the caller gave what the business picked (Integrations › Shopify, "Before a change") and it
// matched the order. The comparison is here, never left to the model. Shopify's HTTP is in @linedesk/connectors.
import {
  appSettingOn,
  type ShopChange,
  type ShopCustomerView,
  type ShopifyCallContextData,
  type ShopifyCallSetup,
  type ShopifyChangeOrderData,
  type ShopifyFindOrdersData,
  type ShopifyFindProductsData,
  type ShopOrderView,
  type ShopVerify,
  SHOP_VERIFY_SETTINGS,
} from '@linedesk/actions'
import {
  AppError,
  createShopifyStore,
  quoteTerm,
  samePhone,
  type ShopifyAddress,
  type ShopifyOrder,
  type ShopifyPolicy,
  type ShopifyStore,
  type TokenSource,
} from '@linedesk/connectors'
import { type AppConnection, app_connections, calls, type Tx } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { appServicesOf, appTokenSource, errorMessage } from './app-connections.ts'
import { recognizedCaller } from './bookings.ts'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Reject } from './handler-context.ts'

type CallRow = typeof calls.$inferSelect

/** How many orders a search or the call start gives the assistant. */
const ORDERS_SHOWN = 5
/** A policy longer than this is cut: the assistant's instructions stay short. */
const POLICY_MAX = 1500
/** Wrong answers to the checks one call may give before no change is possible on it any more. */
const MISMATCHES_PER_CALL = 3
const POLICY_TTL_MS = 10 * 60_000

export const SHOP_CHANGE_SWITCH: Record<ShopChange, 'shop_returns' | 'shop_address' | 'shop_cancel'> = {
  return: 'shop_returns',
  address: 'shop_address',
  cancel: 'shop_cancel',
}

const storeOf = (ctx: Pick<HandlerCtx, 'apps'>): ShopifyStore => appServicesOf(ctx).shopify?.() ?? createShopifyStore()

async function loadCall(tx: Tx, actor: Actor, callId: string): Promise<CallRow> {
  if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, actor.workspaceId)))
  if (!call) throw Reject.t('server.api.callNotFound')
  return call
}

async function shopConnection(tx: Tx, workspaceId: string): Promise<AppConnection | null> {
  const [connection] = await tx
    .select()
    .from(app_connections)
    .where(and(eq(app_connections.workspace_id, workspaceId), eq(app_connections.provider, 'shopify')))
  return connection ?? null
}

/** What call.start tells the agent: the changes the business allows and the checks they need; null: no store. */
export async function shopifyCallSetup(tx: Tx, workspaceId: string): Promise<ShopifyCallSetup | null> {
  const connection = await shopConnection(tx, workspaceId)
  if (!connection) return null
  const changes = (Object.keys(SHOP_CHANGE_SWITCH) as ShopChange[]).filter(change =>
    appSettingOn(connection.settings, SHOP_CHANGE_SWITCH[change], 'shopify'),
  )
  const proof = SHOP_VERIFY_SETTINGS.filter(id => appSettingOn(connection.settings, id, 'shopify'))
  return { changes, proof }
}

// --- How the assistant sees it -----------------------------------------------------------------

const words = (value: string) => value.toLowerCase().replaceAll('_', ' ')
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null)

/**
 * Where an order goes, as the assistant may say it before any check: the city and country only. Never the name, the
 * street or the postcode: those are what the checks before a change compare (security review of #1531), and an
 * unchecked caller must not hear a stranger's address.
 */
function addressLine(address: ShopifyAddress | null): string | null {
  if (!address) return null
  const parts = [address.city, address.province, address.country].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export function orderView(order: ShopifyOrder): ShopOrderView {
  const status = order.cancelledAt
    ? // i18n-ignore: text the voice assistant reads (rule 11), not shown in the app
      `cancelled on ${day(order.cancelledAt)}`
    : order.fulfillmentStatus
      ? words(order.fulfillmentStatus)
      : 'unknown'
  return {
    number: order.name,
    placedOn: day(order.createdAt) ?? '',
    status,
    payment: order.financialStatus ? words(order.financialStatus) : null,
    total: order.total,
    items: order.items.map(item => `${item.quantity} × ${item.title}`),
    shipTo: addressLine(order.shippingAddress),
    shipments: order.shipments.map(s =>
      [
        s.status ? words(s.status) : 'shipment',
        s.carrier ? `with ${s.carrier}` : null,
        s.tracking ? `tracking number ${s.tracking}` : null,
        s.deliveredAt
          ? `delivered ${day(s.deliveredAt)}`
          : s.estimatedDelivery
            ? `expected ${day(s.estimatedDelivery)}`
            : null,
      ]
        .filter(Boolean)
        .join(', '),
    ),
    // Not the name: it is a check before a change (see addressLine).
    customer: null,
  }
}

// --- Searching -------------------------------------------------------------------------------

/** "#1001", "1001", "order 1001" → "1001"; null when there are no digits. */
export const orderDigits = (value: string) => value.replace(/\D/g, '') || null

/** Postcodes compared without spaces and case; US ZIP+4 on its first five digits. */
export function samePostcode(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string) => v.replace(/[\s-]/g, '').toUpperCase()
  if (!a || !b) return false
  const x = norm(a)
  const y = norm(b)
  if (/^\d{5}(\d{4})?$/.test(x) && /^\d{5}(\d{4})?$/.test(y)) return x.slice(0, 5) === y.slice(0, 5)
  return x === y
}

const plain = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)

/**
 * Whether the name the caller gave is the one on the order: their family name must be the family name of the shipping
 * name or of the customer. Speech recognition spells first names loosely, so only the family name is
 * compared, and a first name alone never passes.
 */
export function sameName(given: string | null | undefined, order: ShopifyOrder): boolean {
  const said = plain(given ?? '')
  if (said.length < 2) return false
  const familyNames = [order.shippingAddress?.name, order.customer?.name]
    .map(name => plain(name ?? '').at(-1))
    .filter((name): name is string => !!name)
  return familyNames.includes(said.at(-1)!)
}

const gidNumber = (gid: string) => gid.split('/').at(-1) ?? gid

const STATUS_QUERY: Record<string, string> = {
  open: 'status:open',
  // A cancelled order counts as unshipped at Shopify; the caller means one still on its way.
  unshipped: 'fulfillment_status:unshipped AND -status:cancelled',
  shipped: 'fulfillment_status:shipped',
  cancelled: 'status:cancelled',
}

type OrderSearch = {
  orderNumber?: string
  email?: string
  name?: string
  postcode?: string
  phone?: string
  status?: string
}

/**
 * A phone number as the caller said it, in the form the store keeps (E.164): "(503) 555-0118" and "503-555-0118" find
 * nothing at Shopify, "+15035550118" does. Ten digits are a North American number while the caller's own number is
 * one too (or unknown); anything else is passed on as said.
 */
export function phoneForSearch(spoken: string, callerNumber?: string | null): string | null {
  const said = spoken.trim()
  const digits = said.replace(/\D/g, '')
  if (!digits) return null
  if (said.startsWith('+')) return `+${digits}`
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  const northAmerican = !callerNumber || callerNumber.startsWith('+1')
  if (northAmerican && digits.length === 10) return `+1${digits}`
  if (northAmerican && digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits
}

/**
 * The searches for a name, most exact first: every word (each quoted: as one phrase "Pat Guest" finds nothing at
 * Shopify), then the family name alone ("Michael Brennan" for Mike Brennan's orders), then its first four letters
 * ("Brenan" as speech recognition heard Brennan). Reads need no check, so a near match is fine: the assistant asks
 * which order the caller means.
 */
export function nameQueries(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const queries = [words.map(quoteTerm).join(' AND ')]
  const family = words.at(-1)!
  if (words.length > 1) queries.push(quoteTerm(family))
  const stem = plain(family)
    .join('')
    .replace(/[^a-z]/g, '')
  if (stem.length >= 5) queries.push(`${stem.slice(0, 4)}*`)
  return [...new Set(queries)]
}

/** At most this many searches at the store for one lookup. */
const SEARCHES_PER_LOOKUP = 6

/**
 * The orders matching what the caller said, newest first. Everything they said together first; when that finds
 * nothing, each detail alone (order number, email, phone, name, in that order), so one detail the speech recognition
 * got wrong does not hide the order. A postcode narrows the others down; alone it finds none.
 */
export async function searchOrders(
  store: ShopifyStore,
  token: TokenSource,
  search: OrderSearch,
  callerNumber?: string | null,
): Promise<ShopifyOrder[] | null> {
  // Each detail the caller gave, with its searches, most exact first.
  const details: string[][] = []
  const digits = search.orderNumber ? orderDigits(search.orderNumber) : null
  if (digits) details.push([`(name:${quoteTerm(`#${digits}`)} OR name:${quoteTerm(digits)})`])
  if (search.email?.trim()) details.push([`email:${quoteTerm(search.email.trim())}`])
  const phone = search.phone ? phoneForSearch(search.phone, callerNumber) : null
  let phoneKnown = false
  if (phone) {
    // An order keeps the customer's number on the customer: find them by it, then their orders.
    const customers = await store.findCustomers(token, `phone:${quoteTerm(phone)}`, 3)
    if (customers.length) {
      phoneKnown = true
      details.push([`(${customers.map(c => `customer_id:${gidNumber(c.id)}`).join(' OR ')})`])
    }
  }
  if (search.name?.trim()) details.push(nameQueries(search.name.trim()))
  if (details.length === 0) return phone && !phoneKnown ? [] : null
  const status = search.status && search.status !== 'any' ? STATUS_QUERY[search.status] : undefined
  const first = search.postcode ? 20 : ORDERS_SHOWN
  const tried = new Set<string>()
  const run = async (terms: string[]) => {
    const query = [...terms, status].filter(Boolean).join(' AND ')
    if (tried.has(query) || tried.size >= SEARCHES_PER_LOOKUP) return []
    tried.add(query)
    const found = await store.findOrders(token, query, first)
    return search.postcode ? found.filter(o => samePostcode(o.shippingAddress?.zip, search.postcode)) : found
  }
  const together = await run(details.map(d => d[0]!))
  if (together.length) return together.slice(0, ORDERS_SHOWN)
  for (const searches of details)
    for (const query of searches) {
      const found = await run([query])
      if (found.length) return found.slice(0, ORDERS_SHOWN)
    }
  return []
}

// --- Policies, kept for a while per store -----------------------------------------------------

const policyCache = new Map<string, { at: number; policies: ShopifyPolicy[] }>()

async function policiesOf(store: ShopifyStore, token: TokenSource, connection: AppConnection) {
  const cached = policyCache.get(connection.id)
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policies
  const policies = await store.policies(token)
  policyCache.set(connection.id, { at: Date.now(), policies })
  return policies
}

// --- Checks before a change -------------------------------------------------------------------

/** Calls that made their change: one change per call (this API process), so one call cannot work through orders. */
const changesDone = new Set<string>()

/** Wrong answers per call (this API process); a few, then no change on that call. */
const mismatches = new Map<string, { count: number; at: number }>()
const MISMATCH_TTL_MS = 2 * 60 * 60_000

function mismatchCount(callId: string) {
  const entry = mismatches.get(callId)
  if (!entry || Date.now() - entry.at > MISMATCH_TTL_MS) return 0
  return entry.count
}

function countMismatch(callId: string) {
  for (const [id, entry] of mismatches) if (Date.now() - entry.at > MISMATCH_TTL_MS) mismatches.delete(id)
  mismatches.set(callId, { count: mismatchCount(callId) + 1, at: Date.now() })
}

type Proof = { name?: string; postcode?: string; email?: string; orderNumber?: string }

/** Which checks the caller has not given yet, and whether one they gave does not match the order. */
export function checkProof(
  required: readonly ShopVerify[],
  proof: Proof,
  order: ShopifyOrder,
  caller: { number: string; attested: boolean },
): { missing: ShopVerify[]; mismatch: boolean } {
  const missing: ShopVerify[] = []
  let mismatch = false
  const check = (id: ShopVerify, given: string | undefined, matches: (v: string) => boolean) => {
    if (!required.includes(id)) return
    if (!given?.trim()) missing.push(id)
    else if (!matches(given)) mismatch = true
  }
  check('verify_name', proof.name, v => sameName(v, order))
  check('verify_postcode', proof.postcode, v => samePostcode(v, order.shippingAddress?.zip))
  check('verify_email', proof.email, v => {
    const want = v.trim().toLowerCase()
    return [order.email, order.customer?.email].some(e => e?.toLowerCase() === want)
  })
  check('verify_order_number', proof.orderNumber, v => orderDigits(v) === orderDigits(order.name))
  // Nothing to ask: the number the caller calls from, and only when the carrier vouched for it (else spoofable).
  if (required.includes('verify_caller_number')) {
    const phones = [order.phone, order.customer?.phone, order.shippingAddress?.phone]
    if (!caller.attested || !phones.some(p => samePhone(caller.number, p))) mismatch = true
  }
  return { missing, mismatch }
}

// --- Handlers ---------------------------------------------------------------------------------

async function withStore<T>(
  ctx: HandlerCtx,
  input: { callId: string },
  run: (args: { call: CallRow; connection: AppConnection; token: TokenSource; store: ShopifyStore }) => Promise<T>,
): Promise<T | 'no_store'> {
  const call = await loadCall(ctx.tx, ctx.actor, input.callId)
  const connection = await shopConnection(ctx.tx, call.workspace_id)
  if (!connection) return 'no_store'
  const token = appTokenSource(ctx.tx, appServicesOf(ctx), connection)
  return run({ call, connection, token, store: storeOf(ctx) })
}

/**
 * What to search for a product the caller named, in turn until one finds something: what they said, then with the
 * last words left out ("Complete Snowboard Powder" finds nothing: the color is a variant, not in the title). At most
 * three searches, never a single word shorter than three letters.
 */
export function productQueries(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const queries: string[] = []
  for (let n = words.length; n >= 1 && queries.length < 3; n--) {
    const candidate = words.slice(0, n).join(' ')
    if (n === 1 && candidate.length < 3) break
    queries.push(candidate)
  }
  return queries.length ? queries : [query.trim()]
}

const failed = (what: string, e: unknown) => console.warn(`shopify ${what}: ${errorMessage(e)}`)

export const shopifyCallHandlers: Record<string, Handler> = {
  'shopify.callContext': async (ctx, input: { callId: string }) => {
    const result = await withStore(ctx, input, async ({ call, connection, token, store }) => {
      const [customerFound, policies] = await Promise.all([
        call.from_number && /^\+\d{7,15}$/.test(call.from_number) && (await recognizedCaller(ctx.tx, call))
          ? store
              .findCustomers(token, `phone:${quoteTerm(call.from_number)}`, 1)
              .catch(e => (failed('customer', e), []))
          : Promise.resolve([]),
        policiesOf(store, token, connection).catch(e => (failed('policies', e), [] as ShopifyPolicy[])),
      ])
      const found = customerFound[0] ?? null
      const orders = found
        ? await store.findOrders(token, `customer_id:${gidNumber(found.id)}`, 3).catch(e => (failed('orders', e), []))
        : []
      // The first name only (a greeting), never the email or the family name: those are checks before a change.
      const customer: ShopCustomerView | null = found
        ? { name: found.name?.split(/\s+/)[0] ?? null, email: null, orders: found.ordersCount }
        : null
      const data: ShopifyCallContextData = {
        connected: true,
        customer,
        orders: orders.map(orderView),
        policies: policies.map(p => ({
          title: p.title,
          text: p.body.length > POLICY_MAX ? `${p.body.slice(0, POLICY_MAX)}…` : p.body,
        })),
      }
      return data
    })
    return { rows: {}, data: result === 'no_store' ? ({ connected: false } satisfies ShopifyCallContextData) : result }
  },

  'shopify.findOrders': async (ctx, input: OrderSearch & { callId: string; callerNumber?: boolean }) => {
    const result = await withStore(ctx, input, async ({ call, token, store }): Promise<ShopifyFindOrdersData> => {
      const phone = input.phone ?? (input.callerNumber && call.from_number ? call.from_number : undefined)
      try {
        const orders = await searchOrders(store, token, { ...input, phone }, call.from_number)
        if (orders === null) return { orders: [], problem: 'nothing' }
        return { orders: orders.map(orderView), problem: null }
      } catch (e) {
        failed('find orders', e)
        return { orders: [], problem: 'failed' }
      }
    })
    return { rows: {}, data: result === 'no_store' ? { orders: [], problem: 'no_store' } : result }
  },

  'shopify.findProducts': async (ctx, input: { callId: string; query: string }) => {
    const result = await withStore(ctx, input, async ({ token, store }): Promise<ShopifyFindProductsData> => {
      try {
        let products: Awaited<ReturnType<ShopifyStore['findProducts']>> = []
        for (const query of productQueries(input.query)) {
          products = await store.findProducts(token, query)
          if (products.length) break
        }
        return {
          products: products.map(p => ({
            title: p.title,
            variants: p.variants.map(v => ({
              title: v.title,
              price: v.price,
              available: v.available,
              inStock: v.inStock,
            })),
          })),
          problem: null,
        }
      } catch (e) {
        failed('find products', e)
        return { products: [], problem: 'failed' }
      }
    })
    return { rows: {}, data: result === 'no_store' ? { products: [], problem: 'no_store' } : result }
  },

  'shopify.changeOrder': async (
    ctx,
    input: {
      callId: string
      orderNumber: string
      change: ShopChange
      proof: Proof
      items?: string[]
      address?: { address1: string; address2?: string; city?: string; zip?: string }
      reason?: string
    },
  ) => {
    const result = await withStore(
      ctx,
      input,
      async ({ call, connection, token, store }): Promise<ShopifyChangeOrderData> => {
        if (!appSettingOn(connection.settings, SHOP_CHANGE_SWITCH[input.change], 'shopify'))
          return { status: 'not_allowed', detail: null }
        if (changesDone.has(call.id)) return { status: 'not_allowed', detail: 'one change per call' }
        if (mismatchCount(call.id) >= MISMATCHES_PER_CALL)
          return { status: 'not_allowed', detail: 'too many wrong answers' }
        const digits = orderDigits(input.orderNumber)
        if (!digits) return { status: 'not_found', detail: null }
        let order: ShopifyOrder | undefined
        try {
          order = (
            await store.findOrders(token, `name:${quoteTerm(`#${digits}`)} OR name:${quoteTerm(digits)}`, 5)
          ).find(o => orderDigits(o.name) === digits)
        } catch (e) {
          failed('change: find order', e)
          return { status: 'failed', detail: null }
        }
        if (!order) return { status: 'not_found', detail: null }
        const required = SHOP_VERIFY_SETTINGS.filter(id => appSettingOn(connection.settings, id, 'shopify'))
        // The order number alone proves nothing (it names the order): at least one other check (the settings refuse
        // anything less too).
        if (!required.some(id => id !== 'verify_order_number')) return { status: 'not_allowed', detail: null }
        const { missing, mismatch } = checkProof(required, input.proof, order, {
          number: call.from_number,
          // Only a number the carrier fully vouched for (STIR/SHAKEN A): without attestation (most trunks outside the
          // US) a number is easy to fake.
          attested: call.source === 'phone' && call.caller_attestation === 'A',
        })
        if (mismatch) countMismatch(call.id)
        if (missing.length || mismatch) return { status: 'not_verified', missing, mismatch }
        const note = [`Linedesk call ${call.id}`, input.reason].filter(Boolean).join(': ')
        try {
          if (input.change === 'return') {
            const lines = await store.returnableLines(token, order.id)
            const wanted = input.items?.length
              ? lines.filter(line => input.items!.some(item => line.title.toLowerCase().includes(item.toLowerCase())))
              : lines
            const returnable = wanted.filter(line => line.quantity > 0 && line.fulfillmentLineItemId)
            // i18n-ignore: text the voice assistant reads (rule 11), not shown in the app
            if (returnable.length === 0) return { status: 'too_late', detail: 'nothing on this order can be returned' }
            const name = await store.requestReturn(token, order.id, returnable, note)
            changesDone.add(call.id)
            return { status: 'done', detail: name }
          }
          // An address or a cancellation only before anything left the warehouse.
          if (order.cancelledAt) return { status: 'too_late', detail: 'cancelled already' }
          if (order.fulfillmentStatus && order.fulfillmentStatus !== 'UNFULFILLED')
            return { status: 'too_late', detail: words(order.fulfillmentStatus) }
          if (input.change === 'address') {
            // i18n-ignore: text the voice assistant reads (rule 11), not shown in the app
            if (!input.address?.address1) return { status: 'failed', detail: 'no new address' }
            await store.updateShippingAddress(token, order.id, input.address)
            changesDone.add(call.id)
            return { status: 'done', detail: null }
          }
          await store.cancelOrder(token, order.id, note)
          changesDone.add(call.id)
          return { status: 'done', detail: null }
        } catch (e) {
          failed(`change ${input.change}`, e)
          return { status: 'failed', detail: e instanceof AppError && e.kind === 'invalid' ? e.message : null }
        }
      },
    )
    return { rows: {}, data: result === 'no_store' ? { status: 'no_store', detail: null } : result }
  },
}
