// The email that confirms a booking to the caller, when they gave an address (SMS is not sent yet).
// Sent by a pg-boss job after appointment.book committed (jobs.ts).
import {
  appointment_types,
  bookings,
  calls,
  organization,
  phone_numbers,
  type Tx,
  workspace_settings,
} from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { DEFAULT_TIME_ZONE } from './bookings.ts'
import { callerLocale } from './email-locale.ts'
import type { EmailSender } from './email.ts'
import { bookingConfirmationEmail, emailSafeName, slotInZone } from './emails/templates.ts'
import { getT } from '@linedesk/i18n/server'

/** The number the caller can ring to change the booking: the business's own, which forwards to the assistant. */
async function businessNumber(tx: Tx, callId: string | null): Promise<string | null> {
  if (!callId) return null
  const [call] = await tx.select({ to: calls.to_number }).from(calls).where(eq(calls.id, callId))
  if (!call) return null
  const [number] = await tx
    .select({ forwardedFrom: phone_numbers.forwarded_from })
    .from(phone_numbers)
    .where(eq(phone_numbers.e164, call.to))
  return number?.forwardedFrom || call.to
}

/** Sends the confirmation for one booking; nothing when it has no address or was cancelled since. */
export async function sendBookingConfirmation(
  tx: Tx,
  sender: EmailSender,
  bookingId: string,
): Promise<'sent' | 'skipped'> {
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId))
  if (!booking?.caller_email || booking.status === 'cancelled') return 'skipped'
  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, booking.workspace_id))
  const [type] = booking.appointment_type_id
    ? await tx.select().from(appointment_types).where(eq(appointment_types.id, booking.appointment_type_id))
    : []
  const [settings] = await tx
    .select({ timezone: workspace_settings.timezone })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, booking.workspace_id))
  // Only the frame is translated: the business, its appointment type and the address stay as they were written.
  const locale = await callerLocale(tx, booking.workspace_id, booking.call_id)
  const { t } = getT(locale)
  await sender.send({
    to: booking.caller_email,
    ...bookingConfirmationEmail(
      {
        business: emailSafeName(workspace?.name, t('email.fallback.business')),
        what: emailSafeName(type?.name, t('email.fallback.appointment')).toLowerCase(),
        when: slotInZone(booking.start_at, settings?.timezone ?? DEFAULT_TIME_ZONE, locale),
        minutes: type?.duration_min ?? null,
        address: booking.address,
        phone: await businessNumber(tx, booking.call_id),
      },
      undefined,
      locale,
    ),
  })
  return 'sent'
}
