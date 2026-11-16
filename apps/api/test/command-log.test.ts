// What the command log keeps (apps/api/src/command-log.ts): rows by id, the agent's per-call actions
// by ids only, nothing personal once a call or contact is deleted, invitation ids redacted, and after
// 90 days only ids, except for the audited actions.
import { commands, contacts } from '@linedesk/db'
import { eq, inArray } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { COMMAND_INPUT_RETENTION_DAYS, idsOnly, OMITTED, pruneOldCommands } from '../src/command-log.ts'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Command Log Plumbing')
})

const logged = async (key: string) => (await db.select().from(commands).where(eq(commands.id, key)))[0]!
const text = (value: unknown) => JSON.stringify(value)

test('idsOnly keeps ids, numbers and booleans and says which other fields there were', () => {
  expect(
    idsOnly({ callId: 'c1', text: 'my address is 12 Elm', atMs: 5, toolEvent: { name: 'x' }, urgent: true }),
  ).toEqual({
    callId: 'c1',
    text: OMITTED,
    atMs: 5,
    toolEvent: OMITTED,
    urgent: true,
  })
  expect(idsOnly(null)).toEqual({})
})

describe('what is written', () => {
  test("the agent's per-call actions keep only ids: no transcript line, message or summary", async () => {
    const callId = ws.call.id
    const keys = { line: crypto.randomUUID(), message: crypto.randomUUID(), finish: crypto.randomUUID() }
    await act(
      agent(ws.id),
      'call.appendTranscript',
      { callId, speaker: 'caller', text: 'I live at 12 Elm Street', atMs: 10 },
      keys.line,
    )
    await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Call Dana at 503 555 0100' }, keys.message)
    await act(agent(ws.id), 'call.finish', { callId, summary: 'Dana Ruiz, leaking boiler' }, keys.finish)
    const rows = await Promise.all(Object.values(keys).map(logged))
    for (const row of rows) {
      expect(text(row.input) + text(row.result)).not.toMatch(/Elm|Dana|0100|boiler/)
      expect(row.input).toMatchObject({ callId })
    }
  })

  test('results keep their rows by id only, and a replay reads them again', async () => {
    const key = crypto.randomUUID()
    const first = await act(ws.owner, 'contact.update', { contactId: ws.contact.id, note: 'Gate code 4411' }, key)
    expect(first.body.rows.contacts[0].note).toBe('Gate code 4411')
    const row = await logged(key)
    expect(row.result).toEqual({ ok: true, rowIds: { contacts: [ws.contact.id] } })
    const replay = await act(ws.owner, 'contact.update', { contactId: ws.contact.id, note: 'ignored' }, key)
    expect(replay.body.rows.contacts[0]).toMatchObject({ id: ws.contact.id, note: 'Gate code 4411' })
  })

  test('invitation ids, which open the invitation, are redacted in input and result', async () => {
    const inviteKey = crypto.randomUUID()
    const invite = await act(
      ws.owner,
      'team.invite',
      { email: `invitee-${crypto.randomUUID().slice(0, 6)}@linedesk.test`, role: 'member' },
      inviteKey,
    )
    expect(invite.status).toBe(200)
    const invitationId = invite.body.data.invitationId as string
    expect(text(await logged(inviteKey))).not.toContain(invitationId)
    const revokeKey = crypto.randomUUID()
    expect((await act(ws.owner, 'team.revokeInvite', { invitationId }, revokeKey)).status).toBe(200)
    expect((await logged(revokeKey)).input).toEqual({ invitationId: '[redacted]' })
  })
})

describe('deleting purges', () => {
  test('a deleted call: the commands about it keep only ids', async () => {
    const own = await createWorkspace('Command Log Delete Call')
    const message = crypto.randomUUID()
    await act(agent(own.id), 'call.takeMessage', { callId: own.call.id, message: 'Dana 9921' }, message)
    const before = await db.select().from(commands).where(eq(commands.workspace_id, own.id))
    expect(before.some(c => c.input && text(c.input).includes(own.call.id))).toBe(true)
    expect((await act(own.owner, 'call.delete', { callId: own.call.id })).status).toBe(200)
    const about = (await db.select().from(commands).where(eq(commands.workspace_id, own.id))).filter(
      c => c.action !== 'call.delete' && text(c.input).includes(own.call.id),
    )
    expect(about.length).toBeGreaterThan(0)
    for (const c of about) {
      expect(c.pruned_at).not.toBeNull()
      expect(text(c.input) + text(c.result)).not.toContain('9921')
    }
  })

  test('a deleted contact: the commands about it keep only ids', async () => {
    const own = await createWorkspace('Command Log Delete Contact')
    const key = crypto.randomUUID()
    await act(
      own.owner,
      'contact.update',
      { contactId: own.contact.id, note: 'Spare key under the mat', name: 'Dana Ruiz' },
      key,
    )
    expect((await act(own.owner, 'contact.delete', { contactId: own.contact.id })).status).toBe(200)
    const row = await logged(key)
    expect(row.input).toEqual({ contactId: own.contact.id, note: OMITTED, name: OMITTED })
    expect(text(row)).not.toMatch(/Spare key|Dana/)
  })

  test('a merge keeps only the two ids; an older merge stored in clear is purged when either contact is deleted', async () => {
    const own = await createWorkspace('Command Log Merge')
    const other = async () =>
      (await db.insert(contacts).values({ id: `ct_${crypto.randomUUID()}`, workspace_id: own.id, phone: randomNumber() }).returning())[0]!
    const merged = await other()
    const key = crypto.randomUUID()
    const details = { name: 'Dana Ruiz', email: 'dana@example.com', address: '12 Elm Street', note: 'Gate code 4411' }
    expect((await act(own.owner, 'contact.merge', { keepId: own.contact.id, mergeId: merged.id, ...details }, key)).status).toBe(200)
    const row = await logged(key)
    expect(row.input).toMatchObject({ keepId: own.contact.id, mergeId: merged.id, name: OMITTED, address: OMITTED })
    expect(text(row)).not.toMatch(/Dana|Elm|4411/)

    // Written before merges were logged by ids: found by keepId and by mergeId.
    const keep = await other()
    const gone = await other()
    const older = [crypto.randomUUID(), crypto.randomUUID()]
    for (const [id, input] of [
      [older[0]!, { keepId: keep.id, mergeId: own.contact.id, ...details }],
      [older[1]!, { keepId: own.contact.id, mergeId: gone.id, ...details }],
    ] as const)
      await db.insert(commands).values({ id, workspace_id: own.id, actor_id: own.owner.userId, action: 'contact.merge', input, result: { ok: true } })
    expect((await act(own.owner, 'contact.delete', { contactId: own.contact.id })).status).toBe(200)
    for (const id of older) {
      const purged = await logged(id)
      expect(purged.pruned_at).not.toBeNull()
      expect(text(purged)).not.toMatch(/Dana|Elm|4411|example\.com/)
    }
  })
})

test(`after ${COMMAND_INPUT_RETENTION_DAYS} days only ids stay, except for the audited actions; newer commands are untouched`, async () => {
  const old = new Date(Date.now() - (COMMAND_INPUT_RETENTION_DAYS + 1) * 86_400_000).toISOString()
  const id = (name: string) => `${name}-${crypto.randomUUID()}`
  const rows = [
    {
      id: id('old-note'),
      action: 'contact.update',
      created_at: old,
      input: { contactId: 'ct_1', note: 'Gate code 4411' },
      result: { ok: true, data: { contactId: 'ct_1', label: 'Dana' } },
    },
    {
      id: id('old-team'),
      action: 'team.setRole',
      created_at: old,
      input: { memberId: 'm_1', role: 'admin' },
      result: { ok: true, data: { subject: { email: 'ann@linedesk.test' } } },
    },
    {
      // A change of transfer contacts (audit.ts, TRANSFER_CHANGE_ACTIONS): the input goes down to ids, what the audit
      // log shows of it stays.
      id: id('old-transfers'),
      action: 'assistant.update',
      created_at: old,
      input: { assistantId: 'as_1', transfers: [{ id: 'oncall', name: 'Mike', number: '+15035550199' }] },
      result: {
        ok: true,
        rowIds: { assistants: ['as_1'] },
        data: {
          transferChanges: { added: [{ id: 'oncall', name: 'Mike', number: '…0199' }], changed: [], removed: [], reordered: false },
        },
      },
    },
    {
      // A change of the call email instruction: who it added and removed stays, the text goes.
      id: id('old-routing'),
      action: 'assistant.update',
      created_at: old,
      input: { assistantId: 'as_1', email_routing: 'Water heater calls to <@user:u_1>.' },
      result: {
        ok: true,
        data: { emailRoutingChanges: { added: [{ kind: 'member', id: 'u_1', name: 'Dave' }], removed: [] } },
      },
    },
    {
      // Any other assistant change is everyday work: pruned.
      id: id('old-greeting'),
      action: 'assistant.update',
      created_at: old,
      input: { assistantId: 'as_1', greeting: 'Hi, this is Maya.' },
      result: { ok: true },
    },
    {
      id: id('new-note'),
      action: 'contact.update',
      created_at: new Date().toISOString(),
      input: { contactId: 'ct_1', note: 'Gate code 4411' },
      result: { ok: true },
    },
  ]
  await db.insert(commands).values(rows.map(r => ({ ...r, workspace_id: ws.id, actor_id: ws.owner.userId })))
  expect(await pruneOldCommands(db)).toBeGreaterThanOrEqual(1)
  const after = new Map(
    (
      await db
        .select()
        .from(commands)
        .where(
          inArray(
            commands.id,
            rows.map(r => r.id),
          ),
        )
    ).map(r => [r.id, r]),
  )
  expect(after.get(rows[0]!.id)).toMatchObject({
    input: { contactId: 'ct_1', note: OMITTED },
    result: { ok: true, data: { contactId: 'ct_1', label: OMITTED } },
    action: 'contact.update',
    actor_id: ws.owner.userId,
  })
  expect(after.get(rows[0]!.id)!.pruned_at).not.toBeNull()
  expect(after.get(rows[1]!.id)).toMatchObject({ input: rows[1]!.input, result: rows[1]!.result, pruned_at: null })
  expect(after.get(rows[2]!.id)).toEqual(
    expect.objectContaining({
      input: { assistantId: 'as_1', transfers: OMITTED },
      result: { ok: true, data: { transferChanges: rows[2]!.result.data!.transferChanges } },
    }),
  )
  expect(after.get(rows[2]!.id)!.pruned_at).not.toBeNull()
  expect(after.get(rows[3]!.id)).toEqual(
    expect.objectContaining({
      input: { assistantId: 'as_1', email_routing: OMITTED },
      result: { ok: true, data: { emailRoutingChanges: rows[3]!.result.data!.emailRoutingChanges } },
    }),
  )
  expect(after.get(rows[4]!.id)).toMatchObject({ input: { assistantId: 'as_1', greeting: OMITTED } })
  expect(after.get(rows[4]!.id)!.pruned_at).not.toBeNull()
  expect(after.get(rows[5]!.id)).toMatchObject({ input: rows[5]!.input, pruned_at: null })
  expect(await pruneOldCommands(db)).toBe(0) // already pruned rows are not touched again
})
