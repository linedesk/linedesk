// The greeting as ready audio: synthesized once per greeting text and voice, kept on disk, and played
// at once when a call is answered instead of waiting for the voice provider. A changed greeting or
// voice has another key, so it is synthesized anew; the old file is simply no longer used.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'
import type { tts as ttsTypes } from '@livekit/agents'
import { AudioFrame } from '@livekit/rtc-node'

export type GreetingAudio = { sampleRate: number; channels: number; samples: Int16Array }

/** What makes the greeting sound the way it does. */
export type GreetingVoice = { provider: string; model?: string; voiceId?: string; text: string }

export const greetingKey = (voice: GreetingVoice) =>
  createHash('sha256').update(JSON.stringify([voice.provider, voice.model ?? '', voice.voiceId ?? '', voice.text])).digest('hex').slice(0, 32)

const HEADER_BYTES = 8

export function encodeAudio({ sampleRate, channels, samples }: GreetingAudio): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(sampleRate, 0)
  header.writeUInt32LE(channels, 4)
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)])
}

export function decodeAudio(file: Buffer): GreetingAudio {
  const pcm = file.subarray(HEADER_BYTES)
  const samples = new Int16Array(pcm.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2)
  return { sampleRate: file.readUInt32LE(0), channels: file.readUInt32LE(4), samples }
}

/** The audio as a stream of 20 ms frames, the way `session.say(text, { audio })` takes it. */
export function audioStream({ sampleRate, channels, samples }: GreetingAudio, frameMs = 20): ReadableStream<AudioFrame> {
  const perFrame = Math.round((sampleRate * frameMs) / 1000) * channels
  let offset = 0
  return new ReadableStream<AudioFrame>({
    pull(controller) {
      if (offset >= samples.length) return controller.close()
      const chunk = samples.slice(offset, offset + perFrame)
      offset += perFrame
      controller.enqueue(new AudioFrame(chunk, sampleRate, channels, chunk.length / channels))
    },
  })
}

/** Synthesizes `text` with the given voice into one piece of audio. */
export async function synthesize(tts: ttsTypes.TTS, text: string): Promise<GreetingAudio> {
  const parts: Int16Array[] = []
  let sampleRate = tts.sampleRate
  let channels = tts.numChannels
  for await (const { frame } of tts.synthesize(text)) {
    parts.push(frame.data)
    sampleRate = frame.sampleRate
    channels = frame.channels
  }
  const samples = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    samples.set(part, at)
    at += part.length
  }
  return { sampleRate, channels, samples }
}

export const GREETING_CACHE_DIR = process.env.GREETING_CACHE_DIR || join(tmpdir(), 'linedesk-greetings')

export function createGreetingCache(dir = GREETING_CACHE_DIR) {
  const file = (key: string) => join(dir, `${key}.pcm`)
  return {
    /** The stored audio, or null when there is none (or it cannot be read). */
    async get(key: string): Promise<GreetingAudio | null> {
      try {
        return decodeAudio(await readFile(file(key)))
      } catch {
        return null
      }
    },
    /** Stores the audio; written to a temporary file first, so a reader never sees half a file. */
    async put(key: string, audio: GreetingAudio): Promise<void> {
      await mkdir(dir, { recursive: true })
      const temporary = `${file(key)}.${process.pid}.tmp`
      await writeFile(temporary, encodeAudio(audio))
      await rename(temporary, file(key))
    },
  }
}
