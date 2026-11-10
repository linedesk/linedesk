import type { Call } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { actions, applyLocally, rolePermissions, type LocalTables } from './index.ts'

const tables = (call: Partial<Call>) => ({ calls: new Map([[call.id, call]]) }) as unknown as LocalTables

describe('call.setActionItems', () => {
  const def = actions.get('call.setActionItems')!

  it('replaces the next steps of the call locally', () => {
    const local = tables({ id: 'c1', action_items: [{ text: 'Call back' }] })
    applyLocally(
      local,
      def,
      def.input.parse({ callId: 'c1', items: [{ text: 'Call back', done: true }] }),
      '2026-11-10T12:00:00.000Z',
    )
    expect(local.calls.get('c1')!.action_items).toEqual([{ text: 'Call back', done: true }])
  })
  it('rejects empty steps and needs call:write', () => {
    expect(def.input.safeParse({ callId: 'c1', items: [{ text: '' }] }).success).toBe(false)
    expect(def.permission).toBe('call:write')
    expect(rolePermissions.member).toContain('call:write')
  })
})

describe('call.markSpam and call.markNotSpam', () => {
  const spam = actions.get('call.markSpam')!
  const notSpam = actions.get('call.markNotSpam')!

  it('files a call as spam and takes it back out as a callback in the open inbox', () => {
    const local = tables({ id: 'c1', outcome: 'message', unread: true, inbox_state: 'open' })
    applyLocally(local, spam, spam.input.parse({ callId: 'c1' }), '2026-11-10T12:00:00.000Z')
    expect(local.calls.get('c1')).toMatchObject({ outcome: 'spam', unread: false })
    local.calls.set('c1', { ...local.calls.get('c1')!, inbox_state: 'done' })
    applyLocally(local, notSpam, notSpam.input.parse({ callId: 'c1' }), '2026-11-10T12:00:00.000Z')
    expect(local.calls.get('c1')).toMatchObject({ outcome: 'callback', inbox_state: 'open' })
    applyLocally(local, notSpam, notSpam.input.parse({ callId: 'c1', outcome: 'message' }), '2026-11-10T12:00:00.000Z')
    expect(local.calls.get('c1')!.outcome).toBe('message') // undo puts back what it was
    expect(notSpam.input.safeParse({ callId: 'c1', outcome: 'spam' }).success).toBe(false)
  })
  it('needs call:write, which members have', () => {
    expect(spam.permission).toBe('call:write')
    expect(notSpam.permission).toBe('call:write')
    expect(rolePermissions.member).toContain('call:write')
  })
})
