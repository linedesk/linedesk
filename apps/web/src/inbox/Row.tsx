import { tagLabels } from '@linedesk/actions'
import type { Call, TranscriptSegment } from '@linedesk/db/types'
import type { MouseEvent } from 'react'
import { callerName, callTitle, statusLabel, tabOf, type InboxTab } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { clock, parseTs, shortDuration, timeLabel, timeUnderDay } from '../time.ts'
import type { IconName } from '../ui/icons.ts'
import { Checkbox } from '../ui/controls.tsx'
import { memberLabel, useMember } from '../team/members.ts'
import { Avatar, Badge, cx, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { highlight, searchHit } from './search.tsx'

/** The inbox passes them all; a call list elsewhere (a contact's calls) only those it offers. */
export type RowHandlers = {
  onOpen?: (call: Call) => void
  onHover?: (call: Call) => void
  onToggleDone?: (call: Call) => void
  onToggleUnread?: (call: Call) => void
  onRemind?: (call: Call) => void
  onClearReminder?: (call: Call) => void
  onCommands?: (call: Call) => void
  /** The member picker, under the row's assign button; unset while the workspace has a single member (no assign UI). */
  onAssign?: (call: Call, anchor: DOMRect) => void
  /** Tick or untick a call; with shift, everything from the last ticked call to this one. */
  onSelect?: (call: Call, range: boolean) => void
}

type Props = RowHandlers & {
  call: Call
  tab: InboxTab
  search: string | null
  segments: TranscriptSegment[]
  isCursor: boolean
  motion: 'leaving' | 'entering' | null
  selected?: boolean
  /** Repeat calls this row stands for (see groupRepeats), the row's own call first. */
  group?: Call[]
}

const stop = (run: () => void) => (e: MouseEvent) => {
  e.stopPropagation()
  run()
}

export function RowAction({ title, icon, onClick }: { title: string; icon: IconName; onClick: () => void }) {
  return (
    <button
      type="button"
      className="r-act"
      title={title}
      aria-label={title.replace(/ \(.*\)$/, '')}
      onClick={stop(onClick)}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

export function Status({
  call,
  tab,
  markDone,
  segments,
}: {
  call: Call
  tab: InboxTab
  markDone: boolean
  segments: TranscriptSegment[]
}) {
  const assistant = useAssistantName()
  if (call.status === 'live') return <LiveIndicator since={parseTs(call.started_at)} />
  if (markDone) return <span className="r-quiet">Done</span> // search lists every call, done ones included
  const { text, tone } = statusLabel(call, tab, assistant, undefined, segments)
  if (tone === 'next' || tone === 'quiet')
    return (
      <span className={`r-${tone}`} title={tone === 'next' ? text : undefined}>
        {text}
      </span>
    )
  return <Badge tone={tone}>{text}</Badge>
}

function Summary({ call, search, segments }: Pick<Props, 'call' | 'search' | 'segments'>) {
  const assistantName = useAssistantName()
  const contact = useContact(call.contact_id)
  const hit = search ? searchHit({ call, contact, segments, assistantName }, search) : null
  if (hit?.atMs != null) {
    return (
      <span className="r-sum is-hit">
        <span className="r-topic">
          {hit.field} · {clock(hit.atMs / 1000)}
        </span>{' '}
        · {highlight(hit.text, search, 110)}
      </span>
    )
  }
  return (
    <span className="r-sum">
      {call.tag && <span className="r-tag">{tagLabels[call.tag]}</span>}
      <span className="r-topic">{highlight(callTitle(call), search)}</span>
      {
        search && call.summary ? (
          <> · {highlight(call.summary, search, 160)}</>
        ) : null /* the topic alone; while searching, the summary shows where it matched */
      }
    </span>
  )
}

function SelectBox({
  call,
  selected,
  onSelect,
}: {
  call: Call
  selected: boolean
  onSelect: (call: Call, range: boolean) => void
}) {
  // A click selects (with shift: a range) and never reaches the row. The box is shown, not operated: the label's own toggle is cancelled.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the checkbox inside is the control; this only reads shift from its click
    <span
      className="r-check"
      title="Select (X)"
      onClick={e => {
        e.stopPropagation()
        e.preventDefault() // the label would toggle the box a second time
        onSelect(call, e.shiftKey)
      }}
    >
      <Checkbox checked={selected} label={selected ? 'Selected, unselect' : 'Select'} onChange={() => {}} />
    </span>
  )
}

/** The member a call is assigned to: their initials, the name in the tooltip. */
function AssigneeMark({ userId }: { userId: string }) {
  const name = memberLabel(useMember(userId))
  return (
    <span className="r-assignee" title={`Assigned to ${name}`}>
      <Avatar name={name} size={20} />
    </span>
  )
}

/** Opens the member picker under itself. Always the assign icon; the assignee's initials sit next to the caller's name. */
function AssignAction({ call, onAssign }: { call: Call; onAssign: (call: Call, anchor: DOMRect) => void }) {
  const assignee = useMember(call.assignee_id)
  const title = call.assignee_id ? `Assigned to ${memberLabel(assignee)}: reassign (A)` : 'Assign (A)'
  return (
    <button
      type="button"
      className="r-act r-act-assign"
      title={title}
      aria-label={call.assignee_id ? `Assigned to ${memberLabel(assignee)}, reassign` : 'Assign'}
      aria-haspopup="dialog"
      onClick={e => {
        e.stopPropagation()
        onAssign(call, e.currentTarget.getBoundingClientRect())
      }}
    >
      <Icon name="user" size={14} />
    </button>
  )
}

export function Row({ call, tab, search, segments, isCursor, motion, selected = false, group, ...on }: Props) {
  const contact = useContact(call.contact_id)
  const unread = call.unread || !!group?.some(c => c.unread)
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = tabOf(call) === 'reminders'
  return (
    <div
      role="listitem"
      aria-label={[
        callerName(call, contact),
        callTitle(call),
        group && `${group.length} calls`,
        unread && 'unread',
        done && 'done',
      ]
        .filter(Boolean)
        .join(', ')}
      className={cx(
        'row',
        motion && `is-${motion}`,
        isCursor && 'is-cursor',
        selected && 'is-selected',
        (unread || live) && 'unread',
        done && search !== null && 'is-done',
      )}
      onClick={() => on.onOpen?.(call)}
      onMouseMove={() => {
        if (!isCursor) on.onHover?.(call)
      }}
    >
      <span
        className={cx('r-dot', unread && 'is-unread')}
        role="button"
        tabIndex={-1}
        title={`${unread ? 'Mark read' : 'Mark unread'} (U)`}
        aria-label={unread ? 'Unread, mark read' : 'Read, mark unread'}
        onClick={stop(() => on.onToggleUnread?.(call))}
      >
        <i />
        {on.onSelect && <SelectBox call={call} selected={selected} onSelect={on.onSelect} />}
      </span>
      <span className="r-name">
        <span>{highlight(callerName(call, contact), search)}</span>
        {group && (
          <span className="r-count" title={`${group.length} calls from this number`}>
            {group.length}
          </span>
        )}
        {call.assignee_id && on.onAssign && <AssigneeMark userId={call.assignee_id} />}
        {call.source === 'sample' && <span className="r-sample">Sample</span>}
      </span>
      <Summary call={call} search={search} segments={segments} />
      <span className="r-status">
        <Status call={call} tab={tab} markDone={done && search !== null} segments={segments} />
      </span>
      <span className="r-dur">{live || !call.duration_sec ? '—' : shortDuration(call.duration_sec)}</span>
      <span className="r-time">
        {(tab === 'reminders' && search === null ? timeLabel : timeUnderDay)(parseTs(call.started_at))}
      </span>
      <span className="r-acts">
        {on.onToggleDone && (
          <RowAction
            title={done ? 'Mark not done (⇧E)' : 'Mark done (E)'}
            icon={done ? 'restart' : 'check'}
            onClick={() => on.onToggleDone!(call)}
          />
        )}
        {on.onAssign && <AssignAction call={call} onAssign={on.onAssign} />}
        {reminded
          ? on.onClearReminder && (
              <RowAction title="Clear reminder (⇧H)" icon="restart" onClick={() => on.onClearReminder!(call)} />
            )
          : on.onRemind && <RowAction title="Remind me (H)" icon="clock" onClick={() => on.onRemind!(call)} />}
        {on.onCommands && <RowAction title="All commands (⌘ K)" icon="more" onClick={() => on.onCommands!(call)} />}
      </span>
    </div>
  )
}
