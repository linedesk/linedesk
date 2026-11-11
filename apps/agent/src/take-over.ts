// A member takes the call over from the web app (call.takeOver): they join the room with a token the API
// signed, carrying their name in TAKE_OVER_ATTRIBUTE. The assistant stops the recording (the conversation
// with a person is not recorded, as after a warm transfer), tells the caller who takes over and leaves the
// conversation: it no longer hears the caller and no longer speaks. Only then does it grant the member
// microphone publishing (their token cannot publish) and say so (HAND_OFF_ATTRIBUTE), and the browser turns
// the microphone on. A member who cannot take over is told and removed from the room. The call ends when the
// member or the caller hangs up.
import { HAND_OFF_ATTRIBUTE, type HandOff, TAKE_OVER_ATTRIBUTE } from '@linedesk/actions'
import type { voice } from '@livekit/agents'
import { DisconnectReason, type RemoteParticipant, type Room, RoomEvent } from '@livekit/rtc-node'
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import type { CallLog } from './call-log.ts'
import { livekitHttpUrl, requireLivekitEnv } from './env.ts'

/** Identities the API gives take-over tokens (apps/api/src/live-call.ts). */
const TAKE_OVER_PREFIX = 'takeover-'
/** How long the call waits for a member whose connection dropped (not hung up) before it ends. */
export const REJOIN_GRACE_MS = 15_000

/** What the caller hears before the member speaks. */
export const takeOverLine = (name: string) => `I'm putting you through to ${name} now.`

/** The member's name when this participant took the call over; null for anyone else. */
export function takeOverName(participant: Pick<RemoteParticipant, 'identity' | 'attributes'>): string | null {
  if (!participant.identity.startsWith(TAKE_OVER_PREFIX)) return null
  const name = participant.attributes?.[TAKE_OVER_ATTRIBUTE]?.trim()
  return name ? name : null
}

/** How long the member's browser gets to read `refused` before it is removed from the room. */
const REMOVE_AFTER_MS = 1500

/** What the agent changes on the member through LiveKit's server API. */
export type Members = {
  /** Lets the member publish their microphone, and nothing else. */
  grantMicrophone: (identity: string) => Promise<void>
  remove: (identity: string) => Promise<void>
}

export function livekitMembers(room: string): Members {
  const env = requireLivekitEnv()
  const rooms = new RoomServiceClient(livekitHttpUrl(env.LIVEKIT_URL), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
  return {
    grantMicrophone: async identity => {
      // Permissions are replaced as a whole: everything the token gave, plus the microphone.
      await rooms.updateParticipant(room, identity, {
        permission: {
          canSubscribe: true,
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canPublishData: false,
          canUpdateMetadata: false,
          hidden: false,
        },
      })
    },
    remove: identity => rooms.removeParticipant(room, identity),
  }
}

/** The value of HAND_OFF_ATTRIBUTE for one connection of the member: their browser reads only its own. */
export const handOffValue = (participantSid: string, state: HandOff) => `${participantSid}:${state}`

type Deps = {
  room: Room
  session: voice.AgentSession
  log: CallLog
  /** Stops the recording; rejects when it could not be stopped (then nobody takes over). */
  stopRecording: () => Promise<void>
  /** Says a line the caller cannot interrupt; resolves once it has played. */
  sayLine: (text: string) => Promise<void>
  /** Ends the call for everyone. */
  endCall: () => void
  members?: Members
}

/** Hands the call to the first member who takes it over; returns how to stop watching. */
export function watchTakeOver({
  room,
  session,
  log,
  stopRecording,
  sayLine,
  endCall,
  members = livekitMembers(room.name ?? ''),
}: Deps): () => void {
  let member: string | null = null
  let busy = false
  let leftTimer: ReturnType<typeof setTimeout> | null = null
  const tell = (participant: RemoteParticipant, state: HandOff) =>
    room.localParticipant
      ?.setAttributes({ [HAND_OFF_ATTRIBUTE]: handOffValue(participant.sid ?? '', state) })
      .catch(e =>
        console.warn(`could not tell the member about the take-over: ${e instanceof Error ? e.message : String(e)}`),
      )
  const warn = (what: string) => (e: unknown) =>
    console.warn(`take-over: could not ${what}: ${e instanceof Error ? e.message : String(e)}`)
  /** Tells the member's browser, then removes them: a modified browser cannot stay and listen either. */
  const refuse = (participant: RemoteParticipant) => {
    void tell(participant, 'refused')
    setTimeout(() => void members.remove(participant.identity).catch(warn('remove the member')), REMOVE_AFTER_MS)
  }
  /** Grants the microphone, then tells the browser it may turn it on. */
  const admit = async (participant: RemoteParticipant) => {
    await members.grantMicrophone(participant.identity)
    void tell(participant, 'ready')
  }

  async function handOver(participant: RemoteParticipant, name: string) {
    busy = true
    // Stops whatever the assistant is saying, even a line it says without interruptions.
    try {
      session.interrupt({ force: true }).await.catch(() => {})
    } catch {
      // The session is closing: the caller hung up.
    }
    session.input.setAudioEnabled(false)
    try {
      await stopRecording()
    } catch (e) {
      console.warn(
        `call not taken over, the recording could not be stopped: ${e instanceof Error ? e.message : String(e)}`,
      )
      session.input.setAudioEnabled(true)
      busy = false
      return refuse(participant)
    }
    // Said through the session, so it reaches the transcript like the assistant's other lines.
    await sayLine(takeOverLine(name)).catch(() => {})
    session.output.setAudioEnabled(false)
    // Like a connected transfer: neither silence nor the assistant's time limit ends the call now.
    log.transferred = true
    log.record('system', `${name} took the call over`)
    member = participant.identity
    // Without the microphone the member cannot speak: end the call rather than leave the caller in silence.
    await admit(participant).catch(e => {
      warn('grant the microphone')(e)
      endCall()
    })
  }

  const onJoined = (participant: RemoteParticipant) => {
    const name = takeOverName(participant)
    if (!name) return
    if (member === participant.identity) {
      // The same member back after a dropped connection.
      if (leftTimer) clearTimeout(leftTimer)
      leftTimer = null
      return void admit(participant).catch(warn('grant the microphone again'))
    }
    // Someone else took it over, a warm transfer is connected, or a hand-over is under way.
    if (member || busy || log.transferred) return refuse(participant)
    void handOver(participant, name)
  }
  const onLeft = (participant: RemoteParticipant) => {
    if (participant.identity !== member) return
    // Hung up in the browser: the call ends now. A dropped connection gets a moment to come back.
    if (participant.disconnectReason === DisconnectReason.CLIENT_INITIATED) return endCall()
    leftTimer = setTimeout(endCall, REJOIN_GRACE_MS)
  }

  room.on(RoomEvent.ParticipantConnected, onJoined)
  room.on(RoomEvent.ParticipantDisconnected, onLeft)
  for (const participant of room.remoteParticipants.values()) onJoined(participant)
  return () => {
    room.off(RoomEvent.ParticipantConnected, onJoined)
    room.off(RoomEvent.ParticipantDisconnected, onLeft)
    if (leftTimer) clearTimeout(leftTimer)
  }
}
