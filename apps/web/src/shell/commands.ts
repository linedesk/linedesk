// ⌘K lists what can be done right now: the actions for the selected call, places to go, app commands.
import type { Call, WorkspaceMember } from '@linedesk/db/types'
import { hasReminder } from '../inbox-model.ts'
import { memberLabel } from '../team/members.ts'
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
  /** Flag the call as urgent, or take the flag off (normal). */
  setUrgent?: (call: Call, urgent: boolean) => void
  /** The signed-in member's user id. */
  me: string
  /** Assigning; null while the workspace has a single member (then nothing about it is offered). */
  assign: {
    members: WorkspaceMember[]
    /** The member picker (A). */
    open: (call: Call) => void
    to: (call: Call, userId: string | null, name: string) => void
    /** The calls assigned to a teammate. */
    showMember: (userId: string) => void
  } | null
  /** Whether the call's number is blocked. */
  isBlocked: (call: Call) => boolean
  /** Selecting calls in the list; null when the list is not on screen (a call or another page is open). */
  selection: {
    count: number
    toggle: () => void
    all: () => void
    clear: () => void
  } | null
  goInbox: (tab: 'you' | 'done' | 'reminders' | 'mine' | 'unassigned' | 'review') => void
  /** Owners and admins: the Needs review mode. */
  canReview?: boolean
  goPage: (route: PageRoute) => void
  isInstanceAdmin: boolean
  undo: () => void
  openSearch: () => void
  openHelp: () => void
  /** Set where the install offers the first-use tour (FIRST_USE). */
  showTour?: () => void
  openNav: () => void
  signOut: () => void
  /** Owners and admins after onboarding: opens the go-live checklist again (also after it was closed). */
  showGoLive?: () => void
}

function callCommands(call: Call, c: CommandContext): Command[] {
  const done = call.inbox_state === 'done'
  return [
    done
      ? {
          label: 'Mark not done',
          icon: 'restart',
          shortcut: ['⇧', 'E'],
          run: () => c.markNotDone(call),
        }
      : {
          label: 'Mark done',
          icon: 'check',
          shortcut: ['E'],
          run: () => c.markDone(call),
        },
    {
      label: 'Remind me',
      icon: 'clock',
      shortcut: ['H'],
      run: () => c.openRemind(call),
    },
    ...(c.assign ? assignCommands(call, c.assign, c.me) : []),
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
          icon: 'flag',
          shortcut: ['!'],
          run: () => c.toggleSpam(call),
        },
    {
      label: c.isBlocked(call) ? 'Unblock number' : 'Block number',
      keywords: 'blocklist robocall spam caller',
      icon: 'ban',
      shortcut: ['⇧', 'B'],
      run: () => c.toggleBlock(call),
    },
    {
      label: 'Delete call',
      keywords: 'remove trash',
      icon: 'trash',
      shortcut: ['#'],
      run: () => c.remove(call),
    },
    ...urgentCommands(call, c),
  ]
}

/** Mark urgent, or Not urgent on an urgent call: the team's own say over the urgent flag. */
function urgentCommands(call: Call, c: CommandContext): Command[] {
  const setUrgent = c.setUrgent
  if (!setUrgent) return []
  return call.urgency === 'urgent'
    ? [
        {
          label: 'Not urgent',
          keywords: 'urgent flag emergency priority',
          icon: 'close',
          run: () => setUrgent(call, false),
        },
      ]
    : [
        {
          label: 'Mark urgent',
          keywords: 'urgent flag emergency priority',
          icon: 'flag',
          run: () => setUrgent(call, true),
        },
      ]
}

/**
 * Assign… opens the picker; Unassign when someone has the call. Typing a teammate's name finds
 * "Assign to <name>" directly (never yourself: that goes through the picker).
 */
function assignCommands(call: Call, a: NonNullable<CommandContext['assign']>, me: string): Command[] {
  const teammates = a.members.filter(m => m.user_id !== me && m.user_id !== call.assignee_id)
  return [
    {
      label: 'Assign…',
      keywords: 'assign teammate hand over owner',
      icon: 'user',
      shortcut: ['A'],
      run: () => a.open(call),
    },
    ...(call.assignee_id
      ? [
          {
            label: 'Unassign',
            keywords: 'assign nobody remove',
            icon: 'close',
            run: () => a.to(call, null, ''),
          } satisfies Command,
        ]
      : []),
    ...teammates.map(
      (m): Command => ({
        label: `Assign to ${memberLabel(m)}`,
        keywords: 'assign teammate',
        avatar: memberLabel(m),
        searchOnly: true,
        run: () => a.to(call, m.user_id, memberLabel(m)),
      }),
    ),
  ]
}

function assigneeViewCommands(a: NonNullable<CommandContext['assign']>, c: CommandContext): Command[] {
  return [
    {
      label: 'Go to Assigned to me',
      icon: 'user',
      shortcut: ['G', 'M'],
      run: () => c.goInbox('mine'),
    },
    {
      label: 'Go to Unassigned',
      keywords: 'nobody no one',
      icon: 'users',
      shortcut: ['G', 'U'],
      run: () => c.goInbox('unassigned'),
    },
    ...a.members
      .filter(m => m.user_id !== c.me)
      .map(
        (m): Command => ({
          label: `Go to ${memberLabel(m)}'s calls`,
          keywords: 'assigned to filter teammate',
          avatar: memberLabel(m),
          searchOnly: true,
          run: () => a.showMember(m.user_id),
        }),
      ),
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
    ...(c.target
      ? [
          {
            label: `Selected call · ${c.targetName}`,
            items: callCommands(c.target, c),
          },
        ]
      : []),
    ...(c.selection ? [{ label: 'Select', items: selectCommands(c.selection, !!c.target) }] : []),
    {
      label: 'Go to',
      items: [
        {
          label: 'Go to Inbox',
          icon: 'phone',
          shortcut: ['G', 'I'],
          run: () => c.goInbox('you'),
        },
        {
          label: 'Go to Done',
          icon: 'check',
          shortcut: ['G', 'E'],
          run: () => c.goInbox('done'),
        },
        {
          label: 'Go to Reminders',
          icon: 'clock',
          shortcut: ['G', 'H'],
          run: () => c.goInbox('reminders'),
        },
        ...(c.assign ? assigneeViewCommands(c.assign, c) : []),
        ...(c.canReview
          ? [
              {
                label: 'Go to Needs review',
                icon: 'flag' as const,
                shortcut: ['G', 'R'],
                run: () => c.goInbox('review'),
              },
            ]
          : []),
        {
          label: 'Go to Assistant',
          icon: 'waveform',
          shortcut: ['G', 'A'],
          run: () => c.goPage('assistant'),
        },
        {
          label: 'Go to Contacts',
          icon: 'contact',
          shortcut: ['G', 'C'],
          run: () => c.goPage('contacts'),
        },
        {
          label: 'Go to Insights',
          keywords: 'analytics stats reports numbers',
          icon: 'chart',
          shortcut: ['G', 'N'],
          run: () => c.goPage('insights'),
        },
        {
          label: 'Go to Team',
          icon: 'users',
          shortcut: ['G', 'T'],
          run: () => c.goPage('team'),
        },
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
                icon: 'shield',
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
        {
          label: 'Search calls',
          icon: 'search',
          shortcut: ['/'],
          run: c.openSearch,
        },
        {
          label: 'Show keyboard shortcuts',
          icon: 'keyboard',
          shortcut: ['?'],
          run: c.openHelp,
        },
        ...(c.showTour
          ? [{ label: 'Show the tour', keywords: 'help intro', icon: 'spark' as const, run: c.showTour }]
          : []),
        { label: 'Open menu', icon: 'menu', shortcut: ['M'], run: c.openNav },
        ...(c.showGoLive
          ? [
              {
                label: 'Show go-live checklist',
                keywords: 'setup checklist next steps',
                icon: 'tasks' as const,
                run: c.showGoLive,
              },
            ]
          : []),
        {
          label: 'Account settings',
          icon: 'user',
          run: () => c.goPage('account'),
        },
        { label: 'Sign out', icon: 'arrow-up-right', run: c.signOut },
      ],
    },
  ]
}
