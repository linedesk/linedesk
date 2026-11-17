import { actions, DESTRUCTIVE_ACTIONS, providerNames, rolePermissions } from '@linedesk/actions'
import { createHash } from 'node:crypto'
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
    insert: () => ({
      values: () => record('insert', Object.assign(Promise.resolve(), { onConflictDoNothing: async () => {} })),
    }),
    transaction: (run: (tx: unknown) => unknown) => run(db),
  }
  return { state, db, runHandler: vi.fn() }
})
vi.mock('./db.ts', () => ({ db: fake.db }))
vi.mock('./handlers.ts', () => {
  class Reject extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      if (code) this.code = code
    }
  }
  return {
    Reject,
    Forbidden: class Forbidden extends Reject {},
    NotFound: class NotFound extends Reject {},
    runHandler: fake.runHandler,
    preparers: {},
  }
})

const { canonicalJson, commandInputHash, runAction } = await import('./run-action.ts')
const { Forbidden, NotFound, Reject } = await import('./handlers.ts')

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

  it('keeps the code of a rejection, for the web app to say it in its own words', async () => {
    fake.runHandler.mockRejectedValue(new Reject('this assistant books into its own calendars', 'BOOKING_MODE'))
    expect(await findSlots()).toEqual({
      status: 409,
      body: { ok: false, error: 'this assistant books into its own calendars', code: 'BOOKING_MODE' },
    })
  })

  it('turns a refusal of who asks into 403 with its code', async () => {
    fake.runHandler.mockRejectedValue(new Forbidden('only an owner can do that'))
    expect(await findSlots()).toEqual({
      status: 403,
      body: { ok: false, error: 'only an owner can do that', code: 'forbidden' },
    })
  })

  it('turns a missing row into 404 with its code', async () => {
    fake.runHandler.mockRejectedValue(new NotFound('no such checkout'))
    expect(await findSlots()).toEqual({
      status: 404,
      body: { ok: false, error: 'no such checkout', code: 'not_found' },
    })
  })

  it('lets unexpected errors through', async () => {
    fake.runHandler.mockRejectedValue(new Error('connection lost'))
    await expect(findSlots()).rejects.toThrow('connection lost')
  })

  it('still validates input and checks the permission', async () => {
    expect((await runAction('calendar.findSlots', {}, member)).status).toBe(422)
    expect(
      await runAction('calendar.findSlots', { appointmentTypeId: 'at_1' }, { ...member, permissions: [] }),
    ).toEqual({
      status: 403,
      body: { ok: false, error: 'missing permission calendar:read', code: 'forbidden' },
    })
    expect(fake.runHandler).not.toHaveBeenCalled()
  })

  it('refuses fields an action does not take from API keys, and drops them with a warning for our own clients', async () => {
    const input = { appointmentTypeId: 'at_1', voice_provider: 'x' }
    expect(await runAction('calendar.findSlots', input, { ...member, apiKeyId: 'key_1' })).toEqual({
      status: 422,
      body: { ok: false, error: 'This action does not take the field voice_provider.', code: 'UNKNOWN_FIELDS' },
    })
    expect(fake.runHandler).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await runAction('calendar.findSlots', input, { ...member, sessionId: 'sess_1' })).status).toBe(200)
    expect(fake.runHandler.mock.calls[0]![2]).not.toHaveProperty('voice_provider')
    expect(warn).toHaveBeenCalledWith('calendar.findSlots: ignored input fields it does not take: voice_provider')
    warn.mockRestore()
  })
})

describe('runAction: destructive actions refuse unknown fields from everyone (security review F2 of #756)', () => {
  const valid: Record<(typeof DESTRUCTIVE_ACTIONS)[number], Record<string, unknown>> = {
    'workspace.delete': { workspaceId: 'ws_1', name: 'Brightwater Plumbing & Heating' },
    'workspace.deleteOwn': { name: 'Brightwater Plumbing & Heating' },
    'membership.remove': { memberId: 'mem_1' },
    'team.removeMember': { memberId: 'mem_1' },
    'team.leave': {},
    'phoneNumber.release': { phoneNumberId: 'pn_1', confirm: '+1 503 555 0100' },
    'apiKey.revoke': { apiKeyId: 'key_1' },
    'personalKey.revoke': { personalKeyId: 'pk_1' },
    'agentSetup.revoke': {},
    'agentSetup.revokeWorkspace': {},
    'agentSetup.endOwnAccess': {},
    'webhook.delete': { endpointId: 'wh_1' },
    'integration.remove': { subscriptionId: 'sub_1' },
    'calendar.disconnect': { connectionId: 'cal_1' },
    'user.resetPasskeys': { userId: 'user_2' },
    'account.authenticatorRemove': {},
    'provider.clearKeys': { provider: providerNames[0] },
  }
  // A browser session that may run every action (instance admin passkey-confirmed, owner): only the input is wrong.
  const everything: Actor = {
    actorId: 'user_1',
    role: 'owner',
    workspaceId: 'ws_1',
    sessionId: 'sess_1',
    passkeyConfirmed: true,
    permissions: [...new Set([...actions.values()].map(def => def.permission))],
  }

  it.each(DESTRUCTIVE_ACTIONS)('%s: 422 UNKNOWN_FIELDS for a browser session, nothing runs', async name => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runAction(name, { ...valid[name], keepUsers: true }, everything, 'cmd_1')).toEqual({
      status: 422,
      body: { ok: false, error: 'This action does not take the field keepUsers.', code: 'UNKNOWN_FIELDS' },
    })
    expect(fake.runHandler).not.toHaveBeenCalled()
    expect(fake.state.log).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('names every unknown field; an unknown field with another problem says both', async () => {
    expect(
      await runAction('team.removeMember', { memberId: 'mem_1', keepAccount: true, reason: 'x' }, everything),
    ).toEqual({
      status: 422,
      body: { ok: false, error: 'This action does not take the fields keepAccount, reason.', code: 'UNKNOWN_FIELDS' },
    })
    const both = await runAction('team.removeMember', { keepAccount: true }, everything)
    expect(both.status).toBe(422)
    expect(both.body).not.toHaveProperty('code')
    expect(both.body).toMatchObject({
      error: expect.stringContaining('This action does not take the field keepAccount.'),
    })
  })

  it('other actions still drop an unknown field from a browser session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await runAction('call.markDone', { callId: 'call_1', extra: 1 }, everything, 'cmd_2')).status).toBe(200)
    expect(warn).toHaveBeenCalledWith('call.markDone: ignored input fields it does not take: extra')
    warn.mockRestore()
  })
})

describe('runAction: writing actions', () => {
  it('looks the command up and records it', async () => {
    expect((await markDone()).status).toBe(200)
    expect(fake.state.log).toEqual(['select', 'insert'])
  })

  it('replays a stored result without running the handler again', async () => {
    fake.state.seen = [
      { workspace_id: 'ws_1', action: 'call.markDone', rejected: false, result: { ok: true, rows: {} } },
    ]
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
    fake.state.seen = [
      {
        workspace_id: 'ws_1',
        action: 'call.markDone',
        rejected: true,
        result: { ok: false, error: 'calls row not found' },
      },
    ]
    expect((await markDone()).status).toBe(409)
  })
})

describe('commandInputHash (security review of #1116, M-1)', () => {
  const env = { BETTER_AUTH_SECRET: 'unit-test-secret-unit-test-secret' }
  const def = { sensitive: ['pin'] }
  const input = { phoneNumberId: 'pn_1', pin: '1234' }
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

  it('is keyed: never the plain SHA-256 of the input, redacted or not, and another secret gives another hash', () => {
    const hash = commandInputHash(def, input, env)!
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(sha256(canonicalJson(input)))
    expect(hash).not.toBe(sha256(canonicalJson({ ...input, pin: '[redacted]' })))
    expect(commandInputHash(def, input, { BETTER_AUTH_SECRET: 'another-secret-another-secret-00' })).not.toBe(hash)
  })

  it('a sensitive field never changes it; any other field does', () => {
    const hash = commandInputHash(def, input, env)
    expect(commandInputHash(def, { ...input, pin: '9999' }, env)).toBe(hash)
    expect(commandInputHash(def, { ...input, phoneNumberId: 'pn_2' }, env)).not.toBe(hash)
    expect(commandInputHash(def, { pin: '1234', phoneNumberId: 'pn_1' }, env)).toBe(hash)
  })

  it('is none without the server secret: a reused key replays as before', () => {
    expect(commandInputHash(def, input, {})).toBeNull()
  })
})
