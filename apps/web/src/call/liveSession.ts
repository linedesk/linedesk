// Listening in to a live call and taking it over (call.listen, call.takeOver). One session per tab, kept
// outside the call view: moving to another call or view keeps the audio, so a member who took a call over
// never drops the caller by pressing J. The API signs a short-lived LiveKit token for the call's room;
// listening can only hear. Taking over joins with the microphone off and turns it on once the assistant
// has told the caller and left the conversation (it says so in HAND_OFF_ATTRIBUTE on itself).
import { HAND_OFF_ATTRIBUTE, type HandOff, type LiveCallJoin } from '@linedesk/actions'
import { type Participant, Room, RoomEvent, type TextStreamReader, Track } from 'livekit-client'
import { useSyncExternalStore } from 'react'
import type { LiveSpeaker } from '../settings/liveTranscript.ts'
import { TRANSCRIPTION_TOPIC } from '../settings/liveTranscript.ts'
import { TimedOut, within } from '../settings/testCallModel.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { microphoneAllowed } from './microphone.ts'
import { transcribesOthers } from './useLiveLines.ts'

export type LivePhase = 'idle' | 'joining' | 'listening' | 'handingOff' | 'talking'
export type LiveSession = {
  /** The call this tab listens to or talks on; null when idle. */
  callId: string | null
  phase: LivePhase
  problem: string | null
  muted: boolean
}

const JOIN_TIMEOUT_MS = 15_000
const REFUSED = "The assistant couldn't hand this call over right now. Try again in a moment."
/** How long the assistant may take to say the hand-over line and leave the conversation. */
const HAND_OFF_TIMEOUT_MS = 20_000

let state: LiveSession = { callId: null, phase: 'idle', problem: null, muted: false }
const listeners = new Set<() => void>()
let room: Room | null = null
/** Bumped by every start and stop, so a late answer of an abandoned attempt is ignored. */
let attempt = 0
/** Where the room's transcription streams go while a call view shows them. */
let streamSink: ((reader: TextStreamReader, speaker: LiveSpeaker) => void) | null = null
let audioSink: HTMLDivElement | null = null

// Closing or reloading the tab while talking would hang up on the caller: the browser asks first.
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', e => {
    if (state.phase === 'talking') e.preventDefault()
  })

function update(next: Partial<LiveSession>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** The call's audio plays from a hidden element of the page itself, not of a view that may unmount. */
function sink(): HTMLDivElement {
  if (!audioSink) {
    audioSink = document.createElement('div')
    audioSink.hidden = true
    document.body.append(audioSink)
  }
  return audioSink
}

/** The server's refusal in plain words; LiveKit and other internals stay out. */
function joinErrorText(error: string): string {
  if (/not set up|not configured/i.test(error))
    return "Listening in isn't set up on this server yet. Ask whoever runs your Linedesk."
  if (/ended|not found/i.test(error)) return 'This call has ended.'
  if (/already took|putting this call through|signed-in member|member of the workspace/i.test(error)) return error
  return "Couldn't join the call. Try again in a moment."
}

async function requestJoin(action: 'call.listen' | 'call.takeOver', callId: string): Promise<LiveCallJoin> {
  const res = await fetch(`/v1/actions/${action}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ callId }),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: LiveCallJoin } | null
  if (!res.ok || !body?.ok || !body.data) throw new Error(joinErrorText(body?.error ?? ''))
  return body.data
}

async function connect(join: LiveCallJoin): Promise<Room> {
  const next = new Room()
  next.on(RoomEvent.TrackSubscribed, track => {
    if (track.kind === Track.Kind.Audio) sink().append(track.attach())
  })
  next.on(RoomEvent.TrackUnsubscribed, track => {
    for (const element of track.detach()) element.remove()
  })
  next.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader, from) =>
    streamSink?.(reader, transcribesOthers(reader, from, next) ? 'caller' : 'agent'),
  )
  // The call ended (the room closed) or the connection is gone for good.
  next.on(RoomEvent.Disconnected, () => {
    if (room !== next) return
    room = null
    // Removed while waiting for the hand-over: the assistant could not hand the call over.
    if (state.phase === 'handingOff') {
      attempt++
      return update({ phase: 'idle', muted: false, problem: REFUSED })
    }
    update({ callId: null, phase: 'idle', muted: false })
  })
  try {
    await next.connect(join.url, join.token)
  } catch (e) {
    void next.disconnect()
    throw e
  }
  await next.startAudio().catch(() => {})
  return next
}

/** Leaves the room without touching the state. */
async function drop() {
  const current = room
  room = null
  for (const element of Array.from(audioSink?.children ?? [])) element.remove()
  await current?.disconnect()
}

function fail(e: unknown, mine: number) {
  if (mine !== attempt) return
  void drop()
  const problem =
    e instanceof TimedOut
      ? "Couldn't reach the call. Try again in a moment."
      : e instanceof Error
        ? e.message
        : "Couldn't join the call."
  update({ phase: 'idle', problem })
}

/** Starts listening to a call (any call listened to or talked on before is left). */
async function listen(callId: string) {
  const mine = ++attempt
  await drop()
  update({ callId, phase: 'joining', problem: null, muted: false })
  try {
    const next = await within(requestJoin('call.listen', callId).then(connect), JOIN_TIMEOUT_MS)
    if (mine !== attempt) return void next.disconnect()
    room = next
    update({ phase: 'listening' })
  } catch (e) {
    fail(e, mine)
  }
}

/** What the assistant says on itself for this connection: ready (talk now) or refused. */
function handOffOf(participant: Participant, ownSid: string): HandOff | null {
  const [sid, value] = (participant.attributes[HAND_OFF_ATTRIBUTE] ?? '').split(':')
  return sid === ownSid && (value === 'ready' || value === 'refused') ? value : null
}

/** Waits until the assistant has handed the call over (or refused); TimedOut when it never says. */
function handOff(next: Room): Promise<HandOff> {
  const ownSid = next.localParticipant.sid
  const now = [...next.remoteParticipants.values()].map(p => handOffOf(p, ownSid)).find(Boolean)
  if (now) return Promise.resolve(now)
  return within(
    new Promise<HandOff>(resolve => {
      const onChanged = (_changed: Record<string, string>, participant: Participant) => {
        const value = handOffOf(participant, ownSid)
        if (!value) return
        next.off(RoomEvent.ParticipantAttributesChanged, onChanged)
        resolve(value)
      }
      next.on(RoomEvent.ParticipantAttributesChanged, onChanged)
    }),
    HAND_OFF_TIMEOUT_MS,
  )
}

/** Takes the call over: the microphone first (a refusal costs nothing), then the token, then the hand-over. */
async function takeOver(callId: string) {
  const mine = ++attempt
  update({ callId, phase: 'joining', problem: null, muted: false })
  try {
    const blocked = await within(microphoneAllowed(), JOIN_TIMEOUT_MS)
    if (blocked) throw new Error(blocked)
    const join = await within(requestJoin('call.takeOver', callId), JOIN_TIMEOUT_MS)
    if (mine !== attempt) return
    // Keeps hearing the call until the take-over can join.
    await drop()
    const next = await within(connect(join), JOIN_TIMEOUT_MS)
    if (mine !== attempt) return void next.disconnect()
    room = next
    update({ phase: 'handingOff' })
    const answer = await handOff(next).catch(e => {
      throw e instanceof TimedOut ? new Error("The assistant didn't hand the call over. Try again.") : e
    })
    if (mine !== attempt) return
    if (answer === 'refused') throw new Error(REFUSED)
    await next.localParticipant.setMicrophoneEnabled(true)
    update({ phase: 'talking' })
  } catch (e) {
    fail(e, mine)
  }
}

/** Stops listening, or hangs up after taking over (which ends the call for the caller too). */
async function leave() {
  attempt++
  await drop()
  update({ callId: null, phase: 'idle', problem: null, muted: false })
}

function toggleMute() {
  if (state.phase !== 'talking' || !room) return
  const muted = !state.muted
  update({ muted })
  void room.localParticipant.setMicrophoneEnabled(!muted)
}

/** Clears a problem shown for `callId`. */
function dismiss() {
  update({ problem: null })
}

/** A call view sends the streams it shows to its live lines while mounted; returns how to stop. */
function showStreams(read: (reader: TextStreamReader, speaker: LiveSpeaker) => void): () => void {
  streamSink = read
  return () => {
    if (streamSink === read) streamSink = null
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const liveSession = { listen, takeOver, leave, toggleMute, dismiss, showStreams }

/** This tab's live session. */
export function useLiveSession(): LiveSession {
  return useSyncExternalStore(subscribe, () => state)
}
