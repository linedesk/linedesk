// A select with a search field on top of its list, for long lists (the workspace's country, its language). Arrow
// keys move, Enter picks, Esc closes; the search owns its keys, so none reaches the app's shortcuts.
import { useT } from '@linedesk/i18n/react'
import { Fragment, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAnchoredList } from './floating.ts'
import { cx, Icon } from './kit.tsx'
import './search-select.css'

export type SearchOption = {
  value: string
  label: string
  /** Shown before the label (a flag). */
  icon?: string
  /** Shown at the right of the option (a code). */
  meta?: string
  /** A heading over this option and the ones after it with the same group; only while nothing is searched. */
  group?: string
}

type Props = {
  value: string
  options: readonly SearchOption[]
  onChange: (value: string) => void
  /** Accessible name; also the tooltip. */
  label: string
  /** The options matching what was typed, best first; default: the label or meta contains it. */
  search?: (options: readonly SearchOption[], query: string) => SearchOption[]
  placeholder?: string
  id?: string
  disabled?: boolean
  /** Shown while the value is none of the options (nothing picked yet). */
  empty?: string
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Options whose label starts with what was typed first, then those that contain it, or whose meta is it. */
export function searchOptions(options: readonly SearchOption[], query: string): SearchOption[] {
  const q = fold(query.trim())
  if (!q) return [...options]
  const rank = (o: SearchOption) => {
    const label = fold(o.label)
    if (label.startsWith(q) || fold(o.meta ?? '') === q) return 0
    if (label.split(/[\s(,-]+/).some(word => word.startsWith(q))) return 1
    return label.includes(q) ? 2 : -1
  }
  return options
    .map(({ group: _group, ...o }) => o)
    .filter(o => rank(o) >= 0)
    .sort((a, b) => rank(a) - rank(b))
}

export function SearchSelect({
  value,
  options,
  onChange,
  label,
  search = searchOptions,
  placeholder,
  id,
  disabled,
  empty,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const matches = useMemo(() => (open ? search(options, query) : []), [open, options, query, search])
  const current = options.find(o => o.value === value)

  useAnchoredList(open, button, list, { minWidth: 260 })
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  function show() {
    if (disabled) return
    setQuery('')
    setActive(
      Math.max(
        0,
        options.findIndex(o => o.value === value),
      ),
    )
    setOpen(true)
  }
  function close() {
    setOpen(false)
    button.current?.focus()
  }
  function pick(next: string) {
    close()
    if (next !== value) onChange(next)
  }
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => Math.min(matches.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = matches[active]
      if (o) pick(o.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={cx('k-select', 'k-select-md', 'k-ssel', open && 'open')} ref={root}>
      <button
        ref={button}
        id={id}
        type="button"
        className="k-select-btn"
        disabled={disabled}
        title={label}
        aria-label={`${label}: ${current?.label ?? (empty || value)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            show()
          }
        }}
      >
        {current?.icon && <span className="k-ssel-icon">{current.icon}</span>}
        <span className={cx('k-ssel-label', !current && empty && 'k-ssel-empty')}>{current?.label ?? (empty || value)}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div ref={list} popover="manual" className="k-select-list k-ssel-list k-float">
          <input
            autoFocus
            className="k-ssel-search"
            placeholder={placeholder ?? t('common.searchSelect.placeholder')}
            aria-label={t('common.searchSelect.searchLabel', { label })}
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKey}
          />
          <div id={listId} role="listbox" aria-label={label} className="k-ssel-options">
            {matches.map((o, i) => (
              <Fragment key={o.value}>
                {o.group && o.group !== matches[i - 1]?.group && (
                  <div className="k-ssel-group" aria-hidden>
                    {o.group}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  className={cx('k-select-opt', i === active && 'active')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                >
                  <span className="k-select-opt-t">
                    {o.icon && <span className="k-ssel-icon">{o.icon}</span>}
                    <span>{o.label}</span>
                  </span>
                  {o.meta && <span className="k-ssel-meta">{o.meta}</span>}
                  {o.value === value && <Icon name="check" size={14} />}
                </div>
              </Fragment>
            ))}
            {!matches.length && <div className="k-ssel-empty">{t('common.searchSelect.noMatch', { query })}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
