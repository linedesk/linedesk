import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DEFAULT_SILENCE_CLOSING } from '@linedesk/actions'
import { voice } from '@livekit/agents'
import { hangUpAfterLine, hangUpAfterSpeech, hangUpAtCallLimit, remindOnSilence, silencePolicyOf, silenceSchedule } from './hang-up.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const agent = (agentState: string, { spoke = false, onDone = (_: () => void) => {} } = {}) => ({ agentState, onDone, spokeWithin: () => spoke })

test('hangs up shortly after the goodbye has played, not during it', () => {
  let done: () => void = () => {}
  const hangUp = vi.fn()
  hangUpAfterSpeech(agent('speaking', { onDone: l => (done = l) }), hangUp)
  vi.advanceTimersByTime(2000)
  expect(hangUp).not.toHaveBeenCalled()
  done()
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(10_000)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('end_call right after the goodbye played hangs up without another word; a stuck goodbye is cut at the cap', () => {
  const quiet = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  hangUpAfterSpeech(agent('listening', { spoke: true }), quiet, sayGoodbye)
  vi.advanceTimersByTime(1900)
  expect(quiet).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()

  const stuck = vi.fn()
  hangUpAfterSpeech(agent('speaking'), stuck, undefined, 6000)
  vi.advanceTimersByTime(5999)
  expect(stuck).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(stuck).toHaveBeenCalledOnce()
})

test('end_call with nothing said before: the assistant says goodbye first, never ends in silence', async () => {
  const hangUp = vi.fn()
  let played: () => void = () => {}
  const sayGoodbye = vi.fn(() => new Promise<void>(resolve => (played = resolve)))
  hangUpAfterSpeech(agent('listening'), hangUp, sayGoodbye)
  await vi.advanceTimersByTimeAsync(1500)
  expect(sayGoodbye).toHaveBeenCalledOnce()
  expect(hangUp).not.toHaveBeenCalled()
  played()
  await vi.advanceTimersByTimeAsync(0)
  expect(hangUp).toHaveBeenCalledOnce()
})

test('end_call while the model still thinks up its goodbye: waits for it and adds no goodbye of its own', () => {
  let done: () => void = () => {}
  let spoke = false
  const hangUp = vi.fn()
  const sayGoodbye = vi.fn(async () => {})
  hangUpAfterSpeech({ agentState: 'thinking', onDone: l => (done = l), spokeWithin: () => spoke }, hangUp, sayGoodbye)
  vi.advanceTimersByTime(1500)
  expect(hangUp).not.toHaveBeenCalled()
  spoke = true // "Goodbye." played
  done()
  vi.advanceTimersByTime(400)
  expect(hangUp).toHaveBeenCalledOnce()
  expect(sayGoodbye).not.toHaveBeenCalled()
})

function userStates() {
  const listeners: ((ev: { newState: string }) => void)[] = []
  const session = { on: (event: string, listener: (ev: { newState: string }) => void) => event === voice.AgentSessionEventTypes.UserStateChanged && listeners.push(listener) }
  return { session: session as never, emit: (newState: string) => listeners.forEach(l => l({ newState })) }
}

test('silence settings: defaults on (8 s, 2 reminders, the default closing), each from the assistant when set', () => {
  expect(silencePolicyOf(null)).toEqual({ firstGapS: 8, reminders: 2, closing: DEFAULT_SILENCE_CLOSING })
  expect(silencePolicyOf({ silence_first_gap_s: 5, silence_reminders: 0, silence_closing: '  Bye now.  ' })).toEqual({ firstGapS: 5, reminders: 0, closing: 'Bye now.' })
  expect(silencePolicyOf({ silence_closing: ' ' }).closing).toBe(DEFAULT_SILENCE_CLOSING)
  // 8 s quiet, ask; 16 s more, ask; 32 s more, the closing line.
  expect(silenceSchedule({ firstGapS: 8, reminders: 2 })).toEqual([8, 16, 32])
})

test('silence: reminders with the gap doubling, then the closing line, once', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  // The session reports "away" after the first gap (its away timeout).
  remindOnSilence(session, { firstGapS: 8, reminders: 2 }, { remind, close, transferred: () => false })
  emit('away')
  expect(remind).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(16_000 - 1)
  expect(remind).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1)
  expect(remind).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(32_000 - 1)
  expect(close).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(close).toHaveBeenCalledOnce()
  emit('away')
  vi.advanceTimersByTime(120_000)
  expect(close).toHaveBeenCalledOnce()
  expect(remind).toHaveBeenCalledTimes(2)
})

test('a caller who answers stays on, and the reminders start over at the next silence', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  remindOnSilence(session, { firstGapS: 8, reminders: 2 }, { remind, close, transferred: () => false })
  emit('away')
  vi.advanceTimersByTime(16_000) // second reminder
  emit('speaking')
  vi.advanceTimersByTime(120_000)
  expect(close).not.toHaveBeenCalled()
  emit('listening')
  emit('away')
  expect(remind).toHaveBeenCalledTimes(3)
  vi.advanceTimersByTime(16_000 + 32_000)
  expect(remind).toHaveBeenCalledTimes(4)
  expect(close).toHaveBeenCalledOnce()
})

test('no reminders: the closing line right after the first gap', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  remindOnSilence(session, { firstGapS: 8, reminders: 0 }, { remind, close, transferred: () => false })
  emit('away')
  expect(remind).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test('never during or after a transfer: no reminder, no closing line, the call stays up', () => {
  const { session, emit } = userStates()
  const remind = vi.fn()
  const close = vi.fn()
  let transferred = false
  remindOnSilence(session, { firstGapS: 8, reminders: 2 }, { remind, close, transferred: () => transferred })
  emit('away')
  transferred = true // put through while the reminders run
  vi.advanceTimersByTime(60 * 60_000)
  emit('listening')
  emit('away')
  vi.advanceTimersByTime(60 * 60_000)
  expect(remind).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})

test('the assistant says goodbye at its time limit, unless the call was put through to a person', () => {
  const goodbye = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye, transferred: () => false })
  vi.advanceTimersByTime(25 * 60_000 - 1)
  expect(goodbye).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(goodbye).toHaveBeenCalledOnce()

  const notAfterTransfer = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye: notAfterTransfer, transferred: () => true })
  const cancelled = vi.fn()
  hangUpAtCallLimit(25 * 60_000, { goodbye: cancelled, transferred: () => false })()
  vi.advanceTimersByTime(30 * 60_000)
  expect(notAfterTransfer).not.toHaveBeenCalled()
  expect(cancelled).not.toHaveBeenCalled()
})

test('a fixed line hangs up once it has played, or at the latest after the cap', async () => {
  const played = vi.fn()
  hangUpAfterLine(Promise.resolve(), played)
  await vi.advanceTimersByTimeAsync(0)
  expect(played).toHaveBeenCalledOnce()

  const stuck = vi.fn()
  hangUpAfterLine(new Promise(() => {}), stuck, 15_000)
  await vi.advanceTimersByTimeAsync(14_999)
  expect(stuck).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(stuck).toHaveBeenCalledOnce()

  const failed = vi.fn()
  hangUpAfterLine(Promise.reject(new Error('tts down')), failed)
  await vi.advanceTimersByTimeAsync(0)
  expect(failed).toHaveBeenCalledOnce()
})
