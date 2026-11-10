import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hangUpAfterSpeech } from './hang-up.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('hangs up shortly after the goodbye has played, not during it', () => {
  let done: () => void = () => {}
  const hangUp = vi.fn()
  hangUpAfterSpeech({ agentState: 'speaking', onDone: l => (done = l) }, hangUp)
  vi.advanceTimersByTime(2000)
  expect(hangUp).not.toHaveBeenCalled()
  done()
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(10_000)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('hangs up at once when not speaking, and at the latest after the cap', () => {
  const quiet = vi.fn()
  hangUpAfterSpeech({ agentState: 'listening', onDone: () => {} }, quiet)
  vi.advanceTimersByTime(400)
  expect(quiet).toHaveBeenCalledOnce()

  const stuck = vi.fn()
  hangUpAfterSpeech({ agentState: 'speaking', onDone: () => {} }, stuck, 6000)
  vi.advanceTimersByTime(5999)
  expect(stuck).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(stuck).toHaveBeenCalledOnce()
})
