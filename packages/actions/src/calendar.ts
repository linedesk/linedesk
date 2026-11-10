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
