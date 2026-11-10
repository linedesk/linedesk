// Handlers whose outcome depends on the carrier or on time: they run directly, with the provider
// passed in, inside a transaction that is rolled back. Part of the Postgres-backed API suite.
import { actions, rolePermissions } from '@callfront/actions'
import { calls, type Tx } from '@callfront/db'
import { devProvider, TelephonyError, type TelephonyProvider } from '@callfront/telephony'
import { eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Reject, runHandler } from '../src/handlers.ts'

const WORKSPACE = `ws_test_${crypto.randomUUID().slice(0, 8)}`
const owner: Actor = { actorId: 'user_test', role: 'owner', workspaceId: WORKSPACE, permissions: rolePermissions.owner }
const agent: Actor = { actorId: 'agent', role: 'agent', workspaceId: null, permissions: rolePermissions.agent }

class Rollback extends Error {}

/** The dev provider with spies, and overrides for the step that should fail. */
const provider = (overrides: Partial<TelephonyProvider> = {}) => {
  const spied = { ...devProvider, ...overrides }
  return { ...spied, buyNumber: vi.fn(spied.buyNumber), routeToSip: vi.fn(spied.routeToSip), releaseNumber: vi.fn(spied.releaseNumber) }
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

  test('phoneNumber.setup stores a number from the provider', () => inRollback(async tx => {
    const { rows } = await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550999' })
    expect(rows.phone_numbers).toMatchObject([{ workspace_id: WORKSPACE, e164: '+15035550999', provider: 'dev', mode: 'new', provider_ref: 'dev_+15035550999' }])
    const again = provider()
    await expect(run(tx, owner, 'phoneNumber.setup', { e164: '+15035550999' }, again)).rejects.toThrow('already set up')
    expect(again.buyNumber).not.toHaveBeenCalled()
  }))

  test('phoneNumber.setup picks a number by area code and needs a workspace', () => inRollback(async tx => {
    const { rows } = await run(tx, owner, 'phoneNumber.setup', { areaCode: '971' })
    expect(rows.phone_numbers?.[0]?.e164).toMatch(/^\+1971/)
    await expect(run(tx, agent, 'phoneNumber.setup', { areaCode: '971' })).rejects.toThrow('no workspace')
    await expect(run(tx, owner, 'phoneNumber.setup', { areaCode: '971' }, provider({ searchNumbers: async () => [] }))).rejects.toThrow('no number available in area code 971')
  }))

  test('phoneNumber.setup releases a number it bought when routing fails', () => inRollback(async tx => {
    const failing = provider({ routeToSip: async () => { throw new TelephonyError('dev', 'SIP connection refused') } })
    const error = await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550997' }, failing).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('dev: SIP connection refused; +15035550997 was released')
    expect(failing.releaseNumber).toHaveBeenCalledWith({ e164: '+15035550997', providerRef: 'dev_+15035550997', purchased: true })
  }))

  test('phoneNumber.setup keeps a number the account already owned, and says so when release fails', () => inRollback(async tx => {
    const routeFails = async () => { throw new TelephonyError('dev', 'SIP connection refused') }
    const preOwned = provider({ routeToSip: routeFails, buyNumber: async e164 => ({ e164, providerRef: 'ref_1', purchased: false }) })
    await expect(run(tx, owner, 'phoneNumber.setup', { e164: '+15035550996' }, preOwned)).rejects.toThrow('+15035550996 stays on the carrier account, set it up again to finish')
    expect(preOwned.releaseNumber).not.toHaveBeenCalled()

    const stuck = provider({ routeToSip: routeFails, releaseNumber: async () => { throw new TelephonyError('dev', 'release refused') } })
    await expect(run(tx, owner, 'phoneNumber.setup', { e164: '+15035550996' }, stuck)).rejects.toThrow('releasing +15035550996 failed too (dev: release refused)')
  }))

  test('phoneNumber.setup: a failed or pending purchase is a rejection and stores nothing', () => inRollback(async tx => {
    const pending = provider({ buyNumber: async () => { throw new TelephonyError('dev', 'number order o1 is still pending') } })
    await expect(run(tx, owner, 'phoneNumber.setup', { e164: '+15035550995' }, pending)).rejects.toThrow(Reject)
    expect(pending.routeToSip).not.toHaveBeenCalled()
    expect(pending.releaseNumber).not.toHaveBeenCalled()
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
