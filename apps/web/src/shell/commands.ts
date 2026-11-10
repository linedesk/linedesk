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
  toggleSpam: (call: Call) => void
  toggleBlock: (call: Call) => void
  /** Whether the call's number is blocked. */
  isBlocked: (call: Call) => boolean
  /** Selecting calls in the list; null when the list is not on screen (a call or another page is open). */
  selection: { count: number; toggle: () => void; all: () => void; clear: () => void } | null
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
    done
      ? { label: 'Mark not done', icon: 'restart', shortcut: ['⇧', 'E'], run: () => c.markNotDone(call) }
      : { label: 'Mark done', icon: 'check', shortcut: ['E'], run: () => c.markDone(call) },
    { label: 'Remind me', icon: 'clock', shortcut: ['H'], run: () => c.openRemind(call) },
    ...(hasReminder(call) && !done
      ? [
          {
            label: 'Clear reminder',
            icon: 'restart',
            shortcut: ['⇧', 'H'],
            run: () => c.clearReminder(call),
          } satisfies Command,
        ]
      : []),
    {
      label: call.unread ? 'Mark read' : 'Mark unread',
      keywords: 'read unread',
      icon: 'checks',
      shortcut: ['U'],
      run: () => c.toggleUnread(call),
    },
    call.outcome === 'spam'
      ? {
          label: 'Not spam',
          keywords: 'rescue real caller',
          icon: 'restart',
          shortcut: ['!'],
          run: () => c.toggleSpam(call),
        }
      : {
          label: 'Move to Spam',
          keywords: 'junk sales robocall',
          icon: 'phone-off',
          shortcut: ['!'],
          run: () => c.toggleSpam(call),
        },
    {
      label: c.isBlocked(call) ? 'Unblock number' : 'Block number',
      keywords: 'blocklist robocall spam caller',
      icon: 'phone-off',
      shortcut: ['⇧', 'B'],
      run: () => c.toggleBlock(call),
    },
    { label: 'Delete call', keywords: 'remove trash', icon: 'trash', shortcut: ['#'], run: () => c.remove(call) },
  ]
}

function selectCommands(s: NonNullable<CommandContext['selection']>, hasTarget: boolean): Command[] {
  return [
    ...(hasTarget && !s.count
      ? [
          {
            label: 'Select call',
            keywords: 'pick several bulk',
            icon: 'check',
            shortcut: ['X'],
            run: s.toggle,
          } satisfies Command,
        ]
      : []),
    {
      label: 'Select all in the view',
      keywords: 'pick several bulk',
      icon: 'checks',
      shortcut: ['⌘', 'A'],
      run: s.all,
    },
    ...(s.count
      ? [
          {
            label: 'Clear selection',
            keywords: 'unselect',
            icon: 'restart',
            shortcut: ['esc'],
            run: s.clear,
          } satisfies Command,
        ]
      : []),
  ]
}

export function commandGroups(c: CommandContext): CommandGroup<Command>[] {
  return [
    ...(c.target ? [{ label: `Selected call · ${c.targetName}`, items: callCommands(c.target, c) }] : []),
    ...(c.selection ? [{ label: 'Select', items: selectCommands(c.selection, !!c.target) }] : []),
    {
      label: 'Go to',
      items: [
        { label: 'Go to Inbox', icon: 'phone', shortcut: ['G', 'I'], run: () => c.goInbox('you') },
        { label: 'Go to Done', icon: 'check', shortcut: ['G', 'E'], run: () => c.goInbox('done') },
        { label: 'Go to Reminders', icon: 'clock', shortcut: ['G', 'H'], run: () => c.goInbox('reminders') },
        { label: 'Go to Contacts', icon: 'users', shortcut: ['G', 'C'], run: () => c.goPage('contacts') },
        { label: 'Go to Assistant', icon: 'waveform', shortcut: ['G', 'A'], run: () => c.goPage('assistant') },
        { label: 'Go to Team', icon: 'users', shortcut: ['G', 'T'], run: () => c.goPage('team') },
        {
          label: 'Go to Settings',
          keywords: 'phone number notifications recordings',
          icon: 'gear',
          shortcut: ['G', 'S'],
          run: () => c.goPage('settings'),
        },
        ...(c.isInstanceAdmin
          ? [
              {
                label: 'Go to Admin',
                icon: 'gear',
                shortcut: ['G', 'D'],
                run: () => c.goPage('admin'),
              } satisfies Command,
            ]
          : []),
      ],
    },
    {
      label: 'App',
      items: [
        { label: 'Undo', icon: 'restart', shortcut: ['Z'], run: c.undo },
        { label: 'Search calls', icon: 'search', shortcut: ['/'], run: c.openSearch },
        { label: 'Show keyboard shortcuts', icon: 'keyboard', shortcut: ['?'], run: c.openHelp },
        { label: 'Open menu', icon: 'menu', shortcut: ['M'], run: c.openNav },
        { label: 'Account settings', icon: 'user', run: () => c.goPage('account') },
        { label: 'Sign out', icon: 'arrow-up-right', run: c.signOut },
      ],
    },
  ]
}
