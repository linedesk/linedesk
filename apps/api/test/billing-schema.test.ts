// The billing tables (docs/billing.md §4.1): the ledger is append-only in the database, posting the same
// source twice is refused, kinds, sources and signs are checked, periods never overlap, the balance and the
// reservations always add up on the balance row, one recharge at a time per bill, and the API notices a missing,
// disabled or changed guard.
import {
  RECHARGE_CAP_BASE_CENTS,
  RECHARGE_DEFAULTS,
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_periods,
  billing_recharges,
  call_reservations,
  calls,
  ledger_entries,
  organization,
  rechargeCapCents,
  usage_counters,
} from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  LEDGER_CONSTRAINTS,
  LEDGER_GUARDS,
  LEDGER_INDEXES,
  checkLedgerGuards,
  ledgerGuardsOk,
  missingLedgerGuards,
  requireLedgerGuards,
} from '../src/ledger-guards.ts'
import { act, asServerAdmin, createWorkspace, signUp } from './helpers.ts'

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

async function bill() {
  const [account] = await db
    .insert(billing_accounts)
    .values({ id: rid('bill'), kind: 'cloud', owner_user_id: rid('u') })
    .returning()
  const [period] = await db
    .insert(billing_periods)
    .values({
      id: rid('bp'),
      billing_account_id: account!.id,
      starts_at: '2026-11-01T00:00:00Z',
      ends_at: '2026-12-01T00:00:00Z',
      kind: 'month',
    })
    .returning()
  return { account: account!, period: period! }
}

async function usage(billId: string, periodId: string, sourceId = rid('call'), workspaceId = rid('ws')) {
  const [entry] = await db
    .insert(ledger_entries)
    .values({
      id: rid('le'),
      billing_account_id: billId,
      period_id: periodId,
      workspace_id: workspaceId,
      kind: 'usage',
      amount_micros: -50_000,
      seconds: 3060,
      included_seconds: 3000,
      billable_seconds: 60,
      price_basis: 'fixed_5c',
      source_type: 'call',
      source_id: sourceId,
    })
    .returning()
  return entry!
}

/** The Postgres error of a failed statement (drizzle wraps the driver's error in `cause`). */
async function failure(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run()
  } catch (error) {
    const e = error as { code?: string; message: string; cause?: { code?: string; message: string } }
    return e.cause ?? e
  }
  throw new Error('expected the statement to fail')
}

const balanceOf = async (billId: string) =>
  (await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId)))[0]

describe('ledger_entries', () => {
  test('is append-only: UPDATE, DELETE and TRUNCATE are refused (the guard against bugs)', async () => {
    const { account, period } = await bill()
    const entry = await usage(account.id, period.id)

    const update = await failure(() =>
      db.update(ledger_entries).set({ amount_micros: 0 }).where(eq(ledger_entries.id, entry.id)),
    )
    expect(update.code).toBe('23001')
    expect(update.message).toMatch(/append-only: UPDATE/)
    const remove = await failure(() => db.delete(ledger_entries).where(eq(ledger_entries.id, entry.id)))
    expect(remove.message).toMatch(/append-only: DELETE/)
    const truncate = await failure(() => db.execute(sql`truncate ledger_entries`))
    expect(truncate.message).toMatch(/append-only: TRUNCATE/)

    expect((await db.select().from(ledger_entries).where(eq(ledger_entries.id, entry.id)))[0]).toEqual(entry)
  })

  test('a correction is a new adjustment pointing at an entry of the same bill', async () => {
    const { account, period } = await bill()
    const entry = await usage(account.id, period.id)
    const adjustment = (billId: string, periodId: string) =>
      db.insert(ledger_entries).values({
        id: rid('le'),
        billing_account_id: billId,
        period_id: periodId,
        kind: 'adjustment',
        amount_micros: -entry.amount_micros,
        source_type: 'admin',
        source_id: rid('adj'),
        reverses_entry_id: entry.id,
      })
    const other = await bill()
    expect((await failure(() => adjustment(other.account.id, other.period.id))).code).toBe('23503')
    await adjustment(account.id, period.id)
    const [sum] = (
      await db.execute(
        sql`select coalesce(sum(amount_micros), 0)::bigint as n from ledger_entries where billing_account_id = ${account.id}`,
      )
    ).rows as { n: string }[]
    expect(Number(sum!.n)).toBe(0)
  })

  test('posting the same source and kind twice is refused by the unique key', async () => {
    const { account, period } = await bill()
    const callId = rid('call')
    await usage(account.id, period.id, callId)
    expect((await failure(() => usage(account.id, period.id, callId))).code).toBe('23505')
    const rows = await db.select().from(ledger_entries).where(eq(ledger_entries.source_id, callId))
    expect(rows).toHaveLength(1)
  })

  test('kinds, sources and signs are checked by the database, not only in TypeScript', async () => {
    const { account, period } = await bill()
    const insert = (fields: Record<string, unknown>) =>
      db.execute(sql`insert into ledger_entries (id, billing_account_id, period_id, kind, amount_micros, source_type, source_id, seconds, included_seconds, billable_seconds)
        values (${rid('le')}, ${account.id}, ${period.id}, ${fields.kind ?? 'usage'}, ${fields.amount ?? -1}, ${fields.source ?? 'call'}, ${rid('s')},
        ${fields.seconds === undefined ? 10 : fields.seconds}, ${fields.included === undefined ? 0 : fields.included}, ${fields.billable === undefined ? 10 : fields.billable})`)
    const recharge = {
      kind: 'recharge',
      source: 'billing_recharge',
      amount: 20_000_000,
      seconds: null,
      included: null,
      billable: null,
    }
    for (const fields of [
      { kind: 'invoiced' },
      { source: 'stripe_credit_note' },
      { source: 'admin' },
      { seconds: 10, included: 5, billable: 4 },
      { seconds: null, included: null, billable: null },
      { amount: 1 },
      { ...recharge, seconds: 1 },
      { ...recharge, amount: -1 },
      { ...recharge, source: 'stripe_checkout' },
    ])
      expect((await failure(() => insert(fields))).code, JSON.stringify(fields)).toMatch(/^23514$/)
    await insert(recharge)
    await insert({})
  })
})

describe('the balance', () => {
  test('balance_micros is always the sum of the ledger, whichever entry is posted', async () => {
    const { account, period } = await bill()
    expect(await balanceOf(account.id)).toBeUndefined()
    await db.insert(ledger_entries).values({
      id: rid('le'),
      billing_account_id: account.id,
      period_id: period.id,
      kind: 'recharge',
      amount_micros: 20_000_000,
      source_type: 'billing_recharge',
      source_id: rid('rc'),
    })
    expect((await balanceOf(account.id))?.balance_micros).toBe(20_000_000)
    await usage(account.id, period.id)
    await usage(account.id, period.id)
    const [sum] = (
      await db.execute(
        sql`select sum(amount_micros)::bigint as n from ledger_entries where billing_account_id = ${account.id}`,
      )
    ).rows as { n: string }[]
    expect((await balanceOf(account.id))?.balance_micros).toBe(Number(sum!.n))
    expect(Number(sum!.n)).toBe(19_900_000)
  })

  test("an extra number's month posts once per period: its source_id ends in the period", async () => {
    const { account, period } = await bill()
    const number = (sourceId: string) =>
      db.insert(ledger_entries).values({
        id: rid('le'),
        billing_account_id: account.id,
        period_id: period.id,
        kind: 'number',
        amount_micros: -3_000_000,
        source_type: 'phone_number',
        source_id: sourceId,
      })
    const numberId = rid('pn')
    expect((await failure(() => number(numberId))).code).toBe('23514')
    expect((await failure(() => number(`${numberId}:${rid('bp')}`))).code).toBe('23514')
    await number(`${numberId}:${period.id}`)
    expect((await failure(() => number(`${numberId}:${period.id}`))).code).toBe('23505')
  })
})

describe('periods', () => {
  test("a bill's periods never overlap; another bill's may", async () => {
    const { account } = await bill()
    const period = (billId: string, starts: string, ends: string) =>
      db
        .insert(billing_periods)
        .values({ id: rid('bp'), billing_account_id: billId, starts_at: starts, ends_at: ends, kind: 'month' })
    expect((await failure(() => period(account.id, '2026-11-15T00:00:00Z', '2026-12-15T00:00:00Z'))).code).toBe('23P01')
    await period(account.id, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')
    await period((await bill()).account.id, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')
  })
})

describe('balances, reservations and counters', () => {
  test('reserved_micros is always the sum of the call reservations, a deleted call included', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const { account } = await bill()
    const [second] = await db
      .insert(calls)
      .values({ id: rid('call'), workspace_id: ws.id, from_number: ws.contact.phone, to_number: ws.number })
      .returning()
    await db
      .insert(call_reservations)
      .values({ call_id: ws.call.id, billing_account_id: account.id, reserved_micros: 250_000 })
    await db
      .insert(call_reservations)
      .values({ call_id: second!.id, billing_account_id: account.id, reserved_micros: 250_000 })
    expect((await balanceOf(account.id))?.reserved_micros).toBe(500_000)
    await db
      .update(call_reservations)
      .set({ reserved_micros: 100_000 })
      .where(eq(call_reservations.call_id, second!.id))
    expect((await balanceOf(account.id))?.reserved_micros).toBe(350_000)
    await db.delete(call_reservations).where(eq(call_reservations.call_id, ws.call.id))
    expect((await balanceOf(account.id))?.reserved_micros).toBe(100_000)
    await db.delete(calls).where(eq(calls.id, second!.id))
    expect((await balanceOf(account.id))?.reserved_micros).toBe(0)
  })

  test('call_reservations cannot be truncated behind the reserved sum', async () => {
    const truncate = await failure(() => db.execute(sql`truncate call_reservations`))
    expect(truncate.code).toBe('23001')
    expect(truncate.message).toMatch(/cannot be truncated/)
  })

  test('one balance row per bill; one counter row per bill, period and workspace', async () => {
    const { account, period } = await bill()
    await db.insert(billing_balances).values({ billing_account_id: account.id })
    expect((await failure(() => db.insert(billing_balances).values({ billing_account_id: account.id }))).code).toBe(
      '23505',
    )
    expect(
      (
        await failure(() =>
          db
            .update(billing_balances)
            .set({ reserved_micros: -1 })
            .where(eq(billing_balances.billing_account_id, account.id)),
        )
      ).code,
    ).toBe('23514')
    const slot = { billing_account_id: account.id, period_id: period.id, workspace_id: rid('ws') }
    await db.insert(usage_counters).values(slot)
    expect((await failure(() => db.insert(usage_counters).values(slot))).code).toBe('23505')
  })

  test("a workspace's bill must exist, and a bill with workspaces is not deleted", async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const setBill = (id: string) =>
      db.update(organization).set({ billingAccountId: id }).where(eq(organization.id, ws.id))
    expect((await failure(() => setBill(rid('bill')))).code).toBe('23503')
    const { account } = await bill()
    await setBill(account.id)
    expect((await failure(() => db.delete(billing_accounts).where(eq(billing_accounts.id, account.id)))).code).toBe(
      '23503',
    )
    const state = await failure(() =>
      db.execute(sql`update organization set billing_state = 'trialing' where id = ${ws.id}`),
    )
    expect(state.code).toBe('23514')
  })
})

describe('auto-recharge settings and the monthly cap', () => {
  test('defaults: on, below $5 charge $20, cap base $50; the cap adds $25 per workspace after the first', async () => {
    const { account } = await bill()
    expect(account).toMatchObject({
      auto_recharge: true,
      recharge_threshold_cents: RECHARGE_DEFAULTS.thresholdCents,
      recharge_amount_cents: RECHARGE_DEFAULTS.amountCents,
      recharge_cap_base_cents: RECHARGE_CAP_BASE_CENTS,
    })
    expect([RECHARGE_DEFAULTS.thresholdCents, RECHARGE_DEFAULTS.amountCents, RECHARGE_CAP_BASE_CENTS]).toEqual([
      500, 2000, 5000,
    ])
    expect(rechargeCapCents(5000, 0)).toBe(5000)
    expect(rechargeCapCents(5000, 1)).toBe(5000)
    expect(rechargeCapCents(5000, 2)).toBe(7500)
    expect(rechargeCapCents(5000, 5)).toBe(15_000)
    expect(rechargeCapCents(20_000, 3)).toBe(25_000)
  })

  test('threshold $5 to $100, amount $20 to $500, and the bill fields are checked by the database', async () => {
    const { account } = await bill()
    const set = (fields: Record<string, unknown>) =>
      db.execute(
        sql`update billing_accounts set ${sql.join(
          Object.entries(fields).map(([column, value]) => sql`${sql.raw(column)} = ${value}`),
          sql`, `,
        )} where id = ${account.id}`,
      )
    for (const fields of [
      { recharge_threshold_cents: 499 },
      { recharge_threshold_cents: 10_001 },
      { recharge_amount_cents: 1999 },
      { recharge_amount_cents: 50_001 },
      { recharge_amount_cents: 2000, recharge_threshold_cents: 1600 },
      { recharge_cap_base_cents: -1 },
      { status: 'paused' },
      { kind: 'agency' },
      { interval: 'week' },
    ])
      expect((await failure(() => set(fields))).code, JSON.stringify(fields)).toBe('23514')
    // The amount is at least $5 above the threshold, so one recharge lifts the balance clear of it.
    await set({ recharge_amount_cents: 2000, recharge_threshold_cents: 1500 })
    await set({ recharge_amount_cents: 50_000, recharge_threshold_cents: 10_000 })
    expect((await failure(() => set({ recharge_amount_cents: 10_499 }))).code).toBe('23514')
    await set({ recharge_amount_cents: 10_500 })
  })
})

describe('recharges', () => {
  const recharge = (billId: string, fields: Partial<typeof billing_recharges.$inferInsert> = {}) =>
    db
      .insert(billing_recharges)
      .values({ id: rid('rc'), billing_account_id: billId, amount_cents: 2000, ...fields })
      .returning()

  test('at most one pending recharge per bill; paid and failed ones are kept beside it', async () => {
    const { account } = await bill()
    const [first] = await recharge(account.id)
    expect(first).toMatchObject({ status: 'pending', resolved_at: null })
    expect((await failure(() => recharge(account.id))).code).toBe('23505')
    await recharge((await bill()).account.id)
    await db
      .update(billing_recharges)
      .set({ status: 'failed', failure_code: 'card_declined', resolved_at: '2026-11-15T10:00:00Z' })
      .where(eq(billing_recharges.id, first!.id))
    const [second] = await recharge(account.id)
    await db
      .update(billing_recharges)
      .set({ status: 'paid', stripe_invoice_id: rid('in'), resolved_at: '2026-11-15T11:00:00Z' })
      .where(eq(billing_recharges.id, second!.id))
    await recharge(account.id)
    expect(
      await db.select().from(billing_recharges).where(eq(billing_recharges.billing_account_id, account.id)),
    ).toHaveLength(3)
  })

  test('status, amount and resolution are checked by the database', async () => {
    const { account } = await bill()
    for (const fields of [
      { status: 'refunded' as 'paid' },
      { amount_cents: 1999 },
      { amount_cents: 50_001 },
      { status: 'paid' as const },
      { resolved_at: '2026-11-15T10:00:00Z' },
    ])
      expect((await failure(() => recharge(account.id, fields))).code, JSON.stringify(fields)).toBe('23514')
    const invoice = rid('in')
    await recharge(account.id, { status: 'paid', stripe_invoice_id: invoice, resolved_at: '2026-11-15T10:00:00Z' })
    expect(
      (
        await failure(() =>
          recharge(account.id, { status: 'paid', stripe_invoice_id: invoice, resolved_at: '2026-11-15T10:00:00Z' }),
        )
      ).code,
    ).toBe('23505')
  })

  test('the alert kinds include the yearly renewal reminder, sent once per period', async () => {
    const { account, period } = await bill()
    const alert = (kind: string) =>
      db.execute(
        sql`insert into billing_alerts (billing_account_id, kind, ref) values (${account.id}, ${kind}, ${period.id})`,
      )
    await alert('renewal_reminder')
    expect((await failure(() => alert('renewal_reminder'))).code).toBe('23505')
    expect((await failure(() => alert('renewal_soon'))).code).toBe('23514')
    expect(
      await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, account.id)),
    ).toHaveLength(1)
  })
})

describe('ledger guards', () => {
  test('the API finds every guard, and notices one that is disabled', async () => {
    expect(await missingLedgerGuards(db)).toEqual([])
    expect(await checkLedgerGuards(db)).toBe(true)
    expect(ledgerGuardsOk()).toBe(true)
    const error = console.error
    console.error = () => {}
    try {
      await db.execute(sql`alter table ledger_entries disable trigger ledger_entries_no_update_delete`)
      expect(await missingLedgerGuards(db)).toEqual(['ledger_entries.ledger_entries_no_update_delete'])
      expect(await checkLedgerGuards(db)).toBe(false)
      expect(ledgerGuardsOk()).toBe(false)
    } finally {
      await db.execute(sql`alter table ledger_entries enable trigger ledger_entries_no_update_delete`)
      console.error = error
    }
    expect(await checkLedgerGuards(db)).toBe(true)
    expect(LEDGER_GUARDS.map(g => `${g.table}.${g.trigger}`)).toEqual([
      'ledger_entries.ledger_entries_no_update_delete',
      'ledger_entries.ledger_entries_no_truncate',
      'ledger_entries.ledger_entries_balance',
      'call_reservations.call_reservations_reserved_sum',
      'call_reservations.call_reservations_no_truncate',
    ])
  })

  test('notices a guard whose function body was replaced, or that fires on less than it should', async () => {
    const error = console.error
    console.error = () => {}
    const [original] = (await db.execute(sql`select pg_get_functiondef('ledger_entries_append_only'::regproc) as def`))
      .rows as { def: string }[]
    try {
      // A body that lets everything through, with the trigger itself untouched.
      await db.execute(sql`create or replace function ledger_entries_append_only() returns trigger as $$
        begin return old; end $$ language plpgsql`)
      expect(await missingLedgerGuards(db)).toEqual([
        'ledger_entries.ledger_entries_no_update_delete',
        'ledger_entries.ledger_entries_no_truncate',
      ])
      expect(await checkLedgerGuards(db)).toBe(false)
    } finally {
      await db.execute(sql.raw(original!.def))
    }
    try {
      // The same name and function, but no longer firing on DELETE.
      await db.execute(sql`drop trigger ledger_entries_no_update_delete on ledger_entries`)
      await db.execute(sql`create trigger ledger_entries_no_update_delete before update on ledger_entries
        for each row execute function ledger_entries_append_only()`)
      expect(await missingLedgerGuards(db)).toEqual(['ledger_entries.ledger_entries_no_update_delete'])
    } finally {
      await db.execute(sql`drop trigger ledger_entries_no_update_delete on ledger_entries`)
      await db.execute(sql`create trigger ledger_entries_no_update_delete before update or delete on ledger_entries
        for each row execute function ledger_entries_append_only()`)
      console.error = error
    }
    expect(await missingLedgerGuards(db)).toEqual([])
    expect(await checkLedgerGuards(db)).toBe(true)
  })
})

describe('ledger guards: constraints and indexes', () => {
  test('notices a dropped constraint or index the money logic relies on, and a billing job stops then', async () => {
    expect(LEDGER_CONSTRAINTS.map(c => c.name)).toEqual(
      expect.arrayContaining(['ledger_entries_source', 'ledger_entries_sign', 'ledger_entries_number_per_period']),
    )
    expect(LEDGER_INDEXES.map(i => i.name)).toEqual(['billing_recharges_one_pending'])
    await requireLedgerGuards(db)
    const error = console.error
    console.error = () => {}
    const rolledBack = new Error('roll back')
    try {
      // In one transaction, rolled back: dropping a constraint and an index the way a careless push would.
      await db.transaction(async tx => {
        await tx.execute(sql`alter table ledger_entries drop constraint ledger_entries_sign`)
        await tx.execute(sql`drop index billing_recharges_one_pending`)
        expect(await missingLedgerGuards(tx)).toEqual([
          'ledger_entries.ledger_entries_sign',
          'billing_recharges.billing_recharges_one_pending',
        ])
        await expect(requireLedgerGuards(tx)).rejects.toThrow(/billing is off/)
        expect(ledgerGuardsOk()).toBe(false)
        throw rolledBack
      })
    } catch (e) {
      if (e !== rolledBack) throw e
    } finally {
      console.error = error
    }
    expect(await missingLedgerGuards(db)).toEqual([])
    await requireLedgerGuards(db)
    expect(ledgerGuardsOk()).toBe(true)
  })
})

describe('workspace.delete', () => {
  test("keeps the bill's ledger entries and counters of the deleted workspace", async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const { account, period } = await bill()
    await db
      .update(organization)
      .set({ billingAccountId: account.id, billingState: 'active' })
      .where(eq(organization.id, ws.id))
    const entry = await usage(account.id, period.id, ws.call.id, ws.id)
    await db.insert(usage_counters).values({
      billing_account_id: account.id,
      period_id: period.id,
      workspace_id: ws.id,
      included_seconds_used: 3000,
      usage_micros: 50_000,
    })
    await db
      .insert(call_reservations)
      .values({ call_id: ws.call.id, billing_account_id: account.id, reserved_micros: 250_000 })

    const operator = await signUp()
    const res = await asServerAdmin(operator, () =>
      act(operator, 'workspace.delete', { workspaceId: ws.id, name: 'Brightwater Plumbing & Heating' }),
    )
    expect(res.status).toBe(200)
    expect(await db.select().from(organization).where(eq(organization.id, ws.id))).toEqual([])
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.id, entry.id))).toEqual([entry])
    expect(await db.select().from(usage_counters).where(eq(usage_counters.workspace_id, ws.id))).toHaveLength(1)
    // The running call's reservation went with the call, and the balance row with it.
    expect((await balanceOf(account.id))?.reserved_micros).toBe(0)
  })
})
