import { EventEmitter } from 'node:events'
import { voice } from '@livekit/agents'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EMPTY_REPLY_RETRY, retryEmptyReplies } from './empty-reply.ts'

const E = voice.AgentSessionEventTypes
const llm = (ttftMs: number, cancelled = false) => ({ metrics: { type: 'llm_metrics', ttftMs, cancelled } })

function fakeSession() {
  const session = Object.assign(new EventEmitter(), {
    agentState: 'listening',
    userState: 'listening',
    generateReply: vi.fn(),
  })
  retryEmptyReplies(session as never, 10)
  return session
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('an empty reply is asked again at once, with other words', () => {
  const session = fakeSession()
  session.emit(E.MetricsCollected, llm(420))
  session.emit(E.MetricsCollected, llm(-1, true))
  vi.advanceTimersByTime(20)
  expect(session.generateReply).not.toHaveBeenCalled()
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  expect(session.generateReply).toHaveBeenCalledExactlyOnceWith({ instructions: EMPTY_REPLY_RETRY })
})

test('the retry is not retried; the next empty reply after a real one is', () => {
  const session = fakeSession()
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  expect(session.generateReply).toHaveBeenCalledTimes(1)
  session.emit(E.MetricsCollected, llm(380))
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  expect(session.generateReply).toHaveBeenCalledTimes(2)
})

test('not while the caller talks or the assistant is speaking, and a closed session does not throw', () => {
  const session = fakeSession()
  session.userState = 'speaking'
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  session.userState = 'listening'
  session.agentState = 'speaking'
  session.emit(E.MetricsCollected, llm(-1))
  vi.advanceTimersByTime(20)
  expect(session.generateReply).not.toHaveBeenCalled()
  session.agentState = 'listening'
  session.generateReply.mockImplementation(() => {
    throw new Error('AgentSession is closing')
  })
  session.emit(E.MetricsCollected, llm(-1))
  expect(() => vi.advanceTimersByTime(20)).not.toThrow()
})
