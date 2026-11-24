// Where a call comes from, known before the agent has joined the room, so the call can be registered
// (call.start) while the agent connects instead of after. A test call names its workspace in the job
// metadata; on a phone call the SIP participant is already in the room when the job starts, and
// LiveKit's server API lists it with the caller's and the dialled number.
import { RoomServiceClient } from 'livekit-server-sdk'
import { callOrigin, parseTestMetadata, type CallOrigin } from './call-session.ts'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'

type Participant = { attributes: Record<string, string> }
export type ListParticipants = (room: string) => Promise<Participant[]>

/** The origin of the call in `room`, or null when it cannot be known yet (then it is read after joining). */
export async function earlyOrigin(jobMetadata: string, room: string, list: ListParticipants): Promise<CallOrigin | null> {
  if (parseTestMetadata(jobMetadata)) return callOrigin(jobMetadata, {}, room)
  if (!room) return null
  const sip = (await list(room)).filter(p => p.attributes['sip.phoneNumber'] && p.attributes['sip.trunkPhoneNumber'])
  // Exactly one caller: anything else is left to the normal path after joining.
  return sip.length === 1 ? callOrigin('', sip[0]!.attributes, room) : null
}

export function livekitParticipants(): ListParticipants {
  const livekit = requireLivekitEnv()
  const rooms = new RoomServiceClient(livekitHttpUrl(livekit.LIVEKIT_URL), livekit.LIVEKIT_API_KEY, livekit.LIVEKIT_API_SECRET)
  return room => rooms.listParticipants(room)
}
