// POST /v1/billing/stripe/webhook: the only billing route outside the registry, and it changes
// nothing by itself. It checks Stripe's signature over the raw body (the signing secret and, during a rotation, the
// previous one; 300 s tolerance; the key's mode), stores the event with its job in one transaction and answers 200.
// The job (stripe-events.ts) does the rest. No session, no cookie, no CSRF check (it carries no ambient credential);
// at most 512 KB. The body is never logged: only the event's id and type.
//
// A delivery whose signature verifies is never refused (security review of #865, H1): Stripe sends every account's
// webhooks from the same few addresses, so a block per address would let anyone with a Stripe account lock ours out.
// What an unsigned request costs is kept small instead (L3): a header that is not Stripe's shape is refused before
// anything is read, the provider (keys, switch) is cached, and checking the signature is one HMAC.
import { STRIPE_API_VERSION, type WebhookRefusal, WebhookRefused } from '@linedesk/billing'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { webhookBillingProvider } from './billing-settings.ts'
import { db } from './db.ts'
import { storeStripeEvent } from './stripe-events.ts'

/** The answer Stripe's Dashboard shows for a refused delivery (no detail beyond the kind). */
const REFUSAL_ERROR: Record<WebhookRefusal, string> = {
  signature: 'bad signature',
  livemode: 'wrong mode',
}

export const STRIPE_WEBHOOK_PATH = '/v1/billing/stripe/webhook'
/** Stripe's events are a few KB; the largest (an invoice with many lines) stays far below this. */
export const STRIPE_WEBHOOK_MAX_BYTES = 512 * 1024

/** Stripe's header: `t=<unix>` and at least one `v1=<64 hex>`, comma separated, nothing very long. */
const SIGNATURE_SHAPE = /^(?=.*(?:^|,)t=\d{1,12}(?:,|$))(?=.*(?:^|,)v1=[0-9a-f]{64}(?:,|$))[\w=,]{1,1024}$/

/** Refused deliveries are logged at most once a minute, with how many there were (a flood never fills the log). */
const REFUSED_LOG_MS = 60_000
const refusedLog = { at: 0, count: 0 }
function logRefused(reason: string, now = Date.now()) {
  refusedLog.count++
  if (now - refusedLog.at < REFUSED_LOG_MS) return
  console.warn(`billing: ${refusedLog.count} Stripe webhook deliveries refused since the last note (latest: ${reason})`)
  refusedLog.at = now
  refusedLog.count = 0
}

/**
 * An event in another API version than the adapter's is taken (only version-proof fields are
 * read, every object is fetched again at the pinned version). Noted once an hour per version, so an endpoint that is
 * not pinned (made by hand, `stripe listen`) is visible in the log without filling it.
 */
const VERSION_NOTE_MS = 60 * 60_000
const versionNotes = new Map<string, number>()
function noteVersion(version: string | null | undefined, now = Date.now()) {
  if (!version || version === STRIPE_API_VERSION) return
  if (now - (versionNotes.get(version) ?? 0) < VERSION_NOTE_MS) return
  versionNotes.set(version, now)
  console.warn(
    `billing: Stripe webhook events come in API version ${version}, not ${STRIPE_API_VERSION}: taken (only version-proof fields are read); pin the endpoint with the bootstrap script`,
  )
}

/** Forgets the log throttle (tests). */
export function resetStripeWebhookLimits() {
  refusedLog.at = 0
  refusedLog.count = 0
  versionNotes.clear()
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerStripeWebhookRoute(app: Hono<any>) {
  app.post(
    STRIPE_WEBHOOK_PATH,
    bodyLimit({
      maxSize: STRIPE_WEBHOOK_MAX_BYTES,
      onError: c => c.json({ ok: false, error: 'request too large' }, 413),
    }),
    async c => {
      const signature = c.req.header('stripe-signature')
      if (!signature) return c.json({ ok: false, error: 'missing signature' }, 400)
      if (!SIGNATURE_SHAPE.test(signature)) {
        logRefused('malformed signature header')
        return c.json({ ok: false, error: REFUSAL_ERROR.signature }, 400)
      }
      // Billing off (every self-hosted install): the route does not exist.
      const provider = await webhookBillingProvider()
      if (provider.name === 'none') return c.json({ ok: false, error: 'not found' }, 404)
      const raw = new Uint8Array(await c.req.arrayBuffer())
      let event: ReturnType<typeof provider.webhookEvent>
      try {
        event = provider.webhookEvent(raw, signature)
      } catch (error) {
        if (!(error instanceof WebhookRefused)) throw error
        logRefused(error.reason)
        return c.json({ ok: false, error: REFUSAL_ERROR[error.reason] }, 400)
      }
      noteVersion(event.apiVersion)
      const outcome = await db.transaction(tx => storeStripeEvent(tx, event, new Date().toISOString()))
      if (outcome !== 'duplicate' && outcome !== 'foreign')
        console.log(`billing: Stripe event ${event.id} (${event.type}) ${outcome}`)
      return c.json({ ok: true })
    },
  )
}
