// Who an agent talks to in its room. Phone calls and browser test calls have one person in the
// room; in a no-phone call test the other side is our own test-caller agent, which LiveKit Agents
// would otherwise ignore (agents neither wait for nor listen to other agents by default).
import type { JobContext } from '@livekit/agents'
import { ParticipantKind, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node'

/** Participant kinds an agent links its microphone input to; agents only for a test between agents. */
export const ALL_PARTICIPANT_KINDS = [ParticipantKind.STANDARD, ParticipantKind.SIP, ParticipantKind.CONNECTOR, ParticipantKind.AGENT]

/** The first other participant in the room, of any kind, now or once one joins. */
export function waitForCounterpart(ctx: JobContext, identity?: string): Promise<RemoteParticipant> {
  const matches = (p: RemoteParticipant) => !identity || p.identity === identity
  const present = [...ctx.room.remoteParticipants.values()].find(matches)
  if (present) return Promise.resolve(present)
  return new Promise((resolve, reject) => {
    const joined = (p: RemoteParticipant) => {
      if (!matches(p)) return
      stop()
      resolve(p)
    }
    const left = () => {
      stop()
      reject(new Error('the room closed before anyone joined'))
    }
    const stop = () => {
      ctx.room.off(RoomEvent.ParticipantConnected, joined)
      ctx.room.off(RoomEvent.Disconnected, left)
    }
    ctx.room.on(RoomEvent.ParticipantConnected, joined)
    ctx.room.on(RoomEvent.Disconnected, left)
  })
}
