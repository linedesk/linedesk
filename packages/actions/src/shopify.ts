import { z } from 'zod'
import type { ShopVerify } from './apps.ts'
import { defineAction } from './define.ts'

/**
 * The assistant and the business's Shopify store during a call (docs/crm-sync.md, "Shopify"): who the caller is in
 * the store, their orders, the products, the store's policies, and the changes the business allows (a return, a new
 * shipping address, a cancellation), each only after the caller passed the checks the business picked. Run by the
 * voice agent (permission `agent`); the API reaches Shopify with the workspace's connection. Reads hold no
 * transaction open (readOnly): Shopify may take a second.
 */

const callId = z.string().min(1)
const short = z.string().trim().max(200)

/** One order as the assistant gets it. */
export type ShopOrderView = {
  /** "#1001". */
  number: string
  placedOn: string
  status: string
  payment: string | null
  total: string | null
  items: string[]
  shipTo: string | null
  shipments: string[]
  /** The customer the order is for, as the store names them. */
  customer: string | null
}

export type ShopCustomerView = { name: string | null; email: string | null; orders: number }

/** `data` of shopify.callContext: null fields when the store has nothing, `connected: false` when there is no store. */
export type ShopifyCallContextData =
  | { connected: false }
  | {
      connected: true
      /** The customer with the caller's number; null: none, or the caller ID is not trusted. */
      customer: ShopCustomerView | null
      orders: ShopOrderView[]
      policies: { title: string; text: string }[]
    }

export const shopifyCallContext = defineAction({
  name: 'shopify.callContext',
  description:
    // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
    "What the store knows at the start of a call: the Shopify customer with the caller's number and their last orders, and the store's policies.",
  input: z.object({ callId }),
  permission: 'agent',
  readOnly: true,
})

export const shopifyFindOrders = defineAction({
  name: 'shopify.findOrders',
  description:
    // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
    "Find orders in the workspace's Shopify store by what the caller says: the order number, an email, a name, a postcode, a phone number, or the caller's own number; optionally only open, unshipped or shipped ones.",
  input: z.object({
    callId,
    orderNumber: short.optional(),
    email: short.optional(),
    name: short.optional(),
    postcode: short.optional(),
    phone: short.optional(),
    /** Search by the number the caller is calling from. */
    callerNumber: z.boolean().optional(),
    status: z.enum(['any', 'open', 'unshipped', 'shipped', 'cancelled']).optional(),
  }),
  permission: 'agent',
  readOnly: true,
})

/** `data` of shopify.findOrders. `problem`: `no_store` (not connected), `nothing` (no search term), `failed`. */
export type ShopifyFindOrdersData =
  | { orders: ShopOrderView[]; problem: null }
  | { orders: []; problem: 'no_store' | 'nothing' | 'failed' }

export const shopifyFindProducts = defineAction({
  name: 'shopify.findProducts',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description: "Find products in the workspace's Shopify store: price, variants and whether they are in stock.",
  input: z.object({ callId, query: z.string().trim().min(1).max(200) }),
  permission: 'agent',
  readOnly: true,
})

export type ShopProductView = {
  title: string
  variants: { title: string; price: string | null; available: boolean; inStock: number | null }[]
}

export type ShopifyFindProductsData =
  | { products: ShopProductView[]; problem: null }
  | { products: []; problem: 'no_store' | 'failed' }

export const shopChanges = ['return', 'address', 'cancel'] as const
export type ShopChange = (typeof shopChanges)[number]

export const shopifyChangeOrder = defineAction({
  name: 'shopify.changeOrder',
  description:
    // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
    'Change an order for the caller, when the business allows that change (Integrations › Shopify): start a return, change the shipping address of an order not shipped yet, or cancel an order not shipped yet. The API checks what the caller gave against the order first (the checks the business picked); nothing changes without a match.',
  input: z.object({
    callId,
    orderNumber: short,
    change: z.enum(shopChanges),
    /** What the caller said to prove it is their order; only the checks the business picked are compared. */
    proof: z
      .object({
        name: short.optional(),
        postcode: short.optional(),
        email: short.optional(),
        orderNumber: short.optional(),
      })
      .default({}),
    /** return: the items to send back, as the caller named them; none: everything that can be returned. */
    items: z.array(short).max(20).optional(),
    /** address: the new address. */
    address: z
      .object({ address1: short, address2: short.optional(), city: short.optional(), zip: short.optional() })
      .optional(),
    /** What the caller said about why, for the shop. */
    reason: z.string().trim().max(300).optional(),
  }),
  permission: 'agent',
  // The checks and the change at Shopify hold no transaction open.
  readOnly: true,
})

/**
 * `data` of shopify.changeOrder. done: the change was made (`detail`: the return's name, or nothing). Else why not:
 * not_allowed (the business has not turned this change on), not_found (no such order), not_verified (`missing`: the
 * checks the caller has not given yet; `mismatch`: one did not match), too_late (shipped or cancelled already, or
 * nothing left to return), no_store, failed.
 */
export type ShopifyChangeOrderData =
  | { status: 'done'; detail: string | null }
  | { status: 'not_verified'; missing: ShopVerify[]; mismatch: boolean }
  | { status: 'not_allowed' | 'not_found' | 'too_late' | 'no_store' | 'failed'; detail: string | null }

/** What call.start tells the agent about the store: which changes it may offer and which checks they need. */
export type ShopifyCallSetup = { changes: ShopChange[]; proof: ShopVerify[] }
