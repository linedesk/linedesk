import type { Booking } from '@linedesk/db/types'
import { useRows } from '../store.tsx'
import { Badge } from '../ui/kit.tsx'

const STATUS: Record<Booking['status'], string> = { confirmed: 'Confirmed', rescheduled: 'Rescheduled', cancelled: 'Cancelled' }

/** "TUE", "17", "9:00 – 10:00 AM" in the browser's time zone. */
export function bookingDisplay(booking: Pick<Booking, 'start_at' | 'end_at'>, locale?: string) {
  const start = new Date(booking.start_at)
  const end = new Date(booking.end_at)
  const time = new Intl.DateTimeFormat(locale ?? 'en-US', { hour: 'numeric', minute: '2-digit' })
  return {
    dow: new Intl.DateTimeFormat(locale ?? 'en-US', { weekday: 'short' }).format(start).toUpperCase(),
    day: String(start.getDate()),
    time: time.formatRange(start, end),
  }
}

/** The appointments the assistant booked on this call, under the summary. */
export function BookingCards({ callId }: { callId: string }) {
  const bookings = useRows('bookings')
    .filter(b => b.call_id === callId)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
  return (
    <>
      {bookings.map(booking => {
        const { dow, day, time } = bookingDisplay(booking)
        return (
          <section key={booking.id} className="bkc" aria-label="Booking">
            <div className="bkc-date">
              <span>{dow}</span>
              <b>{day}</b>
            </div>
            <div className="bkc-t">
              <b>{[booking.title, time].filter(Boolean).join(' · ')}</b>
              <span>{booking.calendar_name ?? 'Calendar'}</span>
            </div>
            <Badge tone={booking.status === 'cancelled' ? 'outline' : 'neutral'} dot>
              {STATUS[booking.status]}
            </Badge>
          </section>
        )
      })}
    </>
  )
}
