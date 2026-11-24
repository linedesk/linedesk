import type { Booking } from '@linedesk/db/types'
import { intlLocale } from '../i18n/format.ts'
import { useRows } from '../store.tsx'
import { Badge } from '../ui/kit.tsx'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'

const STATUS = {
  confirmed: msg('call.booking.confirmed'),
  rescheduled: msg('call.booking.rescheduled'),
  cancelled: msg('call.booking.cancelled'),
} satisfies Record<Booking['status'], MessageKey>

/** "TUE", "17", "9:00 – 10:00 AM" in the browser's time zone and the active language. */
export function bookingDisplay(booking: Pick<Booking, 'start_at' | 'end_at'>, locale?: string) {
  const start = new Date(booking.start_at)
  const end = new Date(booking.end_at)
  const time = new Intl.DateTimeFormat(locale ?? intlLocale(), { hour: 'numeric', minute: '2-digit' })
  return {
    dow: new Intl.DateTimeFormat(locale ?? intlLocale(), { weekday: 'short' }).format(start).toLocaleUpperCase(locale ?? intlLocale()),
    day: String(start.getDate()),
    time: time.formatRange(start, end),
  }
}

/** The appointments the assistant booked on this call, under the summary. */
export function BookingCards({ callId }: { callId: string }) {
  const t = useT()
  const bookings = useRows('bookings')
    .filter(b => b.call_id === callId)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
  return (
    <>
      {bookings.map(booking => {
        const { dow, day, time } = bookingDisplay(booking)
        return (
          <section key={booking.id} className="bkc" aria-label={t('call.booking.label')}>
            <div className="bkc-date">
              <span>{dow}</span>
              <b>{day}</b>
            </div>
            <div className="bkc-t">
              <b>{booking.title ? t('call.booking.titleAndTime', { title: booking.title, time }) : time}</b>
              <span>{booking.calendar_name ?? t('call.booking.calendar')}</span>
            </div>
            <Badge tone={booking.status === 'cancelled' ? 'outline' : 'neutral'} dot>
              {t(STATUS[booking.status])}
            </Badge>
          </section>
        )
      })}
    </>
  )
}
