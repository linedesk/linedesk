import type { Call } from '@linedesk/db/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SegmentsByCall } from '../call/segments.ts'
import type { CallGroups, InboxTab } from '../inbox-model.ts'
import { Checkbox } from '../ui/controls.tsx'
import { cx, Icon, Kbd } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import type { BulkActions } from './BulkBar.tsx'
import { InboxHead, type InboxHeadProps } from './InboxHead.tsx'
import { InboxZero } from './InboxZero.tsx'
import { Row, type RowHandlers } from './Row.tsx'

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

const viewHeading: Record<InboxTab, string> = {
  you: 'Needs you',
  ai: 'Handled calls',
  spam: 'Spam',
  reminders: 'Reminders',
  done: 'Done',
  mine: 'Assigned to me',
  member: 'Assigned to a teammate',
  unassigned: 'Unassigned',
  review: 'Needs review',
}
const emptyTitle: Record<InboxTab, string> = {
  you: 'Nothing needs you',
  ai: 'Nothing here yet',
  spam: 'No spam',
  done: 'Nothing done yet',
  reminders: 'No reminders',
  mine: 'Nothing assigned to you',
  member: 'Nothing assigned to them',
  unassigned: 'Every call that needs someone has someone',
  review: 'Nothing to review',
}
function Empty({ tab, search }: { tab: InboxTab; search: string | null }) {
  return (
    <div className="empty">
      <Icon name={tab === 'done' ? 'check' : tab === 'reminders' ? 'clock' : 'tasks'} size={22} />
      <b>{search ? `No call mentions “${search}”` : emptyTitle[tab]}</b>
    </div>
  )
}

/** What the status column shows in each view; search lists calls of every view, so there it is the status. */
const statusHeading: Partial<Record<InboxTab, string>> = { you: 'Next step', reminders: 'Reminder' }

/**
 * Above the calls: a box that selects every call in the view (a dash while only some are), and a
 * heading per column. Sticks to the top while the list scrolls.
 */
function ListHead({
  tab,
  searching,
  total,
  bulk,
}: {
  tab: InboxTab
  searching: boolean
  total: number
  bulk: BulkActions
}) {
  const all = bulk.count > 0 && bulk.count >= total
  const some = bulk.count > 0 && !all
  return (
    <div className="ib-cols" role="presentation">
      {/* Like a row's box: the click is handled here, so the box only shows the selection. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the checkbox inside is the control; its click (and Space) arrive here */}
      <span
        className="ib-cols-check"
        title={all ? 'Unselect all (Esc)' : 'Select all (⌘ A)'}
        onClick={e => {
          e.stopPropagation()
          // A click on the label would click the input a second time; one on the input itself (Space) toggles it the way the selection goes.
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
          if (all) bulk.onClear()
          else bulk.onSelectAll()
        }}
      >
        <Checkbox
          checked={all}
          indeterminate={some}
          label={all ? 'Unselect all calls' : 'Select all calls'}
          onChange={() => {}}
        >
          <span className="ib-cols-all">{all ? 'All selected' : 'Select all'}</span>
        </Checkbox>
      </span>
      <span aria-hidden="true">Time</span>
      <span aria-hidden="true">Caller</span>
      <span aria-hidden="true">Call</span>
      <span aria-hidden="true">{(!searching && statusHeading[tab]) || 'Status'}</span>
      <span aria-hidden="true">Duration</span>
    </div>
  )
}

function Hints({ tab }: { tab: InboxTab }) {
  const done: [string[], string] = tab === 'done' ? [['⇧', 'E'], 'not done'] : [['E'], 'done']
  const hints: [string[], string][] = [
    [['⏎'], 'open'],
    done,
    [['tab'], 'switch'],
    [['⌘', 'K'], 'commands'],
    [['?'], 'all shortcuts'],
  ]
  return (
    <div className="ib-hint">
      <span>
        <Kbd keys={['J']} />
        <Kbd keys={['K']} />
        move
      </span>
      {hints.map(([keys, label]) => (
        <span key={label}>
          <Kbd keys={keys} />
          {label}
        </span>
      ))}
    </div>
  )
}

/** The list of calls for one view, grouped by day. */
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
  const { tab, search, counts } = rest
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cursor) listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  const loadState = useLoadState('calls') // before the first sync an empty list is not "nothing needs you"
  const zero = !list.length && tab === 'you' && search === null && loadState === 'ready'
  // Screen readers hear the call under the cursor as J and K move it (the rows themselves never take focus).
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    setSpoken(cursor ? (listRef.current?.querySelector('.is-cursor')?.getAttribute('aria-label') ?? '') : '')
  }, [cursor])

  return (
    <div className="cv">
      <h1 className="sr-only">
        {search !== null
          ? 'Search calls'
          : tab === 'member' && rest.memberName
            ? `Assigned to ${rest.memberName}`
            : viewHeading[tab]}
      </h1>
      <InboxHead {...rest} resultCount={list.length} menu={menu} bulk={bulk} />
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
      {firstCallHint && tab === 'you' && search === null && loadState === 'ready' && (
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
            zero && 'is-zero',
            selected.size > 0 && 'is-selecting',
            (tab === 'done' || tab === 'spam') && search === null && 'is-quiet',
          )}
          ref={listRef}
          role="list"
        >
          {list.length > 0 && rest.onSelect && (
            <ListHead tab={tab} searching={search !== null} total={list.length} bulk={bulk} />
          )}
          {list.map(c => (
            <Row
              key={c.id}
              {...rest}
              call={c}
              segments={segments.get(c.id) ?? []}
              isCursor={cursor === c.id}
              selected={selected.has(c.id)}
              group={groups.get(c.id)}
              motion={leaving === c.id ? 'leaving' : entering === c.id ? 'entering' : null}
            />
          ))}
          {loadState === 'loading' ? (
            <SkeletonRows label="Loading calls" />
          ) : loadState === 'slow' ? (
            <LoadProblem what="Your calls" />
          ) : zero ? (
            <InboxZero
              handledCount={counts.ai}
              hasAnyCalls={Object.values(counts).some(n => n > 0)}
              quiet={!!firstCallHint}
            />
          ) : (
            !list.length && <Empty tab={tab} search={search} />
          )}
        </div>
      </div>
      {list.length ? <Hints tab={tab} /> : null}
    </div>
  )
}
