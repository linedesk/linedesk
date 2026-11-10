// Row types shared with the browser. Type-only: importing this never pulls in pg or drizzle.
import type {
  appointment_types, assistants, availability_exceptions, availability_rules, bookings, calls, contacts, phone_numbers,
  transcript_segments, workspace_settings,
} from './schema.ts'

export type ActionItem = { text: string; done?: boolean }
export type CallField = { label: string; value: string }
export type ToolEvent = { tool: string; label: string }
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
// Not delivered by read sync yet (so not in `Tables`): the API reads them for calendar actions.
export type WorkspaceSettings = typeof workspace_settings.$inferSelect
export type AvailabilityRule = typeof availability_rules.$inferSelect
export type AvailabilityException = typeof availability_exceptions.$inferSelect
export type AppointmentType = typeof appointment_types.$inferSelect
export type Booking = typeof bookings.$inferSelect

export type Tables = {
  calls: Call
  contacts: Contact
  assistants: Assistant
  phone_numbers: PhoneNumber
  transcript_segments: TranscriptSegment
}
export type TableName = keyof Tables
export const tableNames = ['calls', 'contacts', 'assistants', 'phone_numbers', 'transcript_segments'] as const satisfies readonly TableName[]
