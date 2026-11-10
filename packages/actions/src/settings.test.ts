import type { Contact } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'
import {
  assistantUpdate,
  contactBlock,
  contactUnblock,
  workspaceGetSettings,
  workspaceUpdateSettings,
} from './settings.ts'

describe('assistant.update', () => {
  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
  })
})

describe('contact.block and contact.unblock', () => {
  it('set and clear blocked_at locally, and need contact:write, which members have', () => {
    const local = { contacts: new Map([['ct1', { id: 'ct1', blocked_at: null }]]) } as unknown as LocalTables
    applyLocally(local, contactBlock, { contactId: 'ct1' }, '2026-11-10T12:00:00.000Z')
    expect((local.contacts.get('ct1') as Contact).blocked_at).toBe('2026-11-10T12:00:00.000Z')
    applyLocally(local, contactUnblock, { contactId: 'ct1' }, '2026-11-10T12:01:00.000Z')
    expect((local.contacts.get('ct1') as Contact).blocked_at).toBeNull()
    for (const def of [contactBlock, contactUnblock]) expect(def.permission).toBe('contact:write')
    expect(rolePermissions.member).toContain('contact:write')
  })
})

describe('workspace.updateSettings', () => {
  it('takes one of the offered retention periods, or null to keep recordings', () => {
    for (const days of [30, 60, 90, 180, 365, null]) expect(workspaceUpdateSettings.input.safeParse({ recordingRetentionDays: days }).success).toBe(true)
    for (const days of [0, 7, 91, -1, '90']) expect(workspaceUpdateSettings.input.safeParse({ recordingRetentionDays: days }).success).toBe(false)
  })

  it('only owners and admins change it; every member reads it', () => {
    expect(rolePermissions.member).not.toContain(workspaceUpdateSettings.permission)
    expect(rolePermissions.admin).toContain(workspaceUpdateSettings.permission)
    for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain(workspaceGetSettings.permission)
  })
})
