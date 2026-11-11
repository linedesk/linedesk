import { z } from 'zod'
import { defineAction } from './define.ts'

const instant = z.iso.datetime({ offset: true })
const localDate = z.iso.date()
/** Details the assistant asks for before booking a type, besides the reason. `name` is stored as appointment_types.name_required. */
export const bookingField = z.enum(['name', 'phone', 'email', 'address'])
export type BookingFieldInput = z.infer<typeof bookingField>

// The server handler lives in apps/api; the slots come back in the result's `data`.
export const calendarFindSlots = defineAction({
  name: 'calendar.findSlots',
  description: 'Find free slots for an appointment type: working hours minus existing bookings, buffers and minimum notice.',
  input: z.object({
    appointmentTypeId: z.string().min(1),
    /** Search window. Defaults to now until the type's booking horizon. */
    from: instant.optional(),
    to: instant.optional(),
    /** The window as local dates in the workspace's time zone (both included), for callers that think in days (the voice agent). */
    fromDate: localDate.optional(),
    toDate: localDate.optional(),
    /** One of the assistant's calendars (assistant_calendars id): its busy times at the provider count too. */
    calendarId: z.string().min(1).optional(),
    /** The call the assistant searches on: then only the calendars of the assistant that answered it. */
    callId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  permission: 'calendar:read',
  agent: 'workspace',
  public: true,
  readOnly: true,
})

/**
 * `data` of a successful `calendar.findSlots` result. Instants are ISO 8601 in UTC, earliest first;
 * `label` is the start as the business says it ("Tuesday, November 17 at 9:00 AM").
 */
export type FindSlotsData = { appointmentTypeId: string; timeZone: string; slots: { start: string; end: string; label: string }[] }

/** Longest condition on when the assistant uses a calendar or an appointment type (characters). */
export const CONDITION_MAX = 300

/** Longest caller name, reason and address on a booking (characters). */
const BOOKING_TEXT_MAX = 500

export const appointmentBook = defineAction({
  name: 'appointment.book',
  description:
    "Book an appointment into one of the assistant's calendars: checks the slot is still free, writes the calendar event (caller, number, reason, address) and stores the booking, linked to the call.",
  input: z.object({
    appointmentTypeId: z.string().min(1),
    /** The assistant_calendars id; it must be one of the assistant's enabled calendars. */
    calendarId: z.string().min(1),
    /** A slot start from calendar.findSlots. */
    start: instant,
    /** Required when the appointment type asks for the name. */
    callerName: z.string().trim().min(1).max(BOOKING_TEXT_MAX).optional(),
    reason: z.string().trim().min(1).max(BOOKING_TEXT_MAX),
    address: z.string().trim().max(BOOKING_TEXT_MAX).optional(),
    /** The caller's number; defaults to the number of the call. */
    callerPhone: z.string().trim().max(40).optional(),
    /** Where the confirmation is emailed; defaults to the contact's email. */
    callerEmail: z.email().max(254).optional(),
    callId: z.string().min(1).optional(),
    /** The assistant that books: the calendar must be one of its. */
    assistantId: z.string().min(1).optional(),
  }),
  permission: 'calendar:write',
  agent: 'call',
  logged: 'ids',
  public: true,
})

/** `data` of appointment.book. */
export type BookData = { bookingId: string; start: string; end: string; label: string; calendarName: string }

/**
 * Which booking to change. Members name it by `bookingId`. The voice agent never knows a caller's bookings
 * (caller ID can be faked): it passes its call and what the caller says about the booking, its day in the
 * business's time zone (`bookingDate`) and the name it is under (`bookedName`); the API finds the one booking
 * of the call's caller that matches both, or refuses.
 */
const whichBooking = {
  bookingId: z.string().min(1).optional(),
  callId: z.string().min(1).optional(),
  bookingDate: localDate.optional(),
  bookedName: z.string().trim().min(1).max(BOOKING_TEXT_MAX).optional(),
}

export const appointmentCancel = defineAction({
  name: 'appointment.cancel',
  description: 'Cancel a booking made through Linedesk: deletes its calendar event and marks it cancelled.',
  input: z.object(whichBooking),
  permission: 'calendar:write',
  agent: 'call',
  logged: 'ids',
  public: true,
  destructive: true,
})

export const appointmentReschedule = defineAction({
  name: 'appointment.reschedule',
  description: 'Move a booking made through Linedesk to another free slot: the calendar event moves with it.',
  input: z.object({ ...whichBooking, start: instant }),
  permission: 'calendar:write',
  agent: 'call',
  logged: 'ids',
  public: true,
  destructive: true,
})

export const appointmentTypeUpsert = defineAction({
  name: 'appointmentType.upsert',
  description:
    'Add an appointment type (name, length in minutes, when the assistant offers it, the details it asks for), or change one when its id is given.',
  input: z.object({
    appointmentTypeId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80),
    durationMin: z.number().int().min(5).max(24 * 60),
    bufferMin: z.number().int().min(0).max(240).optional(),
    minNoticeHours: z.number().int().min(0).max(24 * 30).optional(),
    maxDaysAhead: z.number().int().min(1).max(365).optional(),
    enabled: z.boolean().optional(),
    /** Details the assistant must have before booking, on top of the reason. */
    requiredFields: z.array(bookingField).max(4).optional(),
    /** When the assistant offers this type, e.g. "the caller needs an emergency visit"; empty: no condition. */
    instruction: z.string().trim().max(CONDITION_MAX).optional(),
  }),
  permission: 'settings:write',
})

export const appointmentTypeDelete = defineAction({
  name: 'appointmentType.delete',
  description: 'Delete an appointment type. One that has bookings is switched off instead, so its bookings keep their type.',
  input: z.object({ appointmentTypeId: z.string().min(1) }),
  permission: 'settings:write',
})

// Calendar accounts and the calendars an assistant books into. Connecting is OAuth: connectStart
// returns the provider's consent URL; the provider sends the browser back to
// GET /v1/calendar/callback/<provider>, which runs connectFinish for the signed-in member.

export const calendarProvider = z.enum(['google', 'microsoft'])
export type CalendarProviderId = z.infer<typeof calendarProvider>

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
  description:
    'Let the assistant book into a calendar of a connected account. The first calendar becomes its default. When the workspace has no appointment type yet, a 30-minute "Appointment" is created with it, so the assistant can book at once.',
  input: z.object({
    assistantId: z.string().min(1),
    connectionId: z.string().min(1),
    /** The provider's calendar id, from calendar.listCalendars. */
    externalId: z.string().min(1).max(500),
    instruction: z.string().trim().max(CONDITION_MAX).optional(),
  }),
  permission: 'settings:write',
})

export const assistantCalendarUpdate = defineAction({
  name: 'assistantCalendar.update',
  description:
    'Change when the assistant uses a calendar (instruction: the condition, e.g. "the caller needs an emergency visit") or switch it off and on.',
  input: z.object({
    assistantCalendarId: z.string().min(1),
    instruction: z.string().trim().max(CONDITION_MAX).optional(),
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
