import type { Call, TranscriptSegment } from '@callfront/db/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { callTitle, formatPhone, hasReminder } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { dateTimeLabel, longDuration, parseTs } from '../time.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { LiveCard } from './LiveCard.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { Transcript } from './Transcript.tsx'

export type CallViewActions = {
  onBack: () => void
  onStep: (by: number) => void
  onDone: (call: Call) => void
  onNotDone: (call: Call) => void
  onRemind: (call: Call) => void
  onClearReminder: (call: Call) => void
}

type Props = CallViewActions & {
  call: Call
  segments: TranscriptSegment[]
  index: number
  count: number
  search: string | null
  menu?: ReactNode
  side: ReactNode
}

const STICK_TO_BOTTOM_PX = 140

function answeredBy(call: Call, assistant: string): string {
  if (call.outcome === 'hangup') return 'Missed'
  if (call.outcome === 'spam') return `Blocked by ${assistant}`
  if (call.direction === 'out') return `Outbound call by ${assistant}`
  return call.answered_by === 'human' ? 'Answered by the team' : `Answered by ${assistant}`
}

function Bar({ call, index, count, menu, ...on }: Omit<Props, 'segments' | 'search' | 'side'>) {
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = hasReminder(call) && !done
  return (
    <div className="cv-bar">
      {menu}
      <Button size="sm" variant="ghost" icon="left" title="Back to calls (esc)" aria-label="Back to calls" onClick={on.onBack} />
      <Button size="sm" variant="ghost" icon="up" title="Previous call (K)" aria-label="Previous call" disabled={index <= 0} onClick={() => on.onStep(-1)} />
      <Button size="sm" variant="ghost" icon="down" title="Next call (J)" aria-label="Next call" disabled={index >= count - 1} onClick={() => on.onStep(1)} />
      {index > -1 && <span className="cv-pos">{index + 1} of {count}</span>}
      {!live && (
        <div className="cv-acts">
          {reminded && <Button size="sm" variant="ghost" shortcut={['⇧', 'H']} title="Clear reminder (⇧H)" onClick={() => on.onClearReminder(call)}>Clear reminder</Button>}
          {!done && !reminded && <Button size="sm" variant="ghost" icon="clock" className="cv-act" aria-label="Remind me" title="Remind me (H)" onClick={() => on.onRemind(call)} />}
          {done
            ? <Button size="sm" icon="restart" shortcut={['⇧', 'E']} title="Mark not done (⇧E)" onClick={() => on.onNotDone(call)}>Not done</Button>
            : <Button size="sm" variant="primary" shortcut={['E']} className="cv-done" title="Mark done (E)" onClick={() => on.onDone(call)}>Done</Button>}
        </div>
      )}
    </div>
  )
}

function Header({ call }: { call: Call }) {
  const assistant = useAssistantName()
  const contact = useContact(call.contact_id)
  const started = parseTs(call.started_at)
  const live = call.status === 'live'
  return (
    <div className="cv-who">
      <div className="cv-who-t">
        <div className="cv-meta">
          {live ? <LiveIndicator since={started} /> : <><span>{dateTimeLabel(started)}</span><span>{call.duration_sec ? longDuration(call.duration_sec) : '—'}</span></>}
          <span>{answeredBy(call, assistant)}</span>
        </div>
        <h1>{callTitle(call)}</h1>
        <div className="cv-line">
          <b>{contact?.name ? `${contact.name}${contact.company ? ` · ${contact.company}` : ''}` : 'Unknown caller'}</b>
          <span className="sub">{formatPhone(call.from_number)}</span>
          {hasReminder(call) && call.reminder_label && <span>Reminder: {call.reminder_label}</span>}
        </div>
      </div>
    </div>
  )
}

/** Keep a live transcript pinned to the bottom while the reader is already near it. */
function useFollowLive(live: boolean, segmentCount: number) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && live && segmentCount && el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX) el.scrollTop = el.scrollHeight
  }, [live, segmentCount])
  return ref
}

/** One call, full width: what it was about, the conversation, and the caller on the side. Mount with key={call.id} so each call starts at the top. */
export function CallView({ call, segments, search, side, ...bar }: Props) {
  const assistant = useAssistantName()
  const contact = useContact(call.contact_id)
  const live = call.status === 'live'
  const scrollRef = useFollowLive(live, segments.length)
  useEffect(() => {
    if (search) scrollRef.current?.querySelector('.k-bubble mark')?.scrollIntoView({ block: 'center' })
  }, [search, scrollRef])
  const turns = segments.filter(s => s.speaker !== 'system').length
  const [transcriptOpen, setTranscriptOpen] = useState(true)

  return (
    <div className="cv">
      <Bar call={call} {...bar} />
      <div className="cv-main">
        <div className="cv-center">
          <div className="cv-scroll" ref={scrollRef}>
            <div className="cv-col">
              <Header call={call} />
              {live && <LiveCard segments={segments} assistantName={assistant} />}
              <SummaryCard call={call} />
              {segments.length ? (
                <>
                  <div className="tr-h">
                    <b>Transcript</b><span>{turns} {turns === 1 ? 'turn' : 'turns'}{live ? ' · live' : ''}</span>
                    <Button size="sm" variant="ghost" aria-expanded={transcriptOpen} onClick={() => setTranscriptOpen(!transcriptOpen)}>{transcriptOpen ? 'Collapse' : 'Expand'}</Button>
                  </div>
                  {transcriptOpen && <Transcript segments={segments} callerName={contact?.name ?? 'Caller'} assistantName={assistant} search={search} />}
                </>
              ) : !live && (
                <div className="empty">
                  <Icon name="phone-missed" size={24} />
                  <b>{call.outcome === 'hangup' ? 'Hung up without saying anything' : 'No transcript'}</b>
                  <span>There is no transcript for this call.</span>
                </div>
              )}
            </div>
          </div>
        </div>
        {side}
      </div>
    </div>
  )
}
