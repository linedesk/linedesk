// A test call in the browser, no phone involved. The API signs a LiveKit token for a new room
// (assistant.startTestCall); the voice agent joins it and files the call in the inbox as "Test call".
// Settings > Assistant and onboarding show a Start button and the call in a side panel (TestCallPanel).
import type { TestCallData } from '@linedesk/actions'
import { Room, RoomEvent, Track } from 'livekit-client'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useVoiceReady } from '../shell/presence.ts'
import { useAssistantName, useRows } from '../store.tsx'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Button } from '../ui/kit.tsx'
import '../ui/settings-layout.css'
import { microphoneAllowed } from '../call/microphone.ts'
import { useLiveLines } from '../call/useLiveLines.ts'
import { TEST_CALL_TIMEOUT_MS, TimedOut, testCallErrorText, within } from './testCallModel.ts'

type Phase = 'idle' | 'starting' | 'live' | 'ended'

/** Signs the token through the registry. A read-only action: it is not queued in the outbox. */
async function requestTestCall(assistantId?: string): Promise<TestCallData> {
  const res = await fetch('/v1/actions/assistant.startTestCall', {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(assistantId ? { assistantId } : {}),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: TestCallData } | null
  if (!res.ok || !body?.ok || !body.data) throw new Error(testCallErrorText(body?.error ?? ''))
  return body.data
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
  const live = useLiveLines(lines)
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
    live.clear()
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
          // The browser is the caller here: its own speech is the stream about its own track.
          live.listen(next, (reader, from, room) => {
            const track = reader.info.attributes?.['lk.transcribed_track_id']
            return (
              from.identity === room.localParticipant.identity ||
              (!!track && room.localParticipant.trackPublications.has(track))
            )
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
    /** Lines still being spoken, after `lines`. */
    pending: live.pending,
    muted,
    audio,
    /** Why Start is off, for its tooltip; null when it can start. */
    blockedReason: !canStart
      ? 'Only owners and admins can start a test call'
      : voiceDown
        ? `${name} can't take calls yet: the voice service isn't set up. Ask whoever runs this server.`
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
      live.clear()
      setPhase('idle')
    },
  }
}
export type TestCallSession = ReturnType<typeof useTestCall>

/** Start test call, for a page header. Disabled with the reason in its tooltip. */
export function TestCallButton({
  session,
  variant = 'secondary',
  onStart = session.start,
}: {
  session: TestCallSession
  variant?: 'primary' | 'secondary'
  /** Runs instead of `session.start` (onboarding saves the assistant first, then starts). */
  onStart?: () => void
}) {
  const busy = session.phase === 'starting' || session.phase === 'live'
  return (
    <span title={session.blockedReason ?? undefined} className="tc-btn-wrap">
      <Button
        variant={variant}
        icon="phone-in"
        onClick={onStart}
        disabled={!!session.blockedReason || busy}
        title={session.blockedReason ? undefined : 'Start test call: talk to the assistant with your microphone'}
      >
        {session.phase === 'ended' ? 'Call again' : 'Start test call'}
      </Button>
    </span>
  )
}

/** Where the call's audio plays (hidden). */
export function AudioSink({ target }: { target: RefObject<HTMLDivElement | null> }) {
  return <div ref={target} hidden />
}
