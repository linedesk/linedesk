// Integrations that subscribe with a workspace API key (docs/api.md, Integrations; apps/api/src/integrations.ts):
// Zapier's REST hooks. An integration subscribes a URL on its own host to an event, and each finished call is
// POSTed there in the after-call webhook's shape, flattened a little for Zapier's field picker. Owners and admins
// see the subscriptions in Workspace settings › Developers and can remove them; revoking the key removes them too.
import { z } from 'zod'
import { defineAction } from './define.ts'
import { callEndPayloadSchema } from './webhooks.ts'

export const integrationSources = ['zapier'] as const
export type IntegrationSource = (typeof integrationSources)[number]
export const integrationEvents = ['call_finished'] as const
export type IntegrationEvent = (typeof integrationEvents)[number]

/**
 * The hosts an integration's subscription may point at, per source. A leaked key can then send future calls only
 * to a URL on Zapier's own host (which still needs a Zap of the key holder's), never to any server it names.
 * WEBHOOK_ALLOW_PRIVATE_URLS=true (development) lifts it, like the webhooks' address rules.
 */
export const INTEGRATION_HOSTS: Record<IntegrationSource, readonly string[]> = { zapier: ['hooks.zapier.com'] }
/** Subscriptions per workspace: one per Zap that uses a Linedesk trigger. */
export const INTEGRATION_SUBSCRIPTIONS_PER_WORKSPACE = 25
/** Most calls GET /v1/integrations/calls returns (Zapier's samples and dedupe need a few). */
export const INTEGRATION_SAMPLE_CALLS_MAX = 10

export const integrationSubscribe = defineAction({
  name: 'integration.subscribe',
  description:
    "Subscribe a URL on the integration's own host (Zapier: hooks.zapier.com) to an event: each finished phone call is POSTed to it as JSON (GET /v1/integrations/calls has the shape). API keys only. Returns the subscription id for integration.unsubscribe.",
  input: z.object({
    source: z.enum(integrationSources).default('zapier').describe('The integration: zapier.'),
    event: z.enum(integrationEvents).describe('call_finished: a phone call ended and was summarized.'),
    targetUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .describe("Where the events are POSTed: an https URL on the source's host."),
  }),
  permission: 'call:read',
  public: true,
  // The hook URL is the Zap's capability: the command log keeps it redacted.
  sensitive: ['targetUrl'],
})
/** `data` of integration.subscribe. */
export type IntegrationSubscribed = { subscriptionId: string }

export const integrationUnsubscribe = defineAction({
  name: 'integration.unsubscribe',
  description:
    'End a subscription made with integration.subscribe: nothing more is sent to its URL. API keys only. A subscription that is gone already is no error (`removed: false`).',
  input: z.object({ subscriptionId: z.string().min(1).max(100) }),
  permission: 'call:read',
  public: true,
})
/** `data` of integration.unsubscribe. */
export type IntegrationUnsubscribed = { subscriptionId: string; removed: boolean }

export const integrationList = defineAction({
  name: 'integration.list',
  description: "The workspace's integration subscriptions (Zapier), with the key that made each.",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})
/** One subscription as Workspace settings › Developers lists it: never the target URL (it is a capability for the Zap). */
export type IntegrationSubscriptionSummary = {
  id: string
  source: IntegrationSource
  event: IntegrationEvent
  status: 'active' | 'disabled'
  disabled_reason: string | null
  created_at: string
  last_delivery_at: string | null
  api_key_id: string
  api_key_name: string
  api_key_prefix: string
}
export type IntegrationListData = { subscriptions: IntegrationSubscriptionSummary[] }

export const integrationRemove = defineAction({
  name: 'integration.remove',
  description: 'Remove an integration subscription (Zapier): nothing more is sent to it. The Zap stops getting calls.',
  input: z.object({ subscriptionId: z.string().min(1) }),
  permission: 'settings:write',
})

const nullableText = z.string().nullable()

/**
 * What an integration gets for a finished call (and GET /v1/integrations/calls lists): the after-call webhook's
 * payload (docs/webhooks.md) without `hook`, with `id` (the call's, Zapier dedupes on it), `event`, and the caller,
 * next steps and first booking also as flat fields, so a Zap can map them without digging into lists.
 */
export const integrationCallSchema = callEndPayloadSchema.omit({ hook: true }).extend({
  id: z.string().describe("The call's id (same as call_id)."),
  event: z.literal('call_finished'),
  caller_name: nullableText,
  caller_company: nullableText,
  caller_email: nullableText,
  caller_contact_id: nullableText,
  next_steps_text: z.string().describe('The next steps, one per line.'),
  fields_text: z.string().describe('The facts the summary noted, one "Label: value" per line.'),
  booking_start_at: nullableText.describe("The first booking's start, ISO 8601 in UTC; null without one."),
  booking_end_at: nullableText,
  booking_title: nullableText,
})
export type IntegrationCall = z.infer<typeof integrationCallSchema>

/** The after-call payload as an integration gets it (integrationCallSchema). */
export function integrationCall(payload: z.infer<typeof callEndPayloadSchema>): IntegrationCall {
  const { hook: _hook, ...call } = payload
  const booking = payload.bookings[0] ?? null
  return {
    id: payload.call_id,
    event: 'call_finished',
    ...call,
    caller_name: payload.caller?.name ?? null,
    caller_company: payload.caller?.company ?? null,
    caller_email: payload.caller?.email ?? null,
    caller_contact_id: payload.caller?.contact_id ?? null,
    next_steps_text: payload.next_steps.map(s => s.text).join('\n'),
    fields_text: payload.fields.map(f => `${f.label}: ${f.value}`).join('\n'),
    booking_start_at: booking?.start_at ?? null,
    booking_end_at: booking?.end_at ?? null,
    booking_title: booking?.title ?? null,
  }
}

/** Why a subscription may not point at `url`, or null. Only the source's own hosts (INTEGRATION_HOSTS), https. */
export function integrationUrlProblem(source: IntegrationSource, url: string, allowAny = false): string | null {
  if (allowAny) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'not a URL'
  }
  if (parsed.protocol !== 'https:') return 'Use an https address.'
  if (!INTEGRATION_HOSTS[source].includes(parsed.hostname.toLowerCase()))
    return `A ${source} subscription must point at ${INTEGRATION_HOSTS[source].join(' or ')}.`
  if (parsed.username || parsed.password) return 'The address may not carry a user name or password.'
  return null
}
