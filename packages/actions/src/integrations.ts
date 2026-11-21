// Integrations that subscribe with a workspace API key (docs/api.md, Integrations; apps/api/src/integrations.ts):
// Zapier's REST hooks. An integration subscribes a URL on its own host to an event: a phone call starting
// (`call_started`), a during-call lookup the assistant asked (`during_call_lookup`) or a finished call
// (`call_finished`), each POSTed there in the matching webhook's shape, flattened a little for Zapier's field picker.
// Owners and admins see the subscriptions in Integrations › Zapier and can remove them; revoking the key
// removes them too.
import { z } from 'zod'
import { defineAction } from './define.ts'
import { callEndPayloadSchema, callerSchema, duringCallRequestSchema } from './webhooks.ts'

export const integrationSources = ['zapier'] as const
export type IntegrationSource = (typeof integrationSources)[number]
export const integrationEvents = ['call_finished', 'call_started', 'during_call_lookup'] as const
export type IntegrationEvent = (typeof integrationEvents)[number]

/**
 * The link to the Linedesk app on Zapier (integrations/zapier): one app for every install, Cloud and self-hosted; a
 * Zapier user names their install's address when they connect. While the app is not in Zapier's directory, this is
 * its invite link; after the listing, the app's page. Set per install in Server admin › Settings › Integrations (zapierApp.set,
 * instance_settings `zapier_app_url`); none by default, so an install without one shows no Zapier link.
 */
export const ZAPIER_APP_SETTING = 'zapier_app_url'
/** A link on Zapier's own site (zapier.com or a subdomain), https. */
export const zapierAppUrlSchema = z
  .url({ protocol: /^https$/, hostname: /^([a-z0-9-]+\.)*zapier\.com$/i })
  .max(500)
  .describe("The link to the Linedesk app on Zapier: its invite link, or its page in Zapier's directory.")
/** The host Zapier's REST hooks POST to: a self-hosted server must be able to reach it. */
export const ZAPIER_HOOKS_HOST = 'hooks.zapier.com'

/**
 * Whether Zapier's servers can reach an install at `origin`: an https address on the internet, not localhost or a
 * private address (Zapier calls the API from its own cloud).
 */
export function zapierCanReach(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:') return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return false
  return !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host)
}

/**
 * The hosts an integration's subscription may point at, per source. A leaked key can then send future calls only
 * to a URL on Zapier's own host (which still needs a Zap of the key holder's), never to any server it names.
 * WEBHOOK_ALLOW_PRIVATE_URLS=true (development) lifts it, like the webhooks' address rules.
 */
export const INTEGRATION_HOSTS: Record<IntegrationSource, readonly string[]> = { zapier: [ZAPIER_HOOKS_HOST] }
/** Subscriptions per workspace: one per Zap that uses a Linedesk trigger. */
export const INTEGRATION_SUBSCRIPTIONS_PER_WORKSPACE = 25
/** Most calls GET /v1/integrations/calls returns (Zapier's samples and dedupe need a few). */
export const INTEGRATION_SAMPLE_CALLS_MAX = 10

export const integrationSubscribe = defineAction({
  name: 'integration.subscribe',
  description:
    "Subscribe a URL on the integration's own host (Zapier: hooks.zapier.com) to an event: each event is POSTed to it as JSON (GET /v1/integrations/samples/<event> has the shape). API keys only. Returns the subscription id for integration.unsubscribe.",
  input: z.object({
    source: z.enum(integrationSources).default('zapier').describe('The integration: zapier.'),
    event: z
      .enum(integrationEvents)
      .describe(
        'call_started: a phone call came in and the assistant answers it. during_call_lookup: the assistant asked one of its during-call webhook lookups. call_finished: a phone call ended and was summarized.',
      ),
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
/** One subscription as Integrations › Zapier lists it: never the target URL (it is a capability for the Zap). */
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
/** `appUrl`: the link to the Linedesk app on Zapier (zapierApp.set); null while the install has none. */
export type IntegrationListData = { subscriptions: IntegrationSubscriptionSummary[]; appUrl: string | null }

export const zapierAppGet = defineAction({
  name: 'zapierApp.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    'Server admin: the link to the Linedesk app on Zapier that workspaces open to connect Zapier (null: none).',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const zapierAppSet = defineAction({
  name: 'zapierApp.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Server admin: set the link to the Linedesk app on Zapier (an https link on zapier.com: the app's invite link or its directory page), or null to show no Zapier link.",
  input: z.object({ url: zapierAppUrlSchema.nullable() }),
  permission: 'instance:admin',
})
/** `data` of `zapierApp.get` and `zapierApp.set`. */
export type ZapierAppData = { url: string | null }

export const integrationRemove = defineAction({
  name: 'integration.remove',
  description: 'Remove an integration subscription (Zapier): nothing more is sent to it. The Zap stops getting calls.',
  input: z.object({ subscriptionId: z.string().min(1) }).strict(),
  permission: 'settings:write',
})

const nullableText = z.string().nullable()
const callerFlat = {
  caller_name: nullableText,
  caller_company: nullableText,
  caller_email: nullableText,
  caller_contact_id: nullableText,
}
type Caller = z.infer<typeof callerSchema>
const flatCaller = (caller: Caller) => ({
  caller_name: caller?.name ?? null,
  caller_company: caller?.company ?? null,
  caller_email: caller?.email ?? null,
  caller_contact_id: caller?.contact_id ?? null,
})
const detailValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

/**
 * What an integration gets for a finished call (and GET /v1/integrations/calls lists): the after-call webhook's
 * payload (docs/webhooks.md) without `hook`, with `id` (the call's, Zapier dedupes on it), `event`, and the caller,
 * next steps and first booking also as flat fields, so a Zap can map them without digging into lists.
 */
export const integrationCallSchema = callEndPayloadSchema.omit({ hook: true }).extend({
  id: z.string().describe("The call's id (same as call_id)."),
  event: z.literal('call_finished'),
  ...callerFlat,
  next_steps_text: z.string().describe('The next steps, one per line.'),
  fields_text: z.string().describe('The facts the summary noted, one "Label: value" per line.'),
  booking_start_at: nullableText.describe("The first booking's start, ISO 8601 in UTC; null without one."),
  booking_end_at: nullableText,
  booking_title: nullableText,
})
export type IntegrationCall = z.infer<typeof integrationCallSchema>

/**
 * What an integration gets when a phone call comes in (`call_started`), a few seconds after it rings, so the
 * call-start webhook's caller details are in. Spam and calls that are not answered (busy, over the cap) send nothing.
 * `caller` only when the caller ID names the caller (the carrier vouched for it, or the owner turned that check off).
 */
export const integrationCallStartedSchema = z.object({
  id: z.string().describe("The call's id (same as call_id)."),
  event: z.literal('call_started'),
  call_id: z.string(),
  workspace_id: z.string(),
  assistant_id: nullableText,
  assistant_name: nullableText,
  from_number: z.string().describe('The caller. Not a number when they withheld it ("anonymous").'),
  to_number: z.string().describe('The business number they called.'),
  started_at: z.string(),
  caller: callerSchema,
  ...callerFlat,
  caller_verified: z.boolean().describe('False when the caller ID may be faked: `caller` is null then.'),
  caller_details: detailValues.nullable().describe('What the call-start webhook answered, if it did in time.'),
})
export type IntegrationCallStarted = z.infer<typeof integrationCallStartedSchema>

/**
 * What an integration gets after the assistant asked one of its during-call webhook's lookups
 * (`during_call_lookup`): the request the webhook got and its answer. `id` is the lookup's own (one per question).
 */
export const integrationLookupSchema = duringCallRequestSchema.omit({ hook: true, test: true }).extend({
  id: z.string().describe("The lookup's id: one per question the assistant asked."),
  event: z.literal('during_call_lookup'),
  ...callerFlat,
  values_text: z.string().describe('The values the caller gave, one "name: value" per line.'),
  answered: z.boolean().describe('True when the webhook answered in time; the assistant told the caller `answer`.'),
  answer: nullableText.describe("The webhook's answer; null when it failed or was too slow."),
  asked_at: z.string(),
})
export type IntegrationLookup = z.infer<typeof integrationLookupSchema>

/** One event as an integration gets it. */
export type IntegrationPayload = IntegrationCall | IntegrationCallStarted | IntegrationLookup

/** A during-call request and its answer, as an integration gets them (integrationLookupSchema). */
export function integrationLookup(
  id: string,
  request: z.infer<typeof duringCallRequestSchema>,
  answer: string | null,
  askedAt: string,
): IntegrationLookup {
  const { hook: _hook, test: _test, ...rest } = request
  return {
    id,
    event: 'during_call_lookup',
    ...rest,
    ...flatCaller(request.caller),
    values_text: Object.entries(request.values)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n'),
    answered: answer !== null,
    answer,
    asked_at: askedAt,
  }
}

/** The after-call payload as an integration gets it (integrationCallSchema). */
export function integrationCall(payload: z.infer<typeof callEndPayloadSchema>): IntegrationCall {
  const { hook: _hook, ...call } = payload
  const booking = payload.bookings[0] ?? null
  return {
    id: payload.call_id,
    event: 'call_finished',
    ...call,
    ...flatCaller(payload.caller),
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
