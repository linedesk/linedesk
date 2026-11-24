// The install's catalog in its Stripe account (security review of #1040, M-1): the products and
// plan prices are made or updated when an instance admin saves the prices (Server admin › Billing) or the product name
// (› Branding), and when billing is turned on; never on a customer's Checkout. The price ids that sync answered are
// stored (`billing.catalog`) with the Stripe account they belong to, and Checkout sells exactly those. So a key that
// may only read Products and Prices never stops a sign-up or a purchase of minutes: the admin who saved hears at once
// (`catalogSyncAlert`), and Checkout keeps the prices of the last sync that worked. Only an install whose catalog was
// never synced for its account tries once at Checkout, and fails as a setup error the admins hear of.
import { BillingSetupError, type BillingProvider, type PlanCatalog } from '@linedesk/billing'
import { instance_settings, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingRules, planCatalog } from './billing-rules.ts'
import { billingProvider, boundAccount } from './billing-settings.ts'
import { brandName } from './branding.ts'
import { db } from './db.ts'
import { readLegalLinks } from './auth-methods.ts'
import { catalogSyncAlert, portalSyncAlert } from './emails/billing-alerts.ts'

/** The instance setting with the last catalog sync that worked (JSON `StoredCatalog`). */
export const BILLING_CATALOG_KEY = 'billing.catalog'

type StoredCatalog = {
  /** The bound Stripe account and mode (`acct_…:test`): a sync for another account is never used. */
  account: string
  /** The catalog it was made from (JSON; for a person reading the row): older than the settings while a save failed. */
  catalog: string
  /** Plan price ids by lookup key. */
  prices: Record<string, string>
  syncedAt: string
}

const accountKey = (binding: { id: string; mode: string } | null) => (binding ? `${binding.id}:${binding.mode}` : null)

async function readStored(tx: Pick<Tx, 'select'>): Promise<StoredCatalog | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, BILLING_CATALOG_KEY))
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as StoredCatalog
    return typeof parsed?.account === 'string' && parsed.prices && typeof parsed.prices === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The catalog the settings say now: the plan prices of the rules and the install's product name. */
export async function currentCatalog(tx: Pick<Tx, 'select'>): Promise<PlanCatalog> {
  return planCatalog(await billingRules(tx as Tx), brandName())
}

/** The synced price ids for the bound account, or null when this account was never synced. */
export async function syncedPrices(tx: Pick<Tx, 'select'>): Promise<Record<string, string> | null> {
  const stored = await readStored(tx)
  const account = accountKey(await boundAccount(tx))
  return stored && account && stored.account === account ? stored.prices : null
}

export type CatalogSync = { synced: true } | { synced: false; code: string } | { synced: 'skipped' }

/**
 * The customer portal kept to the design with the catalog: no cancel and no plan changes, the
 * install's name as its headline, the install's terms and privacy links when it has them. A refusal is told to the
 * instance admins and never stops the catalog; the portal session checks the features again before it opens.
 */
export async function syncBillingPortal(provider: BillingProvider) {
  try {
    const legal = readLegalLinks(process.env)
    const done = await provider.syncPortal({
      headline: brandName(),
      termsUrl: legal.terms,
      privacyUrl: legal.privacy,
    })
    if (done.changed)
      console.log(`billing: the customer portal configuration ${done.configuration} was set to the design`)
    return { synced: true as const }
  } catch (error) {
    const code =
      error instanceof BillingSetupError
        ? error.code
        : `stripe_${(error as { statusCode?: number }).statusCode ?? 'error'}`
    console.error(`billing: the customer portal could not be set up (${code})`)
    await alertInstanceAdmins(portalSyncAlert(code)).catch(e =>
      console.error('billing: the portal sync alert could not be sent:', e),
    )
    return { synced: false as const, code }
  }
}

/**
 * Makes the Stripe account sell what the settings say and stores the price ids. Skipped while billing is not in effect
 * (turning it on syncs). A refusal is told to every instance admin at once and answered, never thrown: the save that
 * triggered it stands.
 */
export async function syncBillingCatalog(provider?: BillingProvider): Promise<CatalogSync> {
  const using = provider ?? (await billingProvider(db))
  if (using.name === 'none') return { synced: 'skipped' }
  const catalog = await currentCatalog(db)
  const account = accountKey(await boundAccount(db))
  if (!account) return { synced: 'skipped' }
  try {
    const prices = await using.syncCatalog(catalog)
    const value: StoredCatalog = {
      account,
      catalog: JSON.stringify(catalog),
      prices,
      syncedAt: new Date().toISOString(),
    }
    const now = value.syncedAt
    await db
      .insert(instance_settings)
      .values({ key: BILLING_CATALOG_KEY, value: JSON.stringify(value), updated_at: now, updated_by: 'billing' })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: JSON.stringify(value), updated_at: now } })
    await syncBillingPortal(using)
    return { synced: true }
  } catch (error) {
    const code =
      error instanceof BillingSetupError
        ? error.code
        : `stripe_${(error as { statusCode?: number }).statusCode ?? 'error'}`
    console.error(`billing: the Stripe catalog could not be synced (${code})`)
    const before = await readStored(db).catch(() => null)
    await alertInstanceAdmins(catalogSyncAlert({ code, synced: before?.account === account })).catch(e =>
      console.error('billing: the catalog sync alert could not be sent:', e),
    )
    return { synced: false, code }
  }
}

/** Runs a sync after an admin's save committed, unless billing is off (then turning it on syncs). */
export function syncCatalogAfterCommit(onCommit: ((work: () => Promise<void>) => void) | undefined) {
  const run = async () => void (await syncBillingCatalog())
  if (onCommit) onCommit(run)
  else void run().catch(e => console.error('billing: catalog sync:', e))
}

/**
 * The plan price ids a Checkout sells: the last sync for this account. Never synced for it (a fresh install that
 * turned billing on while Stripe refused): one sync now, then a setup error if that failed too. A sync older than the
 * settings (a later save Stripe refused) is used as it is: the admins already heard why the newer prices are not in
 * Stripe.
 */
export async function pricesForCheckout(provider: BillingProvider): Promise<Record<string, string>> {
  const found = await syncedPrices(db)
  if (found) return found
  const sync = await syncBillingCatalog(provider)
  const again = sync.synced === true ? await syncedPrices(db) : null
  if (!again) throw new BillingSetupError('stripe_catalog_not_synced')
  return again
}
