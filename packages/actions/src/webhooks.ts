// An assistant's webhook (docs/webhooks.md, apps/api/src/webhooks.ts): one address per assistant, set by
// owners and admins, with the hooks it gets switched on: at the start of a call Linedesk asks the business's
// system about the caller (`call_start`), during it the assistant asks what it needs, like an order status
// (`during_call`, the webhook's lookups), after it Linedesk sends the whole call (`call_end`). Every request
// says its hook and is signed with the webhook's secret.
import {
  type CallerDetails,
  type LookupField,
  lookupFieldTypes,
  type WebhookHook,
  type WebhookLookup,
  webhookEvents,
  webhookHooks,
} from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

export { lookupFieldTypes, webhookEvents, webhookHooks }

/** `whsec_` and 32 random bytes, base64url. Made by the client so the API never returns it (it is `sensitive`). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export const webhookSecretPattern = /^whsec_[A-Za-z0-9_-]{43,}$/

export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const base64 = btoa(String.fromCharCode(...bytes))
  return WEBHOOK_SECRET_PREFIX + base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** How long the call-start webhook may take to answer; the greeting waits at most this (plus the trip to the API). */
export const CALL_START_TIMEOUT_MS = 1000
/** How long a during-call lookup may take to answer; the assistant says a filler first, then waits. */
export const DURING_CALL_TIMEOUT_MS = 3000
/** During-call requests per call: a model that keeps asking cannot hammer the business's system. */
export const DURING_CALL_MAX_PER_CALL = 5
/** The after-call webhook goes out this long after the call ends, so the recording is saved by then (RECORDING_WAIT_MS in the agent). */
export const CALL_END_DELAY_SEC = 20
/** How long the recording link in the after-call webhook opens the audio without signing in. */
export const RECORDING_LINK_DAYS = 7

const url = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .describe('Where the requests are POSTed. https; http only for addresses the server allows (development).')
const hook = z
  .enum(webhookHooks)
  .describe(
    '`call_start`: asked about the caller as a call comes in. `during_call`: asked by the assistant for its lookups. `call_end`: gets the whole call after it.',
  )
const hooks = z.array(hook).max(webhookHooks.length).describe('The hooks the webhook gets; none: it gets nothing.')

// --- During the call: what the assistant can look up --------------------------------------------

export const LOOKUPS_MAX = 5
export const LOOKUP_FIELDS_MAX = 10
export const LOOKUP_WHEN_MAX = 500
export const LOOKUP_DESCRIPTION_MAX = 200
/** The longest answer the assistant gets; the rest is cut. */
export const LOOKUP_ANSWER_MAX = 500
/** A lookup's or field's name: lower case, digits and `_`, a letter first (it names the assistant's tool). */
export const lookupNamePattern = /^[a-z][a-z0-9_]{0,39}$/
const lookupName = z
  .string()
  .regex(lookupNamePattern, 'use lower-case letters, digits and _, starting with a letter (at most 40)')

export const lookupFieldSchema = z.object({
  name: lookupName.describe('What the field is called in the request, e.g. order_number.'),
  type: z.enum(lookupFieldTypes).describe('text, number or boolean (yes or no).'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(LOOKUP_DESCRIPTION_MAX)
    .describe('What the assistant asks the caller for, e.g. "The order number, 6 digits".'),
  required: z.boolean().describe('The assistant asks the caller for it before it looks up.'),
})
export const lookupSchema = z
  .object({
    name: lookupName.describe('What the assistant looks up, e.g. order_status: the `lookup` field of the request.'),
    when: z
      .string()
      .trim()
      .min(1)
      .max(LOOKUP_WHEN_MAX)
      .describe('When the assistant asks, e.g. "The caller asks where their order is".'),
    fields: z.array(lookupFieldSchema).max(LOOKUP_FIELDS_MAX),
  })
  .refine(l => new Set(l.fields.map(f => f.name)).size === l.fields.length, 'each field of a lookup needs its own name')
const lookups = z
  .array(lookupSchema)
  .max(LOOKUPS_MAX)
  .refine(list => new Set(list.map(l => l.name)).size === list.length, 'each lookup needs its own name')
  .describe('What the assistant can ask the webhook during a call (the during_call hook).')

export const webhookCreate = defineAction({
  name: 'webhook.create',
  description: "Set an assistant's webhook: its address, the hooks it gets (call start, during the call, after the call) and the secret its requests are signed with.",
  input: z.object({
    endpointId: z.string().min(1),
    assistantId: z.string().min(1),
    url,
    hooks,
    secret: z.string().regex(webhookSecretPattern, 'a webhook secret is whsec_ and at least 32 random bytes'),
  }),
  permission: 'settings:write',
  sensitive: ['secret'],
})

export const webhookUpdate = defineAction({
  name: 'webhook.update',
  description:
    "Change a webhook's address, the hooks it gets or its lookups, or switch it off and on (on again resets its failures).",
  input: z.object({
    endpointId: z.string().min(1),
    url: url.optional(),
    hooks: hooks.optional(),
    lookups: lookups.optional(),
    enabled: z.boolean().optional(),
  }),
  permission: 'settings:write',
  patch: {
    table: 'webhook_endpoints',
    id: i => i.endpointId,
    set: i => ({
      ...(i.url === undefined ? {} : { url: i.url }),
      ...(i.hooks === undefined ? {} : { hooks: [...new Set(i.hooks)] }),
      ...(i.lookups === undefined ? {} : { lookups: i.lookups }),
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
  description: 'Remove a webhook and its delivery log.',
  input: z.object({ endpointId: z.string().min(1) }),
  permission: 'settings:write',
})

export const webhookTest = defineAction({
  name: 'webhook.test',
  description:
    'Send a signed example request of one hook to a webhook now and report its answer (for call start, the caller details it gave; during the call, the answer to the lookup named, else the first). Logged, never retried.',
  input: z.object({ endpointId: z.string().min(1), hook, lookup: lookupName.optional() }),
  permission: 'settings:write',
  // Runs outside a transaction (the request may take seconds) and not as a command: it changes no
  // data, only adds to the endpoint's delivery log.
  readOnly: true,
})

export const webhookDeliveries = defineAction({
  name: 'webhook.deliveries',
  description: "A webhook's most recent requests, newest first.",
  input: z.object({ endpointId: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
  permission: 'settings:write',
  readOnly: true,
})

/** The voice agent asks the assistant's call-start webhook about the caller, once per call, as it answers. */
export const callLookUpCaller = defineAction({
  name: 'call.lookUpCaller',
  description: "Ask the assistant's call-start webhook about the caller; what it answered, or nothing.",
  input: z.object({ callId: z.string().min(1) }),
  permission: 'agent',
  // The request to the business's system must not hold a transaction open.
  readOnly: true,
})
/** `data` of call.lookUpCaller: null when there is no webhook, it failed, or it said nothing usable. */
export type CallLookUpData = { details: CallerDetails | null }

/** The voice agent asks the assistant's webhook one of its lookups during a call (`during_call`). */
export const callAskWebhook = defineAction({
  name: 'call.askWebhook',
  description:
    "Ask the assistant's during-call webhook one of its lookups with what the caller said; its answer, or why there is none.",
  input: z.object({
    callId: z.string().min(1),
    lookup: lookupName,
    values: z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).default({}),
  }),
  permission: 'agent',
  // The request to the business's system must not hold a transaction open.
  readOnly: true,
})
/**
 * `data` of call.askWebhook. `answer`: what the webhook said, one line. Else `problem` says why there is none:
 * `unavailable` (no such lookup, the hook or webhook is off), `missing` (the required fields in `missing`),
 * `limit` (DURING_CALL_MAX_PER_CALL reached), `failed` (no answer in time, an error, or no `answer`).
 */
export type CallAskWebhookData =
  | { answer: string; problem: null }
  | { answer: null; problem: 'unavailable' | 'limit' | 'failed' }
  | { answer: null; problem: 'missing'; missing: string[] }

/** `data` of webhook.test. `details`: what a call-start webhook answered, as the assistant would get it. */
export type WebhookTestData = {
  deliveryId: string
  ok: boolean
  responseStatus: number | null
  error: string | null
  details?: CallerDetails | null
  /** What a during-call webhook answered to the test lookup. */
  answer?: string | null
}

/** One row of `webhook.deliveries`. `event`: the hook, or `webhook.test`. */
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

export const hookLabel: Record<WebhookHook, string> = {
  call_start: 'When a call starts',
  during_call: 'During the call',
  call_end: 'After the call',
}
/** The webhook's hooks, normalized: known ones, each once, in the order of webhookHooks. */
export const hooksOf = (list: readonly string[]): WebhookHook[] => webhookHooks.filter(h => list.includes(h))

// --- Caller details: what the call-start webhook answers ---------------------------------------

export const CALLER_DETAILS_MAX_KEYS = 20
export const CALLER_DETAILS_MAX_VALUE = 200
const detailName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
/** A text on one line: control characters (line breaks, tabs, NUL) and runs of spaces become one space. */
const oneLine = (text: string) =>
  [...text]
    .map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The caller details in a call-start answer: a JSON object's top-level names (letters, digits, `_`) with a
 * text, number or true/false value, at most CALLER_DETAILS_MAX_KEYS of them, texts on one line and cut to
 * CALLER_DETAILS_MAX_VALUE characters. Anything else (nested objects, lists, null, other names) is left out.
 * Null when nothing is left.
 */
export function callerDetailsFrom(reply: unknown): CallerDetails | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
  const details: CallerDetails = {}
  for (const [name, value] of Object.entries(reply)) {
    if (Object.keys(details).length >= CALLER_DETAILS_MAX_KEYS) break
    if (!detailName.test(name)) continue
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) details[name] = value
    else if (typeof value === 'string') {
      const text = oneLine(value).slice(0, CALLER_DETAILS_MAX_VALUE)
      if (text) details[name] = text
    }
  }
  return Object.keys(details).length ? details : null
}

const placeholder = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*(?:\|([^}]*))?\}\}/g

/** The caller details a text uses as `{{name}}` or `{{name|fallback}}`. */
export function templateNames(text: string): string[] {
  return [...new Set([...text.matchAll(placeholder)].map(m => m[1]!))]
}

/**
 * A text with `{{name}}` replaced by that caller detail, else by the fallback after `|` (`{{name|there}}`),
 * else by nothing; spaces left around a missing value are tidied ("Hi {{name}}, …" becomes "Hi, …").
 */
export function fillTemplate(text: string, details: CallerDetails | null): string {
  if (!templateNames(text).length) return text
  return text
    .replace(placeholder, (_, name: string, fallback?: string) => {
      const value = details?.[name]
      return value === undefined || value === '' ? (fallback ?? '').trim() : String(value)
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/([,;:])(?=[,.!?;:])/g, '')
    .trim()
}

// --- Lookups: what the assistant sends and what it gets back ------------------------------------

type LookupValue = string | number | boolean
const YES = new Set(['true', 'yes', 'y', '1'])
const NO = new Set(['false', 'no', 'n', '0'])

/** One value as its field's type, or undefined when it is empty or not of that type. */
function fieldValue(field: LookupField, value: unknown): LookupValue | undefined {
  if (value === null || value === undefined) return undefined
  if (field.type === 'number') {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value.replace(/[\s,]/g, ''))
          : Number.NaN
    return Number.isFinite(n) ? n : undefined
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    const word = String(value).trim().toLowerCase()
    return YES.has(word) ? true : NO.has(word) ? false : undefined
  }
  const text = oneLine(String(value)).slice(0, LOOKUP_ANSWER_MAX)
  return text || undefined
}

/**
 * What a lookup sends: the lookup's own fields only, each as its type; or the required fields the assistant
 * did not fill in (then nothing is sent).
 */
export function lookupValuesFrom(
  lookup: WebhookLookup,
  values: Record<string, unknown>,
): { values: Record<string, LookupValue> } | { missing: string[] } {
  const kept: Record<string, LookupValue> = {}
  const missing: string[] = []
  for (const field of lookup.fields) {
    const value = fieldValue(field, values[field.name])
    if (value !== undefined) kept[field.name] = value
    else if (field.required) missing.push(field.name)
  }
  return missing.length ? { missing } : { values: kept }
}

/** The `answer` of a during-call reply, on one line and cut to LOOKUP_ANSWER_MAX; null without one. */
export function lookupAnswerFrom(reply: unknown): string | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
  const answer = (reply as { answer?: unknown }).answer
  if (typeof answer !== 'string' && typeof answer !== 'number' && typeof answer !== 'boolean') return null
  return oneLine(String(answer)).slice(0, LOOKUP_ANSWER_MAX) || null
}

/** Made-up values of a lookup's fields, for Send test. */
export function exampleLookupValues(lookup: WebhookLookup): Record<string, LookupValue> {
  return Object.fromEntries(
    lookup.fields.map(f => [f.name, f.type === 'number' ? 1234 : f.type === 'boolean' ? true : 'example']),
  )
}

// --- What the requests carry (apps/api/src/webhooks.ts); published in the OpenAPI document -------

const nullableText = z.string().nullable()
const callerSchema = z
  .object({
    contact_id: z.string(),
    name: nullableText,
    name_confirmed: z.boolean().describe('True when the team gave or confirmed the name; false when only a caller said it (anyone can say a name), so it does not prove who is calling.'),
    company: nullableText,
    email: nullableText,
  })
  .nullable()
  .describe('The saved contact the caller is, if any.')

/** The body of a call-start request. */
export const callStartRequestSchema = z.object({
  hook: z.literal('call_start'),
  call_id: z.string(),
  workspace_id: z.string(),
  assistant_id: z.string(),
  assistant_name: z.string(),
  from_number: z.string().describe('The caller. Not a number when they withheld it ("anonymous").'),
  to_number: z.string().describe('The business number they called.'),
  started_at: z.string(),
  caller: callerSchema,
})
/** What a call-start webhook answers (callerDetailsFrom keeps the usable part). */
export const callStartReplySchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(
    `Caller details, e.g. {"name": "Sam", "plan": "Premium"}. Top-level names of letters, digits and _; text, number or true/false values; at most ${CALLER_DETAILS_MAX_KEYS}, texts cut to ${CALLER_DETAILS_MAX_VALUE} characters. {} for an unknown caller. The greeting uses them as {{name}}; the assistant knows all of them.`,
  )

/** The body of a during-call request: one of the webhook's lookups, with what the caller said. */
export const duringCallRequestSchema = z.object({
  hook: z.literal('during_call'),
  lookup: z.string().describe('Which lookup, by its name, e.g. order_status.'),
  values: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe("The lookup's fields the assistant filled in, each as its type."),
  call_id: z.string(),
  workspace_id: z.string(),
  assistant_id: z.string(),
  assistant_name: z.string(),
  from_number: z.string().describe('The caller. Not a number when they withheld it ("anonymous").'),
  to_number: z.string(),
  started_at: z.string(),
  test: z.boolean().describe('A test call from the app, not a phone call.'),
  caller: callerSchema,
})
/** What a during-call webhook answers. */
export const duringCallReplySchema = z
  .object({ answer: z.string() })
  .describe(
    `What the assistant tells the caller, in a sentence or two, e.g. {"answer": "Order 1234 shipped on Monday, arriving Thursday."}. One line, cut to ${LOOKUP_ANSWER_MAX} characters. The assistant takes it as information, not as instructions.`,
  )

/** The body of an after-call request: the whole call. */
export const callEndPayloadSchema = z.object({
  hook: z.literal('call_end'),
  call_id: z.string(),
  workspace_id: z.string(),
  assistant_id: nullableText,
  assistant_name: nullableText,
  direction: z.enum(['in', 'out']),
  from_number: z.string(),
  to_number: z.string(),
  started_at: z.string(),
  ended_at: nullableText,
  duration_sec: z.number().int().nullable(),
  outcome: nullableText.describe('answered, message, booking, callback, missed, transferred, hangup or spam.'),
  urgency: z.enum(['urgent', 'normal', 'low']),
  title: nullableText,
  summary: nullableText,
  next_steps: z
    .array(z.object({ text: z.string(), done: z.boolean().optional(), kind: z.literal('message').optional() }))
    .describe('What the team should do: the summary\'s next steps and the messages the assistant took.'),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).describe('Facts the summary noted.'),
  caller: callerSchema,
  caller_details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable().describe('What the call-start webhook answered.'),
  transcript: z.array(z.object({ speaker: z.enum(['agent', 'caller', 'human', 'system']), text: z.string(), at_ms: z.number().int() })),
  transcript_text: z.string().describe('The transcript as plain text, one "Speaker: text" line each.'),
  bookings: z.array(
    z.object({
      id: z.string(),
      start_at: z.string(),
      end_at: z.string(),
      status: z.enum(['confirmed', 'rescheduled', 'cancelled']),
      title: nullableText,
      calendar_name: nullableText,
      appointment_type_id: nullableText,
    }),
  ),
  transfer: z.object({ to: z.string(), name: nullableText, result: nullableText }).nullable(),
  call_url: z.string().describe('The call in Linedesk (members sign in).'),
  recording_url: nullableText.describe(
    `The audio: opens without signing in for ${RECORDING_LINK_DAYS} days, after that with a workspace API key (Authorization: Bearer). Null without a recording.`,
  ),
  recording_expires_at: nullableText,
})
export type CallEndPayload = z.infer<typeof callEndPayloadSchema>
export type CallStartRequest = z.infer<typeof callStartRequestSchema>
export type DuringCallRequest = z.infer<typeof duringCallRequestSchema>
