// ⌘K lists what can be done right now: the actions for the selected call, places to go, app commands.
import type { Call, WorkspaceMember } from '@linedesk/db/types'
import { DOCS_URL, openReport, REPORT_KEYS } from '../feedback/report.ts'
import { i18n } from '../i18n/index.tsx'
import { hasReminder } from '../inbox-model.ts'
import { memberAvatar, memberLabel } from '../team/members.ts'
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
  /** Owners and admins (call:erase): Delete… asks whether to delete permanently now. */
  confirmDelete?: (call: Call) => void
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
  goInbox: (tab: 'you' | 'done' | 'reminders' | 'mine' | 'unassigned') => void
  /** Owners and admins: How <assistant> did, in the Assistant area (named after `assistantName`). */
  canReview?: boolean
  assistantName?: string
  /** Open a page, or one section of it (`goPage('workspace', 'team')`). */
  goPage: (route: PageRoute, section?: string) => void
  isInstanceAdmin: boolean
  /** The workspace's owner, who cannot leave it (only hand it over or delete it): no "Leave workspace…" then. */
  isOwner?: boolean
  undo: () => void
  openSearch: () => void
  openHelp: () => void
  /** Set where the install offers the first-use tour (FIRST_USE). */
  showTour?: () => void
  /** Set where this account may create a workspace (as in the workspace menu): opens New workspace. */
  newWorkspace?: () => void
  openNav: () => void
  signOut: () => void
  /** Owners and admins after onboarding: opens the go-live checklist again (also after it was closed). */
  showGoLive?: () => void
}

function callCommands(call: Call, c: CommandContext): Command[] {
  const { t } = i18n()
  const done = call.inbox_state === 'done'
  return [
    done
      ? {
          label: t('shell.command.markNotDone'),
          hint: t('inbox.action.notDoneHint'),
          icon: 'restart',
          shortcut: ['⇧', 'E'],
          run: () => c.markNotDone(call),
        }
      : {
          label: t('shell.command.markDone'),
          icon: 'check',
          shortcut: ['E'],
          run: () => c.markDone(call),
        },
    {
      label: t('shell.command.remindMe'),
      icon: 'clock',
      shortcut: ['H'],
      run: () => c.openRemind(call),
    },
    ...(c.assign ? assignCommands(call, c.assign, c.me) : []),
    ...(hasReminder(call) && !done
      ? [
          {
            label: t('shell.command.clearReminder'),
            icon: 'restart',
            shortcut: ['⇧', 'H'],
            run: () => c.clearReminder(call),
          } satisfies Command,
        ]
      : []),
    {
      label: call.unread ? t('shell.command.markRead') : t('shell.command.markUnread'),
      keywords: 'read unread',
      icon: 'checks',
      shortcut: ['U'],
      run: () => c.toggleUnread(call),
    },
    call.outcome === 'spam'
      ? {
          label: t('shell.command.notSpam'),
          keywords: 'rescue real caller',
          icon: 'restart',
          shortcut: ['!'],
          run: () => c.toggleSpam(call),
        }
      : {
          label: t('shell.command.moveToSpam'),
          keywords: 'junk sales robocall',
          icon: 'flag',
          shortcut: ['!'],
          run: () => c.toggleSpam(call),
        },
    {
      label: c.isBlocked(call) ? t('shell.command.unblockNumber') : t('shell.command.blockNumber'),
      keywords: 'blocklist robocall spam caller',
      icon: 'ban',
      shortcut: ['⇧', 'B'],
      run: () => c.toggleBlock(call),
    },
    {
      label: t('shell.command.deleteCall'),
      keywords: 'remove trash',
      icon: 'trash',
      shortcut: ['#'],
      run: () => c.remove(call),
    },
    ...(c.confirmDelete
      ? [
          {
            label: t('shell.command.deleteChoose'),
            hint: t('shell.command.deleteChooseHint'),
            keywords: 'remove trash erase permanently forever',
            icon: 'trash',
            run: () => c.confirmDelete!(call),
          } satisfies Command,
        ]
      : []),
    ...urgentCommands(call, c),
  ]
}

/** Mark urgent, or Not urgent on an urgent call: the team's own say over the urgent flag. */
function urgentCommands(call: Call, c: CommandContext): Command[] {
  const { t } = i18n()
  const setUrgent = c.setUrgent
  if (!setUrgent) return []
  return call.urgency === 'urgent'
    ? [
        {
          label: t('shell.command.notUrgent'),
          keywords: 'urgent flag emergency priority',
          icon: 'close',
          run: () => setUrgent(call, false),
        },
      ]
    : [
        {
          label: t('shell.command.markUrgent'),
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
  const { t } = i18n()
  const teammates = a.members.filter(m => m.user_id !== me && m.user_id !== call.assignee_id)
  return [
    {
      label: t('shell.command.assign'),
      keywords: 'assign teammate hand over owner',
      icon: 'user',
      shortcut: ['A'],
      run: () => a.open(call),
    },
    ...(call.assignee_id
      ? [
          {
            label: t('shell.command.unassign'),
            keywords: 'assign nobody remove',
            icon: 'close',
            run: () => a.to(call, null, ''),
          } satisfies Command,
        ]
      : []),
    ...teammates.map(
      (m): Command => ({
        label: t('shell.command.assignTo', { name: memberLabel(m) }),
        keywords: 'assign teammate',
        avatar: memberLabel(m),
        avatarSrc: memberAvatar(m),
        searchOnly: true,
        run: () => a.to(call, m.user_id, memberLabel(m)),
      }),
    ),
  ]
}

function assigneeViewCommands(a: NonNullable<CommandContext['assign']>, c: CommandContext): Command[] {
  const { t } = i18n()
  return [
    {
      label: t('shell.command.goToAssignedToMe'),
      icon: 'user',
      shortcut: ['G', 'M'],
      run: () => c.goInbox('mine'),
    },
    {
      label: t('shell.command.goToUnassigned'),
      keywords: 'nobody no one',
      icon: 'users',
      shortcut: ['G', 'U'],
      run: () => c.goInbox('unassigned'),
    },
    ...a.members
      .filter(m => m.user_id !== c.me)
      .map(
        (m): Command => ({
          label: t('shell.command.goToMemberCalls', { name: memberLabel(m) }),
          keywords: 'assigned to filter teammate',
          avatar: memberLabel(m),
          avatarSrc: memberAvatar(m),
          searchOnly: true,
          run: () => a.showMember(m.user_id),
        }),
      ),
  ]
}

function selectCommands(s: NonNullable<CommandContext['selection']>, hasTarget: boolean): Command[] {
  const { t } = i18n()
  return [
    ...(hasTarget && !s.count
      ? [
          {
            label: t('shell.command.selectCall'),
            keywords: 'pick several bulk',
            icon: 'check',
            shortcut: ['X'],
            run: s.toggle,
          } satisfies Command,
        ]
      : []),
    {
      label: t('shell.command.selectAllInTheView'),
      keywords: 'pick several bulk',
      icon: 'checks',
      shortcut: ['⌘', 'A'],
      run: s.all,
    },
    ...(s.count
      ? [
          {
            label: t('shell.command.clearSelection'),
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
  const { t } = i18n()
  return [
    ...(c.target
      ? [
          {
            label: t('shell.command.selectedCall', { name: c.targetName }),
            items: callCommands(c.target, c),
          },
        ]
      : []),
    ...(c.selection ? [{ label: t('shell.command.select'), items: selectCommands(c.selection, !!c.target) }] : []),
    {
      label: t('shell.command.goTo'),
      items: [
        {
          label: t('shell.command.goToInbox'),
          icon: 'phone',
          shortcut: ['G', 'I'],
          run: () => c.goInbox('you'),
        },
        {
          label: t('shell.command.goToDone'),
          icon: 'check',
          shortcut: ['G', 'E'],
          run: () => c.goInbox('done'),
        },
        {
          label: t('shell.command.goToReminders'),
          icon: 'clock',
          shortcut: ['G', 'H'],
          run: () => c.goInbox('reminders'),
        },
        ...(c.assign ? assigneeViewCommands(c.assign, c) : []),
        {
          label: t('shell.command.goToAssistant'),
          icon: 'waveform',
          shortcut: ['G', 'A'],
          run: () => c.goPage('assistant'),
        },
        ...(c.canReview
          ? [
              {
                label: t('shell.command.goToOpenQuestions'),
                icon: 'flag' as const,
                shortcut: ['G', 'R'],
                run: () => c.goPage('assistant', 'review'),
              },
            ]
          : []),
        {
          label: t('shell.command.goToContacts'),
          icon: 'contact',
          shortcut: ['G', 'C'],
          run: () => c.goPage('contacts'),
        },
        {
          label: t('shell.command.goToInsights'),
          keywords: 'analytics stats reports numbers',
          icon: 'chart',
          shortcut: ['G', 'N'],
          run: () => c.goPage('insights'),
        },
        {
          label: t('shell.command.goToIntegrations'),
          keywords: 'zapier make n8n webhooks calendar api keys mcp developers connect apps',
          icon: 'plug',
          shortcut: ['G', 'O'],
          run: () => c.goPage('integrations'),
        },
        {
          label: t('shell.command.apiKeys'),
          keywords: 'token developers integrations',
          icon: 'shield',
          searchOnly: true,
          run: () => c.goPage('integrations', 'api-keys'),
        },
        {
          label: t('shell.command.zapier'),
          keywords: 'zap automation integrations',
          icon: 'plug',
          searchOnly: true,
          run: () => c.goPage('integrations', 'zapier'),
        },
        {
          label: t('shell.command.goToWorkspaceSettings'),
          keywords: 'settings phone numbers recordings export rename team leave',
          icon: 'gear',
          shortcut: ['G', 'S'],
          run: () => c.goPage('workspace'),
        },
        {
          label: t('shell.command.goToTeam'),
          icon: 'users',
          shortcut: ['G', 'T'],
          run: () => c.goPage('workspace', 'team'),
        },
        {
          label: t('shell.command.renameWorkspace'),
          keywords: 'business name',
          icon: 'gear',
          searchOnly: true,
          run: () => c.goPage('workspace', 'general'),
        },
        {
          label: t('shell.command.timeZone'),
          keywords: 'timezone clock date business hours',
          icon: 'clock',
          searchOnly: true,
          run: () => c.goPage('workspace', 'general'),
        },
        {
          label: t('shell.command.appointmentValue'),
          keywords: 'job value worth money currency insights booked',
          icon: 'chart',
          searchOnly: true,
          run: () => c.goPage('workspace', 'general'),
        },
        {
          label: t('shell.command.notifications'),
          keywords: 'email push device alerts',
          icon: 'bell',
          searchOnly: true,
          run: () => c.goPage('account', 'notifications'),
        },
        ...(c.isOwner
          ? []
          : [
              {
                label: t('shell.command.leaveWorkspace'),
                keywords: 'quit exit danger',
                icon: 'users',
                searchOnly: true,
                run: () => c.goPage('workspace', 'danger'),
              } satisfies Command,
            ]),
        ...(c.newWorkspace
          ? [
              {
                label: t('shell.workspaceMenu.newWorkspace'),
                keywords: 'create add business workspace',
                icon: 'plus',
                run: c.newWorkspace,
              } satisfies Command,
            ]
          : []),
        ...(c.isInstanceAdmin
          ? [
              {
                label: t('shell.command.goToServerAdmin'),
                icon: 'shield',
                shortcut: ['G', 'D'],
                run: () => c.goPage('admin'),
              } satisfies Command,
            ]
          : []),
      ],
    },
    {
      label: t('shell.command.app'),
      items: [
        { label: t('shell.command.undo'), icon: 'restart', shortcut: ['Z'], run: c.undo },
        {
          label: t('shell.command.searchCalls'),
          icon: 'search',
          shortcut: ['/'],
          run: c.openSearch,
        },
        {
          label: t('shell.command.showKeyboardShortcuts'),
          icon: 'keyboard',
          shortcut: ['?'],
          run: c.openHelp,
        },
        ...(c.showTour
          ? [{ label: t('shell.command.showTheTour'), keywords: 'help intro', icon: 'spark' as const, run: c.showTour }]
          : []),
        { label: t('shell.command.openMenu'), icon: 'menu', shortcut: ['M'], run: c.openNav },
        ...(c.showGoLive
          ? [
              {
                label: t('shell.command.showGoLiveChecklist'),
                keywords: 'setup checklist next steps',
                icon: 'tasks' as const,
                run: c.showGoLive,
              },
            ]
          : []),
        {
          label: t('shell.command.goToAccountSettings'),
          keywords: 'account settings profile password passkeys sessions',
          icon: 'user',
          run: () => c.goPage('account'),
        },
        {
          label: t('shell.command.changeLanguage'),
          keywords: 'language locale translation idioma langue sprache 言語',
          icon: 'globe',
          run: () => c.goPage('account', 'preferences'),
        },
        {
          label: t('shell.command.reportBug'),
          keywords: 'help feedback problem error broken support',
          icon: 'bug',
          shortcut: REPORT_KEYS.bug,
          run: () => openReport('bug'),
        },
        {
          label: t('shell.command.requestFeature'),
          keywords: 'help feedback idea wish suggestion',
          icon: 'bulb',
          shortcut: REPORT_KEYS.feature,
          run: () => openReport('feature'),
        },
        {
          label: t('shell.command.documentation'),
          keywords: 'help docs guide manual readme',
          icon: 'book',
          run: () => void window.open(DOCS_URL, '_blank', 'noopener'),
        },
        { label: t('shell.command.signOut'), icon: 'arrow-up-right', run: c.signOut },
      ],
    },
  ]
}
