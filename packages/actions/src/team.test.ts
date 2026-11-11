import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { teamInvite, teamList, teamRemoveMember, teamSetRole } from './team.ts'

describe('team actions', () => {
  it('every member can list the team; only owners and admins can change it', () => {
    for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain(teamList.permission)
    expect(rolePermissions.owner).toContain('team:write')
    expect(rolePermissions.admin).toContain('team:write')
    expect(rolePermissions.member).not.toContain('team:write')
    expect(rolePermissions.agent).not.toContain('team:read')
  })

  it('an invitation cannot give the owner role; a role change can (the server lets only owners do it)', () => {
    expect(teamInvite.input.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false)
    expect(teamSetRole.input.safeParse({ memberId: 'm1', role: 'owner' }).success).toBe(true)
    expect(teamSetRole.input.safeParse({ memberId: 'm1', role: 'chief' }).success).toBe(false)
    expect(teamRemoveMember.input.safeParse({ memberId: '' }).success).toBe(false)
  })

  it('normalizes the invited address', () => {
    expect(teamInvite.input.parse({ email: '  Mike@Brightwater.COM ', role: 'admin' })).toEqual({ email: 'mike@brightwater.com', role: 'admin' })
  })
})
