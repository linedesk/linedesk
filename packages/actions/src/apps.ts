import type { AppErrorCode } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * Connected apps (docs/crm-sync.md): business tools a workspace connects by OAuth, so every finished
 * phone call goes to them. Same list as APP_IDS in @linedesk/connectors (the API checks they match).
 */
export const connectableApps = ['hubspot', 'slack', 'jobber', 'shopify', 'zoho'] as const
export type ConnectableApp = (typeof connectableApps)[number]
const app = z.enum(connectableApps)

/**
 * Why connecting or disconnecting an app did not work: the `reason` of the OAuth callback's redirect and the `code`
 * of the actions' rejections. The page words each one (an unknown code gets the generic text), so no server text
 * reaches the page and nobody can put their own text into the redirect.
 */
export const appConnectErrors = [
  'denied',
  'signed_out',
  'expired',
  'not_yours',
  'scope',
  'no_grant',
  'not_set_up',
  'no_secrets_key',
  'not_connected',
  'shop',
  'verify',
  /** Shopify: the store needs its own app first (shopify.requestSetup), until the install's public app is approved. */
  'setup_needed',
  'failed',
] as const
export type AppConnectError = (typeof appConnectErrors)[number]
export const isAppConnectError = (value: unknown): value is AppConnectError =>
  (appConnectErrors as readonly unknown[]).includes(value)

export const appConnectStart = defineAction({
  name: 'app.connectStart',
  description:
    "Start connecting an app (HubSpot, Slack, Jobber, Shopify, Zoho CRM) to the workspace. Returns the URL of the app's consent page; Slack's lets the member pick the channel calls are posted to. Shopify needs `shop`: the store's myshopify.com domain or its first part.",
  input: z.object({ app, shop: z.string().trim().min(1).max(200).optional() }),
  permission: 'settings:write',
})

/** `data` of app.connectStart. */
export type AppConnectStartData = { url: string }

export const appConnectFinish = defineAction({
  name: 'app.connectFinish',
  description: 'Finish connecting an app with the code it sent back. Run by the OAuth callback route.',
  input: z.object({
    app,
    state: z.string().min(16).max(200),
    code: z.string().min(1).max(4000),
    /** The callback's whole query, for an app that signs it (Shopify: `hmac` over `shop`, `code`, `state`, ...). */
    params: z.record(z.string().max(200), z.string().max(4000)).optional(),
  }),
  permission: 'settings:write',
  sensitive: ['code', 'state', 'params'],
})

export const appDisconnect = defineAction({
  name: 'app.disconnect',
  description:
    'Disconnect an app: removes its tokens and links, withdraws the grant at the app, and stops sending calls to it.',
  input: z.object({ app }),
  permission: 'settings:write',
})

/** `data` of app.disconnect. revoked: the app confirmed it withdrew the grant. */
export type AppDisconnectData = { revoked: boolean }

/**
 * What Linedesk does in a connected app: switches a member turns on or off per connection (Integrations › HubSpot).
 * For Jobber a contact is a client, and a call is logged as a note on it.
 * On by default (except those in OFF_BY_DEFAULT), so a connection behaves as before they existed; a connection stores
 * only those changed.
 * - log_calls: every finished phone call goes to the app (Slack: is posted to the channel). Off: no call is sent
 *   (nor queued).
 * - only_urgent (Slack, off by default): only calls the summary marked urgent are posted; the others are skipped
 *   (`not_urgent`).
 * - create_contacts: a caller with no contact in the app gets one. Off: such a call is skipped (`no_contact`);
 *   callers who have a contact still get the call.
 * - fill_fields: empty fields of the caller's contact are filled from Linedesk. Off: an existing contact is never
 *   changed (a new one still gets the caller's name, number, email and company).
 * Shopify (a contact is a customer; off by default: create_contacts and everything below):
 * - shop_returns, shop_address, shop_cancel: the assistant may start a return, change the shipping address of an order
 *   not shipped yet, cancel an order not shipped yet. Each only after the caller passed the checks below.
 * - verify_name, verify_postcode (on by default), verify_email, verify_order_number, verify_caller_number: what the
 *   caller must give that matches the order before such a change (the API compares, not the assistant). At least one.
 */
export const appSettingIds = [
  'log_calls',
  'create_contacts',
  'fill_fields',
  'only_urgent',
  'shop_returns',
  'shop_address',
  'shop_cancel',
  'verify_name',
  'verify_postcode',
  'verify_email',
  'verify_order_number',
  'verify_caller_number',
] as const
export type AppSettingId = (typeof appSettingIds)[number]

/** The switches each app has, in the order the page shows them. */
export const APP_SETTINGS: Record<ConnectableApp, readonly AppSettingId[]> = {
  hubspot: ['log_calls', 'create_contacts', 'fill_fields'],
  slack: ['log_calls', 'only_urgent'],
  jobber: ['log_calls', 'create_contacts', 'fill_fields'],
  zoho: ['log_calls', 'create_contacts', 'fill_fields'],
  shopify: [
    'log_calls',
    'create_contacts',
    'fill_fields',
    'shop_returns',
    'shop_address',
    'shop_cancel',
    'verify_name',
    'verify_postcode',
    'verify_email',
    'verify_order_number',
    'verify_caller_number',
  ],
}

/** The Shopify switches that change an order: each needs the caller to pass the verify_* checks first. */
export const SHOP_CHANGE_SETTINGS = ['shop_returns', 'shop_address', 'shop_cancel'] as const
/** What a caller can be asked to prove before an order changes (Integrations › Shopify, "Before a change"). */
export const SHOP_VERIFY_SETTINGS = [
  'verify_name',
  'verify_postcode',
  'verify_email',
  'verify_order_number',
  'verify_caller_number',
] as const
export type ShopVerify = (typeof SHOP_VERIFY_SETTINGS)[number]

/** Switches that are off until a member turns them on. */
/**
 * The setup Linedesk recommends for most online stores (Integrations › Shopify shows it as a short summary): every call
 * as a note on the customer with empty details filled in, no new customers; returns and address changes after the
 * name and the postcode match; no cancellations (a refund cannot be taken back).
 */
export const SHOPIFY_RECOMMENDED: Readonly<Record<AppSettingId, boolean>> = {
  log_calls: true,
  create_contacts: false,
  fill_fields: true,
  only_urgent: false,
  shop_returns: true,
  shop_address: true,
  shop_cancel: false,
  verify_name: true,
  verify_postcode: true,
  verify_email: false,
  verify_order_number: false,
  verify_caller_number: false,
}

/** The recommended setup as app.updateSettings takes it: only the switches Shopify has (not only_urgent). */
export const shopifyRecommendedSettings = (): Record<AppSettingId, boolean> =>
  Object.fromEntries(APP_SETTINGS.shopify.map(id => [id, SHOPIFY_RECOMMENDED[id]])) as Record<AppSettingId, boolean>

/** Whether a Shopify connection's switches are the recommended setup. */
export const isShopifyRecommended = (stored: Readonly<Record<string, boolean>> | null | undefined): boolean =>
  APP_SETTINGS.shopify.every(id => appSettingOn(stored, id, 'shopify') === SHOPIFY_RECOMMENDED[id])

const OFF_BY_DEFAULT: readonly AppSettingId[] = [
  'only_urgent',
  'shop_returns',
  'shop_address',
  'shop_cancel',
  'verify_email',
  'verify_order_number',
  'verify_caller_number',
]
/** Per app: a shop owner decides themselves who becomes a Shopify customer (Tim, 2026-11-20). */
/**
 * Whether a switch is on for a connection: its own choice, else its default: for Shopify the recommended setup
 * (SHOPIFY_RECOMMENDED, Tim 2026-11-21), for the other apps on, except OFF_BY_DEFAULT.
 */
export const appSettingOn = (
  stored: Readonly<Record<string, boolean>> | null | undefined,
  id: AppSettingId,
  app?: ConnectableApp,
): boolean => stored?.[id] ?? (app === 'shopify' ? SHOPIFY_RECOMMENDED[id] : !OFF_BY_DEFAULT.includes(id))

export const appUpdateSettings = defineAction({
  name: 'app.updateSettings',
  description:
    "Turn what Linedesk does in a connected app on or off. `id`: the connection (app_connections). `settings`: the switches to set, each true or false; a switch left out keeps its value. log_calls: send every finished phone call to the app; create_contacts: add a caller with no contact in the app as a new contact (off: such a call is skipped); fill_fields: fill empty fields of the caller's contact (off: an existing contact is never changed); only_urgent (Slack): post only calls marked urgent. Shopify: shop_returns, shop_address, shop_cancel let the assistant start a return, change the shipping address or cancel an order not shipped yet; verify_name, verify_postcode, verify_email, verify_order_number, verify_caller_number are what the caller must match first. All are on until changed, except only_urgent; Shopify starts with the recommended setup: log_calls, fill_fields, shop_returns, shop_address, verify_name and verify_postcode on, the others off.",
  input: z.object({
    id: z.string().min(1).max(100),
    settings: z
      .object(Object.fromEntries(appSettingIds.map(id => [id, z.boolean()])) as Record<AppSettingId, z.ZodBoolean>)
      .partial()
      .strict(),
  }),
  permission: 'settings:write',
  // Optimistic in the browser (the page sends every switch, so the row is whole); the handler checks the app has
  // these switches and merges them into what is stored.
  patch: {
    table: 'app_connections',
    id: input => input.id,
    set: input => ({ settings: input.settings as Record<string, boolean> }),
  },
})

export const appPushes = defineAction({
  name: 'app.pushes',
  description: 'The last calls sent to a connected app, newest first, with their state and the last failure.',
  input: z.object({ app, limit: z.number().int().min(1).max(50).default(20) }),
  permission: 'settings:write',
  readOnly: true,
})

/** One call sent (or being sent) to an app. */
export type AppPush = {
  id: string
  callId: string
  /** The caller as Linedesk shows them: the contact's name, else the number. */
  caller: string
  /** `sending` shows as pending: it is being sent now. `skipped`: the connection's settings said not to send it. */
  status: 'pending' | 'sending' | 'done' | 'failed' | 'skipped'
  attempts: number
  /** Why it failed, is being retried or was skipped; the page words it. */
  error: AppErrorCode | null
  createdAt: string
  finishedAt: string | null
}

/** `data` of app.pushes. */
export type AppPushesData = { pushes: AppPush[] }
