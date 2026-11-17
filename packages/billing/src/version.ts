/**
 * The Stripe API version every request and the pinned webhook endpoint use (docs/billing.md §5.1): the version this
 * SDK release is built for (the SDK constructor accepts only that one). Changing it is its own PR, with the SDK update
 * and a look at Stripe's upgrade notes. Its own module, so the API can name it without loading the SDK.
 */
export const STRIPE_API_VERSION = '2026-05-27.dahlia' as const
