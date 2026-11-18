// The Stripe bootstrap (docs/billing.md §9, PR 6): creates or updates, in the account of the key, everything billing
// expects to find there: the products and plan prices (by `lookup_key`), the account's default tax code, the customer
// portal configuration, the payment method configuration "Linedesk Checkout" (card only) and the webhook endpoint,
// pinned to the adapter's API version. Idempotent: a second run changes nothing. Run by a person with a key that may
// write those objects (not the install's restricted key), through scripts/bootstrap.ts.
//
// Nothing here is an id written into the code: products have our own ids, prices are found by lookup key, the portal
// configuration by its metadata, the payment method configuration by name, the endpoint by its URL. The ids it finds
// or makes are returned (the script writes them to a file, not into the code).
import Stripe from 'stripe'
import { stripeKeyMode } from '../keys.ts'
import { CHECKOUT_PMC_NAME, type KeyMode, PORTAL_METADATA, WEBHOOK_EVENTS } from '../provider.ts'
import { findCheckoutConfiguration, STRIPE_API_VERSION, STRIPE_TIMEOUT_MS } from './index.ts'
import { portalFits, portalParams } from './portal.ts'

export { CHECKOUT_PMC_NAME } from '../provider.ts'

export type CatalogPrice = { lookupKey: string; product: string; cents: number; interval: 'month' | 'year' }
export type Catalog = {
  /** Product key (also the end of the product's id, `linedesk_<key>`) → its name on invoices. */
  products: Record<string, string>
  prices: readonly CatalogPrice[]
  taxCode: string
}

export type BootstrapOptions = {
  /** The mode the person asked for (`--sandbox` / `--live`); the key must be of it. */
  mode: KeyMode
  /** Live only with `--live --i-know`: they would set up the account that charges real cards. */
  allowLive?: boolean
  /** The install's webhook URL, `https://<host>/v1/billing/stripe/webhook`. */
  webhookUrl: string
  termsUrl: string
  privacyUrl: string
  /** Where the portal's "back" link goes (Settings › Billing). Left as it is in Stripe when not given. */
  returnUrl?: string
  /**
   * An endpoint at the URL in another API version cannot be changed: make a new, pinned one beside it (a new secret).
   * The old one keeps running until it is deleted with `deleteOldWebhooks` (security review of #866, L2).
   */
  recreateWebhook?: boolean
  /** Delete the endpoints at the URL in another API version, once the pinned one receives (second step of L2). */
  deleteOldWebhooks?: boolean
  /** Replace a price whose amount or terms changed, and archive the old one (live subscriptions keep it; L3). */
  replacePrices?: boolean
  /** List what would change, change nothing. */
  dryRun?: boolean
}

export type BootstrapResult = {
  account: string
  mode: KeyMode
  products: Record<string, string>
  prices: Record<string, string>
  portalConfiguration: string | null
  paymentMethodConfiguration: string | null
  webhookEndpoint: string | null
  /** Endpoints at the URL in another API version, still delivering until deleted (`deleteOldWebhooks`). */
  oldWebhookEndpoints: string[]
  /** What was created or changed (empty on a run with nothing to do). */
  changes: string[]
  /** Only when the endpoint was created now: Stripe shows the signing secret once. Never log it. */
  webhookSecret: string | null
}

export { PORTAL_METADATA } from '../provider.ts'
export const WEBHOOK_METADATA = { linedesk: 'billing' } as const
export class BootstrapRefused extends Error {}

const productId = (key: string) => `linedesk_${key}`
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** Refuses before any request: a key of another mode than asked, or live without both flags. */
export function checkBootstrapKey(secretKey: string, options: Pick<BootstrapOptions, 'mode' | 'allowLive'>) {
  const mode = stripeKeyMode(secretKey)
  if (!mode) throw new BootstrapRefused('not a Stripe secret or restricted key')
  if (mode !== options.mode)
    throw new BootstrapRefused(
      `the key is a ${mode} key, but --${options.mode === 'live' ? 'live' : 'sandbox'} was given`,
    )
  if (mode === 'live' && !options.allowLive)
    throw new BootstrapRefused('a live key sets up the account that charges real cards: add --live --i-know')
  return mode
}

export async function bootstrapStripe(
  secretKey: string,
  catalog: Catalog,
  options: BootstrapOptions,
  doFetch: typeof fetch = fetch,
): Promise<BootstrapResult> {
  const mode = checkBootstrapKey(secretKey, options)
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(doFetch),
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: 2,
    telemetry: false,
    appInfo: { name: 'Linedesk bootstrap' },
  })
  const changes: string[] = []
  /** Runs a write unless this is a dry run; the change is listed either way. */
  const write = async <T>(change: string, run: () => Promise<T>): Promise<T | null> => {
    changes.push(change)
    return options.dryRun ? null : run()
  }

  const account = await stripe.accounts.retrieveCurrent()

  // Products, by our own ids.
  const products: Record<string, string> = {}
  for (const [key, name] of Object.entries(catalog.products)) {
    const id = productId(key)
    const found = await stripe.products.retrieve(id).catch(error => {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) return null
      throw error
    })
    if (!found) {
      await write(`create product ${id}`, () =>
        stripe.products.create({ id, name, tax_code: catalog.taxCode, metadata: { linedesk: key } }),
      )
    } else if (found.name !== name || idOf(found.tax_code) !== catalog.taxCode || !found.active) {
      await write(`update product ${id}`, () =>
        stripe.products.update(id, { name, tax_code: catalog.taxCode, active: true }),
      )
    }
    products[key] = id
  }

  // Prices, by lookup key. A price's amount cannot change: a different one is a new price that takes the lookup key
  // over (`transfer_lookup_key`), and the old one is archived (subscriptions on it keep it until moved; billing finds
  // their seats by the price's `metadata.linedesk`, which the old price keeps). Only with `replacePrices` (L3).
  const prices: Record<string, string> = {}
  const existing = new Map<string, Stripe.Price>()
  for (let i = 0; i < catalog.prices.length; i += 10) {
    const keys = catalog.prices.slice(i, i + 10).map(p => p.lookupKey)
    const page = await stripe.prices.list({ lookup_keys: keys, limit: 100 })
    for (const price of page.data) if (price.lookup_key) existing.set(price.lookup_key, price)
  }
  for (const want of catalog.prices) {
    const have = existing.get(want.lookupKey)
    const product = productId(want.product)
    const fits =
      have?.active &&
      have.unit_amount === want.cents &&
      have.currency === 'usd' &&
      have.tax_behavior === 'exclusive' &&
      have.recurring?.interval === want.interval &&
      have.recurring.interval_count === 1 &&
      have.recurring.usage_type === 'licensed' &&
      idOf(have.product) === product
    if (fits) {
      prices[want.lookupKey] = have.id
      continue
    }
    if (have && !options.replacePrices) {
      if (!options.dryRun)
        throw new BootstrapRefused(
          `the price ${want.lookupKey} (${have.id}) in Stripe differs from the catalog; subscriptions on it keep it. Check with --dry-run, then run again with --replace-prices to replace it and archive the old one.`,
        )
      changes.push(`replace price ${want.lookupKey} (needs --replace-prices)`)
      prices[want.lookupKey] = have.id
      continue
    }
    const made = await write(`${have ? 'replace' : 'create'} price ${want.lookupKey}`, () =>
      stripe.prices.create({
        product,
        currency: 'usd',
        unit_amount: want.cents,
        recurring: { interval: want.interval, usage_type: 'licensed' },
        tax_behavior: 'exclusive',
        lookup_key: want.lookupKey,
        transfer_lookup_key: !!have,
        metadata: { linedesk: want.lookupKey },
      }),
    )
    if (have?.active)
      await write(`archive old price ${want.lookupKey}`, () => stripe.prices.update(have.id, { active: false }))
    prices[want.lookupKey] = made?.id ?? have?.id ?? '(dry run)'
  }

  // The account's default tax code and behavior (docs/billing.md §5.2).
  const tax = await stripe.tax.settings.retrieve()
  if (tax.defaults.tax_code !== catalog.taxCode || tax.defaults.tax_behavior !== 'exclusive')
    await write('set the account default tax code', () =>
      stripe.tax.settings.update({ defaults: { tax_code: catalog.taxCode, tax_behavior: 'exclusive' } }),
    )

  const paymentMethodConfiguration = await checkoutPaymentMethods(stripe, write)
  const portalConfiguration = await portal(stripe, options, write)
  const webhook = await webhookEndpoint(stripe, options, write)
  return {
    account: account.id,
    mode,
    products,
    prices,
    portalConfiguration,
    paymentMethodConfiguration,
    webhookEndpoint: webhook.id,
    oldWebhookEndpoints: webhook.old,
    changes,
    webhookSecret: webhook.secret,
  }
}

type Write = <T>(change: string, run: () => Promise<T>) => Promise<T | null>
const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null)

/**
 * "Linedesk Checkout": card only, no wallets and no Link (docs/billing.md §2.4, decision 7). Every other method the
 * configuration lists is set off, so methods Stripe adds later and turns on by default are caught on the next run. Same
 * in the sandbox and live (each account has its own; the app finds it by name, `checkoutPaymentMethodConfiguration`).
 * Checkout must pass its id as `payment_method_configuration`: with only `payment_method_types: ['card']` Stripe still
 * offers Apple Pay and a pre-ticked "save with Link" (billing review of 16.11., B6).
 */
async function checkoutPaymentMethods(stripe: Stripe, write: Write) {
  // Every page: an account with more than 100 configurations still finds it (review of #876, I2).
  const found = await findCheckoutConfiguration(stripe)
  const methodsOf = (config: Stripe.PaymentMethodConfiguration) =>
    Object.entries(config).filter(
      (entry): entry is [string, { display_preference: { preference: string } }] =>
        typeof entry[1] === 'object' && entry[1] !== null && 'display_preference' in entry[1],
    )
  // A new one starts from the account's default configuration (its list of methods), all but the card set off.
  const first = found ? null : (await stripe.paymentMethodConfigurations.list({ limit: 100 })).data
  const template = found ?? first?.find(c => c.is_default) ?? first?.[0]
  const wanted: Record<string, { display_preference: { preference: 'on' | 'off' } }> = {}
  for (const [method, setting] of template ? methodsOf(template) : []) {
    const on = method === 'card'
    // `preference` is ours; `value` also says whether Stripe can offer the method at all, so it is not compared.
    if (!found || setting.display_preference.preference !== (on ? 'on' : 'off'))
      wanted[method] = { display_preference: { preference: on ? 'on' : 'off' } }
  }
  if (!found) {
    wanted.card = { display_preference: { preference: 'on' } }
    // Named in decision 7: off even when the template does not list them.
    for (const method of ['apple_pay', 'google_pay', 'link'])
      wanted[method] ??= { display_preference: { preference: 'off' } }
    const made = await write(`create payment method configuration "${CHECKOUT_PMC_NAME}" (card only)`, () =>
      stripe.paymentMethodConfigurations.create({ name: CHECKOUT_PMC_NAME, ...wanted }),
    )
    return made?.id ?? null
  }
  // Checkout refuses an inactive configuration, and the app finds only an active one.
  const reactivate = found.active ? {} : { active: true }
  if (Object.keys(wanted).length || !found.active)
    await write(
      `payment method configuration: ${[...Object.keys(wanted).sort(), ...(found.active ? [] : ['active'])].join(', ')}`,
      () => stripe.paymentMethodConfigurations.update(found.id, { ...wanted, ...reactivate }),
    )
  return found.id
}

/**
 * The customer portal (docs/billing.md §2.4): invoices, cards and customer details; no plan changes and no cancel.
 * Cancel and "Keep my plan" happen in the app only (`billing.cancel`, `billing.resume`), so the plan state the app shows
 * is the one it set (security review of #1007, M-2); `customer.subscription.updated` mirrors any change made elsewhere.
 */
async function portal(stripe: Stripe, options: BootstrapOptions, write: Write) {
  // Not given: Stripe keeps the return URL it has (security review of #866, N1); the headline is the app's (its sync).
  const wanted = { termsUrl: options.termsUrl, privacyUrl: options.privacyUrl, returnUrl: options.returnUrl }
  const params = portalParams(wanted)
  const all = await stripe.billingPortal.configurations.list({ limit: 100 })
  const found = all.data.find(c => c.metadata?.linedesk === PORTAL_METADATA.linedesk && c.active)
  if (!found) {
    const made = await write('create the customer portal configuration', () =>
      stripe.billingPortal.configurations.create(params),
    )
    return made?.id ?? null
  }
  if (!portalFits(found, wanted))
    await write('update the customer portal configuration', () =>
      stripe.billingPortal.configurations.update(found.id, params),
    )
  return found.id
}

/**
 * The webhook endpoint at the install's URL: the events of `WEBHOOK_EVENTS`, pinned to `STRIPE_API_VERSION` (the
 * route refuses events in any other version). An endpoint's version cannot be changed, so a new one is made beside an
 * old one, never after deleting it (security review of #866, L2): with `recreateWebhook` the pinned endpoint is created
 * first and the old one keeps delivering (refused for its version, picked up by the reconciliation) until the new
 * secret is stored and a later run deletes it with `deleteOldWebhooks`.
 */
async function webhookEndpoint(stripe: Stripe, options: BootstrapOptions, write: Write) {
  const all = await stripe.webhookEndpoints.list({ limit: 100 })
  const atUrl = all.data.filter(e => e.url === options.webhookUrl)
  let pinned: { id: string | null; secret: string | null } | null = null
  const found = atUrl.find(e => e.api_version === STRIPE_API_VERSION)
  const old = atUrl.filter(e => e !== found)
  if (found) {
    if (!sameSet(found.enabled_events, WEBHOOK_EVENTS) || found.status !== 'enabled')
      await write('update the webhook endpoint events', () =>
        stripe.webhookEndpoints.update(found.id, {
          enabled_events: [...WEBHOOK_EVENTS],
          disabled: false,
          metadata: { ...WEBHOOK_METADATA },
        }),
      )
    pinned = { id: found.id, secret: null }
  } else {
    if (old.length && !options.recreateWebhook)
      throw new BootstrapRefused(
        `the webhook endpoint ${old.map(e => e.id).join(', ')} is on API version ${old[0]!.api_version ?? 'the account default'}, not ${STRIPE_API_VERSION}; its version cannot be changed. Run again with --recreate-webhook: a pinned endpoint is made beside it (a new signing secret), the old one is deleted only later, with --delete-old-webhooks.`,
      )
    const made = await write(`create the webhook endpoint ${options.webhookUrl} (${STRIPE_API_VERSION})`, () =>
      stripe.webhookEndpoints.create({
        url: options.webhookUrl,
        enabled_events: [...WEBHOOK_EVENTS],
        api_version: STRIPE_API_VERSION,
        description: 'Linedesk billing',
        metadata: { ...WEBHOOK_METADATA },
      }),
    )
    pinned = { id: made?.id ?? null, secret: made?.secret ?? null }
  }
  const kept: string[] = []
  for (const endpoint of old) {
    // Only once the pinned one existed before this run: its secret is stored and it receives.
    if (options.deleteOldWebhooks && found)
      await write(
        `delete the old webhook endpoint ${endpoint.id} (API version ${endpoint.api_version ?? 'default'})`,
        () => stripe.webhookEndpoints.del(endpoint.id),
      )
    else kept.push(endpoint.id)
  }
  return { ...pinned, old: kept }
}
