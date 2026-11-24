// Shared pieces of the admin tables: a sortable column head and dates.
// Loading and error states are the app's own (ui/LoadStates.tsx).
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { dateTimeLabel } from '../time.ts'
import { nextSort, type Sort, type SortDir } from './model.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

/** What an empty cell shows, in every admin table. */
export const EMPTY = '—'

export const day = (iso: string) => fmt().dateTime(new Date(iso), { month: 'short', day: 'numeric', year: 'numeric' })
export const when = (iso: string | null) => (iso ? dateTimeLabel(new Date(iso)) : i18n().t('admin.list.never'))

export function useSort<K extends string>(initial: Sort<K>) {
  const [sort, setSort] = useState(initial)
  return { sort, toggle: (key: K, first: SortDir) => setSort(current => nextSort(current, key, first)) }
}

type SortThProps<K extends string> = {
  label: string
  column: K
  first?: SortDir
  sort: Sort<K>
  onSort: (key: K, first: SortDir) => void
  numeric?: boolean
}

/** A column head that sorts. The arrow shows the direction; screen readers get `aria-sort`. */
export function SortTh<K extends string>({ label, column, first = 'asc', sort, onSort, numeric }: SortThProps<K>) {
  const t = useT()
  const active = sort.key === column
  return (
    <th
      scope="col"
      className={numeric ? 'adm-num' : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className="adm-sort"
        title={t('admin.list.sortBy', { column: label })}
        onClick={() => onSort(column, first)}
      >
        {label}
        <span aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )
}
