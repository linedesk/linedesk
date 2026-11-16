// Emails about finished calls: one per call to every member who wants it (their own setting, else
// the workspace default). Sent by a pg-boss job after `call.finish` committed (jobs.ts), so a slow
// mail server never holds up the agent. Test calls and spam send nothing.
import { DEFAULT_NOTIFICATIONS } from '@linedesk/actions'
import {
  appointment_types,
  assistants,
  bookings,
  calls,
  contacts,
  member,
  member_notification_settings,
  organization,
  transcript_segments,
  type Tx,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { EmailSender } from './email.ts'
import { type CallEmail, callEmail, emailSafeName, firstCallEmail, slotInZone } from './emails/templates.ts'
import { claimFirstCallEmail, releaseFirstCallEmail, setupRecipients } from './setup-emails.ts'
import type { UiLocale } from '@linedesk/i18n'
import { getT, localeForUser } from '@linedesk/i18n/server'

export { formatNumber } from './emails/templates.ts'

/** Members of the workspace who get an email for this call, with their address. */
export async function emailRecipients(
  tx: Tx,
  workspaceId: string,
): Promise<{ email: string; name: string; locale: UiLocale }[]> {
  const [settings] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const fallback = settings?.notify_email_default ?? DEFAULT_NOTIFICATIONS.email
  const rows = await tx
    .select({
      email: user.email,
      name: user.name,
      own: member_notification_settings.email,
      locale: user.locale,
      localeAuto: user.localeAuto,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(
      member_notification_settings,
      and(
        eq(member_notification_settings.workspace_id, member.organizationId),
        eq(member_notification_settings.user_id, member.userId),
      ),
    )
    .where(and(eq(member.organizationId, workspaceId), isNull(user.disabledAt)))
  return rows.filter(r => r.own ?? fallback).map(r => ({ email: r.email, name: r.name, locale: localeForUser(r) }))
}

export type NotifyResult = { sent: number; failed: number; skipped?: 'missing' | 'test' | 'spam' | 'unfinished' }

/** Sends the emails for one finished call. A failed address does not stop the others. */
export async function notifyCallFinished(tx: Tx, sender: EmailSender, callId: string): Promise<NotifyResult> {
  const [call] = await tx.select().from(calls).where(eq(calls.id, callId))
  if (!call || call.deleted_at) return { sent: 0, failed: 0, skipped: 'missing' }
  if (call.status !== 'completed') return { sent: 0, failed: 0, skipped: 'unfinished' }
  if (call.source === 'test') return { sent: 0, failed: 0, skipped: 'test' }
  if (call.outcome === 'spam') return { sent: 0, failed: 0, skipped: 'spam' }
  const [contact] = call.contact_id ? await tx.select().from(contacts).where(eq(contacts.id, call.contact_id)) : []
  // The assistant that answered; an older call (or a deleted assistant): the workspace's first.
  const [assistant] = await tx
    .select({ name: assistants.name })
    .from(assistants)
    .where(eq(assistants.workspace_id, call.workspace_id))
    .orderBy(sql`${assistants.id} = ${call.assistant_id ?? ''} desc`, asc(assistants.created_at))
    .limit(1)
  const [settings] = await tx
    .select({ timezone: workspace_settings.timezone })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, call.workspace_id))
  const timeZone = settings?.timezone ?? 'America/New_York'
  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, call.workspace_id))
  const [booked] = await tx
    .select({ start_at: bookings.start_at, type: appointment_types.name, title: bookings.title })
    .from(bookings)
    .leftJoin(appointment_types, eq(appointment_types.id, bookings.appointment_type_id))
    .where(and(eq(bookings.call_id, call.id), ne(bookings.status, 'cancelled')))
    .orderBy(desc(bookings.created_at))
    .limit(1)
  // What was said, in order: tool and system lines (transfers, bookings as events) stay in the app.
  const said = await tx
    .select({ speaker: transcript_segments.speaker, text: transcript_segments.text })
    .from(transcript_segments)
    .where(
      and(
        eq(transcript_segments.call_id, call.id),
        inArray(transcript_segments.speaker, ['caller', 'agent', 'human']),
        isNull(transcript_segments.tool_event),
      ),
    )
    .orderBy(asc(transcript_segments.at_ms), asc(transcript_segments.id))
  const transcript = said.flatMap(({ speaker, text }) => (speaker === 'system' ? [] : [{ speaker, text }]))
  // Per recipient language (email-locale.ts): the frame, the labels and the booked slot; the summary stays as written.
  const contentIn = (locale: UiLocale): CallEmail => ({
    workspaceId: call.workspace_id,
    callId: call.id,
    title: call.title,
    summary: call.summary,
    urgent: call.urgency === 'urgent',
    fromNumber: call.from_number,
    callerName: contact?.name ?? null,
    assistantName: assistant?.name ?? getT(locale).t('email.fallback.assistant'),
    startedAt: call.started_at,
    durationSec: call.duration_sec,
    timeZone,
    nextSteps: call.action_items.filter(item => !item.done).map(item => item.text),
    booking: booked
      ? {
          what: booked.type ?? booked.title ?? getT(locale).t('email.fallback.appointment'),
          when: slotInZone(booked.start_at, timeZone, locale),
        }
      : null,
    transcript,
    workspace: emailSafeName(workspace?.name, getT(locale).t('email.fallback.workspace')),
  })
  const recipients = await emailRecipients(tx, call.workspace_id)
  // The workspace's first real call is a moment of its own (setup-emails.ts), for those of them who get setup
  // emails (owners who did not turn them off: the same rule as the other setup emails); marked sent only when one
  // of them gets an email at all, and only when email really goes out (not only to the log).
  const setupTo = new Set(await setupRecipients(tx, call.workspace_id))
  const getsFirst = (r: { email: string }) => setupTo.has(r.email.toLowerCase())
  const first =
    sender.kind === 'smtp' &&
    recipients.some(getsFirst) &&
    (await claimFirstCallEmail(tx, call, new Date().toISOString()))
  const result: NotifyResult = { sent: 0, failed: 0 }
  for (const recipient of recipients) {
    try {
      const content = contentIn(recipient.locale)
      const email =
        first && getsFirst(recipient)
          ? firstCallEmail(content, undefined, recipient.locale)
          : callEmail(content, undefined, recipient.locale)
      await sender.send({ to: recipient.email, ...email })
      result.sent++
    } catch (e) {
      result.failed++
      console.warn(`call email to a member of ${call.workspace_id} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  // Nothing went out (the job tries again): the first-call email is still to come.
  if (first && result.failed && !result.sent) await releaseFirstCallEmail(tx, call.workspace_id)
  return result
}
