import { describe, expect, it } from 'vitest'
import type { CallResult } from './calls.ts'
import {
  abortReasons,
  callerOverload,
  formatCallerLoad,
  parsePressureTotal,
  parseDockerStats,
  parseRss,
  percentile,
  type Sample,
  summarizeCalls,
  summarizeLevel,
} from './summary.ts'

describe('load test summary', () => {
  it('reads docker stats in any unit', () => {
    expect(parseDockerStats('123.4%|1.5GiB / 4GiB\n')).toEqual({ cpuCores: 1.234, memMb: 1536 })
    expect(parseDockerStats('0.5%|512MiB / 1.5GiB').memMb).toBe(512)
    expect(parseDockerStats('0%|2048KiB / 1GiB').memMb).toBe(2)
    expect(() => parseDockerStats('nonsense')).toThrow()
  })

  it('reads RSS lines in MB', () => {
    expect(parseRss('VmRSS:\t  193164 kB\nVmRSS:\t 1024 kB\n')).toEqual([188.63671875, 1])
  })

  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([3, 1, 2, 4], 50)).toBe(2)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })

  it('counts memory per answered call against the level before', () => {
    const s = (memMb: number, cpuCores = 0.1, processMb = [190, 190, 1]): Sample => ({
      at: 0,
      memMb,
      cpuCores,
      processMb,
    })
    const call = (index: number, answered: boolean): CallResult => ({
      index,
      room: `r${index}`,
      to: '+15035550100',
      answered,
      greetingMs: answered ? 1200 + index : null,
      heardGreetingMs: null,
      pickupMs: null,
      replyMs: [800],
      durationMs: 60_000,
      dialFailed: false,
    })
    const row = summarizeLevel(
      3,
      [call(0, true), call(1, true), call(2, false)],
      s(600),
      [s(900, 1.5, [190, 300, 300, 1]), s(1000, 0.5)],
      s(650),
      1,
    )
    expect(row).toMatchObject({
      answered: 2,
      talked: 2,
      oomKills: 1,
      peakMb: 1000,
      perCallMb: 200,
      afterMb: 650,
      peakCpu: 1.5,
      meanCpu: 1,
      peakProcesses: 3,
      largestProcessMb: 300,
      greetingP50: 1200,
      greetingMax: 1201,
      replyP50: 800,
    })
  })

  const phoneCall = (index: number, over: Partial<CallResult> = {}): CallResult => ({
    index,
    room: `load-test-abc-0-${index}`,
    to: '+15035550100',
    answered: true,
    greetingMs: null,
    heardGreetingMs: 2000 + index * 100,
    pickupMs: 900,
    replyMs: [700 + index, 900],
    durationMs: 60_000,
    dialFailed: false,
    ...over,
  })

  it('sums up what the callers saw in a level', () => {
    const results = [
      phoneCall(0),
      phoneCall(1),
      phoneCall(2, { heardGreetingMs: null, replyMs: [], error: 'no business audio heard' }),
      phoneCall(3, {
        answered: false,
        heardGreetingMs: null,
        pickupMs: null,
        replyMs: [],
        dialFailed: true,
        error: 'dial: 486 busy',
      }),
    ]
    expect(summarizeCalls(4, results)).toEqual({
      level: 4,
      calls: 4,
      answered: 3,
      answeredPct: 75,
      heardGreetingP50: 2000,
      heardGreetingP95: 2100,
      replyP50: 701,
      replyP95: 900,
      dialFailed: 1,
      failures: ['call 2: no business audio heard', 'call 3: dial: 486 busy'],
    })
  })

  it('counts calls that printed no result as not answered', () => {
    expect(summarizeCalls(4, [phoneCall(0), phoneCall(1)]).answeredPct).toBe(50)
  })

  it('goes on after a good level, stops after a bad one and says why', () => {
    const good = summarizeCalls(
      10,
      Array.from({ length: 10 }, (_, i) => phoneCall(i)),
    )
    expect(abortReasons(good)).toEqual([])
    // 9 of 10 answered is exactly 90 %: still fine.
    const nine = summarizeCalls(
      10,
      Array.from({ length: 9 }, (_, i) => phoneCall(i)),
    )
    expect(abortReasons(nine)).toEqual([])
    const few = summarizeCalls(
      10,
      Array.from({ length: 8 }, (_, i) => phoneCall(i)),
    )
    expect(abortReasons(few)).toEqual(['answered 80 % (8 of 10), below 90 %'])
    const slow = summarizeCalls(2, [phoneCall(0, { heardGreetingMs: 3600 }), phoneCall(1, { heardGreetingMs: 3700 })])
    expect(abortReasons(slow)).toEqual(['greeting p50 3.60 s, above 3.50 s'])
    const atLimit = summarizeCalls(1, [phoneCall(0, { heardGreetingMs: 3500 })])
    expect(abortReasons(atLimit)).toEqual([])
    const results = [
      ...Array.from({ length: 19 }, (_, i) => phoneCall(i)),
      phoneCall(19, { answered: false, dialFailed: true, error: 'dial: x' }),
    ]
    expect(abortReasons(summarizeCalls(20, results))).toEqual(['1 call(s) could not be dialled'])
  })

  it('reads the stall total of a cgroup pressure file', () => {
    expect(
      parsePressureTotal('some avg10=8.67 avg60=16.24 avg300=5.28 total=17807725\nfull avg10=6.59 total=12750722\n'),
    ).toBe(17807725)
    expect(parsePressureTotal('')).toBeNull()
  })

  it('tells when the callers were short of CPU or memory', () => {
    const fine = { peakCpu: 1.2, cores: 4, peakMb: 1500, limitMb: 4096, cpuStallPct: 3, memStallPct: 0, oomKills: 0 }
    expect(callerOverload(fine)).toEqual([])
    expect(callerOverload({ ...fine, cpuStallPct: null, memStallPct: null })).toEqual([])
    expect(callerOverload({ ...fine, cpuStallPct: 45, memStallPct: 9, peakMb: 3900, oomKills: 1 })).toEqual([
      'the callers waited for a CPU 45 % of the time',
      'the callers waited for memory 9 % of the time',
      'the callers used 3900 MB of their 4096 MB',
      '1 caller process(es) killed for memory',
    ])
    expect(formatCallerLoad(fine)).toContain('CPU peak 1.20 of 4 cores, waited for CPU 3 %')
  })
})
