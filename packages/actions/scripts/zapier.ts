// The Zapier app's actions and searches, generated from the registry (integrations/zapier/generated/actions.json).
// Every public action is in the app with the fields of its Zod input; a new or changed public action changes the file,
// and CI fails while the committed file is not the one this script writes (`pnpm zapier:generate --check`). The app is
// pushed to Zapier on each release by the maintainers' release pipeline, so Zapier follows the API.
//
//   pnpm zapier:generate           writes the file
//   pnpm zapier:generate --check   exits 1 when the committed file is out of date
import { readFileSync, writeFileSync } from 'node:fs'
import { actions } from '../src/index.ts'
import { inputSchema } from '../src/openapi.ts'

type JsonSchema = {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  description?: string
  default?: unknown
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
}

/** A field as the Zapier app reads it (integrations/zapier/lib/fields.js turns it into an input field). */
type Field = {
  key: string
  label: string
  type: 'string' | 'text' | 'datetime' | 'date' | 'boolean' | 'integer' | 'number'
  required: boolean
  nullable?: boolean
  helpText?: string
  choices?: string[]
  default?: unknown
  dynamic?: string
  children?: Field[]
  /** A list or object without fields of its own: typed as JSON. */
  json?: boolean
  /** A phone number in E.164: spaces, dashes and brackets are dropped before it is sent. */
  phone?: boolean
}

/** Words for Zapier, per action: label, noun, kind, the result to return, fields left out or made required. */
type Words = {
  label: string
  noun: string
  kind?: 'create' | 'search'
  /** Searches: where the list is in `data`. */
  list?: string
  omit?: string[]
  require?: string[]
  /** A field's dropdown, when not the one its key implies (deleted calls for restore). */
  dynamic?: Record<string, string>
}

const WORDS: Record<string, Words> = {
  'call.markDone': { label: 'Mark Call Done', noun: 'Call' },
  'call.markNotDone': { label: 'Move Call Back to Inbox', noun: 'Call' },
  'call.markRead': { label: 'Mark Call Read', noun: 'Call' },
  'call.markUnread': { label: 'Mark Call Unread', noun: 'Call' },
  'call.remind': { label: 'Remind Me About Call', noun: 'Call' },
  'call.clearReminder': { label: 'Remove Call Reminder', noun: 'Call' },
  'call.assign': { label: 'Assign Call', noun: 'Call' },
  'call.delete': { label: 'Delete Call', noun: 'Call' },
  'call.restore': { label: 'Restore Call', noun: 'Call', dynamic: { callId: 'deleted_calls' } },
  'call.markSpam': { label: 'Mark Call as Spam', noun: 'Call' },
  'call.markNotSpam': { label: 'Mark Call as Not Spam', noun: 'Call' },
  'call.setActionItems': { label: 'Set Call Next Steps', noun: 'Call' },
  'call.setUrgency': { label: 'Set Call Urgency', noun: 'Call' },
  'call.export': { label: 'Export Calls', noun: 'Export', kind: 'create' },
  'member.list': { label: 'Find Team Members', noun: 'Team Member', kind: 'search', list: 'members' },
  'contact.create': { label: 'Create Contact', noun: 'Contact' },
  'contact.update': { label: 'Update Contact', noun: 'Contact' },
  'contact.block': { label: 'Block Caller', noun: 'Contact' },
  'contact.unblock': { label: 'Unblock Caller', noun: 'Contact' },
  'contact.delete': { label: 'Delete Contact', noun: 'Contact' },
  'contact.restore': { label: 'Restore Contact', noun: 'Contact', dynamic: { contactId: 'deleted_contacts' } },
  'calendar.findSlots': { label: 'Find Free Slots', noun: 'Slot', kind: 'search', list: 'slots', omit: ['callId'] },
  'appointment.book': { label: 'Book Appointment', noun: 'Booking', omit: ['assistantId'] },
  // The voice agent names a booking by its call, day and name; on Zapier the booking is picked from a list.
  'appointment.cancel': {
    label: 'Cancel Appointment',
    noun: 'Booking',
    omit: ['callId', 'bookingDate', 'bookedName', 'readsRefusals'],
    require: ['bookingId'],
  },
  'appointment.reschedule': {
    label: 'Reschedule Appointment',
    noun: 'Booking',
    omit: ['callId', 'bookingDate', 'bookedName'],
    require: ['bookingId'],
  },
}

/** Subscriptions are the triggers' own (REST hooks), never an action of their own. */
const NOT_ACTIONS = new Set(['integration.subscribe', 'integration.unsubscribe'])

/** Labels of field keys the generic rule would word badly; the rest: camelCase to Title Case. */
const FIELD_LABELS: Record<string, string> = {
  callId: 'Call',
  contactId: 'Contact',
  userId: 'Team Member',
  appointmentTypeId: 'Appointment Type',
  calendarId: 'Calendar',
  bookingId: 'Booking',
  assistantId: 'Assistant',
  at: 'Remind At',
  label: 'Reminder Note',
  items: 'Next Steps',
  from: 'From',
  to: 'To',
  fromDate: 'From Day',
  toDate: 'To Day',
  start: 'Start',
  phone: 'Phone Number',
  callerName: 'Caller Name',
  callerPhone: 'Caller Phone',
  callerEmail: 'Caller Email',
  notify: 'Notify Them',
}

const FIELD_HELP: Record<string, string> = {
  phone: 'In international format, e.g. +15035550123.',
  callId: 'The Call ID, e.g. from the Call Finished trigger.',
  userId: 'Leave empty to unassign the call.',
  at: 'When the call comes back to the inbox.',
  start: 'The start time; it must be a free slot (Find Free Slots).',
}

/** The dropdown a key gets: its kind on GET /v1/integrations/options/<kind>. */
const DYNAMIC: Record<string, string> = {
  callId: 'calls',
  contactId: 'contacts',
  userId: 'members',
  appointmentTypeId: 'appointment_types',
  calendarId: 'calendars',
  bookingId: 'bookings',
  assistantId: 'assistants',
}

const titleCase = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
    .replace(/ ([a-z])/g, (_, c) => ` ${c.toUpperCase()}`)

/** The schema without its `null` branch, and whether it had one. */
function nonNull(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  if (schema.anyOf) {
    const rest = schema.anyOf.filter(s => s.type !== 'null')
    if (rest.length === 1)
      return {
        schema: { ...rest[0], description: schema.description ?? rest[0]!.description },
        nullable: rest.length < schema.anyOf.length,
      }
  }
  if (Array.isArray(schema.type)) {
    const rest = schema.type.filter(t => t !== 'null')
    return {
      schema: { ...schema, type: rest.length === 1 ? rest[0] : rest },
      nullable: rest.length < schema.type.length,
    }
  }
  return { schema, nullable: false }
}

function fieldType(schema: JsonSchema): Field['type'] {
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'integer') return 'integer'
  if (schema.type === 'number') return 'number'
  if (schema.format === 'date-time') return 'datetime'
  if (schema.format === 'date') return 'date'
  if (typeof schema.maxLength === 'number' && schema.maxLength > 500) return 'text'
  return 'string'
}

function fieldsOf(schema: JsonSchema, words: Words | undefined, top: boolean): Field[] {
  const required = new Set([...(schema.required ?? []), ...(top ? (words?.require ?? []) : [])])
  const fields: Field[] = []
  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    if (top && words?.omit?.includes(key)) continue
    if (raw.const !== undefined) continue // one possible value: always the default
    const { schema: prop, nullable } = nonNull(raw)
    const field: Field = {
      key,
      label: FIELD_LABELS[key] ?? titleCase(key),
      type: fieldType(prop),
      required: required.has(key),
    }
    if (nullable) field.nullable = true
    const help = prop.description ?? FIELD_HELP[key]
    if (help) field.helpText = help
    if (prop.pattern?.startsWith('^\\+')) field.phone = true
    if (prop.enum) field.choices = prop.enum.map(String)
    if (prop.default !== undefined) field.default = prop.default
    const dynamic = top ? (words?.dynamic?.[key] ?? DYNAMIC[key]) : undefined
    if (dynamic) field.dynamic = dynamic
    if (prop.type === 'array' && prop.items?.type === 'object') field.children = fieldsOf(prop.items, undefined, false)
    else if (prop.type === 'array' || prop.type === 'object') field.json = true
    fields.push(field)
  }
  return fields
}

/** One entry per public action, in the registry's order. */
export function zapierActions() {
  return [...actions.values()]
    .filter(def => def.public && !NOT_ACTIONS.has(def.name))
    .map(def => {
      const words = WORDS[def.name]
      const [table, verb = ''] = def.name.split('.')
      return {
        name: def.name,
        key: def.name
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .toLowerCase(),
        kind: words?.kind ?? (def.readOnly ? 'search' : 'create'),
        label: words?.label ?? `${titleCase(verb)} ${titleCase(table!)}`,
        noun: words?.noun ?? titleCase(table!),
        description: def.description,
        permission: def.permission,
        ...(words?.list ? { list: words.list } : {}),
        ...(def.destructive ? { destructive: true } : {}),
        fields: fieldsOf(inputSchema(def) as JsonSchema, words, true),
      }
    })
}

const target = new URL('../../../integrations/zapier/generated/actions.json', import.meta.url)
const text = `${JSON.stringify(zapierActions(), null, 2)}\n`

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(target, 'utf8')
  } catch {}
  if (committed !== text) {
    console.error(
      'integrations/zapier/generated/actions.json is out of date: run `pnpm zapier:generate` and commit it.',
    )
    process.exit(1)
  }
  console.log('The Zapier app has every public action.')
} else {
  writeFileSync(target, text)
  console.log(`Wrote ${zapierActions().length} actions to integrations/zapier/generated/actions.json`)
}
