import { useState } from 'react'
import { useCanAssign } from '../team/members.ts'
import { Icon, Kbd } from '../ui/kit.tsx'

export type Group = { group: string; rows: [label: string, keys: string[]][] }

export const SHORTCUTS: Group[] = [
  {
    group: 'Navigate',
    rows: [
      ['Next call', ['J']],
      ['Next call', ['↓']],
      ['Previous call', ['K']],
      ['Previous call', ['↑']],
      ['Open call', ['⏎']],
      ['Open call', ['O']],
      ['Back to list, close', ['esc']],
      ['Next view', ['tab']],
      ['Previous view', ['⇧', 'tab']],
      ['Needs you · Handled · Spam · Reminders · Done', ['1', '–', '5']],
    ],
  },
  {
    group: 'Triage',
    rows: [
      ['Mark done', ['E']],
      ['Mark not done', ['⇧', 'E']],
      ['Remind me', ['H']],
      ['Clear reminder', ['⇧', 'H']],
      ['Assign to a teammate, or unassign', ['A']],
      ['Pick in a menu', ['1', '–', '9']],
      ['Mark read or unread', ['U']],
      ['Spam, or not spam', ['!']],
      ['Contact panel of the open call', ['I']],
      ['Listen to a live call, or stop', ['L']],
      ['Take over a live call', ['⇧', 'T']],
      ['Block or unblock the number', ['⇧', 'B']],
      ['Delete', ['#']],
      ['Undo', ['Z']],
    ],
  },
  {
    group: 'Select',
    rows: [
      ['Select or unselect call', ['X']],
      ['Select this and the next call', ['⇧', 'J']],
      ['Select this and the previous call', ['⇧', 'K']],
      ['Select a range', ['⇧', 'click']],
      ['Select all in the view', ['⌘', 'A']],
      ['Clear selection', ['esc']],
      ['With calls selected, E, H, U and # act on all of them', []],
    ],
  },
  {
    group: 'Contacts',
    rows: [
      ['New contact', ['N']],
      ['Delete contact', ['#']],
    ],
  },
  {
    group: 'Go to',
    rows: [
      ['Inbox', ['G', 'I']],
      ['Done', ['G', 'E']],
      ['Reminders', ['G', 'H']],
      ['Assigned to me', ['G', 'M']],
      ['Unassigned', ['G', 'U']],
      ['Contacts', ['G', 'C']],
      ['Insights', ['G', 'N']],
      ['Assistant', ['G', 'A']],
      ['Workspace settings', ['G', 'S']],
      ['Workspace settings › Team', ['G', 'T']],
      ['Admin (instance admins)', ['G', 'D']],
    ],
  },
  {
    group: 'General',
    rows: [
      ['Search calls', ['/']],
      ['Commands', ['⌘', 'K']],
      ['Keyboard shortcuts', ['?']],
      ['Open menu', ['M']],
    ],
  },
]

/** The rows about assigning: shown only while the workspace has more than one member. */
const ASSIGN_ROWS = new Set(['Assign to a teammate, or unassign', 'Assigned to me', 'Unassigned'])

/** The shortcuts that apply here; without teammates the assign ones are left out. */
export const shortcutsFor = (canAssign: boolean): Group[] =>
  canAssign ? SHORTCUTS : SHORTCUTS.map(g => ({ ...g, rows: g.rows.filter(([label]) => !ASSIGN_ROWS.has(label)) }))

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
  const [query, setQuery] = useState('')
  const groups = filterShortcuts(shortcutsFor(useCanAssign()), query)
  return (
    <div className="help-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="help-head">
        <b>Keyboard shortcuts</b>
        <div className="k-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            placeholder="Find a shortcut"
            aria-label="Find a shortcut"
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
        {!groups.length && <div className="help-empty">No shortcut matches “{query}”.</div>}
      </div>
      <div className="help-foot">
        <span>
          Open this anytime with <Kbd keys={['?']} />
        </span>
        <span>
          Every action is also in <Kbd keys={['⌘', 'K']} />
        </span>
      </div>
    </div>
  )
}
