// The test call in a panel on the right, laid out like a call in the inbox: status and controls on
// top, then what the assistant did and the conversation as it happens (the same transcript, event
// lines and booking cards as the call view), and the summary once the call is filed. It does not
// cover the page with a backdrop: the instructions stay editable while you talk.
import { useT } from '@linedesk/i18n/react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { BookingCards } from '../call/BookingCard.tsx'
import { SummaryCard } from '../call/SummaryCard.tsx'
import { Transcript } from '../call/Transcript.tsx'
import { useFollowLive } from '../call/useFollowLive.ts'
import { callHash } from '../shell/useRoute.ts'
import { clock, longDuration, parseTs } from '../time.ts'
import { Button, Note } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { AudioSink, type TestCallSession } from './TestCall.tsx'
import './test-call-panel.css'

/** Where the call stands, in a few words for the header. */
function Status({ session }: { session: TestCallSession }) {
  const t = useT()
  const { phase, call, problem } = session
  if (problem)
    return (
      <span className="tcp-sub tcp-sub-problem">
        {phase === 'ended' ? t('settings.testCall.status.dropped') : t('settings.testCall.status.couldNotStart')}
      </span>
    )
  if (phase === 'starting') return <span className="tcp-sub">{t('settings.testCall.status.connecting')}</span>
  if (phase === 'live' && call) return <LiveIndicator since={parseTs(call.started_at)} />
  if (phase === 'live') return <span className="tcp-sub">{t('settings.testCall.status.ringing')}</span>
  if (call?.duration_sec)
    return (
      <span className="tcp-sub">
        {t('settings.testCall.status.endedAfter', { duration: longDuration(call.duration_sec) })}
      </span>
    )
  return <span className="tcp-sub">{t('settings.testCall.status.ended')}</span>
}

function Controls({ session }: { session: TestCallSession }) {
  const t = useT()
  const { phase, muted } = session
  if (phase === 'starting')
    return (
      <Button size="sm" variant="ghost" onClick={session.cancel}>
        {t('common.action.cancel')}
      </Button>
    )
  if (phase === 'live')
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon={muted ? 'micOff' : 'mic'}
          aria-pressed={muted}
          aria-label={muted ? t('settings.testCall.unmute') : t('settings.testCall.mute')}
          title={muted ? t('settings.testCall.unmuteTip') : t('settings.testCall.muteTip')}
          onClick={session.toggleMute}
        />
        <Button
          size="sm"
          variant="danger"
          icon="phone-off"
          title={t('settings.testCall.hangUp')}
          onClick={() => void session.stop()}
        >
          {t('settings.testCall.hangUp')}
        </Button>
      </>
    )
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="close"
      aria-label={t('common.action.close')}
      title={t('common.action.closeWithKey', { key: 'esc' })}
      onClick={session.dismiss}
    />
  )
}

/** Opens the filed call in the inbox (the settings page closes, and the panel with it). */
const openInInbox = (callId: string) => {
  window.location.hash = callHash(callId)
}

/** The conversation so far: the same transcript as a finished call, plus the lines still being spoken. */
function Conversation({ session }: { session: TestCallSession }) {
  const t = useT()
  const { call, lines, pending, name, phase } = session
  const running = phase === 'live' || call?.status === 'live'
  const end =
    call && call.status !== 'live'
      ? { time: clock(call.duration_sec ?? 0), label: t('settings.testCall.transcript.ended') }
      : null
  return (
    <Transcript
      segments={lines}
      pending={pending}
      callerName={t('settings.testCall.transcript.you')}
      assistantName={name}
      search={null}
      start={{ time: clock(0), label: t('settings.testCall.transcript.answered', { name }) }}
      end={running ? null : end}
    />
  )
}

/** The panel while a test call starts, runs and right after it, until it is closed. */
export function TestCallPanel({
  session,
  onOpenCall = openInInbox,
  onStart = session.start,
}: {
  session: TestCallSession
  /** Where Open in inbox goes; default: the call in the inbox. null: no such button (onboarding, mid-way). */
  onOpenCall?: ((callId: string) => void) | null
  /** Runs for Call again instead of `session.start` (onboarding saves the assistant first). */
  onStart?: () => void
}) {
  const t = useT()
  const { phase, problem, failure, notSetUp, call, name, lines, pending, stillConnecting } = session
  const open = phase !== 'idle' || !!problem
  const closable = phase === 'ended' || phase === 'idle'
  const { ref, onScroll } = useFollowLive(
    phase === 'live',
    lines.length + pending.length + pending.map(l => l.text).join('').length,
  )
  const dismiss = useRef(session.dismiss)
  dismiss.current = session.dismiss
  // Esc belongs to the panel while it is open (before the page's own Esc, e.g. back in onboarding):
  // it closes the panel after the call, and does nothing during it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (closable) dismiss.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, closable])

  const message =
    problem ?? failure ?? (notSetUp ? t('settings.testCall.serviceNotSetUp', { name, service: notSetUp }) : null)
  const summarizing = phase === 'ended' && call?.status === 'live'
  return (
    <>
      <AudioSink target={session.audio} />
      {open &&
        createPortal(
          <aside className="tcp cv" aria-label={t('settings.testCall.panel')}>
            <header className="tcp-h">
              <div className="tcp-title" role="status">
                <b>{t('settings.testCall.with', { name })}</b>
                <Status session={session} />
              </div>
              <div className="tcp-ctl">
                <Controls session={session} />
              </div>
            </header>
            <div className="tcp-scroll" ref={ref} onScroll={onScroll}>
              {message && <Note tone="danger">{message}</Note>}
              {!message && !call && phase !== 'ended' && (
                <p className="tcp-wait">
                  <span className="st-spin" aria-hidden="true" />
                  {phase === 'starting'
                    ? t('settings.testCall.wait.microphone')
                    : stillConnecting
                      ? t('settings.testCall.wait.stillConnecting')
                      : t('settings.testCall.wait.answer', { name })}
                </p>
              )}
              {summarizing && (
                <p className="tcp-wait">
                  <span className="st-spin" aria-hidden="true" />
                  {t('settings.testCall.wait.summary')}
                </p>
              )}
              {call && call.status !== 'live' && <SummaryCard call={call} />}
              {call && <BookingCards callId={call.id} />}
              {call && <Conversation session={session} />}
            </div>
            {phase === 'ended' && call && (
              <footer className="tcp-f">
                {onOpenCall && (
                  <Button size="sm" variant="ghost" icon="arrow-up-right" onClick={() => onOpenCall(call.id)}>
                    {t('settings.testCall.openInInbox')}
                  </Button>
                )}
                <Button size="sm" variant="primary" icon="phone-in" onClick={onStart}>
                  {t('settings.testCall.callAgain')}
                </Button>
              </footer>
            )}
          </aside>,
          document.body,
        )}
    </>
  )
}
