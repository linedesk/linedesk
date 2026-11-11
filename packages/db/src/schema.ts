// App tables. Property names equal column names (snake_case) so a row has the same shape in
// Postgres, in the API and in the browser (rows arrive there through read sync).
// workspace_id is the Better Auth organization id; every synced table carries it and a `version`
// (global sequence, bumped by trigger on every write) so clients can order row versions.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import type { ActionItem, AssistantVoice, BookingField, BusinessProfile, CallField, ToolEvent, WebhookEvent } from './types.ts'

export const rowVersion = pgSequence('row_version')

const id = () => text('id').primaryKey()
const workspaceId = () => text('workspace_id').notNull()
const version = () => bigint('version', { mode: 'number' }).notNull().default(sql`nextval('row_version')`)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })
const createdAt = () => ts('created_at').notNull().defaultNow()

export const phone_numbers = pgTable(
  'phone_numbers',
  {
    id: id(),
    workspace_id: workspaceId(),
    e164: text('e164').notNull().unique(),
    provider: text('provider', { enum: ['telnyx', 'twilio', 'plivo', 'byo_sip', 'dev'] }).notNull(),
    mode: text('mode', { enum: ['forward_conditional', 'forward_all', 'new', 'ported'] })
      .notNull()
      .default('forward_conditional'),
    forwarded_from: text('forwarded_from'),
    provider_ref: text('provider_ref'),
    /**
     * Whose carrier account the number is in: `install` (Admin, Providers) or `workspace` (the workspace's own
     * Twilio or Telnyx account, workspace_settings.carrier). Releasing and un-routing use that account only.
     */
    carrier_account: text('carrier_account', { enum: ['install', 'workspace'] }).notNull().default('install'),
    /** Bought through Linedesk (phoneNumber.setup with purchase): only these are released at the carrier. */
    purchased: boolean('purchased').notNull().default(false),
    /** The assistant that answers this number (one of the workspace's); null: the workspace's first one. */
    assistant_id: text('assistant_id'),
    verified_at: ts('verified_at'),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('phone_numbers_ws').on(t.workspace_id)],
)

/** A workspace has one or more assistants; each phone number names the one that answers it. */
export const assistants = pgTable(
  'assistants',
  {
    id: id(),
    workspace_id: workspaceId(),
    name: text('name').notNull().default('Maya'),
    greeting: text('greeting').notNull().default(''),
    disclose_ai: boolean('disclose_ai').notNull().default(true),
    record_calls: boolean('record_calls').notNull().default(true),
    voice: jsonb('voice').$type<AssistantVoice>().notNull().default({ provider: 'elevenlabs', voice_id: '' }),
    business_profile: jsonb('business_profile').$type<BusinessProfile>().notNull().default({}),
    /** How to handle calls, as the owner wrote it; null: the default rules (DEFAULT_CALL_RULES in @linedesk/actions). */
    call_rules: text('call_rules'),
    /** Outside business hours (only when the workspace uses them); null: the same as during hours. */
    greeting_outside: text('greeting_outside'),
    instructions_outside: text('instructions_outside'),
    /** Warm transfer: urgent calls are put through to `transfer_number` (E.164, US) when this is on. */
    transfer_urgent: boolean('transfer_urgent').notNull().default(false),
    transfer_number: text('transfer_number'),
    /** Only while the business is open (business hours); outside them the assistant takes a message. */
    transfer_hours_only: boolean('transfer_hours_only').notNull().default(false),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('assistants_ws').on(t.workspace_id)],
)

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    workspace_id: workspaceId(),
    name: text('name'),
    company: text('company'),
    phone: text('phone').notNull(),
    email: text('email'),
    address: text('address'),
    note: text('note'),
    /** Calls from a blocked number are not answered; they are filed quietly in Spam. */
    blocked_at: ts('blocked_at'),
    /** A deleted contact leaves Contacts; its calls keep the link. A new call from the number brings it back. */
    deleted_at: ts('deleted_at'),
    /** Merged into this contact (contact.merge): deleted, its calls moved there; a call from its number goes there too. */
    merged_into: text('merged_into'),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('contacts_ws_phone').on(t.workspace_id, t.phone)],
)

export const calls = pgTable(
  'calls',
  {
    id: id(),
    workspace_id: workspaceId(),
    contact_id: text('contact_id').references(() => contacts.id),
    from_number: text('from_number').notNull(),
    to_number: text('to_number').notNull(),
    direction: text('direction', { enum: ['in', 'out'] })
      .notNull()
      .default('in'),
    /** `test`: a call a member made to the assistant from the web app, with no phone involved. `sample`: an example from sample.add. */
    source: text('source', { enum: ['phone', 'test', 'sample'] })
      .notNull()
      .default('phone'),
    started_at: ts('started_at').notNull().defaultNow(),
    ended_at: ts('ended_at'),
    duration_sec: integer('duration_sec'),
    status: text('status', { enum: ['live', 'completed'] })
      .notNull()
      .default('live'),
    outcome: text('outcome', {
      enum: ['booked', 'rescheduled', 'cancelled', 'callback', 'message', 'answered', 'transferred', 'hangup', 'spam'],
    }),
    urgency: text('urgency', { enum: ['urgent', 'normal', 'low'] })
      .notNull()
      .default('normal'),
    title: text('title'),
    summary: text('summary'),
    action_items: jsonb('action_items').$type<ActionItem[]>().notNull().default([]),
    fields: jsonb('fields').$type<CallField[]>().notNull().default([]),
    answered_by: text('answered_by', { enum: ['ai', 'human'] })
      .notNull()
      .default('ai'),
    recording_key: text('recording_key'),
    /** The recording store that holds `recording_key` (file or s3); null: recorded before stores were per call, so RECORDING_STORE names it. */
    recording_store: text('recording_store', { enum: ['file', 's3'] }),
    room: text('room'),
    /** The assistant that answered (call.start: the number's; a test call: the one picked). */
    assistant_id: text('assistant_id'),
    inbox_state: text('inbox_state', { enum: ['open', 'done'] })
      .notNull()
      .default('open'),
    reminder_at: ts('reminder_at'),
    reminder_label: text('reminder_label'),
    unread: boolean('unread').notNull().default(true),
    /** The member the call is assigned to (call.assign, A in the inbox); null: nobody in particular. */
    assignee_id: text('assignee_id'),
    /** A warm transfer during the call (call.transfer): the number dialled and how it went; null: none. */
    transfer_to: text('transfer_to'),
    transfer_result: text('transfer_result', { enum: ['dialing', 'connected', 'not_answered', 'declined', 'failed'] }),
    /** When the transfer was started; counts toward the workspace's transfers per hour. */
    transfer_at: ts('transfer_at'),
    deleted_at: ts('deleted_at'),
    version: version(),
  },
  t => [index('calls_ws_started').on(t.workspace_id, t.started_at)],
)

export const transcript_segments = pgTable(
  'transcript_segments',
  {
    id: id(),
    workspace_id: workspaceId(),
    call_id: text('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    speaker: text('speaker', { enum: ['agent', 'caller', 'human', 'system'] }).notNull(),
    text: text('text').notNull(),
    at_ms: integer('at_ms').notNull(),
    tool_event: jsonb('tool_event').$type<ToolEvent>(),
    version: version(),
  },
  t => [index('segments_call').on(t.call_id, t.at_ms)],
)

// Per-workspace settings that Better Auth's organization table does not hold. One row per workspace.
export const workspace_settings = pgTable('workspace_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  /** IANA time zone; working hours and exceptions are wall-clock times in it. */
  timezone: text('timezone').notNull(),
  /** Where the owner is in onboarding. null: a workspace from before onboarding existed, treated as finished. */
  onboarding_step: text('onboarding_step', { enum: ['business', 'phone', 'hours', 'calendar', 'test_call', 'done', 'skipped'] }),
  /** Recordings older than this many days are deleted by the daily cleanup job. null: keep them. */
  recording_retention_days: integer('recording_retention_days').default(90),
  /** New-call notifications for members who have not set their own (member_notification_settings). */
  notify_email_default: boolean('notify_email_default').notNull().default(true),
  notify_browser_default: boolean('notify_browser_default').notNull().default(true),
  /** The workspace uses its business hours (availability_rules) for calls. Off: the assistant says nothing about hours. */
  business_hours_on: boolean('business_hours_on').notNull().default(false),
  /** The assistant says a recording notice right after the greeting (off by default; no per-state rules). */
  recording_notice_on: boolean('recording_notice_on').notNull().default(false),
  /** The sentence it says; null: DEFAULT_RECORDING_NOTICE. */
  recording_notice: text('recording_notice'),
  /**
   * The carrier account the workspace's numbers use: `default` is the install's (Admin, Providers), `twilio`
   * or `telnyx` the workspace's own account, its credentials in provider_settings rows with this workspace_id.
   */
  carrier: text('carrier', { enum: ['default', 'twilio', 'telnyx'] }).notNull().default('default'),
  created_at: createdAt(),
  version: version(),
})

// A member's own new-call notifications in one workspace. null: the workspace default applies.
// Not synced: read and written through notifications.* actions, only ever the caller's own row.
export const member_notification_settings = pgTable(
  'member_notification_settings',
  {
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id').notNull(),
    email: boolean('email'),
    browser: boolean('browser'),
    /** Push notifications carry what the call was about (one line); null/false: only who called. */
    push_summary: boolean('push_summary'),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.user_id] })],
)

// Web Push: one row per browser (its push service endpoint) and workspace a member turned push on in.
// Not synced. The endpoint and keys let anyone send to that browser, so they never leave the server
// and are redacted in the command log. Rows go when the member signs out, leaves or is removed, is
// disabled, or when the push service says the subscription is gone.
export const push_subscriptions = pgTable(
  'push_subscriptions',
  {
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    created_at: createdAt(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.endpoint] }), index('push_subscriptions_user_idx').on(t.user_id)],
)

// Weekly working hours: wall-clock times in the workspace time zone. Several rows per weekday are allowed.
// Hours cannot cross midnight; `24:00` is a valid end.
export const availability_rules = pgTable(
  'availability_rules',
  {
    id: id(),
    workspace_id: workspaceId(),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: integer('weekday').notNull(),
    start_time: time('start_time').notNull(),
    end_time: time('end_time').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('availability_rules_ws').on(t.workspace_id),
    check('availability_rules_weekday', sql`${t.weekday} between 0 and 6`),
    check('availability_rules_times', sql`${t.end_time} > ${t.start_time}`),
  ],
)

// Replaces the weekly hours on one date. Without times the day is closed.
export const availability_exceptions = pgTable(
  'availability_exceptions',
  {
    id: id(),
    workspace_id: workspaceId(),
    date: date('date', { mode: 'string' }).notNull(),
    start_time: time('start_time'),
    end_time: time('end_time'),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('availability_exceptions_ws_date').on(t.workspace_id, t.date),
    check(
      'availability_exceptions_times',
      sql`(${t.start_time} is null and ${t.end_time} is null) or coalesce(${t.end_time} > ${t.start_time}, false)`,
    ),
  ],
)

export const appointment_types = pgTable(
  'appointment_types',
  {
    id: id(),
    workspace_id: workspaceId(),
    name: text('name').notNull(),
    duration_min: integer('duration_min').notNull(),
    buffer_min: integer('buffer_min').notNull().default(0),
    min_notice_hours: integer('min_notice_hours').notNull().default(0),
    max_days_ahead: integer('max_days_ahead').notNull().default(60),
    location: text('location', { enum: ['on_site', 'office', 'phone', 'video'] })
      .notNull()
      .default('on_site'),
    enabled: boolean('enabled').notNull().default(true),
    /** What the assistant must have before it books this type: the caller's name and the reason always, plus any of these. */
    required_fields: jsonb('required_fields').$type<BookingField[]>().notNull().default([]),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('appointment_types_ws').on(t.workspace_id),
    check('appointment_types_duration', sql`${t.duration_min} > 0`),
    check('appointment_types_buffer', sql`${t.buffer_min} >= 0`),
    check('appointment_types_min_notice', sql`${t.min_notice_hours} >= 0`),
    check('appointment_types_max_days', sql`${t.max_days_ahead} > 0`),
  ],
)

// A calendar account connected to a workspace (Google or Microsoft). Synced: holds no secret.
// Its tokens are in calendar_credentials, which is never synced.
export const calendar_connections = pgTable(
  'calendar_connections',
  {
    id: id(),
    workspace_id: workspaceId(),
    provider: text('provider', { enum: ['google', 'microsoft'] }).notNull(),
    account_email: text('account_email').notNull(),
    /** `needs_reconnect`: the provider refused the grant (revoked, expired); someone has to connect it again. */
    status: text('status', { enum: ['connected', 'needs_reconnect'] })
      .notNull()
      .default('connected'),
    /** The provider's last refusal, for the settings page. */
    last_error: text('last_error'),
    /** The member who connected the account. */
    connected_by: text('connected_by').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('calendar_connections_ws').on(t.workspace_id),
    unique('calendar_connections_account').on(t.workspace_id, t.provider, t.account_email),
  ],
)

// OAuth tokens of a calendar connection, AES-256-GCM with SECRETS_KEY (apps/api/src/secrets.ts). Never synced.
export const calendar_credentials = pgTable('calendar_credentials', {
  connection_id: text('connection_id')
    .primaryKey()
    .references(() => calendar_connections.id, { onDelete: 'cascade' }),
  workspace_id: workspaceId(),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted').notNull(),
  expires_at: ts('expires_at').notNull(),
  /** The scopes the account granted, as the provider reported them. */
  scope: text('scope'),
  updated_at: ts('updated_at').notNull().defaultNow(),
})

// A started calendar connect: the OAuth `state` (this row's id) and the PKCE verifier, for one member in
// one workspace, used once and for ten minutes. Never synced.
export const calendar_oauth_states = pgTable('calendar_oauth_states', {
  id: id(),
  workspace_id: workspaceId(),
  user_id: text('user_id').notNull(),
  provider: text('provider', { enum: ['google', 'microsoft'] }).notNull(),
  code_verifier: text('code_verifier').notNull(),
  expires_at: ts('expires_at').notNull(),
  created_at: createdAt(),
})

// A calendar the assistant may book into, with the owner's note on when to use it
// ("Emergencies", "Estimates"). The assistant picks one per booking; the API checks it is the assistant's.
export const assistant_calendars = pgTable(
  'assistant_calendars',
  {
    id: id(),
    workspace_id: workspaceId(),
    assistant_id: text('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => calendar_connections.id, { onDelete: 'cascade' }),
    /** The provider's calendar id. */
    external_id: text('external_id').notNull(),
    name: text('name').notNull(),
    /** When to use this calendar, in the owner's words; goes into the assistant's prompt. */
    instruction: text('instruction').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** Used when no instruction fits. At most one per assistant. */
    is_default: boolean('is_default').notNull().default(false),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('assistant_calendars_ws').on(t.workspace_id),
    unique('assistant_calendars_calendar').on(t.assistant_id, t.connection_id, t.external_id),
  ],
)

export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    workspace_id: workspaceId(),
    call_id: text('call_id').references(() => calls.id, { onDelete: 'set null' }),
    contact_id: text('contact_id').references(() => contacts.id),
    appointment_type_id: text('appointment_type_id').references(() => appointment_types.id),
    start_at: ts('start_at').notNull(),
    end_at: ts('end_at').notNull(),
    status: text('status', { enum: ['confirmed', 'rescheduled', 'cancelled'] })
      .notNull()
      .default('confirmed'),
    /** The assistant_calendars row the event was written to (no foreign key: the booking outlives it) and the event's id there. */
    calendar_id: text('calendar_id'),
    external_event_id: text('external_event_id'),
    /** The event's title ("Repair visit · Sam Patel") and the calendar's name, as they were when booked. */
    title: text('title'),
    calendar_name: text('calendar_name'),
    /** The caller's email address, if they gave one. */
    caller_email: text('caller_email'),
    /** The confirmation email: queued, or skipped by the limits (one per call, a few per workspace an hour). */
    confirmation: text('confirmation', { enum: ['queued', 'skipped'] }),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('bookings_ws_start').on(t.workspace_id, t.start_at),
    check('bookings_times', sql`${t.end_at} > ${t.start_at}`),
  ],
)

// API keys of a workspace, for its own integrations (REST, MCP). Only a SHA-256 hash of the key is
// stored: the key itself is shown once, when it is created. Never synced.
export const api_keys = pgTable(
  'api_keys',
  {
    id: id(),
    workspace_id: workspaceId(),
    name: text('name').notNull(),
    /** The key's first characters ("ld_AbCd1234"), to tell keys apart; not enough to use one. */
    prefix: text('prefix').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    /** What the key may do: a member's or an admin's permissions (never an owner's, never key management). */
    role: text('role', { enum: ['member', 'admin'] }).notNull().default('member'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
  },
  t => [index('api_keys_ws').on(t.workspace_id)],
)

// Every command the API accepted or rejected: idempotency per command id + audit log.
export const commands = pgTable('commands', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id'),
  actor_id: text('actor_id').notNull(),
  action: text('action').notNull(),
  input: jsonb('input').notNull(),
  result: jsonb('result').notNull(),
  rejected: boolean('rejected').notNull().default(false),
  /** The instance admin who did this while signed in as `actor_id` (impersonation); null otherwise. */
  impersonated_by: text('impersonated_by'),
  created_at: createdAt(),
})

// How well the assistant handled a call, judged by the language model after the summary: a score
// (1 to 5) and up to three issues. One row per call, replaced when it is evaluated again. For owners
// and admins only, so not synced to browsers; read through `call.getEvaluation` / `call.listEvaluations`.
export const call_evaluations = pgTable(
  'call_evaluations',
  {
    call_id: text('call_id')
      .primaryKey()
      .references(() => calls.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    score: integer('score').notNull(),
    issues: jsonb('issues').$type<string[]>().notNull().default([]),
    /** The model that judged, e.g. google/gemini-2.5-flash-lite. */
    model: text('model'),
    /** The assistant's row version when it was judged: a new evaluation of the call is only worth it after the assistant changed. */
    assistant_version: bigint('assistant_version', { mode: 'number' }),
    created_at: createdAt(),
  },
  t => [index('call_evaluations_ws_score').on(t.workspace_id, t.score)],
)

// The audit log's sign-in side (docs/architecture.md §12, Audit log): sign-ins with their method, sign-in
// methods added or removed, invitations accepted. Actions are in `commands`. Never deleted, and no
// foreign keys, so an entry outlives the user or workspace it names. Not synced to browsers.
export const auth_events = pgTable(
  'auth_events',
  {
    id: id(),
    created_at: createdAt(),
    user_id: text('user_id'),
    /** The address at the time, kept in case the user changes or is removed. */
    email: text('email'),
    event: text('event', {
      enum: ['sign_in', 'sign_up', 'provider_linked', 'passkey_added', 'passkey_removed', 'password_changed', 'invitation_accepted'],
    }).notNull(),
    /** sign_in / sign_up / provider_linked: password, email_code, passkey, google, microsoft, github, oidc. */
    method: text('method'),
    workspace_id: text('workspace_id'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
  },
  t => [index('auth_events_created').on(t.created_at), index('auth_events_user').on(t.user_id, t.created_at)],
)

// Provider keys set in the admin area, one row per provider field. Provider and field are plain text: the
// list of providers lives in code (packages/actions/src/admin.ts), so a new one needs no migration.
// Not synced to browsers. `workspace_id` is null for the value of the whole install; a per-workspace
// override would be a row with the workspace id (not built).
export const provider_settings = pgTable(
  'provider_settings',
  {
    id: id(),
    workspace_id: text('workspace_id'),
    provider: text('provider').notNull(),
    field: text('field').notNull(),
    /** AES-256-GCM with SECRETS_KEY, see apps/api/src/secrets.ts. */
    value_encrypted: text('value_encrypted').notNull(),
    /** The last four characters of a secret, for display. Null for short values and for fields that are not secret. */
    last4: text('last4'),
    updated_at: ts('updated_at').notNull().defaultNow(),
    updated_by: text('updated_by'),
  },
  t => [unique('provider_settings_slot').on(t.workspace_id, t.provider, t.field).nullsNotDistinct()],
)

// Settings of the whole install that are not secret, for example `active_provider.telephony`.
export const instance_settings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: ts('updated_at').notNull().defaultNow(),
  updated_by: text('updated_by'),
})

// Voices a workspace cloned at its text-to-speech provider (voice.clone), with the consent given
// for it. Not synced. A clone no assistant of the workspace uses any more is deleted at the provider
// and marked deleted here (apps/api/src/voices.ts), also when its workspace is deleted; the row is
// kept as the record of who confirmed the speaker's consent, and when.
export const voice_clones = pgTable(
  'voice_clones',
  {
    id: id(),
    workspace_id: workspaceId(),
    provider: text('provider').notNull(),
    voice_id: text('voice_id').notNull(),
    name: text('name').notNull(),
    /** Who confirmed the speaker's consent, when, and the exact statement they confirmed. */
    consent_by: text('consent_by').notNull(),
    consent_at: ts('consent_at').notNull(),
    consent_text: text('consent_text').notNull(),
    created_at: createdAt(),
    /** No assistant uses it any more: deleted at the provider; the row stays as the consent record. */
    deleted_at: ts('deleted_at'),
  },
  t => [index('voice_clones_ws').on(t.workspace_id), unique('voice_clones_voice').on(t.provider, t.voice_id)],
)

// Where a workspace's events are sent (apps/api/src/webhooks.ts). Synced: holds no secret; the signing
// secret is in webhook_secrets. `failure_count`: deliveries in a row that failed after every retry.
export const webhook_endpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    workspace_id: workspaceId(),
    url: text('url').notNull(),
    events: jsonb('events').$type<WebhookEvent[]>().notNull(),
    /** `disabled`: by a member, or by the API after too many failed deliveries (`disabled_reason`). */
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    disabled_reason: text('disabled_reason'),
    failure_count: integer('failure_count').notNull().default(0),
    last_delivery_at: ts('last_delivery_at'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('webhook_endpoints_ws').on(t.workspace_id)],
)

// The signing secret of a webhook endpoint, AES-256-GCM with SECRETS_KEY. Never synced.
export const webhook_secrets = pgTable('webhook_secrets', {
  endpoint_id: text('endpoint_id')
    .primaryKey()
    .references(() => webhook_endpoints.id, { onDelete: 'cascade' }),
  workspace_id: workspaceId(),
  secret_encrypted: text('secret_encrypted').notNull(),
})

// One event sent (or being sent) to one endpoint: the delivery log. Never synced; read with webhook.deliveries.
export const webhook_deliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    workspace_id: workspaceId(),
    endpoint_id: text('endpoint_id')
      .notNull()
      .references(() => webhook_endpoints.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    /** The event as sent. Cleared (null) after 30 days and when its call is deleted: it holds callers' details. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** `pending` until it was delivered or every retry failed. */
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** The endpoint's HTTP status of the last attempt; null when there was no answer. */
    response_status: integer('response_status'),
    error: text('error'),
    last_attempt_at: ts('last_attempt_at'),
    created_at: createdAt(),
  },
  t => [index('webhook_deliveries_endpoint').on(t.endpoint_id, t.created_at)],
)

/** Tables that read sync delivers to clients, filtered by workspace_id. */
export const syncedTables = {
  calls, contacts, assistants, phone_numbers, transcript_segments, appointment_types, bookings, calendar_connections, assistant_calendars,
  webhook_endpoints,
} as const
