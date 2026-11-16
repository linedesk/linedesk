// The text of a reply comes back from the voice provider with word timings (LiveKit's TTS-aligned transcript), and that
// text, not the model's, is what the call's history and transcript keep. ElevenLabs sends two versions of it: the text
// as written and its normalized form, which is romanized for Japanese. Played against a stand-in ElevenLabs server.
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { initializeLogger, tts } from '@livekit/agents'
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const server = vi.hoisted(() => ({ baseURL: '' }))

// The voice the call builds (createTts), only pointed at the stand-in server.
vi.mock('@livekit/agents-plugin-elevenlabs', async importOriginal => {
  const real = await importOriginal<typeof import('@livekit/agents-plugin-elevenlabs')>()
  class TTS extends real.TTS {
    constructor(opts: ConstructorParameters<typeof real.TTS>[0] = {}) {
      super({ ...opts, baseURL: server.baseURL })
    }
  }
  return { ...real, TTS }
})

const { createTts, ELEVENLABS_ALIGNMENT, VoiceWithBackup } = await import('./pipeline.ts')

/** What ElevenLabs reads (normalized) for each text: Japanese comes back romanized, numbers spelled out. */
const NORMALIZED: Record<string, string> = {
  '佐藤様、お電話ありがとうございます。': 'Zuo Teng Yang , oDian Hua arigatougozaimasu.',
  'Your appointment is at 3 pm.': 'Your appointment is at three p m.',
}

type Alignment = { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] }
const alignmentOf = (text: string): Alignment => {
  const chars = Array.from(text)
  return { chars, charStartTimesMs: chars.map((_, i) => 100 + i * 50), charDurationsMs: chars.map(() => 50) }
}

let wss: WebSocketServer | undefined

beforeAll(() => initializeLogger({ pretty: false, level: 'fatal' }))
afterEach(async () => {
  for (const client of wss?.clients ?? []) client.close()
  await new Promise<void>(resolve => (wss ? wss.close(() => resolve()) : resolve()))
  wss = undefined
})

/** Speaks `text` with the call's ElevenLabs voice and returns the timed words LiveKit takes the reply's text from. */
async function spokenWords(text: string, language: 'en' | 'ja') {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  server.baseURL = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
  wss.on('connection', ws => {
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { context_id: string; text?: string; close_context?: boolean }
      const said = message.text?.trim()
      if (said)
        ws.send(
          JSON.stringify({
            contextId: message.context_id,
            audio: Buffer.alloc(22_050 * 2 * 0.2).toString('base64'),
            alignment: alignmentOf(said),
            normalizedAlignment: alignmentOf(NORMALIZED[said] ?? said),
          }),
        )
      if (message.close_context) ws.send(JSON.stringify({ contextId: message.context_id, isFinal: true }))
    })
  })

  const voice = createTts({ provider: 'elevenlabs', apiKey: 'test-key', voiceId: 'voice' }, null, language)
  if (!(voice instanceof VoiceWithBackup)) throw new Error('the call voice is a VoiceWithBackup')
  const own = voice.ttsInstances[0]!
  expect(own).toBeInstanceOf(elevenlabs.TTS)
  expect(own.capabilities.alignedTranscript).toBe(true)
  const stream = own.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 2_000 } })
  const words: NonNullable<tts.SynthesizedAudio['timedTranscripts']> = []
  try {
    stream.pushText(text)
    stream.endInput()
    for await (const event of stream) {
      if (event === tts.SynthesizeStream.END_OF_STREAM) break
      words.push(...(event.timedTranscripts ?? []))
    }
  } finally {
    stream.close()
    await voice.close()
  }
  return words
}

test('a Japanese reply keeps its own script, so the history never holds a romanization', async () => {
  const words = await spokenWords('佐藤様、お電話ありがとうございます。', 'ja')
  expect(words.map(word => word.text).join('')).toBe('佐藤様、お電話ありがとうございます。')
})

test('an English reply keeps what the model wrote and stays timed word by word, so a cut-off reply is cut at the word', async () => {
  const words = await spokenWords('Your appointment is at 3 pm.', 'en')
  expect(
    words
      .map(word => word.text)
      .join('')
      .trim(),
  ).toBe('Your appointment is at 3 pm.')
  expect(words.map(word => word.text.trim())).toEqual(['Your', 'appointment', 'is', 'at', '3', 'pm.'])
  const starts = words.map(word => word.startTime!)
  expect(starts).toEqual([...starts].sort((a, b) => a - b))
  expect(new Set(starts).size).toBe(words.length)
})

test("ElevenLabs' original word timings are the ones the voice asks for", () => {
  expect(ELEVENLABS_ALIGNMENT).toBe('original')
})
