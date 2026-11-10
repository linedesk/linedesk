import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { audioStream, createGreetingCache, greetingKey } from './greeting-cache.ts'

const voice = { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voiceId: 'v1', text: 'Thanks for calling.' }

test('a changed greeting text, voice or model gets another key', () => {
  const key = greetingKey(voice)
  expect(greetingKey({ ...voice })).toBe(key)
  expect(greetingKey({ ...voice, text: 'Hello.' })).not.toBe(key)
  expect(greetingKey({ ...voice, voiceId: 'v2' })).not.toBe(key)
  expect(greetingKey({ ...voice, model: undefined })).not.toBe(key)
  expect(greetingKey({ ...voice, provider: 'cartesia' })).not.toBe(key)
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
