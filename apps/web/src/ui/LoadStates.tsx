// Loading and load-problem states, one standard for the whole app (docs/design-principles.md, "Loading"):
// the page's own words and buttons show at once; an area that waits for data holds its space with a
// skeleton in the shape of what comes (one soft pulse everywhere), shown only after a moment and kept
// long enough not to blink; the data fades in; a load that fails or never ends says so with Try again.
// Spinners belong to buttons the user pressed (kit.tsx Button `busy`), never to page data.
import type { TableName } from '@linedesk/db/types'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { useReadSyncDown, useSnapshotValue } from '../store.tsx'
import { Button, cx } from './kit.tsx'
import { createLoadingGate, initialView, type LoadingView, SLOW_MS } from './loadingGate.ts'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

export type LoadState = 'ready' | 'loading' | 'slow'

/**
 * Whether a synced list can be trusted to be empty. A table that never caught up with the server and
 * has no local rows is still loading, not empty; after a while that becomes a problem worth saying.
 * A table being read again after a change made away from the page (the store's `refreshing`, e.g.
 * back from an OAuth redirect) is loading too: its local rows are from before that change.
 */
export function useLoadState(table: TableName): LoadState {
  const loading = useSnapshotValue(s => s.refreshing.has(table) || (!s.synced.has(table) && s.tables[table].size === 0))
  const readSyncDown = useReadSyncDown()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return setSlow(false)
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [loading])
  // Read sync can't reach the server: it says so at once (LoadProblem), no point waiting for "slow".
  return !loading ? 'ready' : slow || readSyncDown ? 'slow' : 'loading'
}

/**
 * How an area that waits for data looks right now (loadingGate.ts): space reserved, skeleton, slow, or
 * content (fading in when it came after a wait). For areas that can't take the `Loading` wrapper's div.
 */
export function useLoading(loading: boolean): LoadingView {
  const [view, setView] = useState(() => initialView(loading))
  const gate = useRef<ReturnType<typeof createLoadingGate> | null>(null)
  const latest = useRef(loading)
  latest.current = loading
  useEffect(() => {
    const g = createLoadingGate(latest.current, setView)
    gate.current = g
    setView(g.view())
    return () => {
      g.dispose()
      gate.current = null
    }
  }, [])
  useEffect(() => {
    gate.current?.set(loading)
  }, [loading])
  return view
}

/** Every skeleton pulses in step, whenever it appeared (the pulse is 1.4 s, app.css `sk-pulse`). */
const PULSE_MS = 1400
const pulseInStep = (): CSSProperties =>
  ({ '--sk-sync': `-${Math.round(performance.now() % PULSE_MS)}ms` }) as CSSProperties

type LoadingProps = {
  /** What loads, as a person says it ("API keys", "Your calls"): read to screen readers, and the problem's words. */
  what: string
  /** True while there is nothing to show yet (usually `data === undefined`). */
  loading: boolean
  /**
   * The load failed: the server's reason, or true (a synced table that is `slow`). While loading, it
   * replaces the skeleton with LoadProblem; once there is data, the last data stays.
   */
  error?: string | boolean | null
  /** Try again; default: reload the page. */
  onRetry?: () => void
  /** The shape of what comes: Skeleton, SkeletonList, SkeletonRows (same heights and widths as the content). */
  skeleton: ReactNode
  className?: string
  /** The content; only rendered once loading is over, so it may read the data. */
  children?: ReactNode
}

/**
 * An area of a page that waits for data. The rest of the page (headings, labels, buttons that don't need
 * the data) renders outside it, at once.
 */
export function Loading({ what, loading, error, onRetry, skeleton, className, children }: LoadingProps) {
  const failed = loading && Boolean(error)
  const view = useLoading(loading && !failed)
  if (failed || (loading && view.phase === 'slow'))
    return (
      <LoadProblem
        what={what}
        message={typeof error === 'string' ? error : undefined}
        slow={typeof error !== 'string'}
        onRetry={onRetry}
        className={className}
      />
    )
  if (view.phase === 'content') return <div className={cx('ld', view.fadeIn && 'ld-in', className)}>{children}</div>
  return <LoadingArea what={what} reserved={view.phase === 'reserve'} skeleton={skeleton} className={className} />
}

/** The skeleton's frame: busy for screen readers (one quiet line), invisible until it is worth showing. */
function LoadingArea({
  what,
  reserved,
  skeleton,
  className,
}: {
  what: string
  reserved: boolean
  skeleton: ReactNode
  className?: string
}) {
  const t = useT()
  return (
    <div className={cx('ld', 'ld-busy', reserved && 'is-reserved', className)} aria-busy="true" style={pulseInStep()}>
      <span className="sr-only" role="status">
        {t('common.load.loading', { what })}
      </span>
      {skeleton}
    </div>
  )
}

type SkeletonProps = {
  /**
   * `text`: one line of text (the bar sits in a 20px line, like the text it stands for). `field`: an input
   * or select (32px). `title`: a page or card title. `card`: a whole settings card. `block` (default): any
   * other box, sized by `className`, `width` and `height`.
   */
  shape?: 'text' | 'field' | 'title' | 'card' | 'block'
  width?: number | string
  height?: number | string
  className?: string
}

/** One grey shape where something will be. */
export function Skeleton({ shape = 'block', width, height, className }: SkeletonProps) {
  return <span className={cx('sk', `sk-${shape}`, className)} style={{ width, height }} aria-hidden="true" />
}

/**
 * Words in a header or tab that depend on data still loading (the assistant's name): one text bar of the words' width,
 * inline, invisible for a quick load like every skeleton. The area around it announces nothing: it is part of a label.
 */
export function SkeletonText({ width, className }: { width: number | string; className?: string }) {
  const view = useLoading(true)
  return (
    <span className={cx('ld-busy', view.phase === 'reserve' && 'is-reserved', className)} style={pulseInStep()}>
      <Skeleton shape="text" width={width} />
    </span>
  )
}

/** Labelled controls (form.tsx FormField with an input): the label's line and a 32px field, `fields` times. */
export function SkeletonFields({ fields = 2 }: { fields?: number }) {
  return Array.from({ length: fields }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder fields never reorder
    <div key={i} className="k-field" aria-hidden="true">
      <Skeleton shape="text" width={90 + ((i * 41) % 50)} />
      <Skeleton shape="field" width="100%" />
    </div>
  ))
}

/** Widths that vary from row to row, the same on every render (no random jumps). */
const widthFor = (row: number, column: number, min: number, spread: number) => min + ((row * 23 + column * 37) % spread)

type SkeletonListProps = {
  rows?: number
  /** The rows have a muted second line (ListRow `sub`). */
  sub?: boolean
  /** A mark at the left (ListRow `lead`): its size in px. */
  lead?: number
  /** A quiet status at the right (ListRow `aside`). */
  aside?: boolean
  /** A button at the right (ListRow `actions`). */
  action?: boolean
  className?: string
}

/** Rows in the shape of a settings list (ui/list.tsx List and ListRow): same classes, so the same heights. */
export function SkeletonList({ rows = 3, sub = true, lead, aside, action, className }: SkeletonListProps) {
  return (
    <ul className={cx('k-list', 'sk-k-list', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <li key={i} className="k-row">
          <div className="k-row-line">
            {lead ? <Skeleton width={lead} height={lead} className="sk-round" /> : null}
            <span className="k-row-main">
              <span className="k-row-title">
                <Skeleton shape="text" width={widthFor(i, 0, 110, 80)} />
              </span>
              {sub && (
                <span className="k-row-sub">
                  <Skeleton shape="text" width={widthFor(i, 1, 150, 90)} />
                </span>
              )}
            </span>
            {aside && <Skeleton shape="text" width={56} />}
            {action && <Skeleton width={64} height={28} />}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Rows in the shape of a page's grid list with column headings (inbox, contacts, admin tables; ColumnHeads in
 * ui/list.tsx): one bar per column, on the list's own grid (the list's CSS gives `.sk-row` its columns).
 */
export function SkeletonRows({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number
  columns?: number
  className?: string
}) {
  return (
    <div className={cx('sk-list', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <div key={i} className="sk-row">
          {Array.from({ length: columns }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one bar per column
            <Skeleton key={c} shape="text" width={`${widthFor(i, c, 45, 40)}%`} />
          ))}
        </div>
      ))}
    </div>
  )
}

type SkeletonChecklistProps = {
  /**
   * One entry per row: the label's width in px (a step's name, as long as the words it stands for), and optionally
   * the width of the button at the row's right end (a row with an action is as tall as the button).
   */
  rows: readonly { label: number; action?: number }[]
  /** The round mark at the left of every row: its size in px. */
  mark?: number
  /** The real list's and row's classes, so the skeleton has the same gaps and heights. */
  listClassName?: string
  rowClassName?: string
}

/**
 * Rows in the shape of a checklist (setup steps, go-live steps): a round mark, the step's name and, where the step
 * has one, its button. Pass the real list's classes so the rows are exactly as tall as the steps that come.
 */
export function SkeletonChecklist({ rows, mark = 18, listClassName, rowClassName }: SkeletonChecklistProps) {
  return (
    <ul className={cx('sk-checklist', listClassName)} aria-hidden="true">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <li key={i} className={cx('sk-check', rowClassName)}>
          <Skeleton width={mark} height={mark} className="sk-round" />
          <Skeleton shape="text" width={row.label} />
          {row.action ? <Skeleton width={row.action} height={28} className="sk-check-action" /> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * A skeleton in one spot of a page whose loading is already announced once (aria-busy and the hidden line on the
 * page or card around it, see `useLoading`): a title, a button or a line that depends on data that is not there yet.
 * Pass the `LoadingView` phase: `reserve` holds the space without showing the shape (no flash for a quick load).
 */
export function SkeletonPart({
  reserved,
  className,
  children,
}: {
  reserved: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('ld', 'ld-busy', reserved && 'is-reserved', className)} aria-hidden="true" style={pulseInStep()}>
      {children}
    </div>
  )
}

/** Read sync has not reached the server for a while; it keeps retrying by itself, so there is nothing to press. */
function ServerUnreachable({ className }: { className?: string }) {
  const t = useT()
  return (
    <div className={cx('empty', 'load-problem', className)} role="status">
      <b>{t('common.load.unreachable')}</b>
    </div>
  )
}

/** A load that takes longer than usual but has not failed: it shows its content by itself when that arrives. */
function StillLoading({ what, onRetry, className }: { what: string; onRetry?: () => void; className?: string }) {
  const t = useT()
  return (
    <div className={cx('empty', 'load-problem', className)} role="status">
      <b>{t('common.load.slow', { what })}</b>
      <span>{t('common.load.slowHint')}</span>
      <Button size="sm" onClick={onRetry ?? (() => window.location.reload())}>
        {t('common.action.tryAgain')}
      </Button>
    </div>
  )
}

/** The answer of a server that is down or restarting, as the browser reports it. */
const UNREACHABLE = /server answered 5\d\d|failed to fetch|networkerror|load failed/i

/** An error's text as a person reads it: the server's own reason, or what an unreachable server means. */
export const problemText = (message: string | null | undefined) =>
  message && !UNREACHABLE.test(message) ? message : i18n().t('common.load.noAnswer')

type LoadProblemProps = {
  /** "Your calls", "Contacts", "Health": what did not arrive. */
  what: string
  /** The server's own reason, shown when it says more than "not reachable". */
  message?: string
  /**
   * Nothing failed: the load only takes longer than `SLOW_MS` (a big first sync, a busy server). Says it is still
   * loading, not that the server can't be reached; the content replaces it by itself when it arrives.
   */
  slow?: boolean
  /** Default: reload the page (the outbox survives a reload, so changes are kept). */
  onRetry?: () => void
  className?: string
}

/** Something did not load (or takes very long): say so plainly and offer to try again. */
export function LoadProblem({ what, message, slow, onRetry, className }: LoadProblemProps) {
  const t = useT()
  // A synced list (no reason, no retry of its own) while read sync is down: it comes back by itself.
  const readSyncDown = useReadSyncDown()
  if (readSyncDown && !message && !onRetry) return <ServerUnreachable className={className} />
  if (slow && !message) return <StillLoading what={what} onRetry={onRetry} className={className} />
  const unreachable = !message || UNREACHABLE.test(message)
  const reason = unreachable && !onRetry ? t('common.load.noAnswerKept') : problemText(message)
  return (
    <div className={cx('empty', 'load-problem', className)} role="alert">
      <b>{t('common.load.failed', { what })}</b>
      <span>{reason}</span>
      <Button size="sm" onClick={onRetry ?? (() => window.location.reload())}>
        {t('common.action.tryAgain')}
      </Button>
    </div>
  )
}
