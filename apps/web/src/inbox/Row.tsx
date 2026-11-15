import type { Call, Contact, TranscriptSegment } from '@linedesk/db/types'
import { memo, type MouseEvent, type Ref } from 'react'
import { callerName, callTitle, statusLabel, tabOf, type InboxTab } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { clock, formatDate, listDuration, listTime, parseTs } from '../time.ts'

const fullTime = (date: Date) =>
  formatDate(date, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
import type { IconName } from '../ui/icons.ts'
import { Checkbox } from '../ui/controls.tsx'
import { memberAvatar, memberLabel, useMember } from '../team/members.ts'
import { Avatar, Badge, cx, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { highlight, searchHit } from './search.tsx'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

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
  /** In a list that renders only the rows near the viewport: where this row is, for screen readers and the list's measuring. */
  index?: number
  setSize?: number
  measure?: Ref<HTMLDivElement>
}

/** What a screen reader says for a row (and as J and K move the cursor onto it). */
export function rowLabel(call: Call, contact: Contact | undefined, group: Call[] | undefined): string {
  const unread = call.unread || !!group?.some(c => c.unread)
  const { t } = i18n()
  return [
    callerName(call, contact),
    callTitle(call),
    group && t('inbox.row.calls', { count: group.length }),
    call.spam_likely && t('inbox.row.spamLikely'),
    unread && t('inbox.row.unread'),
    call.inbox_state === 'done' && t('inbox.row.done'),
  ]
    .filter(Boolean)
    .join(', ')
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
      // The name without the key and without the line that explains the action (common.withKeyHint).
      aria-label={title.split('\n')[0]!.replace(/ \(.*\)$/, '')}
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
  const t = useT()
  const assistant = useAssistantName()
  if (call.status === 'live') return <LiveIndicator since={parseTs(call.started_at)} />
  if (markDone) return <span className="r-quiet">{t('inbox.action.done')}</span> // search lists every call, done ones included
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
  const t = useT()
  // A click selects (with shift: a range) and never reaches the row. The box is shown, not operated: the label's own toggle is cancelled.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the checkbox inside is the control; this only reads shift from its click
    <span
      className="r-check"
      title={t('common.withKey', { label: t('inbox.row.select'), key: 'X' })}
      onClick={e => {
        e.stopPropagation()
        e.preventDefault() // the label would toggle the box a second time
        onSelect(call, e.shiftKey)
      }}
    >
      <Checkbox checked={selected} label={selected ? t('inbox.row.selectedUnselect') : t('inbox.row.select')} onChange={() => {}} />
    </span>
  )
}

/** The member a call is assigned to: their picture or initials, the name in the tooltip. */
function AssigneeMark({ userId }: { userId: string }) {
  const t = useT()
  const assignee = useMember(userId)
  const name = memberLabel(assignee)
  return (
    <span className="r-assignee" title={t('inbox.row.assignedTo', { name })}>
      <Avatar name={name} size={20} src={memberAvatar(assignee)} />
    </span>
  )
}

/** Opens the member picker under itself. Always the assign icon; the assignee's initials sit next to the caller's name. */
function AssignAction({ call, onAssign }: { call: Call; onAssign: (call: Call, anchor: DOMRect) => void }) {
  const t = useT()
  const assignee = useMember(call.assignee_id)
  const name = memberLabel(assignee)
  const title = t('common.withKey', {
    label: call.assignee_id ? t('inbox.row.reassignTitle', { name }) : t('inbox.assign.label'),
    key: 'A',
  })
  return (
    <button
      type="button"
      className="r-act r-act-assign"
      title={title}
      aria-label={call.assignee_id ? t('inbox.row.reassignLabel', { name }) : t('inbox.assign.label')}
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

/**
 * One call in the list. Memoized: it renders again only when its own props change, so the handlers
 * it gets must keep their identity (Inbox passes stable ones).
 */
export const Row = memo(function Row({
  call,
  tab,
  search,
  segments,
  isCursor,
  motion,
  selected = false,
  group,
  index,
  setSize,
  measure,
  ...on
}: Props) {
  const t = useT()
  const contact = useContact(call.contact_id)
  const unread = call.unread || !!group?.some(c => c.unread)
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = tabOf(call) === 'reminders'
  return (
    <div
      ref={measure}
      data-index={index}
      role="listitem"
      aria-posinset={index === undefined ? undefined : index + 1}
      aria-setsize={setSize}
      aria-label={rowLabel(call, contact, group)}
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
        title={t('common.withKey', { label: unread ? t('inbox.row.markRead') : t('inbox.row.markUnread'), key: 'U' })}
        aria-label={unread ? t('inbox.row.unreadMarkRead') : t('inbox.row.readMarkUnread')}
        onClick={stop(() => on.onToggleUnread?.(call))}
      >
        <i />
        {on.onSelect && <SelectBox call={call} selected={selected} onSelect={on.onSelect} />}
      </span>
      <span className="r-time" title={fullTime(parseTs(call.started_at))}>
        {listTime(parseTs(call.started_at))}
      </span>
      <span className="r-name">
        <span>{highlight(callerName(call, contact), search)}</span>
        {group && (
          <span className="r-count" title={t('inbox.row.callsFromNumber', { count: group.length })}>
            {group.length}
          </span>
        )}
        {call.assignee_id && on.onAssign && <AssigneeMark userId={call.assignee_id} />}
        {call.source === 'sample' && <span className="r-sample">{t('inbox.row.sample')}</span>}
        {call.spam_likely && (
          <span className="r-sample" title={t('inbox.row.spamLikelyTitle')}>
            {t('inbox.row.spamLikely')}
          </span>
        )}
      </span>
      <Summary call={call} search={search} segments={segments} />
      <span className="r-status">
        <Status call={call} tab={tab} markDone={done && search !== null} segments={segments} />
      </span>
      <span className="r-dur">{live || !call.duration_sec ? '—' : listDuration(call.duration_sec)}</span>
      <span className="r-acts">
        {on.onToggleDone && (
          <RowAction
            title={
              done
                ? t('common.withKeyHint', {
                    label: t('shell.command.markNotDone'),
                    key: '⇧E',
                    hint: t('inbox.action.notDoneHint'),
                  })
                : t('common.withKey', { label: t('shell.command.markDone'), key: 'E' })
            }
            icon={done ? 'restart' : 'check'}
            onClick={() => on.onToggleDone!(call)}
          />
        )}
        {on.onAssign && <AssignAction call={call} onAssign={on.onAssign} />}
        {reminded
          ? on.onClearReminder && (
              <RowAction
                title={t('common.withKey', { label: t('inbox.goLive.clearReminder'), key: '⇧H' })}
                icon="restart" onClick={() => on.onClearReminder!(call)} />
            )
          : on.onRemind && <RowAction
                title={t('common.withKey', { label: t('shell.command.remindMe'), key: 'H' })}
                icon="clock" onClick={() => on.onRemind!(call)} />}
        {on.onCommands && <RowAction
              title={t('common.withKey', { label: t('inbox.action.allCommands'), key: '⌘ K' })}
              icon="more" onClick={() => on.onCommands!(call)} />}
      </span>
    </div>
  )
})
