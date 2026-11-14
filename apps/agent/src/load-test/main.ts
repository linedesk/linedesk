// Load test: what N calls at once cost the agent. Runs on the machine with the docker compose stack (a dev machine or a
// test server, never production): starts a second agent container that plays the test callers, raises both containers'
// memory limits for the test, then for each level starts N test calls without a phone (load-test/calls.ts in the caller
// container) while sampling the business agent's container (CPU, memory, its processes). Prints a table per level and
// puts the limits back. Each call is billed on both sides (speech, model, voice): about a cent a minute per side.
//   pnpm --filter @linedesk/agent load-test [--calls 1,5,10] [--scenario callback-message] [--spread 2]
//     [--pipeline realtime|three_stage] [--to <business number>] [--container linedesk-agent-1] [--memory 4g] [--cpuset 1-3]
//     [--caller-memory 3g] [--caller-cpuset 6-13]
// --memory and --cpuset: the business agent's limits during the test (e.g. the defaults: --memory 672m --cpuset 1).
// --caller-cpuset: cores for the test callers, apart from the business agent's and LiveKit's, so only its CPU is measured.
// --to: the Linedesk number whose workspace answers (default: CALL_TEST_TO in the agent's env).
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runScript } from '../env.ts'
import type { CallResult } from './calls.ts'
import {
  type LevelSummary,
  type Sample,
  formatSummaries,
  parseDockerStats,
  parseRss,
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

const flag = (args: string[], name: string, fallback: string) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback
}

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

/** `to`: the business number the calls go to (CALL_TEST_TO); without it, the agent's own CALL_TEST_TO. */
/**
 * `cpuset`: the cores the test callers run on. Give them cores the business agent does not use, or the callers' CPU
 * counts against it (on one machine both would otherwise share the voice cores).
 */
async function startCallerWorker(
  project: string,
  idleProcesses: number,
  memory: string,
  cpuset: string | undefined,
  to: string | undefined,
) {
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
    ...(to ? ['-e', `CALL_TEST_TO=${to}`] : []),
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

async function runLevel(calls: number, container: string, callArgs: string[]): Promise<LevelSummary> {
  console.log(`\n${calls} call(s) at once…`)
  const oomBefore = await oomKillCount(container)
  const baseline = await sample(container)
  const watch = sampler(container)
  const { stdout } = await exec(
    'docker',
    [
      'exec',
      '-w',
      '/app/apps/agent',
      CALLER_CONTAINER,
      'node',
      'src/load-test/calls.ts',
      String(calls),
      '--caller-agent',
      CALLER_AGENT,
      ...callArgs,
    ],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
  ).catch((e: { stdout?: string; message: string }) => {
    console.error(`calls.ts failed: ${e.message}`)
    return { stdout: e.stdout ?? '' }
  })
  const during = await watch.stop()
  const results = stdout
    .split('\n')
    .filter(l => l.startsWith('LOADTEST '))
    .map(l => JSON.parse(l.slice(9)) as CallResult)
  for (const r of results)
    console.log(
      `  call ${r.index}: ${r.answered ? 'answered' : 'NOT answered'}${r.error ? ` (${r.error})` : ''}, greeting ${r.greetingMs ?? '–'} ms, ${r.replyMs.length} replies`,
    )
  await sleep(SETTLE_MS)
  const after = await sample(container)
  return summarizeLevel(calls, results, baseline, during, after, (await oomKillCount(container)) - oomBefore)
}

async function main() {
  const args = process.argv.slice(2)
  const levels = flag(args, '--calls', '1,5,10').split(',').map(Number)
  if (!levels.every(n => Number.isInteger(n) && n > 0)) throw new Error('--calls takes a list like 1,5,10')
  const container = flag(args, '--container', 'linedesk-agent-1')
  const callArgs = [
    '--scenario',
    flag(args, '--scenario', 'callback-message'),
    '--spread',
    flag(args, '--spread', '2'),
    ...(args.includes('--pipeline') ? ['--pipeline', flag(args, '--pipeline', '')] : []),
  ]

  const before = await limitsOf(container)
  const memory = flag(args, '--memory', '4g')
  const cpuset = flag(args, '--cpuset', before.cpuset)
  console.log(
    `Limits of ${container} for the test: memory ${memory} (was ${Math.round(Number(before.memory) / 2 ** 20)} MB), cores ${cpuset || 'all'} (was ${before.cpuset || 'all'})`,
  )
  await docker(
    'update',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    ...(cpuset ? ['--cpuset-cpus', cpuset] : []),
    container,
  )
  const summaries: LevelSummary[] = []
  try {
    console.log('Starting the caller worker…')
    const to = args.includes('--to') ? flag(args, '--to', '') : undefined
    const callerCpuset = args.includes('--caller-cpuset') ? flag(args, '--caller-cpuset', '') : undefined
    await startCallerWorker(before.project, Math.max(...levels), flag(args, '--caller-memory', '3g'), callerCpuset, to)
    for (const calls of levels) summaries.push(await runLevel(calls, container, callArgs))
  } finally {
    await keepCallerLogs()
    await docker('rm', '-f', CALLER_CONTAINER).catch(() => '')
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
  }
  console.log(`\n${formatSummaries(summaries)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runScript(main)
