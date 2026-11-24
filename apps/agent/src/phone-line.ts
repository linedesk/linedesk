// When a phone caller can hear the assistant. LiveKit SIP answers the call (200 OK) as soon as the agent's audio is
// subscribed, but the phone network connects the voice path to the caller some hundred ms later: audio sent before that
// is lost, and the caller heard the greeting without its first words ("Hi there,"; LIN-703). On production the carrier's
// audio paused for 0.6-0.7 s after the answer. The caller's own first audio frame is no sign: it arrives at once.
import { ParticipantKind, RoomEvent, TrackKind, type RemoteParticipant, type Room } from '@livekit/rtc-node'

/** How long after the pickup (the agent's audio subscribed) a phone caller's voice path is open. */
export const PHONE_LINE_OPEN_MS = 1000
/** The longest the greeting waits for the open line once it is ready to play (a pickup that never comes). */
export const PHONE_LINE_WAIT_MS = 2500

type LineRoom = Pick<Room, 'on' | 'off'>

/**
 * Resolves PHONE_LINE_OPEN_MS after the agent's audio is subscribed when the caller is on the phone; at once for any
 * other caller (browser test calls, test-caller agents in the room) and when the room closes. Never rejects. Start it
 * before the session starts, so the subscription is not missed.
 */
export function phoneLineOpen(
  room: LineRoom,
  callerJoined: Promise<RemoteParticipant>,
  openMs = PHONE_LINE_OPEN_MS,
): Promise<void> {
  const pickedUp = new Promise<void>(resolve => {
    const subscribed = (track: { kind?: TrackKind }) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return
      stop()
      setTimeout(resolve, openMs)
    }
    const left = () => {
      stop()
      resolve()
    }
    const stop = () => {
      room.off(RoomEvent.LocalTrackSubscribed, subscribed)
      room.off(RoomEvent.Disconnected, left)
    }
    room.on(RoomEvent.LocalTrackSubscribed, subscribed)
    room.on(RoomEvent.Disconnected, left)
  })
  return callerJoined.then(
    caller => (caller.kind === ParticipantKind.SIP ? pickedUp : undefined),
    () => undefined,
  )
}
