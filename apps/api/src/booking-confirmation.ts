// The email that confirms a booking to the caller, when they gave an address (SMS is not sent yet).
// Sent by a pg-boss job after appointment.book committed (jobs.ts).
import { appointment_types, bookings, organization, type Tx, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { DEFAULT_TIME_ZONE, slotLabel } from './bookings.ts'
import type { Email, EmailSender } from './email.ts'
import { emailSafeName } from './team.ts'

type Confirmation = { business: string; what: string; when: string; minutes: number | null }

/** Plain text, no link: the caller has no account. */
export function confirmationEmail({ business, what, when, minutes }: Confirmation): Omit<Email, 'to'> {
  return {
    subject: `Your ${what} with ${business}: ${when}`,
    text: [
      `Your ${what} with ${business} is booked for ${when}${minutes ? ` (${minutes} minutes)` : ''}.`,
      `To change or cancel it, call ${business} back.`,
    ].join('\n\n'),
  }
}

/** Sends the confirmation for one booking; nothing when it has no address or was cancelled since. */
export async function sendBookingConfirmation(tx: Tx, sender: EmailSender, bookingId: string): Promise<'sent' | 'skipped'> {
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId))
  if (!booking?.caller_email || booking.status === 'cancelled') return 'skipped'
  const [workspace] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, booking.workspace_id))
  const [type] = booking.appointment_type_id ? await tx.select().from(appointment_types).where(eq(appointment_types.id, booking.appointment_type_id)) : []
  const [settings] = await tx.select({ timezone: workspace_settings.timezone }).from(workspace_settings).where(eq(workspace_settings.workspace_id, booking.workspace_id))
  const when = slotLabel(new Date(booking.start_at).toISOString(), settings?.timezone ?? DEFAULT_TIME_ZONE)
  await sender.send({
    to: booking.caller_email,
    ...confirmationEmail({ business: emailSafeName(workspace?.name, 'the business'), what: emailSafeName(type?.name, 'appointment').toLowerCase(), when, minutes: type?.duration_min ?? null }),
  })
  return 'sent'
}
