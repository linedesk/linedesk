import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  switcherWorkspaces,
  workspaceInitial,
  workspaceMenuItems,
  YouRowSkeleton,
  youRowLoading,
} from './WorkspaceMenu.tsx'

describe('workspaceMenuItems', () => {
  test('one menu: the workspaces first, then User settings, Sign out last', () => {
    expect(workspaceMenuItems({ canCreate: false })).toEqual(['switcher', 'account', 'sign-out'])
  })

  test('never Workspace settings, Invite people, Keyboard shortcuts, Help, Terms or Privacy', () => {
    const items: string[] = workspaceMenuItems({ canCreate: true })
    for (const item of ['settings', 'invite', 'shortcuts', 'help', 'terms', 'privacy'])
      expect(items).not.toContain(item)
  })

  test('New workspace… only where a new workspace is allowed, right after the workspaces', () => {
    expect(workspaceMenuItems({ canCreate: true }).slice(0, 2)).toEqual(['switcher', 'new'])
    expect(workspaceMenuItems({ canCreate: false })).not.toContain('new')
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

describe('the you-row', () => {
  test('waits for the session and for the picture, not for a picture that failed or none', () => {
    expect(youRowLoading('', 'none')).toBe(true)
    expect(youRowLoading('', 'ready')).toBe(true)
    expect(youRowLoading('Mike Brennan', 'loading')).toBe(true)
    expect(youRowLoading('Mike Brennan', 'ready')).toBe(false)
    expect(youRowLoading('Mike Brennan', 'failed')).toBe(false)
    expect(youRowLoading('mike@example.com', 'none')).toBe(false)
  })

  test('waits as a round picture and its lines, invisible at first', () => {
    const html = renderToStaticMarkup(createElement(YouRowSkeleton, { lines: 2, reserved: true }))
    expect(html).toContain('class="ws-me ld-busy is-reserved" aria-hidden="true"')
    expect(html).toContain('class="sk sk-block sk-round" style="width:24px;height:24px"')
    expect(html.match(/sk-text/g)).toHaveLength(2)
    const one = renderToStaticMarkup(createElement(YouRowSkeleton, { lines: 1, reserved: false }))
    expect(one).toContain('class="ws-me ld-busy"')
    expect(one.match(/sk-text/g)).toHaveLength(1)
  })
})
