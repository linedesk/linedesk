// Loading and load-problem states, one set for the whole app (inbox, contacts, admin): grey
// placeholders while something loads, plain words and Try again when it does not arrive.
import type { TableName } from '@linedesk/db/types'
import { useEffect, useState } from 'react'
import { useReadSyncDown, useSnapshot } from '../store.tsx'
import { Button, cx } from './kit.tsx'

/** After this long without a first load, the list says so and offers to try again. */
const SLOW_MS = 12_000

export type LoadState = 'ready' | 'loading' | 'slow'

/**
 * Whether a synced list can be trusted to be empty. A table that never caught up with the server and
 * has no local rows is still loading, not empty; after a while that becomes a problem worth saying.
 * A table being read again after a change made away from the page (the store's `refreshing`, e.g.
 * back from an OAuth redirect) is loading too: its local rows are from before that change.
 */
export function useLoadState(table: TableName): LoadState {
  const { synced, tables, refreshing, readSyncDown } = useSnapshot()
  const loading = refreshing.has(table) || (!synced.has(table) && tables[table].size === 0)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [loading])
  // Read sync can't reach the server: it says so at once (LoadProblem), no point waiting for "slow".
  return !loading ? 'ready' : slow || readSyncDown ? 'slow' : 'loading'
}

/** Read sync has not reached the server for a while; it keeps retrying by itself, so there is nothing to press. */
function ServerUnreachable({ className }: { className?: string }) {
  return (
    <div className={cx('empty', 'load-problem', className)} role="status">
      <b>Can't reach the server. Retrying…</b>
    </div>
  )
}

/** Grey rows in the shape of a list, while it loads. */
export function SkeletonRows({ label, rows = 6, className }: { label: string; rows?: number; className?: string }) {
  if (useReadSyncDown()) return <ServerUnreachable className={className} />
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
const NO_ANSWER = 'The server did not answer. It may be restarting, or this device is offline.'

/** An error's text as a person reads it: the server's own reason, or what an unreachable server means. */
export const problemText = (message: string | null | undefined) =>
  message && !UNREACHABLE.test(message) ? message : NO_ANSWER

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
  // A synced list (no reason, no retry of its own) while read sync is down: it comes back by itself.
  const readSyncDown = useReadSyncDown()
  if (readSyncDown && !message && !onRetry) return <ServerUnreachable className={className} />
  const unreachable = !message || UNREACHABLE.test(message)
  const reason = unreachable && !onRetry ? `${NO_ANSWER} Your changes are kept.` : problemText(message)
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
