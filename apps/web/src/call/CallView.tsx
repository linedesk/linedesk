import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  answeredByLabel,
  type CallStatus,
  callStatus,
  callTitle,
  formatPhone,
  hasReminder,
  isTestCall,
  STATUS_WORD,
  testCallLabel,
  transferText,
} from '../inbox-model.ts'
import { useCallAssistantName, useContact } from '../store.tsx'
import { firstName, memberAvatar, memberLabel, useMember } from '../team/members.ts'
import { clock, dateTimeLabel, callDuration, parseTs, whenLabel } from '../time.ts'
import { Avatar, Button, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { registerContactPanel } from './contactPanel.ts'
import { BookingCards } from './BookingCard.tsx'
import { LiveCard } from './LiveCard.tsx'
import { liveSession, useLiveSession } from './liveSession.ts'
import { useLiveLines } from './useLiveLines.ts'
import { RecordingNotKept, RecordingPlayer } from './RecordingPlayer.tsx'
import { EvaluationCard } from './EvaluationCard.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { Transcript } from './Transcript.tsx'
import { useFollowLive } from './useFollowLive.ts'
import { useT } from '@linedesk/i18n/react'

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
  /** Server admins who are an owner or admin here: the call's evaluation under the summary (staff only). */
  canReview?: boolean
}

/** Below this width the contact panel is a sheet (app.css). */
const NARROW_QUERY = '(max-width: 1099px)'

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

type BarProps = Omit<Props, 'segments' | 'search' | 'side' | 'repeatCount' | 'canReview'>

function Bar({ call, index, count, menu, ...on }: BarProps) {
  const t = useT()
  const live = call.status === 'live'
  const done = call.inbox_state === 'done'
  const reminded = hasReminder(call) && !done
  return (
    <div className="cv-bar" role="toolbar" aria-label={t('call.bar.label')}>
      {menu}
      <Button
        size="sm"
        variant="ghost"
        icon="left"
        title={t('common.withKey', { label: t('call.bar.back'), key: 'esc' })}
        aria-label={t('call.bar.back')}
        onClick={on.onBack}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="up"
        title={t('common.withKey', { label: t('call.bar.previous'), key: 'K' })}
        aria-label={t('call.bar.previous')}
        disabled={index <= 0}
        onClick={() => on.onStep(-1)}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="down"
        title={t('common.withKey', { label: t('call.bar.next'), key: 'J' })}
        aria-label={t('call.bar.next')}
        disabled={index >= count - 1}
        onClick={() => on.onStep(1)}
      />
      {index > -1 && <span className="cv-pos">{t('call.bar.position', { index: index + 1, count })}</span>}
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
              aria-label={t('inbox.action.allCommands')}
              title={t('common.withKey', { label: t('inbox.action.allCommands'), key: '⌘ K' })}
              onClick={on.onCommands}
            />
          )}
          {reminded && (
            <Button
              size="sm"
              variant="ghost"
              shortcut={['⇧', 'H']}
              title={t('common.withKey', { label: t('inbox.goLive.clearReminder'), key: '⇧H' })}
              onClick={() => on.onClearReminder(call)}
            >
              {t('inbox.goLive.clearReminder')}
            </Button>
          )}
          {!done && !reminded && (
            <Button
              size="sm"
              variant="ghost"
              icon="clock"
              className="cv-act"
              aria-label={t('shell.command.remindMe')}
              title={t('common.withKey', { label: t('shell.command.remindMe'), key: 'H' })}
              onClick={() => on.onRemind(call)}
            />
          )}
          {call.outcome === 'spam' && on.onToggleSpam && (
            <Button
              size="sm"
              variant="ghost"
              shortcut={['!']}
              title={t('common.withKey', { label: t('call.bar.notSpamTitle'), key: '!' })}
              onClick={() => on.onToggleSpam!(call)}
            >
              {t('call.bar.notSpam')}
            </Button>
          )}
          {done ? (
            <Button
              size="sm"
              icon="restart"
              shortcut={['⇧', 'E']}
              title={t('common.withKeyHint', {
                label: t('shell.command.markNotDone'),
                key: '⇧E',
                hint: t('inbox.action.notDoneHint'),
              })}
              onClick={() => on.onNotDone(call)}
            >
              {t('inbox.action.notDone')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              shortcut={['E']}
              className="cv-done"
              title={t('common.withKey', { label: t('shell.command.markDone'), key: 'E' })}
              onClick={() => on.onDone(call)}
            >
              {t('inbox.action.done')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Who has the call: their picture (or initials) and first name, or Assign. Opens the member picker under itself (A). */
function AssignButton({ call, onAssign }: { call: Call; onAssign: (call: Call, anchor: DOMRect) => void }) {
  const t = useT()
  const assignee = useMember(call.assignee_id)
  const name = memberLabel(assignee)
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={call.assignee_id ? undefined : 'user'}
      className="cv-assign-btn"
      aria-haspopup="dialog"
      title={t('common.withKey', {
        label: call.assignee_id ? t('inbox.row.reassignTitle', { name }) : t('inbox.assign.label'),
        key: 'A',
      })}
      onClick={e => onAssign(call, e.currentTarget.getBoundingClientRect())}
    >
      {call.assignee_id ? (
        <>
          <Avatar name={name} size={20} src={memberAvatar(assignee)} />
          {firstName(assignee)}
        </>
      ) : (
        t('inbox.assign.label')
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
function ContactLink({
  name,
  number,
  open,
  onOpen,
}: {
  name: string | null
  number: string
  open: boolean
  onOpen: () => void
}) {
  const t = useT()
  const label = name ? t('call.header.openContact', { name }) : t('call.header.addNameFor', { number })
  return (
    <button
      type="button"
      className="cv-contact-link"
      aria-label={label}
      aria-expanded={open}
      title={t('common.withKey', { label, key: 'I' })}
      onClick={onOpen}
    >
      <span>{name ?? t('call.contact.addName')}</span>
      <Icon name="arrow-up-right" size={12} />
    </button>
  )
}

function Header({ call, segments, repeatCount, contactOpen, onOpenContact }: HeaderProps) {
  const t = useT()
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
              <span>{call.duration_sec ? callDuration(call.duration_sec) : '—'}</span>
            </>
          )}
          <span>{answeredByLabel(call, segments, assistant)}</span>
          {call.assistant_version != null && (
            <span title={t('call.header.versionTitle')}>
              {t('call.header.version', { version: call.assistant_version })}
            </span>
          )}
        </div>
        <h1>{callTitle(call)}</h1>
        <div className="cv-line">
          <ContactLink
            name={
              isTestCall(call)
                ? testCallLabel()
                : contact?.name
                  ? contact.company
                    ? t('call.header.nameAndCompany', { name: contact.name, company: contact.company })
                    : contact.name
                  : null
            }
            number={formatPhone(call.from_number)}
            open={contactOpen}
            onOpen={onOpenContact}
          />
          <CopyNumber number={formatPhone(call.from_number)} />
          {repeatCount > 1 && <span>{t('inbox.row.callsFromNumber', { count: repeatCount })}</span>}
          {hasReminder(call) && (
            <span>{t('call.header.reminder', { when: whenLabel(parseTs(call.reminder_at!)) })}</span>
          )}
          {transferText(call) && <span className="cv-transfer">{transferText(call)}</span>}
        </div>
      </div>
    </div>
  )
}

/** In place of the transcript when nobody spoke: say what happened, in the same words as the inbox. */
function NoConversation({ status }: { status: CallStatus }) {
  const t = useT()
  const [title, text] =
    status === 'missed'
      ? [STATUS_WORD.missed, t('call.empty.missed')]
      : status === 'hungUp'
        ? [STATUS_WORD.hungUp, t('call.empty.hungUp')]
        : [t('call.empty.noTranscript'), t('call.empty.noTranscriptLine')]
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
  const t = useT()
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
    <button
      type="button"
      className="sub fact-copy"
      title={copied ? t('call.header.copied') : t('call.header.copyNumber')}
      onClick={copy}
    >
      {copied ? t('call.header.copied') : number}
    </button>
  )
}

/** What is being said right now while this tab listens to or talks on the call, until each turn syncs in. */
function useListenedLines(callId: string, segments: TranscriptSegment[]) {
  const { callId: listening } = useLiveSession()
  const live = useLiveLines(segments)
  const { read, clear } = live
  useEffect(() => {
    if (listening !== callId) return
    const stop = liveSession.showStreams((reader, speaker) => void read(reader, speaker))
    return () => {
      stop()
      clear()
    }
  }, [listening, callId, read, clear])
  return live.pending
}

/** One call, full width: what it was about, the conversation, and the caller on the side. Mount with key={call.id} so each call starts at the top. */
export function CallView({ call, segments, search, side, repeatCount = 1, canReview = false, ...bar }: Props) {
  const t = useT()
  const [sideOpen, setSideOpen] = useState(false)
  /** Narrow windows: open or close the contact sheet. Wide ones show the panel anyway. Opening puts the caret in its name. */
  function openContact() {
    const narrow = window.matchMedia(NARROW_QUERY).matches
    if (narrow && sideOpen) return setSideOpen(false)
    if (narrow) setSideOpen(true)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.cv-side [data-field="name"]')?.focus())
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
  const pending = useListenedLines(call.id, segments)
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
              {live && <LiveCard call={call} segments={segments} assistantName={assistant} />}
              {!live && call.recording_key && <RecordingPlayer callId={call.id} callDurationSec={call.duration_sec} />}
              {!live && !call.recording_key && call.source !== 'sample' && <RecordingNotKept />}
              <SummaryCard call={call} />
              {canReview && <EvaluationCard call={call} />}
              <BookingCards callId={call.id} />
              {turns ? (
                <>
                  <div className="tr-h">
                    <b>{t('call.transcript.title')}</b>
                    <span>
                      {live
                        ? t('call.transcript.turnsLive', { count: turns })
                        : t('call.transcript.turns', { count: turns })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={transcriptOpen}
                      onClick={() => setTranscriptOpen(!transcriptOpen)}
                    >
                      {transcriptOpen ? t('call.transcript.collapse') : t('call.transcript.expand')}
                    </Button>
                  </div>
                  {transcriptOpen && (
                    <Transcript
                      segments={segments}
                      callerName={(!isTestCall(call) && contact?.name) || t('call.transcript.caller')}
                      assistantName={assistant}
                      search={search}
                      pending={live ? pending : []}
                      start={{
                        time: clock(0),
                        label:
                          call.answered_by === 'human'
                            ? t('call.transcript.startTeam')
                            : t('call.transcript.start', { assistant }),
                      }}
                      end={
                        live
                          ? null
                          : {
                              time: clock(call.duration_sec ?? Math.max(0, ...segments.map(s => s.at_ms / 1000))),
                              label: status === 'hungUp' ? t('call.transcript.hungUp') : t('call.transcript.ended'),
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
        {sideOpen && (
          <button
            type="button"
            className="cv-side-scrim"
            aria-label={t('call.contact.close')}
            tabIndex={-1}
            onClick={() => setSideOpen(false)}
          />
        )}
        {side}
      </div>
    </div>
  )
}
