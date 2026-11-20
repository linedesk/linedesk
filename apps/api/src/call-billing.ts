// Billing on the call path: the gate in `openCall`, posting a finished call's
// usage at `call.finish` and in the stale sweep, and what follows a debit (the recharge job, the owner's emails). Only
// a phone call of a workspace on a bill, while billing is in effect (Stripe connected, switched on, the ledger guards
// intact), is ever billed: on every other install and workspace nothing here changes a call.
//
// The ledger work runs in a savepoint of the caller's transaction, so a billing failure never undoes the call itself:
// at the gate a throw is a refusal (security review of #857), at the finish it is logged and the stale sweep posts
// the call again. Emails and the recharge charge are pg-boss jobs queued in the same transaction, so they run only
// once it committed (recheck of #857, N1).
import type { UsageLevel } from '@linedesk/actions'
import { isActiveContact } from '@linedesk/actions'
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  type BillingRules,
  callLimitSeconds,
  call_reservations,
  calls,
  type GateReason,
  instance_settings,
  ledger_entries,
  minutesPromptFor,
  minutesPromptPeriod,
  organization,
  PAID_LEVELS,
  type PaidLevel,
  TRIAL_PROMPT_SHARE,
  type Tx,
} from '@linedesk/db'
import type { Assistant } from '@linedesk/db/types'
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { billingRules } from './billing-rules.ts'
import { busyLineRef } from './billing-recharge.ts'
import { billingState } from './billing-settings.ts'
import { queueBillingAlert, queueRecharge } from './jobs.ts'
import {
  type PostOutcome,
  periodAt,
  type RechargeOutcome,
  postCallUsage,
  reserveCall,
  trialSecondsUsed,
} from './ledger.ts'
import { outboundLimits } from './outbound-policy.ts'
import { todayIn } from './public-holidays.ts'
import { queueUsageLimitAlerts } from './usage-limit.ts'

/**
 * Why billing did not let a call start: the gate's own reasons, a failure while checking or billing switched on but
 * not working (`billing_error`, always a refusal), a voice or model the plan does not allow (`level_not_allowed`), or
 * an extra number whose month is unpaid (`number_unpaid`, billing-periods.ts), or a white-label client at the monthly
 * usage limit its partner set (`usage_limit`, usage-limit.ts).
 */
export type CallRefusal = GateReason | 'billing_error' | 'level_not_allowed' | 'number_unpaid' | 'usage_limit'

/** The bill a phone call is billed to; `usable` false while billing is switched on but cannot run (refuse the call). */
export type CallBill = { billId: string; usable: boolean }

/** The instance setting that remembers the admins were emailed about billing switched on but not working. */
export const BILLING_UNUSABLE_KEY = 'billing.unusableAlerted'
/** What this process last saw: null before its first billed call, so its first look also ends an old streak. */
let unusableSeen: boolean | null = null

/**
 * The bill a phone call of the workspace is billed to: null while the workspace is on no bill (every self-hosted
 * install) or an instance admin switched billing off (calls then run unbilled, deliberately). The workspace is read
 * first, so an install without bills asks nothing else. Billing switched on but not in effect (the ledger guards
 * missing or not checkable, the Stripe keys gone or not allowed) fails closed: the bill comes back `usable: false`,
 * and the instance admins are emailed once per such streak (security review of #864, M2).
 */
export async function billOfCall(tx: Tx, workspaceId: string, now: string): Promise<CallBill | null> {
  const [workspace] = await tx
    .select({ bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (!workspace?.bill) return null
  const state = await billingState(tx)
  if (state.inEffect === 'stripe') {
    if (unusableSeen !== false) {
      await tx.delete(instance_settings).where(eq(instance_settings.key, BILLING_UNUSABLE_KEY))
      unusableSeen = false
    }
    return { billId: workspace.bill, usable: true }
  }
  if (!state.on) return null
  unusableSeen = true
  const added = await tx
    .insert(instance_settings)
    .values({ key: BILLING_UNUSABLE_KEY, value: now, updated_at: now })
    .onConflictDoNothing()
    .returning()
  if (added.length) {
    const reason = state.guardsOk ? 'keys' : 'guards'
    console.error(`billing is switched on but cannot run (${reason}): calls of workspaces on a bill are refused`)
    await queueBillingAlert(tx, { kind: 'billing_unusable', reason })
  }
  return { billId: workspace.bill, usable: false }
}

/** The dearest level of the install's rules: what a call whose level is unknown reserves and pays. */
function dearestLevel(rules: BillingRules): PaidLevel {
  return PAID_LEVELS.reduce((a, b) => (rules.levels[b].microsPerMinute > rules.levels[a].microsPerMinute ? b : a))
}

/**
 * The limit a call of this assistant is reserved for: its max call length, plus with an active
 * transfer contact (and transfers on on this server) the bridged time and the transfer leg, each capped.
 */
export function limitFor(assistant: Pick<Assistant, 'max_call_minutes' | 'transfers'> | null, rules: BillingRules) {
  const transfers = !!assistant?.transfers?.some(isActiveContact) && (outboundLimits().transferMaxMinutes ?? 0) > 0
  return callLimitSeconds(assistant?.max_call_minutes ?? DEFAULT_MAX_MINUTES, transfers, rules)
}
/** assistants.max_call_minutes' default, for a call without an assistant. */
const DEFAULT_MAX_MINUTES = 20

export type GateInput = {
  callId: string
  billId: string
  workspaceId: string
  assistant: Pick<Assistant, 'max_call_minutes' | 'transfers'> | null
  /** The level `assistantForCall` decided; `paidLevel` what it pays when own keys is not confirmed. */
  level: UsageLevel | null
  paidLevel: PaidLevel | null
  now: string
}

/**
 * "Can this call start?" for a billed call: reserves it (reserveCall) in a savepoint of the caller's transaction. Any
 * throw is a refusal (`billing_error`), never an allowed call, and leaves nothing behind. A call of an own-keys
 * forecast reserves its paid level; a level that is not known (no assistant, an option in neither list) the dearest.
 */
export async function gateCall(
  tx: Tx,
  input: GateInput,
): Promise<{ allow: true } | { allow: false; reason: CallRefusal }> {
  try {
    return await tx.transaction(async sp => {
      const rules = await billingRules(sp)
      const level = input.paidLevel ?? (isPaid(input.level) ? input.level : dearestLevel(rules))
      const answer = await reserveCall(sp, {
        callId: input.callId,
        billId: input.billId,
        workspaceId: input.workspaceId,
        level,
        ownKeys: input.level === 'own_keys',
        limitSeconds: limitFor(input.assistant, rules),
        now: input.now,
      })
      await afterDebit(sp, input.billId, answer.recharge ?? { kind: 'none' }, input.now)
      // Answered on the trial grace: the trial's minutes are used up, and the owner hears it once.
      if (answer.allow && answer.grace) await trialMinutesAlert(sp, input.billId, 'trial_minutes_used', input.now)
      return answer.allow ? { allow: true as const } : { allow: false as const, reason: answer.reason }
    })
  } catch (error) {
    console.error(`billing: the gate of call ${input.callId} failed; the call is refused:`, error)
    return { allow: false, reason: 'billing_error' }
  }
}

const isPaid = (level: UsageLevel | null): level is PaidLevel =>
  (PAID_LEVELS as readonly string[]).includes(level ?? '')

/**
 * Posts a finished call's usage (postCallUsage) in a savepoint of the caller's transaction, and queues what follows:
 * the recharge job, the owner's emails, and the admins' email about a capped call (only one that cost something,
 * recheck N2). A call with no reservation (not billed) costs one read. A failure is logged and returns null: the call
 * stays finished, its reservation stays, and the stale sweep posts it again. `ownKeysConfirmed`: the agent's report
 * confirmed every stage ran on the partner's own keys (S7, call.finish); the stale sweep never passes it (fail closed).
 */
export async function postFinishedCall(
  tx: Tx,
  callId: string,
  now: string,
  options: { ownKeysConfirmed?: boolean } = {},
): Promise<PostOutcome | null> {
  const [held] = await tx
    .select({ id: call_reservations.call_id })
    .from(call_reservations)
    .where(eq(call_reservations.call_id, callId))
  if (!held) return { kind: 'none' }
  try {
    return await tx.transaction(async sp => {
      const outcome = await postCallUsage(sp, callId, now, options)
      if (outcome.kind !== 'posted') return outcome
      await afterDebit(sp, outcome.billId, outcome.recharge, now)
      if (outcome.posted) await trialMinutesAlert(sp, outcome.billId, 'trial_minutes_low', now)
      // This call's cost may take a white-label client to 80 % or 100 % of its usage limit (usage-limit.ts).
      if (outcome.posted && outcome.entry.workspace_id) await queueUsageLimitAlerts(sp, outcome.entry.workspace_id, now)
      const { rating } = outcome
      if (outcome.posted && rating.cappedFromSeconds !== null && rating.priceMicros > 0)
        await queueBillingAlert(sp, {
          kind: 'capped_call',
          bill: outcome.billId,
          call: callId,
          reported: rating.cappedFromSeconds,
          billed: rating.seconds,
        })
      return outcome
    })
  } catch (error) {
    console.error(`billing: the usage of call ${callId} could not be posted (the stale sweep tries again):`, error)
    return null
  }
}

/**
 * Billed calls whose reservation is still open although the call has ended (a finish whose post failed or found the
 * call unfinished): posted again, each on its own, by the stale sweep. Returns the ids it posted.
 */
export async function postEndedCalls(tx: Tx, now: string): Promise<string[]> {
  const ended = await tx
    .select({ id: call_reservations.call_id })
    .from(call_reservations)
    .innerJoin(calls, eq(calls.id, call_reservations.call_id))
    .where(and(eq(calls.status, 'completed'), isNotNull(calls.ended_at), isNotNull(calls.duration_sec)))
  const posted: string[] = []
  for (const { id } of ended) if ((await postFinishedCall(tx, id, now))?.kind === 'posted') posted.push(id)
  return posted
}

/**
 * Billed calls still live after their limit plus the grace: the stale sweep ends them at the
 * carrier and posts them, so a stuck call never holds the bill's money and concurrency slots for long.
 */
export async function callsPastTheirLimit(tx: Tx, now: string): Promise<{ id: string; room: string | null }[]> {
  const rules = await billingRules(tx)
  return tx
    .select({ id: calls.id, room: calls.room })
    .from(call_reservations)
    .innerJoin(calls, eq(calls.id, call_reservations.call_id))
    .where(
      and(
        eq(calls.status, 'live'),
        sql`${calls.started_at} + make_interval(secs => ${call_reservations.limit_seconds} + ${rules.callLimitGraceSeconds}) < ${now}::timestamptz`,
      ),
    )
}

/**
 * What follows a debit or a gate check, in the same transaction: a new recharge attempt is charged by a job; the
 * monthly cap reached the first time this month emails the owner; and with auto-recharge off a balance below the
 * threshold emails the owner once per low stretch.
 */
export async function afterDebit(tx: Tx, billId: string, recharge: RechargeOutcome, now: string) {
  if (recharge.kind === 'recharge') await queueRecharge(tx, recharge.rechargeId)
  if (recharge.kind === 'cap_reached' && recharge.firstThisMonth)
    await queueBillingAlert(tx, { kind: 'recharge_cap_reached', bill: billId, ref: now.slice(0, 7) })
  await lowBalanceAlert(tx, billId)
}

/**
 * With auto-recharge off, the owner hears once per low stretch that the balance fell below the threshold (in the trial
 * only after "Keep calls answered"): the stretch
 * is named by the last credit before it (a recharge, top-up, credit or write-off), so the next one starts a new one.
 */
async function lowBalanceAlert(tx: Tx, billId: string) {
  const [bill] = await tx
    .select({
      auto: billing_accounts.auto_recharge,
      status: billing_accounts.status,
      trialRecharge: billing_accounts.trial_recharge_at,
      threshold: billing_accounts.recharge_threshold_cents,
      balance: billing_balances.balance_micros,
      reserved: billing_balances.reserved_micros,
    })
    .from(billing_accounts)
    .innerJoin(billing_balances, eq(billing_balances.billing_account_id, billing_accounts.id))
    .where(eq(billing_accounts.id, billId))
  // Not in the trial before "Keep calls answered": its balance is $0 by design, and the minutes prompt covers it.
  if (!bill || bill.auto || !['trialing', 'active', 'past_due'].includes(bill.status)) return
  if (bill.status === 'trialing' && !bill.trialRecharge) return
  if (bill.balance - bill.reserved >= bill.threshold * 10_000) return
  const [lastCredit] = await tx
    .select({ id: ledger_entries.id })
    .from(ledger_entries)
    .where(and(eq(ledger_entries.billing_account_id, billId), gt(ledger_entries.amount_micros, 0)))
    .orderBy(desc(ledger_entries.created_at), desc(ledger_entries.id))
    .limit(1)
  const ref = lastCredit?.id ?? 'start'
  const added = await tx
    .insert(billing_alerts)
    .values({ billing_account_id: billId, kind: 'low_balance', ref })
    .onConflictDoNothing()
    .returning()
  if (added.length) await queueBillingAlert(tx, { kind: 'low_balance', bill: billId, ref })
}

/**
 * The minutes prompt, once per period each: `trial_minutes_low` when a workspace used
 * `TRIAL_PROMPT_SHARE` of its included minutes, `trial_minutes_used` when a call was answered only on the trial grace
 * after they were all used (the trial only: a paid plan has no grace). For a trial until the owner pressed "Keep calls
 * answered" (the email offers it), and for a paid plan with auto-recharge off (`minutesPromptFor`). The used-up email
 * also marks the low one as sent, so it never follows later. The ref is the period.
 */
export async function trialMinutesAlert(
  tx: Tx,
  billId: string,
  kind: 'trial_minutes_low' | 'trial_minutes_used',
  now: string,
) {
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  const prompt = bill ? minutesPromptFor(bill) : null
  if (!prompt || (prompt === 'plan' && kind === 'trial_minutes_used')) return
  const period = await periodAt(tx, billId, now)
  if (period?.kind !== minutesPromptPeriod(prompt)) return
  // Low: the share of the minutes used. Used up: all of them (a call near the end of the minutes may start on the
  // grace too, for the part of its limit they no longer cover; that is not "used up" yet).
  const used = await trialSecondsUsed(tx, billId, period.id)
  const included = (await billingRules(tx)).includedStandardSeconds
  if (used < (kind === 'trial_minutes_low' ? TRIAL_PROMPT_SHARE * included : included)) return
  const kinds = kind === 'trial_minutes_used' ? ['trial_minutes_used', 'trial_minutes_low'] : [kind]
  const added = await tx
    .insert(billing_alerts)
    .values(kinds.map(k => ({ billing_account_id: billId, kind: k as typeof kind, ref: period.id })))
    .onConflictDoNothing()
    .returning()
  if (added.some(a => a.kind === kind)) await queueBillingAlert(tx, { kind, bill: billId, ref: period.id })
}

/** How long after the first busy caller of the day the notice goes out (it counts the callers until then). */
export const BUSY_LINE_NOTICE_DELAY_SECONDS = 15 * 60

/**
 * The busy-line notice (LIN-450): a caller of a billed workspace heard a busy line because all
 * its calls at the same time were in use (the workspace's limit, or the bill's cap). One `billing_alerts` row per
 * workspace and day (the workspace's own day, `timeZone`) counts that day's busy callers; the first queues the bill
 * owner's one email of the day, and the banner shows the count. A workspace on no bill (self-host), or an install
 * where billing is not in effect, has nothing to buy, so it gets no notice.
 */

export async function busyLineAlert(tx: Tx, workspaceId: string, now: string, timeZone: string) {
  try {
    // A savepoint: the notice never undoes the busy call it is about.
    await tx.transaction(async sp => {
      const [workspace] = await sp
        .select({ bill: organization.billingAccountId })
        .from(organization)
        .where(eq(organization.id, workspaceId))
      // Only where billing is in effect: there is something to add, and an owner who pays.
      if (!workspace?.bill || (await billingState(sp)).inEffect !== 'stripe') return
      const ref = busyLineRef(workspaceId, todayIn(timeZone, Date.parse(now)))
      // One row a workspace and day, counting the callers; the first one queues the day's one notice.
      const [row] = await sp
        .insert(billing_alerts)
        .values({ billing_account_id: workspace.bill, kind: 'busy_line', ref })
        .onConflictDoUpdate({
          target: [billing_alerts.billing_account_id, billing_alerts.kind, billing_alerts.ref],
          set: { count: sql`${billing_alerts.count} + 1` },
        })
        .returning({ count: billing_alerts.count })
      // Sent a little later, so it says how many callers got the busy line in that busy stretch, not just the first.
      if (row?.count === 1)
        await queueBillingAlert(
          sp,
          { kind: 'busy_line', bill: workspace.bill, ref },
          { startAfterSeconds: BUSY_LINE_NOTICE_DELAY_SECONDS },
        )
    })
  } catch (error) {
    console.error(`billing: the busy-line notice of workspace ${workspaceId} could not be queued:`, error)
  }
}
