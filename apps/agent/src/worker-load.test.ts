import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_LOAD_THRESHOLD,
  describeLoadPolicy,
  describeProcessWait,
  loadPolicy,
  MAX_REPORTED_LOAD,
  reportedLoad,
  START_GRACE_MS,
} from './worker-load.ts'

describe('loadPolicy', () => {
  test('unset: the worker never refuses a call because of load', () => {
    for (const raw of [undefined, '', '  ']) {
      const policy = loadPolicy(raw)
      expect(policy).toEqual({ threshold: DEFAULT_LOAD_THRESHOLD, refuses: false, ignored: null })
      // Above the highest load the SDK reports (it clamps to 0..1).
      expect(policy.threshold).toBeGreaterThan(1)
    }
  })

  test('a load between 0 and 1 opts in to refusing (installs with more than one worker)', () => {
    expect(loadPolicy('0.8')).toEqual({ threshold: 0.8, refuses: true, ignored: null })
    expect(loadPolicy(' 0.95 ')).toEqual({ threshold: 0.95, refuses: true, ignored: null })
  })

  test('1 and above can never be reached: same as unset', () => {
    for (const raw of ['1', '1.01', '5'])
      expect(loadPolicy(raw)).toMatchObject({ threshold: DEFAULT_LOAD_THRESHOLD, refuses: false, ignored: null })
  })

  test('nonsense is ignored, said so at start, and never refuses', () => {
    for (const raw of ['abc', '0', '-1', 'Infinity']) {
      const policy = loadPolicy(raw)
      expect(policy).toMatchObject({ threshold: DEFAULT_LOAD_THRESHOLD, refuses: false, ignored: raw })
      expect(describeLoadPolicy(policy)).toContain('ignored')
    }
  })

  test('the start-up line says what applies', () => {
    expect(describeLoadPolicy(loadPolicy(undefined))).toMatch(/any CPU load.*only when more than one agent worker/)
    expect(describeLoadPolicy(loadPolicy('0.8'))).toMatch(/80% CPU load/)
  })
})

describe('reportedLoad', () => {
  const run = (raw: string | undefined, loads: number[], step = 2_500, graceMs = 0) => {
    let clock = 0
    const warn = vi.fn()
    const measure = vi.fn(async () => loads.shift() ?? 0)
    const fn = reportedLoad(measure, loadPolicy(raw), warn, () => clock, graceMs)
    return {
      warn,
      next: async () => {
        clock += step
        return fn(null)
      },
    }
  }

  test('by default LiveKit never sees a full load (it weighs workers by 1 - load)', async () => {
    const { next } = run(undefined, [0.3, 1, 0.999])
    expect(await next()).toBe(0.3)
    expect(await next()).toBe(MAX_REPORTED_LOAD)
    expect(await next()).toBe(MAX_REPORTED_LOAD)
    expect(MAX_REPORTED_LOAD).toBeLessThan(1)
  })

  test('opted in: the real load is reported', async () => {
    const { next } = run('0.8', [1])
    expect(await next()).toBe(1)
  })

  test('above 95%: a warning, at most once a minute, calls still answered', async () => {
    const busy = Array(60).fill(0.97)
    const { next, warn } = run(undefined, busy)
    for (let i = 0; i < 24; i++) await next() // just under a minute at one sample every 2.5 s
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/97%.*still answered/)
    await next()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  test('at or below 95%: no warning', async () => {
    const { next, warn } = run(undefined, [0.95, 0.5, 0.9])
    for (let i = 0; i < 3; i++) await next()
    expect(warn).not.toHaveBeenCalled()
  })

  test('opted in, just started: no refusing while the warm processes load (LIN-795)', async () => {
    const { next, warn } = run('0.8', Array(30).fill(1), 2_500, START_GRACE_MS)
    // Under the worker's own threshold (the SDK marks it full at load >= threshold), so LiveKit keeps giving it calls.
    for (let t = 2_500; t < START_GRACE_MS; t += 2_500) expect(await next()).toBeLessThan(0.8)
    expect(warn.mock.calls[0]?.[0]).toMatch(/still answered/)
    // From the end of the grace time on, the real load counts again.
    expect(await next()).toBe(1)
  })

  test('the grace time after start is a minute by default', () => {
    expect(START_GRACE_MS).toBe(60_000)
  })

  test('opted in and over the threshold: the warning says the worker takes no new calls', async () => {
    const { next, warn } = run('0.9', [0.98])
    await next()
    expect(warn.mock.calls[0]?.[0]).toMatch(/takes no new calls.*90%/)
  })
})

test("LiveKit's target_load has the agent's default and follows AGENT_LOAD_THRESHOLD (docker-compose.yml)", () => {
  const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')
  expect(compose).toContain(`target_load: \${AGENT_LOAD_THRESHOLD:-${DEFAULT_LOAD_THRESHOLD}}`)
  // The agent gets the same variable, empty when unset (its own default then applies).
  expect(compose).toContain('AGENT_LOAD_THRESHOLD: ${AGENT_LOAD_THRESHOLD:-}')
})

describe('describeProcessWait', () => {
  test('a warm process: the short hand-over', () => {
    expect(describeProcessWait({ receivedAt: 1_000, launchedAt: 1_004, launchedWarm: true })).toBe(
      'warm process after 4 ms',
    )
  })

  test('no warm process: the call waited for a new one to load', () => {
    expect(describeProcessWait({ receivedAt: 1_000, launchedAt: 6_120, launchedWarm: false })).toBe(
      'no warm process: waited 5120 ms for a new one',
    )
  })

  test('without the SDK timestamps: nothing to say', () => {
    expect(describeProcessWait({})).toBeNull()
    expect(describeProcessWait({ receivedAt: 1_000 })).toBeNull()
  })
})

test('the SDK starts warm processes in parallel, up to four (LIN-226)', async () => {
  // patches/@livekit__agents@*.patch: without it the SDK starts one at a time, and calls in a burst wait in turn.
  const { ProcPool } = await import(new URL('ipc/proc_pool.js', import.meta.resolve('@livekit/agents')).href)
  const pool = new ProcPool({ agent: 'unused', numIdleProcesses: 2 })
  // Only the SDK's MultiMutex has a limit; its plain Mutex (one at a time) has none.
  const limit = pool.initMutex._limit
  expect(limit).toBeGreaterThanOrEqual(1)
  expect(limit).toBeLessThanOrEqual(4)
})

test('while calls start, new warm processes wait; one loads when none is left; a waiting call ends the hold (LIN-485)', async () => {
  // patches/@livekit__agents@*.patch: refills compete with the new calls' setup for the CPU.
  const { ProcPool } = await import(new URL('ipc/proc_pool.js', import.meta.resolve('@livekit/agents')).href)
  const pool = new ProcPool({ agent: 'unused', numIdleProcesses: 2 })
  const settled = async (p: Promise<unknown>) => {
    let done = false
    void p.then(() => (done = true))
    await new Promise(r => setTimeout(r, 300)) // the hold looks again every 250 ms
    return done
  }
  // No call yet (the first fill at start-up): no hold.
  expect(await settled(pool.waitForQuiet())).toBe(true)

  // A call just started and one warm process is still there: the refill waits.
  pool.lastLaunchAt = Date.now()
  pool.warmedProcQueue.items.push({})
  const held = pool.waitForQuiet()
  expect(await settled(held)).toBe(false)
  // A call waits for a process: the hold ends.
  pool.waitingJobs = 1
  expect(await settled(held)).toBe(true)
  pool.waitingJobs = 0

  // None left: one loads at once, the next one waits for it.
  pool.warmedProcQueue.items.length = 0
  const first = await pool.waitForQuiet()
  const second = pool.waitForQuiet()
  expect(await settled(second)).toBe(false)
  first()
  first() // a second call does not free a second slot
  expect(pool.heldInits).toBe(0)
  expect(await settled(second)).toBe(true)
  pool.closed = true
})
