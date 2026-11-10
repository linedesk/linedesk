import type { Call, TranscriptSegment } from '@callfront/db/types'
import type { MouseEvent } from 'react'
import { callerName, callTitle, statusLabel, tabOf, type InboxTab } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { clock, parseTs, shortDuration, timeLabel } from '../time.ts'
import type { IconName } from '../ui/icons.ts'
import { Badge, cx, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { highlight, searchHit } from './search.tsx'

export type RowHandlers = {
  onOpen?: (call: Call) => void
  onHover: (call: Call) => void
  onToggleDone: (call: Call) => void
  onToggleUnread: (call: Call) => void
  onRemind: (call: Call) => void
  onClearReminder: (call: Call) => void
  onCommands?: (call: Call) => void
}

type Props = RowHandlers & {
  call: Call
  tab: InboxTab
  search: string | null
  segments: TranscriptSegment[]
  isCursor: boolean
  motion: 'leaving' | 'entering' | null
}

const stop = (run: () => void) => (e: MouseEvent) => { e.stopPropagation(); run() }

function RowAction({ title, icon, onClick }: { title: string; icon: IconName; onClick: () => void }) {
  return <button type="button" className="r-act" title={title} aria-label={title.replace(/ \(.*\)$/, '')} onClick={stop(onClick)}><Icon name={icon} size={14} /></button>
}

function Status({ call, tab }: { call: Call; tab: InboxTab }) {
  const assistant = useAssistantName()
  if (call.status === 'live') return <LiveIndicator since={parseTs(call.started_at)} />
  const { text, tone } = statusLabel(call, tab, assistant)
  if (tone === 'next' || tone === 'quiet') return <span className={`r-${tone}`}>{text}</span>
  return <Badge tone={tone}>{text}</Badge>
}

function Summary({ call, search, segments }: Pick<Props, 'call' | 'search' | 'segments'>) {
  const assistantName = useAssistantName()
  const contact = useContact(call.contact_id)
  const hit = search ? searchHit({ call, contact, segments, assistantName }, search) : null
  if (hit?.atMs != null) {
    return <span className="r-sum is-hit"><span className="r-topic">{hit.field} · {clock(hit.atMs / 1000)}</span> · {highlight(hit.text, search, 110)}</span>
  }
  return (
    <span className="r-sum">
      <span className="r-topic">{highlight(callTitle(call), search)}</span>
      {call.summary ? <> · {highlight(call.summary, search, search ? 160 : undefined)}</> : null}
    </span>
  )
}

export function Row({ call, tab, search, segments, isCursor, motion, ...on }: Props) {
  const contact = useContact(call.contact_id)
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = tabOf(call) === 'reminders'
  return (
    <div role="listitem" className={cx('row', motion && `is-${motion}`, isCursor && 'is-cursor', (call.unread || live) && 'unread')}
      onClick={() => on.onOpen?.(call)} onMouseMove={() => { if (!isCursor) on.onHover(call) }}>
      <span className={cx('r-dot', call.unread && 'is-unread')} role="button" title={`${call.unread ? 'Mark read' : 'Mark unread'} (U)`}
        aria-label={call.unread ? 'Unread, mark read' : 'Read, mark unread'} onClick={stop(() => on.onToggleUnread(call))}><i /></span>
      <span className="r-name"><span>{highlight(callerName(call, contact), search)}</span></span>
      <Summary call={call} search={search} segments={segments} />
      <span className="r-status"><Status call={call} tab={tab} /></span>
      <span className="r-dur">{live || !call.duration_sec ? '—' : shortDuration(call.duration_sec)}</span>
      <span className="r-time">{timeLabel(parseTs(call.started_at))}</span>
      <span className="r-acts">
        <RowAction title={done ? 'Mark not done (⇧E)' : 'Mark done (E)'} icon={done ? 'restart' : 'check'} onClick={() => on.onToggleDone(call)} />
        {reminded
          ? <RowAction title="Clear reminder (⇧H)" icon="restart" onClick={() => on.onClearReminder(call)} />
          : <RowAction title="Remind me (H)" icon="clock" onClick={() => on.onRemind(call)} />}
        {on.onCommands && <RowAction title="All commands (⌘ K)" icon="more" onClick={() => on.onCommands!(call)} />}
      </span>
    </div>
  )
}
