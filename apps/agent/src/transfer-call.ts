// Warm transfer with LiveKit: the caller hears ringback while the on-call person is dialled into a
// separate consult room, where a small voice session briefs them and waits for yes/no (voice or keys
// 1/2). On yes the agent bridges the two rooms' audio itself and stays silent; otherwise the consult
// room is closed (which hangs up the on-call phone) and the assistant goes back to the caller.
// Why a bridge and not LiveKit's moveParticipant or SIP REFER: docs/decisions.md (warm transfer).
import { type llm, voice } from '@livekit/agents'
import { type RemoteParticipant, type RemoteTrack, Room, RoomEvent, TrackKind } from '@livekit/rtc-node'
import type { TransferResult } from '@linedesk/actions'
import type { AssistantVoice } from '@linedesk/db/types'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { type Announcement, forwardAudio, playRingback } from './audio-bridge.ts'
import type { AgentConfig } from './config.ts'
import { ALL_PARTICIPANT_KINDS } from './counterpart.ts'
import { livekitHttpUrl } from './env.ts'
import { NotAnsweredError, type OnCallDialer } from './on-call-dialer.ts'
import { createStt, createTts } from './pipeline.ts'
import { type Answer, answerOf, answerOfDigit, DECISION_MS } from './transfer.ts'

export const ON_CALL_IDENTITY = 'on-call'
const TRANSFER_AGENT_IDENTITY = 'linedesk-transfer'

export type Livekit = { url: string; apiKey: string; apiSecret: string }

export interface TransferSetup {
  livekit: Livekit
  /** The caller's room (the job's room) and the caller in it. */
  callerRoom: Room
  callerIdentity: string
  dialer: OnCallDialer
  config: AgentConfig
  voice?: AssistantVoice | null
  /** Said to the caller before the ringback ("I'm connecting you…"). */
  announcement?: Announcement
}

/** What happened; `connected` comes with the bridge, which ends the call when the on-call person hangs up. */
export type TransferOutcome = { result: TransferResult }

/** The consult session hears the on-call person but never answers them: no LLM, every turn stops here. */
class ConsultAgent extends voice.Agent {
  heard: (text: string) => void = () => {}

  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    this.heard(message.textContent ?? '')
    throw new voice.StopResponse()
  }
}

async function joinConsultRoom({ url, apiKey, apiSecret }: Livekit, name: string): Promise<Room> {
  const token = new AccessToken(apiKey, apiSecret, { identity: TRANSFER_AGENT_IDENTITY, name: 'Linedesk' })
  token.kind = 'agent'
  token.addGrant({ roomJoin: true, room: name, canPublish: true, canSubscribe: true })
  const room = new Room()
  await room.connect(url, await token.toJwt())
  return room
}

/**
 * Says the briefing (twice at most) and waits for a yes or no by voice or key; null: no decision.
 * Only what comes after the briefing has played counts: a voicemail greeting talking over it, or a
 * key pressed before the question, is no answer. The briefing cannot be interrupted.
 */
async function decide(
  session: voice.AgentSession,
  agent: ConsultAgent,
  room: Room,
  briefing: string,
  signal: AbortSignal,
): Promise<Answer | null> {
  let settle: (answer: Answer | null) => void = () => {}
  const decided = new Promise<Answer | null>(resolve => {
    settle = resolve
  })
  let asked = false
  agent.heard = text => {
    const answer = asked ? answerOf(text) : null
    if (answer) settle(answer)
  }
  const onDigit = (_code: number, digit: string, participant: RemoteParticipant) => {
    const answer = asked && participant.identity === ON_CALL_IDENTITY ? answerOfDigit(digit) : null
    if (answer) settle(answer)
  }
  const onLeft = (participant: RemoteParticipant) => {
    if (participant.identity === ON_CALL_IDENTITY) settle(null)
  }
  room.on(RoomEvent.DtmfReceived, onDigit)
  room.on(RoomEvent.ParticipantDisconnected, onLeft)
  signal.addEventListener('abort', () => settle(null), { once: true })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      asked = false
      const speech = session.say(briefing, { allowInterruptions: false })
      const timeout = speech.waitForPlayout().then(() => {
        asked = true
        return new Promise<null>(resolve => setTimeout(() => resolve(null), DECISION_MS))
      })
      const answer = await Promise.race([decided, timeout])
      if (answer) return answer
      if (signal.aborted) return null
    }
    return null
  } finally {
    room.off(RoomEvent.DtmfReceived, onDigit)
    room.off(RoomEvent.ParticipantDisconnected, onLeft)
  }
}

function audioTrackOf(room: Room, identity: string): RemoteTrack | null {
  const participant = room.remoteParticipants.get(identity)
  for (const publication of participant?.trackPublications.values() ?? []) {
    if (publication.track?.kind === TrackKind.KIND_AUDIO) return publication.track
  }
  return null
}

/** The participant's audio track, now or once it is subscribed. */
function waitForAudio(room: Room, identity: string, timeoutMs = 10_000): Promise<RemoteTrack> {
  const present = audioTrackOf(room, identity)
  if (present) return Promise.resolve(present)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.off(RoomEvent.TrackSubscribed, onTrack)
      reject(new Error(`no audio from ${identity}`))
    }, timeoutMs)
    const onTrack = (track: RemoteTrack, _publication: unknown, participant: RemoteParticipant) => {
      if (participant.identity !== identity || track.kind !== TrackKind.KIND_AUDIO) return
      clearTimeout(timer)
      room.off(RoomEvent.TrackSubscribed, onTrack)
      resolve(track)
    }
    room.on(RoomEvent.TrackSubscribed, onTrack)
  })
}

/**
 * Runs one warm transfer. `briefing` is what the on-call person hears. `signal` aborts when the caller
 * hangs up. `onBridgeEnded` runs when a connected call ends on the on-call side (they hung up).
 * Cleans up after itself except for a connected bridge, which `addCleanup` registers for shutdown.
 */
export async function warmTransfer(
  setup: TransferSetup,
  briefing: string,
  signal: AbortSignal,
  hooks: {
    onBridgeEnded: () => void
    addCleanup: (cleanup: () => Promise<void>) => void
    /**
     * Runs once the on-call person said yes, before anyone is put through: stops the recording, so the
     * conversation with the on-call person is not recorded. If it rejects, the call is not put through.
     */
    onConnecting?: () => Promise<void>
  },
): Promise<TransferOutcome> {
  const { livekit, callerRoom, callerIdentity } = setup
  const consultName = `${callerRoom.name}-oncall`
  const rooms = new RoomServiceClient(livekitHttpUrl(livekit.url), livekit.apiKey, livekit.apiSecret)
  // Deleting the consult room hangs up the on-call phone, whatever state the dial is in.
  const closeConsult = async (room: Room | null) => {
    await rooms.deleteRoom(consultName).catch(() => {})
    await room?.disconnect().catch(() => {})
  }
  const stopRingback = await playRingback(callerRoom, setup.announcement)
  let consult: Room | null = null
  let session: voice.AgentSession | null = null
  let connected = false
  let farewell: string | null = null
  // Whatever happens to this job, the on-call leg ends with it: registered before anything is dialled.
  hooks.addCleanup(() => closeConsult(consult))
  try {
    consult = await joinConsultRoom(livekit, consultName)
    await setup.dialer.dial({ room: consultName, identity: ON_CALL_IDENTITY, signal })
    if (signal.aborted) return { result: 'not_answered' }

    const agent = new ConsultAgent({ instructions: 'You brief the on-call person about an urgent call.' })
    session = new voice.AgentSession({
      vad: null,
      stt: createStt(setup.config.stt),
      tts: createTts(setup.config.tts, setup.voice),
      turnHandling: {
        turnDetection: setup.config.stt.model.startsWith('flux') ? 'stt' : undefined,
        preemptiveGeneration: { enabled: false },
      },
    })
    await session.start({
      agent,
      room: consult,
      inputOptions: {
        participantIdentity: ON_CALL_IDENTITY,
        participantKinds: ALL_PARTICIPANT_KINDS,
        closeOnDisconnect: false,
      },
    })
    const answer = await decide(session, agent, consult, briefing, signal)
    if (answer !== 'yes' || signal.aborted) {
      if (answer === 'no') farewell = "Okay, I'll take a message for the team."
      return { result: answer === 'no' ? 'declined' : 'not_answered' }
    }
    // Fail closed: a recording that cannot be stopped means no bridge; the assistant takes a message.
    try {
      await hooks.onConnecting?.()
    } catch (e) {
      console.warn(
        `not putting the call through, the recording could not be stopped: ${e instanceof Error ? e.message : String(e)}`,
      )
      farewell = "Sorry, I can't put the call through right now. The team will get a message."
      return { result: 'failed' }
    }

    await session.say('Connecting you now.').waitForPlayout()
    await session.close()
    session = null
    await stopRingback()
    const onCallTrack = await waitForAudio(consult, ON_CALL_IDENTITY)
    const callerTrack = await waitForAudio(callerRoom, callerIdentity)
    const stopToCaller = await forwardAudio(onCallTrack, callerRoom, 'on-call')
    const stopToOnCall = await forwardAudio(callerTrack, consult, 'caller')
    const bridged = consult
    const end = async () => {
      await stopToCaller()
      await stopToOnCall()
      await closeConsult(bridged)
    }
    bridged.on(RoomEvent.ParticipantDisconnected, participant => {
      if (participant.identity === ON_CALL_IDENTITY) hooks.onBridgeEnded()
    })
    hooks.addCleanup(end)
    connected = true
    return { result: 'connected' }
  } catch (e) {
    if (e instanceof NotAnsweredError || signal.aborted) return { result: 'not_answered' }
    console.warn(`warm transfer failed: ${e instanceof Error ? e.message : String(e)}`)
    return { result: 'failed' }
  } finally {
    if (!connected) {
      // The caller gets the assistant back at once; the on-call side is wound down meanwhile.
      await stopRingback()
      void windDown(session, farewell).finally(() => closeConsult(consult))
    }
  }
}

/** Says a last line to the on-call person (if any), then closes the consult session. Never rejects. */
async function windDown(session: voice.AgentSession | null, farewell: string | null) {
  if (!session) return
  if (farewell)
    await session
      .say(farewell)
      .waitForPlayout()
      .catch(() => {})
  await session.close().catch(() => {})
}
