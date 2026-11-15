import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { SegmentsByCall } from '../call/segments.ts'
import type { CallGroups, InboxTab } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { inboxHints } from './hints.ts'
import { Checkbox } from '../ui/controls.tsx'
import { cx, Icon } from '../ui/kit.tsx'
import { Loading, SkeletonRows, useLoading, useLoadState } from '../ui/LoadStates.tsx'
import { ColumnHeads } from '../ui/list.tsx'
import { ShortcutHints } from '../ui/listPage.tsx'
import type { BulkActions } from './BulkBar.tsx'
import { InboxHead, type InboxHeadProps } from './InboxHead.tsx'
import { InboxEmpty } from './InboxEmpty.tsx'
import { listFrame } from './listFrame.ts'
import { Row, type RowHandlers, rowLabel } from './Row.tsx'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'

type Props = InboxHeadProps &
  RowHandlers & {
    list: Call[]
    segments: SegmentsByCall
    cursor: string | null
    leaving: string | null
    entering: string | null
    menu?: ReactNode
    selected: ReadonlySet<string>
    bulk: BulkActions
    groups: CallGroups
    /** Beside the calls on wide windows, above them on narrow ones: the go-live checklist. */
    aside?: ReactNode
    /** One line above the calls until the first real call: what happens when one comes in. */
    firstCallHint?: string | null
  }

const viewHeading = {
  you: msg('inbox.view.you'),
  ai: msg('inbox.heading.handled'),
  spam: msg('inbox.view.spam'),
  reminders: msg('inbox.view.reminders'),
  done: msg('inbox.view.done'),
  mine: msg('inbox.view.mine'),
  member: msg('inbox.heading.member'),
  unassigned: msg('inbox.view.unassigned'),
} satisfies Record<InboxTab, MessageKey>
/** What the status column shows in each view; search lists calls of every view, so there it is the status. */
const statusHeading: Partial<Record<InboxTab, MessageKey>> = {
  you: msg('inbox.column.nextStep'),
  reminders: msg('inbox.column.reminder'),
}

/**
 * Above the calls: a box that selects every call in the view (a dash while only some are), and a
 * heading per column. Sticks to the top while the list scrolls.
 */
function ListHead({
  tab,
  searching,
  total,
  bulk,
  ref,
}: {
  tab: InboxTab
  searching: boolean
  total: number
  bulk: BulkActions
  ref?: Ref<HTMLDivElement>
}) {
  const t = useT()
  const all = bulk.count > 0 && bulk.count >= total
  const some = bulk.count > 0 && !all
  // An empty view keeps its headings; the box is there, but there is nothing to select.
  const none = total === 0
  const lead = (
    <>
      {/* Like a row's box: the click is handled here, so the box only shows the selection. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the checkbox inside is the control; its click (and Space) arrive here */}
      <span
        className="ib-cols-check"
        title={
          all
            ? t('common.withKey', { label: t('inbox.select.unselectAll'), key: 'Esc' })
            : t('common.withKey', { label: t('inbox.select.selectAll'), key: '⌘ A' })
        }
        onClick={e => {
          e.stopPropagation()
          if (none) return
          // A click on the label would click the input a second time; one on the input itself (Space) toggles it the way the selection goes.
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
          if (all) bulk.onClear()
          else bulk.onSelectAll()
        }}
      >
        <Checkbox
          checked={all}
          indeterminate={some}
          disabled={none}
          label={all ? t('inbox.select.unselectAllCalls') : t('inbox.select.selectAllCalls')}
          onChange={() => {}}
        >
          <span className="ib-cols-all">{all ? t('inbox.select.allSelected') : t('inbox.select.selectAll')}</span>
        </Checkbox>
      </span>
    </>
  )
  return (
    <ColumnHeads
      ref={ref}
      lead={total > 0 ? lead : undefined}
      labels={[
        t('inbox.column.time'),
        t('inbox.column.caller'),
        t('inbox.column.call'),
        t((!searching && statusHeading[tab]) || 'inbox.column.status'),
        t('inbox.column.duration'),
      ]}
    />
  )
}

function Hints({ tab, hasRows }: { tab: InboxTab; hasRows: boolean }) {
  const t = useT()
  return <ShortcutHints move={hasRows} hints={inboxHints(tab, hasRows).map(([keys, label]) => [keys, t(label)])} />
}

const NO_SEGMENTS: TranscriptSegment[] = []
const HANDLERS = [
  'onOpen',
  'onHover',
  'onToggleDone',
  'onToggleUnread',
  'onRemind',
  'onClearReminder',
  'onCommands',
  'onAssign',
  'onSelect',
] as const satisfies readonly (keyof RowHandlers)[]

/**
 * The row handlers with a stable identity, each calling the latest one passed in, so a memoized row
 * does not render again just because the inbox did. Which handlers exist decides what a row offers
 * (no assign button without onAssign), so a handler that comes or goes makes a new set.
 */
function useStableHandlers(handlers: RowHandlers): RowHandlers {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const present = HANDLERS.filter(name => handlers[name]).join()
  return useMemo(() => {
    const call =
      (name: (typeof HANDLERS)[number]) =>
      (...args: unknown[]) =>
        (latest.current[name] as ((...a: unknown[]) => void) | undefined)?.(...args)
    return Object.fromEntries(
      present
        .split(',')
        .filter(Boolean)
        .map(name => [name, call(name as (typeof HANDLERS)[number])]),
    )
  }, [present])
}

/**
 * Rows above and below the viewport that are rendered too, so fast scrolling and J/K never show a gap:
 * about three screens each way. A flick of the wheel jumps a thousand pixels or more before the list
 * renders again, and 12 rows (about 430 px) showed it empty for a moment. The rows are memoized, so
 * keeping more of them costs little.
 */
const OVERSCAN = 60
/** A row's height before it is measured: one line on wide windows, stacked lines on phones (app.css). */
const estimateRowHeight = () => (window.matchMedia('(max-width: 719px)').matches ? 72 : 36)

/**
 * The list of calls for one view. Only the rows near the viewport are rendered (with thousands of
 * calls in Handled or Done, rendering them all blocks the page); spacers above and below keep the
 * scroll height, and the rows stay in normal flow so a row that leaves collapses smoothly.
 */
export function Inbox({
  list,
  segments,
  cursor,
  leaving,
  entering,
  menu,
  selected,
  bulk,
  groups,
  aside,
  firstCallHint,
  ...rest
}: Props) {
  const t = useT()
  const { tab, search, counts } = rest
  const { onOpen, onHover, onToggleDone, onToggleUnread, onRemind, onClearReminder, onCommands, onAssign, onSelect } =
    rest
  const handlers = useStableHandlers({
    onOpen,
    onHover,
    onToggleDone,
    onToggleUnread,
    onRemind,
    onClearReminder,
    onCommands,
    onAssign,
    onSelect,
  })
  const listRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  // Where the first row starts inside the scrolling list: below the sticky column headings, which also cover that much of the top.
  const [rowsTop, setRowsTop] = useState(0)
  // The headings come and go (none without calls; on phones only while calls are selected), so they are watched too.
  const [head, setHead] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const listEl = listRef.current
    const top = topRef.current
    if (!listEl || !top) return
    const measure = () =>
      setRowsTop(top.getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(listEl)
    if (head) observer.observe(head)
    return () => observer.disconnect()
  }, [head])
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => listRef.current,
    estimateSize: estimateRowHeight,
    getItemKey: i => list[i]!.id,
    overscan: OVERSCAN,
    scrollMargin: rowsTop,
    scrollPaddingStart: rowsTop,
  })
  const cursorIndex = cursor ? list.findIndex(c => c.id === cursor) : -1
  // J and K (and a call opened elsewhere) bring the cursor's row into view; it may not be rendered yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the cursor moves, not as the list changes under it
  useEffect(() => {
    if (cursorIndex >= 0) virtualizer.scrollToIndex(cursorIndex, { align: 'auto' })
  }, [cursor])
  const loadState = useLoadState('calls') // before the first sync an empty list is not "nothing needs you"
  // The skeleton rows stay until the gate lets them go (no flash, no blink); then the calls fade in.
  const listView = useLoading(loadState === 'loading')
  const waiting = loadState !== 'ready' || listView.phase !== 'content'
  const assistant = useAssistantName()
  const frame = listFrame({
    search,
    loadState,
    count: list.length,
    firstCallHint,
    selectable: Boolean(rest.onSelect),
  })
  // Nothing in the view, once the skeleton (if it showed) has gone.
  const empty = frame.empty && !waiting
  // Screen readers hear the call under the cursor as J and K move it (the rows themselves never take focus).
  const cursorCall = cursorIndex >= 0 ? list[cursorIndex] : undefined
  const cursorContact = useContact(cursorCall?.contact_id ?? null)
  const cursorLabel = cursorCall ? rowLabel(cursorCall, cursorContact, groups.get(cursorCall.id)) : ''
  const [spoken, setSpoken] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: said when the cursor moves, not again as the call under it changes
  useEffect(() => setSpoken(cursorLabel), [cursor])
  const items = virtualizer.getVirtualItems()
  // Item positions count from the top of the scrolling list (scrollMargin); the total size from the first row.
  // Before the list has a height (narrow windows size it by its content) nothing is in view: the spacer
  // alone gives it the rows' height, so the next measure finds the viewport.
  const total = virtualizer.getTotalSize()
  const before = items.length ? items[0]!.start - rowsTop : total
  const after = items.length ? Math.max(0, total - (items[items.length - 1]!.end - rowsTop)) : 0

  return (
    <div className="cv">
      <h1 className="sr-only">
        {search !== null
          ? t('inbox.search.label')
          : tab === 'member' && rest.memberName
            ? t('inbox.view.member', { name: rest.memberName })
            : t(viewHeading[tab])}
      </h1>
      <InboxHead {...rest} resultCount={list.length} menu={menu} bulk={bulk} />
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
      {frame.firstCallLine && (
        <div className="ib-firstcall" role="note">
          <Icon name="phone-in" size={14} />
          <span>{firstCallHint}</span>
        </div>
      )}
      <div className="ib-body">
        {aside}
        <div
          className={cx(
            'ib-list',
            empty && 'is-zero',
            listView.fadeIn && 'ld-rows-in',
            selected.size > 0 && 'is-selecting',
            (tab === 'done' || tab === 'spam') && search === null && 'is-quiet',
          )}
          ref={listRef}
          role="list"
        >
          {/* While the calls load, the headings stand over the skeleton rows (no jump when they arrive). */}
          {(frame.columnHeads || (waiting && rest.onSelect)) && (
            <ListHead tab={tab} searching={search !== null} total={list.length} bulk={bulk} ref={setHead} />
          )}
          <div ref={topRef} className="ib-spacer" style={{ height: before }} aria-hidden="true" />
          {!waiting &&
            items.map(item => {
              const c = list[item.index]!
              return (
                <Row
                  key={c.id}
                  {...handlers}
                  tab={tab}
                  search={search}
                  call={c}
                  segments={segments.get(c.id) ?? NO_SEGMENTS}
                  isCursor={cursor === c.id}
                  selected={selected.has(c.id)}
                  group={groups.get(c.id)}
                  motion={leaving === c.id ? 'leaving' : entering === c.id ? 'entering' : null}
                  index={item.index}
                  setSize={list.length}
                  measure={virtualizer.measureElement}
                />
              )
            })}
          <div className="ib-spacer" style={{ height: after }} aria-hidden="true" />
          {waiting ? (
            <Loading
              what={t('inbox.yourCalls')}
              loading
              error={loadState === 'slow'}
              skeleton={<SkeletonRows rows={8} columns={5} />}
            />
          ) : (
            empty && (
              <InboxEmpty
                tab={tab}
                search={search}
                assistant={assistant}
                handledCount={counts.ai}
                hasAnyCalls={Object.values(counts).some(n => n > 0)}
                quiet={frame.firstCallLine}
              />
            )
          )}
        </div>
      </div>
      <Hints tab={tab} hasRows={list.length > 0 && !waiting} />
    </div>
  )
}
