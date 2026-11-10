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
import type { ActionItem, AssistantVoice, BusinessProfile, CallField, ToolEvent } from './types.ts'

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
    verified_at: ts('verified_at'),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('phone_numbers_ws').on(t.workspace_id)],
)

export const assistants = pgTable('assistants', {
  id: id(),
  workspace_id: workspaceId().unique(),
  name: text('name').notNull().default('Maya'),
  greeting: text('greeting').notNull().default(''),
  disclose_ai: boolean('disclose_ai').notNull().default(true),
  record_calls: boolean('record_calls').notNull().default(true),
  voice: jsonb('voice').$type<AssistantVoice>().notNull().default({ provider: 'elevenlabs', voice_id: '' }),
  business_profile: jsonb('business_profile').$type<BusinessProfile>().notNull().default({}),
  created_at: createdAt(),
  version: version(),
})

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
    /** `test`: a call a member made to the assistant from the web app, with no phone involved. */
    source: text('source', { enum: ['phone', 'test'] })
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
    room: text('room'),
    inbox_state: text('inbox_state', { enum: ['open', 'done'] })
      .notNull()
      .default('open'),
    reminder_at: ts('reminder_at'),
    reminder_label: text('reminder_label'),
    unread: boolean('unread').notNull().default(true),
    assignee_id: text('assignee_id'),
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
  onboarding_step: text('onboarding_step', { enum: ['business', 'phone', 'test_call', 'done', 'skipped'] }),
  /** Recordings older than this many days are deleted by the daily cleanup job. null: keep them. */
  recording_retention_days: integer('recording_retention_days').default(90),
  /** New-call notifications for members who have not set their own (member_notification_settings). */
  notify_email_default: boolean('notify_email_default').notNull().default(true),
  notify_browser_default: boolean('notify_browser_default').notNull().default(true),
  created_at: createdAt(),
  version: version(),
})

// A member's own new-call notifications in one workspace. null: the workspace default applies.
// Not synced: read and written through notifications.* actions, only ever the caller's own row.
export const member_notification_settings = pgTable('member_notification_settings', {
  workspace_id: text('workspace_id').notNull(),
  user_id: text('user_id').notNull(),
  email: boolean('email'),
  browser: boolean('browser'),
  updated_at: ts('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspace_id, t.user_id] })])

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
    /** Set once calendar providers exist: the calendar the event was written to and its id there. */
    calendar_id: text('calendar_id'),
    external_event_id: text('external_event_id'),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('bookings_ws_start').on(t.workspace_id, t.start_at),
    check('bookings_times', sql`${t.end_at} > ${t.start_at}`),
  ],
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
  created_at: createdAt(),
})

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

/** Tables that read sync delivers to clients, filtered by workspace_id. */
export const syncedTables = { calls, contacts, assistants, phone_numbers, transcript_segments } as const
