// The automatic forwarding check: who may start one, what it may call, how the arriving call is matched (our caller
// number and the time, nothing else), and what each way the outbound call ends means for the owner.
import { assistants, calls, forwarding_checks, line_lookups, phone_numbers, setup_events } from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  arrivesFor,
  asE164,
  type CheckDialer,
  couldBeFrom,
  type CheckLine,
  claimForwardingCheck,
  clearLineLookups,
  DEV_CHECK_NUMBER,
  type DialOutcome,
  devDialer,
  failureStatus,
  forwardingCheckAvailability,
  forwardingCheckHandlers,
  installCheckLine,
  runForwardingCheck,
  sipStatusOf,
  tryAgain,
} from '../src/forwarding-check.ts'
import { LINE_LOOKUPS_PER_INSTALL_DAY, LINE_LOOKUPS_PER_WORKSPACE_DAY } from '@linedesk/actions'
import { TelephonyError } from '@linedesk/telephony'
import { LivekitError } from '../src/transfer-trunk.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

const CALLER = '+12065550177'
/** A US number the check accepts: exchange 200 to 999, never an N11 one (211, 311, …) nor premium 976. */
const checkable = (area: string) => {
  const exchange = 200 + Math.floor(Math.random() * 800)
  const line = String(Math.floor(Math.random() * 1e4)).padStart(4, '0')
  return `+1${area}${exchange % 100 === 11 || exchange === 976 ? exchange + 1 : exchange}${line}`
}
/** A business number that is never one of the test's Linedesk numbers (those are 503). */
const businessNumber = () => checkable('971')
const fast = { graceMs: 100, pollMs: 20, ringSeconds: 5 }

async function startCheck(name: string, number = businessNumber()) {
  const ws = await createWorkspace(name)
  const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
  const started = await act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn!.id, businessNumber: number })
  expect(started.status).toBe(200)
  return { ws, pn: pn!, checkId: started.body.data.id as string, business: number, started }
}

/** A check line whose dialer runs `dial` and records when it was hung up; `reached`: the call sat in a Linedesk room. */
function line(
  dial: (call: Parameters<CheckDialer['dial']>[0]) => Promise<DialOutcome>,
  reached = false,
  callerNumber = CALLER,
) {
  const hungUp: string[] = []
  const check: CheckLine = {
    callerNumber,
    dialer: { dial, hangUp: async room => void hungUp.push(room), reachedLinedesk: async () => reached },
  }
  return { line: async () => check, hungUp }
}

const numberRow = async (id: string) => (await db.select().from(phone_numbers).where(eq(phone_numbers.id, id)))[0]!
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
/** Marks a check as dialled `secondsAgo` from a caller number, as the job does before it dials. */
const dialled = (id: string, secondsAgo = 0, caller = CALLER) =>
  db
    .update(forwarding_checks)
    .set({ caller_number: caller, dialed_at: ago(secondsAgo) })
    .where(eq(forwarding_checks.id, id))
/** Ends a check as the job does: a result, and when it ended. */
const ended = (id: string, status: 'answered' | 'rang_through' | 'busy', secondsAgo = 0) =>
  db
    .update(forwarding_checks)
    .set({ status, finished_at: ago(secondsAgo) })
    .where(eq(forwarding_checks.id, id))
/** A caller number of its own, so checks of other tests ringing at the same time are not in the way. */
const ownCaller = () => checkable('206')
const arrive = (from: string, to: string) =>
  db.transaction(tx => claimForwardingCheck(tx, { from, to, now: new Date().toISOString() }))

const checkRow = async (id: string) =>
  (await db.select().from(forwarding_checks).where(eq(forwarding_checks.id, id)))[0]!
const events = async (workspaceId: string) =>
  (await db.select().from(setup_events).where(eq(setup_events.workspace_id, workspaceId))).map(e => e.event)
const callsFrom = async (workspaceId: string, from: string) =>
  db
    .select()
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.from_number, from)))

describe('starting a check', () => {
  test('owners and admins may check, look up the line and read the result; members may not', async () => {
    const { ws, pn } = await startCheck('Permission Check Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'phoneNumber.checkForwarding', { phoneNumberId: pn.id })).status).toBe(403)
    expect((await act(member, 'phoneNumber.forwardingCheck', { phoneNumberId: pn.id })).status).toBe(403)
    expect((await act(member, 'phoneNumber.lookupLine', { number: businessNumber() })).status).toBe(403)
    expect((await act(agent(ws.id), 'phoneNumber.checkForwarding', { phoneNumberId: pn.id })).status).toBe(403)
    const admin = await addMember(ws.id, 'admin')
    expect((await act(admin, 'phoneNumber.forwardingCheck', { phoneNumberId: pn.id })).body.data.check.status).toBe(
      'dialing',
    )
  })

  test('answers with the running check; the business number is saved on the number only once it works', async () => {
    const { ws, pn, business, started, checkId } = await startCheck('Saved Number Plumbing')
    expect(started.body.data).toMatchObject({ status: 'dialing', businessNumber: business, phoneNumberId: pn.id })
    expect(started.body.rows).toEqual({})
    expect((await numberRow(pn.id)).forwarded_from).toBeNull()
    // A later check without a number checks the last one checked.
    await db.update(forwarding_checks).set({ status: 'rang_through' }).where(eq(forwarding_checks.id, checkId))
    const again = await act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn.id })
    expect(again.body.data.businessNumber).toBe(business)
    await dialled(again.body.data.id)
    await arrive(CALLER, pn.e164)
    expect((await numberRow(pn.id)).forwarded_from).toBe(business)
  })

  test('a saved number from before the rules is checked like a typed one', async () => {
    const ws = await createWorkspace('Old Saved Number Plumbing')
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    await db.update(phone_numbers).set({ forwarded_from: '+18885550100' }).where(eq(phone_numbers.id, pn!.id))
    const started = await act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn!.id })
    expect(started.body.error).toMatch(/no toll-free/)
  })

  test('only a forwarded number of the workspace, never a Linedesk number, toll-free or foreign number', async () => {
    const ws = await createWorkspace('Refusals Plumbing')
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    const other = await createWorkspace('Other Refusals Plumbing')
    const check = (input: object, who = ws.owner) =>
      act(who, 'phoneNumber.checkForwarding', { phoneNumberId: pn!.id, ...input })
    expect((await check({})).body.error).toMatch(/business number first/)
    // Another workspace's Linedesk number (given one the check would otherwise accept).
    const linedeskNumber = checkable('503')
    await db.update(phone_numbers).set({ e164: linedeskNumber }).where(eq(phone_numbers.workspace_id, other.id))
    expect((await check({ businessNumber: linedeskNumber })).body.error).toMatch(/Linedesk number/)
    expect((await check({ businessNumber: '+18005550100' })).status).toBe(422)
    // Another country than the workspace's numbers' (and none allowed by the admin): the destination policy refuses it.
    expect((await check({ businessNumber: '+442079460750' })).body.error).toMatch(
      /^Only numbers in the United States can be checked/,
    )
    expect((await check({ businessNumber: businessNumber() }, other.owner)).body.error).toBe('phone number not found')
    expect((await check({ businessNumber: DEV_CHECK_NUMBER })).body.error).toMatch(/number Linedesk checks from/)
    // Not Canada or the Caribbean (countries of their own), never personal (5XX), premium (900) or non-geographic numbers.
    for (const foreign of ['+14165550123', '+18765550123', '+18095550123'])
      expect((await check({ businessNumber: foreign })).body.error).toMatch(/^Only numbers in the United States/)
    for (const refused of ['+15005550123', '+19005550123', '+17105550123'])
      expect((await check({ businessNumber: refused })).status).toBe(422)
    await db.update(phone_numbers).set({ mode: 'new' }).where(eq(phone_numbers.id, pn!.id))
    expect((await check({ businessNumber: businessNumber() })).body.error).toMatch(/forwards to can be checked/)
  })

  test('two business numbers a workspace a day, three checks of one number a day on the whole install', async () => {
    const { ws, pn, checkId } = await startCheck('Two Numbers Plumbing')
    const end = (id: string) =>
      db.update(forwarding_checks).set({ status: 'rang_through' }).where(eq(forwarding_checks.id, id))
    await end(checkId)
    const second = await act(ws.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: pn.id,
      businessNumber: businessNumber(),
    })
    expect(second.status).toBe(200)
    await end(second.body.data.id)
    const third = await act(ws.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: pn.id,
      businessNumber: businessNumber(),
    })
    expect(third.body.error).toMatch(/two different numbers today/)
  })

  test('one business number: its first caller and its own business keep their quota, everyone else shares one', async () => {
    const target = businessNumber()
    const tryTarget = async (name: string) => {
      const ws = await createWorkspace(name)
      const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
      const started = await act(ws.owner, 'phoneNumber.checkForwarding', {
        phoneNumberId: pn!.id,
        businessNumber: target,
      })
      if (started.status === 200) {
        await dialled(started.body.data.id, 0, ownCaller())
        await ended(started.body.data.id, 'rang_through')
      }
      return { ws, pn: pn!, started }
    }
    // A check refused or never dialled called nobody: it counts for nothing.
    const notDialled = await startCheck('Never Dialled Target Plumbing', target)
    await db
      .update(forwarding_checks)
      .set({ status: 'not_checked', started_at: ago(120) })
      .where(eq(forwarding_checks.id, notDialled.checkId))
    const first = await tryTarget('First Target Plumbing')
    expect(first.started.status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await tryTarget(`Shared Target ${i} Plumbing`)).started.status).toBe(200)
    const refused = await tryTarget('Shared Target 3 Plumbing')
    expect(refused.started.body.error).toMatch(/checked several times today\. Try again in about (\d+ hours|an hour)\./)
    // The first one still has its own quota left.
    const again = await act(first.ws.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: first.pn.id,
      businessNumber: target,
    })
    expect(again.status).toBe(200)
  })

  test('the business the number forwards to is never locked out by others', async () => {
    const target = businessNumber()
    const owner = await createWorkspace('Own Number Plumbing')
    const [ownNumber] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, owner.id))
    // Others called it three times before it was saved as this business's own number.
    for (let i = 0; i < 3; i++) {
      const { checkId } = await startCheck(`Before Owner ${i} Plumbing`, target)
      await dialled(checkId, 0, ownCaller())
      await ended(checkId, 'rang_through')
    }
    await db.update(phone_numbers).set({ forwarded_from: target }).where(eq(phone_numbers.id, ownNumber!.id))
    const started = await act(owner.owner, 'phoneNumber.checkForwarding', { phoneNumberId: ownNumber!.id })
    expect(started.status).toBe(200)
    expect(started.body.data.businessNumber).toBe(target)
  })

  test('retry times say when a limit frees up', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    expect(tryAgain(now - 23.5 * 3600_000, now)).toBe('Try again in about an hour.')
    expect(tryAgain(now - 2 * 3600_000, now)).toBe('Try again in about 22 hours.')
  })

  test('the install-wide daily cap (FORWARDING_CHECKS_PER_DAY)', async () => {
    const before = process.env.FORWARDING_CHECKS_PER_DAY
    process.env.FORWARDING_CHECKS_PER_DAY = '0'
    try {
      const ws = await createWorkspace('Install Cap Plumbing')
      const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
      const refused = await act(ws.owner, 'phoneNumber.checkForwarding', {
        phoneNumberId: pn!.id,
        businessNumber: businessNumber(),
      })
      expect(refused.body.error).toMatch(/paused on this server for now\. Try again in about/)
    } finally {
      if (before === undefined) delete process.env.FORWARDING_CHECKS_PER_DAY
      else process.env.FORWARDING_CHECKS_PER_DAY = before
    }
  })

  test('one check at a time, and a few an hour', async () => {
    const { ws, pn, checkId, business } = await startCheck('Limits Plumbing')
    const second = businessNumber()
    const again = (number = business) =>
      act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn.id, businessNumber: number })
    expect((await again()).body.error).toMatch(/already running/)
    await db.update(forwarding_checks).set({ status: 'rang_through' }).where(eq(forwarding_checks.id, checkId))
    // Two numbers, at most three checks each: five an hour is reached before either runs out.
    for (const number of [business, business, second, second]) {
      const next = await again(number)
      expect(next.status).toBe(200)
      await db.update(forwarding_checks).set({ status: 'busy' }).where(eq(forwarding_checks.id, next.body.data.id))
    }
    expect((await again(second)).body.error).toMatch(/Too many checks/)
  })

  test('a check that never finished reads as not checked', async () => {
    const { ws, pn, checkId } = await startCheck('Stale Plumbing')
    await db
      .update(forwarding_checks)
      .set({ started_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where(eq(forwarding_checks.id, checkId))
    const read = await act(ws.owner, 'phoneNumber.forwardingCheck', { phoneNumberId: pn.id })
    expect(read.body.data.check).toMatchObject({ id: checkId, status: 'not_checked' })
  })
})

describe('running a check', () => {
  test('our call arriving on the Linedesk number: works, not filed, verified, hung up at once', async () => {
    const { ws, pn, checkId, business } = await startCheck('Works Plumbing')
    let arrival: { status: number; body: { data: Record<string, unknown> } } | undefined
    const { line: l, hungUp } = line(async ({ from, to, linedeskNumber }) => {
      expect(to).toBe(business)
      arrival = await act(agent(), 'call.start', { from, to: linedeskNumber })
      return new Promise(() => {}) // still "ringing": the check ends on the arrival, not on the dial
    })
    expect(await runForwardingCheck(checkId, { ...fast, line: l })).toBe('works')
    expect(arrival!.status).toBe(200)
    expect(arrival!.body.data).toMatchObject({ forwardingCheck: true, blocked: true, callId: checkId })
    expect(await callsFrom(ws.id, CALLER)).toEqual([])
    expect(hungUp).toEqual([`fwdcheck-${checkId}`])
    expect(await checkRow(checkId)).toMatchObject({ status: 'works', caller_number: CALLER })
    expect(await events(ws.id)).toContain('forwarding_verified')
    const number = await numberRow(pn.id)
    expect(number.verified_at).not.toBeNull()
    expect(number.forwarded_from).toBe(business)
    const read = await act(ws.owner, 'phoneNumber.forwardingCheck', { phoneNumberId: pn.id })
    expect(read.body.data.check).toMatchObject({ status: 'works', businessNumber: business })
    expect(read.body.data.check.ringSeconds).toBeGreaterThanOrEqual(1)
  })

  test('answered by Linedesk and arriving a moment later still works', async () => {
    const { checkId } = await startCheck('Late Arrival Plumbing')
    const { line: l } = line(async ({ from, linedeskNumber }) => {
      setTimeout(() => void act(agent(), 'call.start', { from, to: linedeskNumber }), 30)
      return { kind: 'answered' }
    })
    expect(await runForwardingCheck(checkId, { ...fast, graceMs: 2000, line: l })).toBe('works')
  })

  test('a forwarded call after the check gave up (answered, rang through) still turns it into works', async () => {
    for (const given of ['answered', 'rang_through'] as const) {
      const { ws, pn, checkId } = await startCheck(`Gave Up ${given} Plumbing`)
      const caller = ownCaller()
      await dialled(checkId, 50, caller)
      await ended(checkId, given, 3)
      const late = await act(agent(), 'call.start', { from: caller, to: pn.e164 })
      expect(late.body.data).toMatchObject({ forwardingCheck: true, blocked: true })
      expect((await checkRow(checkId)).status).toBe('works')
      expect(await callsFrom(ws.id, caller)).toEqual([])
    }
  })

  test('the window counts from the dial: a check not dialled yet claims nothing, a long-queued one is not dialled', async () => {
    const { ws, pn, checkId } = await startCheck('Queued Plumbing')
    // Started long ago, dialled just now: its call still belongs to it.
    await db
      .update(forwarding_checks)
      .set({ started_at: new Date(Date.now() - 5 * 60_000).toISOString() })
      .where(eq(forwarding_checks.id, checkId))
    await dialled(checkId)
    expect((await arrive(CALLER, pn.e164))?.id).toBe(checkId)

    // Its caller number known but not dialled yet: a call from that number is an ordinary call.
    const queued = await startCheck('Not Dialled Plumbing')
    const caller = randomNumber()
    await db.update(forwarding_checks).set({ caller_number: caller }).where(eq(forwarding_checks.id, queued.checkId))
    const call = await act(agent(), 'call.start', { from: caller, to: queued.pn.e164 })
    expect(call.body.data.forwardingCheck).toBeUndefined()
    expect(await callsFrom(queued.ws.id, caller)).toHaveLength(1)
    await db.update(forwarding_checks).set({ caller_number: null }).where(eq(forwarding_checks.id, queued.checkId))
    await db
      .update(forwarding_checks)
      .set({ started_at: new Date(Date.now() - 45_000).toISOString() })
      .where(eq(forwarding_checks.id, queued.checkId))
    let dialledIt = false
    const { line: l } = line(async () => {
      dialledIt = true
      return { kind: 'answered' }
    })
    expect(await runForwardingCheck(queued.checkId, { ...fast, line: l })).toBe('not_checked')
    expect(dialledIt).toBe(false)
    expect((await checkRow(queued.checkId)).detail).toMatch(/did not start in time/)
    expect(await callsFrom(ws.id, CALLER)).toEqual([])
  })

  test('our caller reaching another Linedesk number: never filed there, the check says where it forwards', async () => {
    const { checkId } = await startCheck('Forwards Elsewhere Plumbing')
    const other = await createWorkspace('Not Checking Plumbing')
    const caller = ownCaller()
    const { line: l, hungUp } = line(
      async ({ from }) => {
        const reached = await act(agent(), 'call.start', { from, to: other.number })
        expect(reached.body.data).toMatchObject({ forwardingCheck: true, blocked: true })
        return new Promise(() => {})
      },
      false,
      caller,
    )
    expect(await runForwardingCheck(checkId, { ...fast, line: l })).toBe('forwards_elsewhere')
    expect(await callsFrom(other.id, caller)).toEqual([])
    // Another business's Linedesk number is never named.
    expect((await checkRow(checkId)).detail).toMatch(/^Your phone forwards to another number, not to \+1 /)
    expect((await checkRow(checkId)).detail).not.toContain(other.number.slice(-4))
    expect(hungUp).toHaveLength(1)
    expect(await events(other.id)).not.toContain('forwarding_verified')
  })

  test('reaching another of the workspace’s own numbers names it', async () => {
    const { ws, checkId } = await startCheck('Second Number Plumbing')
    const second = checkable('503')
    await db
      .insert(phone_numbers)
      .values({ id: `pn_${crypto.randomUUID().slice(0, 8)}`, workspace_id: ws.id, e164: second, provider: 'dev' })
    const caller = ownCaller()
    await dialled(checkId, 0, caller)
    await arrive(caller, second)
    expect((await checkRow(checkId)).detail).toBe(
      `Your phone forwards to +1 ${second.slice(2, 5)} ${second.slice(5, 8)} ${second.slice(8)}, not to +1 ${ws.number.slice(2, 5)} ${ws.number.slice(5, 8)} ${ws.number.slice(8)}.`,
    )
  })

  test('answered, never claimed, but sitting in a Linedesk room: the assistant did not start', async () => {
    const { checkId } = await startCheck('No Assistant Plumbing')
    const { line: l } = line(async () => ({ kind: 'answered' }), true)
    expect(await runForwardingCheck(checkId, { ...fast, line: l })).toBe('no_assistant')
    expect((await checkRow(checkId)).arrived_at).not.toBeNull()
  })

  test('a late call of an ended check never marks the next check of another number', async () => {
    const caller = ownCaller()
    const { ws, pn, checkId: before } = await startCheck('Next Check Plumbing')
    await dialled(before, 60, caller)
    await ended(before, 'rang_through', 5)
    // The next check, of another business number, dialled right after: a call now may still be the first one's.
    const [next] = await db
      .insert(forwarding_checks)
      .values({
        id: `fwc_next${Date.now()}`,
        workspace_id: ws.id,
        phone_number_id: pn.id,
        business_number: businessNumber(),
        linedesk_number: pn.e164,
        caller_number: caller,
        started_at: ago(3),
        dialed_at: ago(2),
      })
      .returning()
    const dropped = await act(agent(), 'call.start', { from: caller, to: pn.e164 })
    expect(dropped.body.data).toMatchObject({ forwardingCheck: true, blocked: true })
    expect((await checkRow(before)).status).toBe('rang_through')
    expect((await checkRow(next!.id)).status).toBe('dialing')
    // Once the first one ended long enough ago, a call can only be the next one's.
    await ended(before, 'rang_through', 30)
    await arrive(caller, pn.e164)
    expect((await checkRow(next!.id)).status).toBe('works')
    expect(await callsFrom(ws.id, caller)).toEqual([])
  })

  test('a call landing elsewhere goes to the check it came from, and a later arrival on its own number upgrades it', async () => {
    const caller = ownCaller()
    const { pn, checkId } = await startCheck('Ended Elsewhere Plumbing')
    const other = await createWorkspace('Elsewhere Target Plumbing')
    await dialled(checkId, 40, caller)
    await ended(checkId, 'rang_through', 2)
    await arrive(caller, other.number)
    expect((await checkRow(checkId)).status).toBe('forwards_elsewhere')
    await arrive(caller, pn.e164)
    expect((await checkRow(checkId)).status).toBe('works')
    expect(await callsFrom(other.id, caller)).toEqual([])
  })

  test('a check whose line took too long to set up is never dialled', async () => {
    const { checkId } = await startCheck('Slow Line Plumbing')
    let dialledIt = false
    const { line: slow } = line(async () => {
      dialledIt = true
      return { kind: 'answered' }
    })
    const result = await runForwardingCheck(checkId, {
      ...fast,
      line: async () => {
        // Provisioning the trunk took past the cutoff the owner already sees.
        await db
          .update(forwarding_checks)
          .set({ started_at: ago(35) })
          .where(eq(forwarding_checks.id, checkId))
        return slow()
      },
    })
    expect(result).toBe('not_checked')
    expect(dialledIt).toBe(false)
    expect((await checkRow(checkId)).dialed_at).toBeNull()
  })

  test('a call from another number is a normal call; the check rings out', async () => {
    const { ws, checkId } = await startCheck('Wrong Caller Plumbing')
    const stranger = randomNumber()
    const { line: l } = line(async ({ linedeskNumber }) => {
      const other = await act(agent(), 'call.start', { from: stranger, to: linedeskNumber })
      expect(other.body.data.forwardingCheck).toBeUndefined()
      return { kind: 'failed', sipStatus: 480, message: 'Temporarily Unavailable' }
    })
    expect(await runForwardingCheck(checkId, { ...fast, line: l })).toBe('rang_through')
    expect(await callsFrom(ws.id, stranger)).toHaveLength(1)
    expect(await events(ws.id)).not.toContain('forwarding_verified')
  })

  test('each way the outbound call ends has its result', async () => {
    const outcomes: [DialOutcome, string][] = [
      [{ kind: 'failed', sipStatus: null, message: 'no answer (timed out)' }, 'rang_through'],
      [{ kind: 'answered' }, 'answered'],
      [{ kind: 'failed', sipStatus: 486, message: 'Busy Here' }, 'busy'],
      [{ kind: 'failed', sipStatus: 404, message: 'Not Found' }, 'unreachable'],
      [{ kind: 'failed', sipStatus: null, message: 'trunk not found' }, 'not_checked'],
    ]
    for (const [outcome, status] of outcomes) {
      const { checkId } = await startCheck(`Outcome ${status} Plumbing`)
      const { line: l, hungUp } = line(async () => outcome)
      expect(await runForwardingCheck(checkId, { ...fast, line: l })).toBe(status)
      const row = await checkRow(checkId)
      expect(row.status).toBe(status)
      // LiveKit's and the carrier's words stay in the log, never in what the business reads.
      if (outcome.kind === 'failed') expect(row.detail ?? '').not.toContain(outcome.message)
      if (status === 'not_checked') expect(row.detail).toBe('Could not check: the call could not be placed.')
      expect(hungUp).toHaveLength(1)
    }
  })

  test('no check line: not checked, the reason only in the log', async () => {
    const { checkId } = await startCheck('No Line Plumbing')
    const result = await runForwardingCheck(checkId, {
      ...fast,
      line: async () => ({ unavailable: 'LiveKit is not set up on this server' }),
    })
    expect(result).toBe('not_checked')
    expect((await checkRow(checkId)).detail).toBe(
      'Could not check: forwarding checks are not available on this server right now.',
    )
  })

  test('dev simulates each result by the last digit, through the same arrival path', async () => {
    const arrive = async (from: string, to: string) => {
      await db.transaction(tx => claimForwardingCheck(tx, { from, to, now: new Date().toISOString() }))
    }
    const timing = { forwardMs: 10, failMs: 10, noAnswerMs: 10 }
    for (const [digit, status] of [
      ['0', 'works'],
      ['2', 'rang_through'],
      ['3', 'answered'],
      ['4', 'busy'],
      ['5', 'unreachable'],
      ['6', 'no_assistant'],
    ] as const) {
      const { checkId } = await startCheck(
        `Dev ${digit} Plumbing`,
        `+1971555${Math.floor(100 + Math.random() * 800)}${digit}`,
      )
      const devLine = async (): Promise<CheckLine> => ({ callerNumber: CALLER, dialer: devDialer(arrive, timing) })
      expect(await runForwardingCheck(checkId, { ...fast, line: devLine })).toBe(status)
    }
  })
})

describe('the development carrier and a server that cannot check', () => {
  test('a simulated check records no milestone: not verified, nothing saved, marked simulated', async () => {
    const { ws, pn, checkId } = await startCheck(
      'Simulated Check Plumbing',
      `+1971555${Math.floor(100 + Math.random() * 800)}0`,
    )
    // The tests run under TELEPHONY_PROVIDER=dev: the install's real check line is the simulation.
    expect(await runForwardingCheck(checkId, { ...fast, line: () => installCheckLine() })).toBe('works')
    expect((await checkRow(checkId)).simulated).toBe(true)
    expect(await events(ws.id)).not.toContain('forwarding_verified')
    const number = await numberRow(pn.id)
    expect(number.verified_at).toBe(pn.verified_at)
    expect(number.forwarded_from).toBeNull()
    const read = await act(ws.owner, 'phoneNumber.forwardingCheck', { phoneNumberId: pn.id })
    expect(read.body.data).toMatchObject({
      check: { status: 'works', simulated: true },
      available: true,
      simulated: true,
    })
  })

  test('whether a check can run is answered without dialling; no line, no check offered', async () => {
    const ws = await createWorkspace('Availability Plumbing')
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    const read = await act(ws.owner, 'phoneNumber.forwardingCheck', { phoneNumberId: pn!.id })
    expect(read.body.data).toEqual({ check: null, available: true, simulated: true })
    let dialled = false
    const noDial: typeof fetch = async () => {
      dialled = true
      throw new Error('no network in this test')
    }
    // A carrier without LiveKit, and a carrier name without a forwarding check: unavailable, nothing asked or dialled.
    const telnyx = await db.transaction(tx => forwardingCheckAvailability(tx, { TELEPHONY_PROVIDER: 'telnyx' }, noDial))
    expect(telnyx).toEqual({ available: false, simulated: false })
    const unknown = await db.transaction(tx => forwardingCheckAvailability(tx, { TELEPHONY_PROVIDER: 'plivo' }, noDial))
    expect(unknown).toEqual({ available: false, simulated: false })
    expect(dialled).toBe(false)
  })
})

describe('matching and reading the carrier', () => {
  const check = { caller_number: CALLER, linedesk_number: '+15035550142', dialed_at: '2026-11-12T10:00:00.000Z' }
  const at = (seconds: number) => Date.parse(check.dialed_at) + seconds * 1000

  test('only our caller number to the check number, inside the window counted from the dial', () => {
    expect(arrivesFor(check, { from: CALLER, to: '+15035550142' }, at(20))).toBe(true)
    expect(arrivesFor(check, { from: '+12065550100', to: '+15035550142' }, at(20))).toBe(false)
    expect(arrivesFor(check, { from: CALLER, to: '+15035550143' }, at(20))).toBe(false)
    expect(arrivesFor(check, { from: CALLER, to: '+15035550142' }, at(-1))).toBe(false)
    expect(arrivesFor(check, { from: CALLER, to: '+15035550142' }, at(200))).toBe(false)
    expect(arrivesFor({ ...check, caller_number: null }, { from: CALLER, to: '+15035550142' }, at(20))).toBe(false)
    expect(arrivesFor({ ...check, dialed_at: null }, { from: CALLER, to: '+15035550142' }, at(20))).toBe(false)
  })

  test('a call can come from a check only while its call rings, or just after it ended', () => {
    const dialedAt = '2026-11-13T10:00:00.000Z'
    const t = (s: number) => Date.parse(dialedAt) + s * 1000
    expect(couldBeFrom({ dialed_at: dialedAt, finished_at: null }, t(30))).toBe(true)
    expect(couldBeFrom({ dialed_at: dialedAt, finished_at: null }, t(-1))).toBe(false)
    expect(couldBeFrom({ dialed_at: null, finished_at: null }, t(30))).toBe(false)
    const finished = new Date(t(40)).toISOString()
    expect(couldBeFrom({ dialed_at: dialedAt, finished_at: finished }, t(50))).toBe(true)
    expect(couldBeFrom({ dialed_at: dialedAt, finished_at: finished }, t(60))).toBe(false)
  })

  test('the SIP status of a LiveKit refusal and what it means', () => {
    expect(sipStatusOf(new LivekitError('x', 500, { msg: 'twirp error: sip status: 486: Busy Here' }))).toBe(486)
    expect(sipStatusOf(new LivekitError('x', 500, { meta: { sip_status_code: '480' } }))).toBe(480)
    expect(sipStatusOf(new Error('SIP status: 407 Proxy Authentication Required'))).toBe(407)
    expect(sipStatusOf(new Error('room not found'))).toBeNull()
    expect(failureStatus({ kind: 'failed', sipStatus: 600, message: '' })).toBe('busy')
    expect(failureStatus({ kind: 'failed', sipStatus: 487, message: '' })).toBe('rang_through')
    expect(failureStatus({ kind: 'failed', sipStatus: 407, message: '' })).toBeNull()
    expect(failureStatus({ kind: 'failed', sipStatus: 503, message: '' })).toBe('unreachable')
  })

  test('the line lookup names the carrier and the forwarding guide to show', async () => {
    const ws = await createWorkspace('Lookup Plumbing')
    const found = await act(ws.owner, 'phoneNumber.lookupLine', { number: businessNumber() })
    // The development carrier (the tests' TELEPHONY_PROVIDER) says so: the web app marks it as simulated.
    expect(found.body.data).toEqual({
      lineType: 'mobile',
      carrier: 'Verizon Wireless',
      carrierId: 'verizon',
      simulated: true,
    })
  })

  test('a number looked up once is answered from the cache, past the lookup limit', async () => {
    clearLineLookups()
    const ws = await createWorkspace('Cached Lookup Plumbing')
    const number = businessNumber()
    for (let i = 0; i < 12; i++)
      expect((await act(ws.owner, 'phoneNumber.lookupLine', { number })).body.data.carrierId).toBe('verizon')
    const fresh = await act(ws.owner, 'phoneNumber.lookupLine', { number: businessNumber() })
    expect(fresh.status).toBe(200)
  })
})

describe('a caller ID can be faked', () => {
  /** A check of `business` that works by our caller arriving on the workspace's number (or a faked caller ID). */
  async function works(name: string, business: string) {
    const started = await startCheck(name, business)
    const caller = ownCaller()
    await dialled(started.checkId, 0, caller)
    await arrive(caller, started.ws.number)
    expect((await checkRow(started.checkId)).status).toBe('works')
    return started
  }
  const transfer = (number: string) => ({
    id: 'desk',
    name: 'Desk',
    number,
    condition: 'Urgent',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
  })

  test('a business number another workspace saved never locks its real owner out', async () => {
    const victim = businessNumber()
    // Another workspace "verifies" the number, say with a faked caller ID.
    await works('Spoofing Plumbing', victim)
    const owner = await createWorkspace('Real Owner Plumbing')
    const [ownNumber] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, owner.id))
    // The real owner may still check it, save it from a working check, and use it as a transfer contact elsewhere.
    const started = await act(owner.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: ownNumber!.id,
      businessNumber: victim,
    })
    expect(started.status).toBe(200)
    const caller = ownCaller()
    await dialled(started.body.data.id, 0, caller)
    await arrive(caller, owner.number)
    expect((await numberRow(ownNumber!.id)).forwarded_from).toBe(victim)
    const third = await createWorkspace('Transfers To It Plumbing')
    const saved = await act(third.owner, 'assistant.update', {
      assistantId: third.assistant.id,
      transfers: [transfer(victim)],
    })
    expect(saved.status).toBe(200)
  })

  test('a transfer to the workspace’s own forwarded business line is still refused', async () => {
    const { ws, business } = await works('Own Loop Plumbing', businessNumber())
    const looping = await act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      transfers: [transfer(business)],
    })
    expect(looping).toMatchObject({ status: 409, body: { error: expect.stringContaining('forwards its calls') } })
  })

  test('a working check switches off a transfer contact on that business line', async () => {
    const business = businessNumber()
    const ws = await createWorkspace('Switch Off Plumbing')
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    await db
      .update(assistants)
      .set({ transfers: [transfer(business)] as never })
      .where(eq(assistants.id, ws.assistant.id))
    const started = await act(ws.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: pn!.id,
      businessNumber: business,
    })
    const caller = ownCaller()
    await dialled(started.body.data.id, 0, caller)
    await arrive(caller, ws.number)
    const [assistant] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
    expect(assistant!.transfers).toMatchObject([{ number: business, enabled: false }])
  })

  test('one arrival per check: a second call with our caller ID changes nothing', async () => {
    const { checkId, ws } = await works('One Arrival Plumbing', businessNumber())
    const before = await checkRow(checkId)
    const row = (await db.select().from(forwarding_checks).where(eq(forwarding_checks.id, checkId)))[0]!
    const again = await arrive(row.caller_number!, ws.number)
    expect(again?.id).toBe(checkId)
    expect(await checkRow(checkId)).toEqual(before)
  })
})

describe('line lookups', () => {
  test('the cache is per workspace: another workspace’s lookup of the same number reaches the carrier and counts', async () => {
    clearLineLookups()
    const number = businessNumber()
    const first = await createWorkspace('First Lookup Plumbing')
    const second = await createWorkspace('Second Lookup Plumbing')
    const counted = async (workspaceId: string) =>
      (await db.select().from(line_lookups).where(eq(line_lookups.workspace_id, workspaceId))).length
    expect((await act(first.owner, 'phoneNumber.lookupLine', { number })).status).toBe(200)
    expect((await act(first.owner, 'phoneNumber.lookupLine', { number })).status).toBe(200)
    expect(await counted(first.id)).toBe(1)
    expect((await act(second.owner, 'phoneNumber.lookupLine', { number })).status).toBe(200)
    expect(await counted(second.id)).toBe(1)
  })

  test('a daily limit per workspace and one for the install, kept in the database', async () => {
    clearLineLookups()
    const ws = await createWorkspace('Daily Lookups Plumbing')
    const rows = (workspaceId: string, n: number) =>
      Array.from({ length: n }, () => ({
        id: `llk_${crypto.randomUUID().replaceAll('-', '')}`,
        workspace_id: workspaceId,
        number: businessNumber(),
      }))
    await db.insert(line_lookups).values(rows(ws.id, LINE_LOOKUPS_PER_WORKSPACE_DAY))
    const over = await act(ws.owner, 'phoneNumber.lookupLine', { number: businessNumber() })
    expect(over.body.error).toMatch(/Too many lookups today/)
    // An older lookup no longer counts.
    await db
      .update(line_lookups)
      .set({ looked_up_at: ago(25 * 3600) })
      .where(eq(line_lookups.workspace_id, ws.id))
    expect((await act(ws.owner, 'phoneNumber.lookupLine', { number: businessNumber() })).status).toBe(200)
    // The install's ceiling, whichever workspaces made them.
    const filler = await createWorkspace('Filler Lookups Plumbing')
    const ids = rows(filler.id, LINE_LOOKUPS_PER_INSTALL_DAY)
    await db.insert(line_lookups).values(ids)
    try {
      const paused = await act(ws.owner, 'phoneNumber.lookupLine', { number: businessNumber() })
      expect(paused.body.error).toMatch(/paused on this server/)
    } finally {
      await db.delete(line_lookups).where(
        inArray(
          line_lookups.id,
          ids.map(r => r.id),
        ),
      )
    }
  })

  test('a carrier error is logged, not shown', async () => {
    clearLineLookups()
    const ws = await createWorkspace('Lookup Error Plumbing')
    const failing = forwardingCheckHandlers(async () => {})['phoneNumber.lookupLine']!
    const actor = { workspaceId: ws.id } as never
    const telephony = {
      lookupNumber: async () => {
        throw new TelephonyError('twilio', '20003: Authenticate (account AC123)')
      },
    } as never
    await expect(
      failing({ tx: db, actor, telephony, now: new Date().toISOString() } as never, { number: businessNumber() }),
    ).rejects.toThrow('The line could not be looked up. Try again later.')
  })
})

test('a check number from Server admin: E.164 stays as written, only a bare ten-digit number is North American', () => {
  expect(asE164('+4930123456')).toBe('+4930123456') // ten digits after the +: German, never +1 493 012 3456
  expect(asE164('+49 30 1234 5678')).toBe('+493012345678')
  expect(asE164('0049 30 1234 5678')).toBe('+493012345678')
  expect(asE164('(503) 555-0142')).toBe('+15035550142')
  expect(asE164('1 503 555 0142')).toBe('+15035550142')
  expect(asE164('+1 503 555 0142')).toBe('+15035550142')
  expect(asE164('12345')).toBeNull()
  expect(asE164(null)).toBeNull()
})
