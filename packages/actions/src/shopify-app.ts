import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * The install's own Shopify app in Shopify's App Store (docs/crm-sync.md "Shopify"). Shopify installs it and opens its
 * embedded page in the store's admin (GET /shopify/app on the API); the page asks the API with App Bridge's session
 * token, which exchanges it for the store's offline access (POST /v1/shopify/embedded/session). The store is then
 * linked to a Linedesk workspace from a new tab: `#shopify/link?t=<token>` in the web app, a single-use link the page
 * got, where an owner or admin signs in, picks the workspace and confirms (shopify.linkInstall).
 */

/** The web app's page that links an installed store to a workspace: `#shopify/link?t=<token>`. */
export const SHOPIFY_LINK_HASH = '#shopify/link'

/** Why a link was refused, as a code the page words itself. */
export const shopifyLinkErrors = [
  /** The link is unknown or was used already. */
  'link_invalid',
  /** The link is older than 15 minutes. */
  'link_expired',
  /** The store removed the app since. */
  'not_installed',
  /** This workspace is connected to another Shopify store. */
  'other_store',
  /** The store is linked to another workspace. */
  'linked_elsewhere',
  /** This workspace connects Shopify with a custom app of its own. */
  'own_app',
  /** Shopify did not grant every permission the app needs. */
  'scope',
  'no_secrets_key',
] as const
export type ShopifyLinkError = (typeof shopifyLinkErrors)[number]
export const isShopifyLinkError = (value: unknown): value is ShopifyLinkError =>
  (shopifyLinkErrors as readonly unknown[]).includes(value)

/** `data` of shopify.describeLink: the store the link is for, and the Shopify store this workspace has connected. */
export type ShopifyLinkInfo = {
  shop: string
  shopName: string
  expiresAt: string
  connectedShop: string | null
  /** The store owner's address in Shopify, who opened the app and started this link. */
  startedBy: string | null
}

/** `data` of shopify.linkInstall. */
export type ShopifyLinkData = { shop: string; connectionId: string }

/** The answer of POST /v1/shopify/embedded/session: what the embedded page shows. */
export type ShopifyEmbeddedStatus = {
  shop: string
  shopName: string
  /** The workspace the store is linked to, or null. */
  workspace: { id: string; name: string } | null
  /** Where "Connect this store to Linedesk" goes (a new single-use link), when not linked and one was asked for. */
  linkUrl: string | null
  /** Where "Open Linedesk" goes, when linked. */
  openUrl: string | null
  /**
   * The staff member who opened the app is not the store's owner: only the owner connects the store, so no link was
   * made (only when one was asked for).
   */
  ownerOnly: boolean
}

/**
 * Whether `url` is a listing in Shopify's App Store (https://apps.shopify.com/<app>), what Integrations › Shopify opens
 * once the public app is approved (Server admin › Providers › Shopify).
 */
export function isShopifyAppStoreUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'apps.shopify.com' &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    /^\/[a-z0-9][a-z0-9-]*\/?$/.test(parsed.pathname)
  )
}

const linkToken = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/)

export const shopifyDescribeLink = defineAction({
  name: 'shopify.describeLink',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "What a link from Linedesk's embedded Shopify app is for: the store and when the link runs out, and the Shopify store this workspace has connected already (or null). Refused when the link is unknown, used or expired.",
  input: z.object({ token: linkToken }),
  permission: 'call:read',
  readOnly: true,
  sensitive: ['token'],
})

export const shopifyLinkInstall = defineAction({
  name: 'shopify.linkInstall',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Link a store that installed Linedesk from Shopify's App Store to this workspace, with the single-use link its embedded app gave (15 minutes). The workspace's Shopify connection is made with the store's access, as Connect does. Refused when the workspace is connected to another store, the store is linked to another workspace, or the link is used or expired.",
  input: z.object({ token: linkToken }),
  permission: 'settings:write',
  sensitive: ['token'],
})
