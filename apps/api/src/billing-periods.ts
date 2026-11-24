// The bill's periods and what comes with each (extra numbers), in one
// hourly job (`billing.periods`):
//
// - Period close: the next period of every bill in service is opened before its start (so a call always finds the
//   period it starts in), with the workspaces' counter rows; a period is closed 3 hours after its end, once the stale
//   sweep has posted the long calls that started in it. Yearly bills get monthly sub-periods from the anchor day.
// - Extra numbers: each number beyond the one a workspace includes pays its month from the balance (a `number` entry,
//   source `<number id>:<period id>`, so each month posts once). Only when the available balance covers it: else the
//   recharge decision runs first and the month posts once that recharge is paid; with no recharge possible the number
//   is unpaid (inbound calls get the fixed line, the owner is emailed) until a later run can post it, and is released
//   after 30 days unpaid. So number months never take the balance below the buffer, and no number runs for free.
// - The yearly renewal reminder (California's automatic renewal law): once per renewal, 15 to 45 days before it.
// - The trial reminders: on each of the install's reminder days before a trial ends (billing-checkout.ts).
//
// Runs only while billing is in effect. Every write is under the bill's lock order (ledger.ts); every email is a job
// queued in the transaction that made its `billing_alerts` row, so it goes once and only after the commit.
import type { BillingProvider } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_numbers,
  billing_periods,
  billing_recharges,
  instance_settings,
  ledger_entries,
  member,
  organization,
  phone_numbers,
  type Tx,
  usage_counters,
  user,
  workspace_settings,
  EXTRA_CALLS_LOOKUP_PREFIX,
} from '@linedesk/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { billingRules } from './billing-rules.ts'
import { billingProvider, billingState } from './billing-settings.ts'
import { DEFAULT_TIME_ZONE, timeZoneOf } from './bookings.ts'
import { afterDebit } from './call-billing.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import type { EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { billingPeriodsFailedAlert } from './emails/billing-alerts.ts'
import {
  billingLifecycleEmail,
  type LifecycleEmail,
  type ManagerChangedEmail,
  managerChangedEmail,
  type ManagerChangedView,
  type RenewalLine,
} from './emails/billing-lifecycle.ts'
import { emailSafeName } from './emails/templates.ts'
import { jobQueue } from './jobs.ts'
import { decideRecharge, feeNumbers, lockBalance, periodAt, postEntry } from './ledger.ts'
import { requireLedgerGuards } from './ledger-guards.ts'

/** Hourly: periods, extra numbers, renewal reminders. */
export const BILLING_PERIODS = 'billing.periods'
const BILLING_PERIODS_CRON = '13 * * * *'
/** One owner email about the bill's life (emails/billing-lifecycle.ts). */
export const BILLING_LIFECYCLE_EMAIL = 'billing.lifecycleEmail'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The next period is opened this long before the current one ends, so the hourly run is never late for it. */
export const OPEN_AHEAD_MS = 2 * HOUR_MS
/** A period is closed this long after its end: the stale sweep has posted its long calls. */
export const CLOSE_AFTER_MS = 3 * HOUR_MS
/** An extra number unpaid this long is released. */
export const UNPAID_RELEASE_DAYS = 30
/** The instance setting with the days before a yearly renewal that the reminder goes out (15 to 45, default 30). */
export const RENEWAL_REMINDER_DAYS_KEY = 'billing.renewalReminderDays'
export const RENEWAL_REMINDER_DAYS = { min: 15, max: 45, default: 30 } as const
/** At most this many periods are opened for one bill in one run (a job that was down for long catches up). */
const MAX_OPENED_PER_RUN = 24

/** Bills in service: they get their next period. A canceled or unpaid sign-up gets none. */
const IN_SERVICE = ['trialing', 'active', 'past_due', 'suspended', 'comped'] as const
/** Bills whose extra numbers pay a month: never in the trial (no extra numbers then) or while suspended or comped. */
const PAYS_NUMBERS = ['active', 'past_due'] as const

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const iso = (ms: number) => new Date(ms).toISOString()

// ---- Periods ----

/** `anchor` moved `months` calendar months (UTC), its day clamped to the month's length, its time kept. */
export function addMonths(anchor: string, months: number): string {
  const a = new Date(anchor)
  const first = Date.UTC(
    a.getUTCFullYear(),
    a.getUTCMonth() + months,
    1,
    a.getUTCHours(),
    a.getUTCMinutes(),
    a.getUTCSeconds(),
    a.getUTCMilliseconds(),
  )
  const target = new Date(first)
  const days = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(a.getUTCDate(), days))
  return target.toISOString()
}

/** A month period is never shorter than this (the shortest real month from an anchor on the 29th to 31st is 28 days). */
export const MIN_MONTH_MS = 27 * DAY_MS

/**
 * Where a period that starts at `start` ends: the first month boundary from the bill's anchor after it, or the
 * subscription's period end when that comes first (a yearly bill's last sub-period ends with its year). Every boundary
 * is counted from the anchor itself (`addMonths(anchor, k)`), never from the last boundary, so an anchor on the 31st
 * gives Jan 31 → Feb 28 → Mar 31, as Stripe does. `minMs`: a boundary closer than this to `start` is skipped for the
 * one after it (no stub period after the anchor moved, security review of #879, M1), and the subscription's end cuts
 * the period only when it is at least that far from `start` too (a plan change that moved Stripe's period end to a
 * day after the last month never makes a one-day month, re-review of #879, N4).
 */
export function nextPeriodEnd(anchor: string, start: string, subscriptionEnd: string | null, minMs = 0): string {
  const a = new Date(anchor)
  const s = new Date(start)
  let k = (s.getUTCFullYear() - a.getUTCFullYear()) * 12 + (s.getUTCMonth() - a.getUTCMonth()) - 1
  while (Date.parse(addMonths(anchor, k)) <= s.getTime()) k++
  let end = addMonths(anchor, k)
  if (Date.parse(end) - s.getTime() < minMs) end = addMonths(anchor, k + 1)
  if (
    subscriptionEnd &&
    Date.parse(subscriptionEnd) - s.getTime() >= Math.max(minMs, 1) &&
    Date.parse(subscriptionEnd) < Date.parse(end)
  )
    return subscriptionEnd
  return end
}

/**
 * The point the bill's months are counted from: the subscription's billing cycle anchor, else (no subscription yet,
 * a comped bill) the start of the bill's first month, else the end of the trial the latest period is (Stripe anchors a
 * subscription on its trial end; invoice.paid, which stores the anchor, comes only after the first month opens:
 * re-review of #879, N4). Never `current_period_start`: Stripe clamps it in short months, so months counted from it
 * drift (Mar 31 → Apr 28 → a 2-day stub to Apr 30; security review of #879, M1).
 */
async function billAnchor(
  tx: Tx,
  bill: { id: string; billing_anchor: string | null },
  latest: { kind: string; starts_at: string; ends_at: string },
) {
  if (bill.billing_anchor) return bill.billing_anchor
  const [first] = await tx
    .select({ starts_at: billing_periods.starts_at })
    .from(billing_periods)
    .where(and(eq(billing_periods.billing_account_id, bill.id), eq(billing_periods.kind, 'month')))
    .orderBy(asc(billing_periods.starts_at))
    .limit(1)
  if (first) return first.starts_at
  return latest.kind === 'trial' ? latest.ends_at : latest.starts_at
}

/**
 * Opens the bill's next periods until one reaches past `now` + OPEN_AHEAD_MS, each with the counter rows of the bill's
 * workspaces. A bill with no period yet (Checkout makes the first) gets none. Idempotent: a period starting where the
 * last one ends exists once (`billing_periods_start`), and periods never overlap (exclusion constraint). A month that
 * follows a month is never shorter than MIN_MONTH_MS (only the subscription's end cuts one short).
 */
export async function openNextPeriods(tx: Tx, billId: string, now: string): Promise<string[]> {
  await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  if (!bill || !(IN_SERVICE as readonly string[]).includes(bill.status)) return []
  const opened: string[] = []
  for (let i = 0; i < MAX_OPENED_PER_RUN; i++) {
    const [latest] = await tx
      .select()
      .from(billing_periods)
      .where(eq(billing_periods.billing_account_id, billId))
      .orderBy(desc(billing_periods.starts_at))
      .limit(1)
    if (!latest || Date.parse(latest.ends_at) > Date.parse(now) + OPEN_AHEAD_MS) break
    const anchor = await billAnchor(tx, bill, latest)
    const minMs = latest.kind === 'month' ? MIN_MONTH_MS : 0
    const [period] = await tx
      .insert(billing_periods)
      .values({
        id: newId('bp'),
        billing_account_id: billId,
        starts_at: latest.ends_at,
        ends_at: nextPeriodEnd(anchor, latest.ends_at, bill.current_period_end, minMs),
        kind: 'month',
      })
      .onConflictDoNothing()
      .returning()
    if (!period) break
    opened.push(period.id)
    const workspaces = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.billingAccountId, billId))
    if (workspaces.length)
      await tx
        .insert(usage_counters)
        .values(workspaces.map(w => ({ billing_account_id: billId, period_id: period.id, workspace_id: w.id })))
        .onConflictDoNothing()
  }
  return opened
}

/** Closes the periods that ended more than CLOSE_AFTER_MS ago. Returns how many. */
export async function closeEndedPeriods(tx: Tx, now: string): Promise<number> {
  const closed = await tx
    .update(billing_periods)
    .set({ closed_at: now })
    .where(and(isNull(billing_periods.closed_at), lte(billing_periods.ends_at, iso(Date.parse(now) - CLOSE_AFTER_MS))))
    .returning({ id: billing_periods.id })
  return closed.length
}

// ---- Extra numbers ----

export type ExtraNumber = { id: string; e164: string; workspaceId: string }

/**
 * The bill's extra numbers: on Linedesk's carrier account, bought through Linedesk, beyond the first of each workspace
 * (its oldest is the one the workspace includes; `feeNumbers`). The same count as `extraNumbersOnBill` (ledger.ts).
 */
export async function extraNumbersOf(tx: Tx, billId: string): Promise<ExtraNumber[]> {
  const rows = await tx
    .select({ id: phone_numbers.id, e164: phone_numbers.e164, workspaceId: phone_numbers.workspace_id })
    .from(phone_numbers)
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(and(eq(organization.billingAccountId, billId), feeNumbers()))
    .orderBy(asc(phone_numbers.workspace_id), asc(phone_numbers.created_at), asc(phone_numbers.id))
  const seen = new Set<string>()
  return rows.filter(r => {
    if (seen.has(r.workspaceId)) return true
    seen.add(r.workspaceId)
    return false
  })
}

const numberSource = (numberId: string, periodId: string) => `${numberId}:${periodId}`

export type NumberMonth =
  /** The month's entry is posted (now, or before). */
  | { kind: 'posted' }
  /** The balance does not cover it yet; a recharge is pending, and a later run posts it once that is paid. */
  | { kind: 'waiting' }
  /** No recharge can pay it: the number is unpaid (fixed line), the owner was emailed once for this month. */
  | { kind: 'unpaid' }

/**
 * Pays one month of one extra number from the balance, under the bill's balance lock: posted
 * only when the available balance (balance − what running calls hold) covers the price, so a number month never takes
 * the balance below zero, let alone the buffer. Otherwise the recharge decision runs; with a recharge pending the month
 * waits for it, and with none possible (the cap, a failed recharge, auto-recharge off) the number becomes unpaid.
 */
export async function chargeNumberMonth(
  tx: Tx,
  billId: string,
  number: ExtraNumber,
  periodId: string,
  now: string,
): Promise<NumberMonth> {
  await requireLedgerGuards(tx)
  const balance = await lockBalance(tx, billId)
  const [existing] = await tx
    .select({ id: ledger_entries.id })
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.source_type, 'phone_number'),
        eq(ledger_entries.source_id, numberSource(number.id, periodId)),
        eq(ledger_entries.kind, 'number'),
      ),
    )
  if (existing) return { kind: 'posted' }
  const priceMicros = (await billingRules(tx)).extraNumberCents * 10_000
  if (balance.balance_micros - balance.reserved_micros >= priceMicros) {
    await postEntry(tx, {
      billing_account_id: billId,
      workspace_id: number.workspaceId,
      period_id: periodId,
      kind: 'number',
      amount_micros: -priceMicros,
      source_type: 'phone_number',
      source_id: numberSource(number.id, periodId),
    })
    await afterDebit(tx, billId, await decideRecharge(tx, billId, now), now)
    return { kind: 'posted' }
  }
  const recharge = await decideRecharge(tx, billId, now)
  await afterDebit(tx, billId, recharge, now)
  const [pending] = await tx
    .select({ id: billing_recharges.id })
    .from(billing_recharges)
    .where(and(eq(billing_recharges.billing_account_id, billId), eq(billing_recharges.status, 'pending')))
  if (pending) return { kind: 'waiting' }
  await tx
    .insert(billing_numbers)
    .values({ phone_number_id: number.id, billing_account_id: billId, unpaid_since: now, unpaid_period_id: periodId })
    .onConflictDoUpdate({
      target: billing_numbers.phone_number_id,
      // The first unpaid month stays the one owed (and the 30 days count from it).
      set: {
        // The row follows the number's workspace to the bill that pays it now (security review of #879, L3).
        billing_account_id: sql`excluded.billing_account_id`,
        unpaid_since: sql`coalesce(${billing_numbers.unpaid_since}, excluded.unpaid_since)`,
        unpaid_period_id: sql`coalesce(${billing_numbers.unpaid_period_id}, excluded.unpaid_period_id)`,
        updated_at: now,
      },
    })
  const [row] = await tx.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, number.id))
  const added = await tx
    .insert(billing_alerts)
    .values({ billing_account_id: billId, kind: 'number_unpaid', ref: numberSource(number.id, periodId) })
    .onConflictDoNothing()
    .returning()
  if (added.length)
    await queueLifecycleEmail(tx, billId, {
      kind: 'number_unpaid',
      e164: number.e164,
      priceCents: priceMicros / 10_000,
      releaseAt: iso(Date.parse(row!.unpaid_since!) + UNPAID_RELEASE_DAYS * DAY_MS),
    })
  return { kind: 'unpaid' }
}

/** A number paid up again (or no longer an extra one): its unpaid state goes, so its calls are answered again. */
async function clearUnpaid(tx: Tx, numberId: string, now: string) {
  await tx
    .update(billing_numbers)
    .set({ unpaid_since: null, unpaid_period_id: null, updated_at: now })
    .where(and(eq(billing_numbers.phone_number_id, numberId), isNotNull(billing_numbers.unpaid_since)))
}

/**
 * Number rows whose workspace is now on another bill (moved between bills) follow it (security review of #879, L3):
 * the row's bill becomes the workspace's bill, so the new bill's run finds the owed month and the old bill's owner no
 * longer sees the number. The month owed to the old bill cannot be paid by the new one: it becomes the new bill's
 * current period, and the 30 days still count from when the number first went unpaid. With no current period on the
 * new bill the unpaid state goes (the new bill's run makes it again if its month cannot be paid). `workspaceId`: only
 * that workspace's numbers (the move itself); without it, every row (the hourly run).
 */
export async function followWorkspaceBills(tx: Tx, now: string, workspaceId?: string) {
  const moved = await tx
    .select({
      numberId: billing_numbers.phone_number_id,
      from: billing_numbers.billing_account_id,
      to: organization.billingAccountId,
      unpaidSince: billing_numbers.unpaid_since,
    })
    .from(billing_numbers)
    .innerJoin(phone_numbers, eq(phone_numbers.id, billing_numbers.phone_number_id))
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(
      and(
        isNotNull(organization.billingAccountId),
        sql`${organization.billingAccountId} <> ${billing_numbers.billing_account_id}`,
        workspaceId ? eq(organization.id, workspaceId) : undefined,
      ),
    )
  for (const row of moved) {
    const to = row.to!
    // Lock order (ledger.ts): the bills' balance rows, in id order, before their number rows.
    for (const bill of [row.from, to].sort()) await lockBalance(tx, bill)
    const current = row.unpaidSince ? await periodAt(tx, to, now) : null
    await tx
      .update(billing_numbers)
      .set({
        billing_account_id: to,
        unpaid_since: current ? row.unpaidSince : null,
        unpaid_period_id: current ? current.id : null,
        // The PIN was the old bill owner's: the new bill's owner gets a new one when they next look (re-review of
        // #879, N2), so the old owner's PIN cannot port the number out.
        port_out_code: null,
        updated_at: now,
      })
      .where(and(eq(billing_numbers.phone_number_id, row.numberId), eq(billing_numbers.billing_account_id, row.from)))
  }
  return moved.length
}

/**
 * A number just bought (phoneNumber.setup, in its transaction): when it is an extra number of a bill that pays numbers,
 * its current month is posted now, under the balance lock the purchase check took (billingNumberRefusal). So the
 * balance a second purchase sees no longer holds this month, and two purchases cannot both pass with one month's
 * money (LIN-506). The hourly run finds the month posted. Billing not in effect, a trial, a comped bill or the
 * workspace's included number: nothing is posted. Without the balance (only an instance admin buys past the check)
 * the number is unpaid, as in the hourly run.
 */
export async function payBoughtNumberMonth(tx: Tx, workspaceId: string, numberId: string, now: string) {
  const [org] = await tx
    .select({ billId: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!org?.billId) return null
  if ((await billingState(tx)).inEffect !== 'stripe') return null
  const [bill] = await tx
    .select({ status: billing_accounts.status })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, org.billId))
  if (!bill || !(PAYS_NUMBERS as readonly string[]).includes(bill.status)) return null
  const number = (await extraNumbersOf(tx, org.billId)).find(n => n.id === numberId)
  if (!number) return null
  const period = await periodAt(tx, org.billId, now)
  if (!period) return null
  return chargeNumberMonth(tx, org.billId, number, period.id, now)
}

/**
 * Every extra number of a bill pays its months: the month left unpaid first (owed since then), then the current one;
 * the number is unpaid until both are posted. Numbers that are no longer extra (another one was released) are cleared.
 */
export async function payNumberMonths(billId: string, now: string) {
  const outcomes: Record<string, NumberMonth['kind']> = {}
  const current = await periodAt(db, billId, now)
  if (!current) return outcomes
  await db.transaction(tx => followWorkspaceBills(tx, now))
  const extra = await extraNumbersOf(db, billId)
  const extraIds = new Set(extra.map(n => n.id))
  const states = await db.select().from(billing_numbers).where(eq(billing_numbers.billing_account_id, billId))
  for (const state of states)
    if (state.unpaid_since && !extraIds.has(state.phone_number_id))
      await db.transaction(async tx => {
        await lockBalance(tx, billId)
        await clearUnpaid(tx, state.phone_number_id, now)
      })
  for (const number of extra) {
    const owed = states.find(s => s.phone_number_id === number.id)?.unpaid_period_id
    const periods = owed && owed !== current.id ? [owed, current.id] : [current.id]
    let outcome: NumberMonth = { kind: 'posted' }
    for (const periodId of periods) {
      outcome = await db.transaction(tx => chargeNumberMonth(tx, billId, number, periodId, now))
      if (outcome.kind !== 'posted') break
    }
    if (outcome.kind === 'posted')
      await db.transaction(async tx => {
        await lockBalance(tx, billId)
        await clearUnpaid(tx, number.id, now)
      })
    outcomes[number.id] = outcome.kind
  }
  return outcomes
}

/**
 * The system actor that releases a number for billing: `settings:write` in the number's workspace only, through the
 * registry's `phoneNumber.release` (audited like any release, with `billing:system` as the actor).
 */
const releaseActor = (workspaceId: string): Actor => ({
  actorId: 'billing:system',
  role: 'admin',
  workspaceId,
  permissions: ['settings:write'],
})

/** Releases one number as the billing system (`phoneNumber.release`). Throws when the release was refused. */
export async function releaseNumberAsSystem(numberId: string) {
  const [number] = await db.select().from(phone_numbers).where(eq(phone_numbers.id, numberId))
  if (!number) return { released: false as const }
  const { runAction } = await import('./run-action.ts')
  const result = await runAction(
    'phoneNumber.release',
    { phoneNumberId: number.id, confirm: number.e164 },
    releaseActor(number.workspace_id),
  )
  if (!result.body.ok) throw new Error(`billing: number ${number.id} could not be released: ${result.body.error}`)
  return { released: true as const, e164: number.e164, workspaceId: number.workspace_id }
}

export type ReleaseCheck =
  /** Still unpaid for 30 days, still an extra number of a bill that pays numbers: released. */
  | 'release'
  /** Paid by one more try, no longer extra, or the bill is comped: the unpaid state is gone, the number stays. */
  | 'cleared'
  /** Not now (a recharge is pending, the bill is suspended for a dispute or fraud warning, or canceled): kept as is. */
  | 'kept'

/**
 * Whether an unpaid number is still to be released, checked again under the bill's lock right before the release
 * (security review of #879, M2): the row must still be unpaid since 30 days, the number still an extra one of the bill
 * its workspace is on now (not the one the workspace includes, say after the included number was released), and the
 * bill must still be one that pays numbers. A comped bill clears the state (it pays nothing); a bill suspended for a
 * dispute or a fraud warning keeps it (no number is taken while that is open); an active or past-due bill gets one more
 * try at the month first.
 */
export async function checkRelease(tx: Tx, numberId: string, now: string): Promise<ReleaseCheck> {
  const [number] = await tx
    .select({ id: phone_numbers.id, e164: phone_numbers.e164, workspaceId: phone_numbers.workspace_id })
    .from(phone_numbers)
    .where(eq(phone_numbers.id, numberId))
  if (!number) return 'kept'
  const [workspace] = await tx
    .select({ billId: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, number.workspaceId))
  const billId = workspace?.billId
  if (!billId) {
    await clearUnpaid(tx, numberId, now)
    return 'cleared'
  }
  await followWorkspaceBills(tx, now, number.workspaceId)
  await lockBalance(tx, billId)
  const [state] = await tx.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, numberId))
  const due = iso(Date.parse(now) - UNPAID_RELEASE_DAYS * DAY_MS)
  if (!state?.unpaid_since || !state.unpaid_period_id || Date.parse(state.unpaid_since) > Date.parse(due)) return 'kept'
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  if (!bill) return 'kept'
  if (!(await extraNumbersOf(tx, billId)).some(n => n.id === numberId) || bill.status === 'comped') {
    await clearUnpaid(tx, numberId, now)
    return 'cleared'
  }
  if (bill.status === 'suspended')
    // Only dunning releases: a dispute may be won or a warning close, and an instance admin's suspension is theirs to
    // settle (#919's `suspend_reason`).
    return bill.suspend_reason === 'payment' ? 'release' : 'kept'
  if (!(PAYS_NUMBERS as readonly string[]).includes(bill.status)) return 'kept'
  const current = await periodAt(tx, billId, now)
  const periods = [state.unpaid_period_id, ...(current && current.id !== state.unpaid_period_id ? [current.id] : [])]
  let outcome: NumberMonth = { kind: 'posted' }
  for (const periodId of periods) {
    outcome = await chargeNumberMonth(tx, billId, number, periodId, now)
    if (outcome.kind !== 'posted') break
  }
  if (outcome.kind === 'posted') {
    await clearUnpaid(tx, numberId, now)
    return 'cleared'
  }
  return outcome.kind === 'waiting' ? 'kept' : 'release'
}

/**
 * Extra numbers unpaid for UNPAID_RELEASE_DAYS are released, each checked again first
 * (`checkRelease`). Each number on its own: one that fails is logged and returned in `failed` (the run emails the
 * instance admins), and the others are still released.
 */
export async function releaseUnpaidNumbers(now: string): Promise<{ released: string[]; failed: string[] }> {
  const due = await db
    .select({ id: billing_numbers.phone_number_id })
    .from(billing_numbers)
    .where(lte(billing_numbers.unpaid_since, iso(Date.parse(now) - UNPAID_RELEASE_DAYS * DAY_MS)))
  const released: string[] = []
  const failed: string[] = []
  for (const { id } of due) {
    try {
      const check = await db.transaction(tx => checkRelease(tx, id, now))
      if (check !== 'release') continue
      if ((await releaseNumberAsSystem(id)).released) released.push(id)
    } catch (error) {
      console.error(`billing periods: number ${id} could not be released:`, error)
      failed.push(`release of ${id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
  }
  return { released, failed }
}

/** Whether calls to this number get the fixed line because its month is unpaid (openCall, handlers.ts). */
export async function numberUnpaid(tx: Tx, workspaceId: string, e164: string): Promise<boolean> {
  const [row] = await tx
    .select({ since: billing_numbers.unpaid_since })
    .from(billing_numbers)
    .innerJoin(phone_numbers, eq(phone_numbers.id, billing_numbers.phone_number_id))
    .where(and(eq(phone_numbers.workspace_id, workspaceId), eq(phone_numbers.e164, e164)))
  return !!row?.since
}

// ---- The yearly renewal reminder ----

/** The days before a yearly renewal that the reminder goes out: the instance setting, within 15 to 45, else 30. */
export async function renewalReminderDays(tx: Pick<Tx, 'select'>): Promise<number> {
  const [row] = await tx
    .select({ value: instance_settings.value })
    .from(instance_settings)
    .where(eq(instance_settings.key, RENEWAL_REMINDER_DAYS_KEY))
  const days = Number(row?.value)
  const { min, max } = RENEWAL_REMINDER_DAYS
  if (row && Number.isInteger(days) && days >= min && days <= max) return days
  if (row) console.error(`billing: ${RENEWAL_REMINDER_DAYS_KEY} must be a whole number from ${min} to ${max}; using 30`)
  return RENEWAL_REMINDER_DAYS.default
}

/** What the renewal charges, from the subscription's items: the seats, the partner base and the extra calls, at their own prices. */
function renewalLines(items: { lookupKey: string | null; quantity: number; unitAmountCents?: number | null }[]) {
  return items
    .filter(i => i.unitAmountCents != null && i.quantity > 0)
    .map(
      (i): RenewalLine => ({
        item: i.lookupKey?.startsWith('partner_')
          ? 'partner'
          : i.lookupKey?.startsWith(EXTRA_CALLS_LOOKUP_PREFIX)
            ? 'extraCalls'
            : 'seats',
        quantity: i.quantity,
        unitCents: i.unitAmountCents!,
      }),
    )
}

/**
 * The yearly renewal reminder: yearly bills whose renewal is within the reminder days, asked
 * of Stripe first (fetch-before-act: not set to cancel, still running, and its period end is the renewal). Once per
 * renewal: the `billing_alerts` row (ref = the period end that renews) is made in the transaction that queues the
 * email, so a second run sends nothing.
 */
export async function sendRenewalReminders(provider: BillingProvider, now: string): Promise<string[]> {
  const days = await renewalReminderDays(db)
  const until = iso(Date.parse(now) + days * DAY_MS)
  const bills = await db
    .select()
    .from(billing_accounts)
    .where(
      and(
        eq(billing_accounts.interval, 'year'),
        inArray(billing_accounts.status, ['active', 'past_due']),
        isNotNull(billing_accounts.stripe_subscription_id),
        sql`${billing_accounts.current_period_end} > ${now}::timestamptz`,
        lte(billing_accounts.current_period_end, until),
      ),
    )
  const reminded: string[] = []
  for (const bill of bills) {
    const [already] = await db
      .select({ ref: billing_alerts.ref })
      .from(billing_alerts)
      .where(
        and(
          eq(billing_alerts.billing_account_id, bill.id),
          eq(billing_alerts.kind, 'renewal_reminder'),
          eq(billing_alerts.ref, bill.current_period_end!),
        ),
      )
    if (already) continue
    const sub = await provider.subscription(bill.stripe_subscription_id!)
    if (!sub || sub.cancelAtPeriodEnd || !['active', 'past_due'].includes(sub.status)) continue
    if (sub.customerId !== bill.stripe_customer_id || sub.interval !== 'year' || !sub.currentPeriodEnd) continue
    if (Date.parse(sub.currentPeriodEnd) !== Date.parse(bill.current_period_end!)) continue
    const lines = renewalLines(sub.items)
    if (!lines.length) continue
    const sent = await db.transaction(async tx => {
      const added = await tx
        .insert(billing_alerts)
        .values({ billing_account_id: bill.id, kind: 'renewal_reminder', ref: bill.current_period_end! })
        .onConflictDoNothing()
        .returning()
      if (!added.length) return false
      await queueLifecycleEmail(tx, bill.id, {
        kind: 'renewal_reminder',
        renewsAt: sub.currentPeriodEnd!,
        lines,
        autoRecharge: bill.auto_recharge
          ? { thresholdCents: bill.recharge_threshold_cents, amountCents: bill.recharge_amount_cents }
          : null,
      })
      return true
    })
    if (sent) reminded.push(bill.id)
  }
  return reminded
}

// ---- The owner's emails ----

/**
 * `workspace`: the email is about this workspace (a port-out of its number): it links there, and its owner gets it
 * too when that is someone else than the bill owner.
 */
export type LifecycleEmailJob = { bill: string; email: LifecycleEmail | ManagerChangedEmail; workspace?: string }

/** Queues one owner email in the caller's transaction: it goes only if that commits. Without a queue (tests) nothing. */
export async function queueLifecycleEmail(
  tx: Tx,
  bill: string,
  email: LifecycleEmail | ManagerChangedEmail,
  workspace?: string,
) {
  const job: LifecycleEmailJob = workspace ? { bill, email, workspace } : { bill, email }
  await jobQueue()?.send(BILLING_LIFECYCLE_EMAIL, job, {
    db: fromDrizzle(tx, sql),
  })
}

/**
 * Sends one owner email (the job): to the bill owner's address, in their language, linking Settings › Billing of the
 * bill's oldest workspace. An owner without an address, or a bill without a workspace, gets nothing. Throws when the
 * email could not go out, so the job tries again.
 */
export async function sendLifecycleEmail(sender: EmailSender, job: LifecycleEmailJob) {
  const [owner] = await db
    .select({ email: user.email })
    .from(billing_accounts)
    .innerJoin(user, eq(user.id, billing_accounts.owner_user_id))
    .where(eq(billing_accounts.id, job.bill))
  const [workspace] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(
      job.workspace
        ? and(eq(organization.billingAccountId, job.bill), eq(organization.id, job.workspace))
        : eq(organization.billingAccountId, job.bill),
    )
    .orderBy(asc(organization.createdAt))
    .limit(1)
  if (!workspace) return { sent: 'nobody' as const }
  const to = new Set(owner?.email ? [owner.email] : [])
  if (job.workspace) {
    const [workspaceOwner] = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, workspace.id), eq(member.role, 'owner')))
    if (workspaceOwner?.email) to.add(workspaceOwner.email)
  }
  if (!to.size) return { sent: 'nobody' as const }
  const { email } = job
  const view = email.kind === 'manager_changed' ? await managerChangedView(email, workspace.id) : null
  const timeZone = await timeZoneOf(db, workspace.id)
  for (const address of to) {
    const locale = await localeForEmail(db, address)
    const rendered =
      email.kind === 'manager_changed'
        ? managerChangedEmail(view!, workspace.id, undefined, locale)
        : billingLifecycleEmail(email, workspace.id, undefined, locale, timeZone)
    await sender.send({ to: address, ...rendered })
  }
  return { sent: to.size > 1 ? ('owners' as const) : ('owner' as const) }
}

/**
 * Who changed the bill and where, read when the note is sent (the job carries ids only): their name and address, the
 * workspace's name and time zone.
 */
async function managerChangedView(email: ManagerChangedEmail, workspaceId: string): Promise<ManagerChangedView> {
  const { kind: _kind, actorId, ...change } = email
  const [actor] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actorId))
  const [workspace] = await db
    .select({ name: organization.name, timezone: workspace_settings.timezone })
    .from(organization)
    .leftJoin(workspace_settings, eq(workspace_settings.workspace_id, organization.id))
    .where(eq(organization.id, workspaceId))
  return {
    ...change,
    name: emailSafeName(actor?.name, '') || null,
    email: actor?.email ?? null,
    workspace: emailSafeName(workspace?.name, '') || null,
    timeZone: workspace?.timezone ?? DEFAULT_TIME_ZONE,
  }
}

// ---- The job ----

export type PeriodsRun = {
  billing: 'on' | 'off'
  opened: number
  closed: number
  numbers: Record<string, NumberMonth['kind']>
  released: string[]
  reminded: string[]
  /** Bills whose trial reminder went out this run (billing-checkout.ts sendTrialReminders). */
  trialReminded: string[]
  /** Sign-ups that got their "one step left" email this run (billing-checkout.ts sendActivationNudges). */
  activationNudged: string[]
  failed: string[]
}

/**
 * One run: every step on its own, so one that fails (Stripe down for the reminder) never stops the others; the
 * failures are emailed to the instance admins. `provider` replaces the one in effect (tests).
 */
export async function runBillingPeriods(
  now = new Date().toISOString(),
  options: { provider?: BillingProvider } = {},
): Promise<PeriodsRun> {
  const run: PeriodsRun = {
    billing: 'on',
    opened: 0,
    closed: 0,
    numbers: {},
    released: [],
    reminded: [],
    trialReminded: [],
    activationNudged: [],
    failed: [],
  }
  if ((await billingState(db)).inEffect === 'none') return { ...run, billing: 'off' }
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      console.error(`billing periods: ${name} failed:`, error)
      run.failed.push(`${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
  }
  const inService = await db
    .select({ id: billing_accounts.id, status: billing_accounts.status })
    .from(billing_accounts)
    .where(inArray(billing_accounts.status, [...IN_SERVICE]))
  for (const bill of inService)
    await step(`periods of ${bill.id}`, async () => {
      run.opened += (await db.transaction(tx => openNextPeriods(tx, bill.id, now))).length
    })
  await step('close', async () => {
    run.closed = await db.transaction(tx => closeEndedPeriods(tx, now))
  })
  for (const bill of inService.filter(b => (PAYS_NUMBERS as readonly string[]).includes(b.status)))
    await step(`numbers of ${bill.id}`, async () => {
      Object.assign(run.numbers, await payNumberMonths(bill.id, now))
    })
  await step('unpaid numbers', async () => {
    const { released, failed } = await releaseUnpaidNumbers(now)
    run.released = released
    run.failed.push(...failed)
  })
  const provider = options.provider ?? (await billingProvider(db))
  await step('renewal reminders', async () => {
    run.reminded = await sendRenewalReminders(provider, now)
  })
  await step('trial reminders', async () => {
    // Loaded when it runs, like the webhook jobs do: billing-checkout.ts pulls in more than this job needs at start.
    const { sendTrialReminders } = await import('./billing-checkout.ts')
    run.trialReminded = await sendTrialReminders(now, { provider })
  })
  await step('activation nudges', async () => {
    const { sendActivationNudges } = await import('./billing-checkout.ts')
    run.activationNudged = await sendActivationNudges(now)
  })
  if (run.failed.length)
    await alertInstanceAdmins(billingPeriodsFailedAlert(run.failed)).catch(e =>
      console.error('billing periods: the alert could not be sent:', e),
    )
  return run
}

/** The queues of this file (jobs.ts `startJobs`). */
export async function createBillingPeriodQueues(instance: PgBoss) {
  // One run at a time, never retried: the next hourly run is the retry.
  await instance.createQueue(BILLING_PERIODS, { retryLimit: 0, expireInSeconds: 1800 })
  await instance.createQueue(BILLING_LIFECYCLE_EMAIL, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
}

/** The workers of this file (jobs.ts `runJobs`). */
export async function runBillingPeriodJobs(instance: PgBoss, sender: EmailSender) {
  await instance.schedule(BILLING_PERIODS, BILLING_PERIODS_CRON)
  await instance.work(BILLING_PERIODS, async () => {
    const run = await runBillingPeriods()
    return { ...run, numbers: Object.keys(run.numbers).length }
  })
  await instance.work<LifecycleEmailJob>(BILLING_LIFECYCLE_EMAIL, async ([job]) =>
    sendLifecycleEmail(sender, job!.data),
  )
}
