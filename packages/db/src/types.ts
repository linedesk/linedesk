// Row types shared with the browser. Type-only: importing this never pulls in pg or drizzle.
import type {
  api_keys,
  appointment_types,
  assistant_calendars,
  assistants,
  availability_exceptions,
  availability_rules,
  bookings,
  calendar_connections,
  calls,
  contacts,
  knowledge_questions,
  phone_numbers,
  transcript_segments,
  webhook_endpoints,
  workspace_settings,
  workspace_members,
  call_events,
  integration_subscriptions,
  app_connections,
} from './schema.ts'

/** `kind: 'message'`: a message saved during the call (call.takeMessage: a transfer nobody took), counted for MESSAGES_PER_CALL. */
export type ActionItem = { text: string; done?: boolean; kind?: 'message' }
export type CallField = { label: string; value: string }
/**
 * A stage of the voice pipeline that failed on the call (call.reportVoiceFailure, VoiceFailure in @linedesk/actions),
 * with when it was reported. `stage`: stt, llm, tts or realtime; `reason`: quota, auth, not_found, no_output, timeout
 * or unknown.
 */
export type CallVoiceFailure = { stage: string; provider: string; reason: string; message: string; at: string }
export type ToolEvent = { tool: string; label: string }
/** Booking details an appointment type can require on top of the caller's name and the reason. */
export type BookingField = 'phone' | 'email' | 'address'
/** @deprecated the events of workspace-wide webhooks, before they were per assistant (webhook_endpoints.events). */
export const webhookEvents = ['call.completed', 'call.summary_ready', 'booking.created', 'message.taken'] as const
export type WebhookEvent = (typeof webhookEvents)[number]
/**
 * What an assistant's webhook gets (apps/api/src/webhooks.ts): `call_start` is asked about the caller when a
 * call comes in, `during_call` is asked by the assistant when it needs something from the business's system
 * (its lookups), `call_end` gets the whole call once it is over.
 */
export const webhookHooks = ['call_start', 'during_call', 'call_end'] as const
export type WebhookHook = (typeof webhookHooks)[number]
/** The kinds of value a during-call lookup's field takes. */
export const lookupFieldTypes = ['text', 'number', 'boolean'] as const
export type LookupFieldType = (typeof lookupFieldTypes)[number]
/** Something the assistant fills in for a lookup, e.g. the order number. */
export type LookupField = { name: string; type: LookupFieldType; description: string; required: boolean }
/**
 * Something the assistant can ask the business's system during a call (`during_call`), e.g. `order_status`:
 * `when` says when to ask, `fields` what to send. LOOKUP_* limits in @linedesk/actions.
 */
export type WebhookLookup = { name: string; when: string; fields: LookupField[] }
/** What the call-start webhook answered: flat names and short values (CALLER_DETAILS_* in @linedesk/actions). */
export type CallerDetails = Record<string, string | number | boolean>
/**
 * One rule of an assistant's call emails (assistants.email_rules, LIN-470): `name` ("Water heaters & boilers"), `when`
 * (the calls it is about, in plain words), `to` (member user ids who get the email) and `assign` (one of `to` who gets
 * the call assigned, or null). A language model only matches the topics; the code picks recipients and assignee.
 */
export type EmailRule = { id: string; when: string; to: string[]; assign: string | null }
/** An assistant's call emails: `always` (member user ids who get every call email) and the rules, in order. */
export type EmailRules = { always: string[]; rules: EmailRule[] }
/** One recipient of a call email (EmailRoute.to): a workspace member, or a confirmed outside address. */
export type EmailRouteRecipient = { kind: 'member'; user_id: string; name: string } | { kind: 'outside'; email: string }
/**
 * Who got the email about a finished call and why (call-notifications.ts, email routing). `routed`: the assistant's
 * call email rules picked `to` (`rules`: the topics (`when`) of the rules that fit, as they were then; older calls: an
 * instruction picked it and there are none); `fallback`: they could not (`problem`), so the members with call emails
 * on got it.
 */
export type EmailRoute = {
  mode: 'routed' | 'fallback'
  to: EmailRouteRecipient[]
  /** The topics (`when`) of the rules that fit the call, in list order; [] when none fit and it went to `always` only. */
  rules?: string[]
  /** One short sentence in the workspace's language from the language model; null in fallback mode. */
  reason: string | null
  /** The member the routing assigned the call to; null: it assigned nobody. */
  assigned_user_id: string | null
  at: string
  problem?: 'llm_failed' | 'no_llm' | 'nothing_fit'
}
/**
 * The assistant's voice: provider and voice id ('' the default voice), and `model`, the text-to-speech model
 * (VOICE_MODEL_LEVELS in @linedesk/actions); missing or '': the install's model.
 */
export type AssistantVoice = { provider: string; voice_id: string; model?: string }
/** What happens when the transfer contact does not take the call. */
/** When nobody accepts: take a message, or try the next contact that fits. ("message_urgent" was removed: now a plain message.) */
export const transferFallbacks = ['message', 'next'] as const
export type TransferFallback = (typeof transferFallbacks)[number]
/**
 * Someone the assistant puts callers through to (warm transfer) when `condition` fits the call. An
 * assistant's contacts are an ordered list: when several fit, they are tried in that order.
 */
export type TransferContact = {
  /** Unique within the assistant's list. */
  id: string
  name: string
  /** E.164; null: no number yet, so the contact is inactive. */
  number: string | null
  /** When to put the caller through, in plain words ("The caller asks to speak to a person"). */
  condition: string
  /** Only while the business is open (business hours). */
  hours_only: boolean
  /** How long the phone rings before the assistant goes back to the caller. */
  ring_seconds: number
  /** Nobody accepts: take a message marked urgent, take a message, or try the next contact that fits. */
  if_no_answer: TransferFallback
  /** Switched off: kept in the list, never dialled. */
  enabled: boolean
  /**
   * When the person picks up, an AI voice first tells them who is calling and about what, and they take the call or
   * not (key 1/2 or yes/no). false: the caller is put straight through as soon as the phone is answered, with no
   * briefing and no way to decline. Missing: on (isBriefed in @linedesk/actions).
   */
  briefing?: boolean
}
/**
 * A new assistant's list: one inactive contact for callers who ask for a person, until a number is set. `name`: the
 * contact's name, in the workspace's UI language when the API makes the assistant (default-transfers.ts in apps/api);
 * the condition is for the assistant and stays English, like the system prompt.
 */
export const defaultTransfers = (name = 'Owner'): TransferContact[] => [
  {
    id: 'person',
    name,
    number: null,
    condition: 'The caller asks to speak to a person',
    hours_only: true,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
  },
]
/** The list with the English name: the column's default, and a reset where no language is known. */
export const DEFAULT_TRANSFERS: TransferContact[] = defaultTransfers()
/**
 * Vacation or closure mode: from `from` to `until` (dates in the workspace time zone, both closed) the business
 * is closed whatever its hours say. `greeting` replaces the greeting (empty: the outside-hours one, else the
 * usual). Nobody is put through: every call gets a message. A `transfers` key saved by an older release is ignored.
 */
export type Closure = { from: string; until: string; greeting: string }
/**
 * The public holiday calendar a workspace follows (Settings › Assistant › Hours & holidays): its holidays are
 * written into availability_exceptions (source `holiday`) for the next twelve months and kept rolling by a daily
 * job. `off`: holidays (by name, so every year) the business is open on. `changes`: one date of a holiday or a
 * yearly day changed for that year only: open (`open`), or open only `start`–`end`.
 */
export type HolidayCalendar = {
  on: boolean
  country: string
  state: string | null
  off: string[]
  changes: HolidayChange[]
}
export type HolidayChange = { date: string; name: string; open: boolean; start: string | null; end: string | null }
/** The main language an assistant speaks (missing: the workspace language when calls can be answered in it, else English) and the ones besides it (`languages.ts` in @linedesk/actions validates the codes). */
export type AssistantLanguages = { main?: string; mode: 'english' | 'allowed' | 'any'; allowed: string[] }
export type BusinessProfile = {
  /** Free text from the business: what the assistant should know and do. When set, the agent uses it instead of the fields below. */
  instructions?: string
  description?: string
  services?: string[]
  service_area?: string
  address?: string
  hours?: string
  /** No longer used (FAQs were removed); kept in stored profiles until the next save. */
  faqs?: { q: string; a: string }[]
  /** No longer used (services and prices were removed); kept in stored profiles until the next save. */
  service_list?: { name: string; description: string; price: string }[]
  /** The website the knowledge was last imported from. */
  website?: string
  /** The business's own number as its listing gives it (onboarding, business.import). */
  phone?: string
}

export type Call = typeof calls.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type Assistant = typeof assistants.$inferSelect
export type PhoneNumber = typeof phone_numbers.$inferSelect
export type { ForwardingCheckStatus } from './schema.ts'
export type TranscriptSegment = typeof transcript_segments.$inferSelect
// Not delivered by read sync (so not in `Tables`): the API reads them for calendar actions.
export type WorkspaceSettings = typeof workspace_settings.$inferSelect
export type AvailabilityRule = typeof availability_rules.$inferSelect
export type AvailabilityException = typeof availability_exceptions.$inferSelect
export type AppointmentType = typeof appointment_types.$inferSelect
export type Booking = typeof bookings.$inferSelect
export type CalendarConnection = typeof calendar_connections.$inferSelect
export type AppConnection = typeof app_connections.$inferSelect
export type AssistantCalendar = typeof assistant_calendars.$inferSelect
export type ApiKey = typeof api_keys.$inferSelect
export type WebhookEndpoint = typeof webhook_endpoints.$inferSelect
export type IntegrationSubscription = typeof integration_subscriptions.$inferSelect
export type WorkspaceMember = typeof workspace_members.$inferSelect
export type CallEvent = typeof call_events.$inferSelect
export type KnowledgeQuestion = typeof knowledge_questions.$inferSelect

export type Tables = {
  calls: Call
  contacts: Contact
  assistants: Assistant
  phone_numbers: PhoneNumber
  transcript_segments: TranscriptSegment
  appointment_types: AppointmentType
  bookings: Booking
  calendar_connections: CalendarConnection
  app_connections: AppConnection
  assistant_calendars: AssistantCalendar
  webhook_endpoints: WebhookEndpoint
  workspace_members: WorkspaceMember
  call_events: CallEvent
  knowledge_questions: KnowledgeQuestion
}
export type TableName = keyof Tables
/**
 * Why a push to a connected app failed (app_pushes, app_connections): the app's AppErrorKind (@linedesk/connectors),
 * `call_deleted`, `no_caller_id` (no number or email to file the call under) or `internal` (anything else).
 * `channel_not_found` / `channel_archived`: the Slack channel calls are posted to was deleted or archived.
 */
export const appErrorCodes = [
  'auth',
  'rate_limited',
  'unavailable',
  'invalid',
  'not_found',
  'channel_not_found',
  'channel_archived',
  'call_deleted',
  'no_caller_id',
  'internal',
  // Skipped by the connection's settings (status `skipped`), not failures: logging calls is off, or no contact
  // matched the caller and creating contacts is off, or the call was not urgent and only urgent calls are sent.
  'calls_off',
  'no_contact',
  'not_urgent',
] as const
export type AppErrorCode = (typeof appErrorCodes)[number]

export const tableNames = [
  'calls',
  'contacts',
  'assistants',
  'phone_numbers',
  'transcript_segments',
  'appointment_types',
  'bookings',
  'calendar_connections',
  'app_connections',
  'assistant_calendars',
  'webhook_endpoints',
  'workspace_members',
  'call_events',
  'knowledge_questions',
] as const satisfies readonly TableName[]

// Billing prices and rules: one module (docs/billing.md §7a).
export * from './billing-config.ts'
