// What the install sells, made or found in its own Stripe account (docs/billing.md §2.1, §7b): the products and the
// plan prices of the install's settings (`PlanCatalog`). Synced when an instance admin saves the prices or the product
// name (and when billing is turned on), never on a customer's Checkout (security review of #1040, M-1): Checkout uses
// the price ids stored by the last sync, so a key without write on Products and Prices never stops a sign-up or a
// purchase of minutes; the admin who saved hears of it at once.
//
// Idempotent and safe to run twice at once: a product has our own id (`linedesk_<key>`, a second create is a 400 we
// read past), a price is created with an idempotency key made of everything it is and of the price it takes the
// lookup key from (a parallel sync gets the same price back; A → B → A is a new price, not a replay of A, review L-2).
// A plan amount that changed becomes a new price that takes the lookup key over (`transfer_lookup_key`); the old one
// stays active for the subscriptions on it, and keeps `metadata.linedesk` = its lookup key, so its seats are still
// found (`seatItem`) and the webhook still knows it as a plan price. A lookup key held by a price of another product
// (a Stripe account shared with another integration) is never taken over (review L-1).
import Stripe from 'stripe'
import { BillingSetupError, type PlanCatalog } from '../provider.ts'

export const productId = (key: string) => `linedesk_${key}`
/** Every product id of ours starts so; a price of any other product is not ours to move. */
export const isOurProduct = (id: string | null) => !!id && id.startsWith('linedesk_')

const isStripe404 = (error: unknown) => error instanceof Stripe.errors.StripeError && error.statusCode === 404
const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null)

/**
 * One product of ours: found, made when missing (with the tax code); renamed, reactivated or given the tax code only
 * when `rename` (the catalog sync, never a customer's Checkout).
 */
export async function ensureProduct(
  stripe: Stripe,
  key: string,
  name: string,
  taxCode: string,
  { rename = true }: { rename?: boolean } = {},
) {
  const id = productId(key)
  const found = await stripe.products.retrieve(id).catch(error => {
    if (isStripe404(error)) return null
    throw error
  })
  if (!found) {
    await stripe.products
      .create({ id, name, tax_code: taxCode, metadata: { linedesk: key } }, { idempotencyKey: `catalog:product:${id}` })
      .catch(async error => {
        // Made by a parallel sync a moment ago: the id is taken, which is what we wanted.
        if (error instanceof Stripe.errors.StripeError && error.code === 'resource_already_exists') return null
        throw error
      })
  } else if (rename && (found.name !== name || !found.active || idOf(found.tax_code) !== taxCode)) {
    await stripe.products.update(id, { name, active: true, tax_code: taxCode })
  }
}

/** The price ids of the catalog's plan prices, making the products and the prices that are missing or changed. */
export async function ensureCatalog(stripe: Stripe, catalog: PlanCatalog): Promise<Map<string, string>> {
  for (const [key, name] of Object.entries(catalog.products)) await ensureProduct(stripe, key, name, catalog.taxCode)
  const keys = catalog.prices.map(p => p.lookupKey)
  const existing = new Map<string, Stripe.Price>()
  for (let i = 0; i < keys.length; i += 10) {
    const page = await stripe.prices.list({ lookup_keys: keys.slice(i, i + 10), active: true, limit: 100 })
    for (const price of page.data) if (price.lookup_key) existing.set(price.lookup_key, price)
  }
  const prices = new Map<string, string>()
  for (const want of catalog.prices) {
    const have = existing.get(want.lookupKey)
    const product = productId(want.product)
    // Another integration's price holds this lookup key: ours to report, not to take (review L-1).
    if (have && !isOurProduct(idOf(have.product)))
      throw new BillingSetupError(`stripe_lookup_key_taken:${want.lookupKey}`)
    const fits =
      have?.active &&
      have.unit_amount === want.cents &&
      have.currency === catalog.currency &&
      have.tax_behavior === 'exclusive' &&
      have.recurring?.interval === want.interval &&
      have.recurring.interval_count === 1 &&
      have.recurring.usage_type === 'licensed' &&
      idOf(have.product) === product
    if (have && fits) {
      prices.set(want.lookupKey, have.id)
      continue
    }
    const made = await stripe.prices.create(
      {
        product,
        currency: catalog.currency,
        unit_amount: want.cents,
        recurring: { interval: want.interval, usage_type: 'licensed' },
        tax_behavior: 'exclusive',
        lookup_key: want.lookupKey,
        transfer_lookup_key: true,
        metadata: { linedesk: want.lookupKey },
      },
      {
        // The price the key moves away from is part of it (review L-2): A → B → A within Stripe's idempotency window
        // makes a new price that takes the key, instead of replaying A's old answer and leaving the key on B.
        idempotencyKey: `catalog:price:${want.lookupKey}:${product}:${catalog.currency}:${want.interval}:${want.cents}:from:${have?.id ?? 'none'}`,
      },
    )
    prices.set(want.lookupKey, made.id)
  }
  return prices
}

/** Ids no Stripe object has: a write to them is answered 403 without the permission, else 404, and changes nothing. */
export const PROBE_IDS = { product: 'linedesk_permission_probe', price: 'price_linedesk_permission_probe' } as const

/**
 * Whether the key may write Products and Prices (Server admin › Providers › Billing, Test; review M-1): an empty update
 * of an object that does not exist. Stripe checks a restricted key's permission first (403), then the object (404),
 * so nothing is ever written. `null`: the answer was neither (a network failure), not known.
 */
export async function catalogWriteAccess(
  stripe: Stripe,
): Promise<{ products: boolean | null; prices: boolean | null }> {
  const probe = async (write: () => Promise<unknown>) => {
    try {
      await write()
      return true
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 403 || status === 401) return false
      if (status === 404 || status === 400) return true
      return null
    }
  }
  return {
    products: await probe(() => stripe.products.update(PROBE_IDS.product, {})),
    prices: await probe(() => stripe.prices.update(PROBE_IDS.price, {})),
  }
}
