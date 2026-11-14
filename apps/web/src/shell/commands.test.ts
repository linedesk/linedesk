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

  it('rename, notifications and leave are found by typing, and open their section', () => {
    const c = context()
    const places: [string, ...unknown[]][] = [
      ['Rename workspace', 'workspace', 'general'],
      ['Notifications', 'account', 'notifications'],
      ['Leave workspace…', 'workspace', 'danger'],
    ]
    for (const [label, ...to] of places) {
      const command = find(c, label)
      expect(command.searchOnly).toBe(true)
      command.run()
      expect(c.goPage).toHaveBeenLastCalledWith(...to)
    }
  })

  it('Account is a place like the others, and the old names are gone', () => {
    const c = context()
    find(c, 'Go to Account').run()
    expect(c.goPage).toHaveBeenLastCalledWith('account')
    const labels = commandGroups(c).flatMap(g => g.items.map(i => i.label))
    expect(labels).not.toContain('Go to Settings')
    expect(labels).not.toContain('Account settings')
  })
})
