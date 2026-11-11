import { z } from 'zod'
import { defineAction } from './define.ts'

const instant = z.iso.datetime({ offset: true })

// The server handler lives in apps/api; the slots come back in the result's `data`.
export const calendarFindSlots = defineAction({
  name: 'calendar.findSlots',
  description: 'Find free slots for an appointment type: working hours minus existing bookings, buffers and minimum notice.',
  input: z.object({
    appointmentTypeId: z.string().min(1),
    /** Search window. Defaults to now until the type's booking horizon. */
    from: instant.optional(),
    to: instant.optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  permission: 'calendar:read',
  readOnly: true,
})

/** `data` of a successful `calendar.findSlots` result. Instants are ISO 8601 in UTC, earliest first. */
export type FindSlotsData = { appointmentTypeId: string; timeZone: string; slots: { start: string; end: string }[] }

// Calendar accounts and the calendars an assistant books into. Connecting is OAuth: connectStart
// returns the provider's consent URL; the provider sends the browser back to
// GET /v1/calendar/callback/<provider>, which runs connectFinish for the signed-in member.

export const calendarProvider = z.enum(['google', 'microsoft'])
export type CalendarProviderId = z.infer<typeof calendarProvider>

/** Longest note on when to use a calendar (characters). */
export const CALENDAR_INSTRUCTION_MAX = 300

export const calendarConnectStart = defineAction({
  name: 'calendar.connectStart',
  description: "Start connecting a Google or Microsoft calendar account to the workspace. Returns the URL of the provider's consent page.",
  input: z.object({ provider: calendarProvider }),
  permission: 'settings:write',
})

/** `data` of calendar.connectStart. */
export type ConnectStartData = { url: string }

export const calendarConnectFinish = defineAction({
  name: 'calendar.connectFinish',
  description: 'Finish connecting a calendar account with the code the provider sent back. Run by the OAuth callback route.',
  input: z.object({ provider: calendarProvider, state: z.string().min(16).max(200), code: z.string().min(1).max(4000) }),
  permission: 'settings:write',
  sensitive: ['code'],
})

const connectionId = z.object({ connectionId: z.string().min(1) })

export const calendarListCalendars = defineAction({
  name: 'calendar.listCalendars',
  description: 'The calendars of a connected account, from the provider: id, name, whether it is the main one and whether events can be written.',
  input: connectionId,
  permission: 'settings:write',
  readOnly: true,
})

/** `data` of calendar.listCalendars. */
export type ListCalendarsData = { calendars: { id: string; name: string; primary: boolean; canWrite: boolean }[] }

export const calendarDisconnect = defineAction({
  name: 'calendar.disconnect',
  description:
    'Disconnect a calendar account: its access is revoked at the provider where possible, its tokens deleted and its calendars removed from every assistant. Booked events stay in the calendar.',
  input: connectionId,
  permission: 'settings:write',
})

/** `data` of calendar.disconnect: whether the provider withdrew the grant (Microsoft has no way to). */
export type DisconnectData = { revoked: boolean; note: string | null }

export const assistantCalendarAdd = defineAction({
  name: 'assistantCalendar.add',
  description: 'Let the assistant book into a calendar of a connected account. The first calendar becomes its default.',
  input: z.object({
    assistantId: z.string().min(1),
    connectionId: z.string().min(1),
    /** The provider's calendar id, from calendar.listCalendars. */
    externalId: z.string().min(1).max(500),
    instruction: z.string().trim().max(CALENDAR_INSTRUCTION_MAX).optional(),
  }),
  permission: 'settings:write',
})

export const assistantCalendarUpdate = defineAction({
  name: 'assistantCalendar.update',
  description: 'Change when the assistant uses a calendar (instruction, e.g. "Emergencies") or switch it off and on.',
  input: z.object({
    assistantCalendarId: z.string().min(1),
    instruction: z.string().trim().max(CALENDAR_INSTRUCTION_MAX).optional(),
    enabled: z.boolean().optional(),
  }),
  permission: 'settings:write',
  patch: {
    table: 'assistant_calendars',
    id: i => i.assistantCalendarId,
    set: ({ instruction, enabled }) => ({ ...(instruction !== undefined && { instruction }), ...(enabled !== undefined && { enabled }) }),
  },
})

const assistantCalendarId = z.object({ assistantCalendarId: z.string().min(1) })

export const assistantCalendarSetDefault = defineAction({
  name: 'assistantCalendar.setDefault',
  description: 'Make a calendar the one the assistant books into when no instruction fits.',
  input: assistantCalendarId,
  permission: 'settings:write',
})

export const assistantCalendarRemove = defineAction({
  name: 'assistantCalendar.remove',
  description: 'Stop the assistant from booking into a calendar. Events booked there stay.',
  input: assistantCalendarId,
  permission: 'settings:write',
})
