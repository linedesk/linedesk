// Load test: what N calls at once cost the agent, or (--remote) what another install's numbers do with N calls at once.
// Runs on the machine with the docker compose stack (a dev machine or a test server such as staging; the business side
// never on production): starts a second agent container that plays the test callers, then per level starts N test
// calls (load-test/calls.ts in the caller container) and prints one `LOADTEST {json}` line per call and a summary per
// level. Each call is billed on both sides (speech, model, voice): about a cent a minute per side, plus Telnyx for both
// legs of a phone call.
//   pnpm --filter @linedesk/agent load-test [--calls 1,5,10] [--scenario callback-message] [--spread 2]
//     [--pipeline realtime|three_stage] [--to <number>[,<number>…]] [--container linedesk-agent-1] [--memory 4g]
//     [--cpuset 1-3] [--caller-memory 3g] [--caller-cpuset 6-13] [--phone] [--remote] [--project linedesk] [--no-abort]
// Without --remote the local business agent is measured: its limits are raised for the test (--memory, --cpuset; e.g.
// the defaults: --memory 672m --cpuset 1) and put back, its container is sampled (CPU, memory, its processes).
// --phone: real calls over the install's test-caller trunk from CALL_TEST_FROM to --to (the numbers in turn), the
//   callers on the three stages only; the calls of a level start spread over --spread seconds.
// --remote (implies --phone, needs --to): the numbers are another install's (e.g. production called from staging); the
//   local business agent is not changed, restarted or sampled, only the caller container is started and removed.
// --caller-cpuset: cores for the test callers, apart from the business agent's and LiveKit's, so only its CPU is measured.
// After a level the run stops when fewer than 90 % were answered, the greeting heard p50 is over 3.5 s or a call could
// not be dialled (--no-abort: go on). Ctrl-C hangs up every call of the run and removes the caller container; the hard
// stop is `docker rm -f linedesk-load-caller`.
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runScript } from '../env.ts'
import { callsArgs, type LoadTestOptions, parseLoadTestArgs } from './args.ts'
import type { CallResult } from './calls.ts'
import {
  abortReasons,
  type CallsSummary,
  formatCallsSummaries,
  formatSummaries,
  type LevelSummary,
  parseDockerStats,
  parseRss,
  type Sample,
  summarizeCalls,
  summarizeLevel,
} from './summary.ts'

const exec = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CALLER_CONTAINER = 'linedesk-load-caller'
const CALLER_AGENT = 'linedesk-load-caller'
/** Quiet time after a level, so the next one starts from a settled worker (finished calls write their summary first). */
const SETTLE_MS = 45_000

const docker = async (...args: string[]) =>
  (await exec('docker', args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 })).stdout
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Memory as docker counts it, each process's RSS, and the container's CPU time so far (cgroup cpu.stat). `cpuCores`
 * is filled in by the sampler from two readings: docker stats' CPU figure is unreliable on Docker Desktop.
 */
async function sample(container: string): Promise<Sample & { cpuUsec: number }> {
  const [stats, inside] = await Promise.all([
    docker('stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', container),
    docker(
      'exec',
      container,
      'sh',
      '-c',
      'grep usage_usec /sys/fs/cgroup/cpu.stat; cat /proc/[0-9]*/status 2>/dev/null | grep VmRSS',
    ),
  ])
  const cpuUsec = Number(/usage_usec (\d+)/.exec(inside)?.[1] ?? 0)
  return { at: Date.now(), cpuCores: 0, memMb: parseDockerStats(stats).memMb, processMb: parseRss(inside), cpuUsec }
}

/** How many processes the kernel has killed for memory in `container` since it started. */
async function oomKillCount(container: string) {
  const events = await docker('exec', container, 'cat', '/sys/fs/cgroup/memory.events').catch(() => '')
  return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0)
}

/** Samples `container` every couple of seconds until `stop` is called; returns what it collected. */
function sampler(container: string) {
  const samples: Sample[] = []
  let running = true
  const loop = (async () => {
    let previous: (Sample & { cpuUsec: number }) | null = null
    while (running) {
      const current = await sample(container).catch(() => null)
      if (current) {
        if (previous) current.cpuCores = (current.cpuUsec - previous.cpuUsec) / ((current.at - previous.at) * 1000)
        samples.push(current)
        previous = current
      }
      await sleep(1000)
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      return samples
    },
  }
}

/** The limits the test changes, to put back afterwards, and the compose project the container belongs to. */
async function limitsOf(container: string) {
  const format =
    '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.CpusetCpus}}|{{index .Config.Labels "com.docker.compose.project"}}'
  const [memory, swap, cpuset, project] = (await docker('inspect', '-f', format, container)).trim().split('|')
  return { memory: memory!, swap: swap!, cpuset: cpuset ?? '', project: project || 'linedesk' }
}

/**
 * `cpuset`: the cores the test callers run on. Give them cores the business agent does not use, or the callers' CPU
 * counts against it (on one machine both would otherwise share the voice cores).
 */
async function startCallerWorker(project: string, idleProcesses: number, memory: string, cpuset: string | undefined) {
  await docker('rm', '-f', CALLER_CONTAINER).catch(() => '')
  await docker(
    'compose',
    '-p',
    project,
    'run',
    '-d',
    '--rm',
    '--no-deps',
    '--name',
    CALLER_CONTAINER,
    '-e',
    `AGENT_NAME=${CALLER_AGENT}`,
    '-e',
    `AGENT_IDLE_PROCESSES=${idleProcesses}`,
    'agent',
  )
  await docker(
    'update',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    ...(cpuset ? ['--cpuset-cpus', cpuset] : []),
    CALLER_CONTAINER,
  )
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(2000)) {
    const logs = await docker('logs', CALLER_CONTAINER).catch(() => '')
    if (logs.includes('registered worker')) return
  }
  throw new Error(`the caller worker in ${CALLER_CONTAINER} did not register with LiveKit within 2 minutes`)
}

/** The caller worker's log, kept before its container goes: a call nobody spoke in is told apart there from a business fault. */
async function keepCallerLogs() {
  const logs = await exec('docker', ['logs', CALLER_CONTAINER], { maxBuffer: 64 * 1024 * 1024 }).catch(() => null)
  if (!logs) return
  const file = join(tmpdir(), `linedesk-load-caller-${Date.now()}.log`)
  await writeFile(file, logs.stdout + logs.stderr)
  console.log(`Caller worker log: ${file}`)
}

/** Starts one level's calls in the caller container and reads back one result per call. */
async function startCalls(args: string[]): Promise<CallResult[]> {
  const { stdout } = await exec(
    'docker',
    ['exec', '-w', '/app/apps/agent', CALLER_CONTAINER, 'node', 'src/load-test/calls.ts', ...args],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
  ).catch((e: { stdout?: string; message: string }) => {
    console.error(`calls.ts failed: ${e.message}`)
    return { stdout: e.stdout ?? '' }
  })
  return stdout
    .split('\n')
    .filter(l => l.startsWith('LOADTEST '))
    .map(l => JSON.parse(l.slice(9)) as CallResult)
}

/** One machine-readable line per call, with its level, for whoever reads the run's output afterwards. */
function printResults(level: number, results: CallResult[]) {
  for (const r of [...results].sort((a, b) => a.index - b.index)) {
    console.log(`LOADTEST ${JSON.stringify({ level, ...r })}`)
    console.log(
      `  call ${r.index} to ${r.to}: ${r.answered ? 'answered' : 'NOT answered'}${r.error ? ` (${r.error})` : ''}, greeting heard ${r.heardGreetingMs ?? '–'} ms, ${r.replyMs.length} replies`,
    )
  }
}

/** One level with the local business agent sampled; waits SETTLE_MS before its last sample. */
async function runMeasuredLevel(calls: number, container: string, args: string[]) {
  const oomBefore = await oomKillCount(container)
  const baseline = await sample(container)
  const watch = sampler(container)
  const results = await startCalls(args)
  const during = await watch.stop()
  printResults(calls, results)
  await sleep(SETTLE_MS)
  const after = await sample(container)
  const level = summarizeLevel(calls, results, baseline, during, after, (await oomKillCount(container)) - oomBefore)
  return { results, level }
}

/** The local business agent's limits before the test, to put back. */
type Limits = Awaited<ReturnType<typeof limitsOf>>

let cleanup: Promise<void> | null = null

/**
 * Ends the test, once, from wherever: hangs up every call of the run (deleting its rooms ends both legs), keeps the
 * caller worker's log, removes the caller container and puts the business agent's limits back (`before` null with
 * --remote: it was left alone).
 */
function stopTest(run: string, container: string, before: Limits | null) {
  cleanup ??= (async () => {
    const hungUp = await exec(
      'docker',
      ['exec', '-w', '/app/apps/agent', CALLER_CONTAINER, 'node', 'src/load-test/calls.ts', '--hang-up', run],
      { cwd: REPO_ROOT, timeout: 60_000 },
    ).catch(() => null)
    if (hungUp) console.log(hungUp.stdout.trim())
    await keepCallerLogs()
    await docker('rm', '-f', CALLER_CONTAINER).catch(() => '')
    if (!before) return
    const restore = [
      '--memory',
      before.memory,
      '--memory-swap',
      before.swap,
      ...(before.cpuset ? ['--cpuset-cpus', before.cpuset] : []),
    ]
    await docker('update', ...restore, container).catch(e =>
      console.error(`Could not put ${container}'s limits back: ${e}`),
    )
  })()
  return cleanup
}

async function raiseLimits(o: LoadTestOptions): Promise<Limits> {
  const before = await limitsOf(o.container)
  const cpuset = o.cpuset ?? before.cpuset
  console.log(
    `Limits of ${o.container} for the test: memory ${o.memory} (was ${Math.round(Number(before.memory) / 2 ** 20)} MB), cores ${cpuset || 'all'} (was ${before.cpuset || 'all'})`,
  )
  await docker(
    'update',
    '--memory',
    o.memory,
    '--memory-swap',
    o.memory,
    ...(cpuset ? ['--cpuset-cpus', cpuset] : []),
    o.container,
  )
  return before
}

async function main() {
  const o = parseLoadTestArgs(process.argv.slice(2))
  const run = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  console.log(
    o.remote
      ? `Run ${run}: callers here, over the phone to ${o.to.join(', ')} (another install; the local business agent is left alone).`
      : `Run ${run}: ${o.phone ? 'over the phone' : 'without a phone'}, the local business agent ${o.container} measured.`,
  )
  const before = o.remote ? null : await raiseLimits(o)
  const stop = () => stopTest(run, o.container, before)
  // The kill switch: Ctrl-C (or a TERM) hangs up every call of the run and removes the caller container.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      console.log(`\n${signal}: hanging up every call of run ${run}…`)
      void stop().finally(() => process.exit(130))
    })

  const levels: LevelSummary[] = []
  const callsSummaries: CallsSummary[] = []
  try {
    console.log('Starting the caller worker…')
    await startCallerWorker(before?.project ?? o.project, Math.max(...o.levels), o.callerMemory, o.callerCpuset)
    for (const [n, calls] of o.levels.entries()) {
      // A measured level settles inside runMeasuredLevel; without measuring, the pause comes before the next level.
      if (n > 0 && !before) await sleep(SETTLE_MS)
      console.log(`\n${calls} call(s) at once…`)
      const args = callsArgs(o, calls, `${run}-${n}`, CALLER_AGENT)
      let results: CallResult[]
      if (before) {
        const measured = await runMeasuredLevel(calls, o.container, args)
        levels.push(measured.level)
        results = measured.results
      } else {
        results = await startCalls(args)
        printResults(calls, results)
      }
      const summary = summarizeCalls(calls, results)
      callsSummaries.push(summary)
      console.log(formatCallsSummaries([summary]))
      for (const failure of summary.failures) console.log(`  ${failure}`)
      const reasons = abortReasons(summary)
      if (!reasons.length) continue
      process.exitCode = 1
      if (n === o.levels.length - 1) console.log(`The last level failed: ${reasons.join('; ')}`)
      else if (!o.abort) console.log(`Going on despite: ${reasons.join('; ')} (--no-abort)`)
      else {
        console.log(`Stopping the run after ${calls} call(s): ${reasons.join('; ')}`)
        break
      }
    }
  } finally {
    await stop()
  }
  console.log(`\n${formatCallsSummaries(callsSummaries)}`)
  if (levels.length) console.log(`\n${formatSummaries(levels)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runScript(main)
