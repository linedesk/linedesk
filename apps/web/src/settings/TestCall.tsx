// "Talk to <assistant>": a test call in the browser, no phone involved. The API signs a LiveKit token
// for a new room (assistant.startTestCall); the voice agent joins it and files the call in the inbox
// as "Test call". The transcript shown here is the call's own, as it syncs in.
import type { TestCallData } from '@callfront/actions'
import { Room, RoomEvent, Track } from 'livekit-client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAssistantName, useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { Section } from './fields.tsx'
import { TEST_CALL_TIMEOUT_MS, TimedOut, testCallErrorText, within } from './testCallModel.ts'

type Phase = 'idle' | 'starting' | 'live' | 'ended'

/** Signs the token through the registry. A read-only action: it is not queued in the outbox. */
async function requestTestCall(): Promise<TestCallData> {
  const res = await fetch('/v1/actions/assistant.startTestCall', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
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
      ? 'Microphone access is blocked. Allow it for this site in the browser, then try again.'
      : 'No microphone found. Connect one, then try again.'
  }
}

/** The call the agent opened for this room, and its transcript, from the local store. */
function useTestCall(room: string | null) {
  const call = useRows('calls').find(c => room !== null && c.room === room)
  const segments = useRows('transcript_segments')
  const lines = useMemo(
    () => (call ? segments.filter(s => s.call_id === call.id).sort((a, b) => a.at_ms - b.at_ms) : []),
    [call, segments],
  )
  const notSetUp = call?.fields.find(f => f.label === 'Not set up')?.value ?? null
  return { call, lines, notSetUp }
}

export function TestCall({ canStart }: { canStart: boolean }) {
  const name = useAssistantName()
  const [phase, setPhase] = useState<Phase>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  const [roomName, setRoomName] = useState<string | null>(null)
  const room = useRef<Room | null>(null)
  const audio = useRef<HTMLDivElement>(null)
  const { call, lines, notSetUp } = useTestCall(roomName)

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
      setProblem(`${name} didn't pick up. The voice service may not be running. Try again in a moment; if it keeps happening, tell whoever runs your Linedesk.`)
      setPhase('idle')
    }, TEST_CALL_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [phase, call, name])

  async function start() {
    const mine = ++attempt.current
    setProblem(null)
    setRoomName(null)
    setPhase('starting')
    // A permission prompt nobody answers (or a microphone the system never hands over) must not hang either.
    const blocked = await within(microphoneAllowed(), TEST_CALL_TIMEOUT_MS).catch(() => "The microphone didn't respond. Allow it for this site, then start the test call again.")
    if (mine !== attempt.current) return
    if (blocked) return fail(blocked)
    const next = new Room()
    try {
      await within((async () => {
        const { url, token, room: joined } = await requestTestCall()
        next.on(RoomEvent.TrackSubscribed, track => {
          if (track.kind === Track.Kind.Audio) audio.current?.append(track.attach())
        })
        next.on(RoomEvent.Disconnected, () => { if (room.current === next) setPhase('ended') })
        await next.connect(url, token)
        await next.localParticipant.setMicrophoneEnabled(true)
        return joined
      })(), TEST_CALL_TIMEOUT_MS).then(joined => {
        if (mine !== attempt.current) return void next.disconnect()
        room.current = next
        setRoomName(joined)
        setPhase('live')
      })
    } catch (e) {
      void next.disconnect()
      if (mine !== attempt.current) return
      fail(e instanceof TimedOut
        ? `Couldn't reach ${name} within ${TEST_CALL_TIMEOUT_MS / 1000} seconds. The voice service may be down. Try again in a moment.`
        : e instanceof Error ? e.message : "The test call couldn't start. Try again in a moment.")
    }
  }

  function fail(text: string) {
    setProblem(text)
    setPhase('idle')
  }

  async function hangUp() {
    const current = room.current
    room.current = null
    await current?.disconnect()
  }

  async function stop() {
    attempt.current++
    await hangUp()
    setPhase('ended')
  }

  function cancel() {
    attempt.current++
    void hangUp()
    setPhase('idle')
  }

  const live = phase === 'live' || phase === 'starting'
  return (
    <Section id="as-test" title={`Talk to ${name}`} description="A test call in the browser, with your microphone. It shows up in the inbox as a test call, with transcript and summary.">
      <div>
        {live ? (
          phase === 'starting'
            ? <span className="st-test-wait"><span className="st-spin" aria-hidden="true" />Connecting…<Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button></span>
            : <Button variant="secondary" onClick={() => void stop()}>End test call</Button>
        ) : (
          <Button variant="primary" icon="phone-in" onClick={() => void start()} disabled={!canStart}>
            {phase === 'ended' ? 'Call again' : 'Start test call'}
          </Button>
        )}
        {!canStart && <span className="help"> Only owners and admins can start a test call.</span>}
      </div>
      {problem && <p className="help" role="alert">{problem}</p>}
      {notSetUp && (
        <p className="help" role="alert">
          {name} can't talk yet: the {notSetUp} service isn't set up. Whoever runs your Linedesk adds it under Admin, Providers.
        </p>
      )}
      {phase === 'live' && !call && <p className="help">Waiting for {name} to answer…</p>}
      {lines.length > 0 && (
        <ol className="help" aria-live="polite" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
          {lines.map(line => (
            <li key={line.id}><b>{line.speaker === 'caller' ? 'You' : line.speaker === 'agent' ? name : 'System'}:</b> {line.text}</li>
          ))}
        </ol>
      )}
      <div ref={audio} hidden />
    </Section>
  )
}
