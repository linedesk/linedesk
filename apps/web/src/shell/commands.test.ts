import { avatarUrlOf } from '@linedesk/actions'
import type { Call, WorkspaceMember } from '@linedesk/db/types'
import { describe, expect, it, vi } from 'vitest'
import { type CommandContext, commandGroups } from './commands.ts'

function context(): CommandContext {
  const noop = () => {}
  return {
    target: undefined,
    targetName: '',
    markDone: noop,
    markNotDone: noop,
    openRemind: noop,
    clearReminder: noop,
    toggleUnread: noop,
    remove: noop,
    toggleSpam: noop,
    toggleBlock: noop,
    me: 'u_1',
    assign: null,
    isBlocked: () => false,
    selection: null,
    goInbox: noop,
    goPage: vi.fn(),
    isInstanceAdmin: false,
    undo: noop,
    openSearch: noop,
    openHelp: noop,
    openNav: noop,
    signOut: noop,
  }
}

const find = (c: CommandContext, label: string) => {
  const found = commandGroups(c)
    .flatMap(g => g.items)
    .find(i => i.label === label)
  if (!found) throw new Error(`No command "${label}"`)
  return found
}

describe('⌘K places (LIN-165)', () => {
  it('Workspace settings (G S) and its Team section (G T)', () => {
    const c = context()
    const settings = find(c, 'Go to Workspace settings')
    expect(settings.shortcut).toEqual(['G', 'S'])
    for (const word of ['settings', 'phone numbers', 'recordings', 'export', 'api keys', 'rename', 'team', 'leave'])
      expect(settings.keywords).toContain(word)
    settings.run()
    expect(c.goPage).toHaveBeenLastCalledWith('workspace')
    const team = find(c, 'Go to Team')
    expect(team.shortcut).toEqual(['G', 'T'])
    team.run()
    expect(c.goPage).toHaveBeenLastCalledWith('workspace', 'team')
  })

  it('rename, time zone, appointment value, notifications and leave are found by typing, and open their section', () => {
    const c = context()
    const places: [string, ...unknown[]][] = [
      ['Rename workspace', 'workspace', 'general'],
      ['Time zone', 'workspace', 'general'],
      ['Appointment value', 'workspace', 'general'],
      ['Notifications', 'account', 'notifications'],
      ['Leave workspace…', 'workspace', 'danger'],
    ]
    for (const [label, ...to] of places) {
      const command = find(c, label)
      expect(command.searchOnly).toBe(true)
      command.run()
      expect(c.goPage).toHaveBeenLastCalledWith(...to)
    }
    expect(find(c, 'Appointment value').keywords).toContain('job')
  })

  it('Account is a place like the others, and the old names are gone', () => {
    const c = context()
    find(c, 'Go to Account settings').run()
    expect(c.goPage).toHaveBeenLastCalledWith('account')
    const labels = commandGroups(c).flatMap(g => g.items.map(i => i.label))
    expect(labels).not.toContain('Go to Settings')
    expect(labels).not.toContain('Account settings')
  })
})

describe('⌘K teammates show their picture (LIN-198)', () => {
  const member = (user_id: string, name: string, avatar_version: string | null) =>
    ({ id: `m-${user_id}`, user_id, name, avatar_version }) as unknown as WorkspaceMember
  const assign = {
    members: [member('u_1', 'Mike Brennan', 'me1'), member('u_2', 'Sam Ortiz', 'v2'), member('u_3', 'Ana Ruiz', null)],
    open: vi.fn(),
    to: vi.fn(),
    showMember: vi.fn(),
  }

  it('"Assign to …" and "Go to …\'s calls": the picture, or the initials without one', () => {
    const c = { ...context(), assign, target: { id: 'c1', assignee_id: null } as unknown as Call, targetName: 'Caller' }
    expect(find(c, 'Assign to Sam Ortiz')).toMatchObject({ avatar: 'Sam Ortiz', avatarSrc: avatarUrlOf('u_2', 'v2') })
    expect(find(c, 'Assign to Ana Ruiz')).toMatchObject({ avatar: 'Ana Ruiz', avatarSrc: null })
    expect(find(c, "Go to Sam Ortiz's calls")).toMatchObject({ avatarSrc: avatarUrlOf('u_2', 'v2') })
    expect(find(c, "Go to Ana Ruiz's calls")).toMatchObject({ avatarSrc: null })
  })
})
