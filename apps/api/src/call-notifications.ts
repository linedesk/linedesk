// Emails about finished calls: one per call to every member with "Email for every call" on (their own setting, else
// the team default they joined with). Sent by a pg-boss job after `call.finish` committed (jobs.ts), so a slow
// mail server never holds up the agent. Test calls and spam send nothing.
// An assistant with call email rules (assistants.email_rules) also sends them to the members of the rules that fit
// (email-routing.ts): a language model says which rules fit, the code picks the members; the decision is stored in calls.email_route before anything is
// sent, so a retry sends to the same people and never asks the model again.
import { DEFAULT_NOTIFICATIONS, routesEmails } from '@linedesk/actions'
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
import type { EmailRoute, EmailRouteRecipient } from '@linedesk/db/types'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { EmailSender } from './email.ts'
import { callerLocale } from './email-locale.ts'
import { assignByRouting, membersById, routeCall, sendableOutside } from './email-routing.ts'
import { type CallEmail, callEmail, emailSafeName, firstCallEmail, slotInZone } from './emails/templates.ts'
import { type EvaluationModel, evaluationModel } from './evaluations.ts'
import { outsideStopUrl } from './email-recipients.ts'
import { unsubscribeHeaders } from './setup-unsubscribe.ts'
import { claimFirstCallEmail, releaseFirstCallEmail, setupRecipients } from './setup-emails.ts'
import type { UiLocale } from '@linedesk/i18n'
import { getT, localeForUser } from '@linedesk/i18n/server'
import { withWorkspaceBrand } from './partner-brand.ts'

export { formatNumber } from './emails/templates.ts'

/** Members of the workspace who get an email for this call, with their address. */
export async function emailRecipients(
  tx: Tx,
  workspaceId: string,
): Promise<{ userId: string; email: string; name: string; locale: UiLocale }[]> {
  const [settings] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const fallback = settings?.notify_email_default ?? DEFAULT_NOTIFICATIONS.email
  const rows = await tx
    .select({
      userId: user.id,
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
  return rows
    .filter(r => r.own ?? fallback)
    .map(r => ({ userId: r.userId, email: r.email, name: r.name, locale: localeForUser(r) }))
}

type MemberRecipient = Awaited<ReturnType<typeof emailRecipients>>[number]

/** Lets tests hand in a language model; the default is the one set up (Server admin › Providers). */
export type NotifyDeps = { model?: (tx: Tx) => Promise<EvaluationModel | null> }

export const asMemberRoute = (r: MemberRecipient): EmailRouteRecipient => ({
  kind: 'member',
  user_id: r.userId,
  name: r.name,
})

/**
 * Who a stored decision sends to now: its members who are still in the workspace and not disabled, and its outside
 * addresses only while they are confirmed and not stopped. A retry sends to the same people as the first try.
 */
async function recipientsOf(tx: Tx, workspaceId: string, route: EmailRoute) {
  const memberIds = route.to.flatMap(r => (r.kind === 'member' ? [r.user_id] : []))
  const emails = route.to.flatMap(r => (r.kind === 'outside' ? [r.email] : []))
  const [members, outside] = await Promise.all([
    membersById(tx, workspaceId, memberIds),
    sendableOutside(tx, workspaceId, emails),
  ])
  return { members: members.map(m => ({ userId: m.userId, email: m.email, name: m.name, locale: m.locale })), outside }
}

export type NotifyResult = { sent: number; failed: number; skipped?: 'missing' | 'test' | 'spam' | 'unfinished' }

/**
 * Sends the emails for one finished call. A failed address does not stop the others. With the workspace's brand: a
 * white-label partner's client gets them under the partner's name (partner-brand.ts).
 */
export async function notifyCallFinished(
  tx: Tx,
  sender: EmailSender,
  callId: string,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const [found] = await tx.select({ workspaceId: calls.workspace_id }).from(calls).where(eq(calls.id, callId))
  return withWorkspaceBrand(found?.workspaceId, () => sendCallEmails(tx, sender, callId, deps), tx)
}

async function sendCallEmails(tx: Tx, sender: EmailSender, callId: string, deps: NotifyDeps): Promise<NotifyResult> {
  const [call] = await tx.select().from(calls).where(eq(calls.id, callId))
  if (!call || call.deleted_at) return { sent: 0, failed: 0, skipped: 'missing' }
  if (call.status !== 'completed') return { sent: 0, failed: 0, skipped: 'unfinished' }
  if (call.source === 'test') return { sent: 0, failed: 0, skipped: 'test' }
  if (call.outcome === 'spam') return { sent: 0, failed: 0, skipped: 'spam' }
  const [contact] = call.contact_id ? await tx.select().from(contacts).where(eq(contacts.id, call.contact_id)) : []
  // The assistant that answered; an older call (or a deleted assistant): the workspace's first.
  const [assistant] = await tx
    .select({ name: assistants.name, email_rules: assistants.email_rules })
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
    fields: call.fields,
    booking: booked
      ? {
          what: booked.type ?? booked.title ?? getT(locale).t('email.fallback.appointment'),
          when: slotInZone(booked.start_at, timeZone, locale),
        }
      : null,
    transcript,
    workspace: emailSafeName(workspace?.name, getT(locale).t('email.fallback.workspace')),
  })
  const everyone = await emailRecipients(tx, call.workspace_id)
  // Routed by the assistant's rules: decided once per call, stored before anything is sent.
  let route = call.email_route
  if (!route && assistant && routesEmails(assistant.email_rules)) {
    const model = assistant.email_rules.rules.length
      ? await (deps.model ?? ((t: Tx) => evaluationModel(t)))(tx).catch(() => null)
      : null
    const now = new Date().toISOString()
    const decided = await routeCall(
      tx,
      call.workspace_id,
      assistant.email_rules,
      {
        id: call.id,
        title: call.title,
        urgent: call.urgency === 'urgent',
        caller: contact?.name ?? call.from_number,
        summary: call.summary,
        fields: call.fields,
        assistantName: assistant.name,
        transcript,
      },
      model,
      everyone.map(asMemberRoute),
      now,
    )
    const [stored] = await tx
      .update(calls)
      .set({ email_route: decided })
      .where(and(eq(calls.id, call.id), isNull(calls.email_route)))
      .returning({ email_route: calls.email_route })
    if (stored) {
      route = decided
      if (decided.assigned_user_id) await assignByRouting(tx, call, decided.assigned_user_id, now)
    } else {
      // Another run stored its decision first: send what it decided.
      const [again] = await tx.select({ email_route: calls.email_route }).from(calls).where(eq(calls.id, call.id))
      route = again?.email_route ?? decided
    }
  }
  const { members: recipients, outside } = route
    ? await recipientsOf(tx, call.workspace_id, route)
    : { members: everyone, outside: [] }
  // The workspace's first real call is a moment of its own (setup-emails.ts), for those of them who get setup
  // emails (owners who did not turn them off: the same rule as the other setup emails); marked sent only when one
  // of them gets an email at all, and only when email really goes out (not only to the log).
  const setupTo = new Set(await setupRecipients(tx, call.workspace_id))
  const getsFirst = (r: { email: string }) => setupTo.has(r.email.toLowerCase())
  const first =
    sender.kind === 'smtp' &&
    recipients.some(getsFirst) &&
    (await claimFirstCallEmail(tx, call, new Date().toISOString()))
  // Members a rule adds (not an email for every call): the footer says why they get it.
  const everyCall = new Set(everyone.map(r => r.userId))
  const result: NotifyResult = { sent: 0, failed: 0 }
  for (const recipient of recipients) {
    try {
      const content = { ...contentIn(recipient.locale), byRule: !everyCall.has(recipient.userId) }
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
  // Outside the team (confirmed, not stopped): the call's language like the summary it carries (callerLocale), no link
  // into the app, a link to stop them.
  if (outside.length) {
    const locale = await callerLocale(tx, call.workspace_id, call.id)
    for (const recipient of outside) {
      const stopUrl = outsideStopUrl(recipient.id)
      // Without SECRETS_KEY there is no stop link, and an outside address never gets an email it cannot stop.
      if (!stopUrl) continue
      try {
        const email = callEmail(contentIn(locale), undefined, locale, { stopUrl })
        await sender.send({ to: recipient.email, ...email, headers: unsubscribeHeaders(stopUrl) })
        result.sent++
      } catch (e) {
        result.failed++
        console.warn(
          `call email to an outside address of ${call.workspace_id} failed: ${e instanceof Error ? e.message : e}`,
        )
      }
    }
  }
  // Nothing went out (the job tries again): the first-call email is still to come.
  if (first && result.failed && !result.sent) await releaseFirstCallEmail(tx, call.workspace_id)
  return result
}
