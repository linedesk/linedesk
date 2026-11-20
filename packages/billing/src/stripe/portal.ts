// The customer portal configuration: one per Stripe account, marked `metadata.linedesk=portal`,
// made by the bootstrap script and kept to the design by the app's catalog sync and before every portal session. The
// design: invoices, cards and the customer's details; never a cancel or a plan change (those happen in the app only,
// security review of #1007, M-2). Shared by the adapter (./index.ts) and the bootstrap (./bootstrap.ts).
import type Stripe from 'stripe'
import { PORTAL_METADATA } from '../provider.ts'

/** What the customer may change in the portal: email, address, name, tax id. */
export const CUSTOMER_UPDATES = ['email', 'address', 'name', 'tax_id'] as const

/** Stripe's limit on the portal's headline. */
const HEADLINE_MAX = 60

/**
 * What the configuration should say. A link or headline left out (`undefined`) keeps what Stripe has; `null` for the
 * headline clears it. The terms and privacy links are never cleared from here: an install without TERMS_URL keeps the
 * links the bootstrap set.
 */
export type PortalWanted = {
  headline?: string | null
  termsUrl?: string | null
  privacyUrl?: string | null
  returnUrl?: string
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

const headlineOf = (headline: string | null | undefined) =>
  headline === undefined ? undefined : headline ? headline.slice(0, HEADLINE_MAX) : null

/** The features of the design: on are invoices, cards and the customer's details; off are cancel and plan changes. */
const FEATURES = {
  customer_update: { enabled: true, allowed_updates: [...CUSTOMER_UPDATES] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: false },
  subscription_update: { enabled: false },
}

/** The create or update parameters for the design. */
export function portalParams(wanted: PortalWanted) {
  const headline = headlineOf(wanted.headline)
  const business_profile = {
    ...(wanted.privacyUrl ? { privacy_policy_url: wanted.privacyUrl } : {}),
    ...(wanted.termsUrl ? { terms_of_service_url: wanted.termsUrl } : {}),
    // Stripe clears a headline with an empty string.
    ...(headline !== undefined ? { headline: headline ?? '' } : {}),
  }
  return {
    ...(Object.keys(business_profile).length ? { business_profile } : {}),
    // Not given: Stripe keeps what it has (security review of #866, N1).
    ...(wanted.returnUrl !== undefined ? { default_return_url: wanted.returnUrl } : {}),
    features: FEATURES,
    metadata: { ...PORTAL_METADATA },
  }
}

/** Whether a configuration offers anything the design keeps out: a cancel or a plan change. */
export const portalAllowsPlanChanges = (config: Stripe.BillingPortal.Configuration) =>
  config.features.subscription_cancel.enabled || config.features.subscription_update.enabled

/** Whether the configuration is the design, as far as `wanted` says it. */
export function portalFits(config: Stripe.BillingPortal.Configuration, wanted: PortalWanted) {
  const f = config.features
  const headline = headlineOf(wanted.headline)
  return (
    (!wanted.privacyUrl || config.business_profile.privacy_policy_url === wanted.privacyUrl) &&
    (!wanted.termsUrl || config.business_profile.terms_of_service_url === wanted.termsUrl) &&
    (headline === undefined || (config.business_profile.headline ?? null) === headline) &&
    (wanted.returnUrl === undefined || (config.default_return_url ?? '') === wanted.returnUrl) &&
    f.customer_update.enabled &&
    sameSet(f.customer_update.allowed_updates, CUSTOMER_UPDATES) &&
    f.invoice_history.enabled &&
    f.payment_method_update.enabled &&
    !portalAllowsPlanChanges(config)
  )
}

/** The active configuration marked as ours, read over every page; null: none. */
export async function findPortalConfiguration(stripe: Stripe): Promise<Stripe.BillingPortal.Configuration | null> {
  for await (const config of stripe.billingPortal.configurations.list({ limit: 100 }))
    if (config.active && config.metadata?.linedesk === PORTAL_METADATA.linedesk) return config
  return null
}
