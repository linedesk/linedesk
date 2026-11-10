// A stand-in recording for one demo call, so the player can be tried without a voice stack. It is
// made at seed time (nothing binary in the repository): soft tone bursts where the transcript has a
// turn, the assistant lower than the caller, as a small 8-bit WAV.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const SAMPLE_RATE = 4000
const AGENT_HZ = 220
const CALLER_HZ = 330
/** How long one turn sounds, at most (the rest of the gap until the next turn is silence). */
const TURN_SEC = 4

export type Turn = { atSec: number; speaker: 'agent' | 'caller' | 'human' | 'system' }

function header(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // PCM chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE, 28) // bytes per second: 1 byte per sample
  h.writeUInt16LE(1, 32) // block align
  h.writeUInt16LE(8, 34) // bits per sample
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** A mono 8-bit WAV of `durationSec`: a syllable-like tone for each spoken turn, silence elsewhere. */
export function demoRecordingWav(durationSec: number, turns: Turn[]): Buffer {
  const samples = Buffer.alloc(Math.round(durationSec * SAMPLE_RATE), 128) // 128 is silence in 8-bit PCM
  const spoken = turns.filter(t => t.speaker !== 'system').sort((a, b) => a.atSec - b.atSec)
  spoken.forEach((turn, i) => {
    const next = spoken[i + 1]?.atSec ?? durationSec
    const length = Math.max(0, Math.min(TURN_SEC, next - turn.atSec - 0.5))
    const hz = turn.speaker === 'caller' ? CALLER_HZ : AGENT_HZ
    const from = Math.round(turn.atSec * SAMPLE_RATE)
    for (let n = 0; n < length * SAMPLE_RATE && from + n < samples.length; n++) {
      const t = n / SAMPLE_RATE
      const syllables = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t) // about three syllables a second
      samples[from + n] = Math.round(128 + 40 * syllables * Math.sin(2 * Math.PI * hz * t))
    }
  })
  return Buffer.concat([header(samples.length), samples])
}

/** Writes the WAV under the file store's directory at `key` (a recordingKey). */
export async function writeDemoRecording(dir: string, key: string, wav: Buffer) {
  const path = join(dir, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, wav)
}
