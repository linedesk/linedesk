import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AGENT_LEFT_GRACE_MS,
  agentLeftText,
  noPickupText,
  PICKUP_TIMEOUT_MS,
  TEST_CALL_TIMEOUT_MS,
  TimedOut,
  testCallErrorText,
  watchPickup,
  within,
} from './testCallModel.ts'

test('a connection that never answers ends after the timeout', async () => {
  vi.useFakeTimers()
  const hung = within(new Promise(() => {}), TEST_CALL_TIMEOUT_MS)
  const seen = hung.catch(e => e)
  await vi.advanceTimersByTimeAsync(TEST_CALL_TIMEOUT_MS)
  expect(await seen).toBeInstanceOf(TimedOut)
  vi.useRealTimers()
})

test('an answer in time passes through', async () => {
  await expect(within(Promise.resolve('room'), 1000)).resolves.toBe('room')
})

test('server refusals never name LiveKit or settings', () => {
  expect(testCallErrorText('test calls are not set up: LiveKit is not configured on the server')).not.toMatch(/LiveKit/)
  expect(testCallErrorText('Too many test calls in a short time. Try again in a few minutes.')).toMatch(/few minutes/)
  expect(testCallErrorText('')).toMatch(/Try again/)
})

test('the daily limits are shown as the server words them', () => {
  for (const limit of [
    'You made 20 test calls today. Try again tomorrow.',
    'This server has had as many test calls today as it allows. Try again tomorrow.',
    'This workspace reached its monthly spending cap, so test calls are off until next month.',
  ])
    expect(testCallErrorText(limit)).toBe(limit)
})

test('nobody to answer: the server says why to the operator and plainly to everyone else, both shown as they are', () => {
  for (const refusal of [
    "The voice agent isn't running on this server. Start the agent worker; Server admin › Overview shows its health.",
    'The voice agent has nothing to answer with: connect speech to text, a language model and a voice (or a realtime model) under Server admin › Providers.',
    "Test calls aren't available on this server right now. Ask whoever runs it.",
  ])
    expect(testCallErrorText(refusal)).toBe(refusal)
})

test('no pickup and dropping out: the operator is pointed at the agent, nobody else at internals', () => {
  expect(noPickupText('Maya', true)).toMatch(/^Maya didn't pick up\..*Server admin › Overview/)
  expect(noPickupText('Maya', false)).toMatch(/^Maya didn't pick up\./)
  expect(agentLeftText('Maya', true)).toMatch(/^Maya left the call unexpectedly\..*Server admin › Overview/)
  for (const text of [noPickupText('Maya', false), agentLeftText('Maya', false)])
    expect(text).not.toMatch(/agent|Admin|LiveKit/)
})

describe('watchPickup', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  const watch = () => {
    const on = { noPickup: vi.fn(), agentLeft: vi.fn() }
    return { on, w: watchPickup(on) }
  }

  test('nobody joins: no pickup after a few seconds, once', () => {
    const { on, w } = watch()
    w.start()
    vi.advanceTimersByTime(PICKUP_TIMEOUT_MS - 1)
    expect(on.noPickup).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS)
    expect(on.noPickup).toHaveBeenCalledTimes(1)
  })

  test('the clocks start with start(), not before', () => {
    const { on } = watch()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS * 2)
    expect(on.noPickup).not.toHaveBeenCalled()
  })

  test('joined but silent: no pickup once the longer wait is over', () => {
    const { on, w } = watch()
    w.start()
    w.joined()
    vi.advanceTimersByTime(PICKUP_TIMEOUT_MS)
    expect(on.noPickup).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS - PICKUP_TIMEOUT_MS)
    expect(on.noPickup).toHaveBeenCalledTimes(1)
  })

  test('heard, even before the start: nothing fires', () => {
    const { on, w } = watch()
    w.heard()
    w.start()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS * 2)
    expect(on.noPickup).not.toHaveBeenCalled()
    expect(on.agentLeft).not.toHaveBeenCalled()
  })

  test('the assistant leaves and the call goes on: it dropped out', () => {
    const { on, w } = watch()
    w.start()
    w.heard()
    w.left()
    vi.advanceTimersByTime(AGENT_LEFT_GRACE_MS)
    expect(on.agentLeft).toHaveBeenCalledTimes(1)
    expect(on.noPickup).not.toHaveBeenCalled()
  })

  test('the assistant leaves and the call ends (a normal hang-up): nothing fires', () => {
    const { on, w } = watch()
    w.start()
    w.heard()
    w.left()
    vi.advanceTimersByTime(AGENT_LEFT_GRACE_MS - 1)
    w.stop()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS)
    expect(on.agentLeft).not.toHaveBeenCalled()
    expect(on.noPickup).not.toHaveBeenCalled()
  })

  test('stopped before anyone joined (hang-up, cancel): nothing fires', () => {
    const { on, w } = watch()
    w.start()
    w.stop()
    vi.advanceTimersByTime(TEST_CALL_TIMEOUT_MS)
    expect(on.noPickup).not.toHaveBeenCalled()
  })
})
