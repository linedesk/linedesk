import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { actions, applyLocally, rolePermissions, type LocalTables } from './index.ts'

const tables = (call: Partial<Call>) => ({ calls: new Map([[call.id, call]]) }) as unknown as LocalTables

describe('call.setActionItems', () => {
  const def = actions.get('call.setActionItems')!

  it('replaces the next steps of the call locally', () => {
    const local = tables({ id: 'c1', action_items: [{ text: 'Call back' }] })
    applyLocally(local, def, def.input.parse({ callId: 'c1', items: [{ text: 'Call back', done: true }] }), '2026-11-10T12:00:00.000Z')
    expect(local.calls.get('c1')!.action_items).toEqual([{ text: 'Call back', done: true }])
  })
  it('rejects empty steps and needs call:write', () => {
    expect(def.input.safeParse({ callId: 'c1', items: [{ text: '' }] }).success).toBe(false)
    expect(def.permission).toBe('call:write')
    expect(rolePermissions.member).toContain('call:write')
  })
})
