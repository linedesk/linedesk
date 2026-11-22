import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * A store's own Shopify app, set up on request (LIN-719, docs/crm-sync.md "Shopify"). Until the install's public app is
 * approved in Shopify's App Store (Server admin › Providers › Shopify, "Public app approved"), a store connects through a
 * custom app made for it alone: a member asks with the store's address, the install's team (or its setup agent) makes the
 * app in Shopify's Dev Dashboard and stores its keys as the workspace's own (shopifySetup.ready), the member installs it
 * on the store with Shopify's link, and Shopify sends them back to connect (GET /v1/apps/open/shopify).
 */
export const shopifySetupStatuses = ['requested', 'ready', 'connected', 'failed'] as const
export type ShopifySetupStatus = (typeof shopifySetupStatuses)[number]

/** A short code for why a setup failed, the agent's own (`store_not_found`, `no_access`): the page words it generally. */
const failureCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)

/** The workspace's open request, as its members see it: never a key. */
export type ShopifySetupRequest = {
  id: string
  shop: string
  status: ShopifySetupStatus
  /** Shopify's link that installs the store's app (status `ready`). */
  installUrl: string | null
  failure: string | null
  createdAt: string
  updatedAt: string
}

/**
 * `data` of shopify.setupStatus and shopify.requestSetup. `way`: `connect` when Connect opens Shopify's consent page (the
 * workspace has its own app, or the install's public app is approved), `request` when the store must be set up first,
 * `app_store` when the public app is approved and listed: Connect opens its listing in Shopify's App Store
 * (`appStoreUrl`), where the store installs it, and the store is then linked from the app in its Shopify admin.
 * `request`: the workspace's open request (not yet connected), or null.
 */
export type ShopifySetupStatusData = {
  way: 'connect' | 'request' | 'app_store'
  request: ShopifySetupRequest | null
  appStoreUrl?: string
}

export const shopifySetupStatus = defineAction({
  name: 'shopify.setupStatus',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "How the workspace connects Shopify: `way` is `connect` (Connect opens Shopify's consent page) or `request` (the store's own app must be set up first, with shopify.requestSetup), and the open setup request with its status (requested, ready with the install link, failed).",
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

export const shopifyRequestSetup = defineAction({
  name: 'shopify.requestSetup',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Ask for the store's own Shopify app, while the install's public app is not approved yet. `shop`: the store's myshopify.com domain or its first part. Replaces the workspace's open request; the install's team is told by email, and the member gets an email with the install link when the app is ready (usually within 30 minutes).",
  input: z.object({ shop: z.string().trim().min(1).max(200) }),
  permission: 'settings:write',
})

/** One open request in Server admin (shopifySetup.list). */
export type ShopifySetupListItem = {
  id: string
  workspaceId: string
  workspaceName: string
  shop: string
  status: ShopifySetupStatus
  /** The member who asked: their address. */
  requestedBy: string | null
  failure: string | null
  createdAt: string
  updatedAt: string
}
/** `data` of shopifySetup.list. */
export type ShopifySetupListData = { requests: ShopifySetupListItem[] }

export const shopifySetupList = defineAction({
  name: 'shopifySetup.list',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The open requests for a store's own Shopify app (not connected yet), oldest first: the workspace, the store's myshopify.com domain, the status (requested, ready, failed) and who asked.",
  input: z.object({ status: z.enum(['requested', 'ready', 'failed']).optional() }),
  permission: 'instance:admin',
  readOnly: true,
})

/** The store's handle in Shopify's admin: the part of its domain before `.myshopify.com`. */
export const shopHandle = (shop: string) => shop.replace(/\.myshopify\.com$/, '')

/**
 * Whether `url` is Shopify's install link of this custom app for this store:
 * https://admin.shopify.com/store/<handle>/oauth/install_custom_app?client_id=<clientId>&… (more parameters allowed).
 */
export function isShopifyInstallUrl(url: string, shop: string, clientId: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'admin.shopify.com' &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === `/store/${shopHandle(shop)}/oauth/install_custom_app` &&
    parsed.searchParams.getAll('client_id').length === 1 &&
    parsed.searchParams.get('client_id') === clientId
  )
}

export const shopifySetupReady = defineAction({
  name: 'shopifySetup.ready',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The store's own Shopify app is made: stores its client ID and secret as the workspace's own Shopify app, sets the request ready with Shopify's install link, and emails the member who asked. `installUrl` must be https://admin.shopify.com/store/<store>/oauth/install_custom_app?client_id=<clientId>&… for the request's store. Set the app's URL to <install address>/v1/apps/open/shopify and its redirect URL to <install address>/v1/apps/callback/shopify.",
  input: z.object({
    requestId: z.string().min(1).max(100),
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,100}$/),
    clientSecret: z.string().trim().min(8).max(200),
    installUrl: z.string().trim().max(2000),
  }),
  permission: 'instance:admin',
  sensitive: ['clientSecret'],
})

export const shopifySetupFailed = defineAction({
  name: 'shopifySetup.failed',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The store's own Shopify app could not be made: the request shows as failed with this short code (`store_not_found`, `no_access`, …), and the page tells the business the team will contact them.",
  input: z.object({ requestId: z.string().min(1).max(100), failure: failureCode }),
  permission: 'instance:admin',
})
