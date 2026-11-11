// Row types shared with the browser. Type-only: importing this never pulls in pg or drizzle.
import type {
  api_keys, appointment_types, assistant_calendars, assistants, availability_exceptions, availability_rules, bookings, calendar_connections, calls, contacts,
  phone_numbers, transcript_segments, webhook_endpoints, workspace_settings, workspace_members, call_events,
} from './schema.ts'

/** `kind: 'message'`: a message the assistant took during the call (call.takeMessage), counted for MESSAGES_PER_CALL. */
export type ActionItem = { text: string; done?: boolean; kind?: 'message' }
export type CallField = { label: string; value: string }
export type ToolEvent = { tool: string; label: string }
/** Booking details an appointment type can require on top of the caller's name and the reason. */
export type BookingField = 'phone' | 'email' | 'address'
/** What a workspace's webhooks can receive (apps/api/src/webhooks.ts). */
export const webhookEvents = ['call.completed', 'call.summary_ready', 'booking.created', 'message.taken'] as const
export type WebhookEvent = (typeof webhookEvents)[number]
export type AssistantVoice = { provider: string; voice_id: string }
/** What happens when the transfer contact does not take the call. */
export const transferFallbacks = ['message_urgent', 'message', 'next'] as const
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
}
/** A new assistant's list: one inactive contact for callers who ask for a person, until a number is set. */
export const DEFAULT_TRANSFERS: TransferContact[] = [
  {
    id: 'person',
    name: 'Owner',
    number: null,
    condition: 'The caller asks to speak to a person',
    hours_only: true,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
  },
]
/**
 * The optional keypad menu an assistant plays right after the greeting ("Press 1 for emergencies…").
 * `transfer`: the key is an urgent call (put through when transfer is on, else flagged urgent and a message);
 * `topic`: the assistant goes on knowing what the caller wants.
 */
export type KeypadMenuAction = 'transfer' | 'topic'
export type KeypadMenuOption = { key: string; label: string; action: KeypadMenuAction }
export type KeypadMenu = { options: KeypadMenuOption[] }
export type BusinessProfile = {
  /** Free text from the business: what the assistant should know and do. When set, the agent uses it instead of the fields below. */
  instructions?: string
  description?: string
  services?: string[]
  service_area?: string
  address?: string
  hours?: string
  faqs?: { q: string; a: string }[]
}

export type Call = typeof calls.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type Assistant = typeof assistants.$inferSelect
export type PhoneNumber = typeof phone_numbers.$inferSelect
export type TranscriptSegment = typeof transcript_segments.$inferSelect
// Not delivered by read sync (so not in `Tables`): the API reads them for calendar actions.
export type WorkspaceSettings = typeof workspace_settings.$inferSelect
export type AvailabilityRule = typeof availability_rules.$inferSelect
export type AvailabilityException = typeof availability_exceptions.$inferSelect
export type AppointmentType = typeof appointment_types.$inferSelect
export type Booking = typeof bookings.$inferSelect
export type CalendarConnection = typeof calendar_connections.$inferSelect
export type AssistantCalendar = typeof assistant_calendars.$inferSelect
export type ApiKey = typeof api_keys.$inferSelect
export type WebhookEndpoint = typeof webhook_endpoints.$inferSelect
export type WorkspaceMember = typeof workspace_members.$inferSelect
export type CallEvent = typeof call_events.$inferSelect

export type Tables = {
  calls: Call
  contacts: Contact
  assistants: Assistant
  phone_numbers: PhoneNumber
  transcript_segments: TranscriptSegment
  appointment_types: AppointmentType
  bookings: Booking
  calendar_connections: CalendarConnection
  assistant_calendars: AssistantCalendar
  webhook_endpoints: WebhookEndpoint
  workspace_members: WorkspaceMember
  call_events: CallEvent
}
export type TableName = keyof Tables
export const tableNames = [
  'calls', 'contacts', 'assistants', 'phone_numbers', 'transcript_segments', 'appointment_types', 'bookings', 'calendar_connections', 'assistant_calendars',
  'webhook_endpoints', 'workspace_members', 'call_events',
] as const satisfies readonly TableName[]
