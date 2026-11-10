import type { Call } from '@callfront/db/types'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { auth, type Me } from './auth.ts'
import { callerName, countsFor, listFor, statusLabel, tabs, type InboxTab } from './inbox-model.ts'
import { localDbName, useRejection, useRows, useRun, useSnapshot } from './store.tsx'
import { dayLabel, parseTs, shortDuration, timeLabel } from './time.ts'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Inbox({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const calls = useRows('calls')
  const contacts = useSnapshot().tables.contacts
  const { pending, online } = useSnapshot()
  const run = useRun()
  const { rejection, clearRejection } = useRejection()
  const [tab, setTab] = useState<InboxTab>('you')
  const [cursor, setCursor] = useState<string | null>(null)

  const list = useMemo(() => listFor(calls, tab), [calls, tab])
  const counts = useMemo(() => countsFor(calls), [calls])
  const current = list.find(c => c.id === cursor) ?? list[0]

  const toggleDone = (c: Call) => run(c.inbox_state === 'done' ? 'call.markNotDone' : 'call.markDone', { callId: c.id })
  const toggleUnread = (c: Call) => run(c.unread ? 'call.markRead' : 'call.markUnread', { callId: c.id })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea')) return
      const index = current ? list.indexOf(current) : -1
      const move = (by: number) => setCursor(list[Math.min(list.length - 1, Math.max(0, index + by))]?.id ?? null)
      if (e.key === 'j' || e.key === 'ArrowDown') move(1)
      else if (e.key === 'k' || e.key === 'ArrowUp') move(-1)
      else if (e.key === 'e' && current) { move(1); void toggleDone(current) }
      else if (e.key === 'u' && current) void toggleUnread(current)
      else if (e.key === 'Tab') {
        const order = tabs.map(t => t[0])
        setTab(order[(order.indexOf(tab) + (e.shiftKey ? order.length - 1 : 1)) % order.length] ?? 'you')
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function signOut() {
    await auth.signOut()
    indexedDB.deleteDatabase(localDbName(me.workspace!.id)) // local rows belong to the signed-in member
    onSignedOut()
  }

  return (
    <div className="app-main">
      <div className="cv">
        <div className="ib-head">
          <div className="ib-tabs" role="tablist" aria-label="Split">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" className="ib-tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}{counts[id] ? <span className="n">{counts[id]}</span> : null}
              </button>
            ))}
            <button type="button" role="tab" className="ib-tab" aria-selected={tab === 'done'} onClick={() => setTab('done')}>Done</button>
          </div>
          <div className="ib-right">
            <span className={cx('sync-state', !online && 'is-offline')}>
              {!online ? `Offline · ${pending} waiting` : pending ? `Syncing ${pending}…` : me.workspace!.name}
            </span>
            <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={signOut}>Sign out</button>
          </div>
        </div>
        <div className="ib-list" role="list">
          {list.length ? list.map((c, i) => {
            const started = parseTs(c.started_at)
            const day = dayLabel(started)
            const newDay = i === 0 || dayLabel(parseTs(list[i - 1]!.started_at)) !== day
            const status = statusLabel(c)
            const live = c.status === 'live'
            return (
              <Fragment key={c.id}>
                {newDay && <div className="ib-day" role="presentation">{day}</div>}
                <div role="listitem" className={cx('row', current?.id === c.id && 'is-cursor', (c.unread || live) && 'unread')} onMouseMove={() => setCursor(c.id)}>
                  <span className={cx('r-dot', c.unread && 'is-unread')} role="button" title={c.unread ? 'Mark read (U)' : 'Mark unread (U)'} onClick={() => toggleUnread(c)}><i /></span>
                  <span className="r-name"><span>{callerName(c, c.contact_id ? contacts.get(c.contact_id) : undefined)}</span></span>
                  <span className="r-sum"><span className="r-topic">{c.title ?? (live ? 'Call in progress' : 'Call')}</span>{c.summary ? ` · ${c.summary}` : ''}</span>
                  <span className="r-status">
                    {status && (status.tone === 'plain' ? <span className="r-next">{status.text}</span> : <span className={`k-badge k-badge-${status.tone}`}>{status.text}</span>)}
                  </span>
                  <span className="r-dur">{live || c.duration_sec == null ? '—' : shortDuration(c.duration_sec)}</span>
                  <span className="r-time">{timeLabel(started)}</span>
                  <span className="r-acts">
                    <button type="button" className="r-act" title={c.inbox_state === 'done' ? 'Mark not done (⇧E)' : 'Mark done (E)'} onClick={() => toggleDone(c)}>✓</button>
                  </span>
                </div>
              </Fragment>
            )
          }) : (
            <div className="empty"><b>{tab === 'you' ? 'Nothing needs you' : 'Nothing here yet'}</b></div>
          )}
        </div>
      </div>
      {rejection && (
        <div className="toast" role="status">
          Could not {rejection.action}: {rejection.error}
          <button type="button" className="toast-undo" onClick={clearRejection}>Dismiss</button>
        </div>
      )}
    </div>
  )
}
