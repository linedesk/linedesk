import { rolePermissions } from '@linedesk/actions'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './context.ts'

// A stand-in for the database that only records which statements run against `commands`.
const fake = vi.hoisted(() => {
  const state = { log: [] as string[], seen: [] as unknown[] }
  const record = <T>(statement: string, result: T) => {
    state.log.push(statement)
    return result
  }
  const db = {
    select: () => ({ from: () => ({ where: async () => record('select', state.seen) }) }),
    insert: () => ({ values: () => record('insert', Object.assign(Promise.resolve(), { onConflictDoNothing: async () => {} })) }),
    transaction: (run: (tx: unknown) => unknown) => run(db),
  }
  return { state, db, runHandler: vi.fn() }
})
vi.mock('./db.ts', () => ({ db: fake.db }))
vi.mock('./handlers.ts', () => {
  class Reject extends Error {}
  return { Reject, Forbidden: class Forbidden extends Reject {}, runHandler: fake.runHandler, preparers: {} }
})

const { runAction } = await import('./run-action.ts')
const { Forbidden, Reject } = await import('./handlers.ts')

const member: Actor = { actorId: 'user_1', role: 'member', workspaceId: 'ws_1', permissions: rolePermissions.member }
const findSlots = () => runAction('calendar.findSlots', { appointmentTypeId: 'at_1' }, member, 'cmd_1')
const markDone = () => runAction('call.markDone', { callId: 'call_1' }, member, 'cmd_1')

beforeEach(() => {
  fake.state.log = []
  fake.state.seen = []
  fake.runHandler.mockReset().mockResolvedValue({ rows: {}, data: { slots: [] } })
})

describe('runAction: read-only actions', () => {
  it('returns the result without reading or writing the command log', async () => {
    expect(await findSlots()).toEqual({ status: 200, body: { ok: true, rows: {}, data: { slots: [] } } })
    expect(fake.state.log).toEqual([])
  })

  it('runs again on a repeated command id instead of replaying a stored result', async () => {
    await findSlots()
    await findSlots()
    expect(fake.runHandler).toHaveBeenCalledTimes(2)
  })

  it('turns a rejection into 409 without logging it', async () => {
    fake.runHandler.mockRejectedValue(new Reject('appointment type not found'))
    expect(await findSlots()).toEqual({ status: 409, body: { ok: false, error: 'appointment type not found' } })
    expect(fake.state.log).toEqual([])
  })

  it('turns a refusal of who asks into 403 with its code', async () => {
    fake.runHandler.mockRejectedValue(new Forbidden('only an owner can do that'))
    expect(await findSlots()).toEqual({ status: 403, body: { ok: false, error: 'only an owner can do that', code: 'forbidden' } })
  })

  it('lets unexpected errors through', async () => {
    fake.runHandler.mockRejectedValue(new Error('connection lost'))
    await expect(findSlots()).rejects.toThrow('connection lost')
  })

  it('still validates input and checks the permission', async () => {
    expect((await runAction('calendar.findSlots', {}, member)).status).toBe(422)
    expect(await runAction('calendar.findSlots', { appointmentTypeId: 'at_1' }, { ...member, permissions: [] })).toEqual({
      status: 403,
      body: { ok: false, error: 'missing permission calendar:read', code: 'forbidden' },
    })
    expect(fake.runHandler).not.toHaveBeenCalled()
  })

  it('refuses fields an action does not take from API keys, and drops them with a warning for our own clients', async () => {
    const input = { appointmentTypeId: 'at_1', voice_provider: 'x' }
    expect(await runAction('calendar.findSlots', input, { ...member, apiKeyId: 'key_1' })).toEqual({
      status: 422,
      body: { ok: false, error: 'This action does not take the field voice_provider.' },
    })
    expect(fake.runHandler).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await runAction('calendar.findSlots', input, { ...member, sessionId: 'sess_1' })).status).toBe(200)
    expect(fake.runHandler.mock.calls[0]![2]).not.toHaveProperty('voice_provider')
    expect(warn).toHaveBeenCalledWith('calendar.findSlots: ignored input fields it does not take: voice_provider')
    warn.mockRestore()
  })
})

describe('runAction: writing actions', () => {
  it('looks the command up and records it', async () => {
    expect((await markDone()).status).toBe(200)
    expect(fake.state.log).toEqual(['select', 'insert'])
  })

  it('replays a stored result without running the handler again', async () => {
    fake.state.seen = [{ workspace_id: 'ws_1', action: 'call.markDone', rejected: false, result: { ok: true, rows: {} } }]
    expect(await markDone()).toEqual({ status: 200, body: { ok: true, rows: {} } })
    expect(fake.runHandler).not.toHaveBeenCalled()
    expect(fake.state.log).toEqual(['select'])
  })

  it('records a rejection', async () => {
    fake.runHandler.mockRejectedValue(new Reject('calls row not found'))
    expect((await markDone()).status).toBe(409)
    expect(fake.state.log).toEqual(['select', 'insert'])
  })

  it('replays a refusal of who asks as 403, a conflict as 409', async () => {
    const refused = { ok: false, error: 'only an owner can do that', code: 'forbidden' }
    fake.state.seen = [{ workspace_id: 'ws_1', action: 'call.markDone', rejected: true, result: refused }]
    expect(await markDone()).toEqual({ status: 403, body: refused })
    fake.state.seen = [{ workspace_id: 'ws_1', action: 'call.markDone', rejected: true, result: { ok: false, error: 'calls row not found' } }]
    expect((await markDone()).status).toBe(409)
  })
})
