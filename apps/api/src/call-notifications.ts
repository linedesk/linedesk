// Emails about finished calls: one per call to every member who wants it (their own setting, else
// the workspace default). Sent by a pg-boss job after `call.finish` committed (jobs.ts), so a slow
// mail server never holds up the agent. Test calls and spam send nothing.
import { DEFAULT_NOTIFICATIONS } from '@linedesk/actions'
import {
  assistants,
  calls,
  contacts,
  member,
  member_notification_settings,
  type Tx,
  user,
  workspace_settings,
} from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Email, EmailSender } from './email.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/** +15035550142 → +1 503 555 0142 (the web app's format). */
export const formatNumber = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

/** Members of the workspace who get an email for this call, with their address. */
export async function emailRecipients(tx: Tx, workspaceId: string): Promise<{ email: string; name: string }[]> {
  const [settings] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const fallback = settings?.notify_email_default ?? DEFAULT_NOTIFICATIONS.email
  const rows = await tx
    .select({ email: user.email, name: user.name, own: member_notification_settings.email })
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
  return rows.filter(r => r.own ?? fallback).map(({ email, name }) => ({ email, name }))
}

type Context = { call: Call; callerName: string | null; assistantName: string; timeZone: string }

/** The email for one finished call: what it was about, the summary, next steps and a link. */
export function callEmail(
  { call, callerName, assistantName, timeZone }: Context,
  to: string,
  origin = WEB_ORIGIN,
): Email {
  const caller = callerName ? `${callerName} (${formatNumber(call.from_number)})` : formatNumber(call.from_number)
  const topic = call.title || 'New call'
  const urgent = call.urgency === 'urgent'
  const at = new Date(call.started_at)
    .toLocaleString('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' ') // plain spaces: some mail apps show the narrow one as a box
  const steps = call.action_items.filter(item => !item.done).map(item => `- ${item.text}`)
  const text = [
    `${assistantName} answered a call from ${caller} on ${at}.`,
    '',
    `${urgent ? 'URGENT: ' : ''}${topic}`,
    ...(call.summary ? [call.summary] : []),
    ...(steps.length ? ['', 'Next steps:', ...steps] : []),
    '',
    `Open the call: ${origin}/#call/${encodeURIComponent(call.id)}`,
    '',
    'You get one email per call. Turn it off in Linedesk under Settings, Notifications.',
  ].join('\n')
  return { to, subject: `${urgent ? 'Urgent: ' : ''}${topic} · ${callerName || formatNumber(call.from_number)}`, text }
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
  const context: Context = {
    call,
    callerName: contact?.name ?? null,
    assistantName: assistant?.name ?? 'Your assistant',
    timeZone: settings?.timezone ?? 'America/New_York',
  }
  const result: NotifyResult = { sent: 0, failed: 0 }
  for (const recipient of await emailRecipients(tx, call.workspace_id)) {
    try {
      await sender.send(callEmail(context, recipient.email))
      result.sent++
    } catch (e) {
      result.failed++
      console.warn(`call email to a member of ${call.workspace_id} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  return result
}
