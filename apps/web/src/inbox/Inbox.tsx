import type { Call } from '@callfront/db/types'
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import type { SegmentsByCall } from '../call/segments.ts'
import type { CallGroups, InboxTab } from '../inbox-model.ts'
import { dayLabel, parseTs } from '../time.ts'
import { cx, Icon, Kbd } from '../ui/kit.tsx'
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
}
const emptyTitle: Record<InboxTab, string> = {
  you: 'Nothing needs you',
  ai: 'Nothing here yet',
  spam: 'No spam',
  done: 'Nothing done yet',
  reminders: 'No reminders',
}
const emptyHelp: Record<InboxTab, string> = {
  you: 'Calls that need a person land here.',
  ai: 'Calls the assistant resolved on its own land here.',
  spam: 'Sales calls and robocalls the assistant blocked land here.',
  done: 'Calls you mark done with E land here.',
  reminders: 'Calls you set a reminder for with H wait here until they come back.',
}

function Empty({ tab, search }: { tab: InboxTab; search: string | null }) {
  return (
    <div className="empty">
      <Icon name={tab === 'done' ? 'check' : tab === 'reminders' ? 'clock' : 'tasks'} size={22} />
      <b>{search ? `No call mentions “${search}”` : emptyTitle[tab]}</b>
      <span>{search ? 'Try a name, a number or a word from the conversation.' : emptyHelp[tab]}</span>
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
  const { tab, search, counts } = rest
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cursor) listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  const day = (c: Call) => dayLabel(parseTs(c.started_at))
  const zero = !list.length && tab === 'you' && search === null
  const groupByDay = tab !== 'reminders' || search !== null // reminders are ordered by when they come back, not by call day

  return (
    <div className="cv">
      <h1 className="sr-only">{search !== null ? 'Search calls' : viewHeading[tab]}</h1>
      <InboxHead {...rest} resultCount={list.length} menu={menu} bulk={bulk} />
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
        {zero ? (
          <InboxZero handledCount={counts.ai} hasAnyCalls={Object.values(counts).some(n => n > 0)} />
        ) : (
          !list.length && <Empty tab={tab} search={search} />
        )}
      </div>
      {list.length ? <Hints tab={tab} /> : null}
    </div>
  )
}
