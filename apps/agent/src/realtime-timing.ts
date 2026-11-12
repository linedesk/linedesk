// Where the time of a realtime reply goes, one log line per reply, from OpenAI's own events and the agent's clock:
// the caller stops speaking (OpenAI's `audio_end_ms`, mapped to when that audio was sent) → OpenAI says the turn is over
// (turn detection and the upload) → it starts the reply → its first audio arrives (model and download) → the agent
// plays it. What a caller hears on top is the phone leg (carrier ↔ LiveKit SIP ↔ agent).

/** The input audio the realtime model is sent: 24 kHz, 16-bit mono, so 48 bytes per millisecond. */
const BYTES_PER_MS = 48

type Event = { type?: string; audio?: string; audio_end_ms?: number }

/** Bytes of base64 text, without decoding it. */
const base64Bytes = (text: string) => Math.floor((text.length * 3) / 4) - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0)

/**
 * Follows one realtime session. `sent` and `received` take OpenAI's client and server events, `speaking` the moment
 * the agent starts playing a reply; each reply after the caller spoke gives one line to `log`.
 */
export function realtimeTurnTimer(log: (line: string) => void, now: () => number = Date.now) {
  /** When the first input audio was sent; positions in the input audio are milliseconds after it, sent in real time. */
  let firstSentAt: number | null = null
  let sentMs = 0
  let turn: { speechEnd: number; stopped: number; lag: number; created?: number; firstAudio?: number } | null = null
  return {
    sent(event: Event) {
      if (event.type !== 'input_audio_buffer.append' || typeof event.audio !== 'string') return
      firstSentAt ??= now()
      sentMs += base64Bytes(event.audio) / BYTES_PER_MS
    },
    received(event: Event) {
      const at = now()
      if (event.type === 'input_audio_buffer.speech_stopped' && firstSentAt !== null && typeof event.audio_end_ms === 'number') {
        // The audio is streamed as it comes: the audio at `audio_end_ms` left the agent about that long after the first.
        // `lag`: how far sending runs behind real time (more audio time passed than was sent); it should stay near 0.
        turn = { speechEnd: firstSentAt + event.audio_end_ms, stopped: at, lag: at - firstSentAt - sentMs }
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
      const ms = (from: number, to: number) => `${Math.round(to - from)} ms`
      log(
        `caller stopped → turn detected ${ms(speechEnd, stopped)}, → reply started ${ms(stopped, created)}, → first audio ${ms(created, firstAudio)}, → playing ${ms(firstAudio, playing)} (total ${ms(speechEnd, playing)}; sending ${Math.round(lag)} ms behind)`,
      )
      turn = null
    },
  }
}
