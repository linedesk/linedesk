import { initializeLogger } from '@livekit/agents'
import { beforeAll, expect, test, vi } from 'vitest'
import { type AgentConfig, configFromEnv, type RealtimeCallConfig, withAssistantRealtimeVoice } from './config.ts'
import { callLanguagesOf, callVoicesOf, withCallLanguages, chatJson, createPipeline, deepgramChoice, NOVA_MULTI_ENDPOINTING_MS, createRealtimePipeline, lineVoiceOf, MAX_TOOL_STEPS, REALTIME_LINE_TTS, REALTIME_TRUNCATION, REALTIME_TURNS, realtimeRepliesEvent, sendRealtimeTruncation, withRealtimeTruncation, transferSpeechOf, REPLY_MAX_TOKENS, replyRequestFields, sttDetectsTurns, greetingVoice, realtimeLine, SUMMARY_MAX_TOKENS, summaryLlm, ttsFor, voiceFor, warmUpLlm } from './pipeline.ts'

const openrouter = { apiKey: 'sk-or-test', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' }

test('chatJson asks the configured API for a JSON object and returns the message content', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
  expect(await chatJson(openrouter, fakeFetch)('system prompt', 'transcript')).toBe('{"ok":true}')
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'openai/gpt-4.1-mini', response_format: { type: 'json_object' }, max_tokens: SUMMARY_MAX_TOKENS })

  const direct = { ...openrouter, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }
  await chatJson(direct, fakeFetch)('s', 'u')
  expect(fakeFetch.mock.calls[1]![0]).toBe('https://api.openai.com/v1/chat/completions')

  const failing: typeof fetch = async () => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 })
  await expect(chatJson(openrouter, failing)('s', 'u')).rejects.toThrow('summary request failed (401): No auth credentials found')
})

test('chatJson gives up when the request takes longer than the timeout', async () => {
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
  })
  await expect(chatJson(openrouter, hanging, 20)('s', 'u')).rejects.toThrow(/timeout|aborted/i)
})

test('the voice of the assistant is used only for the provider it was chosen for', () => {
  const eleven = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice' }
  expect(voiceFor(eleven, { provider: 'elevenlabs', voice_id: 'maya' })).toBe('maya')
  expect(voiceFor(eleven, { provider: 'cartesia', voice_id: 'sonic_voice' })).toBe('default_voice')
  expect(voiceFor(eleven, { provider: 'elevenlabs', voice_id: '' })).toBe('default_voice')
  expect(voiceFor({ provider: 'elevenlabs', apiKey: 'k' }, null)).toBe('cgSgspJ2msm6clMCkdW9') // Jessica, the default voice
})

test('warmUpLlm sends the system prompt for a one-token answer and never throws', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [] }))
  await warmUpLlm(openrouter, 'You are Maya.', fakeFetch)
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'openai/gpt-4.1-mini', max_tokens: 1, messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user' }] })

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(warmUpLlm(openrouter, 's', async () => { throw new TypeError('fetch failed') })).resolves.toBeUndefined()
  await warmUpLlm(openrouter, 's', async () => new Response('busy', { status: 429 }))
  expect(warn.mock.calls.map(c => c[0])).toEqual(['LLM warm-up failed: fetch failed', 'LLM warm-up answered 429'])
  warn.mockRestore()
})

test('the summary uses the summary model, with OpenRouter fallbacks as `models`', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{}' } }] }))
  const llm: AgentConfig['llm'] = {
    provider: 'openrouter', ...openrouter, model: 'live/fast', fallbacks: ['live/backup'], summaryModel: 'sum/strong', summaryFallbacks: ['sum/backup'],
  }
  const config = { llm } as AgentConfig
  vi.stubGlobal('fetch', fakeFetch)
  await summaryLlm(config)('s', 'u')
  vi.unstubAllGlobals()
  expect(JSON.parse(String(fakeFetch.mock.calls[0]![1]!.body))).toMatchObject({ model: 'sum/strong', models: ['sum/strong', 'sum/backup'] })
  await chatJson({ ...openrouter, fallbacks: [] }, fakeFetch)('s', 'u')
  expect(JSON.parse(String(fakeFetch.mock.calls[1]![1]!.body))).not.toHaveProperty('models')
})

const realtime = { provider: 'openai_realtime', apiKey: 'sk-rt', model: 'gpt-realtime-mini', voice: 'marin', summaryModel: 'gpt-4.1-mini' } as const

test('with a realtime model the summary goes to OpenAI chat with its key and summary model', async () => {
  const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{}' } }] }))
  const config: RealtimeCallConfig = { realtime, recording: { store: 'off' }, stages: null }
  vi.stubGlobal('fetch', fakeFetch)
  await summaryLlm(config)('s', 'u')
  vi.unstubAllGlobals()
  const [url, init] = fakeFetch.mock.calls[0]!
  expect(url).toBe('https://api.openai.com/v1/chat/completions')
  expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-rt')
  expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'gpt-4.1-mini' })
})

test('a realtime call has only the model: no speech to text, no voice provider', () => {
  const options = createRealtimePipeline(realtime, 7, 110)
  expect(options.stt).toBeUndefined()
  expect(options.tts).toBeUndefined()
  expect(options.userAwayTimeout).toBe(7)
  expect(options.llm).toMatchObject({ _options: { model: 'gpt-realtime-mini', voice: 'marin', speed: 1.1 } })
  // Phone audio is near-field; one language: the caller's transcript is told which.
  expect(options.llm).toMatchObject({ _options: { inputAudioNoiseReduction: { type: 'near_field' }, inputAudioTranscription: { language: 'en' } } })
  const spanishOrEnglish = createRealtimePipeline(realtime, 7, 100, { main: 'es', others: ['en'] })
  expect((spanishOrEnglish.llm as unknown as { _options: { inputAudioTranscription: { language?: string } } })._options.inputAudioTranscription.language).toBeUndefined()
})

test("the realtime session is opened with the assistant's voice, and its fixed lines are said in it", () => {
  const config: RealtimeCallConfig = { realtime, recording: { store: 'off' }, stages: null }
  const own = withAssistantRealtimeVoice(config, 'coral') as RealtimeCallConfig
  expect(createRealtimePipeline(own.realtime).llm).toMatchObject({ _options: { voice: 'coral' } })
  expect(lineVoiceOf(own, null).key).toMatchObject({ provider: 'openai_tts', voiceId: 'coral' })
  // None picked: the server's default (marin here).
  const fallback = withAssistantRealtimeVoice(config, '') as RealtimeCallConfig
  expect(createRealtimePipeline(fallback.realtime).llm).toMatchObject({ _options: { voice: 'marin' } })
})

// The speech recognition and voice of the three stages log through LiveKit's logger when they are made.
beforeAll(() => initializeLogger({ pretty: false, level: 'fatal' }))

test('a caller turn may take a whole booking in tool rounds, on the three stages and on a realtime model', async () => {
  // find_slots, get_name, get_phone_number, get_address, get_email, book_appointment: six rounds in one turn.
  expect(MAX_TOOL_STEPS + 1).toBeGreaterThanOrEqual(6)
  const stages = await configFromEnv({ DEEPGRAM_API_KEY: 'dg', LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' })
  expect(createPipeline(stages).maxToolSteps).toBe(MAX_TOOL_STEPS)
  expect(createRealtimePipeline(realtime).maxToolSteps).toBe(MAX_TOOL_STEPS)
})

test("a realtime call's fixed lines are made by OpenAI's speech model in the realtime voice and pace", () => {
  const config: RealtimeCallConfig = { realtime, recording: { store: 'off' }, stages: null }
  const voice = lineVoiceOf(config, { talking_speed_pct: 110 })
  expect(voice.key).toEqual({ provider: 'openai_tts', model: REALTIME_LINE_TTS, voiceId: 'marin', speed: 110 })
  expect(voice.tts()).toMatchObject({ model: REALTIME_LINE_TTS, sampleRate: 24_000 })
})

test('a realtime call puts calls through with OpenAI speech and transcription on its key, also without the three stages', () => {
  const config: RealtimeCallConfig = { realtime, recording: { store: 'off' }, stages: null }
  const speech = transferSpeechOf(config, null)
  expect(speech.line.key).toMatchObject({ provider: 'openai_tts', voiceId: 'marin' })
  expect(speech.consult.stt).toEqual({ provider: 'openai_stt', apiKey: 'sk-rt', model: 'gpt-4o-mini-transcribe' })
  expect(sttDetectsTurns(speech.consult.stt)).toBe(true)
  expect(speech.consult.tts()).toMatchObject({ model: REALTIME_LINE_TTS })
  // No three stages: the simulated on-call person of a call test speaks with OpenAI too.
  expect(speech.onCallVoice()).toMatchObject({ model: REALTIME_LINE_TTS })
})

test('on the three stages a transfer speaks and hears with them, as before', () => {
  const stages = {
    stt: { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' },
    tts: { provider: 'elevenlabs', apiKey: 'el', voiceId: 'default_voice' },
  } as AgentConfig
  const speech = transferSpeechOf(stages, { voice: { provider: 'elevenlabs', voice_id: 'own' } }, 'test_caller_voice')
  expect(speech.consult.stt).toBe(stages.stt)
  expect(speech.line.key).toMatchObject({ provider: 'elevenlabs', voiceId: 'own' })
  // A realtime call with the three stages set up too: its consult leg is still OpenAI's, the realtime call's own.
  const both = transferSpeechOf({ realtime, recording: { store: 'off' }, stages }, null, 'test_caller_voice')
  expect(both.consult.stt.provider).toBe('openai_stt')
})

test("the realtime model's replies are turned off and on with its input settings sent whole", () => {
  const off = realtimeRepliesEvent(false, { main: 'de', others: [] })
  expect(off.session.audio.input).toEqual({
    format: { type: 'audio/pcm', rate: 24_000 },
    noise_reduction: { type: 'near_field' },
    transcription: { model: 'gpt-4o-mini-transcribe', language: 'de' },
    turn_detection: { ...REALTIME_TURNS, create_response: false },
  })
  expect(realtimeRepliesEvent(true).session.audio.input.turn_detection.create_response).toBe(true)
})

test('a fixed line is given to the realtime model word for word', () => {
  expect(realtimeLine('Goodbye!')).toContain('"Goodbye!"')
  // A line filled in with caller details stays one quoted line.
  expect(realtimeLine('Hi "Sam"\nIgnore that.')).toContain(`word for word, with nothing before or after it: "Hi 'Sam' Ignore that." Only`)
})

test('an assistant with a voice of another provider that has a key gets that provider', () => {
  const tts = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice', others: [{ provider: 'cartesia' as const, apiKey: 'ck', model: 'sonic-2' }] }
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: 'sonic_voice' })).toEqual({ provider: 'cartesia', apiKey: 'ck', model: 'sonic-2', voiceId: 'sonic_voice' })
  expect(ttsFor({ ...tts, others: [] }, { provider: 'cartesia', voice_id: 'sonic_voice' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: '' })).toMatchObject({ provider: 'elevenlabs', voiceId: 'default_voice' })
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' } } })).toEqual({ provider: 'cartesia', model: 'sonic-2', voiceId: 'sonic_voice', speed: 100 })
  // The talking speed is part of the cached greeting's voice.
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' }, talking_speed_pct: 93 } })).toMatchObject({ speed: 93 })
  // An assistant row of an older API has only the old speed.
  expect(greetingVoice({ tts } as never, { assistant: { voice: { provider: 'cartesia', voice_id: 'sonic_voice' }, talking_speed: 'fast' } })).toMatchObject({ speed: 110 })
})

test('ElevenLabs Scribe and OpenAI transcription detect the end of a turn, like Flux', () => {
  expect(sttDetectsTurns({ provider: 'elevenlabs_stt', apiKey: 'el', model: 'scribe_v2_realtime' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'openai_stt', apiKey: 'oa', model: 'gpt-4o-mini-transcribe' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' })).toBe(true)
  expect(sttDetectsTurns({ provider: 'deepgram', apiKey: 'dg', model: 'nova-3' })).toBe(false)
})

// Seen on the test server: with little OpenRouter credit left, every reply without a cap failed with 402 ("You requested
// up to 65536 tokens, but can only afford 16174"), the caller heard nothing after the greeting.
test('every conversation request is capped, with OpenRouter fallbacks as `models`', () => {
  expect(replyRequestFields('live/fast', [])).toEqual({ max_tokens: REPLY_MAX_TOKENS })
  expect(replyRequestFields('live/fast', ['live/backup'])).toEqual({ max_tokens: REPLY_MAX_TOKENS, models: ['live/fast', 'live/backup'] })
})

test('Flux stays for calls in its 10 languages; any other language takes Nova-3 multi with Deepgram hints', () => {
  // English only: the configured model as it is.
  expect(deepgramChoice('flux-general-en')).toEqual({ protocol: 'flux', model: 'flux-general-en' })
  expect(deepgramChoice('nova-3')).toEqual({ protocol: 'nova', model: 'nova-3' })
  // Languages Flux multilingual covers: Flux multi, as before.
  expect(deepgramChoice('flux-general-en', { main: 'en', others: ['es', 'de'] })).toEqual({ protocol: 'flux', model: 'flux-general-multi', languageHint: ['en', 'es', 'de'] })
  expect(deepgramChoice('flux-general-en', { main: 'ja', others: [] })).toMatchObject({ protocol: 'flux', model: 'flux-general-multi' })
  // A language outside Flux's 10, as the main one or besides: Nova-3 multi, hinted, with Deepgram's endpointing for it.
  const nova = { protocol: 'nova', model: 'nova-3', language: 'multi', endpointing: NOVA_MULTI_ENDPOINTING_MS }
  expect(deepgramChoice('flux-general-en', { main: 'en', others: ['es', 'ko'] })).toEqual({ ...nova, languageHint: ['en', 'es', 'ko'] })
  expect(deepgramChoice('flux-general-en', { main: 'zh', others: [] })).toEqual({ ...nova, languageHint: ['zh'] })
  expect(deepgramChoice('nova-3', { main: 'de', others: ['pl'] })).toEqual({ ...nova, languageHint: ['de', 'pl'] })
  // Every language: detected, hinted toward the main one only.
  expect(deepgramChoice('flux-general-en', { main: 'en', others: ['es', 'ko', 'pl'], everyLanguage: true })).toEqual({ ...nova, languageHint: ['en'] })
  // Flux detects turns, Nova-3 does not: the session falls back to its own detection.
  const stt = { provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' } as const
  expect(sttDetectsTurns(stt, { main: 'en', others: ['fr'] })).toBe(true)
  expect(sttDetectsTurns(stt, { main: 'en', others: ['ko'] })).toBe(false)
})

test('a Flux call that needs Nova-3 multi detects turns in the session, not in the speech recognition', async () => {
  const stages = await configFromEnv({ DEEPGRAM_API_KEY: 'dg', LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' })
  expect(stages.stt.model).toMatch(/^flux/)
  expect(createPipeline(stages, null, undefined, { main: 'pl', others: [] }).turnHandling?.turnDetection).toBeUndefined()
  expect(createPipeline(stages, null, undefined, { main: 'fr', others: [] }).turnHandling?.turnDetection).toBe('stt')
})

test("a call's languages keep only those a voice provider of the install speaks", () => {
  const elevenlabs = [{ provider: 'elevenlabs', model: 'eleven_flash_v2_5' }]
  expect(callLanguagesOf({ main: 'en', mode: 'allowed', allowed: ['ko', 'pl'] }, elevenlabs)).toEqual({ main: 'en', others: ['ko', 'pl'] })
  // Cartesia's Sonic 2 has no Vietnamese; Eleven Multilingual v2 none either.
  expect(callLanguagesOf({ main: 'en', mode: 'allowed', allowed: ['ko', 'vi'] }, [{ provider: 'cartesia', model: 'sonic-2' }]).others).toEqual(['ko'])
  expect(callLanguagesOf({ main: 'en', mode: 'allowed', allowed: ['vi'] }, [{ provider: 'elevenlabs', model: 'eleven_multilingual_v2' }]).others).toEqual([])
  // Every language with a Flux model: Flux's 10, so the call stays on Flux (coordinator decision on LIN-268).
  const flux = { provider: 'deepgram', model: 'flux-general-en' } as const
  const anyOnFlux = callLanguagesOf({ main: 'en', mode: 'any', allowed: [] }, elevenlabs, flux)
  expect(anyOnFlux).toEqual({ main: 'en', others: ['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'], everyLanguage: true })
  expect(deepgramChoice(flux.model, anyOnFlux)).toMatchObject({ protocol: 'flux', model: 'flux-general-multi' })
  // A new language picked explicitly still takes it: as the main language, or in the allowed list.
  expect(callLanguagesOf({ main: 'ko', mode: 'any', allowed: [] }, elevenlabs, flux).main).toBe('ko')
  expect(callLanguagesOf({ main: 'en', mode: 'allowed', allowed: ['pl'] }, elevenlabs, flux).others).toEqual(['pl'])
  // Every language with another speech model (Nova, Scribe): all the voice speaks, detected rather than hinted.
  const any = callLanguagesOf({ main: 'en', mode: 'any', allowed: [] }, elevenlabs, { provider: 'deepgram', model: 'nova-3' })
  expect(any.everyLanguage).toBe(true)
  expect(any.others).toEqual(expect.arrayContaining(['es', 'zh', 'ko', 'pl', 'hu']))
  expect(callLanguagesOf({ main: 'en', mode: 'any', allowed: [] }, elevenlabs, { provider: 'elevenlabs_stt', model: 'scribe_v2_realtime' }).others).toContain('ko')
  // No voice provider (a realtime call): Flux's languages, as before more were added.
  expect(callLanguagesOf({ main: 'en', mode: 'any', allowed: [] }).others).toEqual(['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  // The voice the call speaks with: the assistant's own, with its own voice model.
  const voices = { provider: 'elevenlabs' as const, apiKey: 'k', others: [{ provider: 'cartesia' as const, apiKey: 'c' }] }
  expect(callVoicesOf(voices)).toEqual([{ provider: 'elevenlabs', model: 'eleven_flash_v2_5' }])
  expect(callVoicesOf(voices, { provider: 'cartesia', voice_id: 'v1' })).toEqual([{ provider: 'cartesia', model: 'sonic-3.6' }])
  const multilingual = callVoicesOf(voices, { provider: 'elevenlabs', voice_id: 'v2', model: 'eleven_multilingual_v2' })
  expect(multilingual).toEqual([{ provider: 'elevenlabs', model: 'eleven_multilingual_v2' }])
  // Hungarian is Flash v2.5's, not Multilingual v2's: a call on it does not switch to it.
  expect(callLanguagesOf({ main: 'en', mode: 'allowed', allowed: ['hu', 'pl'] }, multilingual, flux).others).toEqual(['pl'])
})

test('the instructions name the languages the call speaks, not the stored "any"', () => {
  const assistant = { name: 'Maya', languages: { main: 'en', mode: 'any', allowed: [] } }
  expect(withCallLanguages(assistant, { main: 'en', others: ['es', 'de'], everyLanguage: true })).toEqual({
    name: 'Maya',
    languages: { main: 'en', mode: 'allowed', allowed: ['es', 'de'] },
  })
  expect(withCallLanguages(assistant, { main: 'ko', others: [] })?.languages).toEqual({ main: 'ko', mode: 'english', allowed: [] })
  expect(withCallLanguages(null, { main: 'en', others: [] })).toBeNull()
})

test("the assistant's voice model is used when its voice provider has it with a level", () => {
  const tts = { provider: 'elevenlabs' as const, apiKey: 'k', voiceId: 'default_voice', others: [{ provider: 'cartesia' as const, apiKey: 'ck' }] }
  expect(ttsFor(tts, { provider: 'elevenlabs', voice_id: 'v1', model: 'eleven_v3' })).toMatchObject({ model: 'eleven_v3', voiceId: 'v1' })
  // No pick: the provider's default (ElevenLabs Flash v2.5, Cartesia Sonic 3.6).
  expect(ttsFor(tts, { provider: 'elevenlabs', voice_id: 'v1' })).toMatchObject({ model: 'eleven_flash_v2_5' })
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: 'c1' })).toMatchObject({ provider: 'cartesia', model: 'sonic-3.6' })
  // A model of another provider (the voice changed since) or one without a level is not used.
  expect(ttsFor(tts, { provider: 'cartesia', voice_id: 'c1', model: 'eleven_v3' })).toMatchObject({ model: 'sonic-3.6' })
  expect(ttsFor({ ...tts, model: 'eleven_turbo_v2_5' }, { provider: 'elevenlabs', voice_id: 'v1', model: 'made_up' })).toMatchObject({ model: 'eleven_turbo_v2_5' })
})

test('a realtime session keeps half of a long conversation in one cut, past 4,000 tokens after the instructions', () => {
  expect(REALTIME_TRUNCATION).toEqual({ type: 'retention_ratio', retention_ratio: 0.5, token_limits: { post_instructions: 4000 } })
})

test('the truncation is sent once when the session opens and in every full session.update after, a reconnect included', () => {
  const sent: object[] = []
  let builds = 0
  const session = {
    createSessionUpdateEvent: () => ({ type: 'session.update', session: { type: 'realtime', model: 'gpt-realtime', instructions: `v${++builds}` } }),
    sendEvent: (event: object) => void sent.push(event),
  }
  sendRealtimeTruncation(session)
  expect(sent).toEqual([{ type: 'session.update', session: { type: 'realtime', truncation: REALTIME_TRUNCATION } }])
  // What the plugin sends on a reconnect: the full session.update it builds, now with the truncation.
  expect(session.createSessionUpdateEvent()).toEqual({
    type: 'session.update',
    session: { type: 'realtime', model: 'gpt-realtime', instructions: 'v1', truncation: REALTIME_TRUNCATION },
  })
  expect(session.createSessionUpdateEvent().session).toMatchObject({ instructions: 'v2', truncation: REALTIME_TRUNCATION })
})

test('only a GA session.update gets the truncation; the replies switch does not undo it', () => {
  const legacy = { type: 'session.update', session: { instructions: 'x' } }
  expect(withRealtimeTruncation(legacy)).toBe(legacy)
  const other = { type: 'response.create' }
  expect(withRealtimeTruncation(other)).toBe(other)
  expect(realtimeRepliesEvent(false).session).not.toHaveProperty('truncation')
})
