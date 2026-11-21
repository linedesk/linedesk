// When a phone caller can hear the assistant. LiveKit SIP answers the call (200 OK) as soon as the agent's audio is
// subscribed, but the phone network opens the voice path to the caller some hundred ms later: audio sent before that is
// lost, and the caller heard the greeting without its first words ("Hi there,"). The caller's own first audio packet
// shows that the path is open; the greeting waits for it, at most CALLER_AUDIO_WAIT_MS.
import {
  AudioStream,
  ParticipantKind,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node'

/** The longest the greeting waits for the caller's first audio after it is ready to play. */
export const CALLER_AUDIO_WAIT_MS = 1500

type AudioRoom = Pick<Room, 'on' | 'off'>
type Frames = { getReader(): { read(): Promise<unknown>; cancel(): Promise<void> } }

/**
 * Resolves when the first audio frame of a phone caller arrives; at once for any other caller (browser test calls,
 * test-caller agents: their audio path is open when they join). Never rejects.
 */
export function callerAudioOpen(
  room: AudioRoom,
  callerJoined: Promise<RemoteParticipant>,
  framesOf: (track: RemoteTrack) => Frames = track => new AudioStream(track, 16_000, 1),
): Promise<void> {
  return callerJoined.then(
    caller => (caller.kind === ParticipantKind.SIP ? firstFrame(room, caller, framesOf) : undefined),
    () => undefined,
  )
}

function firstFrame(room: AudioRoom, caller: RemoteParticipant, framesOf: (track: RemoteTrack) => Frames) {
  return new Promise<void>(resolve => {
    let reading = false
    const read = (track: RemoteTrack | undefined) => {
      if (reading || !track || track.kind !== TrackKind.KIND_AUDIO) return
      reading = true
      stop()
      const reader = framesOf(track).getReader()
      void reader
        .read()
        .catch(() => {})
        .then(() => {
          resolve()
          void reader.cancel().catch(() => {})
        })
    }
    const subscribed = (track: RemoteTrack, _publication: unknown, participant: RemoteParticipant) => {
      if (participant.identity === caller.identity) read(track)
    }
    const left = () => {
      stop()
      resolve()
    }
    const stop = () => {
      room.off(RoomEvent.TrackSubscribed, subscribed)
      room.off(RoomEvent.Disconnected, left)
    }
    room.on(RoomEvent.TrackSubscribed, subscribed)
    room.on(RoomEvent.Disconnected, left)
    for (const publication of caller.trackPublications.values()) read(publication.track as RemoteTrack | undefined)
  })
}
