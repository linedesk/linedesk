// A test call in the browser, no phone involved. The API signs a LiveKit token for a new room
// (assistant.startTestCall); the voice agent joins it and files the call in the inbox as "Test call".
// Settings > Assistant and onboarding show a Start button and the call in a side panel (TestCallPanel).
import { parseVoiceFailure, type TestCallData, VOICE_FAILURE_ATTRIBUTE, voiceFailureText } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import type { Participant, Room } from 'livekit-client'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useVoiceReady } from '../shell/presence.ts'
import { useAssistantName, useRows } from '../store.tsx'
import { useSupportAccess } from '../supportAccess.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Button } from '../ui/kit.tsx'
import '../ui/settings-layout.css'
import { loadLiveKit, preloadNow } from '../call/livekit.ts'
import { microphoneAllowed } from '../call/microphone.ts'
import { useLiveLines } from '../call/useLiveLines.ts'
import {
  agentLeftText,
  noJoinText,
  noPickupText,
  type PickupWatch,
  prepareStart,
  SLOW_JOIN_MS,
  type StartStep,
  TEST_CALL_TIMEOUT_MS,
  TimedOut,
  testCallErrorText,
  watchPickup,
  within,
} from './testCallModel.ts'
import { i18n } from '../i18n/index.tsx'

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

/**
 * One test call with an assistant (default: the workspace's first): its phase, what went wrong, the call as it syncs
 * in, and the controls. `operator`: an instance admin, who is told what to fix on the server when nobody answers.
 */
export function useTestCall(canStart: boolean, assistant?: { id: string; name: string }, operator = false) {
  const t = useT()
  const supportAccess = useSupportAccess()
  const defaultName = useAssistantName()
  const name = assistant?.name ?? defaultName
  const [phase, setPhase] = useState<Phase>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  /** A stage of the assistant's voice pipeline failed during the call (VoiceFailure), in words for this member. */
  const [failure, setFailure] = useState<string | null>(null)
  const [roomName, setRoomName] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  /** What the start is waiting for (phase 'starting'): the microphone, then reaching the assistant. */
  const [step, setStep] = useState<StartStep>('microphone')
  /** The assistant has not joined after a few seconds: still waiting, not failed yet. */
  const [stillConnecting, setStillConnecting] = useState(false)
  const room = useRef<Room | null>(null)
  /** Whether the assistant picks up and stays, for the call in `room`. */
  const pickup = useRef<PickupWatch | null>(null)
  const audio = useRef<HTMLDivElement>(null)
  const { call, lines, notSetUp } = useRoomCall(roomName)
  const live = useLiveLines(lines)
  // Known up front: without the voice service a test call cannot be answered, so it is not offered.
  const voiceDown = useVoiceReady() === false
  /** Bumped by Cancel and by every new start, so a late answer of an abandoned attempt is ignored. */
  const attempt = useRef(0)

  useEffect(
    () => () => {
      pickup.current?.stop()
      void room.current?.disconnect()
    },
    [],
  )

  // A page that offers the test call fetches the call library now, so Start does not wait for its download.
  const offered = canStart && !voiceDown
  useEffect(() => {
    if (offered) preloadNow()
  }, [offered])

  // The call the assistant filed has arrived: it answered.
  useEffect(() => {
    if (call) pickup.current?.heard()
  }, [call])

  function fail(text: string) {
    setProblem(text)
    setPhase('idle')
  }

  async function start() {
    const mine = ++attempt.current
    setProblem(null)
    setFailure(null)
    setRoomName(null)
    setMuted(false)
    setStillConnecting(false)
    live.clear()
    setStep('microphone')
    setPhase('starting')
    const prepared = await prepareStart({
      microphone: microphoneAllowed,
      library: loadLiveKit,
      step: next => {
        if (mine === attempt.current) setStep(next)
      },
    })
    if (mine !== attempt.current) return
    if ('problem' in prepared) return fail(prepared.problem)
    // Reaching the assistant (the request, the room, its join) takes long on a slow network: say so, as when it joins late.
    const slowStart = setTimeout(() => {
      if (mine === attempt.current) setStillConnecting(true)
    }, SLOW_JOIN_MS)
    const { Room, RoomEvent, Track } = prepared.library
    const next = new Room()
    // Connected, but the assistant never picks up or drops out: say so and hang up instead of a silent call.
    const endWith = (text: string, then: Phase) => {
      if (room.current !== next) return
      room.current = null
      void next.disconnect()
      setProblem(text)
      setPhase(then)
    }
    const watch = watchPickup({
      noJoin: () => endWith(noJoinText(name, operator), 'idle'),
      noPickup: () => endWith(noPickupText(name, operator), 'idle'),
      agentLeft: () => endWith(agentLeftText(name, operator), 'ended'),
      // A stopped watch never reports slow again, so an abandoned attempt cannot set it.
      slow: setStillConnecting,
    })
    pickup.current?.stop()
    pickup.current = watch
    const isAgent = (p: Participant) => p.isAgent
    try {
      const joined = await within(
        (async () => {
          const { url, token, room: joined } = await requestTestCall(assistant?.id)
          next.on(RoomEvent.TrackSubscribed, (track, _publication, from) => {
            if (track.kind !== Track.Kind.Audio) return
            audio.current?.append(track.attach())
            if (isAgent(from)) watch.heard()
          })
          next.on(RoomEvent.ParticipantConnected, p => {
            if (isAgent(p)) watch.joined()
          })
          next.on(RoomEvent.ParticipantDisconnected, p => {
            if (isAgent(p)) watch.left()
          })
          // The agent says on itself when its speech to text, model or voice failed: shown at once, and that is
          // the reason, so the no-pickup wait stops.
          next.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
            const failed = isAgent(p) ? parseVoiceFailure(changed[VOICE_FAILURE_ATTRIBUTE]) : null
            if (!failed || room.current !== next) return
            watch.stop()
            setFailure(voiceFailureText(failed, operator, i18n()))
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
            watch.stop()
            if (room.current === next) setPhase('ended')
          })
          await next.connect(url, token)
          // Already in the room before this browser: no ParticipantConnected for it.
          if ([...next.remoteParticipants.values()].some(isAgent)) watch.joined()
          await next.localParticipant.setMicrophoneEnabled(true)
          return joined
        })(),
        TEST_CALL_TIMEOUT_MS,
      )
      clearTimeout(slowStart)
      if (mine !== attempt.current) {
        watch.stop()
        return void next.disconnect()
      }
      room.current = next
      setRoomName(joined)
      // From here the pickup watch says when it is slow.
      setStillConnecting(false)
      setPhase('live')
      watch.start()
    } catch (e) {
      clearTimeout(slowStart)
      setStillConnecting(false)
      watch.stop()
      void next.disconnect()
      if (mine !== attempt.current) return
      fail(
        e instanceof TimedOut
          ? t('settings.testCall.timedOut', { name, seconds: TEST_CALL_TIMEOUT_MS / 1000 })
          : e instanceof Error
            ? e.message
            : t('settings.testCall.couldNotStart'),
      )
    }
  }

  async function hangUp() {
    pickup.current?.stop()
    const current = room.current
    room.current = null
    await current?.disconnect()
  }

  return {
    name,
    phase,
    problem,
    failure,
    notSetUp,
    call,
    lines,
    /** Lines still being spoken, after `lines`. */
    pending: live.pending,
    muted,
    step,
    stillConnecting,
    audio,
    /** Why Start is off, for its tooltip; null when it can start. */
    blockedReason: !canStart
      ? t(supportAccess ? 'settings.testCall.supportAccess' : 'settings.testCall.onlyAdmins')
      : voiceDown
        ? t(operator ? 'settings.testCall.voiceDownOperator' : 'settings.testCall.voiceDown', { name })
        : null,
    /** Start is off only because the voice service isn't set up, and this viewer can set it up: a line may link there. */
    voiceFixable: canStart && voiceDown && operator,
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
      setFailure(null)
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
  const t = useT()
  const busy = session.phase === 'starting' || session.phase === 'live'
  return (
    <span title={session.blockedReason ?? undefined} className="tc-btn-wrap">
      <Button
        variant={variant}
        icon="phone-in"
        onClick={onStart}
        // Fetched once the page offers it; again on intent in case that failed (offline for a moment).
        onPointerEnter={preloadNow}
        onFocus={preloadNow}
        disabled={!!session.blockedReason || busy}
        title={session.blockedReason ? undefined : t('settings.testCall.startTip')}
      >
        {session.phase === 'ended' ? t('settings.testCall.callAgain') : t('settings.testCall.start')}
      </Button>
    </span>
  )
}

/** Where the call's audio plays (hidden). */
export function AudioSink({ target }: { target: RefObject<HTMLDivElement | null> }) {
  return <div ref={target} hidden />
}
