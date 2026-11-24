// Audio the agent plays or carries itself, outside the voice session: a ringback tone while the
// on-call phone rings, and a one-way bridge that republishes a participant's audio in another room.
// Two bridges, one each way, connect the caller with the on-call person after a warm transfer.
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteTrack,
  type Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node'

const SAMPLE_RATE = 48_000
const FRAME_MS = 20

/** A published track fed from an AudioSource; `stop` unpublishes it and closes the source. */
async function publishSource(room: Room, name: string, sampleRate = SAMPLE_RATE) {
  const source = new AudioSource(sampleRate, 1)
  const track = LocalAudioTrack.createAudioTrack(name, source)
  const publication = await room.localParticipant!.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  )
  let stopped = false
  return {
    source,
    get stopped() {
      return stopped
    },
    async stop() {
      if (stopped) return
      stopped = true
      source.clearQueue()
      await room.localParticipant?.unpublishTrack(publication.sid!).catch(() => {})
      await source.close().catch(() => {})
    },
  }
}

/**
 * US ringback (440 + 480 Hz, two seconds on, four off) as 20 ms frames at a quiet level. Pure: frame
 * `index` of the endless cadence.
 */
export function ringbackFrame(index: number, sampleRate = SAMPLE_RATE, level = 0.12): Int16Array {
  const perFrame = (sampleRate * FRAME_MS) / 1000
  const samples = new Int16Array(perFrame)
  const cycle = (6000 / FRAME_MS) | 0
  if (index % cycle >= 2000 / FRAME_MS) return samples
  const start = index * perFrame
  for (let i = 0; i < samples.length; i++) {
    const t = (start + i) / sampleRate
    samples[i] = Math.round(((Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2) * level * 32767)
  }
  return samples
}

/** Mono speech to play first, e.g. "I'm connecting you…". */
export type Announcement = { sampleRate: number; samples: Int16Array }

/**
 * Plays the announcement, then the ringback tone until stopped, on one track of the announcement's
 * rate: the caller hears what happens and then that the line is ringing.
 */
export async function playRingback(room: Room, announcement?: Announcement): Promise<() => Promise<void>> {
  const sampleRate = announcement?.sampleRate ?? SAMPLE_RATE
  const perFrame = (sampleRate * FRAME_MS) / 1000
  const out = await publishSource(room, 'ringback', sampleRate)
  void (async () => {
    const speech = announcement?.samples ?? new Int16Array(0)
    for (let at = 0; at < speech.length && !out.stopped; at += perFrame) {
      const chunk = speech.slice(at, at + perFrame)
      await out.source.captureFrame(new AudioFrame(chunk, sampleRate, 1, chunk.length)).catch(() => {})
    }
    for (let i = 0; !out.stopped; i++) {
      await out.source
        .captureFrame(new AudioFrame(ringbackFrame(i, sampleRate), sampleRate, 1, perFrame))
        .catch(() => {})
    }
  })()
  return () => out.stop()
}

/** Republishes one remote audio track in another room until stopped (or the track ends). */
export async function forwardAudio(track: RemoteTrack, into: Room, name: string): Promise<() => Promise<void>> {
  const out = await publishSource(into, name)
  const stream = new AudioStream(track, SAMPLE_RATE, 1)
  void (async () => {
    try {
      for await (const frame of stream as unknown as AsyncIterable<AudioFrame>) {
        if (out.stopped) break
        await out.source.captureFrame(frame)
      }
    } catch {
      // the track or the room went away: the bridge simply ends
    }
  })()
  return async () => {
    await out.stop()
    await stream.cancel().catch(() => {})
  }
}
