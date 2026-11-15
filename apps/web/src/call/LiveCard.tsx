import type { Call, TranscriptSegment } from '@linedesk/db/types'
import { useEffect } from 'react'
import { Button, Note } from '../ui/kit.tsx'
import { type LiveSession, liveSession, useLiveSession } from './liveSession.ts'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

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
  const { t } = i18n()
  if (phase === 'joining') return t('call.live.joining')
  if (phase === 'handingOff') return t('call.live.handingOff', { assistant: assistantName })
  if (phase === 'talking') return t('call.live.talking')
  if (takenBy) return takenBy
  return t('call.live.onCall', { assistant: assistantName })
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
  const t = useT()
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
                title={session.muted ? t('call.live.unmuteTitle') : t('call.live.muteTitle')}
              >
                {session.muted ? t('call.live.unmute') : t('call.live.mute')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="phone-off"
                onClick={() => void liveSession.leave()}
                title={t('call.live.hangUpTitle')}
              >
                {t('call.live.hangUp')}
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
                title={t('common.withKey', { label: phase === 'listening' ? t('call.live.stopListening') : t('call.live.listenTitle'), key: 'L' })}
                onClick={() => void (phase === 'listening' ? liveSession.leave() : liveSession.listen(call.id))}
              >
                {phase === 'listening' ? t('call.live.stopListening') : t('call.live.listen')}
              </Button>
              {!takenBy && (
                <Button
                  busy={phase === 'handingOff'}
                  size="sm"
                  variant="primary"
                  icon="phone-in"
                  shortcut={['⇧', 'T']}
                  disabled={busy}
                  title={t('common.withKey', {
                    label: t('call.live.takeOverTitle', { assistant: assistantName }),
                    key: '⇧T',
                  })}
                  onClick={() => void liveSession.takeOver(call.id)}
                >
                  {phase === 'handingOff' ? t('call.live.connecting') : t('call.live.takeOver')}
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      {phase === 'talking' && <p className="lvc-note">{t('call.live.notRecorded')}</p>}
      {phase !== 'talking' && lastEvent && <p className="lvc-note">{lastEvent.label}</p>}
      {mine && session.problem && <Note tone="danger">{session.problem}</Note>}
    </section>
  )
}
