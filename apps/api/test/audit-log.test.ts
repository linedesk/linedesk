// Server admin › Audit log (apps/api/src/audit.ts): what an AI agent did with a setup link is listed, whatever the action;
// a change of an assistant's transfer contacts is listed with what it changed.
import { describe, expect, test } from 'vitest'
import { setupActorIn } from '../src/agent-setup.ts'
import { emailRoutingChanges, listAudit, transferChanges } from '../src/audit.ts'
import { pruneSet } from '../src/command-log.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import { commands } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { act, addMember, createWorkspace } from './helpers.ts'

describe('setup link entries', () => {
  test('an assistant.update through the setup MCP is listed under integrations, with viaSetupKey', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const keyId = `sk_${crypto.randomUUID()}`
    // The setup key's admin in their own workspace, as setup-mcp.ts runs a workspace tool (setupActor, setupActorIn).
    const setupKeyActor: Actor = {
      actorId: ws.owner.userId,
      role: 'member',
      workspaceId: null,
      permissions: ['instance:admin'],
      setupKeyId: keyId,
    }
    const actor = await setupActorIn(setupKeyActor, ws.id)
    expect(actor).not.toBeNull()
    const ran = await runAction(
      'assistant.update',
      { assistantId: ws.assistant.id, greeting: 'Thanks for calling Brightwater Plumbing & Heating, this is Maya.' },
      actor!,
    )
    expect(ran.status).toBe(200)
    // The same action by the owner in the app is everyday work, not audited.
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hi, this is Maya.' })).status,
    ).toBe(200)

    const integrations = await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })
    const updates = integrations.entries.filter(e => e.what === 'assistant.update')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ kind: 'integrations', viaSetupKey: keyId, workspace: { id: ws.id } })

    const everything = await listAudit(db, { workspaceId: ws.id, limit: 50 })
    expect(everything.entries.filter(e => e.what === 'assistant.update')).toEqual(updates)
    for (const kind of ['admin', 'team', 'keys', 'impersonation'] as const) {
      const other = await listAudit(db, { kind, workspaceId: ws.id, limit: 50 })
      expect(other.entries.some(e => e.what === 'assistant.update')).toBe(false)
    }
  })
})

describe('transfer contacts', () => {
  const contact = (over: Record<string, unknown> = {}) => ({
    id: 'oncall',
    name: 'Mike',
    number: '+15035550199',
    condition: 'Urgent: a burst pipe',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'message' as const,
    enabled: true,
    ...over,
  })
  const sarah = contact({ id: 'office', name: 'Sarah', number: '+15035550187', condition: 'Billing questions' })

  test('adding, changing and removing contacts is listed under integrations, by name; numbers only masked', async () => {
    const ws = await createWorkspace('Audited Transfers Plumbing')
    const update = (transfers: unknown[]) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers })
    expect((await update([contact()])).status).toBe(200)
    expect((await update([contact({ number: '+15035550142' }), sarah])).status).toBe(200)
    expect((await update([sarah])).status).toBe(200)
    // Saving the same list again, or other settings, changes no contact: not listed.
    expect((await update([sarah])).status).toBe(200)
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hi, this is Maya.' })).status,
    ).toBe(200)

    const { entries } = await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })
    const changes = entries.filter(e => e.what === 'assistant.update')
    expect(
      changes.map(
        e =>
          e.transferChanges && {
            added: e.transferChanges.added,
            changed: e.transferChanges.changed,
            removed: e.transferChanges.removed,
          },
      ),
    ).toEqual([
      { added: [], changed: [], removed: ['Mike'] },
      { added: ['Sarah'], changed: ['Mike'], removed: [] },
      // The new assistant's inactive default contact (no number) was replaced.
      { added: ['Mike'], changed: [], removed: ['Owner'] },
    ])
    expect(changes[0]).toMatchObject({ kind: 'integrations', actor: { id: ws.owner.userId }, workspace: { id: ws.id } })
    // What the log keeps: only the contacts that changed, with ids, names and the numbers' last four digits.
    const [stored] = await db.select().from(commands).where(eq(commands.id, changes[1]!.id))
    expect(stored?.result).toMatchObject({
      data: {
        transferChanges: {
          added: [{ id: 'office', name: 'Sarah', number: '…0187' }],
          changed: [{ id: 'oncall', name: 'Mike', number: '…0142', numberBefore: '…0199', fields: ['number'] }],
          removed: [],
          reordered: false,
        },
      },
    })
    expect(JSON.stringify(stored?.result)).not.toMatch(/5035550/)
    // The admin page gets the names it shows, and the input's contacts masked.
    expect(JSON.stringify(entries)).not.toMatch(/5035550/)
    expect(changes[1]!.input).toMatchObject({
      transfers: [{ id: 'oncall', name: 'Mike', number: '…0142' }, { name: 'Sarah' }],
    })
    // Listed under everything too, and under no other kind.
    expect(
      (await listAudit(db, { workspaceId: ws.id, limit: 50 })).entries.filter(e => e.what === 'assistant.update'),
    ).toHaveLength(3)
    for (const kind of ['admin', 'team', 'keys', 'impersonation'] as const) {
      const other = await listAudit(db, { kind, workspaceId: ws.id, limit: 50 })
      expect(other.entries.some(e => e.what === 'assistant.update')).toBe(false)
    }

    // Restoring a version with other contacts (the first: the default one) is listed too.
    const versions = (await act(ws.owner, 'assistant.versions', { assistantId: ws.assistant.id })).body.data
      .versions as { number: number }[]
    const first = versions.at(-1)!.number
    expect(
      (await act(ws.owner, 'assistant.restoreVersion', { assistantId: ws.assistant.id, number: first })).status,
    ).toBe(200)
    const restored = (await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })).entries.find(
      e => e.what === 'assistant.restoreVersion',
    )
    expect(restored?.transferChanges).toMatchObject({ added: ['Owner'], removed: ['Sarah'] })
  })

  test('deleting the workspace cuts a change of transfer contacts to ids: it is no longer listed', async () => {
    const ws = await createWorkspace('Gone Transfers Plumbing')
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact()] })).status,
    ).toBe(200)
    const listed = async () =>
      (await listAudit(db, { workspaceId: ws.id, limit: 50 })).entries.filter(e => e.what === 'assistant.update')
    expect(await listed()).toHaveLength(1)
    // What workspace-delete.ts does to the workspace's commands that are not audited actions.
    await db
      .update(commands)
      .set(pruneSet(new Date()))
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'assistant.update')))
    expect(await listed()).toEqual([])
  })

  test('a refused change of transfer contacts is listed too', async () => {
    const ws = await createWorkspace('Refused Transfers Plumbing')
    // Canada is not one of the workspace's countries: refused by the handler.
    const refused = await act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      transfers: [contact({ number: '+16135550123' })],
    })
    expect(refused.status).toBe(409)
    const [row] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'assistant.update')))
    expect(row?.rejected).toBe(true)
    const { entries } = await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })
    const listed = entries.filter(e => e.what === 'assistant.update')
    expect(listed).toMatchObject([{ refused: true, kind: 'integrations', input: { transfers: [{ number: '…0123' }] } }])
    // A refused change of other settings is not.
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: 'no-such-voice' })
    expect(
      (await listAudit(db, { workspaceId: ws.id, limit: 50 })).entries.filter(e => e.what === 'assistant.update'),
    ).toHaveLength(1)
  })

  test('transferChanges: by id and name; a new order alone is a change; the same list is none', () => {
    expect(transferChanges([contact()], [contact()])).toBeNull()
    expect(transferChanges([contact(), sarah], [sarah, contact()])).toEqual({
      added: [],
      changed: [],
      removed: [],
      reordered: true,
    })
    expect(transferChanges([contact()], [contact({ enabled: false }), sarah])).toEqual({
      added: [{ id: 'office', name: 'Sarah', number: '…0187' }],
      changed: [{ id: 'oncall', name: 'Mike', number: '…0199', fields: ['enabled'] }],
      removed: [],
      reordered: false,
    })
  })
})

describe('call email instruction', () => {
  test('a change is listed under integrations with who it added and removed, never the text', async () => {
    const ws = await createWorkspace('Audited Routing Plumbing')
    const dave = await addMember(ws.id, 'member')
    const rosa = `rosa-${crypto.randomUUID().slice(0, 8)}@lakeside-books.example`
    const update = (email_routing: string | null) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, email_routing })
    const first = await update(`Water heater calls to <@user:${dave.userId}>.`)
    expect(first.status).toBe(200)
    expect(first.body.data.emailRoutingChanges).toMatchObject({
      added: [{ kind: 'member', id: dave.userId }],
      removed: [],
    })
    expect((await update(`Book calls to <@email:${rosa}>.`)).status).toBe(200)
    // The same text again, or other settings: no change, not listed.
    expect((await update(`Book calls to <@email:${rosa}>.`)).body.data?.emailRoutingChanges).toBeUndefined()
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hi, this is Maya.' })).status,
    ).toBe(200)
    // Only the wording changed: listed, with nobody added or removed.
    expect((await update(`All book calls to <@email:${rosa}>.`)).status).toBe(200)

    const { entries } = await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })
    const changes = entries.filter(e => e.what === 'assistant.update')
    const daveName = changes.at(-1)!.emailRoutingChanges!.added[0]!
    expect(changes.map(e => e.emailRoutingChanges)).toEqual([
      { added: [], removed: [] },
      { added: [rosa], removed: [daveName] },
      { added: [daveName], removed: [] },
    ])
    expect(daveName).not.toBe(dave.userId)
    for (const e of changes) {
      expect(e.kind).toBe('integrations')
      expect(JSON.stringify(e.input)).not.toContain('calls to')
    }
  })

  test('emailRoutingChanges: by mention; the same text is none; names from the map', () => {
    const names = new Map([['u1', 'Dave']])
    expect(emailRoutingChanges('To <@user:u1>.', 'To <@user:u1>.', names)).toBeNull()
    expect(emailRoutingChanges(null, '', names)).toBeNull()
    expect(emailRoutingChanges('To <@user:u1>.', 'To <@email:Rosa@X.example> and <@user:u2>.', names)).toEqual({
      added: [
        { kind: 'outside', email: 'rosa@x.example' },
        { kind: 'member', id: 'u2', name: null },
      ],
      removed: [{ kind: 'member', id: 'u1', name: 'Dave' }],
    })
  })
})

describe('API keys', () => {
  test('a revoked key is listed with its name (the revoke itself has only the id)', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const created = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'member' })
    expect(created.status).toBe(200)
    const apiKeyId = (created.body as { data: { apiKeyId: string } }).data.apiKeyId
    expect((await act(ws.owner, 'apiKey.revoke', { apiKeyId })).status).toBe(200)

    const { entries } = await listAudit(db, { kind: 'integrations', workspaceId: ws.id, limit: 50 })
    expect(entries.find(e => e.what === 'apiKey.revoke')).toMatchObject({ apiKeyName: 'Zapier', input: { apiKeyId } })
    expect(entries.find(e => e.what === 'apiKey.create')?.apiKeyName).toBeUndefined()
  })
})
