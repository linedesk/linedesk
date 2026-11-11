// What people did with the call (call_events): who assigned it to whom, and when. Newest last.
import type { CallEvent } from '@linedesk/db/types'
import { useMemo } from 'react'
import { useRows } from '../store.tsx'
import { memberLabel, useMembers } from '../team/members.ts'
import { dateTimeLabel, parseTs } from '../time.ts'

/** `me`: the signed-in member, who reads as "You". */
export function CallActivity({ callId, me }: { callId: string; me: string }) {
  const rows = useRows('call_events')
  const members = useMembers()
  const events = useMemo(
    () => rows.filter(e => e.call_id === callId).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [rows, callId],
  )
  if (!events.length) return null
  const name = (userId: string | null, fallback: string) =>
    !userId ? fallback : userId === me ? 'You' : memberLabel(members.find(m => m.user_id === userId))
  const sentence = (e: CallEvent) => {
    const who = name(e.actor_id, 'An integration')
    if (!e.assignee_id) return `${who} unassigned this call`
    if (e.assignee_id === e.actor_id) return `${who} took this call`
    const to = name(e.assignee_id, '')
    return `${who} assigned this call to ${to === 'You' ? 'you' : to}`
  }
  return (
    <section className="cv-activity" aria-label="Activity">
      <b>Activity</b>
      <ul>
        {events.map(e => (
          <li key={e.id}>
            <span>{sentence(e)}</span>
            <time dateTime={e.created_at}>{dateTimeLabel(parseTs(e.created_at))}</time>
          </li>
        ))}
      </ul>
    </section>
  )
}
