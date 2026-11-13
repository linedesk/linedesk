// Setup emails: the first week after sign-up is onboarding too. Built from the workspace's setup milestones
// (setup_events): a few hours after sign-up what is left, on day 1 and day 3 the one next step while no real call
// has reached the assistant (day 3 also offers a partner who sets it up), the first real call as its own email
// (call-notifications.ts), and a week after sign-up a summary for businesses that are live. Each goes out at most
// once per workspace (setup_emails), only to owners who did not turn them off, and only when an instance admin
// turned them on (off by default: a self-hosted install sends none). A job checks every few minutes (jobs.ts).
// What a step is, which number and what counts as live is the shared definition in @linedesk/actions (setup-state.ts),
// the same the go-live checklist in the inbox uses. Until #488 (LIN-85) is merged, setup-state.ts is an identical copy
// in this branch; it goes away with the merge.
import {
  isLive,
  liveMilestones,
  nextSetupStep,
  type SetupEmailsData,
  setupNumber,
  takesAllCalls,
} from '@linedesk/actions'
import {
  assistants,
  calls,
  instance_settings,
  member,
  member_notification_settings,
  organization,
  phone_numbers,
  type SetupEmailKind,
  setup_emails,
  setup_events,
  type Tx,
  user,
} from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { type EmailSender, emailSender } from './email.ts'
import { setupUnsubscribeUrl, unsubscribeHeaders } from './setup-unsubscribe.ts'
import {
  emailSafeName,
  PARTNER_DIRECTORY_URL,
  type SetupEmail,
  setupDay0Email,
  setupNudgeEmail,
  WEB_ORIGIN,
  weekSummaryEmail,
} from './emails/templates.ts'
import type { RenderedEmail } from './emails/layout.ts'
import type { Handler } from './handler-context.ts'
import { HANDLED } from './setup-events.ts'

const SETTING_KEY = 'setup_emails'

/** Whether this install sends setup emails: an instance admin turned them on. Off by default. */
export async function setupEmailsOn(tx: Tx): Promise<boolean> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SETTING_KEY))
  return row?.value === 'on'
}

/** What the admin switch shows next to on/off: whether email really goes out, and the partner link of day 3. */
const installFacts = () => ({
  emailConnected: emailSender.kind === 'smtp',
  partnerDirectoryUrl: PARTNER_DIRECTORY_URL,
})

export const setupEmailHandlers: Record<string, Handler> = {
  'setupEmails.get': async ({ tx }) => ({
    rows: {},
    data: { on: await setupEmailsOn(tx), ...installFacts() } satisfies SetupEmailsData,
  }),

  'setupEmails.set': async ({ tx, actor, now }, input: { on: boolean }) => {
    const value = input.on ? 'on' : 'off'
    await tx
      .insert(instance_settings)
      .values({ key: SETTING_KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { on: input.on, ...installFacts() } satisfies SetupEmailsData }
  },
}

// ---------------------------------------------------------------- when

type ScheduledKind = Exclude<SetupEmailKind, 'first_call'>

/**
 * Hours after sign-up in which each email may go out. The windows do not overlap, so at most one is due at a
 * time, and one missed (the install was down, or the emails were turned on later) is skipped, never sent late.
 */
export const SETUP_EMAIL_WINDOWS: Record<ScheduledKind, readonly [from: number, to: number]> = {
  setup_day0: [2, 24],
  setup_day1: [24, 72],
  setup_day3: [72, 7 * 24],
  week_summary: [7 * 24, 9 * 24],
}
/** Workspaces younger than this are looked at; older ones have had every email they will get. */
const LOOK_BACK_HOURS = SETUP_EMAIL_WINDOWS.week_summary[1]

export type SetupState = {
  hoursSinceSignup: number
  /** A real call reached the assistant (isLive). */
  live: boolean
  sent: ReadonlySet<SetupEmailKind>
}

/** The email due now, or null. The setup ones only until the business is live; the week summary only once it is. */
export function dueSetupEmail({ hoursSinceSignup, live, sent }: SetupState): ScheduledKind | null {
  for (const [kind, [from, to]] of Object.entries(SETUP_EMAIL_WINDOWS) as [
    ScheduledKind,
    readonly [number, number],
  ][]) {
    if (hoursSinceSignup < from || hoursSinceSignup >= to || sent.has(kind)) continue
    if ((kind === 'week_summary') !== live) continue
    return kind
  }
  return null
}

// ---------------------------------------------------------------- who and what

/** Owners of the workspace who get setup emails (not disabled, not turned off), each address once. */
export async function setupRecipients(tx: Tx, workspaceId: string): Promise<string[]> {
  return (await setupRecipientRows(tx, workspaceId)).map(r => r.email)
}

/** The owners who get setup emails, with their user id (for their own unsubscribe link); one per address. */
async function setupRecipientRows(tx: Tx, workspaceId: string): Promise<{ email: string; userId: string }[]> {
  const rows = await tx
    .select({ email: user.email, userId: member.userId, own: member_notification_settings.setup_emails })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(
      member_notification_settings,
      and(
        eq(member_notification_settings.workspace_id, member.organizationId),
        eq(member_notification_settings.user_id, member.userId),
      ),
    )
    .where(and(eq(member.organizationId, workspaceId), eq(member.role, 'owner'), isNull(user.disabledAt)))
  const byEmail = new Map<string, string>()
  for (const r of rows)
    if (r.own !== false && !byEmail.has(r.email.toLowerCase())) byEmail.set(r.email.toLowerCase(), r.userId)
  return [...byEmail].map(([email, userId]) => ({ email, userId }))
}

const milestonesOf = async (tx: Tx, workspaceId: string) =>
  new Map(
    (await tx.select().from(setup_events).where(eq(setup_events.workspace_id, workspaceId))).map(e => [e.event, e.at]),
  )

/** The email of `kind` for this workspace, rendered per recipient with their own unsubscribe link. */
async function emailFor(
  tx: Tx,
  workspaceId: string,
  kind: ScheduledKind,
  signedUpAt: string,
  forwardingVerified: boolean,
): Promise<(unsubscribeUrl: string | null) => RenderedEmail> {
  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  const [assistant] = await tx
    .select({ name: assistants.name })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  const names = {
    workspaceId,
    workspace: emailSafeName(workspace?.name, 'your business'),
    assistantName: emailSafeName(assistant?.name, 'Your assistant'),
  }
  if (kind === 'week_summary') {
    const [counts] = await tx
      .select({
        calls: sql<number>`count(*)::int`,
        urgent: sql<number>`count(*) filter (where ${calls.urgency} = 'urgent')::int`,
        booked: sql<number>`count(*) filter (where ${calls.outcome} in ('booked', 'rescheduled'))::int`,
        messages: sql<number>`count(*) filter (where ${calls.outcome} in ('message', 'callback'))::int`,
      })
      .from(calls)
      .where(
        and(
          eq(calls.workspace_id, workspaceId),
          eq(calls.source, 'phone'),
          eq(calls.from_own_number, false),
          // Answered: the assistant did something for the caller (not a hang-up, not spam).
          inArray(calls.outcome, [...HANDLED] as NonNullable<Call['outcome']>[]),
          sql`${calls.started_at} >= ${signedUpAt}`,
        ),
      )
    const week = { ...names, calls: 0, urgent: 0, booked: 0, messages: 0, ...counts }
    return url => weekSummaryEmail(week, WEB_ORIGIN, url)
  }
  const number = setupNumber(
    await tx
      .select({
        id: phone_numbers.id,
        e164: phone_numbers.e164,
        mode: phone_numbers.mode,
        created_at: phone_numbers.created_at,
      })
      .from(phone_numbers)
      .where(eq(phone_numbers.workspace_id, workspaceId)),
  )
  const setup: SetupEmail = {
    ...names,
    numberId: number?.id ?? null,
    number: number?.e164 ?? null,
    takesAllCalls: !!number && takesAllCalls(number.mode),
    // Setup emails go out only while the workspace is not live (dueSetupEmail).
    step: nextSetupStep({ number, forwardingVerified, live: false }) ?? 'first_call',
  }
  if (kind === 'setup_day0') return url => setupDay0Email(setup, WEB_ORIGIN, url)
  return url => setupNudgeEmail(kind === 'setup_day1' ? 1 : 3, setup, WEB_ORIGIN, url)
}

/** What to log about a failed send or sweep: the error's code or class, never its message (it can hold addresses). */
const errorKind = (e: unknown) =>
  (e as { code?: unknown } | null)?.code
    ? String((e as { code: unknown }).code)
    : e instanceof Error
      ? e.name
      : typeof e

async function sendAll(
  sender: EmailSender,
  to: { email: string; userId: string }[],
  render: (unsubscribeUrl: string | null) => RenderedEmail,
  workspaceId: string,
) {
  let sent = 0
  let failed = 0
  for (const { email: address, userId } of to) {
    const unsubscribeUrl = setupUnsubscribeUrl(workspaceId, userId)
    try {
      await sender.send({
        to: address,
        ...render(unsubscribeUrl),
        ...(unsubscribeUrl ? { headers: unsubscribeHeaders(unsubscribeUrl) } : {}),
      })
      sent++
    } catch (e) {
      // An SMTP timeout after the server took the message counts as failed: when nothing went out, the next run
      // sends again, so a rare duplicate is possible. Accepted over a missed email.
      failed++
      console.warn(`setup email for ${workspaceId} failed (${errorKind(e)})`)
    }
  }
  return { sent, failed }
}

// ---------------------------------------------------------------- sending

export type SetupEmailResult = { kind: ScheduledKind; sent: number; failed: number }

/**
 * Sends the email due for one workspace now, if any, and marks it sent first so two runs never both send it.
 * When nothing could go out at all (mail server down), the mark goes again and the next run tries once more.
 * Only when email really goes out (SMTP): printed to the log it would count as sent and never reach the owner.
 */
export async function sendSetupEmailFor(
  tx: Tx,
  sender: EmailSender,
  workspaceId: string,
  now: string,
): Promise<SetupEmailResult | null> {
  if (sender.kind !== 'smtp') return null
  const milestones = await milestonesOf(tx, workspaceId)
  const signedUpAt = milestones.get('signup')
  if (!signedUpAt) return null
  const sent = new Set(
    (
      await tx.select({ kind: setup_emails.kind }).from(setup_emails).where(eq(setup_emails.workspace_id, workspaceId))
    ).map(r => r.kind),
  )
  const kind = dueSetupEmail({
    hoursSinceSignup: (Date.parse(now) - Date.parse(signedUpAt)) / 3_600_000,
    // isLive; the calls are only looked at when no milestone says so already.
    live: isLive(milestones, false) || (await hasRealCall(tx, workspaceId)),
    sent,
  })
  if (!kind) return null
  const claimed = await tx
    .insert(setup_emails)
    .values({ workspace_id: workspaceId, kind, sent_at: now })
    .onConflictDoNothing()
    .returning()
  if (!claimed.length) return null
  // Forwarding works once the check passed or a real caller reached a forwarding number (as in the go-live checklist).
  const forwardingVerified = milestones.has('forwarding_verified') || (await forwardedCallArrived(tx, workspaceId))
  const email = await emailFor(tx, workspaceId, kind, signedUpAt, forwardingVerified)
  const result = await sendAll(sender, await setupRecipientRows(tx, workspaceId), email, workspaceId)
  if (result.failed && !result.sent)
    await tx.delete(setup_emails).where(and(eq(setup_emails.workspace_id, workspaceId), eq(setup_emails.kind, kind)))
  return { kind, ...result }
}

/** Every workspace that signed up in the last days and is not disabled: what is due goes out. Run by a job. */
export async function sendDueSetupEmails(tx: Tx, sender: EmailSender, now = new Date().toISOString()) {
  if (!(await setupEmailsOn(tx))) return { off: true, sent: 0, failed: 0 }
  // Email not connected (only the log, or nowhere): nothing is sent or marked; they go out once it is.
  if (sender.kind !== 'smtp') return { off: false, notConnected: true, sent: 0, failed: 0 }
  const since = new Date(Date.parse(now) - LOOK_BACK_HOURS * 3_600_000).toISOString()
  const recent = await tx
    .select({ id: setup_events.workspace_id })
    .from(setup_events)
    .innerJoin(organization, eq(organization.id, setup_events.workspace_id))
    .where(and(eq(setup_events.event, 'signup'), gt(setup_events.at, since), isNull(organization.disabledAt)))
  let sent = 0
  let failed = 0
  for (const { id } of recent) {
    try {
      const result = await sendSetupEmailFor(tx, sender, id, now)
      sent += result?.sent ?? 0
      failed += result?.failed ?? 0
    } catch (e) {
      console.error(`setup emails for ${id} failed (${errorKind(e)})`)
    }
  }
  return { off: false, sent, failed }
}

/**
 * A real caller's call (isRealCall: incoming over the phone, not the business's own phones, not spam) in the calls
 * themselves: for workspaces that had calls before the milestones were recorded, which have no first_real_call.
 */
const realCallIn = (workspaceId: unknown) => sql`exists (select 1 from calls c where c.workspace_id = ${workspaceId}
  and c.source = 'phone' and c.direction = 'in' and c.from_own_number = false and c.outcome is distinct from 'spam')`

async function hasRealCall(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ real: boolean }>(sql`select ${realCallIn(workspaceId)} as real`)
  return rows[0]?.real === true
}

/** Whether a real caller (not the business's own phones) reached one of its numbers that is in a forwarding mode. */
async function forwardedCallArrived(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ yes: boolean }>(sql`select exists (
    select 1 from calls c join phone_numbers p on p.e164 = c.to_number and p.workspace_id = c.workspace_id
    where c.workspace_id = ${workspaceId} and c.source = 'phone' and not c.from_own_number
      and p.mode in ('forward_conditional', 'forward_all')) as yes`)
  return rows[0]?.yes === true
}

/** Undoes claimFirstCallEmail when no email could go out at all, so the job's next try sends it. */
export async function releaseFirstCallEmail(tx: Tx, workspaceId: string) {
  await tx
    .delete(setup_emails)
    .where(and(eq(setup_emails.workspace_id, workspaceId), eq(setup_emails.kind, 'first_call')))
}

/**
 * Whether this finished call is the workspace's first real call and its email is the first-call one: marked sent
 * here, so it goes out once. Only for workspaces that signed up since setup milestones exist, and only on installs
 * that send setup emails.
 */
export async function claimFirstCallEmail(
  tx: Tx,
  call: Pick<Call, 'workspace_id' | 'source' | 'from_own_number' | 'started_at'>,
  now: string,
): Promise<boolean> {
  if (call.source !== 'phone' || call.from_own_number) return false
  if (!(await setupEmailsOn(tx))) return false
  const milestones = await milestonesOf(tx, call.workspace_id)
  const first = milestones.get('first_real_call')
  if (!milestones.has('signup') || !first || Date.parse(first) !== Date.parse(call.started_at)) return false
  const claimed = await tx
    .insert(setup_emails)
    .values({ workspace_id: call.workspace_id, kind: 'first_call', sent_at: now })
    .onConflictDoNothing()
    .returning()
  return claimed.length > 0
}

// ---------------------------------------------------------------- at risk (admin)

/** How far back the at-risk list looks: a workspace silent for longer is gone, not at risk. */
export const AT_RISK_MAX_DAYS = 90

export type AtRiskWorkspace = {
  id: string
  name: string
  signed_up_at: string
  onboarding_step: string | null
  owner_email: string | null
  /** Each milestone reached, with when (setup_events). */
  milestones: Record<string, string>
  /** Setup emails sent, with when. */
  emails: Record<string, string>
}

const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)

/**
 * Workspaces that signed up more than `days` days ago (and within AT_RISK_MAX_DAYS) and that no real call has
 * reached yet: where each stopped, and whom to write to. Disabled workspaces are left out. Sign-up is the milestone,
 * or the workspace's creation for one older than the milestones.
 */
export async function atRiskWorkspaces(
  tx: Tx,
  days: number,
  now = new Date().toISOString(),
): Promise<AtRiskWorkspace[]> {
  const { rows } = await tx.execute<AtRiskWorkspace>(sql`
    with ws as (
      select o.id, o.name, coalesce(su.at, o.created_at at time zone 'utc') as signed_up_at
      from organization o
      left join setup_events su on su.workspace_id = o.id and su.event = 'signup'
      where o.disabled_at is null
    )
    select ws.id, ws.name, to_char(ws.signed_up_at at time zone 'utc', ${ISO}) as signed_up_at,
      (select s.onboarding_step from workspace_settings s where s.workspace_id = ws.id) as onboarding_step,
      (select u.email from member m join "user" u on u.id = m.user_id
        where m.organization_id = ws.id and m.role = 'owner' and u.disabled_at is null
        order by m.created_at limit 1) as owner_email,
      coalesce((select json_object_agg(e.event, to_char(e.at at time zone 'utc', ${ISO}))
        from setup_events e where e.workspace_id = ws.id), '{}'::json) as milestones,
      coalesce((select json_object_agg(se.kind, to_char(se.sent_at at time zone 'utc', ${ISO}))
        from setup_emails se where se.workspace_id = ws.id), '{}'::json) as emails
    from ws
    where ws.signed_up_at <= ${now}::timestamptz - make_interval(days => ${days})
      and ws.signed_up_at > ${now}::timestamptz - make_interval(days => ${AT_RISK_MAX_DAYS})
      and not exists (select 1 from setup_events e where e.workspace_id = ws.id
        and e.event in (${sql.join(
          liveMilestones.map(m => sql`${m}`),
          sql`, `,
        )}))
      and not ${realCallIn(sql.raw('ws.id'))}
    order by ws.signed_up_at desc, ws.id`)
  return rows
}

/**
 * How many workspaces are old enough for the at-risk list to judge: signed up more than `days` days ago and within
 * AT_RISK_MAX_DAYS, real call or not (same window as atRiskWorkspaces). Zero on a new install, where an empty list
 * means nothing yet, not that every workspace had a real call.
 */
export async function workspacesOldEnough(tx: Tx, days: number, now = new Date().toISOString()): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from organization o
    left join setup_events su on su.workspace_id = o.id and su.event = 'signup'
    where o.disabled_at is null
      and coalesce(su.at, o.created_at at time zone 'utc') <= ${now}::timestamptz - make_interval(days => ${days})
      and coalesce(su.at, o.created_at at time zone 'utc') > ${now}::timestamptz - make_interval(days => ${AT_RISK_MAX_DAYS})`)
  return rows[0]?.n ?? 0
}
