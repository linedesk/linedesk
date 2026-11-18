// The ledger core on the database (docs/billing.md §4.2 to §4.4, §5.1): the gate's reservation with its level, limit
// and held allowance, posting a finished call once at the level fixed at its start, test calls never counting, the
// recharge decision with one pending attempt and the cap alert once a month, and the nightly check of the sums.
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_periods,
  billing_recharges,
  call_reservations,
  calls,
  ledger_entries,
  organization,
  phone_numbers,
  usage_counters,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import {
  decideRecharge,
  extraNumbersOnBill,
  ledgerDifferences,
  type PostOutcome,
  postCallUsage,
  postEntry,
  reserveCall,
} from '../src/ledger.ts'
import { createWorkspace, randomNumber } from './helpers.ts'

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const NOW = '2026-11-16T12:00:00.000Z'

/** A bill in service with one period over this month and `ws` on it, credited `creditMicros`. */
async function billFor(status: 'active' | 'trialing' | 'comped', creditMicros = 0) {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [bill] = await db
    .insert(billing_accounts)
    .values({ id: rid('bill'), kind: 'cloud', owner_user_id: ws.owner.userId, status, auto_recharge: true })
    .returning()
  const [period] = await db
    .insert(billing_periods)
    .values({
      id: rid('bp'),
      billing_account_id: bill!.id,
      starts_at: '2026-11-01T00:00:00Z',
      ends_at: '2026-12-01T00:00:00Z',
      kind: 'month',
    })
    .returning()
  await db
    .update(organization)
    .set({ billingAccountId: bill!.id, billingState: 'active' })
    .where(eq(organization.id, ws.id))
  if (creditMicros)
    await db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: bill!.id,
        period_id: period!.id,
        kind: 'credit',
        amount_micros: creditMicros,
        source_type: 'admin',
        source_id: rid('credit'),
      }),
    )
  return { ws, bill: bill!, period: period! }
}

async function newCall(workspaceId: string, values: Partial<typeof calls.$inferInsert> = {}) {
  const [call] = await db
    .insert(calls)
    .values({
      id: rid('call'),
      workspace_id: workspaceId,
      from_number: '+15035550100',
      to_number: '+15035550101',
      started_at: NOW,
      ...values,
    })
    .returning()
  return call!
}

const reserve = (
  b: Awaited<ReturnType<typeof billFor>>,
  callId: string,
  over: Partial<Parameters<typeof reserveCall>[1]> = {},
) =>
  db.transaction(tx =>
    reserveCall(tx, {
      callId,
      billId: b.bill.id,
      workspaceId: b.ws.id,
      level: 'standard',
      ownKeys: false,
      limitSeconds: 1200,
      now: NOW,
      ...over,
    }),
  )
const finish = (callId: string, seconds: number, transferSeconds = 0) =>
  db
    .update(calls)
    .set({ duration_sec: seconds, transfer_seconds: transferSeconds, status: 'completed', ended_at: NOW })
    .where(eq(calls.id, callId))
const post = (callId: string, ownKeysConfirmed = false) =>
  db.transaction(tx => postCallUsage(tx, callId, NOW, { ownKeysConfirmed }))
/** The entry a post made, or undefined when it posted nothing. */
const entryOf = (outcome: PostOutcome) => (outcome.kind === 'posted' ? outcome.entry : undefined)
const balanceOf = async (billId: string) =>
  (await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId)))[0]!
const counterOf = async (b: Awaited<ReturnType<typeof billFor>>) =>
  (
    await db
      .select()
      .from(usage_counters)
      .where(and(eq(usage_counters.billing_account_id, b.bill.id), eq(usage_counters.workspace_id, b.ws.id)))
  )[0]!
/** The workspace used its 50 included minutes this period (as if posted; the check then expects the entries). */
const allowanceUsedUp = (b: Awaited<ReturnType<typeof billFor>>) =>
  db.insert(usage_counters).values({
    billing_account_id: b.bill.id,
    period_id: b.period.id,
    workspace_id: b.ws.id,
    included_seconds_used: 3000,
  })
const mine = async (billId: string) =>
  (await db.transaction(tx => ledgerDifferences(tx))).filter(d => d.bill === billId)

describe('a call from the gate to its usage entry', () => {
  test('Standard inside the allowance holds no money and posts $0, using the allowance', async () => {
    const b = await billFor('active')
    const call = await newCall(b.ws.id)
    expect(await reserve(b, call.id)).toMatchObject({ allow: true, reservedMicros: 0, heldSeconds: 1200 })
    const [reservation] = await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))
    expect(reservation).toMatchObject({
      usage_level: 'standard',
      own_keys: false,
      limit_seconds: 1200,
      included_reserved_seconds: 1200,
    })
    await finish(call.id, 300)
    const result = await post(call.id)
    expect(entryOf(result)).toMatchObject({
      kind: 'usage',
      amount_micros: 0,
      seconds: 300,
      included_seconds: 300,
      price_basis: 'standard',
    })
    expect(await counterOf(b)).toMatchObject({ included_seconds_used: 300, usage_micros: 0 })
    expect(await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))).toEqual([])
    expect(await mine(b.bill.id)).toEqual([])
  })

  test('the level fixed at the start prices the call; Premium uses the allowance twice, Ultra not at all', async () => {
    const b = await billFor('active', 20_000_000)
    const premium = await newCall(b.ws.id)
    await reserve(b, premium.id, { level: 'premium', limitSeconds: 600 })
    await finish(premium.id, 600)
    expect(entryOf(await post(premium.id))).toMatchObject({
      amount_micros: 0,
      included_seconds: 600,
      price_basis: 'premium',
    })
    expect((await counterOf(b)).included_seconds_used).toBe(1200)
    const ultra = await newCall(b.ws.id)
    expect(await reserve(b, ultra.id, { level: 'ultra', limitSeconds: 600 })).toMatchObject({
      reservedMicros: 2_000_000,
      heldSeconds: 0,
    })
    await finish(ultra.id, 300, 60)
    expect(entryOf(await post(ultra.id))).toMatchObject({
      amount_micros: -1_200_000,
      seconds: 360,
      included_seconds: 0,
      billable_seconds: 360,
      price_basis: 'ultra',
    })
    expect(await counterOf(b)).toMatchObject({ included_seconds_used: 1200, usage_micros: 1_200_000 })
    expect((await balanceOf(b.bill.id)).balance_micros).toBe(18_800_000)
    expect(await mine(b.bill.id)).toEqual([])
  })

  test('a call posts once; a second post finds nothing to post', async () => {
    const b = await billFor('active', 5_000_000)
    const call = await newCall(b.ws.id)
    await reserve(b, call.id, { level: 'premium' })
    await finish(call.id, 4000)
    expect(await post(call.id)).toMatchObject({ kind: 'posted', posted: true })
    expect(await post(call.id)).toEqual({ kind: 'none' })
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.source_id, call.id))).toHaveLength(1)
  })

  test('own keys is $0 only when forecast at the start and confirmed after the call', async () => {
    const b = await billFor('active', 10_000_000)
    await allowanceUsedUp(b)
    const forecast = await newCall(b.ws.id)
    // The forecast still holds the paid level's price: a part can fall back to our keys.
    expect(await reserve(b, forecast.id, { ownKeys: true, limitSeconds: 600 })).toMatchObject({ allow: true })
    await finish(forecast.id, 600)
    expect(entryOf(await post(forecast.id, true))).toMatchObject({
      amount_micros: 0,
      price_basis: 'own_keys',
      included_seconds: 0,
    })
    const notConfirmed = await newCall(b.ws.id)
    await reserve(b, notConfirmed.id, { ownKeys: true, limitSeconds: 600 })
    await finish(notConfirmed.id, 600)
    expect(entryOf(await post(notConfirmed.id, false))).toMatchObject({
      amount_micros: -500_000,
      price_basis: 'standard',
    })
    const notForecast = await newCall(b.ws.id)
    await reserve(b, notForecast.id, { limitSeconds: 600 })
    await finish(notForecast.id, 600)
    expect(entryOf(await post(notForecast.id, true))).toMatchObject({
      amount_micros: -500_000,
      price_basis: 'standard',
    })
  })

  test('nothing posts before the call has finished; the reservation stays until it has (review M1)', async () => {
    const b = await billFor('active', 5_000_000)
    await allowanceUsedUp(b)
    const call = await newCall(b.ws.id, { status: 'live' })
    await reserve(b, call.id)
    expect(await post(call.id)).toEqual({ kind: 'not_finished' })
    // Completed, but the duration or the end is not written yet: still not finished.
    await db.update(calls).set({ status: 'completed', ended_at: NOW }).where(eq(calls.id, call.id))
    expect(await post(call.id)).toEqual({ kind: 'not_finished' })
    await db.update(calls).set({ ended_at: null, duration_sec: 600 }).where(eq(calls.id, call.id))
    expect(await post(call.id)).toEqual({ kind: 'not_finished' })
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.source_id, call.id))).toEqual([])
    expect(await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))).toHaveLength(1)
    await finish(call.id, 600)
    expect(entryOf(await post(call.id))).toMatchObject({ amount_micros: -500_000, seconds: 600 })
    expect(await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))).toEqual([])
  })

  test('the billed seconds stop at the limit plus the grace, and the entry keeps what the call reported (review M2)', async () => {
    const b = await billFor('active')
    const call = await newCall(b.ws.id)
    expect(await reserve(b, call.id, { level: 'ultra', limitSeconds: 60 })).toMatchObject({ reservedMicros: 200_000 })
    await finish(call.id, 36_000)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await post(call.id)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`call ${call.id} reported 36000 s, billed 120 s`))
    errors.mockRestore()
    expect(outcome).toMatchObject({ kind: 'posted', rating: { seconds: 120, cappedFromSeconds: 36_000 } })
    expect(entryOf(outcome)).toMatchObject({ amount_micros: -400_000, seconds: 120, note: 'capped_from_seconds=36000' })
    // The debt stays within the gate's buffer: the reservation plus the grace's price.
    expect((await balanceOf(b.bill.id)).balance_micros).toBe(-400_000)
  })

  test('the call, its workspace and the bill must belong together (review L2)', async () => {
    const b = await billFor('active', 5_000_000)
    const other = await billFor('active', 5_000_000)
    const call = await newCall(b.ws.id)
    await expect(reserve(b, call.id, { billId: other.bill.id })).rejects.toThrow('do not belong together')
    await expect(reserve(b, call.id, { workspaceId: other.ws.id })).rejects.toThrow('do not belong together')
    const theirs = await newCall(other.ws.id)
    await expect(reserve(b, theirs.id)).rejects.toThrow('do not belong together')
    expect(await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))).toEqual([])
    expect(await reserve(b, call.id)).toMatchObject({ allow: true })
  })

  test('a test call never counts: its reservation goes and nothing posts', async () => {
    const b = await billFor('active')
    const call = await newCall(b.ws.id, { source: 'test' })
    await reserve(b, call.id)
    await finish(call.id, 600)
    expect(await post(call.id)).toEqual({ kind: 'none' })
    expect(await db.select().from(call_reservations).where(eq(call_reservations.call_id, call.id))).toEqual([])
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.source_id, call.id))).toEqual([])
  })

  test('the allowance running calls hold is not free for the next one', async () => {
    const b = await billFor('active', 10_000_000)
    const first = await newCall(b.ws.id)
    expect(await reserve(b, first.id, { limitSeconds: 2400 })).toMatchObject({ heldSeconds: 2400, reservedMicros: 0 })
    const second = await newCall(b.ws.id)
    expect(await reserve(b, second.id, { limitSeconds: 1200 })).toMatchObject({
      heldSeconds: 600,
      reservedMicros: 500_000,
    })
    expect((await balanceOf(b.bill.id)).reserved_micros).toBe(500_000)
    expect(await mine(b.bill.id)).toEqual([])
  })

  test('the gate refuses without balance after the allowance, and over the concurrency cap', async () => {
    const b = await billFor('active')
    await allowanceUsedUp(b)
    const call = await newCall(b.ws.id)
    // 20 minutes at 5¢ is $1, within the −$5 buffer; 20 minutes of Ultra is $4, two of them are not.
    expect(await reserve(b, call.id)).toMatchObject({ allow: true, reservedMicros: 1_000_000 })
    expect(await reserve(b, (await newCall(b.ws.id)).id, { level: 'ultra' })).toMatchObject({ allow: true })
    expect(await reserve(b, (await newCall(b.ws.id)).id, { level: 'ultra' })).toMatchObject({
      allow: false,
      reason: 'no_balance',
    })
    // The trial: at most 5 calls at once per bill (LIN-450, review of #1103 L-4), money for those past the allowance.
    const trial = await billFor('trialing', 10_000_000)
    for (let i = 0; i < 5; i++)
      expect(await reserve(trial, (await newCall(trial.ws.id)).id), `call ${i + 1}`).toMatchObject({ allow: true })
    expect(await reserve(trial, (await newCall(trial.ws.id)).id)).toMatchObject({
      allow: false,
      reason: 'too_many_calls',
    })
  })

  test('a comped bill holds nothing and posts $0 that uses no allowance', async () => {
    const b = await billFor('comped')
    const call = await newCall(b.ws.id)
    expect(await reserve(b, call.id, { level: 'ultra', limitSeconds: 3600 })).toMatchObject({
      allow: true,
      reservedMicros: 0,
      heldSeconds: 0,
    })
    await finish(call.id, 3600)
    expect(entryOf(await post(call.id))).toMatchObject({ amount_micros: 0, seconds: 3600, included_seconds: 0 })
    expect((await counterOf(b)).included_seconds_used).toBe(0)
  })
})

describe('the recharge decision', () => {
  test('below the threshold one pending recharge, then none while it is pending', async () => {
    const b = await billFor('active', 4_000_000)
    expect(await db.transaction(tx => decideRecharge(tx, b.bill.id, NOW))).toMatchObject({
      kind: 'recharge',
      amountCents: 2500,
    })
    expect(await db.transaction(tx => decideRecharge(tx, b.bill.id, NOW))).toEqual({ kind: 'none' })
    const attempts = await db
      .select()
      .from(billing_recharges)
      .where(eq(billing_recharges.billing_account_id, b.bill.id))
    expect(attempts).toMatchObject([{ status: 'pending', amount_cents: 2500 }])
  })

  test('pending, failed and paid attempts this month count in the cap; its alert is made once', async () => {
    const b = await billFor('active', 4_000_000)
    for (const status of ['paid', 'failed'] as const)
      await db.insert(billing_recharges).values({
        id: rid('rc'),
        billing_account_id: b.bill.id,
        amount_cents: 2000,
        status,
        created_at: '2026-11-02T00:00:00.000Z',
        resolved_at: '2026-11-02T00:01:00.000Z',
      })
    // The bill does not wait for its owner (no `recharge_failed_at`), but $50 − $40 leaves less than the $20 minimum.
    expect(await db.transaction(tx => decideRecharge(tx, b.bill.id, NOW))).toEqual({
      kind: 'cap_reached',
      firstThisMonth: true,
    })
    expect(await db.transaction(tx => decideRecharge(tx, b.bill.id, NOW))).toEqual({
      kind: 'cap_reached',
      firstThisMonth: false,
    })
    expect(
      await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, b.bill.id)),
    ).toMatchObject([{ kind: 'recharge_cap_reached', ref: '2026-11' }])
  })

  test('extra numbers on our carrier account count beyond one per workspace', async () => {
    const b = await billFor('active')
    // e164 is unique across the install: draw three distinct numbers up front so no insert can repeat one.
    const drawn = new Set<string>()
    while (drawn.size < 3) drawn.add(randomNumber())
    const [first, second, own] = [...drawn].map(e164 => ({
      id: rid('pn'),
      workspace_id: b.ws.id,
      e164,
      provider: 'dev' as const,
      purchased: true,
    }))
    await db.update(phone_numbers).set({ purchased: true }).where(eq(phone_numbers.workspace_id, b.ws.id))
    await db.insert(phone_numbers).values([first!, second!])
    await db.insert(phone_numbers).values({ ...own!, carrier_account: 'workspace' })
    expect(await db.transaction(tx => extraNumbersOnBill(tx, b.bill.id))).toBe(2)
  })
})

describe('the nightly check', () => {
  test('finds a counter or a paid recharge that does not match the ledger', async () => {
    const b = await billFor('active', 10_000_000)
    const call = await newCall(b.ws.id)
    await reserve(b, call.id)
    await finish(call.id, 120)
    await post(call.id)
    expect(await mine(b.bill.id)).toEqual([])
    await db.update(usage_counters).set({ included_seconds_used: 0 }).where(eq(usage_counters.workspace_id, b.ws.id))
    const paid = rid('rc')
    await db.insert(billing_recharges).values({
      id: paid,
      billing_account_id: b.bill.id,
      amount_cents: 2000,
      status: 'paid',
      created_at: NOW,
      resolved_at: NOW,
    })
    expect(await mine(b.bill.id)).toEqual([
      { kind: 'counter_allowance', bill: b.bill.id, period: b.period.id, workspace: b.ws.id, found: 0, expected: 120 },
      { kind: 'uncredited', bill: b.bill.id, recharge: paid },
    ])
  })
})
