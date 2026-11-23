import type { TeamData, TeamMember } from '@linedesk/actions'
import { describe, expect, it, vi } from 'vitest'
import {
  canEditMember,
  canEditRole,
  changedByLabel,
  canRemove,
  invitationStatus,
  isEmail,
  isMe,
  isOnTeam,
  membersInOrder,
  joinedLabel,
  needsSignInAgain,
  PROFILE_HASH,
  roleInSentence,
  rolesFor,
  sentInvitations,
  teamAsShown,
  teamRemoveConfirmation,
  teamRunner,
} from './team-model.ts'
import { parseHash } from '../shell/useRoute.ts'
import { WHO_HEARS_HASH } from '../settings/Notifications.tsx'

const member = (userId: string, role: TeamMember['role'], email = `${userId}@x.co`): TeamMember =>
  ({ memberId: `m_${userId}`, userId, name: userId, email, role, joinedAt: '2026-11-01T10:00:00Z' })
const data = (canManage: boolean, me = 'mike'): TeamData => ({
  members: [member('mike', 'owner'), member('sarah', 'admin'), member('jo', 'member')],
  invitations: [{ invitationId: 'i1', email: 'new@x.co', role: 'member', invitedBy: 'Mike', invitedById: 'mike', expiresAt: '2026-11-17T10:00:00Z', expired: false }],
  canManage, me, partner: null,
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

  it('one owner: nobody changes or removes the owner; only the owner may pick owner (a hand-over)', () => {
    const team = (me: string): TeamData => ({ ...data(true, me), members: [member('mike', 'owner'), member('ann', 'admin'), member('sarah', 'admin')] })
    expect(team('mike').members.map(m => canEditRole(team('mike'), m))).toEqual([false, true, true])
    expect(team('mike').members.map(m => canRemove(team('mike'), m))).toEqual([false, true, true])
    expect(team('sarah').members.map(m => canEditRole(team('sarah'), m))).toEqual([false, true, false])
    expect(team('sarah').members.map(m => canRemove(team('sarah'), m))).toEqual([false, true, false])
    expect(rolesFor(team('mike'))).toContain('owner')
    expect(rolesFor(team('sarah'))).not.toContain('owner')
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

  it('call emails link to the one place for them, Assistant › Who hears about calls', () => {
    expect(WHO_HEARS_HASH).toBe('#assistant/emails')
    expect(parseHash(WHO_HEARS_HASH)).toMatchObject({ route: 'assistant', known: true })
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

describe('removing someone from the team (LIN-264)', () => {
  it('only the owner gets the box that deletes the account; it is unticked, so the account stays by default', () => {
    expect(teamRemoveConfirmation('Ana', true).option).toMatch(/^Also delete their account if this is their only workspace/)
    expect(teamRemoveConfirmation('Ana', true).list[0]).toMatch(/^Their account stays unless you tick the box/)
    const byAdmin = teamRemoveConfirmation('Ana', false)
    expect('option' in byAdmin).toBe(false)
    expect(byAdmin.list[0]).toMatch(/Only the owner can delete accounts\.$/)
  })

  it('says how many pending invitations they sent the removal cancels (review F1)', () => {
    const team = data(true)
    team.invitations.push({ ...team.invitations[0]!, invitationId: 'i2', email: 'two@x.co', invitedBy: 'sarah', invitedById: 'sarah' })
    expect(sentInvitations(team, 'mike')).toBe(1)
    expect(sentInvitations(team, 'jo')).toBe(0)
    expect(teamRemoveConfirmation('Ana', true, 0).list).toHaveLength(1)
    expect(teamRemoveConfirmation('Ana', false, 1).list[1]).toBe('The pending invitation they sent will be canceled.')
    expect(teamRemoveConfirmation('Ana', true, 3).list[1]).toBe('The 3 pending invitations they sent will be canceled.')
  })
})

describe('team changes (teamRunner)', () => {
  const refusal = Object.assign(new Error('Sign in again to delete their account.'), { code: 'SIGN_IN_AGAIN' })

  it('a change from the page: a toast either way, the team read again, whether it went through', async () => {
    const toast = vi.fn()
    const load = vi.fn(async () => {})
    const run = teamRunner(toast, load)
    expect(await run(async () => {}, 'Done.')).toBe(true)
    expect(await run(() => Promise.reject(new Error('No.')), 'Done.')).toBe(false)
    expect(toast.mock.calls).toEqual([['Done.'], ['No.']])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a refused change confirmed in a dialog rejects, so the dialog ends busy and shows why (LIN-266)', async () => {
    const toast = vi.fn()
    const load = vi.fn(async () => {})
    const run = teamRunner(toast, load)
    await expect(run(() => Promise.reject(refusal), 'Removed.', { inDialog: true })).rejects.toBe(refusal)
    expect(toast).not.toHaveBeenCalled() // the dialog says it, not a toast behind it
    expect(load).toHaveBeenCalledTimes(1)
    expect(await run(async () => {}, 'Removed.', { inDialog: true })).toBe(true)
    expect(toast).toHaveBeenCalledWith('Removed.')
  })

  it("tells the server's sign-in-again refusal from others", () => {
    expect(needsSignInAgain(refusal)).toBe(true)
    expect(needsSignInAgain(new Error('No.'))).toBe(false)
    expect(needsSignInAgain(null)).toBe(false)
  })
})

describe('the team during support access', () => {
  it('reads as a member sees it: nothing to change, the same members and invitations', () => {
    const team = data(true)
    const shown = teamAsShown(team, true)!
    expect(shown.canManage).toBe(false)
    expect(shown.members).toBe(team.members)
    expect(shown.invitations).toBe(team.invitations)
    expect(canEditRole(shown, team.members[1]!)).toBe(false)
    expect(teamAsShown(team, false)).toBe(team)
    expect(teamAsShown(null, true)).toBeNull()
  })
})

describe('people here through the partner', () => {
  const viaPartner = (userId: string): TeamMember => ({ ...member(userId, 'admin'), partner: 'Northside IT' })

  it("are never edited from the client: their account is the partner's person", () => {
    const d: TeamData = { ...data(true), members: [member('mike', 'owner'), viaPartner('priya'), member('jo', 'member')] }
    expect(d.members.map(m => canEditMember(d, m))).toEqual([false, false, true])
  })

  it("come after the workspace's own people, its owner first, each group in the server's order", () => {
    const list = [viaPartner('priya'), member('jo', 'member'), member('mike', 'owner'), viaPartner('marcus'), member('sarah', 'admin')]
    expect(membersInOrder(list).map(m => m.userId)).toEqual(['mike', 'jo', 'sarah', 'priya', 'marcus'])
    expect(list[0]?.userId).toBe('priya')
  })
})

