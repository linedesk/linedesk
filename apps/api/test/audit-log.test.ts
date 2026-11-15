// Server admin › Audit log (apps/api/src/audit.ts): what an AI agent did with a setup link is listed, whatever the action.
import { describe, expect, test } from 'vitest'
import { setupActorIn } from '../src/agent-setup.ts'
import { listAudit } from '../src/audit.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import { act, createWorkspace } from './helpers.ts'

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
