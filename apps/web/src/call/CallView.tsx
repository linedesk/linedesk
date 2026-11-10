import type { Call, TranscriptSegment } from '@callfront/db/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { answeredByLabel, type CallStatus, callStatus, callTitle, formatPhone, hasReminder } from '../inbox-model.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { clock, dateTimeLabel, longDuration, parseTs, whenLabel } from '../time.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { LiveCard } from './LiveCard.tsx'
import { RecordingPlayer } from './RecordingPlayer.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { Transcript } from './Transcript.tsx'

export type CallViewActions = {
  onBack: () => void
  onStep: (by: number) => void
  onDone: (call: Call) => void
  onNotDone: (call: Call) => void
  onRemind: (call: Call) => void
  onClearReminder: (call: Call) => void
  /** ⌘K: the rest of the call's actions (Mark unread, Delete…), as ⋯ does on a row. */
  onCommands?: () => void
}

type Props = CallViewActions & {
  call: Call
  segments: TranscriptSegment[]
  index: number
  count: number
  search: string | null
  menu?: ReactNode
  side: ReactNode
  /** How many calls the inbox row stands for (repeat hang-ups fold into one row). */
  repeatCount?: number
}

const STICK_TO_BOTTOM_PX = 140

type BarProps = Omit<Props, 'segments' | 'search' | 'side' | 'repeatCount'> & {
  sideOpen: boolean
  onToggleSide: () => void
}

function Bar({ call, index, count, menu, sideOpen, onToggleSide, ...on }: BarProps) {
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = hasReminder(call) && !done
  return (
    <div className="cv-bar">
      {menu}
      <Button
        size="sm"
        variant="ghost"
        icon="left"
        title="Back to calls (esc)"
        aria-label="Back to calls"
        onClick={on.onBack}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="up"
        title="Previous call (K)"
        aria-label="Previous call"
        disabled={index <= 0}
        onClick={() => on.onStep(-1)}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="down"
        title="Next call (J)"
        aria-label="Next call"
        disabled={index >= count - 1}
        onClick={() => on.onStep(1)}
      />
      {index > -1 && (
        <span className="cv-pos">
          {index + 1} of {count}
        </span>
      )}
      {/* Narrow windows have no room for the contact panel next to the call: it opens as a sheet. */}
      <Button
        size="sm"
        variant="ghost"
        icon="user"
        className="cv-caller-btn"
        aria-label="Contact"
        aria-expanded={sideOpen}
        title="Contact"
        onClick={onToggleSide}
      />
      {!live && (
        <div className="cv-acts">
          {on.onCommands && (
            <Button
              size="sm"
              variant="ghost"
              icon="more"
              aria-label="All commands"
              title="All commands (⌘ K)"
              onClick={on.onCommands}
            />
          )}
          {reminded && (
            <Button
              size="sm"
              variant="ghost"
              shortcut={['⇧', 'H']}
              title="Clear reminder (⇧H)"
              onClick={() => on.onClearReminder(call)}
            >
              Clear reminder
            </Button>
          )}
          {!done && !reminded && (
            <Button
              size="sm"
              variant="ghost"
              icon="clock"
              className="cv-act"
              aria-label="Remind me"
              title="Remind me (H)"
              onClick={() => on.onRemind(call)}
            />
          )}
          {done ? (
            <Button
              size="sm"
              icon="restart"
              shortcut={['⇧', 'E']}
              title="Mark not done (⇧E)"
              onClick={() => on.onNotDone(call)}
            >
              Not done
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              shortcut={['E']}
              className="cv-done"
              title="Mark done (E)"
              onClick={() => on.onDone(call)}
            >
              Done
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Header({ call, segments, repeatCount }: { call: Call; segments: TranscriptSegment[]; repeatCount: number }) {
  const assistant = useAssistantName()
  const contact = useContact(call.contact_id)
  const started = parseTs(call.started_at)
  const live = call.status === 'live'
  return (
    <div className="cv-who">
      <div className="cv-who-t">
        <div className="cv-meta">
          {live ? (
            <LiveIndicator since={started} />
          ) : (
            <>
              <span>{dateTimeLabel(started)}</span>
              <span>{call.duration_sec ? longDuration(call.duration_sec) : '—'}</span>
            </>
          )}
          <span>{answeredByLabel(call, segments, assistant)}</span>
        </div>
        <h1>{callTitle(call)}</h1>
        <div className="cv-line">
          <b>{contact?.name ? `${contact.name}${contact.company ? ` · ${contact.company}` : ''}` : 'Unknown caller'}</b>
          <span className="sub">{formatPhone(call.from_number)}</span>
          {repeatCount > 1 && <span>{repeatCount} calls from this number</span>}
          {hasReminder(call) && <span>Reminder: {whenLabel(parseTs(call.reminder_at!))}</span>}
        </div>
      </div>
    </div>
  )
}

/** In place of the transcript when nobody spoke: say what happened, in the same words as the inbox. */
function NoConversation({ status }: { status: CallStatus }) {
  const [title, text] =
    status === 'missed'
      ? ['Not answered', 'Nobody picked up this call, so there is no conversation.']
      : status === 'hungUp'
        ? ['Hung up', 'The caller hung up without saying anything.']
        : ['No transcript', 'There is no transcript for this call.']
  return (
    <div className="empty">
      <Icon name="phone-missed" size={24} />
      <b>{title}</b>
      <span>{text}</span>
    </div>
  )
}

/** Keep a live transcript pinned to the bottom while the reader was near it before the new turn arrived. */
function useFollowLive(live: boolean, segmentCount: number) {
  const ref = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const measure = () => {
    const el = ref.current
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX
  }
  useEffect(() => {
    const el = ref.current
    if (el && live && segmentCount && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [live, segmentCount])
  return { ref, onScroll: measure }
}

/** One call, full width: what it was about, the conversation, and the caller on the side. Mount with key={call.id} so each call starts at the top. */
export function CallView({ call, segments, search, side, repeatCount = 1, ...bar }: Props) {
  const [sideOpen, setSideOpen] = useState(false)
  const assistant = useAssistantName()
  const contact = useContact(call.contact_id)
  const live = call.status === 'live'
  const { ref: scrollRef, onScroll } = useFollowLive(live, segments.length)
  // When the call ends, title and summary appear at the top: bring them into view.
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    wasLive.current = live
  }, [live, scrollRef])
  useEffect(() => {
    if (search) scrollRef.current?.querySelector('.k-bubble mark')?.scrollIntoView({ block: 'center' })
  }, [search, scrollRef])
  const turns = segments.filter(s => s.speaker !== 'system').length
  const status = callStatus(call, segments)
  const [transcriptOpen, setTranscriptOpen] = useState(true)

  return (
    <div className="cv">
      <Bar call={call} {...bar} sideOpen={sideOpen} onToggleSide={() => setSideOpen(!sideOpen)} />
      <div className="cv-main" data-side={sideOpen ? 'open' : undefined}>
        <div className="cv-center">
          <div className="cv-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="cv-col">
              <Header call={call} segments={segments} repeatCount={repeatCount} />
              {live && <LiveCard segments={segments} assistantName={assistant} />}
              {!live && call.recording_key && <RecordingPlayer callId={call.id} callDurationSec={call.duration_sec} />}
              <SummaryCard call={call} />
              {turns ? (
                <>
                  <div className="tr-h">
                    <b>Transcript</b>
                    <span>
                      {turns} {turns === 1 ? 'turn' : 'turns'}
                      {live ? ' · live' : ''}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={transcriptOpen}
                      onClick={() => setTranscriptOpen(!transcriptOpen)}
                    >
                      {transcriptOpen ? 'Collapse' : 'Expand'}
                    </Button>
                  </div>
                  {transcriptOpen && (
                    <Transcript
                      segments={segments}
                      callerName={contact?.name ?? 'Caller'}
                      assistantName={assistant}
                      search={search}
                      start={{
                        time: clock(0),
                        label: `Incoming call, ${call.answered_by === 'human' ? 'the team' : assistant} answered`,
                      }}
                      end={
                        live
                          ? null
                          : {
                              time: clock(call.duration_sec ?? Math.max(0, ...segments.map(s => s.at_ms / 1000))),
                              label: status === 'hungUp' ? 'Caller hung up' : 'Call ended',
                            }
                      }
                    />
                  )}
                </>
              ) : (
                !live && <NoConversation status={status} />
              )}
            </div>
          </div>
        </div>
        {side}
      </div>
    </div>
  )
}
