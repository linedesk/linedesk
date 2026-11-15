import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { teamInvite, teamList, teamRemoveMember, teamSetRole, teamTransferOwnership } from './team.ts'

describe('team actions', () => {
  it('every member can list the team; only owners and admins can change it', () => {
    for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain(teamList.permission)
    expect(rolePermissions.owner).toContain('team:write')
    expect(rolePermissions.admin).toContain('team:write')
    expect(rolePermissions.member).not.toContain('team:write')
    expect(rolePermissions.agent).not.toContain('team:read')
  })

  it('neither an invitation nor a role change gives the owner role: only the owner hands the workspace over', () => {
    expect(teamInvite.input.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false)
    expect(teamSetRole.input.safeParse({ memberId: 'm1', role: 'owner' }).success).toBe(false)
    expect(teamSetRole.input.safeParse({ memberId: 'm1', role: 'admin' }).success).toBe(true)
    expect(teamTransferOwnership.permission).toBe('workspace:own')
    expect(rolePermissions.owner).toContain('workspace:own')
    expect(rolePermissions.admin).not.toContain('workspace:own')
    expect(rolePermissions.member).not.toContain('workspace:own')
    expect(teamSetRole.input.safeParse({ memberId: 'm1', role: 'chief' }).success).toBe(false)
    expect(teamRemoveMember.input.safeParse({ memberId: '' }).success).toBe(false)
  })

  it('normalizes the invited address', () => {
    expect(teamInvite.input.parse({ email: '  Mike@Brightwater.COM ', role: 'admin' })).toEqual({ email: 'mike@brightwater.com', role: 'admin' })
  })
})
