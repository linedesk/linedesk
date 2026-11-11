// Shared pieces of the admin tables: a sortable column head and dates.
// Loading and error states are the app's own (ui/LoadStates.tsx).
import { useState } from 'react'
import { dateTimeLabel } from '../time.ts'
import { nextSort, type Sort, type SortDir } from './model.ts'

export const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
export const when = (iso: string | null) => (iso ? dateTimeLabel(new Date(iso)) : 'Never')

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
        title={`Sort by ${label.toLowerCase()}`}
        onClick={() => onSort(column, first)}
      >
        {label}
        <span aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  )
}
