// A white-label client's monthly usage limit (docs/white-label.md, slice S3; LIN-454): set by its partner's team
// (partner.setClientUsageLimit), measured on the partner bill's ledger for the bill's current period: what the client
// used from the bill (its calls, its extra numbers, and adjustments of those), never an estimate. The shape of the
// install's spending cap (spending-cap.ts): at 80 % and 100 % the partner team gets an email, once each per period;
// at the limit new phone calls are refused with the usual refused-call line and filed as missed (`usage_limit`,
// handlers.ts openCall). A running call is never cut: the limit is checked when a call starts, nowhere else.
import { ledger_entries, organization, partner_members, type Tx, usage_limit_alerts, user } from '@linedesk/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { WEB_ORIGIN } from './auth.ts'
import type { EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { usageLimitEmail } from './emails/alerts.ts'
import { emailSafeName } from './emails/templates.ts'
import { queueUsageLimitAlert } from './jobs.ts'
import { periodAt } from './ledger.ts'

/** Percent of the limit at which the partner team is told. */
export const USAGE_LIMIT_ALERT_LEVELS = [80, 100] as const
export type UsageLimitAlert = { workspaceId: string; periodId: string; level: number }

/** The ledger kinds a client's own use of the bill is made of: its calls, its extra numbers, corrections of those. */
const CLIENT_KINDS = ['usage', 'number', 'adjustment'] as const

/** A ledger amount (bigint as text) as a safe number of micros. */
const micros = (value: unknown) => {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n)) throw new Error(`ledger amount out of range: ${String(value)}`)
  return n
}

/**
 * What each workspace used from the bill in the period, from the ledger: the seconds of its billed calls and the cost
 * in micros (usage, numbers and adjustments posted for the workspace, as positive amounts). Workspaces with nothing
 * posted are absent.
 */
export async function clientPeriodUsage(
  tx: Pick<Tx, 'select'>,
  billId: string,
  periodId: string,
  workspaceIds: string[],
): Promise<Map<string, { seconds: number; costMicros: number }>> {
  const usage = new Map<string, { seconds: number; costMicros: number }>()
  if (!workspaceIds.length) return usage
  const rows = await tx
    .select({
      workspaceId: ledger_entries.workspace_id,
      seconds: sql<number>`coalesce(sum(${ledger_entries.seconds}) filter (where ${ledger_entries.kind} = 'usage'), 0)::int`,
      cost: sql<string>`coalesce(-sum(${ledger_entries.amount_micros}), 0)`,
    })
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.billing_account_id, billId),
        eq(ledger_entries.period_id, periodId),
        inArray(ledger_entries.kind, [...CLIENT_KINDS]),
        inArray(ledger_entries.workspace_id, workspaceIds),
      ),
    )
    .groupBy(ledger_entries.workspace_id)
  for (const r of rows) if (r.workspaceId) usage.set(r.workspaceId, { seconds: r.seconds, costMicros: micros(r.cost) })
  return usage
}

export type UsageLimit = { limitCents: number; usedMicros: number; periodId: string; reached: boolean }

/**
 * The workspace's usage limit and what it used against it in its bill's current period; null without a limit, off a
 * bill, or when the bill has no period now (nothing to measure against: the billing gate refuses such a call anyway).
 */
export async function usageLimit(tx: Tx, workspaceId: string, now: string): Promise<UsageLimit | null> {
  const [workspace] = await tx
    .select({ cents: organization.usageLimitCents, bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (workspace?.cents == null || !workspace.bill) return null
  const period = await periodAt(tx, workspace.bill, now)
  if (!period) return null
  const usedMicros =
    (await clientPeriodUsage(tx, workspace.bill, period.id, [workspaceId])).get(workspaceId)?.costMicros ?? 0
  return {
    limitCents: workspace.cents,
    usedMicros,
    periodId: period.id,
    reached: usedMicros >= workspace.cents * 10_000,
  }
}

/** The share of the limit used, in percent (100: reached). */
export const limitPercent = (state: Pick<UsageLimit, 'limitCents' | 'usedMicros'>) =>
  state.limitCents > 0 ? (state.usedMicros / (state.limitCents * 10_000)) * 100 : 100

/**
 * Queues the 80 % and 100 % emails the workspace has reached this period and not had yet, in the caller's transaction
 * (the row that marks one as sent commits with it). `state`: when the caller has read it already.
 */
export async function queueUsageLimitAlerts(tx: Tx, workspaceId: string, now: string, state?: UsageLimit | null) {
  const limit = state === undefined ? await usageLimit(tx, workspaceId, now) : state
  if (!limit) return
  const percent = limitPercent(limit)
  for (const level of USAGE_LIMIT_ALERT_LEVELS) {
    if (percent < level) continue
    const added = await tx
      .insert(usage_limit_alerts)
      .values({ workspace_id: workspaceId, period_id: limit.periodId, level })
      .onConflictDoNothing()
      .returning()
    if (added.length) await queueUsageLimitAlert(tx, { workspaceId, periodId: limit.periodId, level })
  }
}

/** Forgets this period's emails of the workspace (a new limit starts them over). */
export async function resetUsageLimitAlerts(tx: Tx, workspaceId: string) {
  await tx.delete(usage_limit_alerts).where(eq(usage_limit_alerts.workspace_id, workspaceId))
}

/**
 * Sends one alert to the team of the workspace's partner (owner and admins), each address once, in their language.
 * Run by a job: the workspace may have left its partner, lost its limit or moved on to another period since, and then
 * there is nothing to say any more.
 */
export async function sendUsageLimitAlert(
  tx: Tx,
  sender: EmailSender,
  { workspaceId, periodId, level }: UsageLimitAlert,
  now = new Date().toISOString(),
) {
  const [workspace] = await tx
    .select({ name: organization.name, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  const limit = workspace?.partnerId ? await usageLimit(tx, workspaceId, now) : null
  if (!workspace?.partnerId || !limit || limit.periodId !== periodId) return { sent: 0, failed: 0 }
  const team = await tx
    .select({ email: user.email })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(and(eq(partner_members.partner_id, workspace.partnerId), isNull(user.disabledAt)))
  const addresses = [...new Set(team.map(m => m.email.toLowerCase()))]
  let sent = 0
  let failed = 0
  for (const to of addresses) {
    try {
      const locale = await localeForEmail(tx, to)
      const content = {
        workspace: emailSafeName(workspace.name, '') || null,
        level,
        limitUsd: limit.limitCents / 100,
        usedUsd: Math.round(limit.usedMicros / 10_000) / 100,
      }
      await sender.send({ to, ...usageLimitEmail(content, WEB_ORIGIN, locale) })
      sent++
    } catch (e) {
      failed++
      console.warn(`usage limit email for ${workspaceId} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { sent, failed }
}
