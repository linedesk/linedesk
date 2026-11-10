import { useState } from 'react'
import { Icon, Kbd } from '../ui/kit.tsx'

type Group = { group: string; rows: [label: string, keys: string[]][] }

const SHORTCUTS: Group[] = [
  { group: 'Navigate', rows: [['Next call', ['J']], ['Next call', ['↓']], ['Previous call', ['K']], ['Previous call', ['↑']], ['Open call', ['⏎']], ['Open call', ['O']], ['Back to list, close', ['esc']], ['Next split', ['tab']], ['Previous split', ['⇧', 'tab']], ['Needs you · Handled · Spam · Reminders · Done', ['1', '–', '5']]] },
  { group: 'Triage', rows: [['Mark done', ['E']], ['Mark not done', ['⇧', 'E']], ['Remind me', ['H']], ['Clear reminder', ['⇧', 'H']], ['Pick in a menu', ['1', '–', '9']], ['Mark read or unread', ['U']], ['Delete', ['#']], ['Undo', ['Z']]] },
  { group: 'Go to', rows: [['Inbox', ['G', 'I']], ['Done', ['G', 'E']], ['Reminders', ['G', 'H']], ['Assistant', ['G', 'A']]] },
  { group: 'General', rows: [['Search calls', ['/']], ['Commands', ['⌘', 'K']], ['Keyboard shortcuts', ['?']], ['Open menu', ['M']]] },
]

export function HelpSheet() {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const groups = SHORTCUTS.map(g => ({ ...g, rows: g.rows.filter(([label]) => `${g.group} ${label}`.toLowerCase().includes(q)) })).filter(g => g.rows.length)
  return (
    <div className="help-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="help-head">
        <b>Keyboard shortcuts</b>
        <div className="k-input"><Icon name="search" size={15} /><input autoFocus placeholder="Find a shortcut" aria-label="Find a shortcut" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <Kbd keys={['esc']} />
      </div>
      <div className="help-body">
        {groups.map(g => (
          <section key={g.group} className="help-group">
            <h3>{g.group}</h3>
            {g.rows.map(([label, keys]) => <div key={label + keys.join('')} className="help-row"><span>{label}</span><Kbd keys={keys} /></div>)}
          </section>
        ))}
        {!groups.length && <div className="help-empty">No shortcut matches “{query}”.</div>}
      </div>
      <div className="help-foot"><span>Open this anytime with <Kbd keys={['?']} /></span><span>Every action is also in <Kbd keys={['⌘', 'K']} /></span></div>
    </div>
  )
}
