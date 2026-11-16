// The hourly billing periods job (src/billing-periods.ts, docs/billing.md §4.5, §4.2, §3.3; PR 10): periods
// opened before they start and closed 3 hours after they end, monthly sub-periods of a yearly bill, the extra numbers'
// months paid from the balance only when it covers them (else a recharge first, else unpaid with the fixed line and
// one email, released after 30 days), and the yearly renewal reminder once per renewal. Billing is switched on by replacing billingState, the three stages through the environment, and Stripe is a
// fake provider: this file is instance-wide.
import type { BillingProvider, BillingSubscription } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_balances,
  billing_numbers,
  billing_periods,
  billing_recharges,
  commands,
  instance_settings,
  ledger_entries,
  organization,
  phone_numbers,
  usage_counters,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  addMonths,
  BILLING_LIFECYCLE_EMAIL,
  CLOSE_AFTER_MS,
  checkRelease,
  MIN_MONTH_MS,
  nextPeriodEnd,
  openNextPeriods,
  RENEWAL_REMINDER_DAYS_KEY,
  runBillingPeriods,
  sendLifecycleEmail,
} from '../src/billing-periods.ts'
import { db } from '../src/db.ts'
import type { EmailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { postEntry } from '../src/ledger.ts'
import { act, agent, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

const cloud = vi.hoisted(() => ({ on: true }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
  }
})

// Placeholder values, never sent anywhere: the three stages count as set up, so calls are Standard.
const ENV = {
  STT_PROVIDER: 'deepgram',
  DEEPGRAM_API_KEY: 'placeholder',
  LLM_PROVIDER: 'openai',
  OPENAI_API_KEY: 'placeholder',
  TTS_PROVIDER: 'elevenlabs',
  ELEVENLABS_API_KEY: 'placeholder',
}
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  cloud.on = true
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
    insert: async () => [],
  } as never)
})
afterEach(() => setJobQueue(null))
const emails = () =>
  queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL).map(j => j.data as { bill: string; email: { kind: string } })

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const HOUR = 3_600_000
const DAY = 24 * HOUR
const at = (ms: number) => new Date(ms).toISOString()

/** A fake Stripe: the subscriptions it knows. */
const stripe = { subscriptions: new Map<string, BillingSubscription>() }
const provider = {
  name: 'stripe',
  subscription: async (id: string) => stripe.subscriptions.get(id) ?? null,
} as unknown as BillingProvider

type Billed = { ws: Workspace; billId: string; periodId: string }

/** `ws` on a bill with one period around now (or as given), its number the one the workspace includes. */
async function billed(
  over: Partial<typeof billing_accounts.$inferInsert> = {},
  period: { starts: number; ends: number; kind?: 'trial' | 'month' } = {
    starts: Date.now() - 10 * DAY,
    ends: Date.now() + 10 * DAY,
  },
): Promise<Billed> {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const billId = rid('bill')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: ws.owner.userId,
    status: 'active',
    stripe_customer_id: rid('cus'),
    ...over,
  })
  const periodId = rid('bp')
  await db.insert(billing_periods).values({
    id: periodId,
    billing_account_id: billId,
    starts_at: at(period.starts),
    ends_at: at(period.ends),
    kind: period.kind ?? 'month',
  })
  await db
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'active' })
    .where(eq(organization.id, ws.id))
  // Bought through Linedesk on its carrier account: the workspace's included number.
  await db
    .update(phone_numbers)
    .set({ purchased: true, created_at: at(Date.now() - 30 * DAY) })
    .where(eq(phone_numbers.e164, ws.number))
  return { ws, billId, periodId }
}

/** A second number bought on Linedesk's carrier account: an extra number ($3 a month). */
async function extraNumber(ws: Workspace) {
  const [row] = await db
    .insert(phone_numbers)
    .values({ id: rid('pn'), workspace_id: ws.id, e164: randomNumber(), provider: 'dev', purchased: true })
    .returning()
  return row!
}

const credit = (billId: string, periodId: string, micros: number) =>
  db.transaction(tx =>
    postEntry(tx, {
      billing_account_id: billId,
      period_id: periodId,
      kind: 'credit',
      amount_micros: micros,
      source_type: 'admin',
      source_id: rid('adm'),
    }),
  )
const numberEntries = (numberId: string) =>
  db
    .select()
    .from(ledger_entries)
    .where(and(eq(ledger_entries.kind, 'number'), eq(ledger_entries.source_type, 'phone_number')))
    .then(rows => rows.filter(r => r.source_id.startsWith(`${numberId}:`)))
const stateOf = async (numberId: string) =>
  (await db.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, numberId)))[0]
const balanceOf = async (billId: string) =>
  (await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId)))[0]
const periodsOf = (billId: string) =>
  db
    .select()
    .from(billing_periods)
    .where(eq(billing_periods.billing_account_id, billId))
    .orderBy(billing_periods.starts_at)
const alertsOf = (billId: string, kind: string) =>
  db
    .select()
    .from(billing_alerts)
    .where(and(eq(billing_alerts.billing_account_id, billId), eq(billing_alerts.kind, kind as never)))
const run = (now = Date.now()) => runBillingPeriods(at(now), { provider })

describe('period math', () => {
  test('months from an anchor keep its day, clamped to short months, and its time', () => {
    const anchor = '2027-01-31T15:30:00.000Z'
    expect(addMonths(anchor, 1)).toBe('2027-02-28T15:30:00.000Z')
    expect(addMonths(anchor, 2)).toBe('2027-03-31T15:30:00.000Z')
    expect(addMonths(anchor, 13)).toBe('2028-02-29T15:30:00.000Z')
    expect(addMonths(anchor, -1)).toBe('2026-12-31T15:30:00.000Z')
  })

  test('the next period ends at the next anchored month boundary, or at the end of a yearly subscription', () => {
    const anchor = '2027-01-31T15:30:00.000Z'
    expect(nextPeriodEnd(anchor, '2027-02-28T15:30:00.000Z', null)).toBe('2027-03-31T15:30:00.000Z')
    // A trial that ended mid-month: the first month runs to the anchored boundary after it.
    expect(nextPeriodEnd(anchor, '2027-03-05T00:00:00.000Z', null)).toBe('2027-03-31T15:30:00.000Z')
    // The yearly subscription ends before the next boundary: its last sub-period ends with it.
    expect(nextPeriodEnd(anchor, '2027-12-31T15:30:00.000Z', '2028-01-15T00:00:00.000Z')).toBe(
      '2028-01-15T00:00:00.000Z',
    )
    // A subscription end in the past is ignored.
    expect(nextPeriodEnd(anchor, '2027-02-28T15:30:00.000Z', '2027-01-31T15:30:00.000Z')).toBe(
      '2027-03-31T15:30:00.000Z',
    )
  })

  test('a subscription end closer than a month after the start never makes a stub (re-review of #879, N4)', () => {
    // A yearly → monthly switch moved the anchor from the 10th to the 11th; Stripe's period ends on the 11th, a day after
    // the month that just ended. The next month runs to the anchored boundary a month on, not for one day.
    const moved = '2027-03-11T00:00:00.000Z'
    expect(nextPeriodEnd(moved, '2027-03-10T00:00:00.000Z', '2027-03-11T00:00:00.000Z', MIN_MONTH_MS)).toBe(
      '2027-04-11T00:00:00.000Z',
    )
    // A subscription end at least a month away still cuts the last sub-period of a year.
    expect(
      nextPeriodEnd('2027-01-31T15:30:00.000Z', '2027-12-31T15:30:00.000Z', '2028-01-30T00:00:00.000Z', MIN_MONTH_MS),
    ).toBe('2028-01-30T00:00:00.000Z')
  })
})

describe('periods', () => {
  test('the next period opens before the current ends, with counter rows; a second run opens nothing', async () => {
    const now = Date.now()
    // The current month, from the anchor: it ends in an hour.
    const anchor = addMonths(at(now + HOUR), -1)
    const b = await billed({ billing_anchor: anchor }, { starts: Date.parse(anchor), ends: now + HOUR })
    await run(now)
    const periods = await periodsOf(b.billId)
    expect(periods).toHaveLength(2)
    expect(periods[1]).toMatchObject({ starts_at: periods[0]!.ends_at, kind: 'month', closed_at: null })
    expect(Date.parse(periods[1]!.ends_at)).toBe(Date.parse(nextPeriodEnd(anchor, periods[0]!.ends_at, null)))
    const counters = await db
      .select()
      .from(usage_counters)
      .where(and(eq(usage_counters.billing_account_id, b.billId), eq(usage_counters.period_id, periods[1]!.id)))
    expect(counters.map(c => c.workspace_id)).toEqual([b.ws.id])
    await run(now)
    expect(await periodsOf(b.billId)).toHaveLength(2)
  })

  test('an anchor on the 31st: every month ends on its clamped anchor day, no stub periods, leap year included', async () => {
    // Stripe anchored on Jan 31: its current_period_start is clamped every short month (Feb 28, Apr 30, ...), as
    // invoice.paid stores it. The months must still come from the anchor itself (security review of #879, M1).
    const anchor = '2027-01-31T15:30:00.000Z'
    const b = await billed(
      { billing_anchor: anchor, current_period_start: anchor, current_period_end: addMonths(anchor, 1) },
      { starts: Date.parse(anchor), ends: Date.parse(addMonths(anchor, 1)) },
    )
    for (let k = 1; k <= 14; k++) {
      // Each month's invoice.paid stores Stripe's clamped period; the job runs an hour before the period ends.
      await db
        .update(billing_accounts)
        .set({ current_period_start: addMonths(anchor, k - 1), current_period_end: addMonths(anchor, k) })
        .where(eq(billing_accounts.id, b.billId))
      await db.transaction(tx => openNextPeriods(tx, b.billId, at(Date.parse(addMonths(anchor, k)) - HOUR)))
    }
    const periods = await periodsOf(b.billId)
    expect(periods.map(p => new Date(p.ends_at).toISOString())).toEqual(
      Array.from({ length: 15 }, (_, k) => addMonths(anchor, k + 1)),
    )
    expect(periods.slice(0, 3).map(p => new Date(p.ends_at).toISOString())).toEqual([
      '2027-02-28T15:30:00.000Z',
      '2027-03-31T15:30:00.000Z',
      '2027-04-30T15:30:00.000Z',
    ])
    // February of the leap year ends on the 29th, and March on the 31st again.
    expect(periods.map(p => new Date(p.ends_at).toISOString())).toContain('2028-02-29T15:30:00.000Z')
    expect(periods.map(p => new Date(p.ends_at).toISOString())).toContain('2028-03-31T15:30:00.000Z')
    for (const p of periods) expect(Date.parse(p.ends_at) - Date.parse(p.starts_at)).toBeGreaterThanOrEqual(28 * DAY)
  })

  test('an anchor that moved mid-month (a plan change) never leaves a stub month', async () => {
    const now = Date.now()
    // The current month runs to now + 1 h; the anchor moved to 3 days after that, so its next boundary would end the
    // next period after 3 days. That month runs to the boundary after it instead.
    const anchor = at(now + HOUR + 3 * DAY)
    const b = await billed({ billing_anchor: anchor }, { starts: now - 30 * DAY + HOUR, ends: now + HOUR })
    await db.transaction(tx => openNextPeriods(tx, b.billId, at(now)))
    const periods = await periodsOf(b.billId)
    expect(periods).toHaveLength(2)
    expect(Date.parse(periods[1]!.ends_at)).toBe(Date.parse(addMonths(anchor, 1)))
    expect(Date.parse(periods[1]!.ends_at) - Date.parse(periods[1]!.starts_at)).toBeGreaterThanOrEqual(27 * DAY)
  })

  test('after a trial the months count from the trial end, before invoice.paid stored the anchor (re-review of #879, N4)', async () => {
    const now = Date.now()
    // A 14-day trial ends in an hour; Stripe anchors the subscription on the trial end, and invoice.paid (which stores
    // billing_anchor) only comes after the next period is opened.
    const trialEnd = now + HOUR
    const b = await billed({ status: 'trialing' }, { starts: trialEnd - 14 * DAY, ends: trialEnd, kind: 'trial' })
    await db.transaction(tx => openNextPeriods(tx, b.billId, at(now)))
    const periods = await periodsOf(b.billId)
    expect(periods).toHaveLength(2)
    expect(new Date(periods[1]!.starts_at).toISOString()).toBe(at(trialEnd))
    expect(new Date(periods[1]!.ends_at).toISOString()).toBe(addMonths(at(trialEnd), 1))
  })

  test('a job that was down catches up period by period until one reaches past now', async () => {
    const now = Date.now()
    const b = await billed({}, { starts: now - 100 * DAY, ends: now - 70 * DAY })
    await run(now)
    const periods = await periodsOf(b.billId)
    expect(periods.length).toBeGreaterThanOrEqual(4)
    expect(Date.parse(periods.at(-1)!.ends_at)).toBeGreaterThan(now)
    for (let i = 1; i < periods.length; i++) expect(periods[i]!.starts_at).toBe(periods[i - 1]!.ends_at)
  })

  test('a canceled bill and a sign-up without Checkout get no new period', async () => {
    const now = Date.now()
    const canceled = await billed({ status: 'canceled' }, { starts: now - 30 * DAY, ends: now - DAY })
    const pending = await billed({ status: 'pending_payment' }, { starts: now - 30 * DAY, ends: now - DAY })
    await run(now)
    expect(await periodsOf(canceled.billId)).toHaveLength(1)
    expect(await periodsOf(pending.billId)).toHaveLength(1)
  })

  test('a period is closed 3 hours after its end, not before', async () => {
    const now = Date.now()
    const ended = await billed({ status: 'canceled' }, { starts: now - 30 * DAY, ends: now - CLOSE_AFTER_MS - 1000 })
    const recent = await billed({ status: 'canceled' }, { starts: now - 30 * DAY, ends: now - HOUR })
    await run(now)
    expect((await periodsOf(ended.billId))[0]!.closed_at).not.toBeNull()
    expect((await periodsOf(recent.billId))[0]!.closed_at).toBeNull()
  })

  test('billing not in effect: nothing runs', async () => {
    cloud.on = false
    const now = Date.now()
    const b = await billed({}, { starts: now - 30 * DAY, ends: now + HOUR })
    expect((await run(now)).billing).toBe('off')
    expect(await periodsOf(b.billId)).toHaveLength(1)
  })
})

describe('extra numbers', () => {
  test('the included number pays nothing; an extra one posts $3 once per period from a covering balance', async () => {
    const b = await billed()
    const extra = await extraNumber(b.ws)
    await credit(b.billId, b.periodId, 10_000_000)
    await run()
    const entries = await numberEntries(extra.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      amount_micros: -3_000_000,
      period_id: b.periodId,
      workspace_id: b.ws.id,
      source_id: `${extra.id}:${b.periodId}`,
    })
    await run()
    expect(await numberEntries(extra.id)).toHaveLength(1)
    expect((await balanceOf(b.billId))!.balance_micros).toBe(7_000_000)
    // The included number never posts.
    const [included] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, b.ws.number))
    expect(await numberEntries(included!.id)).toEqual([])
  })

  test('a balance that does not cover it: a recharge first, no entry, the number still answered; posted once paid', async () => {
    const b = await billed()
    const extra = await extraNumber(b.ws)
    expect((await run()).numbers[extra.id]).toBe('waiting')
    expect(await numberEntries(extra.id)).toEqual([])
    const [pending] = await db
      .select()
      .from(billing_recharges)
      .where(and(eq(billing_recharges.billing_account_id, b.billId), eq(billing_recharges.status, 'pending')))
    expect(pending).toMatchObject({ amount_cents: 2000 })
    expect(queued.some(j => j.name === 'billing.recharge' && j.data.rechargeId === pending!.id)).toBe(true)
    expect(await stateOf(extra.id)).toBeUndefined()
    // The recharge is paid (as invoice.paid does it): the next run posts the month.
    await db.transaction(async tx => {
      await tx
        .update(billing_recharges)
        .set({ status: 'paid', resolved_at: at(Date.now()) })
        .where(eq(billing_recharges.id, pending!.id))
      await postEntry(tx, {
        billing_account_id: b.billId,
        period_id: b.periodId,
        kind: 'recharge',
        amount_micros: 20_000_000,
        source_type: 'billing_recharge',
        source_id: pending!.id,
      })
    })
    expect((await run()).numbers[extra.id]).toBe('posted')
    expect(await numberEntries(extra.id)).toHaveLength(1)
    // Never below zero: the balance only ever paid what it had.
    expect((await balanceOf(b.billId))!.balance_micros).toBe(17_000_000)
  })

  test('no recharge possible (auto-recharge off): unpaid, one email, calls to it refused; paid by a top-up, answered again', async () => {
    const b = await billed({ auto_recharge: false })
    const extra = await extraNumber(b.ws)
    expect((await run()).numbers[extra.id]).toBe('unpaid')
    expect(await numberEntries(extra.id)).toEqual([])
    expect(await stateOf(extra.id)).toMatchObject({ billing_account_id: b.billId, unpaid_period_id: b.periodId })
    expect(emails().filter(e => e.email.kind === 'number_unpaid')).toHaveLength(1)
    expect(await alertsOf(b.billId, 'number_unpaid')).toHaveLength(1)
    // Another run: still unpaid, no second email.
    queued = []
    await run()
    expect(emails()).toEqual([])
    // A call to it gets the fixed line, filed as missed with the reason; the included number is answered.
    const refused = (await act(agent(), 'call.start', { from: randomNumber(), to: extra.e164 })).body.data
    expect(refused).toMatchObject({ blocked: true, refused: 'number_unpaid' })
    // Bought minutes: the next run posts the month and the number answers again.
    await credit(b.billId, b.periodId, 5_000_000)
    expect((await run()).numbers[extra.id]).toBe('posted')
    expect((await stateOf(extra.id))?.unpaid_since).toBeNull()
    const answered = (await act(agent(), 'call.start', { from: randomNumber(), to: extra.e164 })).body.data
    expect(answered).toMatchObject({ blocked: false, refused: null })
  })

  test('an unpaid month is paid before the next one, and the number stays unpaid until both are', async () => {
    const now = Date.now()
    const b = await billed({ auto_recharge: false }, { starts: now - 40 * DAY, ends: now - 10 * DAY })
    const extra = await extraNumber(b.ws)
    await runBillingPeriods(at(now - 20 * DAY), { provider })
    expect(await stateOf(extra.id)).toMatchObject({ unpaid_period_id: b.periodId })
    // A month later, $4 bought: enough for the old month, not for both.
    await credit(b.billId, b.periodId, 4_000_000)
    await run(now)
    const entries = await numberEntries(extra.id)
    expect(entries.map(e => e.period_id)).toEqual([b.periodId])
    expect(await stateOf(extra.id)).toMatchObject({ unpaid_period_id: b.periodId })
    await credit(b.billId, b.periodId, 5_000_000)
    await run(now)
    expect(await numberEntries(extra.id)).toHaveLength(2)
    expect((await stateOf(extra.id))?.unpaid_since).toBeNull()
  })

  test('unpaid for 30 days: released through phoneNumber.release as the billing system', async () => {
    const now = Date.now()
    const b = await billed({ auto_recharge: false }, { starts: now - 40 * DAY, ends: now + 10 * DAY })
    const extra = await extraNumber(b.ws)
    await run(now - 31 * DAY)
    expect((await run(now - 29 * DAY)).released).toEqual([])
    const result = await run(now)
    expect(result.released).toEqual([extra.id])
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.id, extra.id))).toEqual([])
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'phoneNumber.release'), eq(commands.workspace_id, b.ws.id)))
    expect(logged).toMatchObject({ actor_id: 'billing:system', rejected: false })
  })

  /** `b`'s extra number, unpaid since 31 days (made by a run then), the bill as `over` says at release time. */
  const unpaidFor31Days = async (over: Partial<typeof billing_accounts.$inferInsert> = {}) => {
    const now = Date.now()
    const b = await billed({ auto_recharge: false }, { starts: now - 40 * DAY, ends: now + 10 * DAY })
    const extra = await extraNumber(b.ws)
    await db.insert(billing_numbers).values({
      phone_number_id: extra.id,
      billing_account_id: b.billId,
      unpaid_since: at(now - 31 * DAY),
      unpaid_period_id: b.periodId,
    })
    if (Object.keys(over).length) await db.update(billing_accounts).set(over).where(eq(billing_accounts.id, b.billId))
    return { ...b, extra, now }
  }
  const stillThere = async (numberId: string) =>
    (await db.select().from(phone_numbers).where(eq(phone_numbers.id, numberId))).length === 1

  test('the release checks again: the number became the included one (the first was released): kept, cleared', async () => {
    const u = await unpaidFor31Days({ status: 'suspended', suspend_reason: 'payment' })
    // The owner released the included number while the bill was suspended: the unpaid one is now the included one.
    await db.delete(phone_numbers).where(eq(phone_numbers.e164, u.ws.number))
    expect((await run(u.now)).released).not.toContain(u.extra.id)
    expect(await stillThere(u.extra.id)).toBe(true)
    expect((await stateOf(u.extra.id))?.unpaid_since).toBeNull()
  })

  test('the release checks again: a comped bill clears the state, a dispute, fraud warning or admin suspension holds it', async () => {
    const comped = await unpaidFor31Days({ status: 'comped' })
    const disputed = await unpaidFor31Days({ status: 'suspended', suspend_reason: 'dispute' })
    const warned = await unpaidFor31Days({ status: 'suspended', suspend_reason: 'early_fraud_warning' })
    const byAdmin = await unpaidFor31Days({ status: 'suspended', suspend_reason: 'admin' })
    const result = await run(comped.now)
    for (const u of [comped, disputed, warned, byAdmin]) {
      expect(result.released).not.toContain(u.extra.id)
      expect(await stillThere(u.extra.id)).toBe(true)
    }
    expect((await stateOf(comped.extra.id))?.unpaid_since).toBeNull()
    expect((await stateOf(disputed.extra.id))?.unpaid_since).not.toBeNull()
    expect((await stateOf(warned.extra.id))?.unpaid_since).not.toBeNull()
    expect((await stateOf(byAdmin.extra.id))?.unpaid_since).not.toBeNull()
  })

  test('the release checks again: a month paid in the meantime is posted and the number kept', async () => {
    const u = await unpaidFor31Days()
    await credit(u.billId, u.periodId, 10_000_000)
    expect(await db.transaction(tx => checkRelease(tx, u.extra.id, at(u.now)))).toBe('cleared')
    expect(await numberEntries(u.extra.id)).toHaveLength(1)
    expect((await stateOf(u.extra.id))?.unpaid_since).toBeNull()
    // A bill suspended for a missed payment does release (its months are not paid while suspended).
    const late = await unpaidFor31Days({ status: 'suspended', suspend_reason: 'payment' })
    expect(await db.transaction(tx => checkRelease(tx, late.extra.id, at(late.now)))).toBe('release')
  })

  test('one number that cannot be released does not stop the others; the failure is reported', async () => {
    const broken = await unpaidFor31Days()
    const fine = await unpaidFor31Days()
    // At a carrier other than the one in use (tests run on `dev`): phoneNumber.release refuses it.
    await db
      .update(phone_numbers)
      .set({ provider: 'telnyx', provider_ref: 'ref-1' })
      .where(eq(phone_numbers.id, broken.extra.id))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await run(fine.now)
    error.mockRestore()
    expect(result.released).toContain(fine.extra.id)
    expect(result.released).not.toContain(broken.extra.id)
    expect(result.failed.some(f => f.startsWith(`release of ${broken.extra.id}`))).toBe(true)
    expect(await stillThere(fine.extra.id)).toBe(false)
  })

  test('a workspace moved to another bill: its unpaid number row follows it, and the new bill owes the month', async () => {
    const now = Date.now()
    const a = await billed({ auto_recharge: false })
    const extra = await extraNumber(a.ws)
    expect((await run(now)).numbers[extra.id]).toBe('unpaid')
    expect(await stateOf(extra.id)).toMatchObject({ billing_account_id: a.billId })
    // Bill B (no balance, auto-recharge off), with a period around now; the workspace moves there.
    const other = await billed({ auto_recharge: false })
    await db.update(organization).set({ billingAccountId: other.billId }).where(eq(organization.id, a.ws.id))
    await run(now)
    expect(await stateOf(extra.id)).toMatchObject({
      billing_account_id: other.billId,
      unpaid_period_id: other.periodId,
    })
    // Bill A's owner no longer has it; bill B pays it once it has the balance.
    expect(await db.select().from(billing_numbers).where(eq(billing_numbers.billing_account_id, a.billId))).toEqual([])
    await credit(other.billId, other.periodId, 10_000_000)
    expect((await run(now)).numbers[extra.id]).toBe('posted')
    expect((await numberEntries(extra.id)).map(e => e.billing_account_id)).toEqual([other.billId])
  })

  test('a number row that moves to another bill loses its port-out PIN (re-review of #879, N2)', async () => {
    const now = Date.now()
    const a = await billed({ auto_recharge: false })
    const extra = await extraNumber(a.ws)
    await run(now)
    // The PIN bill A's owner was shown (stored encrypted; any value stands in for it here).
    await db
      .update(billing_numbers)
      .set({ port_out_code: 'pin-of-bill-a' })
      .where(eq(billing_numbers.phone_number_id, extra.id))
    const other = await billed({ auto_recharge: false })
    await db.update(organization).set({ billingAccountId: other.billId }).where(eq(organization.id, a.ws.id))
    await run(now)
    // On bill B it has no PIN: the next view issues a new one, so bill A's PIN cannot port the number out.
    expect(await stateOf(extra.id)).toMatchObject({ billing_account_id: other.billId, port_out_code: null })
  })

  test('a suspended or comped bill posts no number months', async () => {
    for (const status of ['suspended', 'comped'] as const) {
      const b = await billed({ status, suspend_reason: status === 'suspended' ? 'payment' : null })
      const extra = await extraNumber(b.ws)
      await credit(b.billId, b.periodId, 10_000_000)
      await run()
      expect(await numberEntries(extra.id)).toEqual([])
    }
  })
})

describe('the yearly renewal reminder', () => {
  const yearly = async (renewsInDays: number, sub: Partial<BillingSubscription> = {}) => {
    const subscriptionId = rid('sub')
    const end = at(Date.now() + renewsInDays * DAY)
    const b = await billed({
      interval: 'year',
      stripe_subscription_id: subscriptionId,
      current_period_start: at(Date.now() - (365 - renewsInDays) * DAY),
      current_period_end: end,
    })
    const [bill] = await db.select().from(billing_accounts).where(eq(billing_accounts.id, b.billId))
    stripe.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      customerId: bill!.stripe_customer_id!,
      status: 'active',
      currentPeriodStart: bill!.current_period_start,
      currentPeriodEnd: end,
      billingCycleAnchor: bill!.current_period_start,
      interval: 'year',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      defaultPaymentMethod: 'pm_1',
      items: [{ lookupKey: 'ws_yearly', quantity: 2, unitAmountCents: 10_800 }],
      ...sub,
    })
    return b
  }

  test('once per renewal, with the price and auto-recharge, 30 days before by default', async () => {
    const b = await yearly(20)
    await run()
    const sent = emails().filter(e => e.bill === b.billId)
    expect(sent).toEqual([
      {
        bill: b.billId,
        email: {
          kind: 'renewal_reminder',
          renewsAt: expect.any(String),
          lines: [{ item: 'seats', quantity: 2, unitCents: 10_800 }],
          autoRecharge: { thresholdCents: 500, amountCents: 2000 },
        },
      },
    ])
    expect(await alertsOf(b.billId, 'renewal_reminder')).toHaveLength(1)
    queued = []
    await run()
    expect(emails().filter(e => e.bill === b.billId)).toEqual([])
  })

  test('not when the renewal is further than the setting, nor when the plan is set to cancel', async () => {
    const far = await yearly(40)
    const canceling = await yearly(10, { cancelAtPeriodEnd: true })
    await run()
    expect(emails().filter(e => e.bill === far.billId || e.bill === canceling.billId)).toEqual([])
  })

  test('the setting moves the window within 15 to 45 days; out of range is the default', async () => {
    const b = await yearly(40)
    await db.insert(instance_settings).values({ key: RENEWAL_REMINDER_DAYS_KEY, value: '45' })
    try {
      await run()
      expect(emails().filter(e => e.bill === b.billId)).toHaveLength(1)
      const other = await yearly(40)
      await db
        .update(instance_settings)
        .set({ value: '90' })
        .where(eq(instance_settings.key, RENEWAL_REMINDER_DAYS_KEY))
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await run()
      error.mockRestore()
      expect(emails().filter(e => e.bill === other.billId)).toEqual([])
    } finally {
      await db.delete(instance_settings).where(eq(instance_settings.key, RENEWAL_REMINDER_DAYS_KEY))
    }
  })

  test('the email names the date, each line and how to cancel', async () => {
    const b = await billed()
    const sent: { to: string; subject: string; text: string }[] = []
    const sender = { kind: 'smtp', send: async (e: never) => void sent.push(e) } as unknown as EmailSender
    await sendLifecycleEmail(sender, {
      bill: b.billId,
      email: {
        kind: 'renewal_reminder',
        renewsAt: '2027-03-01T00:00:00.000Z',
        lines: [
          { item: 'seats', quantity: 2, unitCents: 10_800 },
          { item: 'partner', quantity: 1, unitCents: 16_800 },
        ],
        autoRecharge: null,
      },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('March 1, 2027')
    expect(sent[0]!.text).toContain('$384.00')
    expect(sent[0]!.text).toContain('2 × $108.00 a year = $216.00')
    expect(sent[0]!.text).toContain('Auto-recharge is off')
    expect(sent[0]!.text).toContain('workspace/billing')
  })
})
