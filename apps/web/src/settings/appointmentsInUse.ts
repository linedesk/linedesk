// Whether the appointment value means anything yet (Workspace settings › General, the Insights summary, the command menu).
import { useRows } from '../store.tsx'

/**
 * The workspace books appointments, or did: a calendar account is added (in any state) or a booking exists. Before
 * that, nothing would multiply an appointment value, so it is not offered. False until the rows are in.
 */
export function useAppointmentsInUse(): boolean {
  const calendars = useRows('calendar_connections')
  const bookings = useRows('bookings')
  return calendars.length > 0 || bookings.length > 0
}
