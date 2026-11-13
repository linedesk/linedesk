// The test call in a panel on the right, laid out like a call in the inbox: status and controls on
// top, then what the assistant did and the conversation as it happens (the same transcript, event
// lines and booking cards as the call view), and the summary once the call is filed. It does not
// cover the page with a backdrop: the instructions stay editable while you talk.
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
  const { phase, call, problem } = session
  if (problem)
    return <span className="tcp-sub tcp-sub-problem">{phase === 'ended' ? 'Call dropped' : "Couldn't start"}</span>
  if (phase === 'starting') return <span className="tcp-sub">Connecting…</span>
  if (phase === 'live' && call) return <LiveIndicator since={parseTs(call.started_at)} />
  if (phase === 'live') return <span className="tcp-sub">Ringing…</span>
  if (call?.duration_sec) return <span className="tcp-sub">Ended · {longDuration(call.duration_sec)}</span>
  return <span className="tcp-sub">Ended</span>
}

function Controls({ session }: { session: TestCallSession }) {
  const { phase, muted } = session
  if (phase === 'starting')
    return (
      <Button size="sm" variant="ghost" onClick={session.cancel}>
        Cancel
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
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute your microphone' : 'Mute your microphone'}
          onClick={session.toggleMute}
        />
        <Button size="sm" variant="danger" icon="phone-off" title="Hang up" onClick={() => void session.stop()}>
          Hang up
        </Button>
      </>
    )
  return (
    <Button size="sm" variant="ghost" icon="close" aria-label="Close" title="Close (esc)" onClick={session.dismiss} />
  )
}

/** Opens the filed call in the inbox (the settings page closes, and the panel with it). */
const openInInbox = (callId: string) => {
  window.location.hash = callHash(callId)
}

/** The conversation so far: the same transcript as a finished call, plus the lines still being spoken. */
function Conversation({ session }: { session: TestCallSession }) {
  const { call, lines, pending, name, phase } = session
  const running = phase === 'live' || call?.status === 'live'
  const end = call && call.status !== 'live' ? { time: clock(call.duration_sec ?? 0), label: 'Call ended' } : null
  return (
    <Transcript
      segments={lines}
      pending={pending}
      callerName="You"
      assistantName={name}
      search={null}
      start={{ time: clock(0), label: `Test call, ${name} answered` }}
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
  const { phase, problem, failure, notSetUp, call, name, lines, pending } = session
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
    problem ?? failure ?? (notSetUp ? `${name} can't talk yet: the ${notSetUp} service isn't set up.` : null)
  const summarizing = phase === 'ended' && call?.status === 'live'
  return (
    <>
      <AudioSink target={session.audio} />
      {open &&
        createPortal(
          <aside className="tcp cv" aria-label="Test call">
            <header className="tcp-h">
              <div className="tcp-title" role="status">
                <b>Test call with {name}</b>
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
                  {phase === 'starting' ? 'Connecting your microphone…' : `Waiting for ${name} to answer…`}
                </p>
              )}
              {summarizing && (
                <p className="tcp-wait">
                  <span className="st-spin" aria-hidden="true" />
                  Writing the summary…
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
                    Open in inbox
                  </Button>
                )}
                <Button size="sm" variant="primary" icon="phone-in" onClick={onStart}>
                  Call again
                </Button>
              </footer>
            )}
          </aside>,
          document.body,
        )}
    </>
  )
}
