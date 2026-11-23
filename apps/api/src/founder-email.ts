// The personal email from a founder: a few hours after the owner of a new workspace signed up, a short plain-text
// email from the founder's own address (no layout, no button), asking what made them sign up. Replies go to the
// founder. Off by default (a self-hosted install sends none): an instance admin turns it on with the name and address
// it comes from (Server admin › Workspaces › At risk). Goes out once per workspace (setup_emails, kind founder_hello), only to
// owners who did not turn setup emails off, and only for workspaces their owner made themselves: not a white-label
// partner's client (the partner talks to its clients) and not one a server admin made and handed over.
// The setup emails job runs it every few minutes (jobs.ts).
import type { FounderEmailData } from '@linedesk/actions'
import { instance_settings, organization, setup_emails, setup_events, type Tx, user } from '@linedesk/db'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import { type EmailSender, emailSender, partnerSenderLine } from './email.ts'
import { localesForUserIds } from './email-locale.ts'
import { appLink, type FounderSender, firstNameOf, founderEmail } from './emails/templates.ts'
import type { Handler } from './handler-context.ts'
import { appOrigin } from './partner-brand.ts'
import { setupRecipientRows } from './setup-emails.ts'
import { setupUnsubscribeUrl, unsubscribeHeaders } from './setup-unsubscribe.ts'

const SETTING_KEY = 'founder_email'

/** Who the email comes from, or null while it is off. */
export async function founderSender(tx: Tx): Promise<FounderSender | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SETTING_KEY))
  if (!row?.value) return null
  try {
    const v = JSON.parse(row.value) as Partial<FounderSender>
    return typeof v.name === 'string' && typeof v.email === 'string' ? { name: v.name, email: v.email } : null
  } catch {
    return null
  }
}

const emailConnected = () => emailSender.kind === 'smtp'

export const founderEmailHandlers: Record<string, Handler> = {
  'founderEmail.get': async ({ tx }) => ({
    rows: {},
    data: { sender: await founderSender(tx), emailConnected: emailConnected() } satisfies FounderEmailData,
  }),

  'founderEmail.set': async ({ tx, actor, now }, input: { sender: FounderSender | null }) => {
    const sender = input.sender ? { name: input.sender.name.trim(), email: input.sender.email.trim() } : null
    const value = sender ? JSON.stringify(sender) : ''
    await tx
      .insert(instance_settings)
      .values({ key: SETTING_KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { sender, emailConnected: emailConnected() } satisfies FounderEmailData }
  },
}

// ---------------------------------------------------------------- when and for whom

/**
 * Hours after the owner joined (the `signup` milestone) in which it may go out. Missed (the install was down, or it
 * was turned on later) it is skipped, never sent days late: workspaces that signed up before it was turned on get none.
 */
export const FOUNDER_EMAIL_WINDOW = [3, 48] as const

/**
 * A workspace its owner made: the `signup` milestone is recorded when the workspace is made (POST /v1/workspaces,
 * the setup MCP). One a server admin made gets it only when its owner joins, later (memberships.ts, ownerJoined).
 */
const MADE_BY_OWNER_MINUTES = 10

// ---------------------------------------------------------------- sending

/** What to log about a failed send: the error's code or class, never its message (it can hold addresses). */
const errorKind = (e: unknown) =>
  (e as { code?: unknown } | null)?.code
    ? String((e as { code: unknown }).code)
    : e instanceof Error
      ? e.name
      : typeof e

/** Sends it for one workspace when it is due, marked sent first so two runs never both send it. */
export async function sendFounderEmailFor(
  tx: Tx,
  sender: EmailSender,
  founder: FounderSender,
  workspaceId: string,
  now: string,
): Promise<{ sent: number; failed: number } | null> {
  const recipients = await setupRecipientRows(tx, workspaceId)
  if (!recipients.length) return null
  const claimed = await tx
    .insert(setup_emails)
    .values({ workspace_id: workspaceId, kind: 'founder_hello', sent_at: now })
    .onConflictDoNothing()
    .returning()
  if (!claimed.length) return null
  const names = new Map(
    (
      await tx
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(
          inArray(
            user.id,
            recipients.map(r => r.userId),
          ),
        )
    ).map(u => [u.id, u.name]),
  )
  const locales = await localesForUserIds(
    tx,
    recipients.map(r => r.userId),
  )
  const origin = await appOrigin(workspaceId, tx)
  const from = partnerSenderLine(founder.name, founder.email)
  let sent = 0
  let failed = 0
  for (const { email: to, userId } of recipients) {
    const oneClick = setupUnsubscribeUrl(workspaceId, userId, origin)
    try {
      await sender.send({
        to,
        from,
        replyTo: founder.email,
        ...founderEmail(
          {
            firstName: firstNameOf(names.get(userId)),
            founder,
            unsubscribeUrl: oneClick ?? appLink(origin, workspaceId, 'account/preferences'),
          },
          locales.get(userId) ?? 'en',
        ),
        ...(oneClick ? { headers: unsubscribeHeaders(oneClick) } : {}),
      })
      sent++
    } catch (e) {
      failed++
      console.warn(`founder email for ${workspaceId} failed (${errorKind(e)})`)
    }
  }
  // Nothing went out at all (mail server down): the mark goes again, so the next run tries once more.
  if (failed && !sent)
    await tx
      .delete(setup_emails)
      .where(and(eq(setup_emails.workspace_id, workspaceId), eq(setup_emails.kind, 'founder_hello')))
  return { sent, failed }
}

/** Every workspace its owner made in the window, not a partner's client, not disabled: the email goes out. A job. */
export async function sendDueFounderEmails(tx: Tx, sender: EmailSender, now = new Date().toISOString()) {
  const founder = await founderSender(tx)
  if (!founder) return { off: true, sent: 0, failed: 0 }
  if (sender.kind !== 'smtp') return { off: false, notConnected: true, sent: 0, failed: 0 }
  const [from, to] = FOUNDER_EMAIL_WINDOW
  const at = (hours: number) => new Date(Date.parse(now) - hours * 3_600_000).toISOString()
  const due = await tx
    .select({ id: setup_events.workspace_id, signedUpAt: setup_events.at, createdAt: organization.createdAt })
    .from(setup_events)
    .innerJoin(organization, eq(organization.id, setup_events.workspace_id))
    .where(
      and(
        eq(setup_events.event, 'signup'),
        gt(setup_events.at, at(to)),
        isNull(organization.disabledAt),
        isNull(organization.partnerId),
      ),
    )
  let sent = 0
  let failed = 0
  for (const w of due) {
    const signedUp = Date.parse(w.signedUpAt)
    if (signedUp > Date.parse(at(from))) continue
    if (signedUp - new Date(w.createdAt).getTime() > MADE_BY_OWNER_MINUTES * 60_000) continue
    try {
      const result = await sendFounderEmailFor(tx, sender, founder, w.id, now)
      sent += result?.sent ?? 0
      failed += result?.failed ?? 0
    } catch (e) {
      console.error(`founder email for ${w.id} failed (${errorKind(e)})`)
    }
  }
  return { off: false, sent, failed }
}
