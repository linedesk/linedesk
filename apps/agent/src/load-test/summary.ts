// Load test: turns the samples of the business agent's container and the calls' results into one row per level.
import type { CallResult } from './calls.ts'

/** One look at the container: CPU in cores (1 = one core busy), memory as docker counts it, and each process's RSS. */
export type Sample = { at: number; cpuCores: number; memMb: number; processMb: number[] }

export type LevelSummary = {
  calls: number
  answered: number
  baselineMb: number
  peakMb: number
  /** (peak − before) / answered calls. */
  perCallMb: number | null
  afterMb: number
  peakCpu: number
  meanCpu: number
  /** Agent processes (50 MB or more) at the busiest moment, warm ones included. */
  peakProcesses: number
  largestProcessMb: number
  greetingP50: number | null
  greetingMax: number | null
  replyP50: number | null
  replyP95: number | null
}

/** Processes this big are the worker and its job processes; the shell and the dev watcher stay below. */
const AGENT_PROCESS_MB = 50

const UNITS: Record<string, number> = {
  B: 1 / 2 ** 20,
  KiB: 1 / 1024,
  kB: 1 / 1024,
  MiB: 1,
  MB: 1,
  GiB: 1024,
  GB: 1024,
}

const toMb = (text: string) => {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim())
  if (!match || UNITS[match[2]!] === undefined) throw new Error(`unexpected memory value from docker stats: ${text}`)
  return Number(match[1]) * UNITS[match[2]!]!
}

/** `docker stats` with the format `{{.CPUPerc}}|{{.MemUsage}}`, e.g. "123.4%|1.2GiB / 4GiB". */
export function parseDockerStats(line: string): { cpuCores: number; memMb: number } {
  const [cpu, mem] = line.trim().split('|')
  if (!cpu || !mem) throw new Error(`unexpected docker stats line: ${line}`)
  return { cpuCores: Number(cpu.replace('%', '')) / 100, memMb: toMb(mem.split('/')[0]!) }
}

/** `VmRSS:   193164 kB` lines from /proc/<pid>/status, in MB. */
export const parseRss = (text: string) => [...text.matchAll(/VmRSS:\s+(\d+)\s*kB/g)].map(m => Number(m[1]) / 1024)

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

export function summarizeLevel(
  calls: number,
  results: CallResult[],
  baseline: Sample,
  during: Sample[],
  after: Sample,
): LevelSummary {
  const all = [baseline, ...during]
  const answered = results.filter(r => r.answered)
  const peakMb = Math.max(...all.map(s => s.memMb))
  const greetings = answered.flatMap(r => (r.greetingMs === null ? [] : [r.greetingMs]))
  const replies = answered.flatMap(r => r.replyMs)
  const agentProcesses = (s: Sample) => s.processMb.filter(mb => mb >= AGENT_PROCESS_MB)
  return {
    calls,
    answered: answered.length,
    baselineMb: baseline.memMb,
    peakMb,
    perCallMb: answered.length ? (peakMb - baseline.memMb) / answered.length : null,
    afterMb: after.memMb,
    peakCpu: Math.max(...all.map(s => s.cpuCores)),
    meanCpu: during.length ? during.reduce((sum, s) => sum + s.cpuCores, 0) / during.length : 0,
    peakProcesses: Math.max(...all.map(s => agentProcesses(s).length)),
    largestProcessMb: Math.max(0, ...all.flatMap(s => s.processMb)),
    greetingP50: percentile(greetings, 50),
    greetingMax: greetings.length ? Math.max(...greetings) : null,
    replyP50: percentile(replies, 50),
    replyP95: percentile(replies, 95),
  }
}

const mb = (v: number | null) => (v === null ? '–' : `${Math.round(v)} MB`)
const sec = (v: number | null) => (v === null ? '–' : `${(v / 1000).toFixed(2)} s`)

export function formatSummaries(rows: LevelSummary[]): string {
  const head =
    '| Calls | Answered | Before | Peak | Per call | After | CPU peak / mean (cores) | Processes | Largest | Greeting p50 / max | Reply p50 / p95 |'
  const lines = rows.map(
    r =>
      `| ${r.calls} | ${r.answered} | ${mb(r.baselineMb)} | ${mb(r.peakMb)} | ${mb(r.perCallMb)} | ${mb(r.afterMb)} | ${r.peakCpu.toFixed(2)} / ${r.meanCpu.toFixed(2)} | ${r.peakProcesses} | ${mb(r.largestProcessMb)} | ${sec(r.greetingP50)} / ${sec(r.greetingMax)} | ${sec(r.replyP50)} / ${sec(r.replyP95)} |`,
  )
  return [head, `|${'---|'.repeat(11)}`, ...lines].join('\n')
}
