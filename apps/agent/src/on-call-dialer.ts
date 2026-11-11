// Who picks up when the assistant puts a call through: the on-call phone over the LiveKit SIP
// outbound trunk, or, in a no-phone call test, a simulated on-call person in the same consult room.
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node'
import { CALL_MAX_MINUTES } from '@linedesk/actions'
import { AccessToken } from 'livekit-server-sdk'
import type { SipClient } from 'livekit-server-sdk'
import type { AgentConfig } from './config.ts'
import { type GreetingAudio, synthesize } from './greeting-cache.ts'
import { createTts } from './pipeline.ts'
import { rms } from './test-caller/latency.ts'
import { RING_SECONDS } from './transfer.ts'

export type DialRequest = { room: string; identity: string; signal: AbortSignal }

/** Puts the on-call person into the consult room; resolves once they answered, rejects when nobody did. */
export interface OnCallDialer {
  dial(request: DialRequest): Promise<void>
}

/** The on-call phone was not answered (rang out, busy, refused). */
export class NotAnsweredError extends Error {}

/** Rejects when the signal aborts (the caller hung up while it rang). */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('dial cancelled'))
    signal.addEventListener('abort', () => reject(new Error('dial cancelled')), { once: true })
  })

/** A transferred call never lasts longer than this on the on-call side: the longest any call lasts. */
const MAX_TRANSFER_SEC = CALL_MAX_MINUTES * 60

/** Dials the on-call number through the outbound trunk, showing the business's Linedesk number. */
export function sipDialer({
  sip,
  trunkId,
  to,
  from,
}: {
  sip: SipClient
  trunkId: string
  to: string
  from?: string
}): OnCallDialer {
  return {
    async dial({ room, identity, signal }) {
      if (signal.aborted) throw new NotAnsweredError('cancelled before dialling')
      // The SIP request cannot be cancelled; the caller of dial deletes the consult room, which ends the leg.
      const dialled = sip.createSipParticipant(trunkId, to, room, {
        participantIdentity: identity,
        participantName: 'On call',
        ...(from ? { fromNumber: from } : {}),
        waitUntilAnswered: true,
        ringingTimeout: RING_SECONDS,
        maxCallDuration: MAX_TRANSFER_SEC,
        timeout: RING_SECONDS + 10,
      })
      try {
        await Promise.race([dialled, aborted(signal)])
      } catch (e) {
        void dialled.catch(() => {})
        throw new NotAnsweredError(e instanceof Error ? e.message : String(e))
      }
    },
  }
}

/** What the simulated on-call person does: take the call, say no (key 2), or let it ring out. */
export type SimulatedAnswer = 'accept' | 'decline' | 'no-answer'
export const simulatedAnswers: readonly SimulatedAnswer[] = ['accept', 'decline', 'no-answer']

type Livekit = { url: string; apiKey: string; apiSecret: string }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('dial cancelled'))
      },
      { once: true },
    )
  })

/** Waits until the other side has spoken and then been quiet for `quietMs`. */
async function untilTheyStopTalking(stream: AsyncIterator<AudioFrame>, quietMs = 1200) {
  let heard = false
  let lastLoud = 0
  for (;;) {
    const { value: frame, done } = await stream.next()
    if (done) return
    const now = Date.now()
    if (rms(frame.data) > 500) {
      heard = true
      lastLoud = now
    } else if (heard && now - lastLoud >= quietMs) return
  }
}

/**
 * A simulated on-call person for the no-phone call test: joins the consult room as the participant
 * the transfer waits for, listens to the briefing and answers by voice ("yes") or with key 2. After
 * taking the call it says a few words to the caller and hangs up, which ends the call.
 */
export function simulatedDialer(answer: SimulatedAnswer, livekit: Livekit, config: AgentConfig): OnCallDialer {
  return {
    async dial({ room: roomName, identity, signal }) {
      if (answer === 'no-answer') {
        await sleep(RING_SECONDS * 1000, signal)
        throw new NotAnsweredError('the simulated on-call phone rang out')
      }
      // Said with the test caller's voice, made before joining: the track's rate is the voice's.
      const lines = await onCallLines(config, answer)
      const token = new AccessToken(livekit.apiKey, livekit.apiSecret, { identity, name: 'On call (simulated)' })
      token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
      const room = new Room()
      await room.connect(livekit.url, await token.toJwt())
      if (signal.aborted) {
        await room.disconnect()
        throw new NotAnsweredError('cancelled while dialling')
      }
      const source = await publishVoice(room, lines)
      void actOnCall(room, source, answer, lines, { hangUp: () => room.disconnect() }).catch(e =>
        console.warn(`simulated on-call person: ${e instanceof Error ? e.message : String(e)}`),
      )
    },
  }
}

const ACCEPT_LINE = 'Yes, put them through.'
/** What the on-call person says once put through; distinctive, so the caller's transcript proves the bridge. */
export const GREETING_LINE =
  "Hi, this is Mike, the on-call plumber. I'm on my way and will be there in about thirty minutes. Bye for now."

/** The on-call person's lines in the test caller's voice: "yes" and the greeting when accepting, else none. */
export function onCallLines(config: AgentConfig, answer: SimulatedAnswer): Promise<GreetingAudio[]> {
  return Promise.all((answer === 'accept' ? [ACCEPT_LINE, GREETING_LINE] : []).map(text => voiceOf(config, text)))
}

/** Publishes the on-call person's microphone in the room, at the rate of their voice. */
export async function publishVoice(room: Room, lines: GreetingAudio[]): Promise<AudioSource> {
  const source = new AudioSource(lines[0]?.sampleRate ?? 24_000, lines[0]?.channels ?? 1)
  await room.localParticipant!.publishTrack(
    LocalAudioTrack.createAudioTrack('phone', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  )
  return source
}

function voiceOf(config: AgentConfig, text: string): Promise<GreetingAudio> {
  const voiceId = process.env.TEST_CALLER_VOICE_ID
  return synthesize(createTts(config.tts, voiceId ? { provider: config.tts.provider, voice_id: voiceId } : null), text)
}

export async function speak(source: AudioSource, audio: GreetingAudio) {
  const perFrame = (audio.sampleRate / 50) * audio.channels
  for (let at = 0; at < audio.samples.length; at += perFrame) {
    const chunk = audio.samples.slice(at, at + perFrame)
    await source.captureFrame(new AudioFrame(chunk, audio.sampleRate, audio.channels, chunk.length / audio.channels))
  }
  await source.waitForPlayout()
}

function firstAudioTrack(room: Room): Promise<RemoteTrack> {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values())
      if (publication.track?.kind === TrackKind.KIND_AUDIO) return Promise.resolve(publication.track)
  }
  return new Promise(resolve => {
    const onTrack = (track: RemoteTrack, _p: unknown, _participant: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return
      room.off(RoomEvent.TrackSubscribed, onTrack)
      resolve(track)
    }
    room.on(RoomEvent.TrackSubscribed, onTrack)
  })
}

/**
 * Listens to the briefing, then answers: key 2 to decline; to accept "yes" (and key 1 with `pressOne`,
 * for a phone line where speech recognition may miss it), then after "Connecting you now." the greeting,
 * then `hangUp`. No answer: stays silent.
 */
export async function actOnCall(
  room: Room,
  source: AudioSource,
  answer: SimulatedAnswer,
  [accept, greeting]: GreetingAudio[],
  { hangUp, pressOne = false }: { hangUp: () => Promise<void>; pressOne?: boolean },
) {
  if (answer === 'no-answer') return
  const heard = (new AudioStream(await firstAudioTrack(room), 16_000, 1) as unknown as AsyncIterable<AudioFrame>)[
    Symbol.asyncIterator
  ]()
  await untilTheyStopTalking(heard) // the briefing
  if (answer === 'decline') {
    await room.localParticipant!.publishDtmf(2, '2')
    return
  }
  await speak(source, accept!)
  if (pressOne) await room.localParticipant!.publishDtmf(1, '1')
  await untilTheyStopTalking(heard) // "Connecting you now."
  await sleep(800)
  await speak(source, greeting!)
  await sleep(1500)
  await hangUp()
}
