// Loading and load-problem states, one set for the whole app (inbox, contacts, admin): grey
// placeholders while something loads, plain words and Try again when it does not arrive.
import type { TableName } from '@callfront/db/types'
import { useEffect, useState } from 'react'
import { useSnapshot } from '../store.tsx'
import { Button, cx } from './kit.tsx'

/** After this long without a first load, the list says so and offers to try again. */
const SLOW_MS = 12_000

export type LoadState = 'ready' | 'loading' | 'slow'

/**
 * Whether a synced list can be trusted to be empty. A table that never caught up with the server and
 * has no local rows is still loading, not empty; after a while that becomes a problem worth saying.
 */
export function useLoadState(table: TableName): LoadState {
  const { synced, tables } = useSnapshot()
  const loading = !synced.has(table) && tables[table].size === 0
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [loading])
  return !loading ? 'ready' : slow ? 'slow' : 'loading'
}

/** Grey rows in the shape of a list, while it loads. */
export function SkeletonRows({ label, rows = 6, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div className={cx('sk-list', className)} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => 110 + ((i * 23) % 50)).map((nameWidth, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <div key={i} className="sk-row">
          <i style={{ width: nameWidth }} />
          <i style={{ flex: 1 }} />
          <i style={{ width: 70 }} />
          <i style={{ width: 56 }} />
        </div>
      ))}
    </div>
  )
}

/** A grey block in the shape of what is loading (a stat tile, a card). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('sk-block', className)} aria-hidden="true" />
}

/** The answer of a server that is down or restarting, as the browser reports it. */
const UNREACHABLE = /server answered 5\d\d|failed to fetch|networkerror|load failed/i

type LoadProblemProps = {
  /** "Your calls", "Contacts", "Health": what did not arrive. */
  what: string
  /** The server's own reason, shown when it says more than "not reachable". */
  message?: string
  /** Default: reload the page (the outbox survives a reload, so changes are kept). */
  onRetry?: () => void
  className?: string
}

/** Something did not load: say so plainly and offer to try again. */
export function LoadProblem({ what, message, onRetry, className }: LoadProblemProps) {
  const reason =
    message && !UNREACHABLE.test(message)
      ? message
      : `The server did not answer. It may be restarting, or this device is offline.${onRetry ? '' : ' Your changes are kept.'}`
  return (
    <div className={cx('empty', 'load-problem', className)} role="alert">
      <b>{what} could not be loaded.</b>
      <span>{reason}</span>
      <Button size="sm" onClick={onRetry ?? (() => window.location.reload())}>
        Try again
      </Button>
    </div>
  )
}
