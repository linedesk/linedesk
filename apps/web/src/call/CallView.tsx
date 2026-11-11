import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { answeredByLabel, type CallStatus, callStatus, callTitle, formatPhone, hasReminder, STATUS_WORD, transferText } from '../inbox-model.ts'
import { useCallAssistantName, useContact } from '../store.tsx'
import { firstName, memberLabel, useMember } from '../team/members.ts'
import { clock, dateTimeLabel, longDuration, parseTs, whenLabel } from '../time.ts'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { registerContactPanel } from './contactPanel.ts'
import { BookingCards } from './BookingCard.tsx'
import { LiveCard } from './LiveCard.tsx'
import { RecordingPlayer } from './RecordingPlayer.tsx'
import { EvaluationCard } from './EvaluationCard.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { Transcript } from './Transcript.tsx'
import { useFollowLive } from './useFollowLive.ts'

export type CallViewActions = {
  onBack: () => void
  onStep: (by: number) => void
  onDone: (call: Call) => void
  onNotDone: (call: Call) => void
  onRemind: (call: Call) => void
  onClearReminder: (call: Call) => void
  /** ⌘K: the rest of the call's actions (Mark unread, Delete…), as ⋯ does on a row. */
  onCommands?: () => void
  /** Takes a spam call back to Needs you (the only way out of Spam besides Done). */
  onToggleSpam?: (call: Call) => void
  /** The member picker under the assign button; unset while the workspace has a single member. */
  onAssign?: (call: Call, anchor: DOMRect) => void
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
  /** Owners and admins: the call's evaluation under the summary. */
  canReview?: boolean
}

/** Below this width the contact panel is a sheet (app.css). */
const NARROW_QUERY = '(max-width: 1099px)'

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

type BarProps = Omit<Props, 'segments' | 'search' | 'side' | 'repeatCount' | 'canReview'>

function Bar({ call, index, count, menu, ...on }: BarProps) {
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = hasReminder(call) && !done
  return (
    <div className="cv-bar" role="toolbar" aria-label="Call">
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
      {on.onAssign && (
        <span className="cv-assign">
          <AssignButton call={call} onAssign={on.onAssign} />
        </span>
      )}
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
          {call.outcome === 'spam' && on.onToggleSpam && (
            <Button
              size="sm"
              variant="ghost"
              shortcut={['!']}
              title="Not spam: back to Needs you (!)"
              onClick={() => on.onToggleSpam!(call)}
            >
              Not spam
            </Button>
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

/** Who has the call: their initials and first name, or Assign. Opens the member picker under itself (A). */
function AssignButton({ call, onAssign }: { call: Call; onAssign: (call: Call, anchor: DOMRect) => void }) {
  const assignee = useMember(call.assignee_id)
  const name = memberLabel(assignee)
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={call.assignee_id ? undefined : 'user'}
      className="cv-assign-btn"
      aria-haspopup="dialog"
      title={call.assignee_id ? `Assigned to ${name}: reassign (A)` : 'Assign (A)'}
      onClick={e => onAssign(call, e.currentTarget.getBoundingClientRect())}
    >
      {call.assignee_id ? (
        <>
          <Avatar name={name} size={20} />
          {firstName(assignee)}
        </>
      ) : (
        'Assign'
      )}
    </Button>
  )
}

type HeaderProps = {
  call: Call
  segments: TranscriptSegment[]
  repeatCount: number
  /** Whether the contact sheet is open (narrow windows). */
  contactOpen: boolean
  onOpenContact: () => void
}

/**
 * The caller's name opens their contact (the panel beside the call; a sheet on narrow windows). An
 * unknown caller reads "Add name" and opens the same panel at its name field.
 */
function ContactLink({ name, number, open, onOpen }: { name: string | null; number: string; open: boolean; onOpen: () => void }) {
  const label = name ? `Open contact ${name}` : `Add a name for ${number}`
  return (
    <button type="button" className="cv-contact-link" aria-label={label} aria-expanded={open} title={`${label} (I)`} onClick={onOpen}>
      <span>{name ?? 'Add name'}</span>
      <Icon name="arrow-up-right" size={12} />
    </button>
  )
}

function Header({ call, segments, repeatCount, contactOpen, onOpenContact }: HeaderProps) {
  const assistant = useCallAssistantName(call.assistant_id)
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
          <ContactLink
            name={contact?.name ? `${contact.name}${contact.company ? ` · ${contact.company}` : ''}` : null}
            number={formatPhone(call.from_number)}
            open={contactOpen}
            onOpen={onOpenContact}
          />
          <CopyNumber number={formatPhone(call.from_number)} />
          {repeatCount > 1 && <span>{repeatCount} calls from this number</span>}
          {hasReminder(call) && <span>Reminder: {whenLabel(parseTs(call.reminder_at!))}</span>}
          {transferText(call) && <span className="cv-transfer">{transferText(call)}</span>}
        </div>
      </div>
    </div>
  )
}

/** In place of the transcript when nobody spoke: say what happened, in the same words as the inbox. */
function NoConversation({ status }: { status: CallStatus }) {
  const [title, text] =
    status === 'missed'
      ? [STATUS_WORD.missed, 'Nobody picked up this call, so there is no conversation.']
      : status === 'hungUp'
        ? [STATUS_WORD.hungUp, 'The caller hung up without saying anything.']
        : ['No transcript', 'There is no transcript for this call.']
  return (
    <div className="empty">
      <Icon name="phone-missed" size={24} />
      <b>{title}</b>
      <span>{text}</span>
    </div>
  )
}

/** The caller's number under the title: a click copies it. */
function CopyNumber({ number }: { number: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(number).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  return (
    <button type="button" className="sub fact-copy" title={copied ? 'Copied' : 'Copy number'} onClick={copy}>
      {copied ? 'Copied' : number}
    </button>
  )
}

/** One call, full width: what it was about, the conversation, and the caller on the side. Mount with key={call.id} so each call starts at the top. */
export function CallView({ call, segments, search, side, repeatCount = 1, canReview = false, ...bar }: Props) {
  const [sideOpen, setSideOpen] = useState(false)
  /** Narrow windows: open or close the contact sheet. Wide ones show the panel anyway. Opening puts the caret in its name. */
  function openContact() {
    const narrow = window.matchMedia(NARROW_QUERY).matches
    if (narrow && sideOpen) return setSideOpen(false)
    if (narrow) setSideOpen(true)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.cv-side [aria-label="Name"]')?.focus())
  }
  useEffect(() => registerContactPanel(() => setSideOpen(open => !open)), [])
  const assistant = useCallAssistantName(call.assistant_id)
  const contact = useContact(call.contact_id)
  const live = call.status === 'live'
  const { ref: scrollRef, onScroll } = useFollowLive(live, segments.length)
  // When the call ends, title and summary appear at the top: bring them into view.
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
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
      <Bar call={call} {...bar} />
      <div className="cv-main" data-side={sideOpen ? 'open' : undefined}>
        <div className="cv-center">
          <div className="cv-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="cv-col">
              <Header
                call={call}
                segments={segments}
                repeatCount={repeatCount}
                contactOpen={sideOpen}
                onOpenContact={openContact}
              />
              {live && <LiveCard segments={segments} assistantName={assistant} />}
              {!live && call.recording_key && <RecordingPlayer callId={call.id} callDurationSec={call.duration_sec} />}
              <SummaryCard call={call} />
              {canReview && <EvaluationCard call={call} />}
              <BookingCards callId={call.id} />
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
