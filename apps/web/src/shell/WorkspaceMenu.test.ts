import { describe, expect, test } from 'vitest'
import { workspaceInitial, workspaceMenuItems } from './WorkspaceMenu.tsx'

const owner = { canCreate: false, canManage: true }
const admin = { canCreate: false, canManage: true }
const member = { canCreate: false, canManage: false }
const instanceAdmin = { canCreate: true, canManage: true }

describe('workspaceMenuItems', () => {
  test('one workspace, no invitations: no switcher', () => {
    expect(workspaceMenuItems({ count: 1, invitations: 0, ...owner })).toEqual(['settings', 'invite'])
    expect(workspaceMenuItems({ count: 1, invitations: 0, ...member })).toEqual(['settings'])
  })

  test('the list not known yet counts as one workspace', () => {
    expect(workspaceMenuItems({ count: null, invitations: 0, ...admin })).toEqual(['settings', 'invite'])
  })

  test('two or more workspaces: the switcher leads', () => {
    expect(workspaceMenuItems({ count: 2, invitations: 0, ...member })).toEqual(['switcher', 'settings'])
    expect(workspaceMenuItems({ count: 12, invitations: 0, ...admin })).toEqual(['switcher', 'settings', 'invite'])
  })

  test('an invitation shows the switcher also with one workspace', () => {
    expect(workspaceMenuItems({ count: 1, invitations: 1, ...member })).toEqual(['switcher', 'settings'])
  })

  test('New workspace… only where a new workspace is allowed', () => {
    expect(workspaceMenuItems({ count: 3, invitations: 0, ...instanceAdmin })).toEqual([
      'switcher',
      'new',
      'settings',
      'invite',
    ])
    expect(workspaceMenuItems({ count: 1, invitations: 0, canCreate: true, canManage: false })).toEqual([
      'new',
      'settings',
    ])
  })

  test('Invite people… only for owners and admins', () => {
    for (const role of [owner, admin])
      expect(workspaceMenuItems({ count: 1, invitations: 0, ...role })).toContain('invite')
    expect(workspaceMenuItems({ count: 5, invitations: 2, ...member })).not.toContain('invite')
  })
})

describe('workspaceInitial', () => {
  test('the first letter, upper case; a question mark without a name', () => {
    expect(workspaceInitial('brightwater Plumbing')).toBe('B')
    expect(workspaceInitial('  Ålesund Dental')).toBe('Å')
    expect(workspaceInitial('')).toBe('?')
  })
})
