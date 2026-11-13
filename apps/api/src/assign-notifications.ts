// Tells a member that a teammate assigned them a call: an email (their own setting "Email me when a
// call is assigned to me", on by default) and a push to their browsers (push.ts). Sent by a pg-boss job a few seconds
// after call.assign committed (jobs.ts), and only when that assignment still stands: an undo or a
// quick change of mind sends nothing.
import {
  call_events,
  calls,
  contacts,
  member,
  member_notification_settings,
  organization,
  type Tx,
  user,
} from '@linedesk/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { EmailSender } from './email.ts'
import { assignedCallEmail, emailSafeName } from './emails/templates.ts'
import { notifyAssignedPush, type PushResult, type PushSender } from './push.ts'

export type AssignNotifyResult = {
  email: 'sent' | 'off' | 'failed' | null
  push: PushResult | null
  skipped?: 'missing' | 'changed' | 'not-a-member' | 'self'
}

/** The assignment `eventId` recorded, if it is still the call's latest and the call is still theirs. */
async function standingAssignment(tx: Tx, eventId: string) {
  const [event] = await tx.select().from(call_events).where(eq(call_events.id, eventId))
  if (!event?.assignee_id) return null
  const [latest] = await tx
    .select({ id: call_events.id })
    .from(call_events)
    .where(and(eq(call_events.call_id, event.call_id), eq(call_events.kind, 'assigned')))
    .orderBy(desc(call_events.created_at), desc(call_events.version))
    .limit(1)
  const [call] = await tx.select().from(calls).where(eq(calls.id, event.call_id))
  if (latest?.id !== event.id || !call || call.deleted_at || call.assignee_id !== event.assignee_id) return null
  return { event, call, assigneeId: event.assignee_id }
}

/** The assignee's address and whether they want emails, while they are an active member of the call's workspace. */
async function assigneeOf(tx: Tx, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ email: user.email, wants: member_notification_settings.assigned_email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(
      member_notification_settings,
      and(
        eq(member_notification_settings.workspace_id, member.organizationId),
        eq(member_notification_settings.user_id, member.userId),
      ),
    )
    .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId), isNull(user.disabledAt)))
  return row ? { email: row.email, wantsEmail: row.wants ?? true } : null
}

/** Who assigned it: their name, else "A teammate"; an API key: "An integration". */
async function assignerName(tx: Tx, actorId: string | null) {
  if (!actorId) return 'An integration'
  const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorId))
  return emailSafeName(row?.name, 'A teammate')
}

export async function notifyAssigned(
  tx: Tx,
  emails: EmailSender,
  pushes: PushSender,
  eventId: string,
): Promise<AssignNotifyResult> {
  const standing = await standingAssignment(tx, eventId)
  if (!standing) return { email: null, push: null, skipped: 'changed' }
  const { event, call, assigneeId } = standing
  if (event.actor_id === assigneeId) return { email: null, push: null, skipped: 'self' }
  const assignee = await assigneeOf(tx, call.workspace_id, assigneeId)
  if (!assignee) return { email: null, push: null, skipped: 'not-a-member' }
  const byName = await assignerName(tx, event.actor_id)
  const [contact] = call.contact_id ? await tx.select().from(contacts).where(eq(contacts.id, call.contact_id)) : []
  let email: AssignNotifyResult['email'] = 'off'
  if (assignee.wantsEmail) {
    try {
      const [workspace] = await tx
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, call.workspace_id))
      const content = assignedCallEmail({
        workspaceId: call.workspace_id,
        callId: call.id,
        title: call.title,
        summary: call.summary,
        urgent: call.urgency === 'urgent',
        fromNumber: call.from_number,
        callerName: contact?.name ?? null,
        assignedBy: byName,
        workspace: emailSafeName(workspace?.name, 'your workspace'),
      })
      await emails.send({ to: assignee.email, ...content })
      email = 'sent'
    } catch (e) {
      email = 'failed'
      console.warn(`assignment email to a member of ${call.workspace_id} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const push = await notifyAssignedPush(tx, pushes, call.id, assigneeId, byName)
  return { email, push }
}
