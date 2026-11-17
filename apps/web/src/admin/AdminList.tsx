// A list for the admin pages: search, sorting by a column, a keyboard cursor (J/K, Enter opens,
// / searches) and a click that opens the row. `rowActions` adds quick actions at the end of a row.
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { cx, Icon } from '../ui/kit.tsx'
import { ShortcutHints } from '../ui/listPage.tsx'
import { type SortDir, sortRows } from './model.ts'

export type Column<T> = {
  key: string
  label: string
  render: (row: T) => ReactNode
  /** Sortable when set. */
  sort?: (row: T) => string | number | null
  firstDir?: SortDir
  numeric?: boolean
  /** Hidden on narrow screens. */
  wide?: boolean
}

/** Keys the list handles; admin mode routes them here while the list is shown. */
export type ListKeys = (key: string) => boolean

type Props<T> = {
  rows: readonly T[]
  rowId: (row: T) => string
  columns: Column<T>[]
  initialSort: { key: string; dir: SortDir }
  searchText: (row: T) => string
  searchLabel: string
  /** The table's name for screen readers ("Workspaces"); the search label when not given. */
  label?: string
  onOpen: (row: T) => void
  keysRef: { current: ListKeys | null }
  empty: ReactNode
  /** Quick actions at the right end of a row (shown on hover, focus or the cursor). */
  rowActions?: (row: T) => ReactNode
  /** Controls under the search, such as a filter (Users: "No workspace"). */
  tools?: ReactNode
}

export function AdminList<T>({
  rows,
  rowId,
  columns,
  initialSort,
  searchText,
  searchLabel,
  label,
  onOpen,
  keysRef,
  empty,
  rowActions,
  tools,
}: Props<T>) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState(initialSort)
  const [cursor, setCursor] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const found = q ? rows.filter(r => searchText(r).toLowerCase().includes(q)) : rows
    const column = columns.find(c => c.key === sort.key)
    return column?.sort ? sortRows(found, column.sort, sort.dir) : [...found]
  }, [rows, query, sort, columns, searchText])
  const at = Math.min(cursor, Math.max(0, shown.length - 1))

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll the cursor row into view whenever the cursor moves
  useEffect(() => {
    list.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at])
  useEffect(() => {
    keysRef.current = key => {
      if (key === '/') search.current?.focus()
      else if (key === 'j' || key === 'ArrowDown') setCursor(Math.min(at + 1, shown.length - 1))
      else if (key === 'k' || key === 'ArrowUp') setCursor(Math.max(at - 1, 0))
      else if (key === 'Enter' && shown[at]) onOpen(shown[at]!)
      else return false
      return true
    }
    return () => {
      keysRef.current = null
    }
  }, [keysRef, at, shown, onOpen])

  const toggle = (column: Column<T>) =>
    setSort(s =>
      s.key === column.key
        ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, dir: column.firstDir ?? 'asc' },
    )

  return (
    <>
      <div className="adm-card adm-listcard">
        <label className="k-input adm-search">
          <Icon name="search" size={15} />
          <input
            ref={search}
            value={query}
            placeholder={searchLabel}
            aria-label={searchLabel}
            onChange={e => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
                if (e.key === 'Enter' && shown[at]) onOpen(shown[at]!)
              }
            }}
          />
          <kbd className="k-kbd">/</kbd>
        </label>
        {tools}
        <div className="adm-list" role="table" aria-label={label ?? searchLabel} ref={list}>
          <div className="adm-row adm-row-head" role="row">
            {columns.map(c => (
              <div
                key={c.key}
                role="columnheader"
                className={cx('adm-cell', c.numeric && 'adm-num', c.wide && 'adm-wide')}
                aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.sort ? (
                  <button
                    type="button"
                    className="adm-sort"
                    title={t('admin.list.sortBy', { column: c.label })}
                    onClick={() => toggle(c)}
                  >
                    {c.label}
                    <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
                  </button>
                ) : (
                  c.label
                )}
              </div>
            ))}
          </div>
          {shown.map((row, i) => (
            <div
              key={rowId(row)}
              role="row"
              tabIndex={-1}
              data-cursor={i === at}
              className={cx('adm-row', i === at && 'is-cursor')}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onOpen(row)}
            >
              {columns.map(c => (
                <div key={c.key} role="cell" className={cx('adm-cell', c.numeric && 'adm-num', c.wide && 'adm-wide')}>
                  {c.render(row)}
                </div>
              ))}
              {rowActions && <div className="adm-cell adm-cell-acts">{rowActions(row)}</div>}
            </div>
          ))}
          {!shown.length && <p className="adm-empty">{query ? t('admin.list.noMatch', { query }) : empty}</p>}
        </div>
      </div>
      <ShortcutHints
        hints={[
          [['⏎'], t('common.shortcut.open')],
          [['esc'], t('admin.list.back')],
        ]}
      />
    </>
  )
}
