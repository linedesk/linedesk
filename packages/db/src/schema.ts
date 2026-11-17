// App tables. Property names equal column names (snake_case) so a row has the same shape in
// Postgres, in the API and in the browser (rows arrive there through read sync).
// workspace_id is the Better Auth organization id; every synced table carries it and a `version`
// (global sequence, bumped by trigger on every write) so clients can order row versions.
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
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
import { organization, user } from './auth-schema.ts'
import {
  appErrorCodes,
  DEFAULT_TRANSFERS,
  RECHARGE_CAP_BASE_CENTS,
  RECHARGE_AMOUNT_OVER_THRESHOLD_CENTS,
  RECHARGE_DEFAULTS,
  RECHARGE_LIMITS,
  TOPUP_LIMITS_CENTS,
  PAID_LEVELS,
  USAGE_LEVELS,
  type ActionItem,
  type AssistantLanguages,
  type AssistantVoice,
  type BookingField,
  type BusinessProfile,
  type CallField,
  type CallerDetails,
  type CallVoiceFailure,
  type EmailRoute,
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
    /**
     * The language model of live turns, as the install's language-model provider names it (LANGUAGE_MODEL_LEVELS in
     * @linedesk/actions). null: the install's default model. On Linedesk Cloud its level (Standard or Premium) counts.
     */
    llm_model: text('llm_model'),
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
    max_call_minutes: integer('max_call_minutes').notNull().default(20),
    silence_closing: text('silence_closing'),
    /** Asked when the line is quiet; null: "Are you still there?" in the language spoken (DEFAULT_SILENCE_REMINDER). */
    silence_reminder: text('silence_reminder'),
    /** Said when the caller has nothing else and the assistant hangs up (end_call); null: "Thanks for calling. Goodbye!" in the language spoken (DEFAULT_GOODBYE_LINE). */
    goodbye_line: text('goodbye_line'),
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
    /**
     * The voice while the realtime model answers its calls (REALTIME_VOICE_IDS in @linedesk/actions); '': the server's
     * default voice (Server admin › Providers › OpenAI Realtime). `voice` is the three stages' voice; each keeps its own.
     */
    realtime_voice: text('realtime_voice').notNull().default(''),
    /**
     * The realtime model that answers its calls when `voice_pipeline` is realtime (REALTIME_MODEL_LEVELS in
     * @linedesk/actions, the Ultra level on Linedesk Cloud). null: the server's realtime model.
     */
    realtime_model: text('realtime_model'),
    /**
     * Who gets the email about each finished call, in plain language (call-notifications.ts, email routing). Mentions
     * are stored as `<@user:USER_ID>` and `<@email:ADDRESS>`. null or '': every member with call emails on.
     */
    email_routing: text('email_routing'),
    /**
     * Members a routed call is also assigned to (Settings › Assistant › Call emails, "Assign"): the first of them, in the
     * instruction's order, who gets the call's email, while nobody has the call. Chosen in the settings, never by the
     * model.
     */
    email_assign: jsonb('email_assign').$type<string[]>().notNull().default([]),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('assistants_ws').on(t.workspace_id),
    // ASSISTANT_CALL_MAX_MINUTES (packages/actions/src/calls.ts): seeds and scripts too, not only the API's check.
    check('assistants_max_call_minutes', sql`${t.max_call_minutes} between 1 and 30`),
  ],
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
    /**
     * How the caller's carrier vouched for the caller ID (STIR/SHAKEN, from the SIP INVITE): `A` the carrier knows the
     * caller may use this number; `B`/`C` weaker; `failed` the check failed; `none` no check (calls from outside
     * North America, many forwarded calls). null: not a phone call, or an agent that did not read it.
     */
    caller_attestation: text('caller_attestation', { enum: ['A', 'B', 'C', 'failed', 'none'] }),
    /** The carrier's spam screening marked the call "Spam likely" (Telnyx inbound call screening, flag mode). */
    spam_likely: boolean('spam_likely').notNull().default(false),
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
     * Seconds of this call's on-call legs that have ended (ringing included): each try that was not answered,
     * declined or failed after dialling. The open leg (`dialing`, `connected`) is counted from `transfer_at` on top
     * (outbound-policy.ts, transferMinutesUsed).
     */
    transfer_seconds: integer('transfer_seconds').notNull().default(0),
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
    /**
     * The call's news (email, push, evaluation, after-call webhook and integrations) waits for the after-call
     * transcript until this time (call.finish with awaitTranscript): the agent then sends the summary of the corrected
     * transcript (call.finalize), or the CALL_RELEASE job sends the news with the summary it has. null: nothing waits.
     */
    awaiting_transcript_until: ts('awaiting_transcript_until'),
    /** When call.correctTranscript started on this held call: only one runs, and the CALL_RELEASE job then queues none. */
    transcript_requested_at: ts('transcript_requested_at'),
    /** Who got the email about the call and why (EmailRoute), stored before the emails go out; null: none sent yet. */
    email_route: jsonb('email_route').$type<EmailRoute>(),
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
export const workspace_settings = pgTable(
  'workspace_settings',
  {
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
    /**
     * Linedesk Cloud: the owner allows Premium voices and models (10¢ a minute instead of 5¢; usageLevel in
     * @linedesk/actions). Off: assistants can pick Standard ones only. Not read on an install without billing.
     */
    allow_premium: boolean('allow_premium').notNull().default(false),
    /**
     * Linedesk Cloud: the owner allows Ultra, assistants answered by a realtime model (20¢ a minute; usageLevel in
     * @linedesk/actions). Off: no assistant answers with a realtime model. Not read on an install without billing.
     */
    allow_ultra: boolean('allow_ultra').notNull().default(false),
    /** Recordings older than this many days are deleted by the daily cleanup job. null: keep them. */
    recording_retention_days: integer('recording_retention_days').default(90),
    /** New-call notifications for members who have not set their own (member_notification_settings). */
    notify_email_default: boolean('notify_email_default').notNull().default(true),
    notify_browser_default: boolean('notify_browser_default').notNull().default(true),
    /** The workspace uses its business hours (availability_rules) for calls. Off: the assistant says nothing about hours. */
    business_hours_on: boolean('business_hours_on').notNull().default(false),
    /** The assistant says a recording notice right after the greeting (on by default; no per-state rules). */
    recording_notice_on: boolean('recording_notice_on').notNull().default(true),
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
    /**
     * Where the business is (ISO 3166-1 alpha-2, upper case: "DE"). null: never set, worked out when read
     * (resolveWorkspaceCountry in @linedesk/actions: the assistant's number, the business phone, the holidays, the
     * country hint, the time zone, else US). A workspace made in the app starts with it set.
     * The default region for phone numbers, the forwarding guide, the holiday calendar and the currency.
     */
    country: text('country'),
    /**
     * A guess at the country, saved once when the workspace was made (countryHintOf in @linedesk/actions): the country
     * code a proxy in front of the install sent with the request (CF-IPCountry), else the time zone's country, else the
     * browser language's region. Only the two-letter code; never the address. null: none known.
     * What New workspace prefilled; counts for Automatic after the holidays.
     */
    country_hint: text('country_hint'),
    /** Where country_hint came from. */
    country_hint_source: text('country_hint_source', { enum: ['sign_up_location', 'time_zone', 'browser_language'] }),
    /** The public holiday calendar the workspace follows; null: never set up. */
    holidays: jsonb('holidays').$type<HolidayCalendar>(),
    /** What a booked job is worth on average, in the minor units of job_value_currency (cents; whole units for JPY, KRW and CLP), for Insights ("≈ $X in booked work"). null: not set. */
    job_value_cents: integer('job_value_cents'),
    /** The currency of job_value_cents (ISO 4217, one of jobValueCurrencies in @linedesk/actions). */
    job_value_currency: text('job_value_currency', {
      enum: [
        'USD',
        'AED',
        'ARS',
        'AUD',
        'BRL',
        'CAD',
        'CHF',
        'CLP',
        'CNY',
        'COP',
        'CZK',
        'DKK',
        'EGP',
        'EUR',
        'GBP',
        'HKD',
        'HUF',
        'IDR',
        'ILS',
        'INR',
        'JPY',
        'KES',
        'KRW',
        'MXN',
        'MYR',
        'NGN',
        'NOK',
        'NZD',
        'PEN',
        'PHP',
        'PLN',
        'RON',
        'SAR',
        'SEK',
        'SGD',
        'THB',
        'TRY',
        'TWD',
        'ZAR',
      ],
    })
      .notNull()
      .default('USD'),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    // The hint is only ever a two-letter code with one of the known sources (or neither).
    check('workspace_settings_country_hint', sql`${t.country_hint} ~ '^[A-Z]{2}$'`),
    check(
      'workspace_settings_country_hint_source',
      sql`${t.country_hint_source} in ('sign_up_location', 'time_zone', 'browser_language')`,
    ),
  ],
)

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
    /**
     * `caldav`: connected with a user name and an app-specific password; `calcom`, `calendly`: with an API key or
     * personal token (calendar_credentials holds the login).
     */
    provider: text('provider', { enum: ['google', 'microsoft', 'caldav', 'calcom', 'calendly'] }).notNull(),
    /** The account's address; for a CalDAV login without one, `<user name>@<server host>`. */
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
// A connection by password (CalDAV) keeps its login (JSON: server, user name, password) where the access token goes,
// an empty refresh token and no real expiry (PASSWORD_LOGIN_EXPIRES in apps/api/src/calendar-connections.ts).
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
  provider: text('provider', { enum: ['google', 'microsoft', 'calendly', 'calcom'] }).notNull(),
  code_verifier: text('code_verifier').notNull(),
  expires_at: ts('expires_at').notNull(),
  created_at: createdAt(),
})

// An app connected to a workspace by OAuth (docs/crm-sync.md), one per app. Synced: holds no secret;
// its tokens are in app_credentials, which is never synced.
export const app_connections = pgTable(
  'app_connections',
  {
    id: id(),
    workspace_id: workspaceId(),
    /** The app (connectableApps in @linedesk/actions, APP_IDS in @linedesk/connectors). */
    provider: text('provider', { enum: ['hubspot', 'slack', 'jobber'] }).notNull(),
    /**
     * The account at the app (a HubSpot portal id, a Slack workspace id, a Jobber account id) and its name for the page
     * (the portal's domain, the Slack workspace's name, the Jobber account's name).
     */
    account_id: text('account_id').notNull(),
    account_name: text('account_name').notNull(),
    /** Where in the account calls go, for the page: the Slack channel (`#calls`) picked when connecting; else null. */
    channel: text('channel'),
    /** `needs_attention`: the grant was refused, or calls failed several times in a row; see error_code. */
    status: text('status', { enum: ['connected', 'needs_attention'] })
      .notNull()
      .default('connected'),
    /** Why the last push failed, as a code the page words (the app's own message goes to the server log only). */
    error_code: text('error_code', { enum: appErrorCodes }),
    /** Calls that failed in a row; a call that goes through sets it back to 0. */
    failures: integer('failures').notNull().default(0),
    last_push_at: ts('last_push_at'),
    /** The member who connected the app; text the app gets is in their language. */
    connected_by: text('connected_by').notNull(),
    /**
     * What Linedesk does in the app (APP_SETTINGS in @linedesk/actions): only the switches a member changed, a missing
     * one is on. Changed with app.updateSettings.
     */
    settings: jsonb('settings').$type<Record<string, boolean>>().notNull().default({}),
    created_at: createdAt(),
    version: version(),
  },
  t => [index('app_connections_ws').on(t.workspace_id), unique('app_connections_app').on(t.workspace_id, t.provider)],
)

// OAuth tokens of an app connection, AES-256-GCM with SECRETS_KEY (apps/api/src/secrets.ts). Never synced.
export const app_credentials = pgTable('app_credentials', {
  connection_id: text('connection_id')
    .primaryKey()
    .references(() => app_connections.id, { onDelete: 'cascade' }),
  workspace_id: workspaceId(),
  access_token_encrypted: text('access_token_encrypted').notNull(),
  refresh_token_encrypted: text('refresh_token_encrypted').notNull(),
  expires_at: ts('expires_at').notNull(),
  scope: text('scope'),
  /** Slack: the incoming webhook calls are posted to (its URL is a secret), encrypted like the tokens; else null. */
  webhook_url_encrypted: text('webhook_url_encrypted'),
  updated_at: ts('updated_at').notNull().defaultNow(),
})

// A started app connect: the OAuth `state` (this row's id), for one member in one workspace, used once
// and for ten minutes. Never synced.
export const app_oauth_states = pgTable('app_oauth_states', {
  id: id(),
  workspace_id: workspaceId(),
  user_id: text('user_id').notNull(),
  provider: text('provider', { enum: ['hubspot', 'slack', 'jobber'] }).notNull(),
  expires_at: ts('expires_at').notNull(),
  created_at: createdAt(),
})

// A Linedesk contact's record in a connected CRM (the HubSpot contact id), set by the first push. Never synced.
export const crm_links = pgTable(
  'crm_links',
  {
    id: id(),
    workspace_id: workspaceId(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => app_connections.id, { onDelete: 'cascade' }),
    contact_id: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    external_id: text('external_id').notNull(),
    created_at: createdAt(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [index('crm_links_ws').on(t.workspace_id), unique('crm_links_contact').on(t.connection_id, t.contact_id)],
)

// One finished call sent to a connected app (job app.push in apps/api/src/app-pushes.ts), for retries and the
// app's page. Never synced: the page reads the last ones with app.pushes.
export const app_pushes = pgTable(
  'app_pushes',
  {
    id: id(),
    workspace_id: workspaceId(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => app_connections.id, { onDelete: 'cascade' }),
    call_id: text('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    /**
     * `sending`: a job has claimed it (claimed_at) and is talking to the app; one per connection at a time.
     * `skipped`: the connection's settings said not to send it (error_code says which: calls_off, no_contact).
     */
    status: text('status', { enum: ['pending', 'sending', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    /** Tries started (counted when claimed, so a try that crashed counts too). */
    attempts: integer('attempts').notNull().default(0),
    claimed_at: ts('claimed_at'),
    error_code: text('error_code', { enum: appErrorCodes }),
    /** The caller's record at the app (a HubSpot contact id), saved as soon as it is found or created, so a retry reuses it. */
    record_id: text('record_id'),
    /** The logged call at the app (a HubSpot call engagement id), saved as soon as it exists: a retry never logs it twice. */
    external_id: text('external_id'),
    created_at: createdAt(),
    finished_at: ts('finished_at'),
  },
  t => [
    index('app_pushes_connection').on(t.connection_id, t.created_at),
    unique('app_pushes_call').on(t.connection_id, t.call_id),
    // The sweep (sweepAppPushes) reads only the open ones.
    index('app_pushes_open').on(t.created_at).where(sql`${t.status} in ('pending', 'sending')`),
  ],
)

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
    /**
     * A scheduling tool's event type (Cal.com, Calendly): its length in minutes. Such a calendar is its own appointment
     * type: the tool decides length, availability and rules; Linedesk's appointment types and hours do not apply. Null
     * for a plain calendar (Google, Microsoft, CalDAV).
     */
    duration_min: integer('duration_min'),
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
    /** The instance admin who made it while signed in as `created_by` (impersonation), else null. */
    created_by_impersonator: text('created_by_impersonator'),
    created_at: createdAt(),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
  },
  t => [index('api_keys_ws').on(t.workspace_id)],
)

// Personal API keys (LIN-339): a key a person makes for themselves, for the CLI, MCP clients and scripts. It acts
// exactly as its maker does today, in every workspace they belong to (apps/api/src/personal-keys.ts). Not synced, not
// per workspace; stored as a SHA-256 hash like api_keys.
export const personal_keys = pgTable(
  'personal_keys',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The key's first characters ("ldp_AbCd1234"), to tell keys apart; not enough to use one. */
    prefix: text('prefix').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    /**
     * Made in a session that passed the passkey check (an instance admin's Server admin check): only such a key
     * carries instance:admin, as only such a session does (context.ts).
     */
    passkey_confirmed: boolean('passkey_confirmed').notNull().default(false),
    /**
     * The MCP client this key was issued to by OAuth sign-in (LIN-126): its client_id (oauth_clients.client_id, or the
     * https URL of its metadata document). Null: made in the app. Such a key never carries Server admin.
     */
    oauth_client_id: text('oauth_client_id'),
    created_at: createdAt(),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
  },
  t => [index('personal_keys_user').on(t.user_id)],
)

// MCP clients that registered themselves (OAuth Dynamic Client Registration, RFC 7591; LIN-126, apps/api/src/oauth.ts).
// Clients known by a metadata document URL (client_id is the URL) are not stored here. Not synced.
export const oauth_clients = pgTable('oauth_clients', {
  client_id: text('client_id').primaryKey(),
  /** The name it registered with (client_name), shown on the consent page next to its redirect host. */
  name: text('name').notNull(),
  /** Exact redirect URIs: https, loopback http or a custom scheme (cursor://, vscode://). */
  redirect_uris: jsonb('redirect_uris').$type<string[]>().notNull(),
  /** none (public client with PKCE), client_secret_post or client_secret_basic. */
  auth_method: text('auth_method').notNull(),
  /** SHA-256 of the client secret, for confidential clients only. */
  secret_hash: text('secret_hash'),
  created_at: createdAt(),
})

// Authorization codes (LIN-126): single use, 10 minutes, bound to the client, redirect URI, PKCE challenge, user and
// resource. Stored as a SHA-256 hash. The personal key issued with a code is noted, so a reused code revokes it.
export const oauth_codes = pgTable(
  'oauth_codes',
  {
    code_hash: text('code_hash').primaryKey(),
    client_id: text('client_id').notNull(),
    /** The client's name at consent: the issued key's name. */
    client_name: text('client_name').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    redirect_uri: text('redirect_uri').notNull(),
    code_challenge: text('code_challenge').notNull(),
    resource: text('resource'),
    personal_key_id: text('personal_key_id'),
    created_at: createdAt(),
    expires_at: ts('expires_at').notNull(),
    used_at: ts('used_at'),
  },
  t => [index('oauth_codes_expires').on(t.expires_at)],
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
    /**
     * HMAC-SHA256 (key derived from the server secret) of the parsed input with its sensitive fields redacted, as
     * canonical JSON: a reused idempotency key with other input is refused, never answered with the first result
     * (security reviews of #1115, L-1, and #1116, M-1). Null on rows from before, and once the row is pruned.
     */
    input_hash: text('input_hash'),
    result: jsonb('result').notNull(),
    rejected: boolean('rejected').notNull().default(false),
    /** The instance admin who did this while signed in as `actor_id` (impersonation); null otherwise. */
    impersonated_by: text('impersonated_by'),
    /** The agent setup key (agent_setup_keys.id) this was done with: an AI agent acting as `actor_id`; null otherwise. */
    setup_key_id: text('setup_key_id'),
    /** The personal API key (personal_keys.id) this was done with: the CLI, an MCP client or a script as `actor_id`. */
    personal_key_id: text('personal_key_id'),
    created_at: createdAt(),
    /** When input and result were cut down to ids: 90 days on, or when the call or contact was deleted (apps/api/src/command-log.ts). */
    pruned_at: ts('pruned_at'),
  },
  t => [
    // The daily prune finds old commands not yet pruned; deleting a call or contact finds the commands naming it.
    index('commands_unpruned_created').on(t.created_at).where(sql`${t.pruned_at} is null`),
    index('commands_unpruned_input').using('gin', t.input.op('jsonb_path_ops')).where(sql`${t.pruned_at} is null`),
    index('commands_unpruned_result').using('gin', t.result.op('jsonb_path_ops')).where(sql`${t.pruned_at} is null`),
    // Server admin › Audit log (apps/api/src/audit.ts): the audited actions, impersonation and setup-link entries.
    index('commands_action_created').on(t.action, t.created_at),
    index('commands_impersonated_created').on(t.created_at).where(sql`${t.impersonated_by} is not null`),
    index('commands_setup_key_created').on(t.created_at).where(sql`${t.setup_key_id} is not null`),
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

// Usage-limit emails already sent (apps/api/src/usage-limit.ts): one row per workspace, billing period and level (80
// or 100 percent), so each goes out once a period. Not synced to browsers.
export const usage_limit_alerts = pgTable(
  'usage_limit_alerts',
  {
    workspace_id: text('workspace_id').notNull(),
    period_id: text('period_id').notNull(),
    level: integer('level').notNull(),
    created_at: createdAt(),
  },
  t => [primaryKey({ columns: [t.workspace_id, t.period_id, t.level] })],
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
        // A new account made by a sign-in that ended up in no workspace (its invitation went away) and was deleted.
        'sign_up_undone',
        'call_routing_reset',
        // A pending invitation whose sender's account was deleted, passed to the workspace's owner. method: the
        // invited address; user: the deleted account (its `email` here becomes 'deleted' with the account, by the
        // 0026 trigger, like all its events; the invited address in `method` stays); subject_id: the owner it passed to.
        'invitation_reassigned',
        // A pending invitation canceled because its sender was removed from the workspace (team.removeMember,
        // membership.remove; LIN-264 review F1). method: the invited address; user: the removed sender.
        'invitation_withdrawn',
      ],
    }).notNull(),
    /**
     * sign_in / sign_up / provider_linked: password, email_code, passkey, google, microsoft, github, oidc.
     * email_changed: the new address (`email` keeps the old one).
     */
    method: text('method'),
    workspace_id: text('workspace_id'),
    /**
     * Another account the event is about, by id (no address kept here: the audit log reads it while the account
     * exists). invitation_reassigned: the owner the invitation passed to.
     */
    subject_id: text('subject_id'),
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
  /** A workspace key's maker is no longer that workspace's owner (handed over, or found so on use). */
  | 'owner_lost'
  /** A workspace key's workspace was disabled. */
  | 'workspace_disabled'
  /** The maker changed or set their password. */
  | 'password_changed'
  /** The maker signed out their other sessions. */
  | 'sessions_ended'
  /** The session that made the key ended (signed out, signed out from another device, expired). */
  | 'session_ended'
  /** A workspace key's maker got another role in that workspace (an admin made a member, or the owner). */
  | 'role_changed'
  /** A workspace key's maker left the workspace or was removed from it. */
  | 'left_workspace'
export const agent_setup_keys = pgTable(
  'agent_setup_keys',
  {
    id: id(),
    /** The key's first characters ("lds_AbCd1234"), to tell keys apart; not enough to use one. */
    prefix: text('prefix').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    /** The instance admin who made it (or, with workspace_id, the workspace's owner); the key acts as this user. */
    created_by: text('created_by').notNull(),
    /**
     * Null: an install key, made by an instance admin (the server's providers and every workspace they manage). Set: a
     * workspace key, made by that workspace's owner (agentSetup.createWorkspaceKey): only this workspace's own setup,
     * never the server's or another workspace's (apps/api/src/agent-setup.ts setupKeyAccess, setupActorIn).
     */
    // Its keys go with a deleted workspace.
    workspace_id: text('workspace_id').references(() => organization.id, { onDelete: 'cascade' }),
    /**
     * A workspace key's maker's role there when it was made ('owner' or 'admin'; null for an install key). The key acts
     * with that role only while the maker still has exactly it: a role change ends the key for good
     * (apps/api/src/agent-setup.ts workspaceSetupActor).
     */
    role: text('role').$type<'owner' | 'admin'>(),
    /**
     * The sign-in session that made the key (Better Auth session.id). The key ends for good once that session ends:
     * signed out, signed out from another device, expired or revoked (agent-setup.ts setupKeyAccess).
     */
    session_id: text('session_id'),
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
     * Until when the key carries its maker's passkey check (apps/api/src/agent-setup.ts keyPasskeyConfirmed): its
     * expiry when the session that made it had passed the check, null when it had not (ADMIN_SECOND_FACTOR=off). While
     * the rule is on, a key without it does not work. Rows from #694's Allow step keep their own time.
     */
    passkey_confirmed_until: ts('passkey_confirmed_until'),
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

// The instance admin's own wording for parts of the assistant's system prompt (LIN-346; Server admin › System prompt):
// one row per edited part, keyed like PROMPT_TEXTS in packages/actions/src/prompt-texts.ts. A part without a row reads
// its default from the code. `default_text`: the default when the row was saved, so the admin sees when it changed.
// Install-wide, not synced; apps/api/src/system-prompt.ts.
export const prompt_overrides = pgTable('prompt_overrides', {
  key: text('key').primaryKey(),
  text: text('text').notNull(),
  default_text: text('default_text').notNull(),
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

// A subscription an integration (Zapier) made with a workspace API key: it gets `event` POSTed to `target_url`
// (docs/api.md, Integrations; apps/api/src/integrations.ts). Separate from the assistants' webhooks, which only
// owners and admins set in the app: a key may only subscribe a URL on the integration's own host. Goes when its
// key is revoked or the integration unsubscribes; a key that stops working sends nothing. Never synced; read with
// integration.list.
export const integration_subscriptions = pgTable(
  'integration_subscriptions',
  {
    id: id(),
    workspace_id: workspaceId(),
    api_key_id: text('api_key_id')
      .notNull()
      .references(() => api_keys.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['zapier'] }).notNull(),
    event: text('event', { enum: ['call_finished', 'call_started', 'during_call_lookup'] }).notNull(),
    target_url: text('target_url').notNull(),
    /** `disabled`: by the API after too many failed deliveries (`disabled_reason`). */
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    disabled_reason: text('disabled_reason'),
    failure_count: integer('failure_count').notNull().default(0),
    last_delivery_at: ts('last_delivery_at'),
    created_at: createdAt(),
  },
  t => [index('integration_subscriptions_ws').on(t.workspace_id)],
)

// One event sent (or being sent) to one endpoint or integration subscription: the delivery log. Never synced; read
// with webhook.deliveries. Exactly one of `endpoint_id` and `subscription_id` is set.
export const webhook_deliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    workspace_id: workspaceId(),
    /** Null for an integration subscription's delivery (`subscription_id`). */
    endpoint_id: text('endpoint_id').references(() => webhook_endpoints.id, { onDelete: 'cascade' }),
    subscription_id: text('subscription_id').references(() => integration_subscriptions.id, { onDelete: 'cascade' }),
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
  app_connections,
  assistant_calendars,
  webhook_endpoints,
  workspace_members,
  call_events,
  knowledge_questions,
} as const

/**
 * Email addresses outside the team that an assistant's call email instruction may name (`<@email:ADDRESS>`). An
 * address gets call emails only after it confirmed (the link in the confirmation email) and until it stops them
 * (the link in every call email, or List-Unsubscribe). Not synced: read through emailRouting.get (owners and admins).
 */
export const email_recipients = pgTable(
  'email_recipients',
  {
    id: id(),
    workspace_id: workspaceId(),
    /** Lowercased. */
    email: text('email').notNull(),
    label: text('label'),
    confirmed_at: ts('confirmed_at'),
    stopped_at: ts('stopped_at'),
    /** sha256 of the confirmation link's token (never the token); null once confirmed. */
    confirm_token_hash: text('confirm_token_hash'),
    confirm_expires_at: ts('confirm_expires_at'),
    confirm_sent_at: ts('confirm_sent_at'),
    /** emailRecipient.remove; emailRecipient.restore undoes it. Removed rows never get a call email. */
    removed_at: ts('removed_at'),
    added_by: text('added_by').notNull(),
    created_at: createdAt(),
    version: version(),
  },
  t => [
    index('email_recipients_ws').on(t.workspace_id),
    unique('email_recipients_ws_email').on(t.workspace_id, t.email),
    uniqueIndex('email_recipients_token').on(t.confirm_token_hash),
  ],
)

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

// The browsers in which a server admin passed the passkey check (apps/api/src/admin-alerts.ts): only a check from a
// browser not listed here emails every server admin. The browser keeps a random token in a long-lived cookie; only its
// SHA-256 is stored, one row per admin and browser. Cleared cookie: the browser counts as new again. Not synced.
export const admin_devices = pgTable(
  'admin_devices',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the browser's device token. */
    device_hash: text('device_hash').notNull(),
    created_at: createdAt(),
    last_seen_at: ts('last_seen_at').notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.user_id, t.device_hash] })],
)

/**
 * An instance admin's authenticator app (TOTP, RFC 6238): the alternative to the passkey for Server admin
 * (apps/api/src/authenticator.ts). One per admin. `secret` is encrypted with SECRETS_KEY; `confirmed_at` is null while
 * it is being added (the first code from the app confirms it). `last_step` is the 30-second step of the last code
 * accepted, so a code works once. Wrong codes count up to a short lock (`locked_until`).
 */
export const admin_authenticators = pgTable('admin_authenticators', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  confirmed_at: ts('confirmed_at'),
  last_step: bigint('last_step', { mode: 'number' }),
  failed_attempts: integer('failed_attempts').notNull().default(0),
  locked_until: ts('locked_until'),
  created_at: createdAt(),
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

// Sign-in attempts per account across every IP (apps/api/src/sign-in-limits.ts): code emails asked for (`code_request`)
// and wrong codes (`code_failure`; those sent from a browser that signed in to the account before also as
// `known_browser_failure`, LIN-442), counted per clock hour. Only for addresses of existing accounts, so the number of
// rows stays bounded, and in the database, so a restart, a second API process or a flood of other addresses does not
// reset them. Rows older than a day go when the account counts its next one. Not synced to browsers.
export const sign_in_counters = pgTable(
  'sign_in_counters',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['code_request', 'code_failure', 'known_browser_failure'] }).notNull(),
    hour: ts('hour').notNull(),
    count: integer('count').notNull().default(0),
  },
  t => [primaryKey({ columns: [t.user_id, t.kind, t.hour] })],
)

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

// --- Billing (Linedesk Cloud; docs/billing.md §4) ---
// Not synced to browsers; read through read-only actions. Usage and extra numbers are paid from a prepaid
// balance per bill, recharged automatically (decision 14). Amounts in US micro-dollars (`bigint`, 1 USD =
// 1,000,000) unless the column says cents. A bill spans workspaces and the ledger is a financial record, so
// nothing here is deleted with a workspace (KEPT_TABLES in apps/api/src/workspace-delete.ts).
// Lock order, for every transaction that touches a bill: its `billing_balances` row first (`SELECT … FOR UPDATE`),
// then `billing_recharges`, then `usage_counters`. The ledger and reservation triggers update the balance row, so a
// transaction that inserts an entry or a reservation locks the balance row first, before any counter row.
const micros = (name: string) => bigint(name, { mode: 'number' })
/** The database's own check of a text enum (drizzle's `enum` is checked only in TypeScript). */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map(v => `'${v}'`).join(', '))})`
const BILLING_INTERVALS = ['month', 'year'] as const
const PERIOD_KINDS = ['trial', 'month'] as const
// The usage levels of `LEVEL_PRICES` plus `own_keys` (decision 15); a new level there regenerates this CHECK.
// `fixed_5c` and `cost_plus_10` are the 0107 values, still allowed (expand-only) but no longer written.
const PRICE_BASES = [...USAGE_LEVELS, 'fixed_5c', 'cost_plus_10'] as const
const INVOICE_KINDS = ['subscription', 'recharge', 'topup'] as const
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const
const ALERT_KINDS = [
  'recharge_failed',
  'recharge_cap_reached',
  'low_balance',
  'renewal_reminder',
  'trial_will_end',
  // PR 10/11 (migration 0126): an extra number whose month is unpaid, the dunning steps of an unpaid plan invoice,
  // and the numbers of a canceled bill (the release date, then the release).
  'number_unpaid',
  'dunning',
  'numbers_release',
  'numbers_released',
] as const
const RECHARGE_STATUSES = ['pending', 'paid', 'failed', 'canceled'] as const

export const BILLING_KINDS = ['cloud', 'partner'] as const
/** Why a bill is suspended (`billing_accounts.suspend_reason`). */
export const SUSPEND_REASONS = ['admin', 'payment', 'dispute', 'early_fraud_warning'] as const
/** The most calls at once an instance admin may allow one bill (`billing_accounts.concurrent_calls_cap`). */
export const CONCURRENT_CALLS_CAP_MAX = 1000
/** Why a bill got no trial at Checkout (docs/billing.md §3.2 step 4). */
export const TRIAL_REFUSALS = ['card_used', 'prepaid'] as const
export const BILLING_STATUSES = [
  'pending_payment',
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
  'comped',
] as const
/** The statuses an admin suspension can come from (`billing_accounts.suspended_from`): not suspended or canceled. */
export const SUSPENDED_FROM = ['pending_payment', 'trialing', 'active', 'past_due', 'comped'] as const

/**
 * A bill: one Stripe customer and subscription (the plan fee, charged in advance), paying for one or more
 * workspaces (`organization.billing_account_id`), with one prepaid balance (`billing_balances`). The monthly
 * recharge cap in effect is computed, never stored: `rechargeCapCents(recharge_cap_base_cents, workspaces)`.
 */
export const billing_accounts = pgTable(
  'billing_accounts',
  {
    id: id(),
    kind: text('kind', { enum: BILLING_KINDS }).notNull(),
    /** The user who pays; no foreign key, so the bill outlives the account. */
    owner_user_id: text('owner_user_id').notNull(),
    status: text('status', { enum: BILLING_STATUSES }).notNull().default('pending_payment'),
    interval: text('interval', { enum: BILLING_INTERVALS }).notNull().default('month'),
    stripe_customer_id: text('stripe_customer_id').unique(),
    stripe_subscription_id: text('stripe_subscription_id').unique(),
    trial_ends_at: ts('trial_ends_at'),
    current_period_start: ts('current_period_start'),
    current_period_end: ts('current_period_end'),
    /**
     * The subscription's billing cycle anchor (Stripe's `billing_cycle_anchor`): the bill's months are counted from it,
     * its day clamped in short months. Never `current_period_start`, which is already clamped (Feb 28 for an anchor on
     * the 31st), so months counted from it drift and leave stub periods (security review of #879, M1).
     */
    billing_anchor: ts('billing_anchor'),
    /** Auto-recharge, on by default: below the threshold the saved card is charged the amount. Off: "Buy minutes" only. */
    auto_recharge: boolean('auto_recharge').notNull().default(true),
    recharge_threshold_cents: integer('recharge_threshold_cents').notNull().default(RECHARGE_DEFAULTS.thresholdCents),
    recharge_amount_cents: integer('recharge_amount_cents').notNull().default(RECHARGE_DEFAULTS.amountCents),
    /** The owner's monthly recharge cap base ($50 default); the cap in effect adds $25 per further workspace. */
    recharge_cap_base_cents: integer('recharge_cap_base_cents').notNull().default(RECHARGE_CAP_BASE_CENTS),
    /** The last auto-recharge failed (card declined, needs action); cleared by the next successful one. */
    recharge_failed_at: ts('recharge_failed_at'),
    held_for_review_at: ts('held_for_review_at'),
    /**
     * When `billing.confirmCheckout` checked the trial's card (docs/billing.md §3.2 step 4: fingerprint, funding, Radar)
     * and moved the bill out of `pending_payment`. Its own fact (security review of #876, M1): a stored subscription is
     * not a confirmed Checkout, since the webhook links one before the checks ran.
     */
    checkout_confirmed_at: ts('checkout_confirmed_at'),
    /**
     * Why the bill gets no trial (§3.2 step 4): `card_used`, the card already had a trial on another bill; `prepaid`, a
     * prepaid card. Its trial subscription was canceled at once; the owner starts the plan with a new Checkout.
     */
    trial_refused: text('trial_refused', { enum: TRIAL_REFUSALS }),
    /** Radar's risk level of the trial's card check; anything but `normal` holds number purchase for review. */
    card_risk_level: text('card_risk_level'),
    /** The subscription ends at the trial or period end (`billing.cancel`; `billing.resume` undoes it until then). */
    cancel_at_period_end: boolean('cancel_at_period_end').notNull().default(false),
    past_due_since: ts('past_due_since'),
    suspended_at: ts('suspended_at'),
    /**
     * Why the bill is suspended (null while it is not): `admin` (Server admin › Billing; only an instance admin lifts
     * it, never a payment), `payment` (dunning), `dispute`, `early_fraud_warning` (docs/billing.md §3.4, review of #865 N1).
     */
    suspend_reason: text('suspend_reason', { enum: SUSPEND_REASONS }),
    /**
     * The status an instance admin's suspension came from (Server admin › Billing; null otherwise): resume goes back to
     * it, so a bill waiting for Checkout or past due is not made active by suspend and resume (re-review of #919, R3).
     */
    suspended_from: text('suspended_from', { enum: SUSPENDED_FROM }),
    /** Calls at once an instance admin set for this bill (Server admin › Billing); null: the rules' cap (§4.4). */
    concurrent_calls_cap: integer('concurrent_calls_cap'),
    /**
     * Extra calls at once already paid for this subscription period (LIN-450, security review of #1103, M-1): the
     * highest extra-calls quantity of the bill until `extra_calls_paid_until` (the period end it was paid for). Going
     * back up to it in the same period is not charged again; a new period starts from what the renewal charged.
     */
    extra_calls_paid: integer('extra_calls_paid').notNull().default(0),
    extra_calls_paid_until: ts('extra_calls_paid_until'),
    canceled_at: ts('canceled_at'),
    /** The failed plan invoice is the first after the trial: 3 days of grace instead of 7 (decision 9). */
    past_due_first_payment: boolean('past_due_first_payment').notNull().default(false),
    created_at: createdAt(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    index('billing_accounts_owner').on(t.owner_user_id),
    check('billing_accounts_kind', oneOf(t.kind, BILLING_KINDS)),
    check('billing_accounts_status', oneOf(t.status, BILLING_STATUSES)),
    check('billing_accounts_interval', oneOf(t.interval, BILLING_INTERVALS)),
    check(
      'billing_accounts_trial_refused',
      sql`${t.trial_refused} is null or ${t.trial_refused} in ('card_used', 'prepaid')`,
    ),
    check('billing_accounts_recharge_cap_base', sql`${t.recharge_cap_base_cents} >= 0`),
    check(
      'billing_accounts_suspend_reason',
      sql`${t.suspend_reason} is null or ${oneOf(t.suspend_reason, SUSPEND_REASONS)}`,
    ),
    // A suspended bill always says why (security review of #919, L1): a suspension path that forgets its reason fails
    // here instead of being lifted by the next paid invoice.
    check('billing_accounts_suspended_reason', sql`${t.status} <> 'suspended' or ${t.suspend_reason} is not null`),
    check(
      'billing_accounts_suspended_from',
      sql`${t.suspended_from} is null or ${oneOf(t.suspended_from, SUSPENDED_FROM)}`,
    ),
    check('billing_accounts_extra_calls_paid', sql`${t.extra_calls_paid} >= 0`),
    check(
      'billing_accounts_concurrent_calls_cap',
      sql`${t.concurrent_calls_cap} is null or ${t.concurrent_calls_cap} between 1 and ${sql.raw(String(CONCURRENT_CALLS_CAP_MAX))}`,
    ),
    check(
      'billing_accounts_recharge_threshold',
      sql`${t.recharge_threshold_cents} between ${sql.raw(String(RECHARGE_LIMITS.thresholdCents.min))} and ${sql.raw(String(RECHARGE_LIMITS.thresholdCents.max))}`,
    ),
    check(
      'billing_accounts_recharge_amount',
      sql`${t.recharge_amount_cents} between ${sql.raw(String(RECHARGE_LIMITS.amountCents.min))} and ${sql.raw(String(RECHARGE_LIMITS.amountCents.max))}`,
    ),
    // One recharge lifts the balance clear of the threshold, so a drop never sets off charges back to back.
    check(
      'billing_accounts_recharge_over_threshold',
      sql`${t.recharge_amount_cents} >= ${t.recharge_threshold_cents} + ${sql.raw(String(RECHARGE_AMOUNT_OVER_THRESHOLD_CENTS))}`,
    ),
  ],
)

/** A bill's periods: the trial, then months (yearly bills get monthly sub-periods from the anchor day). */
export const billing_periods = pgTable(
  'billing_periods',
  {
    id: id(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    starts_at: ts('starts_at').notNull(),
    ends_at: ts('ends_at').notNull(),
    kind: text('kind', { enum: PERIOD_KINDS }).notNull(),
    closed_at: ts('closed_at'),
    created_at: createdAt(),
  },
  t => [
    unique('billing_periods_start').on(t.billing_account_id, t.starts_at),
    check('billing_periods_kind', oneOf(t.kind, PERIOD_KINDS)),
    check('billing_periods_range', sql`${t.ends_at} > ${t.starts_at}`),
  ],
)

/**
 * usage: a call; number: an extra number's month (`source_id` = `<phone number id>:<period id>`, so each month posts
 * once); recharge: an automatic charge (`source_id` = the billing_recharges id); topup: "Buy minutes" (the Checkout
 * session); refund: a Stripe refund (its id); writeoff: forgiving a negative balance, so it is ≥ 0.
 */
export const LEDGER_KINDS = [
  'usage',
  'number',
  'recharge',
  'topup',
  'refund',
  'credit',
  'adjustment',
  'writeoff',
] as const
export const LEDGER_SOURCES = [
  'call',
  'phone_number',
  'billing_recharge',
  'stripe_checkout',
  'stripe_refund',
  'admin',
  'job',
] as const

/**
 * The ledger of a bill's prepaid balance, append-only: a trigger (migration 0107) refuses UPDATE, DELETE and
 * TRUNCATE. It guards against bugs, not against someone with the table owner's SQL (who can disable it). `amount_micros` is signed: + adds to the balance (recharge, top-up, credit), −
 * takes from it (usage, numbers, refunds). Corrections are new `adjustment` entries pointing at the entry
 * they correct. Posting the same (source_type, source_id, kind) twice is refused by the unique key.
 */
export const ledger_entries = pgTable(
  'ledger_entries',
  {
    id: id(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    /** The workspace the entry is for; null for bill-wide entries (recharges, top-ups). No foreign key: kept after a workspace is deleted. */
    workspace_id: text('workspace_id'),
    period_id: text('period_id')
      .notNull()
      .references(() => billing_periods.id),
    created_at: createdAt(),
    kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
    amount_micros: micros('amount_micros').notNull(),
    /** Usage only: the call's seconds, the part inside the included minutes and the part billed. */
    seconds: integer('seconds'),
    included_seconds: integer('included_seconds'),
    billable_seconds: integer('billable_seconds'),
    /** What the call or number cost Linedesk (partner usage, margin reports). */
    cost_micros: micros('cost_micros'),
    price_basis: text('price_basis', { enum: PRICE_BASES }),
    rate_card_version: text('rate_card_version'),
    source_type: text('source_type', { enum: LEDGER_SOURCES }).notNull(),
    source_id: text('source_id').notNull(),
    /** The entry an adjustment corrects, of the same bill (composite foreign key). */
    reverses_entry_id: text('reverses_entry_id'),
    /** Who caused it (a user, or null for jobs and webhooks). */
    actor_id: text('actor_id'),
    note: text('note'),
  },
  t => [
    unique('ledger_entries_source').on(t.source_type, t.source_id, t.kind),
    unique('ledger_entries_bill_entry').on(t.id, t.billing_account_id),
    foreignKey({
      name: 'ledger_entries_reverses_same_bill',
      columns: [t.reverses_entry_id, t.billing_account_id],
      foreignColumns: [t.id, t.billing_account_id],
    }),
    check('ledger_entries_kind', oneOf(t.kind, LEDGER_KINDS)),
    check('ledger_entries_source_type', oneOf(t.source_type, LEDGER_SOURCES)),
    check('ledger_entries_price_basis', sql`${t.price_basis} is null or ${oneOf(t.price_basis, PRICE_BASES)}`),
    check(
      'ledger_entries_kind_source',
      sql`(${t.kind} = 'usage' and ${t.source_type} = 'call') or (${t.kind} = 'number' and ${t.source_type} = 'phone_number') or (${t.kind} = 'recharge' and ${t.source_type} = 'billing_recharge') or (${t.kind} = 'topup' and ${t.source_type} = 'stripe_checkout') or (${t.kind} = 'refund' and ${t.source_type} = 'stripe_refund') or (${t.kind} in ('credit', 'adjustment', 'writeoff') and ${t.source_type} in ('admin', 'job'))`,
    ),
    check(
      'ledger_entries_number_per_period',
      sql`${t.kind} <> 'number' or right(${t.source_id}, length(${t.period_id}) + 1) = ':' || ${t.period_id}`,
    ),
    check('ledger_entries_reverses_adjustment', sql`${t.reverses_entry_id} is null or ${t.kind} = 'adjustment'`),
    index('ledger_entries_bill_created').on(t.billing_account_id, t.created_at),
    index('ledger_entries_workspace_period').on(t.workspace_id, t.period_id),
    check(
      'ledger_entries_usage_seconds',
      sql`${t.kind} <> 'usage' or (${t.seconds} is not null and ${t.included_seconds} is not null and ${t.billable_seconds} is not null and ${t.included_seconds} >= 0 and ${t.billable_seconds} >= 0 and ${t.seconds} = ${t.included_seconds} + ${t.billable_seconds})`,
    ),
    check(
      'ledger_entries_seconds_usage_only',
      sql`${t.kind} = 'usage' or (${t.seconds} is null and ${t.included_seconds} is null and ${t.billable_seconds} is null)`,
    ),
    check(
      'ledger_entries_sign',
      sql`(${t.kind} in ('usage', 'number', 'refund') and ${t.amount_micros} <= 0) or (${t.kind} in ('recharge', 'topup', 'credit', 'writeoff') and ${t.amount_micros} >= 0) or ${t.kind} = 'adjustment'`,
    ),
  ],
)

/**
 * A bill's prepaid balance: the sum of its ledger, kept by a trigger on every ledger insert (migration 0107), so it
 * cannot drift from the ledger; a nightly job still compares. `reserved_micros` is what running calls hold (call_reservations).
 * The call gate locks this row (`SELECT … FOR UPDATE`), so the parallel calls of one bill are serialised.
 */
export const billing_balances = pgTable(
  'billing_balances',
  {
    billing_account_id: text('billing_account_id')
      .primaryKey()
      .references(() => billing_accounts.id),
    balance_micros: micros('balance_micros').notNull().default(0),
    reserved_micros: micros('reserved_micros').notNull().default(0),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [check('billing_balances_reserved', sql`${t.reserved_micros} >= 0`)],
)

/** Per workspace and period, from the ledger: the included seconds used and what its usage cost (rebuilt nightly). */
export const usage_counters = pgTable(
  'usage_counters',
  {
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    period_id: text('period_id')
      .notNull()
      .references(() => billing_periods.id),
    workspace_id: text('workspace_id').notNull(),
    /** The included allowance used, in Standard seconds: a Premium second counts 2, an own-keys second 0. */
    included_seconds_used: integer('included_seconds_used').notNull().default(0),
    /** Charged for usage beyond the included minutes, as a positive amount. */
    usage_micros: micros('usage_micros').notNull().default(0),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    primaryKey({ columns: [t.billing_account_id, t.period_id, t.workspace_id] }),
    check('usage_counters_included', sql`${t.included_seconds_used} >= 0`),
  ],
)

/**
 * What a running call holds against its bill's balance, so parallel calls cannot pass the buffer; every call of a
 * billed workspace has a row, so the rows also count the bill's running calls. Released when the usage posts.
 * A trigger (migration 0107) keeps `billing_balances.reserved_micros` equal to their sum, a deleted call included.
 */
export const call_reservations = pgTable(
  'call_reservations',
  {
    call_id: text('call_id')
      .primaryKey()
      .references(() => calls.id, { onDelete: 'cascade' }),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    reserved_micros: micros('reserved_micros').notNull(),
    /** The level the call pays, fixed when it started (decision 15): its usage entry is rated with it. */
    usage_level: text('usage_level', { enum: PAID_LEVELS }).notNull().default('standard'),
    /** Every part was to run on the customer's own keys: only a forecast, confirmed after the call (§2.1a). */
    own_keys: boolean('own_keys').notNull().default(false),
    /** The longest the call may last, fixed when it started: max call length plus the capped transfer (§4.4). */
    limit_seconds: integer('limit_seconds').notNull().default(3600),
    /** The included allowance this call holds while it runs, in Standard seconds (docs/billing.md §4.4). */
    included_reserved_seconds: integer('included_reserved_seconds').notNull().default(0),
    created_at: createdAt(),
  },
  t => [
    check('call_reservations_usage_level', oneOf(t.usage_level, PAID_LEVELS)),
    check('call_reservations_limit', sql`${t.limit_seconds} > 0`),
    check('call_reservations_included_reserved', sql`${t.included_reserved_seconds} >= 0`),
  ],
)

/**
 * A bill's automatic recharges, one row per attempt (failed ones are kept). At most one is pending per bill (a
 * partial unique index), so two postings that both see the balance under the threshold cannot charge twice. Its id
 * is the Stripe idempotency key and the ledger entry's `source_id`; the monthly cap counts pending and paid rows by
 * `created_at` (UTC calendar month). A pending row older than 24 hours is checked against Stripe by the nightly job.
 */
/** How an attempt is taxed (`billing_recharges.tax`). */
export const RECHARGE_TAX = ['on', 'off', 'no_address'] as const

export const billing_recharges = pgTable(
  'billing_recharges',
  {
    id: id(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    amount_cents: integer('amount_cents').notNull(),
    status: text('status', { enum: RECHARGE_STATUSES }).notNull().default('pending'),
    /** The invoice that charges it (a recharge invoice, or the subscription's first invoice at trial conversion). */
    stripe_invoice_id: text('stripe_invoice_id').unique(),
    /** Stripe's decline or error code of a failed attempt (`card_declined`, `authentication_required`). */
    failure_code: text('failure_code'),
    /**
     * "Buy minutes" with the saved card (docs/billing.md §2.2): the owner chose the amount ($5 to $500) and confirmed
     * it in the app. Charged and credited like a recharge, but never counted in the monthly cap of automatic ones.
     */
    manual: boolean('manual').notNull().default(false),
    /**
     * Stripe Tax for this attempt (LIN-459), decided once at its first charge try and kept for every retry, so a retry
     * after the install's switch changed sends the same invoice request (security review of #1105, L-1): `on` (taxed),
     * `off` (the switch was off), `no_address` (the switch was on, the customer had no address Stripe can tax: charged
     * without tax, the owner is asked for the address). Null until the first try.
     */
    tax: text('tax', { enum: RECHARGE_TAX }),
    created_at: createdAt(),
    resolved_at: ts('resolved_at'),
  },
  t => [
    uniqueIndex('billing_recharges_one_pending').on(t.billing_account_id).where(sql`${t.status} = 'pending'`),
    index('billing_recharges_bill_created').on(t.billing_account_id, t.created_at),
    check('billing_recharges_status', oneOf(t.status, RECHARGE_STATUSES)),
    check(
      'billing_recharges_amount',
      sql`${t.amount_cents} between (case when ${t.manual} then ${sql.raw(String(TOPUP_LIMITS_CENTS.min))} else ${sql.raw(String(RECHARGE_LIMITS.amountCents.min))} end) and ${sql.raw(String(RECHARGE_LIMITS.amountCents.max))}`,
    ),
    check('billing_recharges_resolved', sql`(${t.status} = 'pending') = (${t.resolved_at} is null)`),
    check('billing_recharges_tax', sql`${t.tax} is null or ${oneOf(t.tax, RECHARGE_TAX)}`),
  ],
)

const REFUND_STATUSES = ['pending', 'posted', 'void'] as const

/**
 * A refund from the balance (Server admin › Billing, `billing.refund`), written and committed before Stripe is asked
 * (security review of #919, M2): `pending` until its ledger entry is posted (`posted`), or until Stripe is found to
 * have made no credit note for it (`void`). A pending row whose action did not finish is settled from Stripe (the
 * credit note carries the row id in `metadata.linedesk_refund`) by the next refund of the bill and the nightly
 * reconciliation, so a payout never stays without its entry. While one is pending, the bill takes no other refund.
 */
export const billing_refunds = pgTable(
  'billing_refunds',
  {
    id: id(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    /** The admin dialog's request id: a retry of the same dialog finishes this refund, never makes a second. */
    request_id: text('request_id').notNull().unique(),
    /** The ledger entry of the payment refunded (a recharge or a top-up). */
    payment_entry_id: text('payment_entry_id').notNull(),
    stripe_invoice_id: text('stripe_invoice_id').notNull(),
    stripe_line_id: text('stripe_line_id').notNull(),
    amount_cents: integer('amount_cents').notNull(),
    /** The period the refund entry posts in, chosen before Stripe is asked. */
    period_id: text('period_id')
      .notNull()
      .references(() => billing_periods.id),
    status: text('status', { enum: REFUND_STATUSES }).notNull().default('pending'),
    credit_note_id: text('credit_note_id'),
    /** What went back to the card, tax included (the credit note's total). */
    refunded_cents: integer('refunded_cents'),
    ledger_entry_id: text('ledger_entry_id'),
    actor_id: text('actor_id'),
    reason: text('reason').notNull(),
    created_at: createdAt(),
    resolved_at: ts('resolved_at'),
  },
  t => [
    index('billing_refunds_bill_status').on(t.billing_account_id, t.status),
    check('billing_refunds_status', oneOf(t.status, REFUND_STATUSES)),
    check('billing_refunds_amount', sql`${t.amount_cents} > 0`),
    check('billing_refunds_resolved', sql`(${t.status} = 'pending') = (${t.resolved_at} is null)`),
  ],
)

/** The Stripe webhook inbox: one row per event id, so a redelivery is processed once. Kept 90 days. */
export const stripe_events = pgTable(
  'stripe_events',
  {
    /** Stripe's `evt_…`. */
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    livemode: boolean('livemode').notNull(),
    /** When Stripe created the event. */
    created: ts('created').notNull(),
    received_at: ts('received_at').notNull().defaultNow(),
    processed_at: ts('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    payload: jsonb('payload').notNull(),
  },
  t => [index('stripe_events_received').on(t.received_at)],
)

/** One free trial per card: the card's Stripe fingerprint and the bill that first used it. */
export const card_fingerprints = pgTable('card_fingerprints', {
  fingerprint: text('fingerprint').primaryKey(),
  first_billing_account_id: text('first_billing_account_id')
    .notNull()
    .references(() => billing_accounts.id),
  trial_used_at: ts('trial_used_at'),
  created_at: createdAt(),
})

/**
 * Self-serve sign-up (docs/billing.md §3.1): one row per sign-up code sent from the sign-up page (`code`) and per
 * sign-up started (`signup`), counted for the limits per address, per IP bucket and per install. The address is kept
 * only as a SHA-256 of its lower-case form; the IP only as its limit bucket (an IPv4 address or an IPv6 /64). Rows
 * older than `pendingDays` + 2 days (9 by default) are deleted by the daily sign-up sweep.
 */
export const signup_attempts = pgTable(
  'signup_attempts',
  {
    id: id(),
    kind: text('kind', { enum: ['code', 'signup'] }).notNull(),
    email_hash: text('email_hash'),
    ip_bucket: text('ip_bucket'),
    created_at: createdAt(),
  },
  t => [
    index('signup_attempts_email').on(t.kind, t.email_hash, t.created_at),
    index('signup_attempts_ip').on(t.kind, t.ip_bucket, t.created_at),
    index('signup_attempts_created').on(t.created_at),
    check('signup_attempts_kind', sql`${t.kind} in ('code', 'signup')`),
  ],
)

/** A mirror of the bill's Stripe invoices (plan fees, recharges, top-ups), for display. */
export const billing_invoices = pgTable(
  'billing_invoices',
  {
    stripe_invoice_id: text('stripe_invoice_id').primaryKey(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    kind: text('kind', { enum: INVOICE_KINDS }).notNull(),
    number: text('number'),
    status: text('status', { enum: INVOICE_STATUSES }).notNull(),
    total_cents: integer('total_cents').notNull(),
    tax_cents: integer('tax_cents').notNull().default(0),
    period_start: ts('period_start'),
    period_end: ts('period_end'),
    hosted_invoice_url: text('hosted_invoice_url'),
    pdf_url: text('pdf_url'),
    created_at: createdAt(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    index('billing_invoices_bill').on(t.billing_account_id, t.created_at),
    check('billing_invoices_kind', oneOf(t.kind, INVOICE_KINDS)),
    check('billing_invoices_status', oneOf(t.status, INVOICE_STATUSES)),
  ],
)

/**
 * The owner's billing emails already sent, once per bill, kind and occasion (`ref`: the calendar month for the
 * cap, the failed invoice for a recharge failure, the recharge or top-up that ended a low-balance stretch, the
 * yearly period that renews for the renewal reminder).
 */
export const billing_alerts = pgTable(
  'billing_alerts',
  {
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    kind: text('kind', { enum: ALERT_KINDS }).notNull(),
    ref: text('ref').notNull(),
    created_at: createdAt(),
  },
  t => [
    primaryKey({ columns: [t.billing_account_id, t.kind, t.ref] }),
    check('billing_alerts_kind', oneOf(t.kind, ALERT_KINDS)),
  ],
)

/**
 * A bill's state of a number on Linedesk's carrier account (docs/billing.md §3.4, §4.2): an extra number whose month
 * could not be paid (`unpaid_since`: inbound calls get the fixed line, released after 30 days), and the port-out code
 * shown only to the bill owner (encrypted with SECRETS_KEY). Not synced to browsers; read through billing actions.
 */
export const billing_numbers = pgTable(
  'billing_numbers',
  {
    phone_number_id: text('phone_number_id')
      .primaryKey()
      .references(() => phone_numbers.id, { onDelete: 'cascade' }),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    /** Its month could not be paid since then; null: paid (or not an extra number). */
    unpaid_since: ts('unpaid_since'),
    /** The period whose month is unpaid. */
    unpaid_period_id: text('unpaid_period_id').references(() => billing_periods.id),
    /** The port-out code (AES-256-GCM with SECRETS_KEY, slot `port_out:<number id>`), made when it is first shown. */
    port_out_code: text('port_out_code'),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    index('billing_numbers_bill').on(t.billing_account_id),
    check('billing_numbers_unpaid', sql`(${t.unpaid_since} is null) = (${t.unpaid_period_id} is null)`),
  ],
)

export const DISPUTE_KINDS = ['dispute', 'fraud_warning'] as const

/**
 * Card disputes and early fraud warnings of a bill's charges (docs/billing.md §3.4): what was taken off the balance
 * while a dispute is open (`adjustment_entry_id`) and given back when it was won (`reversal_entry_id`). A refund
 * (PR 13) refuses a charge with an open or lost dispute or a fraud warning here.
 */
export const billing_disputes = pgTable(
  'billing_disputes',
  {
    /** Stripe's `du_…` or `issfr_…`. */
    id: text('id').primaryKey(),
    billing_account_id: text('billing_account_id')
      .notNull()
      .references(() => billing_accounts.id),
    kind: text('kind', { enum: DISPUTE_KINDS }).notNull(),
    /** The disputed or warned charge (`ch_…`). */
    charge_id: text('charge_id').notNull(),
    /** Stripe's dispute status (`needs_response`, `won`, `lost`, …); `open` for a fraud warning. */
    status: text('status').notNull(),
    /** The balance credit the charge paid for (a recharge or a top-up), when it was one. */
    credit_entry_id: text('credit_entry_id'),
    adjustment_entry_id: text('adjustment_entry_id'),
    reversal_entry_id: text('reversal_entry_id'),
    created_at: createdAt(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    index('billing_disputes_bill').on(t.billing_account_id),
    index('billing_disputes_charge').on(t.charge_id),
    check('billing_disputes_kind', oneOf(t.kind, DISPUTE_KINDS)),
  ],
)

// --- White-label partners (docs/white-label.md) -------------------------------------------------------------------

/** A partner's state: `pending` until an instance admin approves it, `suspended` cuts its access to client workspaces. */
export const PARTNER_STATUSES = ['pending', 'approved', 'suspended'] as const
/** A partner team role: one owner (decides the team and the company name) and any number of admins. */
export const PARTNER_ROLES = ['owner', 'admin'] as const
/** How long a partner team invitation link works. */
export const PARTNER_INVITATION_DAYS = 7

/**
 * A white-label partner in the shared install: an agency or MSP that runs workspaces for its clients. Its own row, not
 * a workspace, so nothing that lists, bills or deletes workspaces can mistake it for one. Client workspaces point to it
 * (`organization.partner_id`); its team is `partner_members`. Not synced to browsers; read through partner actions.
 */
export const partners = pgTable(
  'partners',
  {
    id: id(),
    /** The partner's own company name (Server admin, the partner area, later invoices). */
    name: text('name').notNull(),
    status: text('status', { enum: PARTNER_STATUSES }).notNull().default('pending'),
    /**
     * The partner bill (`billing_accounts.kind = 'partner'`), made by the partner sign-up (S2). Null where billing is
     * off (dev, self-host) or for a partner an instance admin created by hand.
     */
    billing_account_id: text('billing_account_id')
      .unique()
      .references(() => billing_accounts.id),
    /** The user id (or `cli`) that created it; no foreign key, so the row outlives the account. */
    created_by: text('created_by').notNull(),
    approved_at: ts('approved_at'),
    approved_by: text('approved_by'),
    suspended_at: ts('suspended_at'),
    created_at: createdAt(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  t => [
    check('partners_status', oneOf(t.status, PARTNER_STATUSES)),
    check('partners_suspended', sql`(${t.status} = 'suspended') = (${t.suspended_at} is not null)`),
  ],
)

/**
 * The partner's team. Each member is an `admin` member of every client workspace of the partner (`member.partner_id`
 * marks those memberships; apps/api/src/partners.ts keeps them in step). Exactly one owner per partner.
 */
export const partner_members = pgTable(
  'partner_members',
  {
    partner_id: text('partner_id')
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: PARTNER_ROLES }).notNull(),
    created_at: createdAt(),
  },
  t => [
    primaryKey({ columns: [t.partner_id, t.user_id] }),
    index('partner_members_user').on(t.user_id),
    uniqueIndex('partner_members_one_owner').on(t.partner_id).where(sql`${t.role} = 'owner'`),
    check('partner_members_role', oneOf(t.role, PARTNER_ROLES)),
  ],
)

/**
 * An invitation to a partner team, sent by email. Only the hash of the link's token is kept. `owner`: the partner's
 * first owner, invited by an instance admin when the partner was created; the owner invites `admin`s.
 */
export const partner_invitations = pgTable(
  'partner_invitations',
  {
    id: id(),
    partner_id: text('partner_id')
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    /** Lowercased. */
    email: text('email').notNull(),
    role: text('role', { enum: PARTNER_ROLES }).notNull(),
    /** sha256 of the link's token (never the token). */
    token_hash: text('token_hash').notNull(),
    /** The user id (or `cli`) that sent it. */
    invited_by: text('invited_by').notNull(),
    expires_at: ts('expires_at').notNull(),
    accepted_at: ts('accepted_at'),
    canceled_at: ts('canceled_at'),
    created_at: createdAt(),
  },
  t => [
    uniqueIndex('partner_invitations_token').on(t.token_hash),
    index('partner_invitations_partner').on(t.partner_id),
    index('partner_invitations_email').on(t.email),
    check('partner_invitations_role', oneOf(t.role, PARTNER_ROLES)),
  ],
)

/**
 * A white-label partner's brand (slice S4, docs/white-label.md): what its clients see instead of the install's in the
 * app and, once the partner is approved and its bill has a paid subscription invoice, in emails. The same shape as the
 * install's branding (instance_settings `branding`). The logo is a PNG checked like the install's (decodeLogo), base64,
 * served at /v1/branding/partners/<id>/logo.png?v=<logo_version>. Not synced to browsers.
 *
 * Two versions (security review of #1111, M-2): the partner's draft (`name` … `privacy_url`, `revision`) and the one an
 * instance admin approved (`approved_*`, `approved_revision`). Clients and emails get only the approved one; the partner
 * team sees its draft. A change of name, logo, support email or links makes a new revision that waits for review; the
 * color is not reviewed and applies at once.
 */
export const partner_branding = pgTable(
  'partner_branding',
  {
    partner_id: text('partner_id')
      .primaryKey()
      .references(() => partners.id, { onDelete: 'cascade' }),
    /** The product name the partner's clients see (1 to 40 characters, brandingInput's rules, no protected name). */
    name: text('name').notNull(),
    /** #rrggbb, or null for the default. */
    color: text('color'),
    /** The PNG, base64; null without a logo. */
    logo: text('logo'),
    /** Changes with every new logo, so its address can be cached for good. */
    logo_version: text('logo_version'),
    /** Reply-To of the partner's workspace emails, and "Contact support" in the app. */
    support_email: text('support_email'),
    terms_url: text('terms_url'),
    privacy_url: text('privacy_url'),
    /** Goes up with every change of a reviewed field (name, logo, support email, links). */
    revision: integer('revision').notNull().default(1),
    updated_at: ts('updated_at').notNull().defaultNow(),
    /** The user id that saved it last; no foreign key, so the row outlives the account. */
    updated_by: text('updated_by').notNull(),
    /** The revision an instance admin approved, or null while none is: then clients and emails get the install's. */
    approved_revision: integer('approved_revision'),
    approved_name: text('approved_name'),
    approved_logo: text('approved_logo'),
    approved_logo_version: text('approved_logo_version'),
    approved_support_email: text('approved_support_email'),
    approved_terms_url: text('approved_terms_url'),
    approved_privacy_url: text('approved_privacy_url'),
    approved_at: ts('approved_at'),
    /** The instance admin who approved it; no foreign key, like `updated_by`. */
    approved_by: text('approved_by'),
  },
  t => [
    check('partner_branding_color', sql`${t.color} is null or ${t.color} ~ '^#[0-9a-f]{6}$'`),
    check(
      'partner_branding_approved',
      sql`(${t.approved_revision} is null) = (${t.approved_name} is null) and (${t.approved_revision} is null) = (${t.approved_at} is null)`,
    ),
  ],
)
