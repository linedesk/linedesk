// Row types shared with the browser. Type-only: importing this never pulls in pg or drizzle.
import type { assistants, calls, contacts, phone_numbers, transcript_segments } from './schema.ts'

export type ActionItem = { text: string; done?: boolean }
export type CallField = { label: string; value: string }
export type ToolEvent = { tool: string; label: string }
export type AssistantVoice = { provider: string; voice_id: string }
export type BusinessProfile = {
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

export type Tables = {
  calls: Call
  contacts: Contact
  assistants: Assistant
  phone_numbers: PhoneNumber
  transcript_segments: TranscriptSegment
}
export type TableName = keyof Tables
export const tableNames = ['calls', 'contacts', 'assistants', 'phone_numbers', 'transcript_segments'] as const satisfies readonly TableName[]
