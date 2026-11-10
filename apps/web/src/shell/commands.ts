// ⌘K lists what can be done right now: the actions for the selected call, places to go, app commands.
import type { Call } from '@callfront/db/types'
import { hasReminder } from '../inbox-model.ts'
import type { CommandGroup, CommandItem } from '../ui/CommandMenu.tsx'
import type { PageRoute } from './pages.tsx'

export type Command = CommandItem & { run: () => void }

export type CommandContext = {
  target: Call | undefined
  targetName: string
  markDone: (call: Call) => void
  markNotDone: (call: Call) => void
  openRemind: (call: Call) => void
  clearReminder: (call: Call) => void
  toggleUnread: (call: Call) => void
  remove: (call: Call) => void
  goInbox: (tab: 'you' | 'done' | 'reminders') => void
  goPage: (route: PageRoute) => void
  isInstanceAdmin: boolean
  undo: () => void
  openSearch: () => void
  openHelp: () => void
  openNav: () => void
  signOut: () => void
}

function callCommands(call: Call, c: CommandContext): Command[] {
  const done = call.inbox_state === 'done'
  return [
    done ? { label: 'Mark not done', icon: 'restart', shortcut: ['⇧', 'E'], run: () => c.markNotDone(call) } : { label: 'Mark done', icon: 'check', shortcut: ['E'], run: () => c.markDone(call) },
    { label: 'Remind me', icon: 'clock', shortcut: ['H'], run: () => c.openRemind(call) },
    ...(hasReminder(call) && !done ? [{ label: 'Clear reminder', icon: 'restart', shortcut: ['⇧', 'H'], run: () => c.clearReminder(call) } satisfies Command] : []),
    { label: call.unread ? 'Mark read' : 'Mark unread', icon: 'checks', shortcut: ['U'], run: () => c.toggleUnread(call) },
    { label: 'Delete call', icon: 'trash', shortcut: ['#'], run: () => c.remove(call) },
  ]
}

export function commandGroups(c: CommandContext): CommandGroup<Command>[] {
  return [
    ...(c.target ? [{ label: `Selected call · ${c.targetName}`, items: callCommands(c.target, c) }] : []),
    { label: 'Go to', items: [
      { label: 'Go to Inbox', icon: 'phone', shortcut: ['G', 'I'], run: () => c.goInbox('you') },
      { label: 'Go to Done', icon: 'check', shortcut: ['G', 'E'], run: () => c.goInbox('done') },
      { label: 'Go to Reminders', icon: 'clock', shortcut: ['G', 'H'], run: () => c.goInbox('reminders') },
      { label: 'Go to Assistant', icon: 'waveform', shortcut: ['G', 'A'], run: () => c.goPage('assistant') },
      ...(c.isInstanceAdmin ? [{ label: 'Go to Admin', icon: 'gear', shortcut: ['G', 'D'], run: () => c.goPage('admin') } satisfies Command] : []),
    ] },
    { label: 'App', items: [
      { label: 'Undo', icon: 'restart', shortcut: ['Z'], run: c.undo },
      { label: 'Search calls', icon: 'search', shortcut: ['/'], run: c.openSearch },
      { label: 'Show keyboard shortcuts', icon: 'keyboard', shortcut: ['?'], run: c.openHelp },
      { label: 'Open menu', icon: 'menu', shortcut: ['M'], run: c.openNav },
      { label: 'Account settings', icon: 'user', run: () => c.goPage('account') },
      { label: 'Sign out', icon: 'arrow-up-right', run: c.signOut },
    ] },
  ]
}
