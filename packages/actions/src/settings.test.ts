import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { assistantUpdate, workspaceGetSettings, workspaceUpdateSettings } from './settings.ts'

describe('assistant.update', () => {
  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
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
