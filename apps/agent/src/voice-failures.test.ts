import { EventEmitter } from 'node:events'
import { APIConnectionError, APIStatusError, APITimeoutError, voice } from '@livekit/agents'
import { expect, test, vi } from 'vitest'
import { onceEachStage, voiceFailureOf, watchVoicePipeline } from './voice-failures.ts'

const E = voice.AgentSessionEventTypes
const status = (statusCode: number, message: string, body: object | null = null) =>
  new APIStatusError({ message, options: { statusCode, body } })

test('the reason comes from the status, then from the text', () => {
  expect(
    voiceFailureOf('tts', 'elevenlabs', status(401, 'quota_exceeded', { detail: { status: 'quota_exceeded' } })).reason,
  ).toBe('quota')
  expect(voiceFailureOf('llm', 'openrouter', status(401, 'No auth credentials found')).reason).toBe('auth')
  expect(voiceFailureOf('llm', 'openai', status(404, 'The model `gpt-9` does not exist')).reason).toBe('not_found')
  expect(voiceFailureOf('stt', 'deepgram', new APITimeoutError({})).reason).toBe('timeout')
  expect(
    voiceFailureOf(
      'tts',
      'elevenlabs',
      new APIConnectionError({ message: 'TTS stream completed but no audio was received' }),
    ).reason,
  ).toBe('no_output')
  expect(voiceFailureOf('realtime', 'openai_realtime', new Error('socket hang up')).reason).toBe('unknown')
  expect(voiceFailureOf('stt', 'deepgram', new APIConnectionError({})).reason).toBe('network')
  expect(voiceFailureOf('llm', 'openai', new Error('something odd')).reason).toBe('unknown')
})

test('a key in the provider text never reaches the message', () => {
  const failure = voiceFailureOf('llm', 'openai', status(401, 'Incorrect API key provided: sk-secret-0123456789'), [
    'sk-secret-0123456789',
  ])
  expect(failure.message).not.toContain('sk-secret-0123456789')
  expect(failure.message).toContain('[redacted]')
})

test('each stage is logged and reported once per call, in one line', () => {
  const report = vi.fn()
  const log = vi.fn()
  const once = onceEachStage(report, log)
  const quota = { stage: 'tts', provider: 'elevenlabs', reason: 'quota', message: 'quota_exceeded' } as const
  once(quota)
  once({ ...quota, reason: 'no_output' })
  once({ stage: 'llm', provider: 'openrouter', reason: 'auth', message: 'refused' })
  expect(report).toHaveBeenCalledTimes(2)
  expect(log.mock.calls.map(c => c[0])).toEqual([
    'voice elevenlabs failed (quota): quota_exceeded',
    'language model openrouter failed (auth): refused',
  ])
})

function watched(providers: Parameters<typeof watchVoicePipeline>[1]) {
  const session = new EventEmitter()
  const report = vi.fn()
  watchVoicePipeline(session as never, providers, report)
  return { session, report }
}

test('errors of every stage become failures with the provider in use', () => {
  const { session, report } = watched({ stt: 'deepgram', llm: 'openrouter', tts: 'elevenlabs' })
  const error = (type: string, cause: Error) => ({
    error: { type, label: 'x', error: cause, recoverable: false, timestamp: 0 },
  })
  session.emit(E.Error, error('stt_error', status(402, 'Payment Required')))
  session.emit(
    E.Error,
    error('tts_error', new APIConnectionError({ message: 'TTS synthesis completed but no audio was received' })),
  )
  session.emit(E.Error, error('llm_error', status(401, 'invalid api key')))
  expect(report.mock.calls.map(c => [c[0].stage, c[0].provider, c[0].reason])).toEqual([
    ['stt', 'deepgram', 'quota'],
    ['tts', 'elevenlabs', 'no_output'],
    ['llm', 'openrouter', 'auth'],
  ])
  const realtime = watched({ realtime: 'openai_realtime' })
  realtime.session.emit(E.Error, error('realtime_model_error', status(429, 'You exceeded your current quota')))
  expect(realtime.report.mock.calls[0]![0]).toMatchObject({
    stage: 'realtime',
    provider: 'openai_realtime',
    reason: 'quota',
  })
})

test('an empty reply of the language model is a failure; a cancelled one or one that said something is not', () => {
  const { session, report } = watched({ llm: 'openrouter' })
  const llm = (ttftMs: number, cancelled = false) => ({ metrics: { type: 'llm_metrics', ttftMs, cancelled } })
  session.emit(E.MetricsCollected, llm(420))
  session.emit(E.MetricsCollected, llm(-1, true))
  expect(report).not.toHaveBeenCalled()
  session.emit(E.MetricsCollected, llm(-1))
  expect(report.mock.calls[0]![0]).toMatchObject({ stage: 'llm', provider: 'openrouter', reason: 'no_output' })
})

test('a turn that only called tools that do not exist or with wrong arguments is a failure; a tool that ran is not', () => {
  const { session, report } = watched({ llm: 'openrouter' })
  const outputs = (...list: [string, boolean][]) => ({
    functionCalls: [],
    functionCallOutputs: list.map(([output, isError]) => ({ output, isError })),
  })
  session.emit(E.FunctionToolsExecuted, outputs(['Took the message', false]))
  session.emit(
    E.FunctionToolsExecuted,
    outputs(['Unknown function: book_flight - available tools: take_message', true], ['booking failed', true]),
  )
  expect(report).not.toHaveBeenCalled()
  session.emit(
    E.FunctionToolsExecuted,
    outputs(
      ['Unknown function: book_flight - available tools: take_message', true],
      ['Invalid arguments for take_message: missing message', true],
    ),
  )
  expect(report.mock.calls[0]![0]).toMatchObject({ stage: 'llm', reason: 'no_output' })
})
