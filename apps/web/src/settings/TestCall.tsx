// A test call in the browser, no phone involved. The API signs a LiveKit token for a new room
// (assistant.startTestCall); the voice agent joins it and files the call in the inbox as "Test call".
// Settings > Assistant shows a Start button in its header and a compact call bar under it; onboarding
// shows the same button, bar and the transcript as it syncs in (TestCall).
import type { TestCallData } from '@linedesk/actions'
import { Room, RoomEvent, Track } from 'livekit-client'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useVoiceReady } from '../shell/presence.ts'
import { useAssistantName, useRows } from '../store.tsx'
import { Button, cx } from '../ui/kit.tsx'
import '../ui/settings-layout.css'
import { TEST_CALL_TIMEOUT_MS, TimedOut, testCallErrorText, within } from './testCallModel.ts'

type Phase = 'idle' | 'starting' | 'live' | 'ended'

/** Signs the token through the registry. A read-only action: it is not queued in the outbox. */
async function requestTestCall(assistantId?: string): Promise<TestCallData> {
  const res = await fetch('/v1/actions/assistant.startTestCall', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(assistantId ? { assistantId } : {}),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: TestCallData } | null
  if (!res.ok || !body?.ok || !body.data) throw new Error(testCallErrorText(body?.error ?? ''))
  return body.data
}

/** Asks for the microphone before anything is created, so a refusal costs nothing. */
async function microphoneAllowed(): Promise<string | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return null
  } catch (e) {
    return e instanceof DOMException && e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow it for this site, then try again.'
      : 'No microphone found. Connect one, then try again.'
  }
}

/** The call the agent opened for this room, and its transcript, from the local store. */
function useRoomCall(room: string | null) {
  const call = useRows('calls').find(c => room !== null && c.room === room)
  const segments = useRows('transcript_segments')
  const lines = useMemo(
    () => (call ? segments.filter(s => s.call_id === call.id).sort((a, b) => a.at_ms - b.at_ms) : []),
    [call, segments],
  )
  const notSetUp = call?.fields.find(f => f.label === 'Not set up')?.value ?? null
  return { call, lines, notSetUp }
}

/** One test call with an assistant (default: the workspace's first): its phase, what went wrong, the call as it syncs in, and the controls. */
export function useTestCall(canStart: boolean, assistant?: { id: string; name: string }) {
  const defaultName = useAssistantName()
  const name = assistant?.name ?? defaultName
  const [phase, setPhase] = useState<Phase>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  const [roomName, setRoomName] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const room = useRef<Room | null>(null)
  const audio = useRef<HTMLDivElement>(null)
  const { call, lines, notSetUp } = useRoomCall(roomName)
  // Known up front: without the voice service a test call cannot be answered, so it is not offered.
  const voiceDown = useVoiceReady() === false
  /** Bumped by Cancel and by every new start, so a late answer of an abandoned attempt is ignored. */
  const attempt = useRef(0)

  useEffect(() => () => void room.current?.disconnect(), [])

  // Connected, but the assistant never picked up: say so instead of waiting forever.
  useEffect(() => {
    if (phase !== 'live' || call) return
    const timer = setTimeout(() => {
      const current = room.current
      room.current = null
      void current?.disconnect()
      setProblem(`${name} didn't pick up. The voice service may not be running. Try again in a moment.`)
      setPhase('idle')
    }, TEST_CALL_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [phase, call, name])

  function fail(text: string) {
    setProblem(text)
    setPhase('idle')
  }

  async function start() {
    const mine = ++attempt.current
    setProblem(null)
    setRoomName(null)
    setMuted(false)
    setPhase('starting')
    // A permission prompt nobody answers must not hang either.
    const blocked = await within(microphoneAllowed(), TEST_CALL_TIMEOUT_MS).catch(
      () => "The microphone didn't respond. Allow it for this site, then try again.",
    )
    if (mine !== attempt.current) return
    if (blocked) return fail(blocked)
    const next = new Room()
    try {
      const joined = await within(
        (async () => {
          const { url, token, room: joined } = await requestTestCall(assistant?.id)
          next.on(RoomEvent.TrackSubscribed, track => {
            if (track.kind === Track.Kind.Audio) audio.current?.append(track.attach())
          })
          next.on(RoomEvent.Disconnected, () => {
            if (room.current === next) setPhase('ended')
          })
          await next.connect(url, token)
          await next.localParticipant.setMicrophoneEnabled(true)
          return joined
        })(),
        TEST_CALL_TIMEOUT_MS,
      )
      if (mine !== attempt.current) return void next.disconnect()
      room.current = next
      setRoomName(joined)
      setPhase('live')
    } catch (e) {
      void next.disconnect()
      if (mine !== attempt.current) return
      fail(
        e instanceof TimedOut
          ? `Couldn't reach ${name} within ${TEST_CALL_TIMEOUT_MS / 1000} seconds. Try again in a moment.`
          : e instanceof Error
            ? e.message
            : "The test call couldn't start. Try again in a moment.",
      )
    }
  }

  async function hangUp() {
    const current = room.current
    room.current = null
    await current?.disconnect()
  }

  return {
    name,
    phase,
    problem,
    notSetUp,
    call,
    lines,
    muted,
    audio,
    /** Why Start is off, for its tooltip; null when it can start. */
    blockedReason: !canStart
      ? 'Only owners and admins can start a test call'
      : voiceDown
        ? `${name} can't take calls yet: the voice service isn't set up. Ask whoever runs your Linedesk.`
        : null,
    start: () => void start(),
    stop: async () => {
      attempt.current++
      await hangUp()
      setPhase('ended')
    },
    cancel: () => {
      attempt.current++
      void hangUp()
      setPhase('idle')
    },
    toggleMute: () => {
      const next = !muted
      setMuted(next)
      void room.current?.localParticipant.setMicrophoneEnabled(!next)
    },
    /** Closes the bar after a call or a problem. */
    dismiss: () => {
      setProblem(null)
      setRoomName(null)
      setPhase('idle')
    },
  }
}
export type TestCallSession = ReturnType<typeof useTestCall>

/** Start test call, for a page header. Disabled with the reason in its tooltip. */
export function TestCallButton({
  session,
  variant = 'secondary',
}: {
  session: TestCallSession
  variant?: 'primary' | 'secondary'
}) {
  const busy = session.phase === 'starting' || session.phase === 'live'
  return (
    <span title={session.blockedReason ?? undefined} className="tc-btn-wrap">
      <Button
        variant={variant}
        icon="phone-in"
        onClick={session.start}
        disabled={!!session.blockedReason || busy}
        title={session.blockedReason ? undefined : 'Start test call: talk to the assistant with your microphone'}
      >
        {session.phase === 'ended' ? 'Call again' : 'Start test call'}
      </Button>
    </span>
  )
}

/** The running call (or what went wrong) in one compact bar: status, mute, hang up. */
export function TestCallBar({ session }: { session: TestCallSession }) {
  const { phase, problem, notSetUp, call, lines, muted, name } = session
  const last = lines.at(-1)
  const status =
    phase === 'starting'
      ? 'Connecting…'
      : phase === 'live'
        ? call
          ? `On a test call with ${name}`
          : `Waiting for ${name} to answer…`
        : phase === 'ended'
          ? 'Test call ended. It is in the inbox.'
          : null
  const message = problem ?? (notSetUp ? `${name} can't talk yet: the ${notSetUp} service isn't set up.` : null)
  return (
    <>
      {(status || message) && (
        <div className={cx('tc-bar', message && 'tc-bar-problem')} role="status" aria-live="polite">
          {phase === 'live' && <span className="tc-live" aria-hidden="true" />}
          {phase === 'starting' && <span className="st-spin" aria-hidden="true" />}
          <span className="tc-text">
            <b>{message ?? status}</b>
            {!message && last && (
              <span className="tc-line">
                {last.speaker === 'caller' ? 'You' : last.speaker === 'agent' ? name : 'System'}: {last.text}
              </span>
            )}
          </span>
          {phase === 'starting' && (
            <Button size="sm" variant="ghost" onClick={session.cancel}>
              Cancel
            </Button>
          )}
          {phase === 'live' && (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={muted ? 'micOff' : 'mic'}
                aria-pressed={muted}
                title={muted ? 'Unmute' : 'Mute'}
                onClick={session.toggleMute}
              />
              <Button size="sm" variant="danger" onClick={() => void session.stop()} title="Hang up">
                Hang up
              </Button>
            </>
          )}
          {(phase === 'ended' || phase === 'idle') && (
            <Button size="sm" variant="ghost" icon="close" title="Close" onClick={session.dismiss} />
          )}
        </div>
      )}
      <AudioSink target={session.audio} />
    </>
  )
}

function AudioSink({ target }: { target: RefObject<HTMLDivElement | null> }) {
  return <div ref={target} hidden />
}

/** For onboarding: the button, the bar and the whole transcript, without a card. */
export function TestCall({ canStart }: { canStart: boolean }) {
  const session = useTestCall(canStart)
  return (
    <div className="st-test-bare">
      <TestCallButton session={session} />
      <TestCallBar session={session} />
      {session.lines.length > 0 && (
        <ol className="tc-transcript" aria-live="polite">
          {session.lines.map(line => (
            <li key={line.id}>
              <b>{line.speaker === 'caller' ? 'You' : line.speaker === 'agent' ? session.name : 'System'}:</b>{' '}
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
