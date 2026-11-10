// Handlers whose outcome depends on the carrier or on time: they run directly, with the provider
// passed in, inside a transaction that is rolled back. Part of the Postgres-backed API suite.
import { actions, rolePermissions } from '@callfront/actions'
import { calls, phone_numbers, type Tx } from '@callfront/db'
import { devProvider, TelephonyError, type TelephonyProvider } from '@callfront/telephony'
import { eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Reject, runHandler, type Undo } from '../src/handlers.ts'

const WORKSPACE = `ws_test_${crypto.randomUUID().slice(0, 8)}`
const owner: Actor = { actorId: 'user_test', role: 'owner', workspaceId: WORKSPACE, permissions: rolePermissions.owner }
const agent: Actor = { actorId: 'agent', role: 'agent', workspaceId: null, permissions: rolePermissions.agent }

class Rollback extends Error {}

/** A carrier account in memory, with spies: `owned` are the numbers already in it. Overrides make a step fail. */
function carrier(owned: string[] = [], overrides: Partial<TelephonyProvider> = {}) {
  const account = new Set(owned)
  const base: TelephonyProvider = {
    ...devProvider,
    findNumber: async e164 => (account.has(e164) ? { e164, providerRef: `ref_${e164}` } : null),
    buyNumber: async e164 => {
      account.add(e164)
      return { e164, providerRef: `ref_${e164}` }
    },
    releaseNumber: async number => void account.delete(number.e164),
    ...overrides,
  }
  return {
    ...base, account,
    findNumber: vi.fn(base.findNumber), buyNumber: vi.fn(base.buyNumber), routeToSip: vi.fn(base.routeToSip), unrouteNumber: vi.fn(base.unrouteNumber), releaseNumber: vi.fn(base.releaseNumber),
  }
}

describe('telephony handlers', () => {
  const run = (tx: Tx, actor: Actor, name: string, input: unknown, telephony: TelephonyProvider = devProvider) =>
    runHandler({ tx, actor, now: new Date().toISOString(), telephony }, actions.get(name)!, actions.get(name)!.input.parse(input))

  async function inRollback(body: (tx: Tx) => Promise<void>) {
    await db.transaction(async tx => {
      await body(tx)
      throw new Rollback()
    }).catch(e => {
      if (!(e instanceof Rollback)) throw e
    })
  }

  /** Runs phoneNumber.setup like the API does: undos registered by the handler run when it fails. */
  async function setup(tx: Tx, input: unknown, telephony: TelephonyProvider, actor: Actor = owner) {
    const undos: Undo[] = []
    const def = actions.get('phoneNumber.setup')!
    try {
      return await runHandler({ tx, actor, now: new Date().toISOString(), telephony, onRollback: undo => undos.push(undo) }, def, def.input.parse(input))
    } catch (e) {
      const notes = await Promise.all(undos.map(undo => undo()))
      throw Object.assign(e as Error, { notes })
    }
  }

  test('attaches a number that is in the carrier account, and never buys', () => inRollback(async tx => {
    const twilio = carrier(['+15035550999'])
    const { rows } = await setup(tx, { e164: '+15035550999' }, twilio)
    expect(rows.phone_numbers).toMatchObject([{ workspace_id: WORKSPACE, e164: '+15035550999', provider: 'dev', mode: 'forward_conditional', provider_ref: 'ref_+15035550999', verified_at: null }])
    expect(twilio.routeToSip).toHaveBeenCalledWith({ e164: '+15035550999', providerRef: 'ref_+15035550999' }, expect.any(String))
    expect(twilio.buyNumber).not.toHaveBeenCalled()

    await expect(setup(tx, { e164: '+15035550999' }, twilio)).rejects.toThrow('already set up')
    expect((await setup(tx, { e164: '+15035550990', mode: 'ported' }, carrier(['+15035550990']))).rows.phone_numbers?.[0]?.mode).toBe('ported')
  }))

  test('a number that is not in the account is rejected, not bought: a typo costs nothing', () => inRollback(async tx => {
    const twilio = carrier(['+15035550999'])
    const error = await setup(tx, { e164: '+15035550998' }, twilio).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('+15035550998 is not in the dev account. Check the number; to buy it, pass purchase: true')
    expect(twilio.buyNumber).not.toHaveBeenCalled()
    expect(twilio.routeToSip).not.toHaveBeenCalled()
  }))

  test('buys only with purchase: true, by number or by area code', () => inRollback(async tx => {
    const twilio = carrier()
    const bought = await setup(tx, { e164: '+15035550997', purchase: true }, twilio)
    expect(bought.rows.phone_numbers).toMatchObject([{ e164: '+15035550997', mode: 'new', provider_ref: 'ref_+15035550997' }])
    expect(bought.rows.phone_numbers?.[0]?.verified_at).toBeTruthy()
    expect(twilio.buyNumber).toHaveBeenCalledWith('+15035550997')

    const byArea = await setup(tx, { areaCode: '971', purchase: true }, twilio)
    expect(byArea.rows.phone_numbers?.[0]?.e164).toMatch(/^\+1971/)
    expect(twilio.buyNumber).toHaveBeenCalledTimes(2)

    const owned = carrier(['+15035550996'])
    await setup(tx, { e164: '+15035550996', purchase: true }, owned) // already ours: attach, do not buy again
    expect(owned.buyNumber).not.toHaveBeenCalled()

    const def = actions.get('phoneNumber.setup')!
    expect(def.input.safeParse({ areaCode: '971' }).success).toBe(false) // an area code alone would mean buying
    expect(def.input.safeParse({}).success).toBe(false)
    await expect(setup(tx, { areaCode: '971', purchase: true }, carrier([], { searchNumbers: async () => [] }))).rejects.toThrow('no number available in area code 971')
    await expect(setup(tx, { e164: '+15035550995' }, carrier(['+15035550995']), agent)).rejects.toThrow('no workspace')
  }))

  test('a bought number is released when a later step fails; an attached one is left alone', () => inRollback(async tx => {
    const routeFails = async () => { throw new TelephonyError('dev', 'SIP connection refused') }
    const buying = carrier([], { routeToSip: routeFails })
    const error = await setup(tx, { e164: '+15035550994', purchase: true }, buying).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('dev: SIP connection refused')
    expect(error.notes).toEqual(['+15035550994 was released'])
    expect(buying.releaseNumber).toHaveBeenCalledWith({ e164: '+15035550994', providerRef: 'ref_+15035550994' })
    expect(buying.account.has('+15035550994')).toBe(false)

    const attaching = carrier(['+15035550993'], { routeToSip: routeFails })
    const attachError = await setup(tx, { e164: '+15035550993' }, attaching).catch(e => e)
    expect(attachError.notes).toEqual([])
    expect(attaching.releaseNumber).not.toHaveBeenCalled()

    const stuck = carrier([], { routeToSip: routeFails, releaseNumber: async () => { throw new TelephonyError('dev', 'release refused') } })
    const stuckError = await setup(tx, { e164: '+15035550992', purchase: true }, stuck).catch(e => e)
    expect(stuckError.notes).toEqual(['releasing +15035550992 failed (dev: release refused): release it at the carrier, or set it up again'])
  }))

  test('a failed purchase is a rejection, stores nothing and has nothing to release', () => inRollback(async tx => {
    const failing = carrier([], { buyNumber: async () => { throw new TelephonyError('dev', 'number order o1 failed') } })
    const error = await setup(tx, { e164: '+15035550991', purchase: true }, failing).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.notes).toEqual([])
    expect(failing.routeToSip).not.toHaveBeenCalled()
  }))

  /** A number row as phoneNumber.setup leaves it; `purchased` says whether Linedesk bought it. */
  async function numberRow(tx: Tx, e164: string, values: Partial<typeof phone_numbers.$inferInsert> = {}) {
    const [row] = await tx.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID().slice(0, 12)}`, workspace_id: WORKSPACE, e164, provider: 'telnyx', provider_ref: `ref_${e164}`, ...values }).returning()
    return row!
  }
  const telnyx = (owned: string[] = [], overrides: Partial<TelephonyProvider> = {}) => Object.assign(carrier(owned, overrides), { name: 'telnyx' as const })
  const stillThere = async (tx: Tx, id: string) => (await tx.select().from(phone_numbers).where(eq(phone_numbers.id, id))).length === 1

  test('release: an attached number stays with the business but is taken off Linedesk\'s routing', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550881')
    const account = telnyx(['+15035550881'])
    const { data } = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '(503) 555-0881' }, account)
    expect(data).toEqual({ releasedAtCarrier: false, unroutedAtCarrier: true })
    expect(account.releaseNumber).not.toHaveBeenCalled()
    expect(account.unrouteNumber).toHaveBeenCalledWith({ e164: '+15035550881', providerRef: 'ref_+15035550881' })
    expect(account.account.has('+15035550881')).toBe(true)
    // At another carrier than the one in use: only detached here, never touched at the wrong carrier.
    const elsewhere = await numberRow(tx, '+15035550886', { provider: 'twilio' })
    const other = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: elsewhere.id, confirm: '5035550886' }, account)
    expect(other.data).toEqual({ releasedAtCarrier: false, unroutedAtCarrier: false })
    expect(account.unrouteNumber).toHaveBeenCalledOnce()
    expect(await stillThere(tx, row.id)).toBe(false)
  }))

  test('release: a number Linedesk bought goes back to the carrier', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550882', { purchased: true, mode: 'new' })
    const account = telnyx(['+15035550882'])
    const { data } = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '+1 503 555 0882' }, account)
    expect(data).toEqual({ releasedAtCarrier: true, unroutedAtCarrier: false })
    expect(account.unrouteNumber).not.toHaveBeenCalled()
    expect(account.releaseNumber).toHaveBeenCalledWith({ e164: '+15035550882', providerRef: 'ref_+15035550882' })
    expect(account.account.has('+15035550882')).toBe(false)
    expect(await stillThere(tx, row.id)).toBe(false)
  }))

  test('release: the typed number must match; other workspaces, the agent and another carrier are refused', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550883', { purchased: true })
    const account = telnyx(['+15035550883'])
    await expect(run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '503 555 0884' }, account)).rejects.toThrow('type the number +15035550883 to confirm')
    const stranger: Actor = { ...owner, workspaceId: `ws_other_${crypto.randomUUID().slice(0, 8)}` }
    await expect(run(tx, stranger, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, account)).rejects.toThrow('phone number not found')
    await expect(run(tx, agent, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, account)).rejects.toThrow('no workspace')
    // Bought at Telnyx while Twilio is in use: never released at the wrong carrier.
    const twilio = Object.assign(carrier(['+15035550883']), { name: 'twilio' as const })
    await expect(run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, twilio)).rejects.toThrow('telnyx, but twilio is the carrier in use')
    expect(twilio.releaseNumber).not.toHaveBeenCalled()
    expect(account.releaseNumber).not.toHaveBeenCalled()
    expect(rolePermissions.member).not.toContain(actions.get('phoneNumber.release')!.permission)
  }))

  test('release: when the carrier refuses, the release is rejected (and the transaction keeps the number)', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550885', { purchased: true })
    const refusing = telnyx(['+15035550885'], { releaseNumber: async () => { throw new TelephonyError('telnyx', 'number has an open port request') } })
    const error = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550885' }, refusing).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('telnyx: number has an open port request')
  }))

  test('setup marks bought numbers as purchased and attached ones not', () => inRollback(async tx => {
    expect((await setup(tx, { e164: '+15035550886', purchase: true }, carrier())).rows.phone_numbers?.[0]?.purchased).toBe(true)
    expect((await setup(tx, { e164: '+15035550887' }, carrier(['+15035550887']))).rows.phone_numbers?.[0]?.purchased).toBe(false)
  }))

  test('a carrier that is selected but not configured is a rejection naming what is missing', () => inRollback(async tx => {
    const saved = { ...process.env }
    const unconfigured = () => runHandler({ tx, actor: owner, now: new Date().toISOString() }, actions.get('phoneNumber.setup')!, { e164: '+15035550993', purchase: false })
    try {
      Object.assign(process.env, { TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '' })
      await expect(unconfigured()).rejects.toThrow('phone setup is not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN not set')
      Object.assign(process.env, { TELEPHONY_PROVIDER: 'nobody' })
      await expect(unconfigured()).rejects.toThrow(Reject)
    } finally {
      Object.assign(process.env, saved)
    }
  }))

  test('a call on the new number: takeMessage appends action items, flagUrgent sets urgency', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const { data } = await run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const scoped = { ...agent, workspaceId: data!.workspaceId as string }
    const callId = data!.callId as string

    await run(tx, scoped, 'call.takeMessage', { callId, message: 'Call back about the quote' })
    const taken = await run(tx, scoped, 'call.takeMessage', { callId, message: 'Prefers mornings' })
    expect(taken.rows.calls?.[0]?.action_items).toEqual([{ text: 'Call back about the quote' }, { text: 'Prefers mornings' }])

    const flagged = await run(tx, scoped, 'call.flagUrgent', { callId })
    expect(flagged.rows.calls?.[0]?.urgency).toBe('urgent')
  }))

  test('agent calls need the workspace of the call, except call.start', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const { data } = await run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const callId = data!.callId as string
    const other = { ...agent, workspaceId: 'ws_other' }

    for (const actor of [agent, other]) {
      await expect(run(tx, actor, 'call.appendTranscript', { callId, speaker: 'caller', text: 'Hi', atMs: 0 })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.takeMessage', { callId, message: 'Hi' })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.flagUrgent', { callId })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.finish', { callId })).rejects.toThrow(Reject)
    }
    await expect(run(tx, agent, 'call.finish', { callId })).rejects.toThrow('send x-workspace-id')
  }))

  test('call.start completes calls of the workspace that have been live for hours', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const start = () => run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const lost = (await start()).data!.callId as string
    const recent = (await start()).data!.callId as string
    await tx.update(calls).set({ started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }).where(eq(calls.id, lost))

    const { rows } = await start()
    expect(rows.calls).toHaveLength(2)
    expect(rows.calls?.[1]).toMatchObject({ id: lost, status: 'completed', outcome: 'answered', title: 'Call ended without a summary' })
    const [stillLive] = await tx.select().from(calls).where(eq(calls.id, recent))
    expect(stillLive?.status).toBe('live')
  }))
})
