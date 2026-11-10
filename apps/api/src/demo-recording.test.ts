import { expect, test } from 'vitest'
import { demoRecordingWav } from './demo-recording.ts'

test('a small mono 8-bit WAV of the call length, with sound where the turns are', () => {
  const wav = demoRecordingWav(10, [
    { atSec: 0, speaker: 'agent' },
    { atSec: 5, speaker: 'caller' },
    { atSec: 7, speaker: 'system' },
  ])
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
  const rate = wav.readUInt32LE(24)
  expect(wav.readUInt32LE(40)).toBe(10 * rate) // one byte per sample, 10 seconds
  expect(wav.length).toBe(44 + 10 * rate)
  const at = (sec: number) => wav[44 + Math.round(sec * rate)]!
  const loudest = (from: number, to: number) =>
    Math.max(...wav.subarray(44 + from * rate, 44 + to * rate).map(v => Math.abs(v - 128)))
  expect(loudest(0, 2)).toBeGreaterThan(20) // the assistant speaks
  expect(loudest(5, 6)).toBeGreaterThan(20) // then the caller
  expect(at(4.8)).toBe(128) // silence before the caller's turn
  expect(at(9.9)).toBe(128)
})
