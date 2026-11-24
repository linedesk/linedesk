// Palette used for ⌘K and for pick lists (numbered: 1–9 pick an item).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { IconName } from './icons.ts'
import { Avatar, Icon, Kbd } from './kit.tsx'
import { useT } from '@linedesk/i18n/react'

/** `hint` is a quiet detail after the label, for example the time behind "Tomorrow morning". */
/** `keywords` are other words that find the item ("unread" finds "Mark read"). */
/** `avatar`: a person's name, shown as their picture (`avatarSrc`) or initials in place of an icon. `searchOnly`: listed only once something is typed. */
export type CommandItem = {
  label: string
  icon?: IconName
  avatar?: string
  avatarSrc?: string | null
  shortcut?: string[]
  hint?: string
  keywords?: string
  searchOnly?: boolean
}
export type CommandGroup<T extends CommandItem = CommandItem> = { label: string | null; items: T[] }
export type SelectVia = 'key' | 'mouse'

/** A phone or tablet without a keyboard: focusing the search would open the on-screen keyboard over the list. */
const touchOnly = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches

/** 4 prefix, 3 every token starts a word, 2 word initials, 1 substring, 0 no match. */
export function commandScore(label: string, query: string): number {
  const l = label.toLowerCase(),
    q = query.toLowerCase().trim()
  if (!q) return 1
  if (l.startsWith(q)) return 4
  const words = l.split(/[^a-z0-9]+/).filter(Boolean)
  if (q.split(/\s+/).every(t => words.some(w => w.startsWith(t)))) return 3
  const compact = q.replace(/\s+/g, '')
  if (
    compact.length > 1 &&
    words
      .map(w => w[0])
      .join('')
      .startsWith(compact)
  )
    return 2
  return l.includes(q) ? 1 : 0
}

export function rank<T extends CommandItem>(groups: CommandGroup<T>[], query: string): CommandGroup<T>[] {
  if (!query.trim())
    return groups.map(g => ({ ...g, items: g.items.filter(it => !it.searchOnly) })).filter(g => g.items.length)
  const seen = new Set<string>()
  const ranked = groups
    .flatMap(g => g.items)
    .filter(it => !seen.has(it.label) && seen.add(it.label))
    .map((it, order) => ({
      it,
      score: Math.max(commandScore(it.label, query), it.keywords ? commandScore(it.keywords, query) - 1 : 0),
      order,
    }))
    .filter(r => r.score)
    .sort((a, b) => b.score - a.score || a.order - b.order)
  return ranked.length ? [{ label: null, items: ranked.map(r => r.it) }] : []
}

type Props<T extends CommandItem> = {
  groups: CommandGroup<T>[]
  onSelect: (item: T, via: SelectVia) => void
  placeholder?: string
  numbered?: boolean
  /** Items made from what was typed (a reminder time), shown first and never filtered away. */
  fromQuery?: (query: string) => CommandGroup<T> | null
  /** The dialog's name for screen readers. */
  label?: string
}

export function CommandMenu<T extends CommandItem>({
  groups,
  onSelect,
  placeholder,
  numbered,
  fromQuery,
  label,
}: Props<T>) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionId = (n: number) => `${listId}-${n}`
  const typed = query.trim() ? fromQuery?.(query) : null
  const shown = [...(typed?.items.length ? [typed] : []), ...rank(groups, query)]
  const flat = shown.flatMap(g => g.items)
  const index = Math.min(active, Math.max(flat.length - 1, 0))

  function onKey(e: KeyboardEvent) {
    const count = Math.max(flat.length, 1)
    const picked = numbered && !query && !e.repeat && /^[1-9]$/.test(e.key) ? flat[Number(e.key) - 1] : undefined
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((index + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((index - 1 + count) % count)
    } else if (e.key === 'Enter' && !e.repeat && flat[index]) onSelect(flat[index], 'key')
    else if (picked) {
      e.preventDefault()
      onSelect(picked, 'key')
    }
  }

  // Touch screens: focus rests on the panel, so the overlay's focus trap leaves the search alone.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (touchOnly()) panel.current?.focus()
  }, [])

  let n = -1
  return (
    <div className="k-cmd" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label ?? t('common.commandMenu.label')}>
      <div className="k-cmd-search">
        <Icon name="search" />
        <input
          autoFocus={!touchOnly()}
          value={query}
          placeholder={placeholder ?? t('common.commandMenu.placeholder')}
          aria-label={t('common.commandMenu.search')}
          autoComplete="off"
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat.length ? optionId(index) : undefined}
          onChange={e => {
            setQuery(e.target.value)
            setActive(0)
          }}
        />
        <Kbd keys={['esc']} />
      </div>
      <div className="k-cmd-list" role="listbox" id={listId}>
        {!flat.length && <div className="k-cmd-empty">{t('common.commandMenu.noResults', { query })}</div>}
        {shown.map(g => (
          <div key={g.label ?? 'results'} role="group" aria-label={g.label ?? undefined}>
            {g.label && <div className="k-cmd-group">{g.label}</div>}
            {g.items.map(it => {
              const me = ++n
              return (
                <div
                  key={it.label}
                  id={optionId(me)}
                  className="k-cmd-item"
                  role="option"
                  aria-selected={me === index}
                  onMouseEnter={() => setActive(me)}
                  onClick={() => onSelect(it, 'mouse')}
                >
                  {it.avatar !== undefined ? <Avatar name={it.avatar} size={20} src={it.avatarSrc} /> : it.icon && <Icon name={it.icon} />}
                  <span>
                    {it.label}
                    {it.hint && <small className="k-cmd-hint">{it.hint}</small>}
                  </span>
                  {it.shortcut ? (
                    <Kbd keys={it.shortcut} />
                  ) : numbered && me < 9 ? (
                    <Kbd keys={[String(me + 1)]} />
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="k-cmd-foot">
        <span>
          <Kbd keys={['↑', '↓']} />
          {t('common.commandMenu.select')}
        </span>
        <span>
          <Kbd keys={['⏎']} />
          {t('common.commandMenu.run')}
        </span>
        <span>
          <Kbd keys={['esc']} />
          {t('common.commandMenu.close')}
        </span>
      </div>
    </div>
  )
}
