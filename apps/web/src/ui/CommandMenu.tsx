// Palette used for ⌘K and for pick lists (numbered: 1–9 pick an item).
import { useId, useState, type KeyboardEvent } from 'react'
import type { IconName } from './icons.ts'
import { Icon, Kbd } from './kit.tsx'

/** `hint` is a quiet detail after the label, for example the time behind "Tomorrow morning". */
/** `keywords` are other words that find the item ("unread" finds "Mark read"). */
export type CommandItem = { label: string; icon?: IconName; shortcut?: string[]; hint?: string; keywords?: string }
export type CommandGroup<T extends CommandItem = CommandItem> = { label: string | null; items: T[] }
export type SelectVia = 'key' | 'mouse'

/** 4 prefix, 3 every token starts a word, 2 word initials, 1 substring, 0 no match. */
export function commandScore(label: string, query: string): number {
  const l = label.toLowerCase(), q = query.toLowerCase().trim()
  if (!q) return 1
  if (l.startsWith(q)) return 4
  const words = l.split(/[^a-z0-9]+/).filter(Boolean)
  if (q.split(/\s+/).every(t => words.some(w => w.startsWith(t)))) return 3
  const compact = q.replace(/\s+/g, '')
  if (compact.length > 1 && words.map(w => w[0]).join('').startsWith(compact)) return 2
  return l.includes(q) ? 1 : 0
}

export function rank<T extends CommandItem>(groups: CommandGroup<T>[], query: string): CommandGroup<T>[] {
  if (!query.trim()) return groups.filter(g => g.items.length)
  const seen = new Set<string>()
  const ranked = groups.flatMap(g => g.items)
    .filter(it => !seen.has(it.label) && seen.add(it.label))
    .map((it, order) => ({ it, score: Math.max(commandScore(it.label, query), it.keywords ? commandScore(it.keywords, query) - 1 : 0), order }))
    .filter(r => r.score)
    .sort((a, b) => b.score - a.score || a.order - b.order)
  return ranked.length ? [{ label: null, items: ranked.map(r => r.it) }] : []
}

type Props<T extends CommandItem> = {
  groups: CommandGroup<T>[]
  onSelect: (item: T, via: SelectVia) => void
  placeholder?: string
  numbered?: boolean
}

export function CommandMenu<T extends CommandItem>({ groups, onSelect, placeholder = 'Type a command …', numbered }: Props<T>) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionId = (n: number) => `${listId}-${n}`
  const shown = rank(groups, query)
  const flat = shown.flatMap(g => g.items)
  const index = Math.min(active, Math.max(flat.length - 1, 0))

  function onKey(e: KeyboardEvent) {
    const count = Math.max(flat.length, 1)
    const picked = numbered && !query && /^[1-9]$/.test(e.key) ? flat[Number(e.key) - 1] : undefined
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((index + 1) % count) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((index - 1 + count) % count) }
    else if (e.key === 'Enter' && flat[index]) onSelect(flat[index], 'key')
    else if (picked) { e.preventDefault(); onSelect(picked, 'key') }
  }

  let n = -1
  return (
    <div className="k-cmd" role="dialog" aria-modal="true" aria-label="Commands">
      <div className="k-cmd-search">
        <Icon name="search" />
        <input autoFocus value={query} placeholder={placeholder} aria-label="Search commands" autoComplete="off" onKeyDown={onKey}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={flat.length ? optionId(index) : undefined}
          onChange={e => { setQuery(e.target.value); setActive(0) }} />
        <Kbd keys={['esc']} />
      </div>
      <div className="k-cmd-list" role="listbox" id={listId}>
        {!flat.length && <div className="k-cmd-empty">No results for “{query}”</div>}
        {shown.map(g => (
          <div key={g.label ?? 'results'} role="group" aria-label={g.label ?? undefined}>
            {g.label && <div className="k-cmd-group">{g.label}</div>}
            {g.items.map(it => {
              const me = ++n
              return (
                <div key={it.label} id={optionId(me)} className="k-cmd-item" role="option" aria-selected={me === index} onMouseEnter={() => setActive(me)} onClick={() => onSelect(it, 'mouse')}>
                  {it.icon && <Icon name={it.icon} />}
                  <span>{it.label}{it.hint && <small className="k-cmd-hint">{it.hint}</small>}</span>
                  {it.shortcut ? <Kbd keys={it.shortcut} /> : numbered && me < 9 ? <Kbd keys={[String(me + 1)]} /> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="k-cmd-foot">
        <span><Kbd keys={['↑', '↓']} />select</span>
        <span><Kbd keys={['⏎']} />run</span>
        <span><Kbd keys={['esc']} />close</span>
      </div>
    </div>
  )
}
