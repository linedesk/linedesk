import type { MessageKey } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { useCanAssign } from '../team/members.ts'
import { Icon, Kbd } from '../ui/kit.tsx'

export type Group = { group: string; rows: [label: string, keys: string[]][] }

// i18n-dynamic: shell.help.*
const SHORTCUTS: Group[] = [
  {
    group: 'help.group.navigate',
    rows: [
      ['help.row.nextCall', ['J']],
      ['help.row.nextCall', ['↓']],
      ['help.row.previousCall', ['K']],
      ['help.row.previousCall', ['↑']],
      ['help.row.openCall', ['⏎']],
      ['help.row.openCall', ['O']],
      ['help.row.backToListClose', ['esc']],
      ['help.row.nextView', ['tab']],
      ['help.row.previousView', ['⇧', 'tab']],
      ['help.row.needsYouHandledSpamRemindersDone', ['1', '–', '5']],
    ],
  },
  {
    group: 'help.group.triage',
    rows: [
      ['help.row.markDone', ['E']],
      ['help.row.markNotDone', ['⇧', 'E']],
      ['help.row.remindMe', ['H']],
      ['help.row.clearReminder', ['⇧', 'H']],
      ['help.row.assignToATeammateOrUnassign', ['A']],
      ['help.row.pickInAMenu', ['1', '–', '9']],
      ['help.row.markReadOrUnread', ['U']],
      ['help.row.spamOrNotSpam', ['!']],
      ['help.row.contactPanelOfTheOpenCall', ['I']],
      ['help.row.listenToALiveCallOr', ['L']],
      ['help.row.takeOverALiveCall', ['⇧', 'T']],
      ['help.row.blockOrUnblockTheNumber', ['⇧', 'B']],
      ['help.row.delete', ['#']],
      ['help.row.undo', ['Z']],
    ],
  },
  {
    group: 'help.group.select',
    rows: [
      ['help.row.selectOrUnselectCall', ['X']],
      ['help.row.selectThisAndTheNextCall', ['⇧', 'J']],
      ['help.row.selectThisAndThePreviousCall', ['⇧', 'K']],
      ['help.row.selectARange', ['⇧', 'click']],
      ['help.row.selectAllInTheView', ['⌘', 'A']],
      ['help.row.clearSelection', ['esc']],
      ['help.row.withCallsSelectedEHU', []],
    ],
  },
  {
    group: 'help.group.contacts',
    rows: [
      ['help.row.newContact', ['N']],
      ['help.row.deleteContact', ['#']],
    ],
  },
  {
    group: 'help.group.goTo',
    rows: [
      ['help.row.inbox', ['G', 'I']],
      ['help.row.done', ['G', 'E']],
      ['help.row.reminders', ['G', 'H']],
      ['help.row.assignedToMe', ['G', 'M']],
      ['help.row.unassigned', ['G', 'U']],
      ['help.row.contacts', ['G', 'C']],
      ['help.row.insights', ['G', 'N']],
      ['help.row.integrations', ['G', 'O']],
      ['help.row.assistant', ['G', 'A']],
      ['help.row.openQuestions', ['G', 'R']],
      ['help.row.workspaceSettings', ['G', 'S']],
      ['help.row.team', ['G', 'T']],
      ['help.row.serverAdmin', ['G', 'D']],
    ],
  },
  {
    group: 'help.group.general',
    rows: [
      ['help.row.searchCalls', ['/']],
      ['help.row.commands', ['⌘', 'K']],
      ['help.row.keyboardShortcuts', ['?']],
      ['help.row.openMenu', ['M']],
      ['help.row.reportBug', ['⇧', 'R']],
      ['help.row.requestFeature', ['⇧', 'F']],
    ],
  },
]

const BULK_ROW = 'help.row.withCallsSelectedEHU'

/** The rows about assigning: shown only while the workspace has more than one member. */
const ASSIGN_ROWS = new Set(['help.row.assignToATeammateOrUnassign', 'help.row.assignedToMe', 'help.row.unassigned'])

/** The shortcuts that apply here, in the active language; without teammates the assign ones are left out. */
export function shortcutsFor(canAssign: boolean): Group[] {
  const { t, format } = i18n()
  const text = (key: string) =>
    key === BULK_ROW
      ? t('shell.help.row.withCallsSelectedEHU', { keys: format.list(['E', 'H', 'U', '#']) })
      : t(`shell.${key}` as MessageKey)
  return SHORTCUTS.map(g => ({
    group: t(`shell.${g.group}` as MessageKey),
    rows: g.rows.filter(([key]) => canAssign || !ASSIGN_ROWS.has(key)).map(([key, keys]) => [text(key), keys]),
  }))
}

/** Matches the action, its group and its keys ("tab", "esc", "⇧ e"), word by word. */
export function filterShortcuts(groups: Group[], query: string): Group[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (group: string, label: string, keys: string[]) => {
    const text = `${group} ${label} ${keys.join(' ')} ${keys.join('')}`.toLowerCase()
    return words.every(w => text.includes(w))
  }
  return groups
    .map(g => ({ ...g, rows: g.rows.filter(([label, keys]) => matches(g.group, label, keys)) }))
    .filter(g => g.rows.length)
}

export function HelpSheet() {
  const t = useT()
  const [query, setQuery] = useState('')
  const groups = filterShortcuts(shortcutsFor(useCanAssign()), query)
  return (
    <div className="help-sheet" role="dialog" aria-modal="true" aria-label={t('shell.help.title')}>
      <div className="help-head">
        <b>{t('shell.help.title')}</b>
        <div className="k-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            placeholder={t('shell.help.find')}
            aria-label={t('shell.help.find')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <Kbd keys={['esc']} />
      </div>
      <div className="help-body">
        {groups.map(g => (
          <section key={g.group} className="help-group">
            <h3>{g.group}</h3>
            {g.rows.map(([label, keys]) => (
              <div key={label + keys.join('')} className="help-row">
                <span>{label}</span>
                <Kbd keys={keys} />
              </div>
            ))}
          </section>
        ))}
        {!groups.length && <div className="help-empty">{t('shell.help.noMatch', { query })}</div>}
      </div>
      <div className="help-foot">
        <span>
          <T k="shell.help.openAnytime" values={{ keys: <Kbd keys={['?']} /> }} />
        </span>
        <span>
          <T k="shell.help.everyAction" values={{ keys: <Kbd keys={['⌘', 'K']} /> }} />
        </span>
      </div>
    </div>
  )
}
