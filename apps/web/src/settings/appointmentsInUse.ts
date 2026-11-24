// Whether the appointment value means anything yet (Workspace settings › General, the Insights summary, the command
// menu), and whether an assistant can book at all (the Insights Booked tile).
import type { AppointmentType, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { useRows } from '../store.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'

/**
 * The workspace books appointments, or did: a calendar account is added (in any state) or a booking exists. Before
 * that, nothing would multiply an appointment value, so it is not offered. False until the rows are in.
 */
export function useAppointmentsInUse(): boolean {
  const calendars = useRows('calendar_connections')
  const bookings = useRows('bookings')
  return calendars.length > 0 || bookings.length > 0
}

/**
 * An assistant can book, as the server's bookingContext sees it: a calendar that is on, of an account that is
 * connected, with an appointment type that is on to book into it (a scheduling tool's event type is a type of its own).
 */
export function bookingSetUp(
  connections: readonly Pick<CalendarConnection, 'id' | 'status'>[],
  calendars: readonly Pick<AssistantCalendar, 'connection_id' | 'enabled' | 'duration_min'>[],
  types: readonly Pick<AppointmentType, 'enabled'>[],
): boolean {
  const connected = new Set(connections.filter(c => c.status === 'connected').map(c => c.id))
  const usable = calendars.filter(c => c.enabled && connected.has(c.connection_id))
  return usable.some(c => c.duration_min !== null) || (usable.length > 0 && types.some(t => t.enabled))
}

/** bookingSetUp for this workspace; null until its rows are in. */
export function useBookingSetUp(): boolean | null {
  const loaded = [
    useLoadState('calendar_connections'),
    useLoadState('assistant_calendars'),
    useLoadState('appointment_types'),
  ].every(s => s === 'ready')
  const connections = useRows('calendar_connections')
  const calendars = useRows('assistant_calendars')
  const types = useRows('appointment_types')
  return loaded ? bookingSetUp(connections, calendars, types) : null
}
