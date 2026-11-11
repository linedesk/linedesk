import type { TeamData, TeamMember } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { canEditRole, canRemove, invitationStatus, isEmail, isOnTeam, joinedLabel } from './team-model.ts'

const member = (userId: string, role: TeamMember['role'], email = `${userId}@x.co`): TeamMember =>
  ({ memberId: `m_${userId}`, userId, name: userId, email, role, joinedAt: '2026-11-01T10:00:00Z' })
const data = (canManage: boolean, me = 'mike'): TeamData => ({
  members: [member('mike', 'owner'), member('sarah', 'admin'), member('jo', 'member')],
  invitations: [{ invitationId: 'i1', email: 'new@x.co', role: 'member', invitedBy: 'Mike', expiresAt: '2026-11-17T10:00:00Z', expired: false }],
  canManage, me,
})

describe('team model', () => {
  it('owners are never edited here; members see everything read-only', () => {
    const d = data(true)
    expect(d.members.map(m => canEditRole(d, m))).toEqual([false, true, true])
    const ro = data(false, 'jo')
    expect(ro.members.some(m => canEditRole(ro, m) || canRemove(ro, m))).toBe(false)
  })

  it('nobody removes themselves', () => {
    const d = data(true, 'sarah')
    expect(d.members.map(m => canRemove(d, m))).toEqual([false, false, true])
  })

  it('knows who is already on the team or invited', () => {
    expect(isOnTeam(data(true), ' NEW@x.co ')).toBe(true)
    expect(isOnTeam(data(true), 'jo@x.co')).toBe(true)
    expect(isOnTeam(data(true), 'other@x.co')).toBe(false)
    expect(isEmail('a@b.co')).toBe(true)
    expect(isEmail('a@b')).toBe(false)
  })

  it('labels dates and expiry', () => {
    expect(joinedLabel('2026-11-01T10:00:00Z', new Date('2026-11-10T00:00:00Z'))).toBe('Joined Nov 1')
    expect(joinedLabel('2025-11-01T10:00:00Z', new Date('2026-11-10T00:00:00Z'))).toBe('Joined Nov 1, 2025')
    const invite = data(true).invitations[0]!
    expect(invitationStatus(invite, Date.parse('2026-11-10T10:00:00Z'))).toBe('Expires in 7 days')
    expect(invitationStatus(invite, Date.parse('2026-11-17T09:00:00Z'))).toBe('Expires today')
    expect(invitationStatus({ ...invite, expired: true })).toBe('Resend to renew the link')
  })
})
