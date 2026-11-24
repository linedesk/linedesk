// patches/@livekit__agents.patch (LIN-516): a chunked TTS request that fails because its stream was closed on purpose
// (an interrupted reply, a dropped preemptive generation) is no error. Without the patch the SDK reported it as an
// unrecoverable TTS error, and the session closed: OpenAI's SDK throws APIUserAbortError, not an "AbortError".
import { initializeLogger, tts } from '@livekit/agents'
import { expect, test } from 'vitest'

initializeLogger({ pretty: false, level: 'silent' })

class AbortedRequest extends tts.ChunkedStream {
  label = 'test.ChunkedStream'
  protected async run() {
    await new Promise<void>(resolve => this.abortSignal.addEventListener('abort', () => resolve(), { once: true }))
    // what openai's SDK throws for a request whose signal was aborted (an APIError, so not caught by name)
    throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
  }
}

class SlowTts extends tts.TTS {
  label = 'test.TTS'
  constructor() {
    super(24_000, 1, { streaming: false })
  }
  synthesize(text: string) {
    return new AbortedRequest(text, this)
  }
  stream(): tts.SynthesizeStream {
    throw new Error('not streaming')
  }
}

test('closing a chunked TTS stream mid-request emits no TTS error', async () => {
  const voice = new SlowTts()
  const errors: unknown[] = []
  voice.on('error', e => errors.push(e))
  const stream = voice.synthesize('Thank you for calling')
  await new Promise(resolve => setTimeout(resolve, 20))
  stream.close()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(errors).toEqual([])
})
