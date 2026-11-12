// Where the time of a realtime reply goes, from OpenAI's own events and the agent's clock: the caller stops speaking
// (OpenAI's `audio_end_ms` less the silence its VAD waits for, mapped to when that audio was sent) → OpenAI says the
// turn is over (the silence wait and the upload) → it starts the reply → its first audio arrives (model and download)
// → the agent plays it. What a caller hears on top is the phone leg (carrier ↔ LiveKit SIP ↔ agent).
import type { ReplyTimes } from './turn-metrics.ts'

/** The input audio the realtime model is sent: 24 kHz, 16-bit mono, so 48 bytes per millisecond. */
const BYTES_PER_MS = 48

type Event = { type?: string; audio?: string; audio_end_ms?: number }

/** Bytes of base64 text, without decoding it. */
const base64Bytes = (text: string) => Math.floor((text.length * 3) / 4) - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0)

/** One realtime reply: the parts of ReplyTimes, with OpenAI's model time split into starting the reply and its first audio. */
export type RealtimeReply = ReplyTimes & { startMs: number; firstAudioMs: number; lagMs: number }

/** The log line for one realtime reply. */
export const describeRealtimeReply = (r: RealtimeReply) =>
  `caller stopped → turn detected ${r.turnMs} ms, → reply started ${r.startMs} ms, → first audio ${r.firstAudioMs} ms, → playing ${r.serverMs} ms (total ${r.totalMs} ms; sending ${r.lagMs} ms behind)`

/** How many sent chunks are kept to map a position to when it was sent: about a minute of 20 ms frames. */
const SENT_KEPT = 3000

/**
 * Follows one realtime session. `sent` and `received` take OpenAI's client and server events, `speaking` the moment
 * the agent starts playing a reply; each reply after the caller spoke goes to `onReply`. `silenceMs`: the silence OpenAI's
 * server VAD waits for, which its `audio_end_ms` includes (0 for semantic VAD).
 */
export function realtimeTurnTimer(onReply: (reply: RealtimeReply) => void, { now = Date.now, silenceMs = 0 }: { now?: () => number; silenceMs?: number } = {}) {
  let firstSentAt: number | null = null
  let sentMs = 0
  /** Each sent chunk: the input audio position it ends at and when it left. Audio does not come evenly (gaps, bursts). */
  const sent: { endMs: number; at: number }[] = []
  /** Where the chunks no longer kept end: positions up to here cannot be mapped. */
  let droppedUntil = 0
  /** When the audio at `position` left the agent: the chunk that holds it; null when it is no longer kept. */
  const sentAt = (position: number) => (position <= droppedUntil ? null : (sent.find(chunk => chunk.endMs >= position)?.at ?? null))
  let turn: { speechEnd: number; stopped: number; lag: number; created?: number; firstAudio?: number } | null = null
  return {
    sent(event: Event) {
      if (event.type !== 'input_audio_buffer.append' || typeof event.audio !== 'string') return
      const at = now()
      firstSentAt ??= at
      sentMs += base64Bytes(event.audio) / BYTES_PER_MS
      sent.push({ endMs: sentMs, at })
      if (sent.length > SENT_KEPT) droppedUntil = sent.splice(0, sent.length - SENT_KEPT).at(-1)!.endMs
    },
    received(event: Event) {
      const at = now()
      if (event.type === 'input_audio_buffer.speech_stopped' && firstSentAt !== null && typeof event.audio_end_ms === 'number') {
        // The caller's last word: where the speech ended in the input audio, less the silence the VAD waited for.
        const speechEnd = sentAt(Math.max(0, event.audio_end_ms - silenceMs))
        // `lag`: how far sending runs behind real time (more audio time passed than was sent); it should stay near 0.
        if (speechEnd !== null) turn = { speechEnd, stopped: at, lag: at - firstSentAt - sentMs }
      } else if (event.type === 'response.created' && turn && turn.created === undefined) {
        turn.created = at
      } else if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') && turn?.created !== undefined && turn.firstAudio === undefined) {
        turn.firstAudio = at
      }
    },
    speaking() {
      if (!turn?.firstAudio || turn.created === undefined) return
      const playing = now()
      const { speechEnd, stopped, created, firstAudio, lag } = turn
      const ms = (from: number, to: number) => Math.max(0, Math.round(to - from))
      onReply({
        at: new Date(speechEnd).toISOString(),
        turnMs: ms(speechEnd, stopped),
        startMs: ms(stopped, created),
        firstAudioMs: ms(created, firstAudio),
        // OpenAI's whole time from taking the turn to its first audio.
        modelMs: ms(stopped, firstAudio),
        serverMs: ms(firstAudio, playing),
        totalMs: ms(speechEnd, playing),
        lagMs: Math.round(lag),
      })
      turn = null
    },
  }
}
