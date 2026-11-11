import { tagLabels } from '@linedesk/actions'
import type { Call, CallTag } from '@linedesk/db/types'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SegmentsByCall } from '../call/segments.ts'
import type { CallGroups, InboxTab } from '../inbox-model.ts'
import { dayLabel, parseTs } from '../time.ts'
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
function Empty({ tab, search, tag }: { tab: InboxTab; search: string | null; tag: CallTag | null }) {
  return (
    <div className="empty">
      <Icon name={tab === 'done' ? 'check' : tab === 'reminders' ? 'clock' : 'tasks'} size={22} />
      <b>{search ? `No call mentions “${search}”` : tag ? `No calls tagged ${tagLabels[tag]} here` : emptyTitle[tab]}</b>
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
export function Inbox({ list, segments, cursor, leaving, entering, menu, selected, bulk, groups, ...rest }: Props) {
  const { tab, search, tag, counts } = rest
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cursor) listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  const day = (c: Call) => dayLabel(parseTs(c.started_at))
  const loadState = useLoadState('calls') // before the first sync an empty list is not "nothing needs you"
  const zero = !list.length && tab === 'you' && search === null && !tag && loadState === 'ready'
  // Screen readers hear the call under the cursor as J and K move it (the rows themselves never take focus).
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    setSpoken(cursor ? (listRef.current?.querySelector('.is-cursor')?.getAttribute('aria-label') ?? '') : '')
  }, [cursor])
  const groupByDay = tab !== 'reminders' || search !== null // reminders are ordered by when they come back, not by call day

  return (
    <div className="cv">
      <h1 className="sr-only">
        {search !== null ? 'Search calls' : tab === 'member' && rest.memberName ? `Assigned to ${rest.memberName}` : viewHeading[tab]}
      </h1>
      <InboxHead {...rest} resultCount={list.length} menu={menu} bulk={bulk} />
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
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
        {list.map((c, i) => (
          <Fragment key={c.id}>
            {groupByDay && (i === 0 || day(list[i - 1]!) !== day(c)) && (
              <div className="ib-day" role="presentation">
                {day(c)}
              </div>
            )}
            <Row
              {...rest}
              call={c}
              segments={segments.get(c.id) ?? []}
              isCursor={cursor === c.id}
              selected={selected.has(c.id)}
              group={groups.get(c.id)}
              motion={leaving === c.id ? 'leaving' : entering === c.id ? 'entering' : null}
            />
          </Fragment>
        ))}
        {loadState === 'loading' ? (
          <SkeletonRows label="Loading calls" />
        ) : loadState === 'slow' ? (
          <LoadProblem what="Your calls" />
        ) : zero ? (
          <InboxZero handledCount={counts.ai} hasAnyCalls={Object.values(counts).some(n => n > 0)} />
        ) : (
          !list.length && <Empty tab={tab} search={search} tag={tag} />
        )}
      </div>
      {list.length ? <Hints tab={tab} /> : null}
    </div>
  )
}
