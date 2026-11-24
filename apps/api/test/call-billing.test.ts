// Billing on the call path (src/call-billing.ts): the gate in call.start with its
// reservation and refusals, posting at call.finish and in the stale sweep (which ends calls past their limit), the
// transfer leg capped on a billed call, the recharge and alert jobs queued in the same transaction, and an install
// or workspace without billing behaving exactly as before. Billing is switched on by replacing billingState (no
// Stripe keys in tests); the three stages are set up through the environment, so this file is instance-wide.
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
  instance_settings,
  partner_providers,
  partners,
  usage_counters,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { sendBillingAlert } from '../src/billing-recharge.ts'
import { DEFAULT_TIME_ZONE } from '../src/bookings.ts'
import { todayIn } from '../src/public-holidays.ts'
import { BILLING_UNUSABLE_KEY, gateCall, postFinishedCall, trialMinutesAlert } from '../src/call-billing.ts'
import { db } from '../src/db.ts'
import type { EmailSender } from '../src/email.ts'
import { runLedgerCheck, runStuckRechargeCheck, setJobQueue } from '../src/jobs.ts'
import { ledgerDifferences, postEntry } from '../src/ledger.ts'
import { finishStaleCalls } from '../src/stale-calls.ts'
import {
  act,
  agent,
  createWorkspace,
  getCall,
  randomNumber,
  saveTransferContacts,
  signUp,
  type Workspace,
} from './helpers.ts'

const cloud = vi.hoisted(() => ({ on: true, unusable: false, reserveThrows: false }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    // `unusable`: switched on, but the ledger guards are missing (billing not in effect).
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      !cloud.on
        ? real.billingState(...args)
        : cloud.unusable
          ? { ...(await real.billingState(...args)), on: true, inEffect: 'none' as const, guardsOk: false }
          : { ...(await real.billingState(...args)), inEffect: 'stripe' as const },
  }
})
vi.mock('../src/ledger.ts', async original => {
  const real = await original<typeof import('../src/ledger.ts')>()
  return {
    ...real,
    reserveCall: async (...args: Parameters<typeof real.reserveCall>) => {
      if (cloud.reserveThrows) throw new Error('a broken reservation')
      return real.reserveCall(...args)
    },
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

/** The jobs queued in a transaction (a fake queue: nothing runs). */
let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  cloud.on = true
  cloud.unusable = false
  cloud.reserveThrows = false
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
    insert: async () => [],
  } as never)
})
afterEach(() => setJobQueue(null))
const jobs = (name: string) => queued.filter(j => j.name === name).map(j => j.data)

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const DAY = 86_400_000

type Billed = { ws: Workspace; billId: string; periodId: string }

/** `ws` on a bill in service with a period around now, credited `creditMicros`, its allowance used up when asked. */
async function billed(
  status: 'active' | 'trialing' | 'comped',
  {
    creditMicros = 0,
    allowanceUsed = false,
    autoRecharge = true,
    ws,
    periodKind = 'month',
    usedSeconds,
  }: {
    creditMicros?: number
    allowanceUsed?: boolean
    autoRecharge?: boolean
    ws?: Workspace
    /** The period around now: a month, or the trial's. */
    periodKind?: 'month' | 'trial'
    /** As if earlier calls used this many included seconds (`allowanceUsed`: all 3000). */
    usedSeconds?: number
  } = {},
): Promise<Billed> {
  const workspace = ws ?? (await createWorkspace('Brightwater Plumbing & Heating'))
  const billId = rid('bill')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: workspace.owner.userId,
    status,
    auto_recharge: autoRecharge,
    stripe_customer_id: rid('cus'),
  })
  const periodId = rid('bp')
  await db.insert(billing_periods).values({
    id: periodId,
    billing_account_id: billId,
    starts_at: new Date(Date.now() - 10 * DAY).toISOString(),
    ends_at: new Date(Date.now() + 10 * DAY).toISOString(),
    kind: periodKind,
  })
  await db
    .update(organization)
    .set({ billingAccountId: billId, billingState: 'active' })
    .where(eq(organization.id, workspace.id))
  if (creditMicros) await credit(billId, periodId, creditMicros)
  // As if earlier calls used it: their entry and the counter, so the nightly check adds up.
  const used = allowanceUsed ? 3000 : usedSeconds
  if (used)
    await db.transaction(async tx => {
      await postEntry(tx, {
        billing_account_id: billId,
        workspace_id: workspace.id,
        period_id: periodId,
        kind: 'usage',
        amount_micros: 0,
        seconds: used,
        included_seconds: used,
        billable_seconds: 0,
        price_basis: 'standard',
        source_type: 'call',
        source_id: workspace.call.id,
      })
      await tx.insert(usage_counters).values({
        billing_account_id: billId,
        period_id: periodId,
        workspace_id: workspace.id,
        included_seconds_used: used,
      })
    })
  return { ws: workspace, billId, periodId }
}
const credit = (billId: string, periodId: string, micros: number) =>
  db.transaction(tx =>
    postEntry(tx, {
      billing_account_id: billId,
      period_id: periodId,
      kind: micros >= 0 ? 'credit' : 'adjustment',
      amount_micros: micros,
      source_type: 'admin',
      source_id: rid('adm'),
    }),
  )

const start = async (ws: Pick<Workspace, 'number'>) =>
  (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
const finish = (ws: Pick<Workspace, 'id'>, callId: string) =>
  act(agent(ws.id), 'call.finish', { callId, summary: 'Asked about a leak', outcome: 'message' })
const reservationOf = async (callId: string) =>
  (await db.select().from(call_reservations).where(eq(call_reservations.call_id, callId)))[0]
const balanceOf = async (billId: string) =>
  (await db.select().from(billing_balances).where(eq(billing_balances.billing_account_id, billId)))[0]
const usageOf = (callId: string) =>
  db
    .select()
    .from(ledger_entries)
    .where(and(eq(ledger_entries.source_type, 'call'), eq(ledger_entries.source_id, callId)))
/** The call started `seconds` ago (its reservation and limit stay as the gate made them). */
const startedAgo = (callId: string, seconds: number) =>
  db
    .update(calls)
    .set({ started_at: new Date(Date.now() - seconds * 1000).toISOString() })
    .where(eq(calls.id, callId))
const mine = async (billId: string) =>
  (await db.transaction(tx => ledgerDifferences(tx))).filter(d => d.bill === billId)
const noRooms = { listRooms: async () => new Map<string, number>(), endRoom: async () => true }

describe('without billing nothing changes', () => {
  test('billing off: a workspace on a bill with no balance is answered as before, and nothing is reserved or posted', async () => {
    cloud.on = false
    const b = await billed('active', { allowanceUsed: true })
    const started = await start(b.ws)
    expect(started).toMatchObject({ blocked: false, busy: false, overCap: false, refused: null, usageLevel: null })
    expect(await reservationOf(started.callId)).toBeUndefined()
    expect((await finish(b.ws, started.callId)).status).toBe(200)
    expect(await usageOf(started.callId)).toEqual([])
    expect(await balanceOf(b.billId)).toMatchObject({ balance_micros: 0, reserved_micros: 0 })
    expect(queued.filter(j => j.name.startsWith('billing.'))).toEqual([])
  })

  test('billing on, a workspace on no bill (self-hosted, unbilled): answered as before, its transfer leg uncapped', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const started = await start(ws)
    expect(started).toMatchObject({ blocked: false, refused: null, usageLevel: 'standard' })
    expect(await reservationOf(started.callId)).toBeUndefined()
    await saveTransferContacts(ws.assistant.id, ['+15035550199'])
    const dialled = await act(agent(ws.id), 'call.transfer', {
      callId: started.callId,
      to: '+15035550199',
      result: 'dialing',
    })
    expect(dialled.body.data.maxMinutes).toBe(30)
    expect((await finish(ws, started.callId)).status).toBe(200)
    expect(await usageOf(started.callId)).toEqual([])
  })

  test('a test call is never gated or billed (decision 5)', async () => {
    const b = await billed('active', { allowanceUsed: true })
    const started = (await act(agent(b.ws.id), 'call.startTest', { assistantId: b.ws.assistant.id, room: rid('room') }))
      .body.data
    expect(started.blocked).toBe(false)
    expect(await reservationOf(started.callId)).toBeUndefined()
  })
})

describe('the gate in call.start', () => {
  test('a call inside the allowance is reserved for its limit; with a transfer contact the limit adds the capped transfer', async () => {
    const b = await billed('active')
    const first = await start(b.ws)
    expect(first).toMatchObject({ blocked: false, refused: null })
    expect(await reservationOf(first.callId)).toMatchObject({
      billing_account_id: b.billId,
      usage_level: 'standard',
      own_keys: false,
      limit_seconds: 1200,
      included_reserved_seconds: 1200,
      reserved_micros: 0,
    })
    await saveTransferContacts(b.ws.assistant.id, ['+15035550199'])
    const second = await start(b.ws)
    // 20 minutes plus 10 bridged and the 10-minute leg; 1800 Standard seconds of the allowance were left.
    expect(await reservationOf(second.callId)).toMatchObject({
      limit_seconds: 2400,
      included_reserved_seconds: 1800,
      reserved_micros: 500_000,
    })
  })

  test('no balance after the allowance: refused with the reason, filed as missed with a callback, pushed', async () => {
    // In the trial, past its grace (10 Standard minutes below zero): the refused-call answer as before.
    const b = await billed('trialing', { allowanceUsed: true, creditMicros: -500_000 })
    const started = await start(b.ws)
    expect(started).toMatchObject({ blocked: true, refused: 'no_balance', overCap: false, busy: false })
    expect(await reservationOf(started.callId)).toBeUndefined()
    expect(await getCall(started.callId)).toMatchObject({
      status: 'completed',
      duration_sec: 0,
      outcome: 'hangup',
      title: 'Missed call',
      summary: 'Nobody answered this call: the prepaid balance is used up. Call the caller back.',
      action_items: [{ text: 'Call back' }],
    })
    expect(jobs('call.push')).toContainEqual({ callId: started.callId, kind: 'finished' })
  })

  test('a bill that is not in service refuses as billing_inactive; one with balance after the allowance allows', async () => {
    const suspended = await billed('active')
    await db
      .update(billing_accounts)
      .set({ status: 'suspended', suspend_reason: 'payment' })
      .where(eq(billing_accounts.id, suspended.billId))
    expect(await start(suspended.ws)).toMatchObject({ blocked: true, refused: 'billing_inactive' })
    const paying = await billed('active', { allowanceUsed: true, creditMicros: 2_000_000 })
    const started = await start(paying.ws)
    expect(started).toMatchObject({ blocked: false, refused: null })
    expect(await reservationOf(started.callId)).toMatchObject({
      reserved_micros: 1_000_000,
      included_reserved_seconds: 0,
    })
  })

  test('any throw from the reservation is a refusal, never an allowed call, and leaves nothing behind', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    cloud.reserveThrows = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = await start(b.ws)
    error.mockRestore()
    expect(started).toMatchObject({ blocked: true, refused: 'billing_error' })
    expect(await getCall(started.callId)).toMatchObject({ status: 'completed', outcome: 'hangup' })
    expect(await reservationOf(started.callId)).toBeUndefined()
  })

  test('a reservation that fails inside the savepoint (the call is not the workspace’s) refuses and keeps the transaction', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    const other = await createWorkspace('Another business')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await db.transaction(async tx => {
      const refused = await gateCall(tx, {
        callId: other.call.id,
        billId: b.billId,
        workspaceId: b.ws.id,
        assistant: null,
        level: 'standard',
        paidLevel: 'standard',
        now: new Date().toISOString(),
      })
      // The outer transaction still works after the savepoint rolled back.
      await tx.select().from(calls).where(eq(calls.id, other.call.id))
      return refused
    })
    error.mockRestore()
    expect(answer).toEqual({ allow: false, reason: 'billing_error' })
    expect(await reservationOf(other.call.id)).toBeUndefined()
  })

  test('the trial allows 5 calls at once per workspace (LIN-450); the sixth caller hears the busy line', async () => {
    // Money for the calls beyond the included allowance (each reserves its whole 20 minutes).
    const b = await billed('trialing', { creditMicros: 10_000_000 })
    // A new workspace has one live (sample) call already: four more fill its 5 lines.
    for (let i = 0; i < 4; i++) expect((await start(b.ws)).blocked, `call ${i + 2}`).toBe(false)
    expect(await start(b.ws)).toMatchObject({ blocked: true, busy: true })
  })

  test('a trial bill takes at most 5 calls at once over all its workspaces (review of #1103, L-4)', async () => {
    const b = await billed('trialing', { creditMicros: 10_000_000 })
    const second = await createWorkspace('Second')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    // 3 + 2: no workspace reaches its own 5 lines, the bill reaches the trial's 5.
    for (const ws of [b.ws, b.ws, b.ws, second, second]) expect((await start(ws)).blocked).toBe(false)
    expect(await start(second)).toMatchObject({ blocked: true, refused: 'too_many_calls' })
  })

  test("the bill's cap counts every workspace on it: an instance admin's cap of 2 refuses the third as too_many_calls", async () => {
    // Comped: only the cap decides.
    const b = await billed('comped')
    const [second, third] = [await createWorkspace('Second'), await createWorkspace('Third')]
    for (const ws of [second, third])
      await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, ws.id))
    await db.update(billing_accounts).set({ concurrent_calls_cap: 2 }).where(eq(billing_accounts.id, b.billId))
    // One call per workspace, so no single workspace reaches its own lines; the bill's cap refuses the third.
    expect((await start(b.ws)).blocked).toBe(false)
    expect((await start(second)).blocked).toBe(false)
    expect(await start(third)).toMatchObject({ blocked: true, refused: 'too_many_calls' })
  })

  test('parallel call.starts never take the balance below the buffer and never pass the cap', async () => {
    // Three workspaces on the bill: a cap of 15 calls at once. The balance is −$1.50; each call reserves $1 for 20
    // Standard minutes, so 3 fit above −$5 and the other 2 are refused.
    const b = await billed('active', { allowanceUsed: true })
    await credit(b.billId, b.periodId, -1_500_000)
    for (const name of ['Second', 'Third']) {
      const ws = await createWorkspace(name)
      await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, ws.id))
    }
    const answers = await Promise.all(Array.from({ length: 5 }, () => start(b.ws)))
    expect(answers.filter(a => !a.blocked)).toHaveLength(3)
    expect(answers.filter(a => a.refused === 'no_balance')).toHaveLength(2)
    const balance = (await balanceOf(b.billId))!
    expect(balance.balance_micros - balance.reserved_micros).toBe(-4_500_000)
    expect(await mine(b.billId)).toEqual([])
  })

  test('a low balance at the gate decides a recharge and queues its charge in the same transaction', async () => {
    const b = await billed('active', { creditMicros: 3_000_000 })
    await start(b.ws)
    const [attempt] = await db
      .select()
      .from(billing_recharges)
      .where(eq(billing_recharges.billing_account_id, b.billId))
    expect(attempt).toMatchObject({ status: 'pending', amount_cents: 2500 })
    expect(jobs('billing.recharge')).toEqual([{ rechargeId: attempt!.id }])
  })
})

describe('billing switched on but not working, and calls the API refuses itself', () => {
  test('billing on but unusable: a workspace on a bill is refused (billing_error), the admins emailed once per streak', async () => {
    cloud.unusable = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b = await billed('active', { creditMicros: 10_000_000 })
      const first = await start(b.ws)
      expect(first).toMatchObject({ blocked: true, refused: 'billing_error' })
      expect(await reservationOf(first.callId)).toBeUndefined()
      expect(await getCall(first.callId)).toMatchObject({ status: 'completed', title: 'Missed call' })
      await start(b.ws)
      expect(jobs('billing.alert')).toEqual([{ kind: 'billing_unusable', reason: 'guards' }])
      // A workspace on no bill is answered as before.
      const unbilled = await createWorkspace('Brightwater Plumbing & Heating')
      expect(await start(unbilled)).toMatchObject({ blocked: false, refused: null })
      // Working again: the streak ends, so the next one emails again.
      cloud.unusable = false
      expect(await start(b.ws)).toMatchObject({ blocked: false, refused: null })
      expect(await db.select().from(instance_settings).where(eq(instance_settings.key, BILLING_UNUSABLE_KEY))).toEqual(
        [],
      )
      cloud.unusable = true
      await start(b.ws)
      expect(jobs('billing.alert')).toHaveLength(2)
    } finally {
      error.mockRestore()
      await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_UNUSABLE_KEY))
    }
  })

  test('a voice or model the plan does not allow: the API refuses the call itself on a billed workspace (review L2)', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    // Without the three stages set up there is no Standard setup: the call's level is `not_allowed`.
    const keys = Object.keys(ENV).map(k => [k, process.env[k]] as const)
    for (const [k] of keys) delete process.env[k]
    try {
      const started = await start(b.ws)
      expect(started).toMatchObject({ blocked: true, refused: 'level_not_allowed', usageLevel: 'not_allowed' })
      expect(await reservationOf(started.callId)).toBeUndefined()
    } finally {
      for (const [k, v] of keys) process.env[k] = v
    }
  })

  test('a second call.start for the room of a live call answers that call again, never a second billed one (review L4)', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const room = rid('room')
    const from = randomNumber()
    const [first, second] = await Promise.all(
      [0, 1].map(async () => (await act(agent(), 'call.start', { from, to: b.ws.number, room })).body.data),
    )
    expect(second.callId).toBe(first.callId)
    expect(second).toMatchObject({ blocked: false, refused: null, busy: false })
    expect(await db.select().from(calls).where(eq(calls.room, room))).toHaveLength(1)
    expect((await balanceOf(b.billId))!.reserved_micros).toBe(1_000_000)
  })
})

describe('posting at the finish and in the stale sweep', () => {
  test('call.finish posts the usage once; a repeated finish posts nothing more', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 120)
    await finish(b.ws, callId)
    const [entry] = await usageOf(callId)
    expect(entry).toMatchObject({
      kind: 'usage',
      price_basis: 'standard',
      billable_seconds: 120,
      amount_micros: -100_000,
    })
    expect(await reservationOf(callId)).toBeUndefined()
    await finish(b.ws, callId)
    expect(await usageOf(callId)).toHaveLength(1)
    expect((await balanceOf(b.billId))!.balance_micros).toBe(9_900_000)
    expect(await mine(b.billId)).toEqual([])
  })

  test('a post before the call ended keeps the reservation (not_finished); the finish then posts it', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    expect(await db.transaction(tx => postFinishedCall(tx, callId, new Date().toISOString()))).toEqual({
      kind: 'not_finished',
    })
    expect(await reservationOf(callId)).toBeDefined()
    await finish(b.ws, callId)
    expect(await usageOf(callId)).toHaveLength(1)
  })

  test('the stale sweep posts an ended call whose finish did not post', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    // Ended without call.finish's post (a failed post, an older API): the reservation is still there.
    await db
      .update(calls)
      .set({ status: 'completed', ended_at: new Date().toISOString(), duration_sec: 60 })
      .where(eq(calls.id, callId))
    await finishStaleCalls(db, noRooms)
    expect(await usageOf(callId)).toMatchObject([{ seconds: 60, amount_micros: -50_000 }])
    expect(await reservationOf(callId)).toBeUndefined()
  })

  test('the stale sweep ends a call past its limit at the carrier, with its end and duration, and posts it capped', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 1500) // 25 minutes: past 20 minutes plus the 60-second grace
    const ended: string[] = []
    // Someone is still in the room: only the limit ends it.
    const room = (await getCall(callId))!.room!
    await finishStaleCalls(db, {
      listRooms: async () => new Map([[room, 2]]),
      endRoom: async r => {
        ended.push(r)
        return true
      },
    })
    expect(ended).toEqual([room])
    const call = (await getCall(callId))!
    expect(call.status).toBe('completed')
    expect(call.ended_at).not.toBeNull()
    expect(call.duration_sec).toBeGreaterThanOrEqual(1500)
    const [entry] = await usageOf(callId)
    expect(entry).toMatchObject({ seconds: 1260, amount_micros: -1_050_000 })
    expect(entry!.note).toMatch(/^capped_from_seconds=15\d\d$/)
    // The admins hear of it once the post committed (a job), never from inside the transaction.
    expect(jobs('billing.alert').filter(j => j.call === callId)).toMatchObject([{ kind: 'capped_call', billed: 1260 }])
  })

  test('a call past its limit whose room is gone ended unreported: filed at its last activity, not billed its limit (review L1)', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 1500)
    await finishStaleCalls(db, noRooms)
    expect((await getCall(callId))!.duration_sec).toBe(0)
    expect(await usageOf(callId)).toMatchObject([{ seconds: 0, amount_micros: 0 }])
    // Bridged: at most the transfer cap after the transfer (put through 1400 s ago: ended 800 s ago).
    await saveTransferContacts(b.ws.assistant.id, ['+15035550199'])
    const bridged = await start(b.ws)
    await db
      .update(calls)
      .set({
        started_at: new Date(Date.now() - 3000_000).toISOString(),
        transfer_at: new Date(Date.now() - 1400_000).toISOString(),
        transfer_to: '+15035550199',
        transfer_result: 'connected',
      })
      .where(eq(calls.id, bridged.callId))
    await finishStaleCalls(db, noRooms)
    const ended = (await getCall(bridged.callId))!
    expect(ended.duration_sec).toBeGreaterThanOrEqual(2199)
    expect(ended.duration_sec).toBeLessThanOrEqual(2201)
  })

  test('a call past its limit whose room cannot be ended stays live until the next sweep', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 1500)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await finishStaleCalls(db, { listRooms: async () => new Map(), endRoom: async () => false })
    warn.mockRestore()
    expect((await getCall(callId))!.status).toBe('live')
    expect(await reservationOf(callId)).toBeDefined()
  })

  test('a capped call that cost nothing (comped) emails nobody (recheck N2)', async () => {
    const b = await billed('comped')
    const { callId } = await start(b.ws)
    await startedAgo(callId, 1500)
    const room = (await getCall(callId))!.room!
    await finishStaleCalls(db, { listRooms: async () => new Map([[room, 2]]), endRoom: async () => true })
    expect(await usageOf(callId)).toMatchObject([{ amount_micros: 0, seconds: 1260 }])
    // (The sweep sees every bill's calls: only this call's alert matters here.)
    expect(jobs('billing.alert').filter(j => j.call === callId)).toEqual([])
  })

  test('call.finish and the stale sweep at once post the call once', async () => {
    for (let i = 0; i < 5; i++) {
      const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
      const { callId } = await start(b.ws)
      await startedAgo(callId, 1500)
      await Promise.all([finish(b.ws, callId), finishStaleCalls(db, noRooms)])
      await finishStaleCalls(db, noRooms)
      expect(await usageOf(callId)).toHaveLength(1)
      expect(await reservationOf(callId)).toBeUndefined()
      expect(await mine(b.billId)).toEqual([])
    }
  })

  test('the time after the hang-up is not part of the call (endedAgoMs)', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 300)
    // The agent summarized for 20 s before it sent call.finish.
    await act(agent(b.ws.id), 'call.finish', { callId, summary: 'Asked about a leak', endedAgoMs: 20_000 })
    const [first] = await db.select().from(calls).where(eq(calls.id, callId))
    expect(first!.duration_sec).toBeGreaterThanOrEqual(279)
    expect(first!.duration_sec).toBeLessThanOrEqual(282)
    const length = Date.parse(first!.ended_at!) - Date.parse(first!.started_at)
    expect(Math.abs(length - first!.duration_sec! * 1000)).toBeLessThanOrEqual(500)
    // A retry a minute of waiting later changes neither the end nor the duration.
    await act(agent(b.ws.id), 'call.finish', { callId, summary: 'Asked about a leak' })
    const [again] = await db.select().from(calls).where(eq(calls.id, callId))
    expect(again!.ended_at).toBe(first!.ended_at)
    expect(again!.duration_sec).toBe(first!.duration_sec)
    expect(await usageOf(callId)).toHaveLength(1)
  })

  test('a call never ends before it started', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await act(agent(b.ws.id), 'call.finish', { callId, summary: 'Hung up', endedAgoMs: 3_600_000 })
    const [call] = await db.select().from(calls).where(eq(calls.id, callId))
    expect(call!.duration_sec).toBe(0)
    expect(Date.parse(call!.ended_at!)).toBe(Date.parse(call!.started_at))
  })

  test('parallel finishes of one call post it once', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    await startedAgo(callId, 300)
    await Promise.all(Array.from({ length: 4 }, () => finish(b.ws, callId)))
    expect(await usageOf(callId)).toHaveLength(1)
    expect(await mine(b.billId)).toEqual([])
  })
})

describe("a white-label client on its partner's own keys (S7)", () => {
  const finishWith = (ws: Pick<Workspace, 'id'>, callId: string, keySources?: Record<string, string>) =>
    act(agent(ws.id), 'call.finish', {
      callId,
      summary: 'Asked about a leak',
      outcome: 'message',
      keySources,
    })
  // The client of an approved partner, switched to its keys, on its own carrier, with every stage tested ok
  // (partner-keys.test.ts covers each condition of the forecast).
  async function onPartnerKeys(ws: Pick<Workspace, 'id'>) {
    const [p] = await db
      .insert(partners)
      .values({
        id: crypto.randomUUID(),
        name: 'Own Keys Partners',
        status: 'approved',
        created_by: 'test',
      })
      .returning()
    await db.update(organization).set({ partnerId: p!.id }).where(eq(organization.id, ws.id))
    await db
      .insert(workspace_settings)
      .values({
        workspace_id: ws.id,
        timezone: DEFAULT_TIME_ZONE,
        partner_keys: true,
        carrier: 'telnyx',
      })
      .onConflictDoUpdate({
        target: workspace_settings.workspace_id,
        set: { partner_keys: true, carrier: 'telnyx' },
      })
    const stages = {
      stt: ENV.STT_PROVIDER,
      llm: ENV.LLM_PROVIDER,
      tts: ENV.TTS_PROVIDER,
    } as const
    for (const [category, provider] of Object.entries(stages))
      await db.insert(partner_providers).values({
        partner_id: p!.id,
        category: category as 'stt',
        provider: provider!,
        key_encrypted: 'not-read-by-the-forecast',
        last4: 'TEST',
        status: 'ok',
        updated_by: 'test',
      })
  }

  test('forecast and confirmed: $0 on own_keys, no allowance used; the agent is told to read the partner keys', async () => {
    const b = await billed('active', {
      allowanceUsed: true,
      creditMicros: 10_000_000,
    })
    await onPartnerKeys(b.ws)
    const started = await start(b.ws)
    expect(started).toMatchObject({ usageLevel: 'own_keys', keys: 'partner' })
    expect((await getCall(started.callId))!.partner_keys).toBe(true)
    // The paid level is still reserved while the call runs.
    expect(await reservationOf(started.callId)).toMatchObject({
      own_keys: true,
    })
    await startedAgo(started.callId, 120)
    expect(
      await finishWith(b.ws, started.callId, {
        stt: 'partner',
        llm: 'partner',
        tts: 'partner',
      }),
    ).toMatchObject({
      status: 200,
    })
    const [entry] = await usageOf(started.callId)
    expect(entry).toMatchObject({
      price_basis: 'own_keys',
      amount_micros: 0,
      included_seconds: 0,
    })
    expect((await getCall(started.callId))!.key_sources).toEqual({
      stt: 'partner',
      llm: 'partner',
      tts: 'partner',
    })
    expect((await balanceOf(b.billId))!.balance_micros).toBe(10_000_000)
  })

  test('a stage on the install keys, or no report: billed at its level', async () => {
    const b = await billed('active', {
      allowanceUsed: true,
      creditMicros: 10_000_000,
    })
    await onPartnerKeys(b.ws)
    const one = await start(b.ws)
    await startedAgo(one.callId, 120)
    await finishWith(b.ws, one.callId, {
      stt: 'partner',
      llm: 'partner',
      tts: 'install',
    })
    expect((await usageOf(one.callId))[0]).toMatchObject({
      price_basis: 'standard',
      amount_micros: -100_000,
    })
    const two = await start(b.ws)
    await startedAgo(two.callId, 120)
    await finish(b.ws, two.callId)
    expect((await usageOf(two.callId))[0]).toMatchObject({
      price_basis: 'standard',
      amount_micros: -100_000,
    })
  })

  test('a call not forecast on own keys is billed even when the agent claims partner keys', async () => {
    const b = await billed('active', {
      allowanceUsed: true,
      creditMicros: 10_000_000,
    })
    const started = await start(b.ws)
    expect(started.keys).toBeNull()
    await startedAgo(started.callId, 120)
    await finishWith(b.ws, started.callId, {
      stt: 'partner',
      llm: 'partner',
      tts: 'partner',
    })
    expect((await usageOf(started.callId))[0]).toMatchObject({
      price_basis: 'standard',
      amount_micros: -100_000,
    })
    expect((await getCall(started.callId))!.key_sources).toBeNull()
  })
})

describe('transfers on a billed call', () => {
  test('the transfer leg lasts at most the billed cap (10 minutes)', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    await saveTransferContacts(b.ws.assistant.id, ['+15035550199'])
    const { callId } = await start(b.ws)
    const dialled = await act(agent(b.ws.id), 'call.transfer', { callId, to: '+15035550199', result: 'dialing' })
    expect(dialled.status).toBe(200)
    expect(dialled.body.data.maxMinutes).toBe(10)
  })

  test('the leg still bridged at the finish is billed: a 600 s call with a 480 s leg posts 1080 s, once (review H1)', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: 10_000_000 })
    await saveTransferContacts(b.ws.assistant.id, ['+15035550199'])
    const { callId } = await start(b.ws)
    const to = '+15035550199'
    expect((await act(agent(b.ws.id), 'call.transfer', { callId, to, result: 'dialing' })).status).toBe(200)
    expect((await act(agent(b.ws.id), 'call.transfer', { callId, to, result: 'connected' })).status).toBe(200)
    await db
      .update(calls)
      .set({
        started_at: new Date(Date.now() - 600_000).toISOString(),
        transfer_at: new Date(Date.now() - 480_000).toISOString(),
      })
      .where(eq(calls.id, callId))
    await finish(b.ws, callId)
    // 600 s inbound plus the 480 s leg (a second more when the clock ticks over between the update and the finish).
    const [entry] = await usageOf(callId)
    expect(entry!.seconds).toBeGreaterThanOrEqual(1080)
    expect(entry!.seconds).toBeLessThanOrEqual(1082)
    expect(entry!.amount_micros).toBe(-Math.round((entry!.seconds! * 50_000) / 60))
    await finish(b.ws, callId)
    expect(await usageOf(callId)).toHaveLength(1)
    expect(await mine(b.billId)).toEqual([])
  })

  test('a transfer the reservation was not sized for (contact added after the call started) is refused', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    const { callId } = await start(b.ws)
    expect((await reservationOf(callId))!.limit_seconds).toBe(1200)
    await saveTransferContacts(b.ws.assistant.id, ['+15035550199'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dialled = await act(agent(b.ws.id), 'call.transfer', { callId, to: '+15035550199', result: 'dialing' })
    warn.mockRestore()
    expect(dialled.status).not.toBe(200)
    expect(JSON.stringify(dialled.body)).toContain('does not cover a transfer')
    expect((await getCall(callId))!.transfer_result).toBeNull()
  })
})

describe('alerts', () => {
  test('auto-recharge off: a low balance emails the owner once per low stretch; a credit starts a new stretch', async () => {
    const b = await billed('active', { autoRecharge: false, allowanceUsed: true, creditMicros: 6_000_000 })
    // Each call reserves $1: the second takes the available balance below the $5 threshold.
    await start(b.ws)
    expect(jobs('billing.alert')).toEqual([])
    await start(b.ws)
    expect(jobs('billing.alert')).toMatchObject([{ kind: 'low_balance', bill: b.billId }])
    // The email names what calls can still use ($6 less the $2 the two running calls hold), the figure it fired on (N3).
    const sent: string[] = []
    const sender = {
      kind: 'smtp',
      send: async (e: { text: string }) => void sent.push(e.text),
    } as unknown as EmailSender
    await sendBillingAlert(db, sender, { kind: 'low_balance', bill: b.billId, ref: 'start' })
    expect(sent[0]).toContain('$4.00')
    await start(b.ws)
    expect(jobs('billing.alert')).toHaveLength(1)
    await credit(b.billId, b.periodId, 500_000)
    await start(b.ws)
    expect(jobs('billing.alert')).toHaveLength(2)
    expect(
      await db
        .select()
        .from(billing_alerts)
        .where(and(eq(billing_alerts.billing_account_id, b.billId), eq(billing_alerts.kind, 'low_balance'))),
    ).toHaveLength(2)
  })

  test('no low-balance email while the included minutes last (LIN-647)', async () => {
    // A plan that just started: $0 balance, auto-recharge off, its included minutes not used yet.
    const b = await billed('active', { autoRecharge: false, creditMicros: 0 })
    await start(b.ws)
    expect(jobs('billing.alert')).toEqual([])
  })

  test('the monthly cap reached emails the owner once a month', async () => {
    const b = await billed('active', { allowanceUsed: true })
    // $50 of recharges this month already: the cap is used up.
    await db.insert(billing_recharges).values([
      {
        id: rid('rc'),
        billing_account_id: b.billId,
        amount_cents: 5000,
        status: 'paid',
        resolved_at: new Date().toISOString(),
      },
    ])
    await start(b.ws)
    await start(b.ws)
    expect(jobs('billing.alert')).toMatchObject([{ kind: 'recharge_cap_reached', bill: b.billId }])
  })
})

describe('the nightly check', () => {
  test('a usage entry without its counter row is reported (review L3)', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    await db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: b.billId,
        workspace_id: b.ws.id,
        period_id: b.periodId,
        kind: 'usage',
        amount_micros: -50_000,
        seconds: 60,
        included_seconds: 0,
        billable_seconds: 60,
        price_basis: 'standard',
        source_type: 'call',
        source_id: b.ws.call.id,
      }),
    )
    expect(await mine(b.billId)).toEqual([
      { kind: 'counter_usage', bill: b.billId, period: b.periodId, workspace: b.ws.id, found: 0, expected: 50_000 },
    ])
    await db.delete(usage_counters).where(inArray(usage_counters.billing_account_id, [b.billId]))
  })

  test('a recharge pending for more than 2 hours is named to the admins: hourly once, nightly each night (review M1)', async () => {
    const b = await billed('active')
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    const stuck = rid('rc')
    // One attempt pending at a time per bill: the older one on its own bill.
    const older = await billed('active')
    const old = rid('rc')
    await db.insert(billing_recharges).values([
      { id: stuck, billing_account_id: b.billId, amount_cents: 2000, created_at: hoursAgo(2.5) },
      { id: old, billing_account_id: older.billId, amount_cents: 2000, created_at: hoursAgo(5) },
    ])
    const named = async (run: (alert: never) => Promise<unknown>) => {
      const texts: string[] = []
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await run((async (alert: (l: string) => { subject: string; blocks: unknown[] }) => {
        texts.push(JSON.stringify(alert('en')))
      }) as never)
      error.mockRestore()
      return texts.join('\n')
    }
    const hourly = await named(alert => runStuckRechargeCheck({ alert }))
    expect(hourly).toContain(stuck)
    expect(hourly).not.toContain(old)
    const nightly = await named(alert => runLedgerCheck({ alert }))
    expect(nightly).toContain(stuck)
    expect(nightly).toContain(old)
    await db
      .update(billing_recharges)
      .set({ status: 'canceled', resolved_at: hoursAgo(0) })
      .where(inArray(billing_recharges.id, [stuck, old]))
  })

  test('the capped-call email is awaited in its job, so a failed send is retried (review N2)', async () => {
    const admin = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
    try {
      const failing = {
        kind: 'smtp',
        send: async () => Promise.reject(new Error('smtp down')),
      } as unknown as EmailSender
      await expect(
        sendBillingAlert(db, failing, {
          kind: 'capped_call',
          bill: 'bill_x',
          call: 'call_x',
          reported: 1500,
          billed: 1260,
        }),
      ).rejects.toThrow('could not be sent')
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
    }
  })

  test('a check that throws alerts the instance admins instead of failing unheard (review L4)', async () => {
    const alerts: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await runLedgerCheck({
      alert: async alert => {
        alerts.push(alert('en').subject)
      },
      check: async () => {
        throw new Error('exactNumber out of range')
      },
    })
    error.mockRestore()
    expect(result).toEqual({ bills: true, failed: true })
    expect(alerts).toEqual(['The billing check on Linedesk could not run'])
  })
})

// ---- A white-label client's monthly usage limit (LIN-454, src/usage-limit.ts) ----

describe('the usage limit a partner sets for a client', () => {
  /** `micros` used by `b`'s workspace this period (a usage entry as if from an earlier call). */
  const used = (b: Billed, micros: number) =>
    db.transaction(tx =>
      postEntry(tx, {
        billing_account_id: b.billId,
        workspace_id: b.ws.id,
        period_id: b.periodId,
        kind: 'usage',
        amount_micros: -micros,
        seconds: 600,
        included_seconds: 0,
        billable_seconds: 600,
        price_basis: 'standard',
        source_type: 'call',
        source_id: rid('call'),
      }),
    )
  const setLimit = (b: Billed, cents: number | null) =>
    db.update(organization).set({ usageLimitCents: cents }).where(eq(organization.id, b.ws.id))

  test('at the limit a new call is refused with the fixed line, filed as missed with a callback, and the 100 % email queued', async () => {
    const b = await billed('active', { creditMicros: 50_000_000 })
    await setLimit(b, 1000)
    await used(b, 10_000_000)
    const started = await start(b.ws)
    expect(started).toMatchObject({ blocked: true, refused: 'usage_limit', overCap: false, busy: false })
    expect(await reservationOf(started.callId)).toBeUndefined()
    expect(await getCall(started.callId)).toMatchObject({
      status: 'completed',
      duration_sec: 0,
      title: 'Missed call',
      summary: 'Nobody answered this call: the workspace reached its monthly usage limit. Call the caller back.',
      action_items: [{ text: 'Call back' }],
    })
    expect(jobs('call.push')).toContainEqual({ callId: started.callId, kind: 'finished' })
    expect(jobs('usage.limitAlert')).toEqual([
      { workspaceId: b.ws.id, periodId: b.periodId, level: 80 },
      { workspaceId: b.ws.id, periodId: b.periodId, level: 100 },
    ])
    // Each email once a period: the next refused call queues none.
    queued = []
    expect(await start(b.ws)).toMatchObject({ refused: 'usage_limit' })
    expect(jobs('usage.limitAlert')).toEqual([])
  })

  test('below the limit calls are answered; a call running when the limit is passed is never cut, its cost queues the email', async () => {
    const b = await billed('active', { creditMicros: 50_000_000 })
    await setLimit(b, 1000)
    await used(b, 7_000_000)
    const running = await start(b.ws)
    expect(running).toMatchObject({ blocked: false, refused: null })
    expect(jobs('usage.limitAlert')).toEqual([])
    // Another call meanwhile passes the limit; the running one finishes and is posted as usual.
    await used(b, 3_500_000)
    expect((await finish(b.ws, running.callId)).status).toBe(200)
    expect(await usageOf(running.callId)).toHaveLength(1)
    expect(jobs('usage.limitAlert').map(j => j.level)).toEqual([80, 100])
    expect(await start(b.ws)).toMatchObject({ blocked: true, refused: 'usage_limit' })
  })

  test('without a limit, or with a higher one, nothing changes; only this workspace counts against it', async () => {
    const b = await billed('active', { creditMicros: 100_000_000 })
    await used(b, 20_000_000)
    expect(await start(b.ws)).toMatchObject({ blocked: false, refused: null })
    await setLimit(b, 5000)
    expect(await start(b.ws)).toMatchObject({ blocked: false, refused: null })
    // Another workspace on the same bill uses a lot: not this workspace's use.
    const other = await createWorkspace('Rival Plumbing')
    await db
      .update(organization)
      .set({ billingAccountId: b.billId, billingState: 'active' })
      .where(eq(organization.id, other.id))
    await used({ ...b, ws: other }, 40_000_000)
    expect(await start(b.ws)).toMatchObject({ blocked: false, refused: null })
  })
})

describe('the trial prompt, its grace and the trial recharge', () => {
  /** A trial bill whose workspace used `usedSeconds` of its 3000 included seconds. */
  const trial = (o: Parameters<typeof billed>[1] = {}) => billed('trialing', { periodKind: 'trial', ...o })
  const alerts = (billId: string) =>
    db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, billId))
  /** A call answered and finished `seconds` later. */
  async function call(b: Billed, seconds: number) {
    const started = await start(b.ws)
    expect(started).toMatchObject({ blocked: false, refused: null })
    await startedAgo(started.callId, seconds)
    expect((await finish(b.ws, started.callId)).status).toBe(200)
    return started.callId
  }

  test('at 40 of the 50 trial minutes the owner is emailed once; not before, not again', async () => {
    const b = await trial({ usedSeconds: 2300 })
    await call(b, 60) // 2360 s: below 40 minutes
    expect(jobs('billing.alert')).toEqual([])
    await call(b, 60) // 2420 s: past 40 minutes
    const ref = b.periodId
    expect(jobs('billing.alert')).toEqual([{ kind: 'trial_minutes_low', bill: b.billId, ref }])
    await call(b, 60)
    expect(jobs('billing.alert')).toHaveLength(1)
    expect(await alerts(b.billId)).toMatchObject([{ kind: 'trial_minutes_low', ref }])
  })

  test('no prompt once the owner pressed it in the trial, nor on a paid plan with auto-recharge on', async () => {
    const tapped = await trial({ usedSeconds: 2390 })
    await db
      .update(billing_accounts)
      .set({ trial_recharge_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, tapped.billId))
    await call(tapped, 60)
    const paid = await billed('active', { usedSeconds: 2390 })
    await call(paid, 60)
    expect(jobs('billing.alert').filter(j => String(j.kind).startsWith('trial_minutes'))).toEqual([])
  })

  test('auto-recharge off (the default since 2026-11-17): the trial is prompted, and a paid plan once per month', async () => {
    const off = await trial({ usedSeconds: 2390, autoRecharge: false })
    await call(off, 60)
    const paid = await billed('active', { usedSeconds: 2390, autoRecharge: false })
    await call(paid, 60)
    await call(paid, 60)
    expect(jobs('billing.alert').filter(j => String(j.kind).startsWith('trial_minutes'))).toEqual([
      { kind: 'trial_minutes_low', bill: off.billId, ref: off.periodId },
      { kind: 'trial_minutes_low', bill: paid.billId, ref: paid.periodId },
    ])
    // A paid plan has no grace: never the used-up prompt.
    await trialMinutesAlert(db as never, paid.billId, 'trial_minutes_used', new Date().toISOString())
    expect(jobs('billing.alert').filter(j => j.kind === 'trial_minutes_used')).toEqual([])
  })

  test('minutes used up and no balance: new calls are answered on the 10-minute grace, the owner emailed once', async () => {
    const b = await trial({ allowanceUsed: true })
    const first = await start(b.ws)
    expect(first).toMatchObject({ blocked: false, refused: null })
    // It holds its limit (20 Standard minutes, $1): a second call at once would go past the grace and is refused.
    expect(await reservationOf(first.callId)).toMatchObject({
      reserved_micros: 1_000_000,
      included_reserved_seconds: 0,
    })
    expect(await start(b.ws)).toMatchObject({ blocked: true, refused: 'no_balance' })
    expect(jobs('billing.alert')).toEqual([{ kind: 'trial_minutes_used', bill: b.billId, ref: b.periodId }])
    // 4 minutes billed: $0.20 of the $0.50 grace used; the next call starts on the grace too, no second email.
    await startedAgo(first.callId, 240)
    await finish(b.ws, first.callId)
    expect(await balanceOf(b.billId)).toMatchObject({ balance_micros: -200_000, reserved_micros: 0 })
    const second = await start(b.ws)
    expect(second).toMatchObject({ blocked: false })
    await startedAgo(second.callId, 360)
    await finish(b.ws, second.callId)
    // 10 minutes past the allowance: the grace is used, new callers get the fixed line and a missed call.
    expect(await balanceOf(b.billId)).toMatchObject({ balance_micros: -500_000 })
    expect(await start(b.ws)).toMatchObject({ blocked: true, refused: 'no_balance' })
    expect(jobs('billing.alert').filter(j => j.kind === 'trial_minutes_used')).toHaveLength(1)
    // The used-up email also counts as the 40-minute one: that never follows.
    expect((await alerts(b.billId)).map(a => a.kind).sort()).toEqual(['trial_minutes_low', 'trial_minutes_used'])
    expect(jobs('billing.alert').filter(j => j.kind === 'trial_minutes_low')).toEqual([])
  })

  test('after the grace is used, paid bills keep their $5 buffer as before', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: -500_000 })
    expect(await start(b.ws)).toMatchObject({ blocked: false, refused: null })
  })

  test('auto-recharge fires in the trial once the owner turned on the trial recharge, never before', async () => {
    const before = await trial({ allowanceUsed: true, creditMicros: 3_000_000 })
    await start(before.ws)
    expect(jobs('billing.recharge')).toEqual([])
    const after = await trial({ allowanceUsed: true, creditMicros: 3_000_000 })
    await db
      .update(billing_accounts)
      .set({ trial_recharge_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, after.billId))
    await start(after.ws)
    const [attempt] = await db
      .select()
      .from(billing_recharges)
      .where(eq(billing_recharges.billing_account_id, after.billId))
    expect(attempt).toMatchObject({ status: 'pending', amount_cents: 2500, manual: false })
    expect(jobs('billing.recharge')).toEqual([{ rechargeId: attempt!.id }])
  })

  test('the emails: minutes, the purchase with its card, the top-up and the free plan; nothing once tapped', async () => {
    const b = await trial({ usedSeconds: 2460 })
    await db
      .update(billing_accounts)
      .set({ trial_ends_at: '2026-12-01T12:00:00.000Z' })
      .where(eq(billing_accounts.id, b.billId))
    const sent: { subject: string; text: string; html: string }[] = []
    const sender = {
      kind: 'smtp',
      send: async (e: (typeof sent)[number]) => void sent.push(e),
    } as unknown as EmailSender
    const provider = {
      name: 'stripe',
      rechargeCard: async () => ({ id: 'pm_1', brand: 'visa', last4: '4242' }),
    } as never
    await sendBillingAlert(db, sender, { kind: 'trial_minutes_low', bill: b.billId, ref: b.periodId }, { provider })
    expect(sent[0]!.subject).toBe('You used 41 of your 50 trial minutes')
    expect(sent[0]!.text).toContain('9 minutes are left. After that, calls need call credit.')
    expect(sent[0]!.text).toContain('To keep every call answered, add $25 with Visa ending in 4242.')
    expect(sent[0]!.text).toContain('Whenever your balance falls below $5, we add $25 again.')
    expect(sent[0]!.text).toContain('Your plan stays free until December 1, 2026.')
    expect(sent[0]!.html).toContain('Keep calls answered')
    await sendBillingAlert(db, sender, { kind: 'trial_minutes_used', bill: b.billId, ref: b.periodId }, { provider })
    expect(sent[1]!.subject).toBe('Your 50 trial minutes are used up')
    expect(sent[1]!.text).toContain('Calls are still answered for a short time.')
    // The card could not be read: "your saved card".
    const broken = { name: 'stripe', rechargeCard: async () => Promise.reject(new Error('down')) } as never
    await sendBillingAlert(
      db,
      sender,
      { kind: 'trial_minutes_low', bill: b.billId, ref: b.periodId },
      { provider: broken },
    )
    expect(sent[2]!.text).toContain('add $25 with your saved card.')
    await db
      .update(billing_accounts)
      .set({ trial_recharge_at: new Date().toISOString() })
      .where(eq(billing_accounts.id, b.billId))
    expect(
      await sendBillingAlert(db, sender, { kind: 'trial_minutes_low', bill: b.billId, ref: b.periodId }, { provider }),
    ).toEqual({ sent: 'nobody' })
    expect(sent).toHaveLength(3)
  })

  test('a paid plan with auto-recharge off: the minutes of the month, the purchase, no trial date; nothing once it is on', async () => {
    const b = await billed('active', { usedSeconds: 2460, autoRecharge: false })
    const sent: { subject: string; text: string; html: string }[] = []
    const sender = {
      kind: 'smtp',
      send: async (e: (typeof sent)[number]) => void sent.push(e),
    } as unknown as EmailSender
    const provider = {
      name: 'stripe',
      rechargeCard: async () => ({ id: 'pm_1', brand: 'visa', last4: '4242' }),
    } as never
    await sendBillingAlert(db, sender, { kind: 'trial_minutes_low', bill: b.billId, ref: b.periodId }, { provider })
    expect(sent[0]!.subject).toBe('You used 41 of your 50 included minutes this month')
    expect(sent[0]!.text).toContain('9 minutes are left this month.')
    expect(sent[0]!.text).toContain('To keep every call answered, add $25 with Visa ending in 4242.')
    expect(sent[0]!.text).not.toContain('trial')
    expect(sent[0]!.text).not.toContain('stays free')
    await db.update(billing_accounts).set({ auto_recharge: true }).where(eq(billing_accounts.id, b.billId))
    expect(
      await sendBillingAlert(db, sender, { kind: 'trial_minutes_low', bill: b.billId, ref: b.periodId }, { provider }),
    ).toEqual({ sent: 'nobody' })
    expect(sent).toHaveLength(1)
  })
})

describe('the busy-line notice (LIN-450)', () => {
  const busyRows = (billId: string) =>
    db
      .select()
      .from(billing_alerts)
      .where(and(eq(billing_alerts.billing_account_id, billId), eq(billing_alerts.kind, 'busy_line')))
  /** The workspace's own day (its time zone; a new workspace has one), as the notice counts it. */
  const today = async (ws: Workspace) => {
    const [row] = await db
      .select({ zone: workspace_settings.timezone })
      .from(workspace_settings)
      .where(eq(workspace_settings.workspace_id, ws.id))
    return todayIn(row?.zone ?? DEFAULT_TIME_ZONE)
  }
  /** Fills the workspace's 5 lines (a new workspace has one live sample call), then one busy caller. */
  async function fillAndBusy(b: Billed) {
    for (let i = 0; i < 4; i++) expect((await start(b.ws)).blocked).toBe(false)
    expect(await start(b.ws)).toMatchObject({ blocked: true, busy: true })
  }

  test('all lines busy: one row a workspace and day counts the callers; only the first queues the email', async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    await fillAndBusy(b)
    const ref = `${b.ws.id}:${await today(b.ws)}`
    expect(await busyRows(b.billId)).toMatchObject([{ ref, count: 1 }])
    expect(jobs('billing.alert')).toEqual([{ kind: 'busy_line', bill: b.billId, ref }])
    expect(await start(b.ws)).toMatchObject({ blocked: true, busy: true })
    expect(await start(b.ws)).toMatchObject({ blocked: true, busy: true })
    expect(await busyRows(b.billId)).toMatchObject([{ ref, count: 3 }])
    expect(jobs('billing.alert').filter(j => j.kind === 'busy_line')).toHaveLength(1)
  })

  test("another day of the workspace is a new notice; yesterday's row stays as it was", async () => {
    const b = await billed('active', { creditMicros: 10_000_000 })
    const yesterday = `${b.ws.id}:2026-01-01`
    await db
      .insert(billing_alerts)
      .values({ billing_account_id: b.billId, kind: 'busy_line', ref: yesterday, count: 4 })
    await fillAndBusy(b)
    expect((await busyRows(b.billId)).map(r => [r.ref, r.count]).sort()).toEqual(
      [
        [yesterday, 4],
        [`${b.ws.id}:${await today(b.ws)}`, 1],
      ].sort(),
    )
    expect(jobs('billing.alert').filter(j => j.kind === 'busy_line')).toHaveLength(1)
  })

  test("the bill's cap refuses a call as too_many_calls: the same notice, for the workspace the caller called", async () => {
    const b = await billed('trialing', { creditMicros: 10_000_000 })
    const second = await createWorkspace('Second')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    for (const ws of [b.ws, b.ws, b.ws, second, second]) expect((await start(ws)).blocked).toBe(false)
    expect(await start(second)).toMatchObject({ blocked: true, refused: 'too_many_calls' })
    expect(await busyRows(b.billId)).toMatchObject([{ ref: `${second.id}:${await today(second)}`, count: 1 }])
  })

  test('billing not in effect, or a workspace on no bill: no notice (nothing to add)', async () => {
    cloud.on = false
    const b = await billed('active', { creditMicros: 10_000_000 })
    await fillAndBusy(b)
    expect(await busyRows(b.billId)).toEqual([])
    cloud.on = true
    const unbilled = await createWorkspace('Self-hosted')
    for (let i = 0; i < 4; i++) await start(unbilled)
    expect(await start(unbilled)).toMatchObject({ blocked: true, busy: true })
    expect(jobs('billing.alert')).toEqual([])
  })

  test('other refusals (no balance) are no busy line', async () => {
    const b = await billed('active', { allowanceUsed: true, creditMicros: -5_000_000 })
    expect(await start(b.ws)).toMatchObject({ blocked: true, refused: 'no_balance' })
    expect(await busyRows(b.billId)).toEqual([])
  })

  describe('the email', () => {
    const sent: { to: string; subject: string; text: string; html: string }[] = []
    const sender = {
      kind: 'smtp',
      send: async (e: (typeof sent)[number]) => void sent.push(e),
    } as unknown as EmailSender
    beforeEach(() => {
      sent.length = 0
    })
    async function notice(status: 'active' | 'trialing' | 'canceled', count = 3) {
      const b = await billed(status === 'canceled' ? 'active' : status)
      const ref = `${b.ws.id}:2026-11-17`
      await db.insert(billing_alerts).values({ billing_account_id: b.billId, kind: 'busy_line', ref, count })
      if (status === 'canceled')
        await db.update(billing_accounts).set({ status: 'canceled' }).where(eq(billing_accounts.id, b.billId))
      return { b, send: () => sendBillingAlert(db, sender, { kind: 'busy_line', bill: b.billId, ref }) }
    }

    test('a paid plan: how many callers, the day, the limit, and one button to add 5 more for $5 a month', async () => {
      const { b, send } = await notice('active')
      await db
        .update(billing_accounts)
        .set({ stripe_subscription_id: rid('sub') })
        .where(eq(billing_accounts.id, b.billId))
      expect(await send()).toEqual({ sent: 'owner' })
      const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, b.ws.owner.userId))
      expect(sent[0]!.to).toBe(owner!.email)
      expect(sent[0]!.subject).toBe('3 callers got a busy line at Brightwater Plumbing & Heating')
      expect(sent[0]!.text).toContain(
        'On November 17, 2026, Brightwater Plumbing & Heating was already on 5 calls at the same time, so 3 callers heard',
      )
      expect(sent[0]!.text).toContain('Add 5 more lines for $5 a month')
      expect(sent[0]!.text).toContain(`#workspace/billing?addCalls=1&ws=${b.ws.id}`)
      expect(sent[0]!.text).toContain('We send this at most once a day per workspace.')
    })

    test('the trial: more once the plan is paid, no button; an instance admin cap: no offer at all', async () => {
      const { send } = await notice('trialing', 1)
      await send()
      expect(sent[0]!.subject).toBe('A caller got a busy line at Brightwater Plumbing & Heating')
      expect(sent[0]!.text).toContain('once your plan is paid, after the trial')
      expect(sent[0]!.text).not.toContain('addCalls')
      const capped = await notice('active')
      await db
        .update(billing_accounts)
        .set({ stripe_subscription_id: rid('sub'), concurrent_calls_cap: 8 })
        .where(eq(billing_accounts.id, capped.b.billId))
      await capped.send()
      expect(sent[1]!.text).toContain('was already on 8 calls at the same time')
      expect(sent[1]!.text).not.toContain('Add 5 more lines')
      expect(sent[1]!.text).not.toContain('after the trial')
    })

    test('nothing for a canceled bill, or a workspace that left the bill', async () => {
      const { send } = await notice('canceled')
      expect(await send()).toEqual({ sent: 'nobody' })
      const moved = await notice('active')
      await db.update(organization).set({ billingAccountId: null }).where(eq(organization.id, moved.b.ws.id))
      expect(await moved.send()).toEqual({ sent: 'nobody' })
      expect(sent).toEqual([])
    })
  })
})
