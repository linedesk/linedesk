import { describe, expect, test } from 'vitest'
import { switcherWorkspaces, workspaceInitial, workspaceMenuItems } from './WorkspaceMenu.tsx'

const noLinks = { terms: null, privacy: null, supportEmail: null }
const allLinks = {
  terms: 'https://example.com/terms',
  privacy: 'https://example.com/privacy',
  supportEmail: 'help@example.com',
}

describe('workspaceMenuItems', () => {
  test('one menu: the workspaces first, then the account, Sign out last', () => {
    expect(workspaceMenuItems({ canCreate: false, links: noLinks })).toEqual([
      'switcher',
      'account',
      'shortcuts',
      'sign-out',
    ])
  })

  test('never Workspace settings or Invite people: those are in the sidebar', () => {
    const items: string[] = workspaceMenuItems({ canCreate: true, links: allLinks })
    expect(items).not.toContain('settings')
    expect(items).not.toContain('invite')
  })

  test('New workspace… only where a new workspace is allowed, right after the workspaces', () => {
    expect(workspaceMenuItems({ canCreate: true, links: noLinks }).slice(0, 2)).toEqual(['switcher', 'new'])
    expect(workspaceMenuItems({ canCreate: false, links: noLinks })).not.toContain('new')
  })

  test('Help, Terms and Privacy only where the install has them, before Sign out', () => {
    expect(workspaceMenuItems({ canCreate: false, links: allLinks })).toEqual([
      'switcher',
      'account',
      'shortcuts',
      'help',
      'terms',
      'privacy',
      'sign-out',
    ])
    expect(workspaceMenuItems({ canCreate: false, links: { ...noLinks, terms: 'https://example.com/t' } })).toEqual([
      'switcher',
      'account',
      'shortcuts',
      'terms',
      'sign-out',
    ])
  })

  test('links not known yet: Account settings and Sign out are still there', () => {
    expect(workspaceMenuItems({ canCreate: false, links: null })).toEqual([
      'switcher',
      'account',
      'shortcuts',
      'sign-out',
    ])
  })
})

describe('switcherWorkspaces', () => {
  const current = { id: 'w1', name: 'Brightwater Plumbing & Heating' }

  test('the list not known yet: the current workspace alone, so it still shows checked', () => {
    expect(switcherWorkspaces(null, current)).toEqual([current])
    expect(switcherWorkspaces([], current)).toEqual([current])
  })

  test('one workspace: listed too', () => {
    expect(switcherWorkspaces([{ id: 'w1', name: 'Brightwater Plumbing & Heating' }], current)).toHaveLength(1)
  })

  test('the current one carries the name the session has (just renamed); the others are unchanged', () => {
    const all = [
      { id: 'w1', name: 'Brightwater', iconUrl: '/icon.png' },
      { id: 'w2', name: 'Acme HVAC', disabled: true },
    ]
    expect(switcherWorkspaces(all, current)).toEqual([
      { id: 'w1', name: 'Brightwater Plumbing & Heating', iconUrl: '/icon.png' },
      { id: 'w2', name: 'Acme HVAC', disabled: true },
    ])
  })
})

describe('workspaceInitial', () => {
  test('the first letter, upper case; a question mark without a name', () => {
    expect(workspaceInitial('brightwater Plumbing')).toBe('B')
    expect(workspaceInitial('  Ålesund Dental')).toBe('Å')
    expect(workspaceInitial('')).toBe('?')
  })
})
