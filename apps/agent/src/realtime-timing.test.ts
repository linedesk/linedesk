import { expect, test } from 'vitest'
import { describeRealtimeReply, realtimeTurnTimer } from './realtime-timing.ts'

/** 100 ms of 24 kHz 16-bit audio, base64: 4800 bytes. */
const audio100ms = Buffer.alloc(4800).toString('base64')

test('one line per reply: caller stopped → turn detected → reply started → first audio → playing', () => {
  let clock = 0
  const lines: string[] = []
  const timer = realtimeTurnTimer(reply => lines.push(describeRealtimeReply(reply)), () => clock)
  // 3 s of audio, sent in real time from t=0.
  for (let t = 0; t < 3000; t += 100) {
    clock = t
    timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
  }
  // The caller stopped speaking at 2000 ms into the audio; OpenAI says so at 2900 ms.
  clock = 2900
  timer.received({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 2000 })
  clock = 3000
  timer.received({ type: 'response.created' })
  clock = 3500
  timer.received({ type: 'response.output_audio.delta' })
  clock = 3550
  timer.received({ type: 'response.output_audio.delta' })
  clock = 3600
  timer.speaking()
  expect(lines).toEqual([
    'caller stopped → turn detected 900 ms, → reply started 100 ms, → first audio 500 ms, → playing 100 ms (total 1600 ms; sending -100 ms behind)',
  ])
  // A reply without the caller speaking first (a reminder) gives no line.
  timer.received({ type: 'response.created' })
  timer.speaking()
  expect(lines).toHaveLength(1)
})
