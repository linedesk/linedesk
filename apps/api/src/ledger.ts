// The billing ledger core: posting entries, rating finished calls, the call gate's reservation
// and the recharge decision, on the tables of migrations 0107 and 0110. The math is in @linedesk/db (types.ts), so the
// browser shows the same numbers; this file reads and locks the rows. No Stripe call happens here: a recharge is a
// pending `billing_recharges` row, charged by the job of PR 4.
//
// Lock order (schema.ts): every function here locks the bill's `billing_balances` row first (`lockBalance`), before
// any recharge or counter row, so the transactions of one bill are serialised on that row and never deadlock.
import {
  type BillingRules,
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_periods,
  billing_recharges,
  type CallRating,
  call_reservations,
  callGate,
  callReservation,
  calls,
  type GateAnswer,
  ledger_entries,
  organization,
  type PaidLevel,
  phone_numbers,
  type RechargeAnswer,
  rateCall,
  rechargeDecision,
  type Tx,
  usage_counters,
} from '@linedesk/db'
import { and, desc, eq, gt, inArray, lte, notLike, type SQL, sql } from 'drizzle-orm'
import { billingRules } from './billing-rules.ts'
import { checkLedgerGuards, missingLedgerGuards } from './ledger-guards.ts'
import { closedLegSeconds } from './transfer-legs.ts'

/**
 * The allowance factor of an entry's price basis, in SQL, from the install's rules (level names are constants and the
 * factors integers checked by billing-rules.ts): a level without a factor and `own_keys` use none, the 0107 bases one
 * each.
 */
const allowanceFactorSql = (rules: BillingRules) =>
  sql.raw(
    `case l.price_basis ${Object.entries(rules.levels)
      .map(([level, price]) => `when '${level}' then ${Math.trunc(Number(price.allowanceFactor ?? 0))}`)
      .join(' ')} when 'own_keys' then 0 else 1 end`,
  )

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** The UTC calendar month an ISO time is in, as its first instant. */
const monthStart = (now: string) => `${new Date(now).toISOString().slice(0, 7)}-01T00:00:00.000Z`

/** Postgres returns sums of bigint as text: read one exactly, refusing what a JS number cannot hold. */
function exactNumber(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n)) throw new Error(`ledger amount out of range: ${String(value)}`)
  return n
}

/** Locks the bill's balance row (made if missing) until the transaction ends: the first lock of every bill path. */
export async function lockBalance(tx: Tx, billId: string) {
  await tx.insert(billing_balances).values({ billing_account_id: billId }).onConflictDoNothing()
  const [row] = await tx
    .select()
    .from(billing_balances)
    .where(eq(billing_balances.billing_account_id, billId))
    .for('update')
  return row!
}

/** The bill's period that contains `at`, or null (a bill in service always has one; null fails the caller closed). */
export async function periodAt(tx: Tx, billId: string, at: string) {
  const [period] = await tx
    .select()
    .from(billing_periods)
    .where(
      and(
        eq(billing_periods.billing_account_id, billId),
        lte(billing_periods.starts_at, at),
        gt(billing_periods.ends_at, at),
      ),
    )
  return period ?? null
}

/**
 * The bill's period for money posted now (a credit, a refund): the one that contains now, else its latest, so money
 * that moved after the last period closed (a refund up to 90 days after the bill ended) still has a place. Null only
 * for a bill without any period.
 */
export async function periodForMoney(tx: Tx, billId: string, now: string) {
  const current = await periodAt(tx, billId, now)
  if (current) return current
  const [latest] = await tx
    .select()
    .from(billing_periods)
    .where(eq(billing_periods.billing_account_id, billId))
    .orderBy(desc(billing_periods.starts_at))
    .limit(1)
  return latest ?? null
}

async function workspacesOnBill(tx: Tx, billId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return row?.n ?? 0
}

/** The extra calls at once of each workspace on the bill (LIN-450): the call gate's cap is their limits' sum. */
export async function extraCallsOnBill(tx: Pick<Tx, 'select'>, billId: string): Promise<number[]> {
  const rows = await tx
    .select({ extra: organization.extraCalls })
    .from(organization)
    .where(eq(organization.billingAccountId, billId))
  return rows.map(r => r.extra)
}

/**
 * The numbers that pay a monthly fee once they are extra: bought through Linedesk on its carrier account, without the
 * numbers of the countries that once needed documents (Germany, the UK, Ireland) while the install waives their fee
 * (`regulatedNumberFeeWaived`; Germany's numbers are now held in the install's name, number-buy.ts). A waived number is not counted at all, so it never takes the number a workspace includes.
 */
export async function feeNumbers(tx: Pick<Tx, 'select'>): Promise<SQL> {
  const waived = (await billingRules(tx)).regulatedNumberFeeWaived
  return and(
    eq(phone_numbers.purchased, true),
    eq(phone_numbers.carrier_account, 'install'),
    ...(waived ? regulatedPrefixes().map(prefix => notLike(phone_numbers.e164, `${prefix}%`)) : []),
  )!
}

/** The calling codes of the countries the fee waiver covers (Germany, the UK, Ireland). */
const regulatedPrefixes = () => ['+49', '+44', '+353']

/** Numbers bought on our carrier account beyond the one each workspace includes (feeNumbers). */
export async function extraNumbersOnBill(tx: Tx, billId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(phone_numbers)
    .innerJoin(organization, eq(organization.id, phone_numbers.workspace_id))
    .where(and(eq(organization.billingAccountId, billId), await feeNumbers(tx)))
    .groupBy(phone_numbers.workspace_id)
  return rows.reduce((sum, r) => sum + Math.max(0, r.n - 1), 0)
}

/** The most included Standard seconds a workspace of the bill used in the period (the trial prompt's figure). */
export async function trialSecondsUsed(tx: Pick<Tx, 'select'>, billId: string, periodId: string) {
  const [row] = await tx
    .select({ used: sql<number>`coalesce(max(${usage_counters.included_seconds_used}), 0)::int` })
    .from(usage_counters)
    .where(and(eq(usage_counters.billing_account_id, billId), eq(usage_counters.period_id, periodId)))
  return row?.used ?? 0
}

export type NewEntry = Omit<typeof ledger_entries.$inferInsert, 'id' | 'created_at'>

/**
 * Posts one ledger entry, once: a second post of the same source and kind returns the first entry unchanged
 * (`ledger_entries_source`). The balance moves by trigger in the same statement; the bill's balance row is locked
 * first, so the order of locks is the same on every path.
 */
export async function postEntry(tx: Tx, entry: NewEntry) {
  await lockBalance(tx, entry.billing_account_id)
  const [posted] = await tx
    .insert(ledger_entries)
    .values({ ...entry, id: newId('le') })
    .onConflictDoNothing({ target: [ledger_entries.source_type, ledger_entries.source_id, ledger_entries.kind] })
    .returning()
  if (posted) return { entry: posted, posted: true }
  const [existing] = await tx
    .select()
    .from(ledger_entries)
    .where(
      and(
        eq(ledger_entries.source_type, entry.source_type),
        eq(ledger_entries.source_id, entry.source_id),
        eq(ledger_entries.kind, entry.kind),
      ),
    )
  return { entry: existing!, posted: false }
}

/** The workspace's counter row for the period (made if missing), locked; called after the balance row is locked. */
async function lockCounter(tx: Tx, billId: string, periodId: string, workspaceId: string) {
  const slot = { billing_account_id: billId, period_id: periodId, workspace_id: workspaceId }
  await tx.insert(usage_counters).values(slot).onConflictDoNothing()
  const [row] = await tx
    .select()
    .from(usage_counters)
    .where(
      and(
        eq(usage_counters.billing_account_id, billId),
        eq(usage_counters.period_id, periodId),
        eq(usage_counters.workspace_id, workspaceId),
      ),
    )
    .for('update')
  return row!
}

/** The included allowance the workspace's running calls hold, in Standard seconds. */
async function allowanceHeld(tx: Tx, billId: string, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${call_reservations.included_reserved_seconds}), 0)::int` })
    .from(call_reservations)
    .innerJoin(calls, eq(calls.id, call_reservations.call_id))
    .where(and(eq(call_reservations.billing_account_id, billId), eq(calls.workspace_id, workspaceId)))
  return row?.n ?? 0
}

/**
 * The call is the workspace's and the workspace is on the bill, read under the bill's lock: a caller's stale bill id
 * or wrong workspace never bills one customer's call to another bill (security review of #857, L2). Throws: a
 * mismatch is a bug in the caller, and the caller treats any throw as a refusal.
 */
async function assertBelongTogether(tx: Tx, input: Pick<ReserveInput, 'callId' | 'billId' | 'workspaceId'>) {
  const [workspace] = await tx
    .select({ billId: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, input.workspaceId))
  const [call] = await tx.select({ workspaceId: calls.workspace_id }).from(calls).where(eq(calls.id, input.callId))
  if (workspace?.billId !== input.billId || call?.workspaceId !== input.workspaceId)
    throw new Error(
      `billing: call ${input.callId}, workspace ${input.workspaceId} and bill ${input.billId} do not belong together`,
    )
}

export type ReserveInput = {
  callId: string
  billId: string
  workspaceId: string
  /** The level the call pays (an own-keys call too: its level if own keys is not confirmed). */
  level: PaidLevel
  /** `usageLevel` forecast every part on the customer's own keys. */
  ownKeys: boolean
  /** `callLimitSeconds` of the assistant's settings at call start. */
  limitSeconds: number
  now: string
}
export type ReserveAnswer = GateAnswer & { reservedMicros?: number; heldSeconds?: number; recharge?: RechargeOutcome }

/**
 * "Can this call start?": under the bill's balance lock, checks the bill, its concurrency cap
 * and the balance, and on yes stores the call's reservation (its paid level, the own-keys forecast, its limit, the
 * money and the allowance it holds). A low balance also runs the recharge decision.
 */
export async function reserveCall(tx: Tx, input: ReserveInput): Promise<ReserveAnswer> {
  const balance = await lockBalance(tx, input.billId)
  await assertBelongTogether(tx, input)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, input.billId))
  if (!bill) return { allow: false, reason: 'billing_inactive' }
  const period = await periodAt(tx, input.billId, input.now)
  if (!period) return { allow: false, reason: 'billing_inactive' }
  const [running] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(call_reservations)
    .where(eq(call_reservations.billing_account_id, input.billId))
  const rules = await billingRules(tx)
  const counter = await lockCounter(tx, input.billId, period.id, input.workspaceId)
  const free =
    rules.includedStandardSeconds -
    counter.included_seconds_used -
    (await allowanceHeld(tx, input.billId, input.workspaceId))
  // A comped bill is debited nothing, so its calls hold neither money nor allowance.
  const { heldSeconds, reservedMicros } =
    bill.status === 'comped'
      ? { heldSeconds: 0, reservedMicros: 0 }
      : callReservation(input.level, input.limitSeconds, free, rules)
  const answer = callGate(
    {
      status: bill.status,
      balanceMicros: balance.balance_micros,
      reservedMicros: balance.reserved_micros,
      running: running?.n ?? 0,
      extraCalls: await extraCallsOnBill(tx, input.billId),
      concurrencyCap: bill.concurrent_calls_cap,
    },
    reservedMicros,
    rules,
  )
  if (!answer.allow) return { ...answer, recharge: await decideRecharge(tx, input.billId, input.now) }
  await tx.insert(call_reservations).values({
    call_id: input.callId,
    billing_account_id: input.billId,
    reserved_micros: reservedMicros,
    usage_level: input.level,
    own_keys: input.ownKeys,
    limit_seconds: input.limitSeconds,
    included_reserved_seconds: heldSeconds,
  })
  return {
    allow: true,
    ...(answer.grace ? { grace: true as const } : {}),
    reservedMicros,
    heldSeconds,
    recharge: await decideRecharge(tx, input.billId, input.now),
  }
}

export type PostOutcome =
  /** Nothing to post: no reservation (already posted, or the call was not billed at its start), or a call that never counts. */
  | { kind: 'none' }
  /** The call has not finished (no `completed` status, end or duration yet): nothing posted, the reservation kept. */
  | { kind: 'not_finished' }
  | {
      kind: 'posted'
      billId: string
      entry: typeof ledger_entries.$inferSelect
      /** False when an earlier post of this call already made the entry. */
      posted: boolean
      rating: CallRating
      recharge: RechargeOutcome
    }

/**
 * Rates a finished call and posts its usage once, at the level and to the bill stored on its
 * reservation, in the period it started in; releases the reservation. Only a finished call posts: before its status
 * is `completed` with `ended_at` and `duration_sec` set, nothing posts and the reservation stays, so an early or
 * repeated finish never locks in $0 (security review of #857, M1). The billed seconds are capped at the reservation's
 * limit plus the grace; when the cap applies the entry's note keeps the reported seconds (M2), and the caller tells
 * the instance admins once the transaction committed (call-billing.ts; recheck N1). A test, simulated or sample call never counts: its reservation goes and nothing posts.
 * `ownKeysConfirmed`: the usage report confirmed every part ran on the customer's own keys; it makes the call $0 only
 * when own keys was also forecast at its start. A comped bill gets a $0 entry that uses no allowance.
 */
export async function postCallUsage(
  tx: Tx,
  callId: string,
  now: string,
  options: { ownKeysConfirmed?: boolean } = {},
): Promise<PostOutcome> {
  const [reservation] = await tx.select().from(call_reservations).where(eq(call_reservations.call_id, callId))
  if (!reservation) return { kind: 'none' }
  const billId = reservation.billing_account_id
  await lockBalance(tx, billId)
  const [call] = await tx.select().from(calls).where(eq(calls.id, callId))
  if (call?.source !== 'phone') {
    await tx.delete(call_reservations).where(eq(call_reservations.call_id, callId))
    return { kind: 'none' }
  }
  if (call.status !== 'completed' || call.ended_at === null || call.duration_sec === null)
    return { kind: 'not_finished' }
  const period = await periodAt(tx, billId, call.started_at)
  if (!period) throw new Error(`billing: no period of bill ${billId} at ${call.started_at} for call ${callId}`)
  const counter = await lockCounter(tx, billId, period.id, call.workspace_id)
  const [bill] = await tx
    .select({ status: billing_accounts.status })
    .from(billing_accounts)
    .where(eq(billing_accounts.id, billId))
  const rating = rateCall(
    {
      comped: bill?.status === 'comped',
      durationSeconds: call.duration_sec,
      // Every transfer leg, the one still bridged when the call ended up to that end (security review of #864, H1).
      transferSeconds: closedLegSeconds(call, call.ended_at),
      level: reservation.usage_level,
      ownKeysConfirmed: reservation.own_keys && options.ownKeysConfirmed === true,
      allowanceUsed: counter.included_seconds_used,
      limitSeconds: reservation.limit_seconds,
    },
    await billingRules(tx),
  )
  const { entry, posted } = await postEntry(tx, {
    billing_account_id: billId,
    workspace_id: call.workspace_id,
    period_id: period.id,
    kind: 'usage',
    amount_micros: -rating.priceMicros,
    seconds: rating.seconds,
    included_seconds: rating.includedSeconds,
    billable_seconds: rating.billableSeconds,
    price_basis: rating.basis,
    source_type: 'call',
    source_id: callId,
    // Machine-readable, for the admin review of a capped call: the seconds the call reported.
    note: rating.cappedFromSeconds === null ? null : `capped_from_seconds=${rating.cappedFromSeconds}`,
  })
  if (posted) {
    await tx
      .update(usage_counters)
      .set({
        included_seconds_used: sql`${usage_counters.included_seconds_used} + ${rating.allowanceSeconds}`,
        usage_micros: sql`${usage_counters.usage_micros} + ${rating.priceMicros}`,
        updated_at: now,
      })
      .where(
        and(
          eq(usage_counters.billing_account_id, billId),
          eq(usage_counters.period_id, period.id),
          eq(usage_counters.workspace_id, call.workspace_id),
        ),
      )
    if (rating.cappedFromSeconds !== null)
      console.error(
        `billing: call ${callId} reported ${rating.cappedFromSeconds} s, billed ${rating.seconds} s (its limit plus the grace)`,
      )
  }
  await tx.delete(call_reservations).where(eq(call_reservations.call_id, callId))
  return { kind: 'posted', billId, entry, posted, rating, recharge: await decideRecharge(tx, billId, now) }
}

export type RechargeOutcome =
  | { kind: 'none' }
  | { kind: 'recharge'; rechargeId: string; amountCents: number }
  | { kind: 'cap_reached'; firstThisMonth: boolean }

/**
 * The recharge decision under the bill's balance lock: a pending `billing_recharges` row when
 * the balance is below the threshold and the monthly cap leaves at least $20, else maybe the cap-reached alert row
 * (once per month). The partial unique index keeps it to one pending attempt even if two decide at once.
 */
export async function decideRecharge(tx: Tx, billId: string, now: string): Promise<RechargeOutcome> {
  const balance = await lockBalance(tx, billId)
  const [bill] = await tx.select().from(billing_accounts).where(eq(billing_accounts.id, billId))
  if (!bill) return { kind: 'none' }
  const month = monthStart(now)
  const attempts = await tx
    .select({
      status: billing_recharges.status,
      amount: billing_recharges.amount_cents,
      created_at: billing_recharges.created_at,
      manual: billing_recharges.manual,
    })
    .from(billing_recharges)
    .where(
      and(
        eq(billing_recharges.billing_account_id, billId),
        inArray(billing_recharges.status, ['pending', 'failed', 'paid']),
      ),
    )
  // "Buy minutes" with the saved card (`manual`) is the owner's own purchase: never counted in the automatic cap.
  const thisMonth = attempts.filter(a => !a.manual && new Date(a.created_at) >= new Date(month))
  const answer: RechargeAnswer = rechargeDecision(
    {
      status: bill.status,
      autoRecharge: bill.auto_recharge,
      thresholdCents: bill.recharge_threshold_cents,
      amountCents: bill.recharge_amount_cents,
      capBaseCents: bill.recharge_cap_base_cents,
      workspaces: await workspacesOnBill(tx, billId),
      extraNumbers: await extraNumbersOnBill(tx, billId),
      pending: attempts.some(a => a.status === 'pending'),
      failedWaiting: bill.recharge_failed_at !== null,
      trialRecharge: bill.trial_recharge_at !== null,
      availableMicros: balance.balance_micros - balance.reserved_micros,
      usedThisMonthCents: thisMonth.reduce((sum, a) => sum + a.amount, 0),
    },
    await billingRules(tx),
  )
  if (answer.kind === 'none') return answer
  if (answer.kind === 'cap_reached') {
    const inserted = await tx
      .insert(billing_alerts)
      .values({ billing_account_id: billId, kind: 'recharge_cap_reached', ref: month.slice(0, 7) })
      .onConflictDoNothing()
      .returning()
    return { kind: 'cap_reached', firstThisMonth: inserted.length > 0 }
  }
  const [row] = await tx
    .insert(billing_recharges)
    .values({ id: newId('rc'), billing_account_id: billId, amount_cents: answer.amountCents, created_at: now })
    .onConflictDoNothing()
    .returning()
  return row ? { kind: 'recharge', rechargeId: row.id, amountCents: row.amount_cents } : { kind: 'none' }
}

/** One thing the nightly check finds that does not add up; `expected` is what the ledger says, `found` the stored sum. */
export type LedgerDifference =
  | { kind: 'balance' | 'reserved'; bill: string; found: number; expected: number }
  | {
      kind: 'counter_allowance' | 'counter_usage'
      bill: string
      period: string
      workspace: string
      found: number
      expected: number
    }
  | { kind: 'uncredited'; bill: string; recharge: string }

/**
 * What the nightly check finds wrong: a balance that is not its ledger's sum, a reserved sum
 * that is not its reservations', a counter that is not its usage entries' (allowance at each level's factor, and the
 * money), a paid recharge without its credit. Empty when everything adds up.
 */
export async function ledgerDifferences(tx: Tx): Promise<LedgerDifference[]> {
  const balances = await tx.execute<{
    bill: string
    balance: string
    ledger: string
    reserved: string
    held: string
  }>(sql`
    select b.billing_account_id as bill, b.balance_micros as balance, b.reserved_micros as reserved,
      coalesce((select sum(amount_micros) from ledger_entries l where l.billing_account_id = b.billing_account_id), 0) as ledger,
      coalesce((select sum(reserved_micros) from call_reservations r where r.billing_account_id = b.billing_account_id), 0) as held
    from billing_balances b`)
  const counters = await tx.execute<{
    bill: string
    period: string
    workspace: string
    used: number
    usage: string
    allowance: number
    charged: string
  }>(sql`
    with counted as (
      select l.billing_account_id as bill, l.period_id as period, l.workspace_id as workspace,
        sum(l.included_seconds * ${allowanceFactorSql(await billingRules(tx))})::int as allowance,
        -sum(l.amount_micros) as charged
      from ledger_entries l where l.kind = 'usage'
      group by l.billing_account_id, l.period_id, l.workspace_id)
    select coalesce(c.billing_account_id, u.bill) as bill, coalesce(c.period_id, u.period) as period,
      coalesce(c.workspace_id, u.workspace) as workspace,
      coalesce(c.included_seconds_used, 0) as used, coalesce(c.usage_micros, 0) as usage,
      coalesce(u.allowance, 0) as allowance, coalesce(u.charged, 0) as charged
    from usage_counters c
    full outer join counted u on u.bill = c.billing_account_id and u.period = c.period_id
      and u.workspace = c.workspace_id`)
  const uncredited = await tx.execute<{ bill: string; id: string }>(sql`
    select r.billing_account_id as bill, r.id from billing_recharges r
    where r.status = 'paid' and not exists (
      select 1 from ledger_entries l where l.kind = 'recharge' and l.source_type = 'billing_recharge' and l.source_id = r.id)`)
  const found: LedgerDifference[] = []
  for (const r of balances.rows) {
    const balance = { found: exactNumber(r.balance), expected: exactNumber(r.ledger) }
    if (balance.found !== balance.expected) found.push({ kind: 'balance', bill: r.bill, ...balance })
    const reserved = { found: exactNumber(r.reserved), expected: exactNumber(r.held) }
    if (reserved.found !== reserved.expected) found.push({ kind: 'reserved', bill: r.bill, ...reserved })
  }
  for (const c of counters.rows) {
    const slot = { bill: c.bill, period: c.period, workspace: c.workspace }
    if (c.used !== c.allowance) found.push({ kind: 'counter_allowance', ...slot, found: c.used, expected: c.allowance })
    const usage = { found: exactNumber(c.usage), expected: exactNumber(c.charged) }
    if (usage.found !== usage.expected) found.push({ kind: 'counter_usage', ...slot, ...usage })
  }
  for (const r of uncredited.rows) found.push({ kind: 'uncredited', bill: r.bill, recharge: r.id })
  return found
}

/**
 * The nightly billing check: the ledger guards again (a missing one turns billing off until the
 * next good check), then the sums. Skipped on an install without bills. Returns what it found, for the alert.
 */
export async function checkLedger(
  tx: Tx,
): Promise<{ guardsMissing: string[]; differences: LedgerDifference[] } | null> {
  if (!(await anyBills(tx))) return null
  const guardsMissing = (await checkLedgerGuards(tx)) ? [] : await missingLedgerGuards(tx)
  return { guardsMissing, differences: await ledgerDifferences(tx) }
}

/** Bills exist on this install (else the nightly check has nothing to compare). */
export async function anyBills(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ id: billing_accounts.id }).from(billing_accounts).limit(1)
  return !!row
}
