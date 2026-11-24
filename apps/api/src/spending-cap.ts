// A workspace's monthly spending cap: off unless an instance admin sets one (Server admin › Workspaces). The measure is
// the estimated cost of its calls this UTC month, with the same rates as Server admin › Overview (costEstimate). Once
// it is reached, new phone calls are not answered by the assistant: the agent says one fixed line (the business will
// call back) and the call is filed as missed with "Call back" (handlers.ts openCall); test calls are refused.
// Owners (of a white-label client: its partner's owner) and instance admins get an email at 80 % and at 100 %, once
// each per month, each in the version for them (decision of 2026-11-24): an owner reads what happens to calls and whom
// to ask, an admin the facts and the button to raise the cap. Someone who is both gets the admin's version only.
import { calls, member, organization, partner_members, spending_cap_alerts, type Tx, user } from '@linedesk/db'
import { and, eq, gte, isNull, notInArray, sql } from 'drizzle-orm'
import { costEstimate } from './admin-overview.ts'
import { WEB_ORIGIN } from './auth.ts'
import { readLegalLinks } from './auth-methods.ts'
import { billingState } from './billing-settings.ts'
import { timeZoneOf } from './bookings.ts'
import type { Email, EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { type SpendingCapReader, spendingCapEmail } from './emails/alerts.ts'
import { type EmailLocale, emailSafeName } from './emails/templates.ts'
import { instanceAdminEmails } from './instance-admin.ts'
import { queueSpendingCapAlert } from './jobs.ts'

/** Percent of the cap at which owners and instance admins are told. */
export const SPENDING_ALERT_LEVELS = [80, 100] as const
export type SpendingAlert = { workspaceId: string; month: string; level: number }

/** The UTC month of an ISO time, '2026-11'. */
export const monthOf = (now: string) => new Date(now).toISOString().slice(0, 7)
const monthStart = (now: string) => `${monthOf(now)}-01T00:00:00.000Z`
/** When the cap starts over: the first moment of the next UTC month. */
export const capResetsAt = (now: string) => {
  const d = new Date(monthStart(now))
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString()
}

/**
 * The workspace's estimated cost this UTC month, in USD. Deleted calls count (they were paid for); sample, simulated
 * and test calls never count (the same as for billing). A call still live counts once it
 * has finished.
 */
export async function monthlySpend(tx: Tx, workspaceId: string, now: string): Promise<number> {
  const [row] = await tx
    .select({
      all: sql<number>`coalesce(sum(${calls.duration_sec}), 0)::int`,
      phone: sql<number>`coalesce(sum(${calls.duration_sec}) filter (where ${calls.source} = 'phone'), 0)::int`,
    })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        notInArray(calls.source, ['sample', 'simulated', 'test']),
        gte(calls.started_at, monthStart(now)),
      ),
    )
  return (await costEstimate(tx))({ all: row?.all ?? 0, phone: row?.phone ?? 0 })
}

export type SpendingCap = { capUsd: number; spentUsd: number; reached: boolean }

/** The workspace's cap and this month's spend against it; null when it has no cap. */
export async function spendingCap(tx: Tx, workspaceId: string, now: string): Promise<SpendingCap | null> {
  const [workspace] = await tx
    .select({ cents: organization.spendingCapCents })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (workspace?.cents == null) return null
  const spentUsd = await monthlySpend(tx, workspaceId, now)
  return { capUsd: workspace.cents / 100, spentUsd, reached: Math.round(spentUsd * 100) >= workspace.cents }
}

/**
 * Queues the email for the highest of the 80 % and 100 % levels the workspace has reached this month and not had yet,
 * in the caller's transaction (the rows that mark the levels as had commit with it). `cap`: when the caller has read it already.
 */
export async function queueSpendingAlerts(tx: Tx, workspaceId: string, now: string, cap?: SpendingCap | null) {
  const state = cap === undefined ? await spendingCap(tx, workspaceId, now) : cap
  if (!state) return
  const percent = state.capUsd > 0 ? (state.spentUsd / state.capUsd) * 100 : 100
  const month = monthOf(now)
  // Every level reached is marked as had, but only the highest new one is emailed: a spend that passes 80 % and the cap
  // at once (a new cap below this month's spend, one long call) gets the cap email alone, not both in the same minute.
  let highest: number | null = null
  for (const level of SPENDING_ALERT_LEVELS) {
    if (percent < level) continue
    const added = await tx
      .insert(spending_cap_alerts)
      .values({ workspace_id: workspaceId, month, level })
      .onConflictDoNothing()
      .returning()
    if (added.length) highest = level
  }
  if (highest !== null) await queueSpendingCapAlert(tx, { workspaceId, month, level: highest })
}

/**
 * The email at one level for one reader, in the recipient's language. Its site is the install's own (WEB_ORIGIN), also
 * for a partner's client (S5): the readers are the partner's owner and the instance admins, who work there.
 */
export function spendingAlertEmail(
  workspace: string | null,
  level: number,
  cap: SpendingCap,
  to: string,
  reader: SpendingCapReader,
  now: string,
  locale?: EmailLocale,
  timeZone?: string | null,
): Email {
  return {
    to,
    ...spendingCapEmail(
      { workspace, level, capUsd: cap.capUsd, spentUsd: cap.spentUsd, resetsAt: capResetsAt(now), timeZone, reader },
      WEB_ORIGIN,
      locale,
    ),
  }
}

/**
 * Where an owner is sent to have the cap raised: the install's support address (SUPPORT_EMAIL) when the install bills
 * its workspaces, as Linedesk Cloud does (its owners are customers and have no server admin of their own); else their
 * server admin. `billing`: buying minutes exists on this install.
 */
async function ownerHelp(tx: Tx): Promise<{ support: string | null; billing: boolean }> {
  const billing = (await billingState(tx)).inEffect === 'stripe'
  const support = billing ? readLegalLinks(process.env).supportEmail : null
  return { support, billing }
}

/** Who gets which version: every address once, an instance admin always the admin's (it has the button). */
export function spendingCapRecipients(owners: string[], admins: string[]) {
  const adminSet = new Set(admins.map(a => a.toLowerCase()))
  const ownerSet = new Set(owners.map(o => o.toLowerCase()).filter(o => !adminSet.has(o)))
  return { owners: [...ownerSet], admins: [...adminSet] }
}

/** Sends one alert to the workspace's owners and the instance admins, each address once, in its version. Run by a job. */
export async function sendSpendingAlert(
  tx: Tx,
  sender: EmailSender,
  { workspaceId, month, level }: SpendingAlert,
  now = new Date().toISOString(),
) {
  const [workspace] = await tx
    .select({ name: organization.name, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  const cap = workspace ? await spendingCap(tx, workspaceId, now) : null
  // The workspace is gone, its cap was removed, or the month is over since: nothing to say any more.
  if (!workspace || !cap || monthOf(now) !== month) return { sent: 0, failed: 0 }
  // A white-label client's people see minutes, never dollar amounts (docs/white-label.md; review of #1109, L-2): its
  // partner's owner, who pays for it, gets the email instead of the client's owner.
  const owners = workspace.partnerId
    ? await tx
        .select({ email: user.email })
        .from(partner_members)
        .innerJoin(user, eq(user.id, partner_members.user_id))
        .where(
          and(
            eq(partner_members.partner_id, workspace.partnerId),
            eq(partner_members.role, 'owner'),
            isNull(user.disabledAt),
          ),
        )
    : await tx
        .select({ email: user.email })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, workspaceId), eq(member.role, 'owner'), isNull(user.disabledAt)))
  const recipients = spendingCapRecipients(
    owners.map(o => o.email),
    await instanceAdminEmails(),
  )
  const help = await ownerHelp(tx)
  const readers: [string, SpendingCapReader][] = [
    ...recipients.owners.map((to): [string, SpendingCapReader] => [
      to,
      { kind: 'owner', partner: !!workspace.partnerId, ...help },
    ]),
    ...recipients.admins.map((to): [string, SpendingCapReader] => [
      to,
      { kind: 'admin', workspaceId, support: help.support },
    ]),
  ]
  const name = emailSafeName(workspace.name, '') || null
  const timeZone = await timeZoneOf(tx, workspaceId)
  let sent = 0
  let failed = 0
  for (const [to, reader] of readers) {
    try {
      const locale = await localeForEmail(tx, to)
      await sender.send(spendingAlertEmail(name, level, cap, to, reader, now, locale, timeZone))
      sent++
    } catch (e) {
      failed++
      console.warn(`spending cap email for ${workspaceId} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { sent, failed }
}
