// App tables. Property names equal column names (snake_case) so a row has the same shape in
// Postgres, in the API and in the browser (rows arrive there through read sync).
// workspace_id is the Better Auth organization id; every synced table carries it and a `version`
// (global sequence, bumped by trigger on every write) so clients can order row versions.
import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, pgSequence, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { ActionItem, AssistantVoice, BusinessProfile, CallField, ToolEvent } from './types.ts'

export const rowVersion = pgSequence('row_version')

const id = () => text('id').primaryKey()
const workspaceId = () => text('workspace_id').notNull()
const version = () => bigint('version', { mode: 'number' }).notNull().default(sql`nextval('row_version')`)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })
const createdAt = () => ts('created_at').notNull().defaultNow()

export const phone_numbers = pgTable('phone_numbers', {
  id: id(),
  workspace_id: workspaceId(),
  e164: text('e164').notNull().unique(),
  provider: text('provider', { enum: ['telnyx', 'twilio', 'plivo', 'byo_sip', 'dev'] }).notNull(),
  mode: text('mode', { enum: ['forward_conditional', 'forward_all', 'new', 'ported'] }).notNull().default('forward_conditional'),
  forwarded_from: text('forwarded_from'),
  provider_ref: text('provider_ref'),
  verified_at: ts('verified_at'),
  created_at: createdAt(),
  version: version(),
}, t => [index('phone_numbers_ws').on(t.workspace_id)])

export const assistants = pgTable('assistants', {
  id: id(),
  workspace_id: workspaceId().unique(),
  name: text('name').notNull().default('Maya'),
  greeting: text('greeting').notNull().default(''),
  disclose_ai: boolean('disclose_ai').notNull().default(true),
  voice: jsonb('voice').$type<AssistantVoice>().notNull().default({ provider: 'cartesia', voice_id: '' }),
  business_profile: jsonb('business_profile').$type<BusinessProfile>().notNull().default({}),
  created_at: createdAt(),
  version: version(),
})

export const contacts = pgTable('contacts', {
  id: id(),
  workspace_id: workspaceId(),
  name: text('name'),
  company: text('company'),
  phone: text('phone').notNull(),
  email: text('email'),
  address: text('address'),
  note: text('note'),
  created_at: createdAt(),
  version: version(),
}, t => [index('contacts_ws_phone').on(t.workspace_id, t.phone)])

export const calls = pgTable('calls', {
  id: id(),
  workspace_id: workspaceId(),
  contact_id: text('contact_id').references(() => contacts.id),
  from_number: text('from_number').notNull(),
  to_number: text('to_number').notNull(),
  direction: text('direction', { enum: ['in', 'out'] }).notNull().default('in'),
  started_at: ts('started_at').notNull().defaultNow(),
  ended_at: ts('ended_at'),
  duration_sec: integer('duration_sec'),
  status: text('status', { enum: ['live', 'completed'] }).notNull().default('live'),
  outcome: text('outcome', { enum: ['booked', 'rescheduled', 'cancelled', 'callback', 'message', 'answered', 'transferred', 'hangup', 'spam'] }),
  urgency: text('urgency', { enum: ['urgent', 'normal', 'low'] }).notNull().default('normal'),
  title: text('title'),
  summary: text('summary'),
  action_items: jsonb('action_items').$type<ActionItem[]>().notNull().default([]),
  fields: jsonb('fields').$type<CallField[]>().notNull().default([]),
  answered_by: text('answered_by', { enum: ['ai', 'human'] }).notNull().default('ai'),
  recording_key: text('recording_key'),
  room: text('room'),
  inbox_state: text('inbox_state', { enum: ['open', 'done'] }).notNull().default('open'),
  reminder_at: ts('reminder_at'),
  reminder_label: text('reminder_label'),
  unread: boolean('unread').notNull().default(true),
  assignee_id: text('assignee_id'),
  deleted_at: ts('deleted_at'),
  version: version(),
}, t => [index('calls_ws_started').on(t.workspace_id, t.started_at)])

export const transcript_segments = pgTable('transcript_segments', {
  id: id(),
  workspace_id: workspaceId(),
  call_id: text('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  speaker: text('speaker', { enum: ['agent', 'caller', 'human', 'system'] }).notNull(),
  text: text('text').notNull(),
  at_ms: integer('at_ms').notNull(),
  tool_event: jsonb('tool_event').$type<ToolEvent>(),
  version: version(),
}, t => [index('segments_call').on(t.call_id, t.at_ms)])

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

/** Tables that read sync delivers to clients, filtered by workspace_id. */
export const syncedTables = { calls, contacts, assistants, phone_numbers, transcript_segments } as const
