// Row types shared with the browser. Type-only: importing this never pulls in pg or drizzle.
import type {
  api_keys, appointment_types, assistant_calendars, assistants, availability_exceptions, availability_rules, bookings, calendar_connections, calls, contacts,
  phone_numbers, transcript_segments, webhook_endpoints, workspace_settings,
} from './schema.ts'

export type ActionItem = { text: string; done?: boolean }
export type CallField = { label: string; value: string }
export type ToolEvent = { tool: string; label: string }
/** Booking details an appointment type can require on top of the caller's name and the reason. */
export type BookingField = 'phone' | 'email' | 'address'
/** What a workspace's webhooks can receive (apps/api/src/webhooks.ts). */
export const webhookEvents = ['call.completed', 'call.summary_ready', 'booking.created', 'message.taken'] as const
export type WebhookEvent = (typeof webhookEvents)[number]
export type AssistantVoice = { provider: string; voice_id: string }
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
}
export type TableName = keyof Tables
export const tableNames = [
  'calls', 'contacts', 'assistants', 'phone_numbers', 'transcript_segments', 'appointment_types', 'bookings', 'calendar_connections', 'assistant_calendars',
  'webhook_endpoints',
] as const satisfies readonly TableName[]
