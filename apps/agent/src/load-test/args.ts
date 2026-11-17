// Load test: the command line of load-test/main.ts.
import { VOICE_PIPELINES } from '@linedesk/actions'
import { isScenario, scenarioNames } from '../test-caller/scenarios.ts'

export type LoadTestOptions = {
  levels: number[]
  scenario: string
  /** Seconds: phone, the window the calls of a level start in; no phone, the gap between call starts. */
  spread: string
  pipeline: string | undefined
  /** Real calls over the install's test-caller trunk instead of calls in a room. */
  phone: boolean
  /** The business side is another install: the local business agent is not changed, restarted or sampled. */
  remote: boolean
  /** Numbers to call, in turn; empty: CALL_TEST_TO in the agent's env. */
  to: string[]
  /** The local business agent's container and its limits during the test (not with --remote). */
  container: string
  memory: string
  cpuset: string | undefined
  callerMemory: string
  callerCpuset: string | undefined
  /** The compose project the caller container is started in (with --remote; else the business container's). */
  project: string
  abort: boolean
}

const E164 = /^\+[1-9]\d{6,14}$/

/** Flags that change the local business agent, which --remote leaves alone. */
const LOCAL_ONLY = ['--container', '--memory', '--cpuset'] as const

/**
 * The callers' memory when --caller-memory is not given: at the biggest level the caller worker holds one process per
 * call plus as many warm ones again (about 250 MB each), plus the worker itself.
 */
export const defaultCallerMemory = (biggestLevel: number) => `${Math.max(3, Math.ceil(0.5 * biggestLevel + 1))}g`

export function parseLoadTestArgs(args: readonly string[]): LoadTestOptions {
  const value = (name: string) => {
    const at = args.indexOf(name)
    if (at < 0) return undefined
    const next = args[at + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} takes a value`)
    return next
  }
  const levels = (value('--calls') ?? '1,5,10').split(',').map(Number)
  if (!levels.length || !levels.every(n => Number.isInteger(n) && n > 0))
    throw new Error('--calls takes a list like 1,5,10')
  const scenario = value('--scenario') ?? 'callback-message'
  if (!isScenario(scenario)) throw new Error(`--scenario takes one of ${scenarioNames.join(', ')}`)
  const spread = value('--spread') ?? '2'
  if (!(Number(spread) >= 0)) throw new Error('--spread takes seconds')
  const pipeline = value('--pipeline')
  if (pipeline !== undefined && !(VOICE_PIPELINES as readonly string[]).includes(pipeline))
    throw new Error(`--pipeline takes ${VOICE_PIPELINES.join(' or ')}`)
  const remote = args.includes('--remote')
  // The business side of another install can only be reached over the phone.
  const phone = remote || args.includes('--phone')
  if (phone && pipeline !== undefined)
    throw new Error(
      "--pipeline works without a phone only; over the phone the assistant's own setting applies (Settings › Assistant)",
    )
  const to = (value('--to') ?? '').split(',').filter(Boolean)
  const wrong = to.filter(n => !E164.test(n))
  if (wrong.length)
    throw new Error(`--to takes E.164 numbers like +15035550123, comma-separated; not: ${wrong.join(', ')}`)
  if (remote && !to.length) throw new Error("--remote needs --to: the other install's number(s)")
  const local = LOCAL_ONLY.filter(name => args.includes(name))
  if (remote && local.length)
    throw new Error(`--remote leaves the local business agent alone; drop ${local.join(', ')}`)
  return {
    levels,
    scenario,
    spread,
    pipeline,
    phone,
    remote,
    to,
    container: value('--container') ?? 'linedesk-agent-1',
    memory: value('--memory') ?? '4g',
    cpuset: value('--cpuset'),
    callerMemory: value('--caller-memory') ?? defaultCallerMemory(Math.max(...levels)),
    callerCpuset: value('--caller-cpuset'),
    project: value('--project') ?? 'linedesk',
    abort: !args.includes('--no-abort'),
  }
}

/** The arguments main.ts passes to calls.ts in the caller container for one level. */
export function callsArgs(o: LoadTestOptions, calls: number, run: string, callerAgent: string): string[] {
  return [
    String(calls),
    '--caller-agent',
    callerAgent,
    '--run',
    run,
    '--scenario',
    o.scenario,
    '--spread',
    o.spread,
    ...(o.pipeline ? ['--pipeline', o.pipeline] : []),
    ...(o.phone ? ['--phone'] : []),
    ...(o.to.length ? ['--to', o.to.join(',')] : []),
  ]
}
