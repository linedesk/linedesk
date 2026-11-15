import type { KeyMode } from './provider.ts'

/**
 * Stripe secret keys (`sk_…`) and restricted keys (`rk_…`, recommended: only the permissions billing needs). The
 * mode is part of the key: `sk_test_`/`rk_test_` charge nothing, `sk_live_`/`rk_live_` charge real cards.
 */
const STRIPE_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/

/** The mode of a Stripe secret or restricted key; null for anything else (a publishable key, a typo). */
export function stripeKeyMode(key: string): KeyMode | null {
  const match = STRIPE_KEY.exec(key.trim())
  return match ? (match[2] as KeyMode) : null
}

/** A webhook signing secret from the Stripe Dashboard or `stripe listen`. */
export const isStripeWebhookSecret = (secret: string) => /^whsec_[A-Za-z0-9]+$/.test(secret.trim())

/**
 * Whether an install may hold a live key: only when its operator says so in the server's environment
 * (`BILLING_LIVE_KEYS=1`, set on production only) and never in dev mode (`LINEDESK_MODE=dev`). Staging, a local
 * image and every self-hosted install refuse live keys by default, so no real card is charged from them.
 */
export const liveKeysAllowed = (env: Record<string, string | undefined>) =>
  env.BILLING_LIVE_KEYS === '1' && env.LINEDESK_MODE !== 'dev'

/** Why a live key is refused, wherever it is (stored, tested, switched on). */
export const LIVE_KEYS_REFUSED =
  'Live Stripe keys are refused on this install: they would charge real cards. Use a test key (sk_test_… or rk_test_…). Production allows them with BILLING_LIVE_KEYS=1 in its server environment.'
