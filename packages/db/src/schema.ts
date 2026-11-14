// App tables. Property names equal column names (snake_case) so a row has the same shape in
// Postgres, in the API and in the browser (rows arrive there through read sync).
// workspace_id is the Better Auth organization id; every synced table carries it and a `version`
// (global sequence, bumped by trigger on every write) so clients can order row versions.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
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
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { user } from './auth-schema.ts'
import {
  DEFAULT_TRANSFERS,
  type ActionItem,
  type AssistantLanguages,
  type AssistantVoice,
  type BookingField,
  type BusinessProfile,
  type CallField,
  type CallerDetails,
  type CallVoiceFailure,
  type Closure,
  type HolidayCalendar,
  type ToolEvent,
  type TransferContact,
  type WebhookEvent,
  type WebhookHook,
  type WebhookLookup,
} from './types.ts'

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
    carrier_account: text('carrier_account', { enum: ['install', 'workspace'] })
      .notNull()
      .default('install'),
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
    /** Replaced by `ai_disclosure` (0054 migrated it); kept until the release after it is gone. */
    disclose_ai: boolean('disclose_ai').notNull().default(true),
    /** Whether and when the assistant mentions it is an AI (AI_DISCLOSURE_MODES in @linedesk/actions). */
    ai_disclosure: text('ai_disclosure', { enum: ['never', 'when_asked', 'at_start', 'at_start_consent'] })
      .notNull()
      .default('when_asked'),
    /** The tone it uses (COMMUNICATION_STYLES in @linedesk/actions); `standard` adds nothing to the instructions. */
    communication_style: text('communication_style', {
      enum: ['standard', 'professional', 'casual', 'formal', 'empathetic'],
    })
      .notNull()
      .default('standard'),
    record_calls: boolean('record_calls').notNull().default(true),
    /** No longer used: greeting saved contacts by name was removed (0061 turned it off); dropped in a later release. */
    greet_by_name: boolean('greet_by_name').notNull().default(false),
    /** No longer used, like `greet_by_name` (0061 emptied it); dropped in a later release. */
    greeting_known_caller: text('greeting_known_caller').notNull().default(''),
    voice: jsonb('voice').$type<AssistantVoice>().notNull().default({ provider: 'elevenlabs', voice_id: '' }),
    business_profile: jsonb('business_profile').$type<BusinessProfile>().notNull().default({}),
    /** No longer used: the call rules are fixed (callRules in @linedesk/actions); dropped in a later release. */
    call_rules: text('call_rules'),
    /** Outside business hours (only when the workspace uses them); null: the same as during hours. */
    greeting_outside: text('greeting_outside'),
    /** No longer used (migration 0053 moved it into business_profile.instructions); dropped in a later release. */
    instructions_outside: text('instructions_outside'),
    /**
     * Warm transfer: who the assistant puts callers through to, and when, in order (TransferContact).
     * Replaces transfer_urgent/transfer_number/transfer_hours_only, which stay until the next release (expand/contract).
     */
    transfers: jsonb('transfers').$type<TransferContact[]>().notNull().default(DEFAULT_TRANSFERS),
    /** @deprecated read `transfers`; migrated into its first contact (0046). */
    transfer_urgent: boolean('transfer_urgent').notNull().default(false),
    transfer_number: text('transfer_number'),
    /** Only while the business is open (business hours); outside them the assistant takes a message. */
    transfer_hours_only: boolean('transfer_hours_only').notNull().default(false),
    /**
     * Silence on the line (SILENCE_* in @linedesk/actions): after `silence_first_gap_s` seconds without a word the
     * assistant asks whether the caller is still there, again every `silence_first_gap_s` seconds, `silence_reminders`
     * times; at `silence_hang_up_s` seconds of silence it says `silence_closing` (null: the default line) and hangs up.
     */
    silence_first_gap_s: integer('silence_first_gap_s').notNull().default(5),
    silence_reminders: integer('silence_reminders').notNull().default(2),
    silence_hang_up_s: integer('silence_hang_up_s').notNull().default(15),
    /** The longest the assistant stays on a call, in minutes (at most ASSISTANT_CALL_MAX_MINUTES); then it says goodbye and hangs up. */
    max_call_minutes: integer('max_call_minutes').notNull().default(25),
    silence_closing: text('silence_closing'),
    /** Asked when the line is quiet; null: "Are you still there?" in the language spoken (DEFAULT_SILENCE_REMINDER). */
    silence_reminder: text('silence_reminder'),
    /** Replaced by `talking_speed_pct`; the nearest of slow, normal, fast, kept for the release before. */
    talking_speed: text('talking_speed', { enum: ['slow', 'normal', 'fast'] })
      .notNull()
      .default('normal'),
    /**
     * How fast the assistant talks, in percent of the voice's own pace (TALKING_SPEED_PCT_* in @linedesk/actions).
     * Replaces `talking_speed`, which is still kept in step (the nearest of the three) for the release before.
     */
    talking_speed_pct: integer('talking_speed_pct').notNull().default(100),
    /** The behaviour checklist (BEHAVIOURS in @linedesk/actions): only the switches the owner changed; the rest use their default. */
    behaviours: jsonb('behaviours').$type<Record<string, boolean>>().notNull().default({}),
    /** Languages the assistant speaks with callers: English only (the default), English + an allow-list, or any it supports. */
    languages: jsonb('languages').$type<AssistantLanguages>().notNull().default({ mode: 'english', allowed: [] }),
    /**
     * How its calls are answered (VOICE_PIPELINES in @linedesk/actions): a realtime model, or speech to text, language
     * model and voice. null: the install's default (the realtime model when one is set up). pipelineFor picks the other
     * one when the chosen one is not set up.
     */
    voice_pipeline: text('voice_pipeline', { enum: ['realtime', 'three_stage'] }),
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
    /**
     * Who gave the name: `member` (typed, imported or confirmed by the team) or `caller` (said on a call). Only a
     * member's name lets the assistant talk about the caller's history; null (no name, or written by an older
     * release) counts as a caller's.
     */
    name_source: text('name_source', { enum: ['member', 'caller'] }),
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
    /**
     * `test`: a call a member made to the assistant from the web app, with no phone involved. `sample`: an example
     * from sample.add. `simulated`: a scripted call from the call simulator; never counts as a real call.
     */
    source: text('source', { enum: ['phone', 'test', 'sample', 'simulated'] })
      .notNull()
      .default('phone'),
    /**
     * A phone call from the business's own phones (a number its assistants put calls through to, or one of its
     * Linedesk numbers): the owner trying it out, not a caller. Set by call.start; such calls don't count as real.
     */
    from_own_number: boolean('from_own_number').notNull().default(false),
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
    /** The assistant's settings version the call ran with (assistant_versions.number); null: before versions. */
    assistant_version: integer('assistant_version'),
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
    /** The transfer contact's name at the time (TransferContact.name); null: none or an older call. */
    transfer_name: text('transfer_name'),
    transfer_result: text('transfer_result', { enum: ['dialing', 'connected', 'not_answered', 'declined', 'failed'] }),
    /** When the transfer was started; counts toward the workspace's transfers per hour. */
    transfer_at: ts('transfer_at'),
    /**
     * Times on this call the caller described a booking to change (day and name) that the API could not match,
     * or picked a time that was not free. Summed over the caller's calls of the last 24 hours, it locks booking
     * changes by phone for that caller (bookings.ts, BOOKING_MISSES_PER_DAY).
     */
    booking_misses: integer('booking_misses').notNull().default(0),
    /** What the assistant's call-start webhook answered about the caller (webhooks.ts, CallerDetails); null: no answer. */
    caller_details: jsonb('caller_details').$type<CallerDetails>(),
    /** Stages of the voice pipeline that failed on this call (call.reportVoiceFailure), one per stage, provider and reason. */
    voice_failures: jsonb('voice_failures').$type<CallVoiceFailure[]>().notNull().default([]),
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

// The members of a workspace as the browser sees them: who calls can be assigned to. Only safe fields
// (name, role, the profile picture's version; no email, no sign-in data). Kept in step with Better Auth's `member` and `user` by triggers
// (migrations/0039_workspace_members.sql), whoever writes them; never written by the app. id = member.id.
export const workspace_members = pgTable(
  'workspace_members',
  {
    id: id(),
    workspace_id: workspaceId(),
    user_id: text('user_id').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    /** The account is disabled by an instance admin: shown on calls it had, never offered to assign. */
    disabled: boolean('disabled').notNull().default(false),
    /**
     * The member's profile picture (user_avatars.version), null without one: its address is
     * /v1/avatars/<user_id>.png?v=<avatar_version>. Kept in step by triggers (migration 0087).
     */
    avatar_version: text('avatar_version'),
    version: version(),
  },
  t => [index('workspace_members_ws').on(t.workspace_id)],
)

// What people did with a call, its activity: assigned (assignee_id set) or unassigned (null) by call.assign;
// listened in (call.listen) or took the live call over (call.takeOver). Written by the server, never by the browser.
export const call_events = pgTable(
  'call_events',
  {
    id: id(),
    workspace_id: workspaceId(),
    call_id: text('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['assigned', 'listened', 'took_over'] }).notNull(),
    /** The member who did it; null: an API key or the system. */
    actor_id: text('actor_id'),
    /** For `assigned`: the new assignee; null: unassigned. */
    assignee_id: text('assignee_id'),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('call_events_call').on(t.call_id, t.created_at)],
)

// Per-workspace settings that Better Auth's organization table does not hold. One row per workspace.
export const workspace_settings = pgTable('workspace_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  /** IANA time zone; working hours and exceptions are wall-clock times in it. */
  timezone: text('timezone').notNull(),
  /**
   * Where the owner is in onboarding. null: a workspace from before onboarding existed, treated as finished.
   * `hours`, `calendar` and `test_call` are steps of the earlier flow, still read (resumeStep maps them).
   */
  onboarding_step: text('onboarding_step', {
    enum: ['business', 'assistant', 'pickup', 'notify', 'phone', 'hours', 'calendar', 'test_call', 'done', 'skipped'],
  }),
  /**
   * When the assistant picks up, as chosen in onboarding: `no_answer` (calls the business doesn't answer, by
   * conditional forwarding), `always` (every call, forwarding all) or `after_hours` (only when closed: conditional
   * forwarding plus the business hours). It picks the forwarding code shown; routing itself stays with the
   * number's mode and the hours. null: never chosen.
   */
  pickup_mode: text('pickup_mode', { enum: ['no_answer', 'always', 'after_hours'] }),
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
  carrier: text('carrier', { enum: ['default', 'twilio', 'telnyx'] })
    .notNull()
    .default('default'),
  /** Vacation or closure mode: closed on these dates whatever the hours say, with its own greeting; null: off. */
  closure: jsonb('closure').$type<Closure>(),
  /** The public holiday calendar the workspace follows; null: never set up. */
  holidays: jsonb('holidays').$type<HolidayCalendar>(),
  /** What a booked job is worth on average, in the minor units of job_value_currency (cents; whole yen for JPY), for Insights ("≈ $X in booked work"). null: not set. */
  job_value_cents: integer('job_value_cents'),
  /** The currency of job_value_cents (ISO 4217, one of jobValueCurrencies in @linedesk/actions). */
  job_value_currency: text('job_value_currency', {
    enum: [
      'USD',
      'AUD',
      'BRL',
      'CAD',
      'CHF',
      'DKK',
      'EUR',
      'GBP',
      'INR',
      'JPY',
      'MXN',
      'NOK',
      'NZD',
      'SEK',
      'SGD',
      'ZAR',
    ],
  })
    .notNull()
    .default('USD'),
  created_at: createdAt(),
  version: version(),
})

// A member's own new-call notifications in one workspace. null: the workspace default applies.
// Not synced: read and written through notifications.* actions (the caller's own row), and by the workspace's
// owners and admins through team.updateMemberNotifications.
export const member_notification_settings = pgTable(
  'member_notification_settings',
  {
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id').notNull(),
    email: boolean('email'),
    browser: boolean('browser'),
    /** Push notifications carry what the call was about (one line); null/false: only who called. */
    push_summary: boolean('push_summary'),
    /** An email when a teammate assigns a call to this member; null: on. */
    assigned_email: boolean('assigned_email'),
    /** Setup emails (apps/api/src/setup-emails.ts) while the workspace gets set up; null: on. */
    setup_emails: boolean('setup_emails'),
    updated_at: ts('updated_at').notNull().defaultNow(),
    /**
     * Who made the last change: the member, or an owner or admin of the workspace (team.updateMemberNotifications).
     * null: the member (rows from before this column). The member's page says when it was someone else.
     */
    updated_by: text('updated_by'),
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
    /** What the day is ("Thanksgiving"); empty when none was given. */
    name: text('name').notNull().default(''),
    start_time: time('start_time'),
    end_time: time('end_time'),
    /**
     * `own`: added by the owner. `holiday`: from the workspace's holiday calendar (workspace_settings.holidays),
     * `repeat`: a later year of an own yearly day; both written by syncDerivedDays (apps/api/src/public-holidays.ts),
     * never by hand, and from today on replaced at each sync.
     */
    source: text('source', { enum: ['own', 'holiday', 'repeat'] })
      .notNull()
      .default('own'),
    /** `holiday`: the holiday's name (its key in `off`); `repeat`: the date of the own yearly day it repeats. */
    source_key: text('source_key'),
    /** Own days only: closed on this date every year. */
    yearly: boolean('yearly').notNull().default(false),
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
    /** Kept for a release from before the two buffers below: the larger of them. */
    buffer_min: integer('buffer_min').notNull().default(0),
    /** Free time kept between an appointment or event before and this one (minutes). */
    buffer_before_min: integer('buffer_before_min').notNull().default(0),
    /** Free time kept between this one and the next appointment or event (minutes). */
    buffer_after_min: integer('buffer_after_min').notNull().default(0),
    /** When it may be booked, relative to the business hours (see hoursFor in @linedesk/calendar). */
    book_when: text('book_when', { enum: ['business_hours', 'outside_business_hours', 'any_time'] })
      .notNull()
      .default('business_hours'),
    min_notice_hours: integer('min_notice_hours').notNull().default(0),
    max_days_ahead: integer('max_days_ahead').notNull().default(60),
    location: text('location', { enum: ['on_site', 'office', 'phone', 'video'] })
      .notNull()
      .default('on_site'),
    enabled: boolean('enabled').notNull().default(true),
    /** What the assistant must have before it books this type besides the reason (always): any of these. */
    required_fields: jsonb('required_fields').$type<BookingField[]>().notNull().default([]),
    /**
     * Whether the assistant asks for the caller's name before booking (the "Name" field). A column of its
     * own, not a value in required_fields, so a release that knows only phone, email and address keeps working.
     */
    name_required: boolean('name_required').notNull().default(true),
    /** When the assistant offers this type ("the caller needs an emergency visit"); empty: no condition. */
    instruction: text('instruction').notNull().default(''),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('appointment_types_ws').on(t.workspace_id),
    check('appointment_types_duration', sql`${t.duration_min} > 0`),
    check('appointment_types_buffer', sql`${t.buffer_min} >= 0`),
    check('appointment_types_buffer_before', sql`${t.buffer_before_min} >= 0`),
    check('appointment_types_buffer_after', sql`${t.buffer_after_min} >= 0`),
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

// Every saved change of an assistant's call settings (and its calendars) as a whole copy, numbered per
// assistant: Settings › Assistant › History lists them, compares one with now and restores it. Not synced.
export const assistant_versions = pgTable(
  'assistant_versions',
  {
    id: id(),
    workspace_id: workspaceId(),
    assistant_id: text('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    /** 1, 2, 3… per assistant; a call stores the one it ran with (calls.assistant_version). */
    number: integer('number').notNull(),
    /** The settings as saved (AssistantSnapshot in @linedesk/actions). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
    /** What changed against the version before, in a few words. */
    summary: text('summary').notNull(),
    /** The user who saved it; null: written by Linedesk itself (the first copy, a change from an older release). */
    changed_by: text('changed_by'),
    /** The version this one brought back (assistant.restoreVersion); null: an edit. */
    restored_from: integer('restored_from'),
    created_at: createdAt(),
  },
  t => [
    unique('assistant_versions_number').on(t.assistant_id, t.number),
    index('assistant_versions_ws').on(t.workspace_id),
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
    /** Where the appointment is, as the caller gave it (also the calendar event's location). */
    address: text('address'),
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
    role: text('role', { enum: ['member', 'admin'] })
      .notNull()
      .default('member'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
  },
  t => [index('api_keys_ws').on(t.workspace_id)],
)

// Every command the API accepted or rejected: idempotency per command id + audit log.
export const commands = pgTable(
  'commands',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id'),
    actor_id: text('actor_id').notNull(),
    action: text('action').notNull(),
    input: jsonb('input').notNull(),
    result: jsonb('result').notNull(),
    rejected: boolean('rejected').notNull().default(false),
    /** The instance admin who did this while signed in as `actor_id` (impersonation); null otherwise. */
    impersonated_by: text('impersonated_by'),
    /** The agent setup key (agent_setup_keys.id) this was done with: an AI agent acting as `actor_id`; null otherwise. */
    setup_key_id: text('setup_key_id'),
    created_at: createdAt(),
    /** When input and result were cut down to ids: 90 days on, or when the call or contact was deleted (apps/api/src/command-log.ts). */
    pruned_at: ts('pruned_at'),
  },
  t => [
    // The daily prune finds old commands not yet pruned; deleting a call or contact finds the commands naming it.
    index('commands_unpruned_created').on(t.created_at).where(sql`${t.pruned_at} is null`),
    index('commands_unpruned_input').using('gin', t.input.op('jsonb_path_ops')).where(sql`${t.pruned_at} is null`),
    index('commands_unpruned_result').using('gin', t.result.op('jsonb_path_ops')).where(sql`${t.pruned_at} is null`),
  ],
)

// How well the assistant handled a call, judged by the language model after the summary: a score
// (1 to 5), up to three issues and the questions it could not answer. One row per call, replaced when it is evaluated again. For owners
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
    /** Questions about the business the caller asked that the assistant could not answer (at most three). */
    unanswered: jsonb('unanswered').$type<string[]>().notNull().default([]),
    /** When an owner or admin marked it done in "How <assistant> did" (null: open); cleared when it is judged again. */
    reviewed_at: ts('reviewed_at'),
    /** Who marked it done (user id). */
    reviewed_by: text('reviewed_by'),
    created_at: createdAt(),
  },
  t => [index('call_evaluations_ws_score').on(t.workspace_id, t.score)],
)

// Reply latency (Admin, Overview): one row per assistant reply, the time from the caller's last word to the reply's
// first audio, split by where it went. Written by the agent at hang-up (call.recordTimings); `heard_ms` rows come from
// the call test, which hears the reply over the phone. Not synced: only the admin overview reads it.
export const reply_timings = pgTable(
  'reply_timings',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    call_id: text('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    /** `cascaded` (speech to text, language model, voice) or `realtime`; `phone`: a call test's `heard_ms` row. */
    pipeline: text('pipeline').notNull(),
    /** Who did each part: { turn, model, voice } provider ids (a realtime model is turn and model). */
    providers: jsonb('providers').$type<Record<string, string>>().notNull().default({}),
    /** End-of-turn detection: from the caller's last word until the turn is taken. */
    turn_ms: integer('turn_ms'),
    /** The model: until its first token (realtime: until its first audio). */
    model_ms: integer('model_ms'),
    /** The voice: until its first audio (none on a realtime call). */
    voice_ms: integer('voice_ms'),
    /** Linedesk's own agent: the rest until the audio plays. */
    server_ms: integer('server_ms'),
    /** From the caller's last word until the reply plays, on the agent's clock. */
    total_ms: integer('total_ms'),
    /** What the caller heard over the phone (call test only): total plus the phone network. */
    heard_ms: integer('heard_ms'),
  },
  t => [index('reply_timings_at').on(t.at)],
)

// Knowledge (docs/architecture.md, Knowledge): questions callers asked that the assistant could not answer.
// knowledge_documents and knowledge_chunks are no longer used (documents were removed) and are dropped in a later
// release; the documents table stays synced until then, so a web app of the release before keeps working.
export const knowledge_documents = pgTable(
  'knowledge_documents',
  {
    id: id(),
    workspace_id: workspaceId(),
    assistant_id: text('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime_type: text('mime_type').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    /** Characters of text extracted; what decides whether it goes into every call or is looked up. */
    chars: integer('chars').notNull(),
    /** Where the original file is (the recording store in effect when it was added); null: only the text is kept. */
    store: text('store', { enum: ['file', 's3'] }),
    storage_key: text('storage_key'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('knowledge_documents_ws').on(t.workspace_id), index('knowledge_documents_assistant').on(t.assistant_id)],
)

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

export const knowledge_chunks = pgTable(
  'knowledge_chunks',
  {
    id: id(),
    workspace_id: workspaceId(),
    document_id: text('document_id')
      .notNull()
      .references(() => knowledge_documents.id, { onDelete: 'cascade' }),
    assistant_id: text('assistant_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    search: tsvector('search').notNull().generatedAlwaysAs(sql`to_tsvector('english', text)`),
  },
  t => [
    index('knowledge_chunks_assistant').on(t.assistant_id),
    index('knowledge_chunks_search').using('gin', t.search),
  ],
)

export const knowledge_questions = pgTable(
  'knowledge_questions',
  {
    id: id(),
    workspace_id: workspaceId(),
    assistant_id: text('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    call_id: text('call_id').references(() => calls.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    /** `answered`: the owner's answer became an FAQ; `dismissed`: not worth an answer. */
    status: text('status', { enum: ['open', 'answered', 'dismissed'] })
      .notNull()
      .default('open'),
    resolved_at: ts('resolved_at'),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('knowledge_questions_ws').on(t.workspace_id),
    index('knowledge_questions_assistant').on(t.assistant_id, t.status),
  ],
)

// Spending-cap emails already sent: one row per workspace, UTC month ('2026-11') and level (80 or 100 percent),
// so each goes out once a month (apps/api/src/spending-cap.ts). Not synced to browsers.
export const spending_cap_alerts = pgTable(
  'spending_cap_alerts',
  {
    workspace_id: text('workspace_id').notNull(),
    month: text('month').notNull(),
    level: integer('level').notNull(),
    created_at: createdAt(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.month, t.level] })],
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
      enum: [
        'sign_in',
        'sign_up',
        'provider_linked',
        'passkey_added',
        'passkey_removed',
        'password_changed',
        'email_changed',
        'invitation_accepted',
        'call_routing_reset',
      ],
    }).notNull(),
    /**
     * sign_in / sign_up / provider_linked: password, email_code, passkey, google, microsoft, github, oidc.
     * email_changed: the new address (`email` keeps the old one).
     */
    method: text('method'),
    workspace_id: text('workspace_id'),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
  },
  t => [index('auth_events_created').on(t.created_at), index('auth_events_user').on(t.user_id, t.created_at)],
)

// Every number bought through Linedesk, kept when the number is released: the purchase limits on the
// install's carrier account count it (apps/api/src/number-purchases.ts). No foreign keys, never deleted,
// not synced to browsers.
export const number_purchases = pgTable(
  'number_purchases',
  {
    id: id(),
    created_at: createdAt(),
    workspace_id: text('workspace_id').notNull(),
    /** The user who bought it (the impersonated user while an instance admin is signed in as them). */
    actor_id: text('actor_id').notNull(),
    e164: text('e164').notNull(),
    provider: text('provider').notNull(),
    carrier_account: text('carrier_account', { enum: ['install', 'workspace'] }).notNull(),
    /** Bought by an instance admin: not counted against the limits for everyone else. */
    by_admin: boolean('by_admin').notNull().default(false),
  },
  t => [
    index('number_purchases_ws').on(t.workspace_id, t.created_at),
    index('number_purchases_created').on(t.created_at),
  ],
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

// Agent setup keys (LIN-125, apps/api/src/agent-setup.ts): an instance admin lets an AI agent (Claude, ChatGPT, Codex…)
// set up the install through the setup MCP at /mcp/setup. A key acts as the admin who made it, with a short list of
// setup tools only, for a few hours; stored as a SHA-256 hash like a workspace API key. Not synced.
/** Why a setup key was revoked: a newer one, the admin's End, a cleanup that ends all of the admin's ways in, or the admin role removed. */
export type SetupKeyEndReason =
  | 'replaced'
  | 'ended_by_admin'
  /** The agent ended its own link at the end of the setup (agentSetup.endOwnAccess). */
  | 'ended_by_agent'
  | 'passkeys_reset'
  | 'account_disabled'
  | 'password_reset'
  | 'account_recovery'
  | 'admin_role_removed'
export const agent_setup_keys = pgTable(
  'agent_setup_keys',
  {
    id: id(),
    /** The key's first characters ("lds_AbCd1234"), to tell keys apart; not enough to use one. */
    prefix: text('prefix').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    /** The instance admin who made it; the key acts as this user. */
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    expires_at: ts('expires_at').notNull(),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
    /**
     * Why it was revoked (with revoked_at), so an agent still using it hears why instead of "unknown key". The row and
     * its hash stay after the end: that answer matches on the hash only (agent-setup.ts setupKeyAccess).
     */
    ended_reason: text('ended_reason').$type<SetupKeyEndReason>(),
    /**
     * Until when the key may change email and sign-in (the passkey step-up, admin-step-up.ts): the admin confirmed
     * with a passkey when making it, or afterwards on the setup page; 12 hours from that passkey sign-in. Null: never.
     */
    passkey_confirmed_until: ts('passkey_confirmed_until'),
    /** The last change the agent asked for that waits for the admin's Allow (AgentSetupAllowRequest in @linedesk/actions), no secrets. */
    allow_request: jsonb('allow_request').$type<{
      at: string
      ip: string | null
      client: string | null
      what: string
    }>(),
  },
  t => [index('agent_setup_keys_creator').on(t.created_by)],
)

// Settings of the whole install that are not secret, for example `active_provider.telephony`.
export const instance_settings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: ts('updated_at').notNull().defaultNow(),
  updated_by: text('updated_by'),
})

// Providers that are failing now (LIN-111): one row per provider of the registry while its calls fail (quota used
// up, key rejected, model gone), from a provider test, the API's own calls or the voice agent's reports. A success
// deletes the row. One record for every source: the voice agent's call failures (LIN-107) included. `alerted_at`: when the instance admins were emailed about this streak (once, not per call).
// Install-wide, not synced; apps/api/src/provider-failures.ts.
export const provider_failures = pgTable('provider_failures', {
  provider: text('provider').primaryKey(),
  reason: text('reason').notNull(),
  message: text('message').notNull(),
  source: text('source').notNull(),
  since: ts('since').notNull().defaultNow(),
  last_at: ts('last_at').notNull().defaultNow(),
  count: integer('count').notNull().default(1),
  /** Where the latest failure happened: a workspace and call, or null for the install itself (a test, an email). */
  workspace_id: text('workspace_id'),
  call_id: text('call_id'),
  alerted_at: ts('alerted_at'),
})

// The last test of each provider (LIN-141): whether it passed, for exactly the keys in effect then, whoever ran it (an
// admin, the setup agent, the free check when a setup page opens, the background health check). `keys` is an HMAC of those values keyed with
// SECRETS_KEY, so a changed key reads as untested again and nothing about a key can be learned from it. Every setup
// screen reads it (apps/api/src/setup-checklist.ts), so they agree and a restart forgets nothing. Install-wide, not synced.
export const provider_tests = pgTable('provider_tests', {
  provider: text('provider').primaryKey(),
  keys: text('keys').notNull(),
  ok: boolean('ok').notNull(),
  message: text('message').notNull(),
  tested_at: ts('tested_at').notNull().defaultNow(),
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

// An assistant's webhook (apps/api/src/webhooks.ts): one address per assistant, sent the hooks it has on
// (at the start of a call, during it, after it). Synced: holds no secret; the signing secret is in webhook_secrets.
// `failure_count`: requests in a row that failed (after every retry).
export const webhook_endpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    workspace_id: workspaceId(),
    /** Null only on endpoints from before webhooks were per assistant (0062): those receive nothing. */
    assistant_id: text('assistant_id').references(() => assistants.id, { onDelete: 'cascade' }),
    /** The hooks it gets (WebhookHook); none: it gets nothing, like switched off. */
    hooks: jsonb('hooks').$type<WebhookHook[]>().notNull().default([]),
    /** What the assistant can ask it during a call (the `during_call` hook); none: nothing. */
    lookups: jsonb('lookups').$type<WebhookLookup[]>().notNull().default([]),
    url: text('url').notNull(),
    /** @deprecated events are gone (each hook sends one thing); kept for the release before, dropped later. */
    events: jsonb('events').$type<WebhookEvent[]>().notNull().default([]),
    /** `disabled`: by a member, or by the API after too many failed deliveries (`disabled_reason`). */
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    disabled_reason: text('disabled_reason'),
    failure_count: integer('failure_count').notNull().default(0),
    last_delivery_at: ts('last_delivery_at'),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('webhook_endpoints_ws').on(t.workspace_id),
    uniqueIndex('webhook_endpoints_assistant').on(t.assistant_id),
  ],
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
    status: text('status', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** The endpoint's HTTP status of the last attempt; null when there was no answer. */
    response_status: integer('response_status'),
    error: text('error'),
    last_attempt_at: ts('last_attempt_at'),
    created_at: createdAt(),
  },
  t => [index('webhook_deliveries_endpoint').on(t.endpoint_id, t.created_at)],
)

// A member closed the go-live checklist in the inbox (onboarding.dismissGoLiveChecklist): it stays closed for them
// in this workspace, in every browser, until they reopen it from the command menu. Not synced; read through
// onboarding.goLiveChecklist, only the caller's own row.
export const golive_checklist_dismissals = pgTable(
  'golive_checklist_dismissals',
  {
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id').notNull(),
    dismissed_at: ts('dismissed_at').notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.user_id] })],
)

// A go-live step set aside (onboarding.skipGoLiveStep, onboarding.remindGoLiveStep, onboarding.restoreGoLiveStep).
// user_id null: the whole workspace's row, only `skipped` ("Not needed") of a workspace-scoped step: every owner and
// admin stops seeing it. user_id set: one person's row, a `later` (back for them at `until`) or the `skipped` of a
// person-scoped step (goLiveStepScope in @linedesk/actions: push is about their own devices).
// Not synced; read through onboarding.goLiveChecklist (the workspace's rows and the caller's own).
export const golive_checklist_steps = pgTable(
  'golive_checklist_steps',
  {
    id: id(),
    workspace_id: workspaceId(),
    step: text('step').notNull(),
    state: text('state', { enum: ['skipped', 'later'] }).notNull(),
    /** Whose row it is: a `later`, or the `skipped` of a person-scoped step; null for the whole workspace. */
    user_id: text('user_id'),
    /** When a `later` step comes back; null for `skipped`. */
    until: ts('until'),
    /** Who skipped it or put it off. */
    by_user_id: text('by_user_id').notNull(),
    created_at: createdAt(),
  },
  t => [
    uniqueIndex('golive_checklist_steps_workspace').on(t.workspace_id, t.step).where(sql`${t.user_id} is null`),
    uniqueIndex('golive_checklist_steps_person')
      .on(t.workspace_id, t.user_id, t.step, t.state)
      .where(sql`${t.user_id} is not null`),
  ],
)

/** Tables that read sync delivers to clients, filtered by workspace_id. */
export const syncedTables = {
  calls,
  contacts,
  assistants,
  phone_numbers,
  transcript_segments,
  appointment_types,
  bookings,
  calendar_connections,
  assistant_calendars,
  webhook_endpoints,
  workspace_members,
  call_events,
  knowledge_documents,
  knowledge_questions,
} as const

// A member's answer to the GitHub star prompt (apps/api/src/star-prompt.ts): once answered, it is
// never shown to them again, in any browser. Not synced; one row per user, not per workspace.
export const star_prompts = pgTable('star_prompts', {
  user_id: text('user_id').primaryKey(),
  /** starred: through Linedesk (github.star); opened: went to the repository page; dismissed: No thanks or closed. */
  answer: text('answer', { enum: ['starred', 'opened', 'dismissed'] }).notNull(),
  answered_at: ts('answered_at').notNull().defaultNow(),
})

/**
 * The setup milestones a business reaches on its way to its first real call, in order of the usual setup.
 * `forwarding_instructions_shown` is the only one the web app reports (onboarding.recordEvent); the API
 * records the others where they happen (apps/api/src/setup-events.ts).
 */
export const setupEventKinds = [
  'signup',
  'business_found',
  'assistant_heard',
  'mobile_added',
  'number_connected',
  'forwarding_instructions_shown',
  'forwarding_verified',
  'onboarding_done',
  'onboarding_skipped',
  'first_real_call',
  'activated',
] as const
export type SetupEventKind = (typeof setupEventKinds)[number]

// When a workspace first reached each setup milestone (onboarding funnel, time to first real call). Only the
// first time counts: one row per workspace and milestone, never updated. Not synced to browsers.
export const setup_events = pgTable(
  'setup_events',
  {
    workspace_id: workspaceId(),
    event: text('event', { enum: setupEventKinds }).notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  t => [
    primaryKey({ columns: [t.workspace_id, t.event] }),
    // The setup emails job looks up recent sign-ups every few minutes (apps/api/src/setup-emails.ts).
    index('setup_events_signup_at').on(t.at).where(sql`event = 'signup'`),
  ],
)

/** The setup emails (apps/api/src/setup-emails.ts): days after sign-up, the first real call, the first week. */
export const setupEmailKinds = ['setup_day0', 'setup_day1', 'setup_day3', 'first_call', 'week_summary'] as const
export type SetupEmailKind = (typeof setupEmailKinds)[number]

// Setup emails a workspace got: each goes out at most once per workspace. Not synced to browsers.
export const setup_emails = pgTable(
  'setup_emails',
  {
    workspace_id: workspaceId(),
    kind: text('kind', { enum: setupEmailKinds }).notNull(),
    sent_at: ts('sent_at').notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.kind] })],
)

/**
 * What a forwarding check found: `dialing` while it runs; `works` (our call arrived on the Linedesk number),
 * `rang_through` (rang the business phone, never forwarded), `answered` (picked up before it forwarded: voicemail or
 * a person), `busy`, `unreachable`, or `not_checked` (it could not run: no carrier, no number to call from).
 */
// forwards_elsewhere: the call arrived on another Linedesk number than this one. no_assistant: it reached Linedesk (the
// call was answered there) but the assistant never picked it up, so the forwarding works and the agent does not.
export const forwardingCheckStatuses = [
  'dialing',
  'works',
  'rang_through',
  'answered',
  'busy',
  'unreachable',
  'forwards_elsewhere',
  'no_assistant',
  'not_checked',
] as const
export type ForwardingCheckStatus = (typeof forwardingCheckStatuses)[number]

// One automatic test of call forwarding (apps/api/src/forwarding-check.ts): Linedesk calls the business's own number
// from a number of the install and watches whether that call arrives on the workspace's Linedesk number. Not synced:
// the web app reads it through phoneNumber.forwardingCheck while a check runs.
export const forwarding_checks = pgTable(
  'forwarding_checks',
  {
    id: id(),
    workspace_id: workspaceId(),
    phone_number_id: text('phone_number_id').notNull(),
    /** The business's own number that was called; saved as phone_numbers.forwarded_from once a check works. */
    business_number: text('business_number').notNull(),
    /** The workspace's Linedesk number the call should arrive on (phone_numbers.e164). */
    linedesk_number: text('linedesk_number').notNull(),
    /** The install's number the check called from; the arriving call is matched on it. Null until the check dials. */
    caller_number: text('caller_number'),
    /** Run by the development carrier (`dev`): nothing was dialled, so a `works` never verifies the number. */
    simulated: boolean('simulated').notNull().default(false),
    status: text('status', { enum: forwardingCheckStatuses }).notNull().default('dialing'),
    /** Why a check could not run, or what the carrier answered (no secrets): for the owner and the admin. */
    detail: text('detail'),
    created_by: text('created_by'),
    started_at: ts('started_at').notNull().defaultNow(),
    dialed_at: ts('dialed_at'),
    arrived_at: ts('arrived_at'),
    finished_at: ts('finished_at'),
  },
  t => [
    index('forwarding_checks_ws').on(t.workspace_id, t.started_at),
    // Arrivals are matched on our caller number and the time since the dial; limits count by business number.
    index('forwarding_checks_arrival').on(t.caller_number, t.dialed_at),
    index('forwarding_checks_business').on(t.business_number, t.started_at),
  ],
)

/**
 * Carrier line lookups that reached the carrier (phoneNumber.lookupLine; each costs a fraction of a cent), counted
 * for the daily limits per workspace and per install. Not synced to the browser.
 */
export const line_lookups = pgTable(
  'line_lookups',
  {
    id: id(),
    workspace_id: workspaceId(),
    number: text('number').notNull(),
    looked_up_at: ts('looked_up_at').notNull().defaultNow(),
  },
  t => [index('line_lookups_ws').on(t.workspace_id, t.looked_up_at), index('line_lookups_at').on(t.looked_up_at)],
)

// Business lookup imports and searches per UTC day: one row per workspace, and one with workspace_id '' for the whole
// install, so the caps hold across API processes and deploys (apps/api/src/business-import.ts). No foreign key: the
// install row has no workspace; old days are deleted as new ones start. Not synced to browsers.
export const business_lookup_usage = pgTable(
  'business_lookup_usage',
  {
    day: date('day').notNull(),
    workspace_id: text('workspace_id').notNull(),
    requests: integer('requests').notNull().default(0),
  },
  t => [primaryKey({ columns: [t.day, t.workspace_id] })],
)

// The workspace icon (Workspace settings › General; apps/api/src/workspace-icon.ts): a checked PNG of at most
// 512×512 pixels, base64, like the install logo in instance_settings. One row per workspace that has an icon;
// no row: the initial letter shows. `version` changes with every new icon and is part of its address
// (/v1/workspace-icons/<workspace_id>.png?v=<version>), so the image is cached for good. Not synced to browsers:
// the workspace lists of /v1/me carry the address.
export const workspace_icons = pgTable('workspace_icons', {
  workspace_id: text('workspace_id').primaryKey(),
  png: text('png').notNull(),
  version: text('version').notNull(),
  updated_at: ts('updated_at').notNull().defaultNow(),
  updated_by: text('updated_by'),
})

// A person's profile picture (Account settings › Profile; apps/api/src/user-avatar.ts): stored like the workspace
// icon, a checked PNG of at most 512×512 pixels, base64. One row per account that has a picture; no row: the
// initials show. `version` changes with every new picture and is part of its address
// (/v1/avatars/<user_id>.png?v=<version>); triggers copy it into workspace_members.avatar_version, so every member
// of the person's workspaces sees the new picture with the next sync. Not synced itself.
export const user_avatars = pgTable('user_avatars', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  png: text('png').notNull(),
  version: text('version').notNull(),
  updated_at: ts('updated_at').notNull().defaultNow(),
})

// The last change to a person's profile (name, picture) made by someone else: an owner or admin of a workspace they
// are in (team.updateMemberProfile, team.setMemberAvatar, team.removeMemberAvatar). Account settings › Profile says
// "Last changed by <name>". One row per account at most; it goes when the person changes their profile themselves.
export const profile_changes = pgTable('profile_changes', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** The owner or admin who made the change (no foreign key: the entry stays readable as "a teammate" if they go). */
  changed_by: text('changed_by').notNull(),
  /** The workspace whose owner or admin made it. */
  workspace_id: text('workspace_id').notNull(),
  changed_at: ts('changed_at').notNull().defaultNow(),
  /**
   * What the profile was before someone else first changed it, so it can be put back: `name`, and `avatar` (the
   * picture's version and PNG, null: no picture). Only what was changed; later changes by others keep the first value.
   */
  previous: jsonb('previous').$type<ProfileBefore>().notNull().default({}),
})

/** profile_changes.previous. */
export type ProfileBefore = { name?: string; avatar?: { version: string; png: string } | null }
