import type { TeamData, TeamMember } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import {
  canEditMember,
  canEditRole,
  changedByLabel,
  canRemove,
  invitationStatus,
  isEmail,
  isMe,
  isOnTeam,
  joinedLabel,
  PROFILE_HASH,
  roleInSentence,
} from './team-model.ts'
import { parseHash } from '../shell/useRoute.ts'
import { OWN_NOTIFICATIONS_HASH } from '../settings/Notifications.tsx'

const member = (userId: string, role: TeamMember['role'], email = `${userId}@x.co`): TeamMember =>
  ({ memberId: `m_${userId}`, userId, name: userId, email, role, joinedAt: '2026-11-01T10:00:00Z' })
const data = (canManage: boolean, me = 'mike'): TeamData => ({
  members: [member('mike', 'owner'), member('sarah', 'admin'), member('jo', 'member')],
  invitations: [{ invitationId: 'i1', email: 'new@x.co', role: 'member', invitedBy: 'Mike', expiresAt: '2026-11-17T10:00:00Z', expired: false }],
  canManage, me,
})

describe('team model', () => {
  it('owners edit everyone else; admins everyone but owners; members nobody; nobody themselves', () => {
    const asOwner = data(true)
    expect(asOwner.members.map(m => canEditMember(asOwner, m))).toEqual([false, true, true])
    const asAdmin = data(true, 'sarah')
    expect(asAdmin.members.map(m => canEditMember(asAdmin, m))).toEqual([false, false, true])
    const asMember = data(false, 'jo')
    expect(asMember.members.some(m => canEditMember(asMember, m))).toBe(false)
  })

  it('says who changed a setting last and when', () => {
    const now = new Date('2026-11-20T12:00:00Z')
    expect(changedByLabel({ name: 'Ana Admin', at: '2026-11-14T15:00:00Z' }, now)).toBe('Last changed by Ana Admin on Nov 14.')
    expect(changedByLabel({ name: 'Ana', at: '2025-03-02T15:00:00Z' }, now)).toBe('Last changed by Ana on Mar 2, 2025.')
  })

  it('the last owner is never edited; members see everything read-only', () => {
    const d = data(true)
    expect(d.members.map(m => canEditRole(d, m))).toEqual([false, true, true])
    expect(data(true, 'sarah').members.map(m => canEditRole(data(true, 'sarah'), m))).toEqual([false, false, true])
    const ro = data(false, 'jo')
    expect(ro.members.some(m => canEditRole(ro, m) || canRemove(ro, m))).toBe(false)
  })

  it('with two owners, an owner changes the other owner and their own role; an admin changes neither', () => {
    const two = (me: string): TeamData => ({ ...data(true, me), members: [member('mike', 'owner'), member('ann', 'owner'), member('sarah', 'admin')] })
    expect(two('mike').members.map(m => canEditRole(two('mike'), m))).toEqual([true, true, true])
    expect(two('mike').members.map(m => canRemove(two('mike'), m))).toEqual([false, true, true])
    expect(two('sarah').members.map(m => canEditRole(two('sarah'), m))).toEqual([false, false, false])
    expect(two('sarah').members.map(m => canRemove(two('sarah'), m))).toEqual([false, false, false])
  })

  it('nobody removes themselves', () => {
    const d = data(true, 'sarah')
    expect(d.members.map(m => canRemove(d, m))).toEqual([false, false, true])
  })

  it('only your own row offers Edit profile, and it opens Account settings › Profile', () => {
    const d = data(true, 'sarah')
    expect(d.members.map(m => isMe(d, m))).toEqual([false, true, false])
    expect(PROFILE_HASH).toBe('#account/profile')
    expect(parseHash(PROFILE_HASH)).toMatchObject({ route: 'account', known: true })
  })

  it('the team defaults link to your own notifications in Account', () => {
    expect(OWN_NOTIFICATIONS_HASH).toBe('#account/notifications')
    expect(parseHash(OWN_NOTIFICATIONS_HASH)).toMatchObject({ route: 'account', known: true })
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

describe('roleInSentence', () => {
  it('puts the right article before the role', () => {
    expect(roleInSentence('member')).toBe('a member')
    expect(roleInSentence('admin')).toBe('an admin')
    expect(roleInSentence('owner')).toBe('an owner')
  })
})
