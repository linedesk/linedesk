import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { audioStream, createGreetingCache, greetingKey, withoutLeadingSilence } from './greeting-cache.ts'

const voice = { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voiceId: 'v1', text: 'Thanks for calling.' }

test('a changed greeting text, voice or model gets another key', () => {
  const key = greetingKey(voice)
  expect(greetingKey({ ...voice })).toBe(key)
  expect(greetingKey({ ...voice, text: 'Hello.' })).not.toBe(key)
  expect(greetingKey({ ...voice, voiceId: 'v2' })).not.toBe(key)
  expect(greetingKey({ ...voice, model: undefined })).not.toBe(key)
  expect(greetingKey({ ...voice, provider: 'cartesia' })).not.toBe(key)
  // A talking speed other than normal is another sound; normal keeps the key stored greetings have.
  expect(greetingKey({ ...voice, speed: 100 })).toBe(key)
  expect(greetingKey({ ...voice, speed: 108 })).not.toBe(key)
})

test('stores and reads back the audio; nothing stored is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greetings-'))
  try {
    const cache = createGreetingCache(dir)
    expect(await cache.get('missing')).toBeNull()
    const audio = { sampleRate: 24_000, channels: 1, samples: Int16Array.from([0, 1, -1, 32767, -32768]) }
    await cache.put('k', audio)
    expect(await cache.get('k')).toEqual(audio)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty file (stored before empty audio was refused) is a miss: the greeting is made again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greetings-'))
  try {
    const cache = createGreetingCache(dir)
    await cache.put('empty', { sampleRate: 24_000, channels: 1, samples: new Int16Array(0) })
    expect(await cache.get('empty')).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plays as 20 ms frames, the last one shorter', async () => {
  const samples = new Int16Array(24_000 / 10 + 100) // 100 ms + 100 samples at 24 kHz
  const reader = audioStream({ sampleRate: 24_000, channels: 1, samples }).getReader()
  const sizes: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    expect(value.sampleRate).toBe(24_000)
    sizes.push(value.samplesPerChannel)
  }
  expect(sizes).toEqual([480, 480, 480, 480, 480, 100])
})

test('the silence before the first word is cut, keeping 20 ms before it (LIN-262)', () => {
  // 24 kHz: 300 ms of near-silence (hiss under the level), then the voice.
  const samples = new Int16Array(24_000)
  for (let i = 0; i < 7_200; i++) samples[i] = i % 2 ? 40 : -40
  samples[7_200] = 2_000
  samples[7_201] = -1_500
  const trimmed = withoutLeadingSilence({ sampleRate: 24_000, channels: 1, samples })
  expect(trimmed.samples.length).toBe(24_000 - 7_200 + 480)
  expect(trimmed.samples[480]).toBe(2_000)
  expect(trimmed.sampleRate).toBe(24_000)
})

test('audio that starts at once, or is silent throughout, is played as it is', () => {
  const loud = { sampleRate: 24_000, channels: 1, samples: Int16Array.from([0, 0, 900, -900, 0]) }
  expect(withoutLeadingSilence(loud)).toBe(loud)
  const silent = { sampleRate: 24_000, channels: 1, samples: new Int16Array(4_800) }
  expect(withoutLeadingSilence(silent)).toBe(silent)
})

test('stereo audio is cut on a whole frame, so the channels stay paired', () => {
  const samples = new Int16Array(2 * 2_000)
  samples[2 * 1_000 + 1] = 3_000 // right channel of frame 1000
  const trimmed = withoutLeadingSilence({ sampleRate: 8_000, channels: 2, samples })
  // 20 ms at 8 kHz = 160 frames kept before frame 1000.
  expect(trimmed.samples.length).toBe(2 * (2_000 - 840))
  expect(trimmed.samples[2 * 160 + 1]).toBe(3_000)
})
