import { describe, expect, it } from 'vitest'
import { parseDockerStats, parseRss, percentile, type Sample, summarizeLevel } from './summary.ts'

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
    const call = (index: number, answered: boolean) => ({
      index,
      room: `r${index}`,
      answered,
      greetingMs: answered ? 1200 + index : null,
      replyMs: [800],
      durationMs: 60_000,
    })
    const row = summarizeLevel(
      3,
      [call(0, true), call(1, true), call(2, false)],
      s(600),
      [s(900, 1.5, [190, 300, 300, 1]), s(1000, 0.5)],
      s(650),
    )
    expect(row).toMatchObject({
      answered: 2,
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
})
