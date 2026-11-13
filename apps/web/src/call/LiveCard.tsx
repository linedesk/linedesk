import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { useEffect } from 'react'
import { Button } from '../ui/kit.tsx'
import { type LiveSession, liveSession, useLiveSession } from './liveSession.ts'

/** L listens or stops listening, ⇧T takes the call over: the open live call registers them while shown. */
let keysMounted: ((key: string) => boolean) | null = null

/** The app's key handler asks here; false when no live call is open or the key is not one of these. */
export function liveCallKey(key: string): boolean {
  return keysMounted?.(key) ?? false
}

function useLiveKeys(callId: string, session: LiveSession) {
  useEffect(() => {
    const mine = session.callId === callId ? session.phase : 'idle'
    const handler = (key: string) => {
      if (key === 'l') {
        if (mine === 'listening') void liveSession.leave()
        else if (mine === 'idle') void liveSession.listen(callId)
        else return false
        return true
      }
      if (key === 'T' && (mine === 'idle' || mine === 'listening')) {
        void liveSession.takeOver(callId)
        return true
      }
      return false
    }
    keysMounted = handler
    return () => {
      if (keysMounted === handler) keysMounted = null
    }
  }, [callId, session.callId, session.phase])
}

function headline(phase: LiveSession['phase'], assistantName: string, takenBy: string | null) {
  if (phase === 'joining') return 'Joining the call…'
  if (phase === 'handingOff') return `${assistantName} is putting the caller through to you…`
  if (phase === 'talking') return "You're on the call"
  if (takenBy) return takenBy
  return `${assistantName} is on the call…`
}

/**
 * Shown while the call is running: who is on it, the latest thing the assistant did, and Listen /
 * Take over for this tab (liveSession.ts). The conversation after a take-over is not recorded.
 */
export function LiveCard({
  call,
  segments,
  assistantName,
}: {
  call: Call
  segments: TranscriptSegment[]
  assistantName: string
}) {
  const session = useLiveSession()
  useLiveKeys(call.id, session)
  const mine = session.callId === call.id
  const phase = mine ? session.phase : 'idle'
  const lastEvent = segments.findLast(s => s.tool_event)?.tool_event
  // "<name> took the call over" (written by the assistant when it hands over).
  const takenBy = segments.findLast(s => s.speaker === 'system' && s.text.endsWith('took the call over'))?.text ?? null
  const busy = phase === 'joining' || phase === 'handingOff'
  return (
    <section className="lvc" aria-live="polite">
      <div className="lvc-row">
        <span className="lvc-bars on">
          {[0, 1, 2, 3, 4].map(i => (
            <i key={i} />
          ))}
        </span>
        <span className="lvc-who">{headline(phase, assistantName, takenBy)}</span>
        <span className="lvc-acts">
          {phase === 'talking' ? (
            <>
              <Button
                size="sm"
                icon="mic"
                aria-pressed={session.muted}
                onClick={liveSession.toggleMute}
                title={session.muted ? 'Unmute your microphone' : 'Mute your microphone'}
              >
                {session.muted ? 'Unmute' : 'Mute'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="phone-off"
                onClick={() => void liveSession.leave()}
                title="Hang up: ends the call for the caller too"
              >
                Hang up
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                icon="headset"
                shortcut={['L']}
                disabled={busy}
                aria-pressed={phase === 'listening'}
                title={
                  phase === 'listening'
                    ? 'Stop listening (L)'
                    : 'Listen: hear the call without the caller hearing you (L)'
                }
                onClick={() => void (phase === 'listening' ? liveSession.leave() : liveSession.listen(call.id))}
              >
                {phase === 'listening' ? 'Stop listening' : 'Listen'}
              </Button>
              {!takenBy && (
                <Button busy={phase === 'handingOff'}
                  size="sm"
                  variant="primary"
                  icon="phone-in"
                  shortcut={['⇧', 'T']}
                  disabled={busy}
                  title={`Take over: ${assistantName} tells the caller and hands the call to you; not recorded from then on (⇧T)`}
                  onClick={() => void liveSession.takeOver(call.id)}
                >
                  {phase === 'handingOff' ? 'Connecting…' : 'Take over'}
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      {phase === 'talking' && <p className="lvc-note">The caller hears you. This part of the call is not recorded.</p>}
      {phase !== 'talking' && lastEvent && <p className="lvc-note">{lastEvent.label}</p>}
      {mine && session.problem && (
        <p className="lvc-note lvc-problem" role="alert">
          {session.problem}
        </p>
      )}
    </section>
  )
}
