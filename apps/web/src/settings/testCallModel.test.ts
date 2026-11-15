import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AGENT_LEFT_GRACE_MS,
  ANSWER_TIMEOUT_MS,
  agentLeftText,
  noJoinText,
  noPickupText,
  PICKUP_TIMEOUT_MS,
  prepareStart,
  SLOW_JOIN_MS,
  TEST_CALL_TIMEOUT_MS,
  TimedOut,
  testCallErrorText,
  waitText,
  watchPickup,
  within,
} from './testCallModel.ts'

describe('the start of a test call says what it waits for', () => {
  // Production, 2026-11-15: about 15 s of "Connecting your microphone…" on a slow network, most of it spent reaching
  // the assistant, which read like a microphone problem.
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  test('the microphone first, then reaching the assistant; the call library loads during the permission prompt', async () => {
    const mic = deferred<string | null>()
    const lib = deferred<string>()
    const library = vi.fn(() => lib.promise)
    const steps: string[] = []
    const prepared = prepareStart({ microphone: () => mic.promise, library, step: s => steps.push(s) })
    expect(steps).toEqual(['microphone'])
    expect(library).toHaveBeenCalledOnce() // not after the microphone: side by side
    mic.resolve(null)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(steps).toEqual(['microphone', 'connecting'])
    lib.resolve('livekit')
    await expect(prepared).resolves.toEqual({ library: 'livekit' })
  })

  test('a refused microphone is said, never a library problem; a library that fails after it is', async () => {
    const steps: string[] = []
    const refused = await prepareStart({
      microphone: async () => 'Microphone blocked',
      library: () => Promise.reject(new Error('offline')),
      step: s => steps.push(s),
    })
    expect(refused).toEqual({ problem: 'Microphone blocked' })
    expect(steps).toEqual(['microphone'])
    const failed = await prepareStart({
      microphone: async () => null,
      library: () => Promise.reject(new Error('offline')),
      step: () => {},
    })
    expect(failed).toEqual({ problem: expect.any(String) })
    expect((failed as { problem: string }).problem).not.toMatch(/offline/)
  })

  test('a permission prompt nobody answers ends the start', async () => {
    vi.useFakeTimers()
    const prepared = prepareStart({
      microphone: () => new Promise(() => {}),
      library: async () => 'lk',
      step: () => {},
      timeoutMs: 1000,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await prepared).toEqual({ problem: expect.any(String) })
    vi.useRealTimers()
  })

  test('the panel line: microphone, then the assistant by name, still connecting when slow, then waiting for the answer', () => {
    const at = (phase: 'starting' | 'live', step: 'microphone' | 'connecting', stillConnecting = false) =>
      waitText({ phase, step, stillConnecting, name: 'Maya' })
    expect(at('starting', 'microphone')).toBe('Connecting your microphone…')
    expect(at('starting', 'connecting')).toBe('Connecting to Maya…')
    expect(at('starting', 'connecting', true)).toBe('Still connecting…')
    expect(at('live', 'connecting')).toBe('Waiting for Maya to answer…')
    expect(at('live', 'connecting', true)).toBe('Still connecting…')
  })
})

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

test('no agent joined: the operator learns the voice agent is down or the server overloaded, and where to look', () => {
  expect(noJoinText('Maya', true)).toBe(
    "Maya didn't join. The voice agent is not running or the server is overloaded. Check Server admin › Overview (Voice agent, Answering calls).",
  )
  expect(noJoinText('Maya', false)).toMatch(/^Maya didn't join\./)
  expect(noJoinText('Maya', false)).not.toMatch(/agent|Admin|LiveKit|overloaded/)
})

test('a member who does not run the server is told to ask the server admin', () => {
  for (const text of [noJoinText('Maya', false), noPickupText('Maya', false)]) {
    expect(text).toMatch(/ask your server admin/)
    expect(text).not.toMatch(/whoever/)
  }
})

describe('watchPickup', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  const watch = () => {
    const on = { noJoin: vi.fn(), noPickup: vi.fn(), agentLeft: vi.fn(), slow: vi.fn() }
    return { on, w: watchPickup(on) }
  }

  test('nobody joins: "still connecting" after 8 seconds, "didn\'t join" after 20, once, and nothing else', () => {
    const { on, w } = watch()
    w.start()
    expect(SLOW_JOIN_MS).toBe(8_000)
    expect(PICKUP_TIMEOUT_MS).toBe(20_000)
    vi.advanceTimersByTime(SLOW_JOIN_MS - 1)
    expect(on.slow).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(on.slow).toHaveBeenLastCalledWith(true)
    expect(on.noJoin).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PICKUP_TIMEOUT_MS - SLOW_JOIN_MS - 1)
    expect(on.noJoin).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(on.noJoin).toHaveBeenCalledTimes(1)
    expect(on.slow).toHaveBeenLastCalledWith(false)
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS)
    expect(on.noJoin).toHaveBeenCalledTimes(1)
    expect(on.noPickup).not.toHaveBeenCalled()
    expect(on.agentLeft).not.toHaveBeenCalled()
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
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS - PICKUP_TIMEOUT_MS)
    expect(on.noPickup).toHaveBeenCalledTimes(1)
    expect(on.noJoin).not.toHaveBeenCalled()
    expect(on.slow).not.toHaveBeenCalled()
  })

  test('a slow join (as on a busy server) is no failure: "still connecting", then the call goes on', () => {
    const { on, w } = watch()
    w.start()
    vi.advanceTimersByTime(PICKUP_TIMEOUT_MS - 1_000)
    expect(on.slow).toHaveBeenLastCalledWith(true)
    w.joined()
    expect(on.slow).toHaveBeenLastCalledWith(false)
    // A late join still leaves time for the greeting: heard 8 seconds after it, past the 20 s join limit.
    vi.advanceTimersByTime(8_000)
    w.heard()
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS)
    expect(on.noJoin).not.toHaveBeenCalled()
    expect(on.noPickup).not.toHaveBeenCalled()
    expect(on.slow).toHaveBeenCalledTimes(2)
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
    expect(on.noJoin).not.toHaveBeenCalled()
  })
})

test('the waiting lines of the test call panel are muted, not red: waiting is no error (Settings and the setup page)', () => {
  const css = readFileSync(new URL('./test-call-panel.css', import.meta.url), 'utf8')
  const start = css.indexOf('.tcp-wait {')
  const rule = css.slice(start, css.indexOf('}', start))
  expect(rule).toContain('color: var(--ink-muted)')
  expect(rule).not.toContain('--danger')
})
