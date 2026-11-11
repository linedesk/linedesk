// Outbound webhooks: endpoints a workspace's owners and admins add under Settings, Webhooks. Each
// event goes to every active endpoint that subscribed to it, signed with the endpoint's secret
// (apps/api/src/webhooks.ts).
import { webhookEvents } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

export { webhookEvents }

/** `whsec_` and 32 random bytes, base64url. Made by the client so the API never returns it (it is `sensitive`). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export const webhookSecretPattern = /^whsec_[A-Za-z0-9_-]{43,}$/

export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const base64 = btoa(String.fromCharCode(...bytes))
  return WEBHOOK_SECRET_PREFIX + base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const url = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .describe('Where the events are POSTed. https; http only for addresses the server allows (development).')
const events = z.array(z.enum(webhookEvents)).min(1)

export const webhookCreate = defineAction({
  name: 'webhook.create',
  description: 'Add a webhook endpoint: the events it receives and the secret its deliveries are signed with.',
  input: z.object({
    endpointId: z.string().min(1),
    url,
    events,
    secret: z.string().regex(webhookSecretPattern, 'a webhook secret is whsec_ and at least 32 random bytes'),
  }),
  permission: 'settings:write',
  sensitive: ['secret'],
})

export const webhookUpdate = defineAction({
  name: 'webhook.update',
  description: 'Change where an endpoint receives events, which ones, or switch it off and on (on again resets its failures).',
  input: z.object({
    endpointId: z.string().min(1),
    url: url.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  }),
  permission: 'settings:write',
  patch: {
    table: 'webhook_endpoints',
    id: i => i.endpointId,
    set: i => ({
      ...(i.url === undefined ? {} : { url: i.url }),
      ...(i.events === undefined ? {} : { events: i.events }),
      ...(i.enabled === undefined
        ? {}
        : i.enabled
          ? { status: 'active' as const, disabled_reason: null, failure_count: 0 }
          : { status: 'disabled' as const, disabled_reason: null }),
    }),
  },
})

export const webhookDelete = defineAction({
  name: 'webhook.delete',
  description: 'Remove a webhook endpoint and its delivery log.',
  input: z.object({ endpointId: z.string().min(1) }),
  permission: 'settings:write',
})

export const webhookTest = defineAction({
  name: 'webhook.test',
  description: 'Send a signed test event to an endpoint now and report its answer. Logged, never retried.',
  input: z.object({ endpointId: z.string().min(1) }),
  permission: 'settings:write',
  // Runs outside a transaction (the request may take seconds) and not as a command: it changes no
  // data, only adds to the endpoint's delivery log.
  readOnly: true,
})

export const webhookDeliveries = defineAction({
  name: 'webhook.deliveries',
  description: "An endpoint's most recent deliveries, newest first.",
  input: z.object({ endpointId: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
  permission: 'settings:write',
  readOnly: true,
})

/** `data` of webhook.test. */
export type WebhookTestData = { deliveryId: string; ok: boolean; responseStatus: number | null; error: string | null }

/** One row of `webhook.deliveries`. */
export type WebhookDeliverySummary = {
  id: string
  event: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  response_status: number | null
  error: string | null
  created_at: string
  last_attempt_at: string | null
}
export type WebhookDeliveriesData = { deliveries: WebhookDeliverySummary[] }
