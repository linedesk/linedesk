// Loading and load-problem states for lists filled by read sync (inbox, contacts). Same wording as
// the admin area's ListSkeleton / LoadError: grey rows while loading, plain words and Try again.
import type { TableName } from '@callfront/db/types'
import { useEffect, useState } from 'react'
import { useSnapshot } from '../store.tsx'
import { Button } from './kit.tsx'

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
export function SkeletonRows({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div className="sk-list" role="status" aria-busy="true" aria-label={label}>
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

/** The first load takes too long: say so plainly and offer to try again (the outbox survives a reload). */
export function LoadProblem({ what }: { what: string }) {
  return (
    <div className="empty" role="alert">
      <b>{what} could not be loaded yet.</b>
      <span>The server did not answer. It may be restarting, or this device is offline. Your changes are kept.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </div>
  )
}
