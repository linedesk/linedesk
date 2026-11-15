// The transcription adapters against fake services: what each sends (URL, key header, model, speaker labels), what it
// returns (text, turns with speakers and times in milliseconds), and that no error carries a response body.
import { describe, expect, it } from 'vitest'
import {
  assemblyAiTranscriber,
  deepgramTranscriber,
  elevenLabsTranscriber,
  openAiTranscriber,
  TranscriberError,
  transcriberFor,
} from './transcriber.ts'

const file = { name: 'call.ogg', contentType: 'audio/ogg' }
const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' })
/** What the caller said: must never show in an error. */
const CALLER_WORDS = 'My name is Dana Reyes and my number is'

type Sent = { url: string; init: RequestInit }
function fakeFetch(answers: (Response | (() => Response))[]) {
  const sent: Sent[] = []
  const doFetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, init })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected request to ${url}`)
    return typeof next === 'function' ? next() : next
  }) as unknown as typeof fetch
  return { sent, doFetch }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('OpenAI (gpt-transcribe)', () => {
  it('sends the file with the model and the key, and returns the text', async () => {
    const { sent, doFetch } = fakeFetch([json({ text: 'Hello, this is Maya.' })])
    const transcriber = openAiTranscriber('sk-test', { doFetch })
    expect([transcriber.model, transcriber.maxBytes]).toEqual(['gpt-transcribe', 25 * 1024 * 1024])
    expect(await transcriber.transcribe(audio, file)).toEqual({ text: 'Hello, this is Maya.' })
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    const form = sent[0]!.init.body as FormData
    expect([form.get('model'), form.get('response_format')]).toEqual(['gpt-transcribe', 'json'])
    expect((form.get('file') as File).size).toBe(3)
  })

  it('refusals and answers that are not JSON fail with the status only', async () => {
    const refused = fakeFetch([new Response(`{"error":"${CALLER_WORDS} sk-secret"}`, { status: 401 })])
    const error = await openAiTranscriber('sk-secret', refused)
      .transcribe(audio, file)
      .catch(e => e)
    expect(error).toBeInstanceOf(TranscriberError)
    expect(error.status).toBe(401)
    expect(error.message).not.toMatch(/sk-secret|Dana/)
    const garbled = fakeFetch([new Response(CALLER_WORDS)])
    const parse = await openAiTranscriber('k', garbled)
      .transcribe(audio, file)
      .catch(e => e)
    expect(parse.message).toBe('transcription failed (200): the transcription: the answer is not JSON')
  })
})

describe('Deepgram (Nova-3, recorded audio)', () => {
  it('asks for speaker labels and turns, and returns them in milliseconds', async () => {
    const { sent, doFetch } = fakeFetch([
      json({
        results: {
          channels: [{ alternatives: [{ transcript: 'How can I help? My sink leaks.' }] }],
          utterances: [
            { speaker: 0, start: 0.1, end: 1.2, transcript: 'How can I help?' },
            { speaker: 1, start: 1.5, end: 2.75, transcript: 'My sink leaks.' },
          ],
        },
      }),
    ])
    const heard = await deepgramTranscriber('dg-key', { doFetch }).transcribe(audio, file)
    expect(heard).toEqual({
      text: 'How can I help? My sink leaks.',
      turns: [
        { speaker: '0', start: 100, end: 1200, text: 'How can I help?' },
        { speaker: '1', start: 1500, end: 2750, text: 'My sink leaks.' },
      ],
    })
    const url = new URL(sent[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      diarize: 'true',
      utterances: 'true',
      mip_opt_out: 'true',
    })
    expect(sent[0]!.init.headers).toMatchObject({ authorization: 'Token dg-key', 'content-type': 'audio/ogg' })
    expect(sent[0]!.init.body).toBe(audio)
  })

  it('fails without the body', async () => {
    const { doFetch } = fakeFetch([new Response(CALLER_WORDS, { status: 402 })])
    const error = await deepgramTranscriber('k', { doFetch })
      .transcribe(audio, file)
      .catch(e => e)
    expect([error.status, /Dana/.test(error.message)]).toEqual([402, false])
  })
})

describe('AssemblyAI (Universal)', () => {
  it('uploads, asks for speaker labels, waits until done, and returns the turns', async () => {
    const waits: number[] = []
    const { sent, doFetch } = fakeFetch([
      json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }),
      json({ id: 'tr_1', status: 'queued' }),
      json({ id: 'tr_1', status: 'processing' }),
      json({
        id: 'tr_1',
        status: 'completed',
        text: 'How can I help? My sink leaks.',
        utterances: [
          { speaker: 'A', start: 100, end: 1200, text: 'How can I help?' },
          { speaker: 'B', start: 1500, end: 2750, text: 'My sink leaks.' },
        ],
      }),
      new Response(null, { status: 200 }),
    ])
    const transcriber = assemblyAiTranscriber('aai-key', { doFetch, wait: async ms => void waits.push(ms) })
    expect(await transcriber.transcribe(audio, file)).toEqual({
      text: 'How can I help? My sink leaks.',
      turns: [
        { speaker: 'A', start: 100, end: 1200, text: 'How can I help?' },
        { speaker: 'B', start: 1500, end: 2750, text: 'My sink leaks.' },
      ],
    })
    expect(sent.map(s => s.url)).toEqual([
      'https://api.assemblyai.com/v2/upload',
      'https://api.assemblyai.com/v2/transcript',
      'https://api.assemblyai.com/v2/transcript/tr_1',
      'https://api.assemblyai.com/v2/transcript/tr_1',
      'https://api.assemblyai.com/v2/transcript/tr_1',
    ])
    // Once read, the transcript is deleted at AssemblyAI; every request has a time limit.
    expect(sent[4]!.init.method).toBe('DELETE')
    expect(sent.every(s => s.init.signal instanceof AbortSignal)).toBe(true)
    expect(sent.every(s => (s.init.headers as Record<string, string>).authorization === 'aai-key')).toBe(true)
    expect(JSON.parse(sent[1]!.init.body as string)).toEqual({
      audio_url: 'https://cdn.assemblyai.com/upload/abc',
      speaker_labels: true,
      punctuate: true,
    })
    expect(waits).toEqual([2000])
  })

  it('a transcription that failed at AssemblyAI is refused for good, without its error text, and deleted', async () => {
    const { sent, doFetch } = fakeFetch([
      json({ upload_url: 'u' }),
      json({ id: 'tr_2' }),
      json({ id: 'tr_2', status: 'error', error: CALLER_WORDS }),
      new Response(null, { status: 500 }),
    ])
    const error = await assemblyAiTranscriber('k', { doFetch, wait: async () => {} })
      .transcribe(audio, file)
      .catch(e => e)
    expect(error).toBeInstanceOf(TranscriberError)
    expect(error.status).toBe(422)
    expect(error.message).not.toMatch(/Dana/)
    expect(sent[3]!.init.method).toBe('DELETE')
  })
})

describe('ElevenLabs Scribe', () => {
  it('asks for speaker labels and word times, and joins the words of one speaker into turns', async () => {
    const { sent, doFetch } = fakeFetch([
      json({
        text: 'Hi there. Hello.',
        words: [
          { text: 'Hi', type: 'word', start: 0.1, end: 0.3, speaker_id: 'speaker_0' },
          { text: ' ', type: 'spacing', start: 0.3, end: 0.35, speaker_id: 'speaker_0' },
          { text: 'there.', type: 'word', start: 0.35, end: 0.7, speaker_id: 'speaker_0' },
          { text: 'Hello.', type: 'word', start: 1.0, end: 1.4, speaker_id: 'speaker_1' },
        ],
      }),
    ])
    expect(await elevenLabsTranscriber('xi-key', { doFetch }).transcribe(audio, file)).toEqual({
      text: 'Hi there. Hello.',
      turns: [
        { speaker: 'speaker_0', start: 100, end: 700, text: 'Hi there.' },
        { speaker: 'speaker_1', start: 1000, end: 1400, text: 'Hello.' },
      ],
    })
    expect(sent[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect((sent[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key')
    const form = sent[0]!.init.body as FormData
    expect([form.get('model_id'), form.get('diarize'), form.get('timestamps_granularity')]).toEqual([
      'scribe_v2',
      'true',
      'word',
    ])
  })
})

describe('transcriberFor', () => {
  it('gives each provider of the category its adapter, with a size limit the API process can hold', () => {
    expect(transcriberFor('openai_transcript', 'k').model).toBe('gpt-transcribe')
    expect(transcriberFor('deepgram_transcript', 'k').model).toBe('nova-3')
    expect(transcriberFor('assemblyai', 'k').model).toBe('universal')
    expect(transcriberFor('elevenlabs_transcript', 'k').model).toBe('scribe_v2')
    for (const name of ['openai_transcript', 'deepgram_transcript', 'assemblyai', 'elevenlabs_transcript'] as const)
      expect(transcriberFor(name, 'k').maxBytes).toBe(25 * 1024 * 1024)
  })
})
