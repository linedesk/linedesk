// Shared pieces of the admin tables: a sortable column head, an inline confirmation, dates.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { dateTimeLabel } from '../time.ts'
import { Button } from '../ui/kit.tsx'
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

type ConfirmProps = {
  /** What happens, in one sentence. */
  text: ReactNode
  action: string
  /** Set for the heaviest actions: the button unlocks once this is typed. */
  typed?: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

/** The second step of a destructive action, in place: says what will happen, Esc or Cancel backs out. */
export function Confirm({ text, action, typed, onConfirm, onCancel }: ConfirmProps) {
  const [entered, setEntered] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  // Focus moves to the field to type in, else to Cancel: a repeated Enter must not confirm.
  useEffect(() => form.current?.querySelector<HTMLElement>('input, .adm-confirm-cancel')?.focus(), [])
  const unlocked = !typed || entered.trim().toLowerCase() === typed.trim().toLowerCase()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!unlocked || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form ref={form} className="adm-confirm" onSubmit={submit} onKeyDown={e => e.key === 'Escape' && onCancel()}>
      <span className="adm-confirm-text">{text}</span>
      {typed && (
        <label className="k-input adm-confirm-typed">
          <input
            value={entered}
            placeholder={typed}
            aria-label={`Type ${typed} to confirm`}
            autoComplete="off"
            onChange={e => setEntered(e.target.value)}
          />
        </label>
      )}
      <Button type="submit" size="sm" variant="danger" disabled={!unlocked || busy}>
        {action}
      </Button>
      <Button size="sm" variant="ghost" className="adm-confirm-cancel" onClick={onCancel}>
        Cancel
      </Button>
      {error && (
        <span className="adm-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}
