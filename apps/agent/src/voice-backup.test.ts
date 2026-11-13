import { initializeLogger, type APIConnectOptions, tts } from '@livekit/agents'
import { AudioFrame } from '@livekit/rtc-node'
import { beforeAll, expect, test, vi } from 'vitest'
import { openAiVoiceBackup } from './config.ts'
import { synthesize } from './greeting-cache.ts'
import { createTts, spokeWithBackup, VoiceWithBackup } from './pipeline.ts'

beforeAll(() => initializeLogger({ pretty: false, level: 'fatal' }))

/** A voice that answers with `frames` frames of audio; 0: like ElevenLabs with its quota used up (no audio, no error). */
class FakeVoice extends tts.TTS {
  label = 'fake.TTS'
  readonly name: string
  readonly frames: number
  languages: (string | undefined)[] = []
  constructor(name: string, frames: number) {
    super(24_000, 1, { streaming: false })
    this.name = name
    this.frames = frames
  }
  override get provider() {
    return this.name
  }
  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    return new FakeStream(text, this, connOptions, abortSignal)
  }
  stream(): tts.SynthesizeStream {
    throw new Error('not streaming')
  }
  updateOptions(opts: { language?: string }) {
    this.languages.push(opts.language)
  }
}

class FakeStream extends tts.ChunkedStream {
  label = 'fake.ChunkedStream'
  readonly voice: FakeVoice
  constructor(text: string, voice: FakeVoice, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, voice, connOptions, abortSignal)
    this.voice = voice
  }
  protected async run() {
    for (let i = 0; i < this.voice.frames; i++) {
      this.queue.put({
        requestId: 'r',
        segmentId: 'r',
        frame: new AudioFrame(new Int16Array(240).fill(this.voice.name.length), 24_000, 1, 240),
        final: i === this.voice.frames - 1,
      })
    }
    this.queue.close()
  }
}

test('a voice provider that gives no audio (quota used up) hands the line to the backup, for the rest of the call, logged once', async () => {
  const log = vi.fn()
  const primary = new FakeVoice('elevenlabs', 0)
  const backup = new FakeVoice('openai', 3)
  const voice = new VoiceWithBackup(primary, [backup], log)
  const first = await synthesize(voice, 'Are you still there?')
  expect(first.samples.length).toBe(3 * 240)
  expect(spokeWithBackup(voice)).toBe(true)
  const second = await synthesize(voice, 'Thanks for calling. Goodbye!')
  expect(second.samples.length).toBe(3 * 240)
  expect(log).toHaveBeenCalledOnce()
  expect(log.mock.calls[0]![0]).toMatch(/voice elevenlabs failed: speaking with openai/)
})

test('while the voice provider answers, the backup is never used and the audio is its own', async () => {
  const voice = new VoiceWithBackup(new FakeVoice('elevenlabs', 2), [new FakeVoice('openai', 3)], () => {})
  expect((await synthesize(voice, 'Hello')).samples.length).toBe(2 * 240)
  expect(spokeWithBackup(voice)).toBe(false)
})

test('a language change reaches the voice providers, not OpenAI, which reads the language from the text', () => {
  const config = { provider: 'elevenlabs' as const, apiKey: 'el', openAiBackup: { apiKey: 'sk', voice: 'marin' } }
  const voice = createTts(config)
  expect(voice).toBeInstanceOf(VoiceWithBackup)
  expect((voice as VoiceWithBackup).ttsInstances.map(i => i.provider)).toEqual(['ElevenLabs', 'api.openai.com'])
  expect(() => voice.updateOptions({ language: 'es' })).not.toThrow()
})

test('another voice provider with a key is a backup too, after OpenAI', () => {
  const config = {
    provider: 'elevenlabs' as const,
    apiKey: 'el',
    others: [{ provider: 'cartesia' as const, apiKey: 'ca' }],
  }
  expect((createTts(config) as VoiceWithBackup).ttsInstances.map(i => i.label)).toEqual([
    'elevenlabs.TTS',
    'cartesia.TTS',
  ])
  // An assistant whose own voice is Cartesia's: ElevenLabs is its backup.
  const own = createTts(config, { provider: 'cartesia', voice_id: 'v' }) as VoiceWithBackup
  expect(own.ttsInstances.map(i => i.label)).toEqual(['cartesia.TTS', 'elevenlabs.TTS'])
})

test('without a backup the voice is the provider alone', () => {
  expect(createTts({ provider: 'elevenlabs', apiKey: 'el' })).not.toBeInstanceOf(VoiceWithBackup)
})

test('the backup takes an OpenAI key that is set up anyway: the realtime model first, in its voice', () => {
  const entry = (provider: string, api_key: string, voice?: string) => ({
    provider,
    api_key,
    ...(voice ? { voice } : {}),
  })
  const settings = (over: object) => ({ stt: null, llm: null, tts: null, recording: null, ...over }) as never
  expect(openAiVoiceBackup(settings({ realtime: entry('openai_realtime', 'rt', 'cedar') }), {})).toEqual({
    apiKey: 'rt',
    voice: 'cedar',
  })
  expect(openAiVoiceBackup(settings({ stt: entry('openai_stt', 'stt') }), {})).toEqual({
    apiKey: 'stt',
    voice: 'marin',
  })
  expect(openAiVoiceBackup(settings({ llm: entry('openai', 'llm') }), {})).toEqual({ apiKey: 'llm', voice: 'marin' })
  expect(openAiVoiceBackup(settings({ llm: entry('openrouter', 'or') }), { OPENAI_API_KEY: 'env' })).toEqual({
    apiKey: 'env',
    voice: 'marin',
  })
  expect(openAiVoiceBackup(settings({ llm: entry('openrouter', 'or') }), {})).toBeNull()
})
