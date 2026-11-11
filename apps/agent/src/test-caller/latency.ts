// What a caller actually waits for: from the moment the test caller stops talking to the moment
// the business's assistant starts talking, measured on the audio the caller receives. The test
// caller publishes the numbers as a participant attribute; the call-test command reads them.
import { voice, type JobContext } from '@livekit/agents'
import { AudioStream, type AudioFrame, type RemoteParticipant, RoomEvent, TrackKind } from '@livekit/rtc-node'

export const LATENCY_ATTRIBUTE = 'linedesk.latency'
/**
 * The business's agent publishes its own setup timings on this attribute: milliseconds from its job
 * start (in room mode: when the call is picked up) to each step, and whether the greeting was stored audio.
 */
export const SETUP_ATTRIBUTE = 'linedesk.setup'
export type AgentSetup = { steps: Record<string, number>; greeting: string }
/** The greeting must start within this long of pickup (on the test server's hardware). */
export const GREETING_TARGET_MS = 2500
export type LatencySample = { greetingMs: number | null; replyMs: number[] }

/** Level above which a 10 ms frame counts as speech (16-bit PCM RMS). Phone and TTS audio sit far above it. */
const SPEECH_RMS = 500
/** Speech has to last this long to count, and silence this long to end it. */
const ONSET_MS = 60
const QUIET_MS = 400

export const rms = (samples: Int16Array) => {
  let sum = 0
  for (const s of samples) sum += s * s
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

/** Turns a stream of (level, time) into speech onsets: true on the first frame of each new utterance. */
export function createOnsetDetector() {
  let loudSince: number | null = null
  let lastLoud = Number.NEGATIVE_INFINITY
  let speaking = false
  return (level: number, atMs: number): boolean => {
    if (level < SPEECH_RMS) {
      loudSince = null
      if (speaking && atMs - lastLoud >= QUIET_MS) speaking = false
      return false
    }
    lastLoud = atMs
    loudSince ??= atMs
    if (speaking || atMs - loudSince < ONSET_MS) return false
    speaking = true
    return true
  }
}

/** Collects greeting and reply times; `onset` and `callerStopped` are fed by the test caller. */
export function createLatencyLog(startedAt: number) {
  const sample: LatencySample = { greetingMs: null, replyMs: [] }
  let callerStoppedAt: number | null = null
  return {
    sample,
    callerStopped(atMs: number) {
      callerStoppedAt = atMs
    },
    /** The business started speaking, `onsetMs` back from when it was detected. */
    businessStarted(atMs: number, onsetMs = ONSET_MS) {
      const startedSpeaking = atMs - onsetMs
      if (sample.greetingMs === null) sample.greetingMs = Math.max(0, startedSpeaking - startedAt)
      else if (callerStoppedAt !== null) sample.replyMs.push(Math.max(0, startedSpeaking - callerStoppedAt))
      callerStoppedAt = null
    },
  }
}

/** Measures on the counterpart's audio and publishes the numbers on every change. */
export function measureLatency(ctx: JobContext, counterpart: RemoteParticipant, session: voice.AgentSession | null) {
  const log = createLatencyLog(Date.now())
  const publish = () => void ctx.room.localParticipant?.setAttributes({ [LATENCY_ATTRIBUTE]: JSON.stringify(log.sample) }).catch(() => {})
  session?.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ oldState }) => {
    if (oldState === 'speaking') log.callerStopped(Date.now())
  })
  const listen = async (stream: AsyncIterable<AudioFrame>) => {
    const onset = createOnsetDetector()
    for await (const frame of stream) {
      const now = Date.now()
      if (onset(rms(frame.data), now)) {
        log.businessStarted(now)
        publish()
      }
    }
  }
  const attach = () => {
    for (const publication of counterpart.trackPublications.values()) {
      if (publication.track?.kind === TrackKind.KIND_AUDIO) return void listen(new AudioStream(publication.track, 16000, 1) as unknown as AsyncIterable<AudioFrame>)
    }
    ctx.room.once(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity === counterpart.identity && track.kind === TrackKind.KIND_AUDIO) void listen(new AudioStream(track, 16000, 1) as unknown as AsyncIterable<AudioFrame>)
      else attach()
    })
  }
  attach()
  return log.sample
}
