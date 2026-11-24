import { expect, test } from 'vitest'
import { describeRealtimeReply, realtimeTurnTimer } from './realtime-timing.ts'

/** 100 ms of 24 kHz 16-bit audio, base64: 4800 bytes. */
const audio100ms = Buffer.alloc(4800).toString('base64')

test('one line per reply: caller stopped → turn detected → reply started → first audio → playing', () => {
  let clock = 0
  const lines: string[] = []
  const timer = realtimeTurnTimer(reply => lines.push(describeRealtimeReply(reply)), { now: () => clock })
  // 3 s of audio, sent in real time from t=0.
  for (let t = 0; t < 3000; t += 100) {
    clock = t
    timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
  }
  // The caller stopped speaking at 2000 ms into the audio (the chunk sent at 1900); OpenAI says so at 2900 ms.
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
    'caller stopped → turn detected 1000 ms, → reply started 100 ms, → first audio 500 ms, → playing 100 ms (total 1700 ms; sending -100 ms behind)',
  ])
  // A reply without the caller speaking first (a reminder) gives no line.
  timer.received({ type: 'response.created' })
  timer.speaking()
  expect(lines).toHaveLength(1)
})

test('silence detection: audio_end_ms includes the silence waited for; audio sent unevenly is mapped chunk by chunk', () => {
  let clock = 0
  const replies: number[][] = []
  const timer = realtimeTurnTimer(r => replies.push([r.turnMs, r.totalMs]), { now: () => clock, silenceMs: 500 })
  // 1 s of audio arrives in a burst at t=0 (a caller's first words, queued), then 100 ms chunks in real time from t=1000.
  for (let i = 0; i < 10; i++) timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
  for (let t = 1000; t < 4000; t += 100) {
    clock = t
    timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
  }
  // Speech ended at audio position 2500 (sent at t=2400, the chunk 2400–2500); the VAD waited 500 ms: audio_end_ms 3000.
  clock = 3700
  timer.received({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 3000 })
  timer.received({ type: 'response.created' })
  clock = 4000
  timer.received({ type: 'response.output_audio.delta' })
  timer.speaking()
  expect(replies).toEqual([[1300, 1600]])
})

test('the parts never add up to more than the total; a reply measured out of order gives no time', () => {
  for (let run = 0; run < 200; run++) {
    let clock = 0
    const replies: { turnMs: number; modelMs: number; serverMs: number; totalMs: number }[] = []
    const timer = realtimeTurnTimer(r => replies.push(r), { now: () => clock, silenceMs: 500 })
    // Audio in uneven chunks (bursts and gaps), then events at random times, sometimes out of order.
    for (let i = 0; i < 60; i++) {
      clock += Math.floor(Math.random() * 60)
      timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
    }
    const at = (offset: number) => Math.max(0, clock + offset)
    const steps = Array.from({ length: 4 }, () => Math.floor(Math.random() * 1500) - 300)
    clock = at(steps[0]!)
    timer.received({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 2000 + Math.floor(Math.random() * 4000) })
    clock = at(steps[1]!)
    timer.received({ type: 'response.created' })
    clock = at(steps[2]!)
    timer.received({ type: 'response.output_audio.delta' })
    clock = at(steps[3]!)
    timer.speaking()
    for (const r of replies) {
      expect(r.turnMs + r.modelMs + r.serverMs).toBe(r.totalMs)
      for (const part of [r.turnMs, r.modelMs, r.serverMs]) expect(part).toBeGreaterThanOrEqual(0)
    }
  }
})

test('the caller\'s last word mapped after OpenAI took the turn (sending behind): no reply time', () => {
  let clock = 0
  const replies: unknown[] = []
  const timer = realtimeTurnTimer(r => replies.push(r), { now: () => clock })
  timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms })
  clock = 1000
  timer.sent({ type: 'input_audio_buffer.append', audio: audio100ms }) // audio 100–200 left at 1000
  clock = 500
  timer.received({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 150 })
  timer.received({ type: 'response.created' })
  clock = 1200
  timer.received({ type: 'response.output_audio.delta' })
  timer.speaking()
  expect(replies).toEqual([])
})
