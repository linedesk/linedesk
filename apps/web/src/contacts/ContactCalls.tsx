// A contact's calls inside their record: a compact list in the card, in the inbox's language (unread dot,
// topic, status, when, length) on two lines, as the card is narrow: topic and when, then status, summary
// and length. No day headers: a contact's calls span
// weeks, so each row carries its own date. Click, Enter or Space opens the call; U and E (or the dot and
// the hover button) mark it read/unread and done, with undo. Long lists show the latest few first.
import type { Call } from '@linedesk/db/types'
import { type KeyboardEvent, useState } from 'react'
import { callTitle, tabOf } from '../inbox-model.ts'
import { type Change, doneChange, notDoneChange, unreadChange } from '../inbox/changes.ts'
import { RowAction, Status } from '../inbox/Row.tsx'
import { parseTs, shortDuration, timeLabel } from '../time.ts'
import { cx } from '../ui/kit.tsx'
import { useT } from '@linedesk/i18n/react'

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 5

type Props = {
  calls: Call[]
  onOpen: (call: Call) => void
  onChange: (change: Change) => void
}

export function ContactCalls({ calls, onOpen, onChange }: Props) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  if (!calls.length) return <p className="ct-calls-empty">{t('contacts.calls.empty')}</p>
  const collapsible = calls.length > COLLAPSED_ROWS + 1 // never hide a single row behind a button
  const shown = collapsible && !expanded ? calls.slice(0, COLLAPSED_ROWS) : calls
  return (
    <div className="ct-calls">
      <div role="list" aria-label={t('contacts.column.calls')}>
        {shown.map(call => (
          <CallItem key={call.id} call={call} onOpen={onOpen} onChange={onChange} />
        ))}
      </div>
      {collapsible && (
        <button type="button" className="ct-calls-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('contacts.calls.showFewer') : t('contacts.calls.showAll', { count: calls.length })}
        </button>
      )}
    </div>
  )
}

function CallItem({ call, onOpen, onChange }: { call: Call; onOpen: Props['onOpen']; onChange: Props['onChange'] }) {
  const t = useT()
  const done = call.inbox_state === 'done'
  const live = call.status === 'live'
  const title = callTitle(call)
  const toggleUnread = () => onChange(unreadChange(call))
  const toggleDone = () => onChange(done ? notDoneChange(call) : doneChange(call))
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    const run = rowKeys(e, { open: () => onOpen(call), toggleUnread, toggleDone })
    if (!run) return
    e.preventDefault()
    e.stopPropagation() // the page's own keys (j/k, Enter on the contact list) stay out of it
    run()
  }
  return (
    <div
      role="listitem"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the row is the list's item and opens the call (Enter, Space, click), as in the inbox
      tabIndex={0}
      aria-label={[title, call.unread && t('inbox.row.unread'), done && t('inbox.row.done')].filter(Boolean).join(', ')}
      className={cx('ct-call', call.unread && 'is-unread', done && 'is-done')}
      onClick={() => onOpen(call)}
      onKeyDown={onKeyDown}
    >
      <span
        className="ct-call-dot"
        role="button"
        tabIndex={-1}
        title={t('common.withKey', { label: call.unread ? t('inbox.row.markRead') : t('inbox.row.markUnread'), key: 'U' })}
        aria-label={call.unread ? t('inbox.row.unreadMarkRead') : t('inbox.row.readMarkUnread')}
        onClick={e => {
          e.stopPropagation()
          toggleUnread()
        }}
      />
      <span className="ct-call-title" title={title}>
        {title}
      </span>
      <span className="ct-call-when">{timeLabel(parseTs(call.started_at))}</span>
      <span className="ct-call-line">
        <span className="ct-call-status">
          <Status call={call} tab={tabOf(call)} markDone={done} segments={[]} />
        </span>
        {call.summary && <span className="ct-call-sum">{call.summary}</span>}
      </span>
      <span className="ct-call-dur">{live || !call.duration_sec ? '' : shortDuration(call.duration_sec)}</span>
      <span className="ct-call-acts">
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
          onClick={toggleDone}
        />
      </span>
    </div>
  )
}

type RowKeyHandlers = { open: () => void; toggleUnread: () => void; toggleDone: () => void }

/** What a key does on a focused row; arrows move between rows. Null: not ours. */
function rowKeys(e: KeyboardEvent<HTMLDivElement>, on: RowKeyHandlers): (() => void) | null {
  const row = e.currentTarget
  const focus = (el: Element | null) => () => (el as HTMLElement | null)?.focus()
  switch (e.key) {
    case 'Enter':
    case ' ':
      return on.open
    case 'u':
    case 'U':
      return on.toggleUnread
    case 'e':
    case 'E':
      return on.toggleDone
    case 'ArrowDown':
      return focus(row.nextElementSibling)
    case 'ArrowUp':
      return focus(row.previousElementSibling)
    default:
      return null
  }
}
